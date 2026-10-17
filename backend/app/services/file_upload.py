"""File upload: send a file to BigQuery through the Cloud Run file processor.

    submit    the file is checked here first, exactly as Cloud Run will check it: the name
              the contract expects, CSV or Excel, the header in contract order, then the
              table's schema and the contract. Only a passing file reaches an admin.
    approve   checked once more, then copied into the landing bucket as
              {FILE_UPLOAD_LANDING_PREFIX}/{dataset}.{table}/{request id}/{prefix}_{YYYYMMDD}.{csv|xlsx}.
              The new object triggers Cloud Run (GCS notification → Pub/Sub push); the table folder
              tells it which contract to read, so it reads only that one.
    follow    Cloud Run records every attempt in file_audit.job_metadata and every check in
              validation_metadata. DataDesk finds the attempts by the landed object's URI and
              generation, and the request follows them to completed or failed.

One contract serves both: DataDesk's onboarding contract is the source, and it is published
to Cloud Run's config bucket as YAML whenever it changes (publish_contract).
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

import yaml
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters import file_pipeline
from app.core.config import Settings, get_settings
from app.models.targets import UploadTarget
from app.models.user import User
from app.models.workspace import UploadRequest, WorkspaceFile
from app.schemas.onboarding import ColumnRule, Contract, FileUpload
from app.services import file_parser, loaders, validators
from app.services import workspace as ws
from app.services.errors import NotFound, ServiceError

log = logging.getLogger("datadesk.file_upload")

# columns Cloud Run adds to every row it loads; they are never in the file
AUDIT_COLUMNS = ("_job_id", "_source_file", "_loaded_at")

# BigQuery column type → the type Cloud Run checks values against. Anything else is checked as
# STRING (no type check), and BigQuery's load job has the last word.
CLOUD_RUN_TYPES = {
    "INTEGER": "INT64",
    "INT64": "INT64",
    "FLOAT": "FLOAT64",
    "FLOAT64": "FLOAT64",
    "NUMERIC": "NUMERIC",
    "DECIMAL": "NUMERIC",
    "BOOLEAN": "BOOL",
    "BOOL": "BOOL",
    "DATE": "DATE",
    "TIMESTAMP": "TIMESTAMP",
}

FORMAT_TYPES = {"csv": "text/csv", "xlsx": file_parser.CONTENT_TYPES["xlsx"]}

# where File upload keeps a person's files in My files: new uploads, and what was sent
UPLOADS_FOLDER = ["File uploads"]
ARCHIVE_FOLDER = ["File uploads", "Archive"]


# ------------------------------------------------------------------ the contract, for Cloud Run
def settings_of(target: UploadTarget) -> FileUpload:
    """How files reach the table through Cloud Run. Every table takes files this way; one
    saved before the settings existed uses the defaults (its table name, CSV and Excel, append)."""
    raw = (target.contract or {}).get("file_upload") or {}
    return FileUpload.model_validate({**raw, "enabled": True})


def prefix_of(target: UploadTarget, fu: FileUpload) -> str:
    return (fu.file_prefix or target.table_name).rstrip("_-")


def file_columns(target: UploadTarget) -> list[dict]:
    """The columns a file must have, in order: the table's, minus the ones Cloud Run adds."""
    return [c for c in target.schema_snapshot or [] if c["name"] not in AUDIT_COLUMNS]


def file_pattern(prefix: str, formats: list[str]) -> str:
    return rf"^{re.escape(prefix)}_(\d{{8}})\.({'|'.join(formats)})$"


def expected_name(target: UploadTarget, fu: FileUpload) -> str:
    """ "customer_YYYYMMDD.csv or .xlsx": what people are told."""
    exts = " or .".join(fu.formats)
    return f"{prefix_of(target, fu)}_YYYYMMDD.{exts}"


def contract_object(settings: Settings, target: UploadTarget) -> str:
    return f"{settings.file_upload_contracts_prefix}{target.database_name}.{target.table_name}.yaml"


