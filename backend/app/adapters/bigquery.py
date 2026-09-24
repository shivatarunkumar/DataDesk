"""BigQuery client for upload targets: live schema, append loads and MERGE upserts.

Credentials are Application Default Credentials (gcloud auth application-default login,
or GOOGLE_APPLICATION_CREDENTIALS). Every call is blocking; callers run it in a thread.
"""

from __future__ import annotations

import logging
import time
import uuid
from functools import lru_cache

from app.adapters import gcp
from app.core.config import get_settings

log = logging.getLogger("datadesk.bigquery")


class BigQueryDisabled(RuntimeError):
    """BQ_ENABLED=false, or no project to run jobs in."""


@lru_cache
def get_client():
    settings = get_settings()
    if not settings.bq_enabled:
        raise BigQueryDisabled("BigQuery is switched off (BQ_ENABLED=false)")
    if not settings.bq_project:
        raise BigQueryDisabled("No BigQuery project: set GCP_PROJECT_ID (or BQ_PROJECT_ID) in .env")
    from google.cloud import bigquery

    return bigquery.Client(
        project=settings.bq_project, location=settings.bq_location or None, credentials=gcp.credentials()
    )


def reachable() -> dict:
    """Health probe: can we list datasets in the project?"""
    client = get_client()
    datasets = list(client.list_datasets(max_results=1, timeout=5))
    return {"project": client.project, "datasets_visible": bool(datasets)}


def list_datasets() -> list[str]:
    client = get_client()
    return sorted(d.dataset_id for d in client.list_datasets(timeout=15))


def list_tables(dataset: str) -> list[dict]:
    client = get_client()
    return [
        {"schema": None, "table": t.table_id, "kind": t.table_type}
        for t in sorted(
            client.list_tables(f"{client.project}.{dataset}", timeout=15), key=lambda t: t.table_id
        )
        if t.table_type in ("TABLE", "EXTERNAL") and not t.table_id.startswith("_stg_")
    ]


def table_columns(dataset: str, table: str) -> list[dict]:
    client = get_client()
    tbl = client.get_table(f"{client.project}.{dataset}.{table}")
    return [
        {
            # a repeated field is an array of its type, whatever field_type says
            "name": f.name,
            "type": f"ARRAY<{f.field_type}>" if f.mode == "REPEATED" else f.field_type,
            "nullable": f.mode != "REQUIRED",
        }
        for f in tbl.schema
    ]


def load(
    dataset: str,
    table: str,
    rows: list[dict],
    columns: list[str],
    mode: str,
    keys: list[str],
) -> dict:
    """Append rows, or upsert them via a staging table + MERGE. `rows` are already typed,
    `columns` already validated as identifiers by the caller."""
    from google.cloud import bigquery

    client = get_client()
    target_ref = f"{client.project}.{dataset}.{table}"
    schema = [f for f in client.get_table(target_ref).schema if f.name in columns]
    started = time.perf_counter()

    if mode == "append":
        job = client.load_table_from_json(
            rows,
            target_ref,
            job_config=bigquery.LoadJobConfig(
                write_disposition=bigquery.WriteDisposition.WRITE_APPEND, schema=schema
            ),
        )
        job.result()
        log.info("bigquery append %s: %d rows in %dms", target_ref, len(rows), _ms(started))
        return {"inserted": len(rows), "updated": 0}

    staging_ref = f"{client.project}.{dataset}._stg_{uuid.uuid4().hex[:12]}"
    try:
        client.load_table_from_json(
            rows,
            staging_ref,
            job_config=bigquery.LoadJobConfig(
                write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE, schema=schema
            ),
        ).result()

        on_clause = " AND ".join(f"T.`{k}` = S.`{k}`" for k in keys)
        non_keys = [c for c in columns if c not in keys]
        set_clause = ", ".join(f"T.`{c}` = S.`{c}`" for c in non_keys) or f"T.`{keys[0]}` = S.`{keys[0]}`"
        insert_cols = ", ".join(f"`{c}`" for c in columns)
        insert_vals = ", ".join(f"S.`{c}`" for c in columns)
        merge = client.query(
            f"MERGE `{target_ref}` T USING `{staging_ref}` S ON {on_clause} "
            f"WHEN MATCHED THEN UPDATE SET {set_clause} "
            f"WHEN NOT MATCHED THEN INSERT ({insert_cols}) VALUES ({insert_vals})"
        )
        merge.result()
        affected = merge.num_dml_affected_rows or 0
        log.info(
            "bigquery upsert %s: %d rows, %d affected in %dms", target_ref, len(rows), affected, _ms(started)
        )
        return {"affected": affected, "rows": len(rows)}
    finally:
        client.delete_table(staging_ref, not_found_ok=True)


