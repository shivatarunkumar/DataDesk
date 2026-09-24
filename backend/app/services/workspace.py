"""A person's own workspace: folders, files, versions, and requests to load a file.

Nothing here writes to a target table. A load request is created only after the file
passes validation against the table's live schema; the load itself runs when an admin
approves it (services/reviews.py).
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.storage import StorageNotConfigured, get_storage
from app.core.config import Settings
from app.models.targets import (
    BqAccessRequest,
    BqTableCache,
    DbAccessGrant,
    PgDatabase,
    PgTableCatalog,
    UploadTarget,
)
from app.models.user import User
from app.models.workspace import UploadRequest, WorkspaceFile, WorkspaceFileVersion, WorkspaceFolder
from app.schemas.workspace import TargetTable, UploadRequestCreate
from app.services import file_parser, loaders, validators
from app.services.errors import NotFound, ServiceError

log = logging.getLogger("datadesk.workspace")

DELIMITERS = {"comma": ",", "tab": "\t", "semicolon": ";", "pipe": "|"}
ORACLE_PLACEHOLDER = TargetTable(
    target_type="oracle", database=None, table="—", label="Oracle (coming soon)", enabled=False
)


# ------------------------------------------------------------------ storage
async def run_storage(call, *args):
    """Run a blocking storage call in a thread, with errors the person can act on."""
    try:
        return await asyncio.to_thread(call, *args)
    except StorageNotConfigured as exc:
        raise ServiceError(str(exc), status_code=503) from exc
    except ServiceError:
        raise
    except Exception as exc:
        log.warning(
            "storage call %s failed: %s: %s", getattr(call, "__name__", call), type(exc).__name__, exc
        )
        raise ServiceError(f"Storage error: {exc}", status_code=502) from exc


def resolve_delimiter(value: str | None) -> str | None:
    """'tab' / 'comma' / … or a literal character → the delimiter; None or 'auto' = detect."""
    if not value or value == "auto":
        return None
    return DELIMITERS.get(value, value[0])


# ------------------------------------------------------------------ lookups
async def folder_path(session: AsyncSession, folder_id: uuid.UUID | None, user_id: uuid.UUID) -> str:
    if not folder_id:
        return ""
    folder = await session.scalar(
        select(WorkspaceFolder).where(WorkspaceFolder.id == folder_id, WorkspaceFolder.user_id == user_id)
    )
    if folder is None:
        raise NotFound("Folder")
    return folder.path


async def owned_file(session: AsyncSession, file_id: uuid.UUID, user_id: uuid.UUID) -> WorkspaceFile:
    file = await session.scalar(
        select(WorkspaceFile).where(
            WorkspaceFile.id == file_id, WorkspaceFile.user_id == user_id, WorkspaceFile.status == "active"
        )
    )
    if file is None:
        raise NotFound("File")
    return file


async def version_path(session: AsyncSession, file: WorkspaceFile, version: int | None) -> tuple[str, int]:
    """(GCS path, version) for a version of the file; the current one when None."""
    if version is None or version == file.current_version:
        return file.current_gcs_path, file.current_version
    row = await session.scalar(
        select(WorkspaceFileVersion).where(
            WorkspaceFileVersion.file_id == file.id, WorkspaceFileVersion.version == version
        )
    )
    if row is None:
        raise NotFound("Version")
    return row.gcs_path, row.version


# ------------------------------------------------------------------ folders
async def list_folders(session: AsyncSession, user_id: uuid.UUID) -> list[WorkspaceFolder]:
    rows = await session.scalars(
        select(WorkspaceFolder).where(WorkspaceFolder.user_id == user_id).order_by(WorkspaceFolder.path)
    )
    return list(rows)


async def create_folder(
    session: AsyncSession, user_id: uuid.UUID, name: str, parent_id: uuid.UUID | None
) -> WorkspaceFolder:
    name = name.strip()
    if not name or "/" in name or name in (".", ".."):
        raise ServiceError("Folder names can't be empty, '.' or '..', or contain '/'.", field="name")
    parent = await folder_path(session, parent_id, user_id)
    path = f"{parent}/{name}" if parent else name

    clash = await session.scalar(
        select(WorkspaceFolder.id).where(WorkspaceFolder.user_id == user_id, WorkspaceFolder.path == path)
    )
    if clash:
        raise ServiceError("A folder with that name already exists here.", status_code=409, field="name")

    storage = get_storage()
    if storage.configured:
        # mirror the folder in the bucket, so an empty folder is visible there too
        await run_storage(
            storage.upload, storage.folder_marker_path(str(user_id), path), b"", "application/x-directory"
        )

    folder = WorkspaceFolder(user_id=user_id, parent_id=parent_id, name=name, path=path)
    session.add(folder)
    await session.flush()
    log.info("created folder %s", path)
    return folder


async def delete_folder(session: AsyncSession, user_id: uuid.UUID, folder_id: uuid.UUID) -> None:
    folder = await session.scalar(
        select(WorkspaceFolder).where(WorkspaceFolder.id == folder_id, WorkspaceFolder.user_id == user_id)
    )
    if folder is None:
        raise NotFound("Folder")

    has_subfolders = await session.scalar(
        select(WorkspaceFolder.id).where(WorkspaceFolder.parent_id == folder_id).limit(1)
    )
    has_files = await session.scalar(
        select(WorkspaceFile.id)
        .where(WorkspaceFile.folder_id == folder_id, WorkspaceFile.status == "active")
        .limit(1)
    )
    if has_subfolders or has_files:
        raise ServiceError("This folder isn't empty. Delete what's inside it first.", status_code=409)

    storage = get_storage()
    if storage.configured:
        try:
            await asyncio.to_thread(storage.delete, storage.folder_marker_path(str(user_id), folder.path))
        except Exception as exc:  # the marker is cosmetic; don't block the delete on it
            log.warning("could not remove folder marker for %s: %s", folder.path, exc)
    await session.delete(folder)
    log.info("deleted folder %s", folder.path)


# ------------------------------------------------------------------ files
async def list_files(session: AsyncSession, user_id: uuid.UUID) -> list[WorkspaceFile]:
    rows = await session.scalars(
        select(WorkspaceFile)
        .where(WorkspaceFile.user_id == user_id, WorkspaceFile.status == "active")
        .order_by(WorkspaceFile.updated_at.desc())
    )
    return list(rows)


def _column_meta(parsed: dict) -> list[dict]:
    return [{"name": c, "inferred_type": parsed["inferred_types"].get(c)} for c in parsed["columns"]]


async def upload_file(
    session: AsyncSession,
    settings: Settings,
    user: User,
    filename: str,
    data: bytes,
    folder_id: uuid.UUID | None,
) -> WorkspaceFile:
    fmt = file_parser.detect_format(filename)
    if not fmt:
        raise ServiceError("Only .csv, .tsv, .xlsx and .json files are supported.", status_code=415)
    if len(data) > settings.max_upload_bytes:
        limit_mb = settings.max_upload_bytes // (1024 * 1024)
        raise ServiceError(f"That file is larger than the {limit_mb} MB limit.", status_code=413)

    folder = await folder_path(session, folder_id, user.id)
    try:
        parsed = await asyncio.to_thread(file_parser.parse, data, fmt, None, settings.max_rows)
    except Exception as exc:
        raise ServiceError(f"Could not read that file: {exc}", status_code=422) from exc

    storage = get_storage()
    path = storage.object_path(str(user.id), 1, filename, folder)
    await run_storage(
        storage.upload, path, data, file_parser.CONTENT_TYPES.get(fmt, "application/octet-stream")
    )

    file = WorkspaceFile(
        id=uuid.uuid4(),
        user_id=user.id,
        folder_id=folder_id,
        original_name=filename,
        format=fmt,
        current_version=1,
        current_gcs_path=path,
        row_count=parsed["row_count"],
        column_meta=_column_meta(parsed),
        size_bytes=len(data),
        is_permanent=False,
    )
    session.add(file)
    session.add(
        WorkspaceFileVersion(
            file_id=file.id,
            version=1,
            gcs_path=path,
            row_count=parsed["row_count"],
            size_bytes=len(data),
            note="Initial upload",
            created_by=user.id,
        )
    )
    await session.flush()
    log.info("uploaded %s (%s, %d rows, %d bytes)", filename, fmt, parsed["row_count"], len(data))
    return file


async def read_content(
    session: AsyncSession, settings: Settings, file: WorkspaceFile, version: int | None, delimiter: str | None
) -> dict:
    path, resolved = await version_path(session, file, version)
    storage = get_storage()
    data = await run_storage(storage.download, path)
    try:
        parsed = await asyncio.to_thread(
            file_parser.parse, data, file.format, resolve_delimiter(delimiter), settings.max_rows
        )
    except Exception as exc:
        raise ServiceError(f"Could not read that file: {exc}", status_code=422) from exc
    return {**parsed, "version": resolved}


async def download(session: AsyncSession, file: WorkspaceFile, version: int | None) -> bytes:
    path, _ = await version_path(session, file, version)
    return await run_storage(get_storage().download, path)


async def save_content(
    session: AsyncSession,
    settings: Settings,
    user: User,
    file: WorkspaceFile,
    columns: list[str],
    rows: list[dict],
    note: str | None,
    delimiter: str | None,
) -> WorkspaceFile:
    """Every save is a new version; earlier ones stay readable."""
    if len(set(columns)) != len(columns):
        raise ServiceError("Two columns have the same name. Rename one before saving.")
    if len(rows) > settings.max_rows:
        raise ServiceError(f"Files are limited to {settings.max_rows} rows.")
    try:
        data = file_parser.serialize(
            columns, rows, file.format, delimiter=resolve_delimiter(delimiter) or ","
        )
    except Exception as exc:
        raise ServiceError(f"Could not save those edits: {exc}") from exc

    new_version = file.current_version + 1
    folder = await folder_path(session, file.folder_id, user.id)
    storage = get_storage()
    path = storage.object_path(str(user.id), new_version, file.original_name, folder)
    await run_storage(storage.upload, path, data, file_parser.CONTENT_TYPES.get(file.format))

    reparsed = await asyncio.to_thread(file_parser.parse, data, file.format, resolve_delimiter(delimiter))
    file.current_version = new_version
    file.current_gcs_path = path
    file.row_count = len(rows)
    file.column_meta = [{"name": c, "inferred_type": reparsed["inferred_types"].get(c)} for c in columns]
    file.size_bytes = len(data)
    session.add(
        WorkspaceFileVersion(
            file_id=file.id,
            version=new_version,
            gcs_path=path,
            row_count=len(rows),
            size_bytes=len(data),
            note=note or "Edited in DataDesk",
            created_by=user.id,
        )
    )
    await session.flush()
    log.info("saved %s as v%d (%d rows)", file.original_name, new_version, len(rows))
    return file


async def restore_version(
    session: AsyncSession, settings: Settings, user: User, file: WorkspaceFile, version: int
) -> WorkspaceFile:
    """Make an earlier version current again, as a NEW version: history is never rewritten,
    so the version being replaced can itself be restored later."""
    if version == file.current_version:
        raise ServiceError(f"Version {version} is already the current one.", status_code=409)
    path, _ = await version_path(session, file, version)
    storage = get_storage()
    data = await run_storage(storage.download, path)
    try:
        parsed = await asyncio.to_thread(file_parser.parse, data, file.format, None, settings.max_rows)
    except Exception as exc:
        raise ServiceError(f"Version {version} can't be read: {exc}", status_code=422) from exc

    new_version = file.current_version + 1
    folder = await folder_path(session, file.folder_id, user.id)
    new_path = storage.object_path(str(user.id), new_version, file.original_name, folder)
    # the bytes are copied as they were, so the file comes back exactly (delimiter included)
    await run_storage(storage.upload, new_path, data, file_parser.CONTENT_TYPES.get(file.format))

    file.current_version = new_version
    file.current_gcs_path = new_path
    file.row_count = parsed["row_count"]
    file.column_meta = _column_meta(parsed)
    file.size_bytes = len(data)
    session.add(
        WorkspaceFileVersion(
            file_id=file.id,
            version=new_version,
            gcs_path=new_path,
            row_count=parsed["row_count"],
            size_bytes=len(data),
            note=f"Restored from v{version}",
            created_by=user.id,
        )
    )
    await session.flush()
    log.info("restored %s v%d as v%d", file.original_name, version, new_version)
    return file


async def delete_file(session: AsyncSession, file: WorkspaceFile) -> None:
    """Archive the metadata (load requests keep their history) and remove every blob."""
    file.status = "archived"
    storage = get_storage()
    if storage.configured:
        paths = await session.scalars(
            select(WorkspaceFileVersion.gcs_path).where(WorkspaceFileVersion.file_id == file.id)
        )
        for path in paths:
            try:
                await asyncio.to_thread(storage.delete, path)
            except Exception as exc:  # best effort: the file is already gone from the UI
                log.warning("could not delete %s: %s", path, exc)
    log.info("deleted %s", file.original_name)


async def list_versions(session: AsyncSession, file: WorkspaceFile) -> list[WorkspaceFileVersion]:
    rows = await session.scalars(
        select(WorkspaceFileVersion)
        .where(WorkspaceFileVersion.file_id == file.id)
        .order_by(WorkspaceFileVersion.version.desc())
    )
    return list(rows)


# ------------------------------------------------------------------ upload targets
def _pg_target(db_name: str, table: str) -> TargetTable:
    return TargetTable(
        target_type="postgres",
        database=db_name,
        schema_name="public",
        table=table,
        label=f"{db_name}.{table}",
    )


def _bq_target(dataset: str, table: str) -> TargetTable:
    return TargetTable(target_type="bigquery", database=dataset, table=table, label=f"{dataset}.{table}")


def onboarded_option(target: UploadTarget) -> TargetTable:
    return TargetTable(
        target_type=target.target_type,
        database=target.database_name,
        schema_name=target.schema_name,
        table=target.table_name,
        label=target.display_name,
        enabled=target.target_type != "oracle",
        target_id=target.id,
        description=target.description,
        write_modes=list(target.write_modes),
        key_columns=list(target.key_columns or []),
        contract=target.contract,
        contract_version=target.contract_version,
        columns=target.schema_snapshot,
    )


async def allowed_targets(session: AsyncSession, user_id: uuid.UUID, is_admin: bool) -> list[TargetTable]:
    """Tables this person may load into.

    Every active onboarded table is open to everyone: onboarding is the admin's decision
    that people may send data there, and the contract plus the approval step guard it.
    On top of those come the older per-person grants (the whole catalog for admins).
    Oracle is always listed, disabled, until it is supported.
    """
    now = datetime.now(UTC)
    targets: list[TargetTable] = [
        onboarded_option(t)
        for t in await session.scalars(
            select(UploadTarget)
            .where(UploadTarget.is_active.is_(True), UploadTarget.onboarding_status == "approved")
            .order_by(UploadTarget.display_name)
        )
    ]
    catalog = (
        select(PgTableCatalog.table_name, PgDatabase.name)
        .join(PgDatabase, PgTableCatalog.database_id == PgDatabase.id)
        .where(PgTableCatalog.is_active.is_(True), PgDatabase.is_active.is_(True))
        .order_by(PgDatabase.name, PgTableCatalog.table_name)
    )

    if is_admin:
        for table, db_name in await session.execute(catalog):
            targets.append(_pg_target(db_name, table))
        for row in await session.scalars(
            select(BqTableCache).order_by(BqTableCache.dataset_id, BqTableCache.id)
        ):
            targets.append(_bq_target(row.dataset_id, row.id))
        return [*_dedupe(targets), ORACLE_PLACEHOLDER]

    # Postgres: active grants, on a whole database or on single tables
    grants = [
        g
        for g in await session.scalars(
            select(DbAccessGrant).where(DbAccessGrant.user_id == user_id, DbAccessGrant.revoked_at.is_(None))
        )
        if g.expires_at is None or g.expires_at > now
    ]
    db_ids = {g.database_id for g in grants if g.scope_type == "database" and g.database_id}
    table_ids = {g.table_id for g in grants if g.scope_type == "table" and g.table_id}
    granted = []
    if db_ids:
        granted.append(PgTableCatalog.database_id.in_(db_ids))
    if table_ids:
        granted.append(PgTableCatalog.id.in_(table_ids))
    if granted:
        for table, db_name in await session.execute(catalog.where(or_(*granted))):
            targets.append(_pg_target(db_name, table))

    # BigQuery: approved, unexpired access requests
    for req in await session.scalars(
        select(BqAccessRequest).where(
            BqAccessRequest.user_id == user_id, BqAccessRequest.status == "approved"
        )
    ):
        if req.expires_at is not None and req.expires_at <= now:
            continue
        if req.scope_type == "table" and req.dataset_id and req.table_id:
            targets.append(_bq_target(req.dataset_id, req.table_id))
        elif req.scope_type == "dataset" and req.dataset_id:
            for row in await session.scalars(
                select(BqTableCache).where(BqTableCache.dataset_id == req.dataset_id)
            ):
                targets.append(_bq_target(req.dataset_id, row.id))

    return [*_dedupe(targets), ORACLE_PLACEHOLDER]


def _dedupe(targets: list[TargetTable]) -> list[TargetTable]:
    """One entry per table; onboarded targets come first, so they win over grants."""
    seen: set[tuple] = set()
    unique = []
    for t in targets:
        key = (t.target_type, t.database, t.table)
        if key not in seen:
            seen.add(key)
            unique.append(t)
    return unique


# ------------------------------------------------------------------ load requests
async def resolve_target(
    session: AsyncSession, user: User, body: UploadRequestCreate
) -> tuple[TargetTable, UploadTarget | None]:
    """Where the file goes: an onboarded target by id, or a granted table by name."""
    if body.target_id:
        target = await session.get(UploadTarget, body.target_id)
        if target is None or not target.is_open:
            raise ServiceError("That table is no longer open for loads.", status_code=404)
        if target.target_type == "oracle":
            raise ServiceError("Oracle support is coming soon.")
        return onboarded_option(target), target

    if not body.target_type or not body.table:
        raise ServiceError("Choose a table to load into.", field="table")
    if body.target_type == "oracle":
        raise ServiceError("Oracle support is coming soon.")
    allowed = await allowed_targets(session, user.id, is_admin=user.role == "admin")
    match = next(
        (
            t
            for t in allowed
            if t.enabled
            and t.target_type == body.target_type
            and t.database == body.database
            and t.table == body.table
        ),
        None,
    )
    if match is None:
        log.info("load refused: %s has no access to %s.%s", user.username, body.database, body.table)
        raise ServiceError(
            f"You don't have access to load into {body.database}.{body.table}. Ask an admin to onboard it.",
            status_code=403,
        )
    onboarded = await session.get(UploadTarget, match.target_id) if match.target_id else None
    return match, onboarded


def contract_rules(target_type: str, table: str, onboarded: UploadTarget | None) -> tuple[dict, int | None]:
    """(rules by column, max_rows) from the onboarded contract, else a file in data-contracts/."""
    if onboarded is not None:
        return validators.rules_from_contract(onboarded.contract), onboarded.contract.get("max_rows")
    return validators.load_rules(target_type, table), None


async def create_upload_request(
    session: AsyncSession, settings: Settings, user: User, body: UploadRequestCreate
) -> tuple[UploadRequest | None, WorkspaceFile, dict, TargetTable]:
    """Validate the file against the target's live schema and data contract and, if it
    passes, file a request for an admin.

    Returns (request, or None when validation failed; the file; the report; the target).
    """
    file = await owned_file(session, body.file_id, user.id)
    target, onboarded = await resolve_target(session, user, body)

    if body.write_mode not in target.write_modes:
        raise ServiceError(f"{target.label} doesn't accept {body.write_mode} loads.", field="write_mode")
    keys = [k.strip() for k in body.key_columns or [] if k.strip()]
    if onboarded is not None and body.write_mode == "upsert":
        keys = list(onboarded.key_columns)  # the admin fixed the key when onboarding
    if body.write_mode == "upsert" and not keys:
        raise ServiceError("Upsert needs at least one key column.", field="key_columns")

    try:
        target_cols = await loaders.target_columns(
            target.target_type, target.database, target.schema_name, target.table
        )
    except Exception as exc:
        raise ServiceError(f"Could not read the target table's schema: {exc}", status_code=502) from exc

    parsed = await read_content(session, settings, file, None, None)
    rules, max_rows = contract_rules(target.target_type, target.table, onboarded)
    report = validators.validate(parsed, target_cols, body.write_mode, keys, rules, max_rows=max_rows)
    report["contract_version"] = onboarded.contract_version if onboarded else None
    report["contract_rules"] = len(rules)
    # what the Validation stage shows: how the file was read
    report["file"] = {
        "format": file.format,
        "delimiter": parsed.get("delimiter"),
        "version": file.current_version,
    }
    if not report["passed"]:
        log.info(
            "validation failed for %s → %s.%s: %s",
            file.original_name,
            target.database,
            target.table,
            report["summary"],
        )
        return None, file, report, target

    request = UploadRequest(
        user_id=user.id,
        file_id=file.id,
        file_version=file.current_version,
        target_type=target.target_type,
        target_database=target.database,
        target_schema=target.schema_name or ("public" if target.target_type == "postgres" else None),
        target_table=target.table,
        write_mode=body.write_mode,
        key_columns=keys or None,
        justification=(body.justification or "").strip() or None,
        validation_status="passed",
        validation_report=report,
        status="pending",
        target_id=onboarded.id if onboarded else None,
        contract_version=onboarded.contract_version if onboarded else None,
    )
    session.add(request)
    await session.flush()
    log.info(
        "load request filed: %s v%d → %s.%s (contract v%s)",
        file.original_name,
        file.current_version,
        target.database,
        target.table,
        request.contract_version or "-",
    )
    return request, file, report, target


async def my_upload_requests(
    session: AsyncSession, user_id: uuid.UUID
) -> list[tuple[UploadRequest, str | None, str | None]]:
    """(request, file name, onboarded target's display name) newest first."""
    rows = await session.execute(
        select(UploadRequest, WorkspaceFile.original_name, UploadTarget.display_name)
        .join(WorkspaceFile, WorkspaceFile.id == UploadRequest.file_id)
        .outerjoin(UploadTarget, UploadTarget.id == UploadRequest.target_id)
        .where(UploadRequest.user_id == user_id)
        .order_by(UploadRequest.created_at.desc())
    )
    return [(req, name, label) for req, name, label in rows]