def cloud_run_contract(target: UploadTarget) -> dict:
    """The onboarding contract in Cloud Run's format (file-processor-service/app/models.py)."""
    fu = settings_of(target)
    contract = target.contract or {}
    rules = {c["name"]: c for c in contract.get("columns", [])}
    prefix = prefix_of(target, fu)

    columns = []
    for col in file_columns(target):
        rule = rules.get(col["name"], {})
        spec: dict = {
            "name": col["name"],
            "type": CLOUD_RUN_TYPES.get(col["type"].upper(), "STRING"),
        }
        if rule.get("required") or not col.get("nullable", True):
            spec["required"] = True
        for key in ("unique", "regex", "min", "max", "min_length", "max_length", "format", "description"):
            if validators._is_set(rule.get(key)):
                spec[key] = rule[key]
        if rule.get("enum"):
            spec["allowed_values"] = [str(v) for v in rule["enum"]]
        if rule.get("severity") == "warning":
            spec["severity"] = "WARNING"
        columns.append(spec)

    out = {
        "name": prefix,
        "version": target.contract_version,
        "description": target.display_name,
        "file_pattern": file_pattern(prefix, fu.formats),
        "file_date_group": 1,
        "target_table": f"{target.database_name}.{target.table_name}",
        "load_mode": fu.load_mode,
        "load_modes": fu.load_modes,
        "file_format": fu.formats,
        "delimiter": ",",
        "has_header": True,
        "min_rows": contract.get("min_rows") or 1,
    }
    if contract.get("max_rows"):
        out["max_rows"] = contract["max_rows"]
    out["columns"] = columns
    return out


def contract_yaml(target: UploadTarget) -> str:
    header = (
        f'# Published by DataDesk from the onboarded table "{target.display_name}" ({target.location}).\n'
        "# Change it in DataDesk (Onboarding); edits made here are overwritten on the next publish.\n"
    )
    return header + yaml.safe_dump(cloud_run_contract(target), sort_keys=False, allow_unicode=True, width=120)


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def should_publish(settings: Settings, target: UploadTarget) -> bool:
    return settings.file_upload_enabled and target.onboarding_status == "approved" and target.is_active


def _publish_sync(settings: Settings, target: UploadTarget) -> dict | None:
    name = contract_object(settings, target)
    published = target.contract_published or {}
    if not should_publish(settings, target):
        if published:
            file_pipeline.delete_contract(name)
        return None

    text = contract_yaml(target)
    sha = _sha(text)
    if published.get("sha") == sha:
        return published  # nothing changed: Cloud Run already has exactly this

    # Cloud Run maps a file to the one contract whose pattern matches its name: any other
    # contract for the same table goes (it was this table's before DataDesk owned it), and one
    # for another table that would also match is a clash the admin has to resolve
    fu = settings_of(target)
    example = f"{prefix_of(target, fu)}_20260101.{fu.formats[0]}"
    table = f"{target.database_name}.{target.table_name}"
    replaced = []
    for obj, body in file_pipeline.list_contracts().items():
        if obj == name:
            continue
        try:
            other = yaml.safe_load(body) or {}
        except yaml.YAMLError:
            continue
        if other.get("target_table") == table:
            replaced.append(obj)
            continue
        pattern = other.get("file_pattern")
        try:
            clash = bool(pattern) and re.fullmatch(pattern, example) is not None
        except re.error:
            clash = False
        if clash:
            raise ServiceError(
                f"Cloud Run's contract {obj} (for {other.get('target_table')}) already takes files "
                f"named like {example}. Pick another file name prefix.",
                status_code=409,
                field="file_prefix",
            )
    for obj in replaced:
        file_pipeline.delete_contract(obj)
    uri = file_pipeline.write_contract(name, text)
    return {
        "uri": uri,
        "version": target.contract_version,
        "published_at": datetime.now(UTC).isoformat(),
        "sha": sha,
        **({"replaced": replaced} if replaced else {}),
    }


async def publish_contract(settings: Settings, target: UploadTarget) -> None:
    """Make Cloud Run's copy of the contract match the onboarded table: written while the table
    is approved, open and takes files; removed otherwise. Run on every change to a target, in
    the same transaction, so a failure to publish rolls the change back."""
    if not settings.file_upload_enabled or (
        not target.contract_published and not should_publish(settings, target)
    ):
        return
    try:
        target.contract_published = await asyncio.to_thread(_publish_sync, settings, target)
    except ServiceError:
        raise
    except Exception as exc:
        log.warning("publishing the contract of %s failed: %s", target.location, exc)
        raise ServiceError(
            f"Could not publish the contract to gs://{settings.file_upload_config_bucket}: {exc}",
            status_code=502,
        ) from exc