def _ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


# Table-level permissions each write mode needs. BigQuery's testIamPermissions answers with
# the ones the caller holds (inherited project and dataset roles included), without doing
# anything to the table.
READ_PERMISSIONS = ["bigquery.tables.get", "bigquery.tables.getData"]
WRITE_PERMISSIONS = ["bigquery.tables.updateData"]


def access_checks(
    dataset: str, table: str, modes: list[str], keys: list[str], probe_writes: bool = True
) -> list[dict]:
    """What DataDesk can and can't do with this table, one line per check.

    Read-only, except for upsert: that loads through a staging table in the same dataset,
    and whether we may create one can only be proved by creating (and dropping) an empty one.
    """
    from google.api_core import exceptions
    from google.cloud import bigquery

    checks: list[dict] = []

    def add(name: str, ok: bool, detail: str, hint: str = "") -> None:
        checks.append({"name": name, "ok": ok, "detail": detail, "hint": hint})

    def warn(name: str, detail: str, hint: str = "") -> None:
        checks.append({"name": name, "ok": True, "warning": True, "detail": detail, "hint": hint})

    try:
        who, is_service_account = gcp.identity()
        client = get_client()
        # a cheap call that proves the credentials (and any impersonation) actually work
        client.get_dataset(f"{client.project}.{dataset}", timeout=15)
    except exceptions.NotFound:
        who, is_service_account = gcp.identity()
    except exceptions.Forbidden as exc:
        who, _ = gcp.identity()
        add(
            "identity",
            False,
            f"{who} was refused: {exc.message}",
            "grant your gcloud user roles/iam.serviceAccountTokenCreator on GCP_SERVICE_ACCOUNT"
            if get_settings().gcp_service_account
            else "run: gcloud auth application-default login",
        )
        return checks
    except Exception as exc:
        add("identity", False, str(exc)[:300], "check GCP_SERVICE_ACCOUNT and your gcloud login")
        return checks
    detail = f"loads would run as {who} in project {client.project}"
    hint = "DataDesk should use its own service account: set GCP_SERVICE_ACCOUNT in .env (see README)"
    if is_service_account:
        add("identity", True, detail)
    elif get_settings().enforce_app_identity:
        add("identity", False, detail, hint)
    else:
        warn("identity", detail + " (not enforced: ENFORCE_APP_IDENTITY=false)", hint)

    ref = f"{client.project}.{dataset}.{table}"
    try:
        client.get_dataset(f"{client.project}.{dataset}", timeout=15)
        add("dataset", True, f"{dataset} is visible")
        tbl = client.get_table(ref, timeout=15)
        add("table", True, f"{len(tbl.schema)} columns, {tbl.num_rows or 0:,} rows")
    except exceptions.NotFound as exc:
        what = "dataset" if "Dataset" in (exc.message or "") else "table"
        add(what, False, f"{ref} not found", "check the dataset and table name")
        return checks
    except exceptions.Forbidden as exc:
        add("table", False, exc.message, "grant the account roles/bigquery.dataViewer on the dataset")
        return checks

    wanted = READ_PERMISSIONS + WRITE_PERMISSIONS
    try:
        granted = set(client.test_iam_permissions(ref, wanted).get("permissions", []))
    except Exception as exc:
        granted = set()
        add("permissions", False, f"could not ask BigQuery: {exc}")
    missing_read = [p for p in READ_PERMISSIONS if p not in granted]
    add(
        "read",
        not missing_read,
        "can read the table's schema and rows" if not missing_read else f"missing {', '.join(missing_read)}",
        "" if not missing_read else "grant roles/bigquery.dataViewer on the dataset",
    )
    can_write = "bigquery.tables.updateData" in granted
    add(
        "write",
        can_write,
        "can add and change rows" if can_write else "missing bigquery.tables.updateData",
        "" if can_write else "grant roles/bigquery.dataEditor on the dataset or table",
    )

    try:
        job = client.query(
            f"SELECT * FROM `{ref}` LIMIT 0",
            job_config=bigquery.QueryJobConfig(dry_run=True, use_query_cache=False),
        )
        add(
            "jobs",
            True,
            f"can run load and query jobs (dry run would scan {job.total_bytes_processed or 0} bytes)",
        )
    except exceptions.Forbidden as exc:
        add("jobs", False, exc.message, f"grant roles/bigquery.jobUser on project {client.project}")
    except Exception as exc:
        add("jobs", False, str(exc)[:300])

    names = {f.name for f in tbl.schema}
    if "upsert" in modes:
        missing = [k for k in keys if k not in names]
        add(
            "upsert key",
            bool(keys) and not missing,
            f"matches on {', '.join(keys)}"
            if keys and not missing
            else f"not in the table: {', '.join(missing) or '—'}",
        )
        if not probe_writes:
            add("staging table", True, "checked when an admin reviews (it creates a temporary table)")
            return checks
        staging = f"{client.project}.{dataset}._stg_check_{uuid.uuid4().hex[:8]}"
        try:
            client.create_table(bigquery.Table(staging, schema=tbl.schema[:1]), timeout=15)
            client.delete_table(staging, not_found_ok=True, timeout=15)
            add("staging table", True, f"can create and drop the temporary table an upsert uses in {dataset}")
        except exceptions.Forbidden as exc:
            add("staging table", False, exc.message, "upsert needs roles/bigquery.dataEditor on the dataset")
        except Exception as exc:
            add("staging table", False, str(exc)[:300])
    return checks


