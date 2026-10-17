"""The Cloud Run file processor, as DataDesk sees it: the config bucket its contracts live in,
the landing bucket files go into, and the file_audit tables it records every attempt in.

Every call is blocking; the services run them in a thread.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime

from app.adapters import bigquery
from app.adapters.storage import get_storage
from app.core.config import get_settings

log = logging.getLogger("datadesk.file_pipeline")

YAML_TYPE = "application/x-yaml"


def _bucket(name: str):
    return get_storage().client().bucket(name)


# ------------------------------------------------------------------ contracts (config bucket)
def list_contracts() -> dict[str, str]:
    """{object name: YAML text} for every contract Cloud Run reads."""
    s = get_settings()
    client = get_storage().client()
    return {
        blob.name: blob.download_as_text()
        for blob in client.list_blobs(s.file_upload_config_bucket, prefix=s.file_upload_contracts_prefix)
        if blob.name.endswith((".yaml", ".yml"))
    }


def write_contract(name: str, text: str) -> str:
    """Write one contract; returns its gs:// URI."""
    bucket = get_settings().file_upload_config_bucket
    _bucket(bucket).blob(name).upload_from_string(text, content_type=YAML_TYPE)
    log.info("published contract gs://%s/%s", bucket, name)
    return f"gs://{bucket}/{name}"


def read_contract(name: str) -> tuple[str, datetime] | None:
    """(YAML text, when it was last written) of one published contract, or None."""
    blob = _bucket(get_settings().file_upload_config_bucket).get_blob(name)
    if blob is None:
        return None
    return blob.download_as_text(), blob.updated


def delete_contract(name: str) -> None:
    bucket = get_settings().file_upload_config_bucket
    blob = _bucket(bucket).blob(name)
    if blob.exists():
        blob.delete()
        log.info("removed contract gs://%s/%s", bucket, name)


# ------------------------------------------------------------------ landing bucket
def land(source_path: str, name: str, content_type: str, metadata: dict[str, str]) -> tuple[str, str]:
    """Copy a workspace object into the landing bucket, with custom metadata Cloud Run reads
    (load_mode). Returns (gs:// URI, generation). The object's arrival triggers Cloud Run."""
    bucket = get_settings().file_upload_landing_bucket
    generation = get_storage().copy_out(source_path, bucket, name, content_type, metadata)
    log.info("landed gs://%s/%s (generation %s)", bucket, name, generation)
    return f"gs://{bucket}/{name}", generation


def landing_object_exists(uri: str, generation: str | None) -> bool:
    """Is that version of the file still in landing? Cloud Run moves it out when it's done."""
    bucket, _, name = uri.removeprefix("gs://").partition("/")
    blob = _bucket(bucket).get_blob(name)
    return blob is not None and (generation is None or str(blob.generation) == str(generation))


# ------------------------------------------------------------------ file_audit (BigQuery)
JOB_COLUMNS = (
    "job_id",
    "status",
    "status_reason",
    "attempt_number",
    "delivery_attempt",
    "start_time",
    "end_time",
    "duration_seconds",
    "file_path",
    "file_generation",
    "final_file_path",
    "contract_name",
    "contract_version",
    "target_table",
    "load_mode",
    "bq_load_job_id",
    "rows_in_file",
    "rows_loaded",
    "rows_failed_validation",
    "validation_status",
    "validation_rules_executed",
    "validation_rules_failed",
    "recon_status",
    "error_code",
    "error_message",
    "created_at",
    "updated_at",
)

CHECK_COLUMNS = (
    "job_id",
    "check_name",
    "check_type",
    "stage",
    "validation_result",
    "severity",
    "summary",
    "records_evaluated",
    "records_failed",
    "records_warned",
    "checks_evaluated",
    "checks_failed",
    "failed_checks",
    "validated_at",
)


def _table(name: str) -> str:
    s = get_settings()
    return f"`{s.bq_project}.{s.file_upload_audit_dataset}.{name}`"


def _plain(value):
    return value.isoformat() if isinstance(value, datetime) else value