# ------------------------------------------------------------------ starting from Cloud Run's rules
def from_cloud_run(data: dict) -> tuple[Contract, list[str]]:
    """A Cloud Run YAML contract in DataDesk's form, and what couldn't be carried over."""
    notes: list[str] = []
    unique_key = list(data.get("unique_key") or [])
    if len(unique_key) > 1:
        notes.append(
            f"The combined unique key ({', '.join(unique_key)}) isn't carried over: "
            "mark single columns unique instead."
        )
    rules = []
    for col in data.get("columns") or []:
        rules.append(
            ColumnRule(
                name=col["name"],
                description=col.get("description"),
                required=bool(col.get("required")),
                unique=bool(col.get("unique")) or unique_key == [col["name"]],
                regex=col.get("regex"),
                enum=[str(v) for v in col["allowed_values"]] if col.get("allowed_values") else None,
                min=col.get("min"),
                max=col.get("max"),
                min_length=col.get("min_length"),
                max_length=col.get("max_length"),
                format=col.get("format"),
                severity="warning" if str(col.get("severity", "")).upper() == "WARNING" else "error",
            )
        )
    prefix = None
    match = re.match(r"^\^?([A-Za-z0-9][A-Za-z0-9_-]*)_\(", data.get("file_pattern") or "")
    if match:
        prefix = match.group(1)
    else:
        notes.append(f"Its file pattern {data.get('file_pattern')!r} isn't a simple prefix: set one below.")
    formats = [f for f in data.get("file_format") or ["csv"] if f in ("csv", "xlsx")] or ["csv"]
    contract = Contract(
        columns=rules,
        min_rows=data.get("min_rows") if (data.get("min_rows") or 1) > 1 else None,
        max_rows=data.get("max_rows"),
        file_upload=FileUpload(
            enabled=True,
            file_prefix=prefix,
            load_modes=data.get("load_modes") or [data.get("load_mode") or "append"],
            formats=formats,
        ),
    )
    return contract, notes


async def existing_cloud_run_contract(dataset: str, table: str) -> dict | None:
    """The contract Cloud Run has today for dataset.table, if any (one DataDesk didn't write)."""
    settings = get_settings()
    if not settings.file_upload_enabled:
        return None
    try:
        sources = await asyncio.to_thread(file_pipeline.list_contracts)
    except Exception as exc:
        raise ServiceError(f"Could not read Cloud Run's contracts: {exc}", status_code=502) from exc
    for name, body in sorted(sources.items()):
        try:
            data = yaml.safe_load(body) or {}
        except yaml.YAMLError:
            continue
        if data.get("target_table") == f"{dataset}.{table}":
            contract, notes = from_cloud_run(data)
            return {
                "source": f"gs://{settings.file_upload_config_bucket}/{name}",
                "contract": contract,
                "notes": notes,
            }
    return None


# ------------------------------------------------------------------ the tables people can pick
def target_option(target: UploadTarget) -> dict:
    fu = settings_of(target)
    return {
        "target_id": target.id,
        "dataset": target.database_name,
        "table": target.table_name,
        "label": target.display_name,
        "description": target.description,
        "file_prefix": prefix_of(target, fu),
        "expected_name": expected_name(target, fu),
        "load_mode": fu.load_mode,
        "load_modes": fu.load_modes,
        "formats": fu.formats,
        "contract": target.contract,
        "contract_version": target.contract_version,
        "columns": file_columns(target),
        "published": target.contract_published,
    }


async def targets(session: AsyncSession) -> list[dict]:
    rows = await session.scalars(
        select(UploadTarget)
        .where(
            UploadTarget.target_type == "bigquery",
            UploadTarget.is_active.is_(True),
            UploadTarget.onboarding_status == "approved",
        )
        .order_by(UploadTarget.display_name)
    )
    return [target_option(t) for t in rows]


# ------------------------------------------------------------------ naming
_DATE_IN_NAME = re.compile(r"(?<!\d)(\d{4})[-_]?(\d{2})[-_]?(\d{2})(?!\d)")


def date_in_name(name: str) -> date | None:
    """A date written into a file name: sales_20261015.csv, report-2026-10-15.xlsx."""
    for match in _DATE_IN_NAME.finditer(name or ""):
        try:
            return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        except ValueError:
            continue
    return None


def landing_name(prefix: str, fmt: str, file_date: date) -> str:
    return f"{prefix}_{file_date:%Y%m%d}.{'xlsx' if fmt == 'xlsx' else 'csv'}"


@dataclass
class Naming:
    landing_name: str
    file_date: date
    # the file already had the name the contract expects
    matched: bool
    expected: str


def name_file(target: UploadTarget, fu: FileUpload, original: str, fmt: str, chosen: date | None) -> Naming:
    """The name a file lands under: its own when it already fits, else {prefix}_{date}.{ext}
    with the date chosen on the form, the one in its name, or today."""
    prefix = prefix_of(target, fu)
    day = chosen or date_in_name(original) or datetime.now(UTC).date()
    name = landing_name(prefix, fmt, day)
    return Naming(name, day, original == name, expected_name(target, fu))


# ------------------------------------------------------------------ checking a file
def header_problems(actual: list[str], expected: list[str]) -> list[dict]:
    """Cloud Run reads the header as is: every column, in contract order, nothing extra."""
    if actual == expected:
        return []
    missing = [c for c in expected if c not in actual]
    extra = [c for c in actual if c not in expected]
    problems = [
        {
            "row": None,
            "column": c,
            "rule": "header",
            "message": f"Column '{c}' is missing; Cloud Run needs every column.",
        }
        for c in missing
    ]
    problems += [
        {
            "row": None,
            "column": c,
            "rule": "header",
            "message": f"Column '{c}' isn't in the table; remove it.",
        }
        for c in extra
    ]
    if not problems:
        problems.append(
            {
                "row": None,
                "column": None,
                "rule": "header",
                "message": f"The columns are in the wrong order. Cloud Run needs: {', '.join(expected)}.",
            }
        )
    return problems