# ------------------------------------------------------------------ data studio
def dry_run(sql: str, default_dataset: str | None) -> dict:
    """What a query would do, without running it: its statement type, the tables it reads
    and the bytes it would scan. Data Studio refuses anything but a SELECT over onboarded tables."""
    from google.cloud import bigquery

    client = get_client()
    job = client.query(
        sql,
        job_config=bigquery.QueryJobConfig(
            dry_run=True,
            use_query_cache=False,
            default_dataset=f"{client.project}.{default_dataset}" if default_dataset else None,
        ),
    )
    return {
        "statement_type": job.statement_type,
        "tables": [(t.project, t.dataset_id, t.table_id) for t in job.referenced_tables or []],
        "bytes": job.total_bytes_processed or 0,
        "project": client.project,
    }


def run_query(sql: str, default_dataset: str | None, limit: int, max_bytes: int, timeout: int) -> dict:
    """Run a (dry-run-checked) SELECT and return at most `limit` rows, as raw Python values."""
    from google.cloud import bigquery

    client = get_client()
    started = time.perf_counter()
    config = bigquery.QueryJobConfig(
        maximum_bytes_billed=max_bytes,
        default_dataset=f"{client.project}.{default_dataset}" if default_dataset else None,
    )
    config.job_timeout_ms = timeout * 1000  # BigQuery cancels the job itself after this
    job = client.query(sql, job_config=config)
    result = job.result(max_results=limit + 1, timeout=timeout)
    rows = [tuple(r.values()) for r in result]
    log.info("studio query: %d rows, %s bytes in %dms", len(rows), job.total_bytes_processed, _ms(started))
    return {
        "columns": [{"name": f.name, "type": f.field_type} for f in result.schema],
        "rows": rows[:limit],
        "truncated": len(rows) > limit,
        "bytes": job.total_bytes_processed or 0,
    }


def ref(dataset: str, table: str) -> str:
    """A table's full name, quoted for SQL."""
    return f"`{get_client().project}.{dataset}.{table}`"


def query(sql: str, params: dict[str, str | None], timeout: int = 120) -> list[dict]:
    """Run SQL (a query, or a script whose last statement returns rows) with STRING
    parameters, which the SQL casts to each column's type."""
    from google.cloud import bigquery

    client = get_client()
    job = client.query(
        sql,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter(k, "STRING", v) for k, v in params.items()]
        ),
    )
    return [dict(r.items()) for r in job.result(timeout=timeout)]