def jobs_for(uris: list[str], since: datetime) -> list[dict]:
    """Every job_metadata row for these landed files, oldest first. `since` keeps the scan to the
    partitions written after the files landed."""
    if not uris:
        return []
    from google.cloud import bigquery as bq

    started = time.perf_counter()
    client = bigquery.get_client()
    job = client.query(
        f"SELECT {', '.join(JOB_COLUMNS)} FROM {_table('job_metadata')} "
        "WHERE created_at >= @since AND file_path IN UNNEST(@uris) ORDER BY created_at",
        job_config=bq.QueryJobConfig(
            query_parameters=[
                bq.ScalarQueryParameter("since", "TIMESTAMP", since),
                bq.ArrayQueryParameter("uris", "STRING", uris),
            ]
        ),
    )
    rows = [{k: _plain(v) for k, v in r.items()} for r in job.result(timeout=60)]
    log.info("file_audit: %d job row(s) for %d file(s) in %dms", len(rows), len(uris), _ms(started))
    return rows


def checks_for(job_ids: list[str], since: datetime) -> list[dict]:
    """validation_metadata rows for these jobs, `details` parsed."""
    if not job_ids:
        return []
    from google.cloud import bigquery as bq

    client = bigquery.get_client()
    job = client.query(
        f"SELECT {', '.join(CHECK_COLUMNS)}, TO_JSON_STRING(details) AS details "
        f"FROM {_table('validation_metadata')} "
        "WHERE created_at >= @since AND job_id IN UNNEST(@ids) ORDER BY validated_at, check_name",
        job_config=bq.QueryJobConfig(
            query_parameters=[
                bq.ScalarQueryParameter("since", "TIMESTAMP", since),
                bq.ArrayQueryParameter("ids", "STRING", job_ids),
            ]
        ),
    )
    rows = []
    for r in job.result(timeout=60):
        row = {k: _plain(v) for k, v in r.items()}
        row["details"] = json.loads(row["details"]) if row.get("details") else None
        rows.append(row)
    return rows


# ------------------------------------------------------------------ access
def access_checks() -> list[dict]:
    """Can DataDesk publish contracts, land files and read the audit tables? One line each."""
    from google.api_core import exceptions

    s = get_settings()
    checks: list[dict] = []

    def add(name: str, ok: bool, detail: str, hint: str = "") -> None:
        checks.append({"name": name, "ok": ok, "detail": detail, "hint": hint})

    for name, bucket in (
        ("config bucket", s.file_upload_config_bucket),
        ("landing bucket", s.file_upload_landing_bucket),
    ):
        wanted = [
            "storage.objects.create",
            "storage.objects.delete",
            "storage.objects.get",
            "storage.objects.list",
        ]
        try:
            granted = set(_bucket(bucket).test_iam_permissions(wanted))
            missing = [p for p in wanted if p not in granted]
            add(
                name,
                not missing,
                f"gs://{bucket}: can write and remove files"
                if not missing
                else f"gs://{bucket}: missing {', '.join(missing)}",
                "" if not missing else f"grant roles/storage.objectAdmin on gs://{bucket}",
            )
        except exceptions.NotFound:
            add(
                name,
                False,
                f"gs://{bucket} doesn't exist",
                "check FILE_UPLOAD_* in .env and run make check-resources in cloud-run-poc",
            )
        except Exception as exc:
            add(
                name,
                False,
                f"gs://{bucket}: {str(exc)[:200]}",
                f"grant roles/storage.objectAdmin on gs://{bucket}",
            )

    for table in ("job_metadata", "validation_metadata"):
        ref = f"{s.bq_project}.{s.file_upload_audit_dataset}.{table}"
        try:
            client = bigquery.get_client()
            granted = set(
                client.test_iam_permissions(ref, ["bigquery.tables.getData"]).get("permissions", [])
            )
            ok = "bigquery.tables.getData" in granted
            add(
                table,
                ok,
                f"can read {ref}" if ok else f"can't read {ref}",
                "" if ok else f"grant roles/bigquery.dataViewer on the {s.file_upload_audit_dataset} dataset",
            )
        except exceptions.NotFound:
            add(table, False, f"{ref} not found", "check FILE_UPLOAD_AUDIT_DATASET in .env")
        except Exception as exc:
            add(table, False, str(exc)[:200])
    return checks


def _ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)