def _format_problems(file: WorkspaceFile, fu: FileUpload, delimiter: str | None) -> list[dict]:
    def problem(message: str) -> list[dict]:
        return [{"row": None, "column": None, "rule": "file", "message": message}]

    if file.format not in fu.formats:
        allowed = " or ".join(f.upper() for f in fu.formats)
        return problem(f"Cloud Run takes {allowed} files for this table; this one is {file.format.upper()}.")
    if file.format == "csv" and delimiter and delimiter != ",":
        names = {"\t": "tab", ";": "semicolon", "|": "pipe"}
        return problem(
            "Cloud Run reads comma-separated files; this one is "
            f"{names.get(delimiter, repr(delimiter))}-separated. "
            "Open it in My files, set the delimiter to comma and save."
        )
    return []


async def check_file(
    session: AsyncSession,
    settings: Settings,
    file: WorkspaceFile,
    version: int,
    target: UploadTarget,
    naming: Naming,
    mode: str | None = None,
) -> dict:
    """The report Cloud Run's own checks would give, as far as DataDesk can tell before it lands."""
    fu = settings_of(target)
    parsed = await ws.read_content(session, settings, file, version, None)
    expected = [c["name"] for c in file_columns(target)]
    errors = _format_problems(file, fu, parsed.get("delimiter")) + header_problems(
        parsed["columns"], expected
    )

    try:
        live = await loaders.target_columns(target.database_name, target.table_name)
    except Exception as exc:
        raise ServiceError(f"Could not read the table's schema: {exc}", status_code=502) from exc
    contract = target.contract or {}
    report = validators.validate(
        parsed,
        [c for c in live if c["name"] not in AUDIT_COLUMNS],
        "append",
        None,
        validators.rules_from_contract(contract),
        max_rows=contract.get("max_rows"),
        min_rows=contract.get("min_rows"),
        strict=True,
    )
    # the header problems say it better than "not in the table" for each column
    report["errors"] = errors + [
        e for e in report["errors"] if e["rule"] not in ("unknown_column", "missing_column")
    ]
    report["passed"] = not report["errors"]
    if report["passed"]:
        report["summary"] = "All checks passed." + (
            f" {len(report['warnings'])} warning(s): shown, but they don't stop the file."
            if report["warnings"]
            else ""
        )
    elif errors:
        report["summary"] = f"{len(report['errors'])} problem(s) found." + (
            f" {len(report['warnings'])} warning(s)." if report["warnings"] else ""
        )
    report["contract_version"] = target.contract_version
    report["contract_rules"] = len(validators.rules_from_contract(contract))
    report["file"] = {"format": file.format, "delimiter": parsed.get("delimiter"), "version": version}
    report["pipeline"] = {
        "landing_name": naming.landing_name,
        "file_date": naming.file_date.isoformat(),
        "name_matched": naming.matched,
        "original_name": file.original_name,
        "expected_name": naming.expected,
        "load_mode": mode or fu.load_mode,
    }
    return report


async def _pipeline_target(
    session: AsyncSession, target_id: uuid.UUID | None
) -> tuple[UploadTarget, FileUpload]:
    target = await session.get(UploadTarget, target_id) if target_id else None
    if target is None or not target.is_open:
        raise ServiceError("That table is no longer open for file uploads.", status_code=404)
    return target, settings_of(target)


async def create_request(
    session: AsyncSession,
    settings: Settings,
    user: User,
    file_id: uuid.UUID,
    target_id: uuid.UUID,
    file_date: date | None,
    justification: str | None,
    load_mode: str | None = None,
) -> tuple[UploadRequest | None, WorkspaceFile, dict, UploadTarget]:
    """Check the file as Cloud Run will and, when it passes, file a request for an admin."""
    if not settings.file_upload_enabled:
        raise ServiceError("File upload is switched off: set FILE_UPLOAD_* in .env.", status_code=503)
    file = await ws.owned_file(session, file_id, user.id)
    target, fu = await _pipeline_target(session, target_id)
    mode = load_mode or fu.load_mode
    if mode not in fu.load_modes:
        raise ServiceError(f"{target.display_name} doesn't take {mode} loads.", field="load_mode")
    naming = name_file(target, fu, file.original_name, file.format, file_date)
    report = await check_file(session, settings, file, file.current_version, target, naming, mode)
    if not report["passed"]:
        log.info(
            "file upload check failed: %s → %s: %s", file.original_name, target.location, report["summary"]
        )
        return None, file, report, target

    request = UploadRequest(
        user_id=user.id,
        file_id=file.id,
        file_version=file.current_version,
        target_type="bigquery",
        target_database=target.database_name,
        target_table=target.table_name,
        write_mode=mode,
        justification=(justification or "").strip() or None,
        validation_status="passed",
        validation_report=report,
        status="pending",
        target_id=target.id,
        contract_version=target.contract_version,
        origin="pipeline",
        file_date=naming.file_date,
        landing_name=naming.landing_name,
    )
    session.add(request)
    await session.flush()
    log.info(
        "file upload filed: %s v%d → %s as %s (contract v%d, %s)",
        file.original_name,
        file.current_version,
        target.location,
        naming.landing_name,
        target.contract_version,
        mode,
    )
    return request, file, report, target


