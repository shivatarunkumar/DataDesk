"""A person's own workspace: folders, files, versions, and requests to load a file.

Nothing here writes to a target table. A load request is created only after the file
passes validation against the table's live schema; the load itself runs when an admin
approves it (services/reviews.py).
"""

from __future__ import annotations

import asyncio
import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.storage import StorageNotConfigured, get_storage
from app.core.config import Settings
from app.models.targets import UploadTarget
from app.models.user import User
from app.models.workspace import WorkspaceFile, WorkspaceFileVersion, WorkspaceFolder
from app.schemas.workspace import TargetTable
from app.services import file_parser, validators
from app.services.errors import NotFound, ServiceError

log = logging.getLogger("datadesk.workspace")

DELIMITERS = {"comma": ",", "tab": "\t", "semicolon": ";", "pipe": "|"}


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


async def ensure_folder(session: AsyncSession, user_id: uuid.UUID, path: list[str]) -> WorkspaceFolder:
    """The folder at this path in someone's files (e.g. ["File uploads", "Archive"]), made if missing."""
    parent: WorkspaceFolder | None = None
    for i, name in enumerate(path):
        full = "/".join(path[: i + 1])
        found = await session.scalar(
            select(WorkspaceFolder).where(WorkspaceFolder.user_id == user_id, WorkspaceFolder.path == full)
        )
        parent = found or await create_folder(session, user_id, name, parent.id if parent else None)
    assert parent is not None
    return parent


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
def onboarded_option(target: UploadTarget) -> TargetTable:
    return TargetTable(
        database=target.database_name,
        table=target.table_name,
        label=target.display_name,
        target_id=target.id,
        description=target.description,
        write_modes=list(target.write_modes),
        key_columns=list(target.key_columns or []),
        contract=target.contract,
        contract_version=target.contract_version,
        columns=target.schema_snapshot,
    )


def contract_rules(table: str, onboarded: UploadTarget | None) -> tuple[dict, int | None]:
    """(rules by column, max_rows) from the onboarded contract, else a file in data-contracts/."""
    if onboarded is not None:
        return validators.rules_from_contract(onboarded.contract), onboarded.contract.get("max_rows")
    return validators.load_rules(table), None