# ------------------------------------------------------------------ approving: into the landing bucket
async def approve(
    session: AsyncSession, settings: Settings, admin: User, request: UploadRequest
) -> UploadRequest:
    """Check again against the contract as it is now, then put the file in the landing bucket.
    The request stays "approved" until Cloud Run's outcome is read back (refresh)."""
    if not settings.file_upload_enabled:
        raise ServiceError("File upload is switched off: set FILE_UPLOAD_* in .env.", status_code=503)
    target, fu = await _pipeline_target(session, request.target_id)

    # a request filed under an older file name rule would land where no contract matches
    if not re.fullmatch(file_pattern(prefix_of(target, fu), fu.formats), request.landing_name or ""):
        raise ServiceError(
            f"This request would land as {request.landing_name}, but Cloud Run now expects "
            f"{expected_name(target, fu)}. Reject it and send the file again.",
            status_code=409,
        )

    # Approving never publishes. It checks what Cloud Run reads: the contract in the config
    # bucket must be this table's current one. No waiting for Cloud Run's cache: the file carries
    # its contract version, and Cloud Run re-reads a cached contract of another version.
    current = contract_yaml(target)
    try:
        live = await asyncio.to_thread(file_pipeline.read_contract, contract_object(settings, target))
    except Exception as exc:
        raise ServiceError(f"Could not read Cloud Run's contract: {exc}", status_code=502) from exc
    if live is None or _sha(live[0]) != _sha(current):
        raise ServiceError(
            "Cloud Run doesn't have this table's current contract. Open the table in Onboarding and "
            "save it to publish it, then approve again.",
            status_code=409,
        )
    since = live[1]
    if (target.contract_published or {}).get("sha") != _sha(current):
        # the bucket is right but the record of it isn't (a publish whose transaction rolled back)
        target.contract_published = {
            "uri": f"gs://{settings.file_upload_config_bucket}/{contract_object(settings, target)}",
            "version": target.contract_version,
            "published_at": since.isoformat(),
            "sha": _sha(current),
        }

    file = await session.get(WorkspaceFile, request.file_id)
    if file is None or file.status != "active":
        raise ServiceError("The source file no longer exists.", status_code=410)

    request.status = "approved"
    request.reviewed_by = admin.id
    request.reviewed_at = datetime.now(UTC)

    if request.write_mode not in fu.load_modes:
        raise ServiceError(
            f"{target.display_name} no longer takes {request.write_mode} loads. "
            "Reject this and send it again.",
            status_code=409,
        )
    naming = Naming(request.landing_name, request.file_date, False, expected_name(target, fu))
    report = await check_file(
        session, settings, file, request.file_version, target, naming, request.write_mode
    )
    if not report["passed"]:
        request.status = "failed"
        request.validation_status = "failed"
        request.validation_report = report
        changed = target.contract_version != request.contract_version
        request.result = {
            "error": "The file no longer passes: the data contract changed since the request "
            f"(now v{target.contract_version})."
            if changed
            else "The file no longer matches the table (checked again at approval)."
        }
        log.info("file upload %s failed re-validation: %s", request.id, report["summary"])
        return request

    path, _ = await ws.version_path(session, file, request.file_version)
    # the table folder tells Cloud Run which contract to read (only that one): dataset.table
    name = (
        f"{settings.file_upload_landing_prefix.strip('/')}/{target.database_name}.{target.table_name}/"
        f"{request.id}/{request.landing_name}"
    )
    try:
        # the chosen mode travels with the file: Cloud Run reads it from the object's metadata
        uri, generation = await asyncio.to_thread(
            file_pipeline.land,
            path,
            name,
            FORMAT_TYPES[file.format],
            # what Cloud Run reads from the object: the mode, and the contract version it was checked with
            {"load_mode": request.write_mode, "contract_version": str(target.contract_version)},
        )
    except Exception as exc:
        request.status = "failed"
        request.result = {"error": f"Could not put the file in the landing bucket: {exc}"}
        log.warning("landing %s failed: %s", request.id, exc)
        return request
    request.landing_uri = uri
    request.landing_generation = generation
    request.landed_at = datetime.now(UTC)
    # bucket objects the move leaves behind: the API deletes them once this is committed
    request.stale_objects = await _archive(session, file)
    request.result = {"landed": uri}
    request.pipeline = {
        "state": "waiting",
        "message": "In the landing bucket, waiting for Cloud Run",
        "jobs": [],
        "checks": [],
    }
    request.pipeline_checked_at = request.landed_at
    log.info("%s approved file upload %s → %s", admin.username, request.id, uri)
    return request


async def _archive(session: AsyncSession, file: WorkspaceFile) -> list[str]:
    """Once a file is with Cloud Run, move it to My files › File uploads › Archive, so the files
    people send don't pile up where they work. Best effort: the load goes ahead either way.
    Returns the old bucket objects, to delete after the commit."""
    from app.schemas.workspace import TransferIn
    from app.services import transfer

    out = transfer.Outcome()
    try:
        owner = await session.get(User, file.user_id)
        archive = await ws.ensure_folder(session, file.user_id, ARCHIVE_FOLDER)
        if file.folder_id != archive.id:
            await transfer.move(
                session, owner, TransferIn(file_ids=[file.id], destination_id=archive.id), out
            )
            log.info("archived %s to %s", file.original_name, "/".join(ARCHIVE_FOLDER))
    except Exception as exc:
        # a move that stopped part way may point some versions at their copies: delete nothing
        log.warning("could not archive %s after landing: %s", file.original_name, exc)
        return []
    return out.stale_objects


# ------------------------------------------------------------------ following Cloud Run
TERMINAL = ("completed", "failed", "rejected")


def failures_of(check: dict) -> list[dict]:
    """Each failing rule inside a validation_metadata row: which column, what was expected,
    how many rows, and up to ten sample rows (from `details`)."""
    details = check.get("details") or {}
    out = []

    def add(column: str | None, rule: str, item: dict) -> None:
        if not isinstance(item, dict) or item.get("result") != "FAIL":
            return
        out.append(
            {
                "column": column,
                "check": rule.upper(),
                "severity": item.get("severity") or check.get("severity"),
                "failed": item.get("failed"),
                "evaluated": item.get("evaluated"),
                "expected": item.get("expected"),
                "actual": item.get("actual"),
                "error": item.get("error"),
                "samples": item.get("samples") or [],
            }
        )

    if "columns" in details or "file" in details:
        for rule, item in (details.get("file") or {}).items():
            add(None, rule, item)
        for column, rules in (details.get("columns") or {}).items():
            for rule, item in (rules or {}).items():
                add(column, rule, item)
    else:
        add(None, check.get("check_name") or check.get("check_type") or "check", details)
    return out


def _attempts(job: dict) -> int:
    return max(job.get("delivery_attempt") or 0, job.get("attempt_number") or 0)


def summarize(
    jobs: list[dict],
    landed_at: datetime,
    now: datetime,
    pickup_minutes: int,
    max_attempts: int,
    in_landing: bool | None = None,
) -> dict:
    """Where a landed file stands, from its job_metadata rows (oldest first):
    {state, status (the request's), message, error?}."""
    latest = jobs[-1] if jobs else None
    if latest is None:
        waited = (now - landed_at).total_seconds() / 60
        if waited < pickup_minutes:
            return {
                "state": "waiting",
                "status": "approved",
                "message": "In the landing bucket, waiting for Cloud Run",
            }
        where = (
            " The file is still in the landing bucket."
            if in_landing
            else " The file is no longer in the landing bucket, but no job was recorded."
            if in_landing is False
            else ""
        )
        return {
            "state": "not_picked_up",
            "status": "approved",
            "message": f"Cloud Run hasn't picked the file up {int(waited)} minutes after it landed.{where} "
            "Check the file-landing Pub/Sub subscription, its dead-letter topic and the Cloud Run logs.",
        }

    status = latest.get("status")
    reason = latest.get("status_reason") or latest.get("error_message") or ""
    attempt = _attempts(latest)
    if status == "IN_PROGRESS":
        return {
            "state": "processing",
            "status": "approved",
            "message": f"Cloud Run is checking and loading the file (attempt {attempt or 1})",
        }
    if status == "SUCCESS":
        rows = latest.get("rows_loaded")
        return {
            "state": "succeeded",
            "status": "completed",
            "message": f"Loaded {rows if rows is not None else '?'} rows into "
            f"{latest.get('target_table') or 'the table'}"
            + (f" ({reason})" if reason and "archive" in reason else ""),
        }
    if status == "REJECTED":
        code = latest.get("error_code") or ""
        message = {
            "NO_CONTRACT": "Cloud Run found no contract for this file name, so it was not loaded.",
            "AMBIGUOUS_CONTRACT": "More than one Cloud Run contract matches this file name, "
            "so it was not loaded.",
        }.get(code, f"Cloud Run rejected the file: {reason}" if reason else "Cloud Run rejected the file.")
        return {"state": "rejected", "status": "failed", "message": message, "error": message}
    if status == "FAILED":
        if latest.get("error_code") == "TRANSIENT":
            if attempt < max_attempts:
                return {
                    "state": "retrying",
                    "status": "approved",
                    "message": f"Attempt {attempt} hit a temporary error; Pub/Sub retries it "
                    f"({latest.get('error_message') or reason})",
                }
            message = (
                f"Cloud Run gave up after {attempt} attempts ({latest.get('error_message') or reason}). "
                "The message is in the file-landing dead-letter topic."
            )
            return {"state": "failed", "status": "failed", "message": message, "error": message}
        detail = latest.get("error_message") or reason or "unknown error"
        message = f"Cloud Run failed: {detail}"
        if latest.get("error_code") == "RECON_MISMATCH":
            message = (
                f"Loaded {latest.get('rows_loaded')} rows but the file has {latest.get('rows_in_file')}: "
                "the rows are in the table and can be found by _job_id."
            )
        return {"state": "failed", "status": "failed", "message": message, "error": message}
    return {"state": "processing", "status": "approved", "message": f"Cloud Run reports {status}"}


def _job_view(job: dict) -> dict:
    keep = (
        "job_id",
        "status",
        "status_reason",
        "attempt_number",
        "delivery_attempt",
        "start_time",
        "end_time",
        "duration_seconds",
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
    return {k: job.get(k) for k in keep}


def _check_view(check: dict) -> dict:
    return {
        "job_id": check.get("job_id"),
        "check_name": check.get("check_name"),
        "check_type": check.get("check_type"),
        "stage": check.get("stage"),
        "result": check.get("validation_result"),
        "severity": check.get("severity"),
        "summary": check.get("summary"),
        "records_evaluated": check.get("records_evaluated"),
        "records_failed": check.get("records_failed"),
        "records_warned": check.get("records_warned"),
        "checks_evaluated": check.get("checks_evaluated"),
        "checks_failed": check.get("checks_failed"),
        "failed_checks": check.get("failed_checks") or [],
        "failures": failures_of(check),
        "validated_at": check.get("validated_at"),
    }


async def refresh(
    session: AsyncSession, settings: Settings, requests: list[UploadRequest], *, with_checks: bool = False
) -> None:
    """Read Cloud Run's attempts (and, when asked or when a request just finished, its checks)
    for these landed requests, and move each one on.

    DataDesk's database is the record; file_audit is only where news comes from. So a request that is
    completed or failed is never read again, every attempt seen once is kept even if its row
    later disappears from BigQuery (a cleanup, a truncate), and a failure to reach BigQuery
    leaves the request as it was, with the reason in its snapshot."""
    landed = [
        r
        for r in requests
        if r.origin == "pipeline" and r.status == "approved" and r.landing_uri and r.landed_at
    ]
    if not landed:
        return
    now = datetime.now(UTC)
    since = min(r.landed_at for r in landed) - timedelta(minutes=10)
    try:
        jobs = await asyncio.to_thread(file_pipeline.jobs_for, sorted({r.landing_uri for r in landed}), since)
    except Exception as exc:
        log.warning("reading file_audit.job_metadata failed: %s", exc)
        for r in landed:
            r.pipeline = {
                **(r.pipeline or {}),
                "read_error": f"Could not read Cloud Run's job records: {exc}",
            }
            r.pipeline_checked_at = now
        return

    mine: dict[uuid.UUID, list[dict]] = {}
    for r in landed:
        # what was seen before, updated with what BigQuery says now; nothing is ever dropped
        seen = {j["job_id"]: j for j in (r.pipeline or {}).get("jobs", []) if j.get("job_id")}
        for j in jobs:
            if j.get("file_path") == r.landing_uri and (
                not j.get("file_generation")
                or not r.landing_generation
                or str(j["file_generation"]) == r.landing_generation
            ):
                seen[j["job_id"]] = _job_view(j)
        mine[r.id] = sorted(seen.values(), key=lambda j: str(j.get("created_at") or ""))

    states: dict[uuid.UUID, dict] = {}
    for r in landed:
        in_landing = None
        if not mine[r.id] and (now - r.landed_at).total_seconds() / 60 >= settings.file_upload_pickup_minutes:
            try:
                in_landing = await asyncio.to_thread(
                    file_pipeline.landing_object_exists, r.landing_uri, r.landing_generation
                )
            except Exception:
                in_landing = None
        states[r.id] = summarize(
            mine[r.id],
            r.landed_at,
            now,
            settings.file_upload_pickup_minutes,
            settings.file_upload_max_attempts,
            in_landing,
        )

    # the checks of each request's latest attempt: always once it is over, otherwise on request
    wanted = {
        r.id: mine[r.id][-1]["job_id"]
        for r in landed
        if mine[r.id] and (with_checks or states[r.id]["status"] in TERMINAL)
    }
    checks: list[dict] = []
    if wanted:
        try:
            checks = await asyncio.to_thread(file_pipeline.checks_for, sorted(set(wanted.values())), since)
        except Exception as exc:
            log.warning("reading file_audit.validation_metadata failed: %s", exc)

    for r in landed:
        state = states[r.id]
        latest_job = wanted.get(r.id)
        previous = r.pipeline or {}
        own = [_check_view(c) for c in checks if latest_job and c.get("job_id") == latest_job]
        snapshot = {
            "state": state["state"],
            "message": state["message"],
            "jobs": [_job_view(j) for j in mine[r.id]],
            # checks not read this time (or not written yet): keep the ones read before
            "checks": own or (previous.get("checks", []) if mine[r.id] else []),
        }
        if previous.get("state") != state["state"]:
            log.info("file upload %s: %s → %s", r.id, previous.get("state") or "-", state["state"])
        r.pipeline = snapshot
        r.pipeline_checked_at = now
        if state["status"] != r.status:
            r.status = state["status"]
            last = mine[r.id][-1] if mine[r.id] else {}
            if r.status == "completed":
                r.executed_at = _ts(last.get("end_time")) or now
                r.result = {
                    "rows_loaded": last.get("rows_loaded"),
                    "final_path": last.get("final_file_path"),
                    "job_id": last.get("job_id"),
                }
            elif r.status == "failed":
                r.executed_at = _ts(last.get("end_time")) or now
                r.result = {"error": state.get("error") or state["message"], "job_id": last.get("job_id")}


def _ts(value) -> datetime | None:
    return datetime.fromisoformat(value) if isinstance(value, str) else value


async def get_request(session: AsyncSession, request_id: uuid.UUID) -> UploadRequest:
    request = await session.get(UploadRequest, request_id)
    if request is None or request.origin != "pipeline":
        raise NotFound("File upload")
    return request


def visible_pipeline(pipeline: dict | None, *, full: bool) -> dict | None:
    """Sample values come from a private file: only the requester and admins see them."""
    if pipeline is None or full:
        return pipeline
    checks = [
        {**c, "failures": [{**f, "samples": [], "actual": None} for f in c.get("failures", [])]}
        for c in pipeline.get("checks", [])
    ]
    return {**pipeline, "checks": checks}


# ------------------------------------------------------------------ publishing at startup
async def publish_all(settings: Settings) -> None:
    """Make sure Cloud Run has the contract of every open table (tables onboarded before every
    table took files, or published while Cloud Run's bucket was unreachable). Unchanged
    contracts aren't rewritten."""
    from app.core.db import get_sessionmaker

    if not settings.file_upload_enabled:
        return
    async with get_sessionmaker()() as session:
        targets = list(
            await session.scalars(
                select(UploadTarget).where(
                    UploadTarget.onboarding_status == "approved", UploadTarget.is_active.is_(True)
                )
            )
        )
        published = 0
        for target in targets:
            before = (target.contract_published or {}).get("sha")
            try:
                await publish_contract(settings, target)
            except Exception as exc:  # one table's problem doesn't stop the others
                log.warning("publishing the contract of %s at startup failed: %s", target.location, exc)
                continue
            published += (target.contract_published or {}).get("sha") != before
        await session.commit()
    log.info("contracts: %d of %d open tables (re)published to Cloud Run", published, len(targets))


# ------------------------------------------------------------------ the background poller
async def poll_forever(settings: Settings) -> None:
    """Every FILE_UPLOAD_POLL_SECONDS, read Cloud Run's progress for every request it still has
    and save it, so an outcome is recorded even when nobody has the request open."""
    from app.core.db import get_sessionmaker

    log.info("file upload poller: every %ds", settings.file_upload_poll_seconds)
    while True:
        await asyncio.sleep(settings.file_upload_poll_seconds)
        try:
            async with get_sessionmaker()() as session:
                moving = list(
                    await session.scalars(
                        select(UploadRequest).where(
                            UploadRequest.origin == "pipeline",
                            UploadRequest.status == "approved",
                            UploadRequest.landing_uri.is_not(None),
                        )
                    )
                )
                if moving:
                    await refresh(session, settings, moving)
                    await session.commit()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # keep polling: the next round may well work
            log.warning("file upload poller: %s: %s", type(exc).__name__, exc)
