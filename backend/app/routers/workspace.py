"""User-facing Data Workspace API: personal GCS-backed files + governed uploads.

Files: upload / list / spreadsheet-edit (versioned) / download (owner only).
Uploads: pick a granted target table, validate against its live schema + optional
rules, and — on pass — create an admin-review request. Nothing is written to a
target table here; that happens only on admin approval (see routers/admin.py).
"""
import io
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import file_parser, gcs_client, validators
from app.access_models import DbAccessGrant, PgDatabase, PgTableCatalog
from app.auth_models import User
from app.bq_access_models import BqAccessRequest, BqTableCache
from app.datamanager_database import get_dm_db
from app.loaders import get_target_columns
from app.deps import parse_token as _parse_token
from app.workspace_models import UploadRequest, WorkspaceFile, WorkspaceFileVersion, WorkspaceFolder
from app.workspace_schemas import (
    FileContentResponse,
    FileVersionResponse,
    FolderCreate,
    FolderResponse,
    RenameRequest,
    SaveContentRequest,
    TargetTable,
    UploadRequestCreate,
    UploadRequestResponse,
    WorkspaceFileResponse,
)

router = APIRouter(prefix="/workspace", tags=["workspace"])


# ── Helpers ───────────────────────────────────────────────────────────────────

def _require_gcs():
    if not gcs_client.is_configured():
        raise HTTPException(
            status_code=503,
            detail="File storage is not configured. Set a real gcp.storage.default_bucket "
                   "in config/gcp.yaml and restart the backend.",
        )


async def _folder_path(folder_id: uuid.UUID | None, user_id: uuid.UUID, db: AsyncSession) -> str:
    if not folder_id:
        return ""
    res = await db.execute(
        select(WorkspaceFolder).where(
            WorkspaceFolder.id == folder_id, WorkspaceFolder.user_id == user_id
        )
    )
    folder = res.scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found.")
    return folder.path


async def _owned_file(file_id: uuid.UUID, user_id: uuid.UUID, db: AsyncSession) -> WorkspaceFile:
    res = await db.execute(
        select(WorkspaceFile).where(
            WorkspaceFile.id == file_id,
            WorkspaceFile.user_id == user_id,
            WorkspaceFile.status != "archived",
        )
    )
    f = res.scalar_one_or_none()
    if not f:
        raise HTTPException(status_code=404, detail="File not found.")
    return f


async def _allowed_targets(
    user_id: uuid.UUID, db: AsyncSession, is_admin: bool = False
) -> list[TargetTable]:
    """Tables the user may upload into. Admins see the whole catalog; regular
    users see only tables they hold an active grant for."""
    now = datetime.now(timezone.utc)
    targets: list[TargetTable] = []

    if is_admin:
        # Every catalog Postgres table
        pg_rows = (
            await db.execute(
                select(PgTableCatalog, PgDatabase)
                .join(PgDatabase, PgTableCatalog.database_id == PgDatabase.id)
                .where(PgTableCatalog.is_active.is_(True), PgDatabase.is_active.is_(True))
                .order_by(PgDatabase.name, PgTableCatalog.table_name)
            )
        ).all()
        for tbl, pg_db in pg_rows:
            targets.append(TargetTable(
                target_type="postgres", database=pg_db.name, schema_name="public",
                table=tbl.table_name, label=f"{pg_db.name}.{tbl.table_name}",
            ))
        # Every cached BigQuery table
        bq_rows = (
            await db.execute(select(BqTableCache).order_by(BqTableCache.dataset_id, BqTableCache.id))
        ).scalars().all()
        for t in bq_rows:
            targets.append(TargetTable(
                target_type="bigquery", database=t.dataset_id, table=t.id,
                label=f"{t.dataset_id}.{t.id}",
            ))
        targets.append(TargetTable(
            target_type="oracle", database=None, table="—",
            label="Oracle (coming soon)", enabled=False,
        ))
        return targets

    # ── Postgres: from db_access_grants ──
    grants = (
        await db.execute(
            select(DbAccessGrant).where(
                DbAccessGrant.user_id == user_id,
                DbAccessGrant.revoked_at.is_(None),
            )
        )
    ).scalars().all()
    active = [g for g in grants if g.expires_at is None or g.expires_at > now]

    granted_db_ids = {g.database_id for g in active if g.scope_type == "database" and g.database_id}
    granted_tbl_ids = {g.table_id for g in active if g.scope_type == "table" and g.table_id}

    # database-scope grants → every catalog table in that DB
    if granted_db_ids:
        rows = (
            await db.execute(
                select(PgTableCatalog, PgDatabase)
                .join(PgDatabase, PgTableCatalog.database_id == PgDatabase.id)
                .where(PgTableCatalog.database_id.in_(granted_db_ids),
                       PgTableCatalog.is_active.is_(True))
            )
        ).all()
        for tbl, pg_db in rows:
            targets.append(TargetTable(
                target_type="postgres", database=pg_db.name, schema_name="public",
                table=tbl.table_name, label=f"{pg_db.name}.{tbl.table_name}",
            ))
    # table-scope grants
    if granted_tbl_ids:
        rows = (
            await db.execute(
                select(PgTableCatalog, PgDatabase)
                .join(PgDatabase, PgTableCatalog.database_id == PgDatabase.id)
                .where(PgTableCatalog.id.in_(granted_tbl_ids))
            )
        ).all()
        for tbl, pg_db in rows:
            targets.append(TargetTable(
                target_type="postgres", database=pg_db.name, schema_name="public",
                table=tbl.table_name, label=f"{pg_db.name}.{tbl.table_name}",
            ))

    # ── BigQuery: approved, non-expired bq_access_requests ──
    bq_reqs = (
        await db.execute(
            select(BqAccessRequest).where(
                BqAccessRequest.user_id == user_id,
                BqAccessRequest.status == "approved",
            )
        )
    ).scalars().all()
    for r in bq_reqs:
        if r.expires_at is not None and r.expires_at <= now:
            continue
        if r.scope_type == "table" and r.table_id:
            targets.append(TargetTable(
                target_type="bigquery", database=r.dataset_id, table=r.table_id,
                label=f"{r.dataset_id}.{r.table_id}",
            ))
        elif r.scope_type == "dataset" and r.dataset_id:
            tbls = (
                await db.execute(
                    select(BqTableCache).where(BqTableCache.dataset_id == r.dataset_id)
                )
            ).scalars().all()
            for t in tbls:
                targets.append(TargetTable(
                    target_type="bigquery", database=r.dataset_id, table=t.id,
                    label=f"{r.dataset_id}.{t.id}",
                ))

    # de-duplicate
    seen = set()
    unique: list[TargetTable] = []
    for t in targets:
        key = (t.target_type, t.database, t.table)
        if key not in seen:
            seen.add(key)
            unique.append(t)

    # Oracle placeholder — always shown, disabled
    unique.append(TargetTable(
        target_type="oracle", database=None, table="—",
        label="Oracle (coming soon)", enabled=False,
    ))
    return unique


# ── Folders ───────────────────────────────────────────────────────────────────

@router.get("/folders", response_model=list[FolderResponse])
async def list_folders(
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_dm_db),
):
    payload = _parse_token(authorization)
    user_id = uuid.UUID(payload["sub"])
    res = await db.execute(
        select(WorkspaceFolder)
        .where(WorkspaceFolder.user_id == user_id)
        .order_by(WorkspaceFolder.path)
    )
    return res.scalars().all()


@router.post("/folders", response_model=FolderResponse, status_code=201)
async def create_folder(
    body: FolderCreate,
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_dm_db),
):
    payload = _parse_token(authorization)
    user_id = uuid.UUID(payload["sub"])

    name = (body.name or "").strip()
    if not name or "/" in name:
        raise HTTPException(status_code=400, detail="Folder name is required and cannot contain '/'.")

    parent_path = await _folder_path(body.parent_id, user_id, db)
    path = f"{parent_path}/{name}" if parent_path else name

    dup = await db.execute(
        select(WorkspaceFolder).where(
            WorkspaceFolder.user_id == user_id, WorkspaceFolder.path == path
        )
    )
    if dup.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="A folder with that name already exists here.")

    # Mirror the folder in GCS under the user's dedicated (id-based) root.
    if gcs_client.is_configured():
        try:
            gcs_client.create_folder(str(user_id), path)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Storage error creating folder: {exc}")

    folder = WorkspaceFolder(user_id=user_id, parent_id=body.parent_id, name=name, path=path)
    db.add(folder)
    await db.commit()
    await db.refresh(folder)
    return folder


@router.delete("/folders/{folder_id}")
async def delete_folder(
    folder_id: uuid.UUID,
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_dm_db),
):
    payload = _parse_token(authorization)
    user_id = uuid.UUID(payload["sub"])
    res = await db.execute(
        select(WorkspaceFolder).where(
            WorkspaceFolder.id == folder_id, WorkspaceFolder.user_id == user_id
        )
    )
    folder = res.scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found.")

    # Block delete if it (or a descendant) still contains active files or subfolders.
    child_folders = await db.execute(
        select(WorkspaceFolder).where(
            WorkspaceFolder.user_id == user_id,
            WorkspaceFolder.path.like(f"{folder.path}/%"),
        )
    )
    has_children = child_folders.scalars().first() is not None
    files_in = await db.execute(
        select(WorkspaceFile).where(
            WorkspaceFile.folder_id == folder_id, WorkspaceFile.status == "active"
        )
    )
    has_files = files_in.scalars().first() is not None
    if has_children or has_files:
        raise HTTPException(status_code=400, detail="Folder is not empty. Delete its contents first.")

    if gcs_client.is_configured():
        try:
            gcs_client.delete(gcs_client.folder_placeholder_path(str(user_id), folder.path))
        except Exception:
            pass
    await db.delete(folder)
    await db.commit()
    return {"detail": "Folder deleted."}


# ── File management ───────────────────────────────────────────────────────────

@router.post("/files", response_model=WorkspaceFileResponse, status_code=201)
async def upload_file(
    file: UploadFile = File(...),
    folder_id: str | None = Form(None),
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_dm_db),
):
    payload = _parse_token(authorization)
    user_id = uuid.UUID(payload["sub"])
    ures = await db.execute(select(User).where(User.id == user_id))
    user = ures.scalar_one_or_none()
    username = (user.username or user.email) if user else str(user_id)
    _require_gcs()

    fmt = file_parser.detect_format(file.filename or "")
    if not fmt:
        raise HTTPException(status_code=400, detail="Only .csv, .xlsx, or .json files are supported.")

    fid = uuid.UUID(folder_id) if folder_id else None
    folder_path = await _folder_path(fid, user_id, db)

    data = await file.read()
    try:
        parsed = file_parser.parse(data, fmt)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not parse file: {exc}")

    file_id = uuid.uuid4()
    path = gcs_client.object_path(str(user_id), 1, file.filename or f"file.{fmt}", folder_path)
    try:
        gcs_client.upload_bytes(path, data, file_parser.CONTENT_TYPES.get(fmt, "application/octet-stream"))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Storage error: {exc}")

    column_meta = [{"name": c, "inferred_type": parsed["inferred_types"].get(c)} for c in parsed["columns"]]
    wf = WorkspaceFile(
        id=file_id, user_id=user_id, folder_id=fid, username=username,
        original_name=file.filename or f"file.{fmt}", format=fmt,
        current_version=1, current_gcs_path=path, row_count=parsed["row_count"],
        column_meta=column_meta, size_bytes=len(data), is_permanent=False,
    )
    db.add(wf)
    db.add(WorkspaceFileVersion(
        file_id=file_id, version=1, gcs_path=path,
        row_count=parsed["row_count"], size_bytes=len(data), note="Initial upload",
        created_by=user_id,
    ))
    await db.commit()
    await db.refresh(wf)
    return wf


@router.get("/files", response_model=list[WorkspaceFileResponse])
async def list_files(
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_dm_db),
):
    payload = _parse_token(authorization)
    user_id = uuid.UUID(payload["sub"])
    res = await db.execute(
        select(WorkspaceFile)
        .where(WorkspaceFile.user_id == user_id, WorkspaceFile.status == "active")
        .order_by(WorkspaceFile.updated_at.desc())
    )
    return res.scalars().all()


@router.get("/files/{file_id}/versions", response_model=list[FileVersionResponse])
async def file_versions(
    file_id: uuid.UUID,
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_dm_db),
):
    payload = _parse_token(authorization)
    user_id = uuid.UUID(payload["sub"])
    await _owned_file(file_id, user_id, db)
    res = await db.execute(
        select(WorkspaceFileVersion)
        .where(WorkspaceFileVersion.file_id == file_id)
        .order_by(WorkspaceFileVersion.version.desc())
    )
    return res.scalars().all()


_DELIM_MAP = {"comma": ",", "tab": "\t", "semicolon": ";", "pipe": "|"}


def _resolve_delim(value: str | None) -> str | None:
    """Map a keyword ('tab'/'comma'/…) or literal char to a delimiter; None = auto."""
    if not value or value == "auto":
        return None
    if value in _DELIM_MAP:
        return _DELIM_MAP[value]
    return value[0]  # custom single char


@router.get("/files/{file_id}/content", response_model=FileContentResponse)
async def file_content(
    file_id: uuid.UUID,
    version: int | None = Query(default=None),
    delimiter: str | None = Query(default=None, description="auto|comma|tab|semicolon|pipe or a literal char"),
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_dm_db),
):
    payload = _parse_token(authorization)
    user_id = uuid.UUID(payload["sub"])
    f = await _owned_file(file_id, user_id, db)
    _require_gcs()

    path = f.current_gcs_path
    ver = f.current_version
    if version is not None and version != f.current_version:
        vres = await db.execute(
            select(WorkspaceFileVersion).where(
                WorkspaceFileVersion.file_id == file_id,
                WorkspaceFileVersion.version == version,
            )
        )
        v = vres.scalar_one_or_none()
        if not v:
            raise HTTPException(status_code=404, detail="Version not found.")
        path, ver = v.gcs_path, v.version

    try:
        data = gcs_client.download_bytes(path)
        parsed = file_parser.parse(data, f.format, delimiter=_resolve_delim(delimiter))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not read file: {exc}")
    return FileContentResponse(
        columns=parsed["columns"], rows=parsed["rows"], version=ver,
        inferred_types=parsed["inferred_types"], delimiter=parsed.get("delimiter"),
    )


@router.put("/files/{file_id}/content", response_model=WorkspaceFileResponse)
async def save_content(
    file_id: uuid.UUID,
    body: SaveContentRequest,
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_dm_db),
):
    payload = _parse_token(authorization)
    user_id = uuid.UUID(payload["sub"])
    f = await _owned_file(file_id, user_id, db)
    _require_gcs()

    write_delim = _resolve_delim(body.delimiter) or ","
    try:
        data = file_parser.serialize(body.columns, body.rows, f.format, delimiter=write_delim)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not serialize edits: {exc}")

    new_version = f.current_version + 1
    folder_path = await _folder_path(f.folder_id, user_id, db)
    path = gcs_client.object_path(str(user_id), new_version, f.original_name, folder_path)
    try:
        gcs_client.upload_bytes(path, data, file_parser.CONTENT_TYPES.get(f.format))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Storage error: {exc}")

    inferred = {c: t for c, t in file_parser.parse(data, f.format)["inferred_types"].items()}
    f.current_version = new_version
    f.current_gcs_path = path
    f.row_count = len(body.rows)
    f.column_meta = [{"name": c, "inferred_type": inferred.get(c)} for c in body.columns]
    f.size_bytes = len(data)
    db.add(WorkspaceFileVersion(
        file_id=f.id, version=new_version, gcs_path=path,
        row_count=len(body.rows), size_bytes=len(data),
        note=body.note or "Edited in workspace", created_by=user_id,
    ))
    await db.commit()
    await db.refresh(f)
    return f


@router.patch("/files/{file_id}", response_model=WorkspaceFileResponse)
async def update_file(
    file_id: uuid.UUID,
    body: RenameRequest,
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_dm_db),
):
    payload = _parse_token(authorization)
    user_id = uuid.UUID(payload["sub"])
    f = await _owned_file(file_id, user_id, db)
    if body.original_name is not None:
        f.original_name = body.original_name
    if body.is_permanent is not None:
        f.is_permanent = body.is_permanent
    await db.commit()
    await db.refresh(f)
    return f


@router.delete("/files/{file_id}")
async def delete_file(
    file_id: uuid.UUID,
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_dm_db),
):
    payload = _parse_token(authorization)
    user_id = uuid.UUID(payload["sub"])
    f = await _owned_file(file_id, user_id, db)
    # Soft-delete metadata; best-effort remove every version blob.
    f.status = "archived"
    if gcs_client.is_configured():
        try:
            vres = await db.execute(
                select(WorkspaceFileVersion).where(WorkspaceFileVersion.file_id == f.id)
            )
            for v in vres.scalars().all():
                gcs_client.delete(v.gcs_path)
        except Exception:
            pass
    await db.commit()
    return {"detail": "File deleted."}


@router.get("/files/{file_id}/download")
async def download_file(
    file_id: uuid.UUID,
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_dm_db),
):
    """Owner-only download of the user's OWN workspace file (not production data)."""
    payload = _parse_token(authorization)
    user_id = uuid.UUID(payload["sub"])
    f = await _owned_file(file_id, user_id, db)
    _require_gcs()
    try:
        data = gcs_client.download_bytes(f.current_gcs_path)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Storage error: {exc}")
    return StreamingResponse(
        io.BytesIO(data),
        media_type=file_parser.CONTENT_TYPES.get(f.format, "application/octet-stream"),
        headers={"Content-Disposition": f'attachment; filename="{f.original_name}"'},
    )


# ── Governed upload ───────────────────────────────────────────────────────────

@router.get("/targets", response_model=list[TargetTable])
async def list_targets(
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_dm_db),
):
    payload = _parse_token(authorization)
    user_id = uuid.UUID(payload["sub"])
    return await _allowed_targets(user_id, db, is_admin=(payload.get("role") == "admin"))


@router.post("/upload-requests", response_model=UploadRequestResponse)
async def create_upload_request(
    body: UploadRequestCreate,
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_dm_db),
):
    payload = _parse_token(authorization)
    user_id = uuid.UUID(payload["sub"])

    if body.write_mode not in ("append", "upsert"):
        raise HTTPException(status_code=400, detail="write_mode must be 'append' or 'upsert'.")
    if body.target_type == "oracle":
        raise HTTPException(status_code=400, detail="Oracle support is coming soon.")
    if body.write_mode == "upsert" and not body.key_columns:
        raise HTTPException(status_code=400, detail="Upsert requires at least one key column.")

    f = await _owned_file(body.file_id, user_id, db)

    # Enforce grant: the chosen target must be in the user's allowed set.
    allowed = await _allowed_targets(user_id, db, is_admin=(payload.get("role") == "admin"))
    match = any(
        t.enabled and t.target_type == body.target_type
        and t.database == body.database and t.table == body.table
        for t in allowed
    )
    if not match:
        raise HTTPException(
            status_code=403,
            detail=f"You do not have an active grant to upload into {body.database}.{body.table}. "
                   "Request access first.",
        )

    # Live target schema + optional rules
    try:
        target_columns = await get_target_columns(
            body.target_type, body.database, body.schema_name, body.table
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not read target schema: {exc}")
    rules = validators.load_rules(body.target_type, body.table)

    # Read current file content and validate
    _require_gcs()
    try:
        data = gcs_client.download_bytes(f.current_gcs_path)
        parsed = file_parser.parse(data, f.format)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not read file: {exc}")

    report = validators.validate(
        parsed, target_columns, body.write_mode, body.key_columns, rules
    )

    if not report["passed"]:
        # Return the report inline; do NOT create a pending request on failure.
        return UploadRequestResponse(
            file_id=f.id, file_name=f.original_name, target_type=body.target_type,
            target_database=body.database, target_schema=body.schema_name,
            target_table=body.table, write_mode=body.write_mode,
            key_columns=body.key_columns, justification=body.justification,
            validation_status="failed", validation_report=report, status="failed",
        )

    req = UploadRequest(
        user_id=user_id, file_id=f.id, file_version=f.current_version,
        target_type=body.target_type, target_database=body.database,
        target_schema=body.schema_name or "public", target_table=body.table,
        write_mode=body.write_mode, key_columns=body.key_columns,
        justification=body.justification, validation_status="passed",
        validation_report=report, status="pending",
    )
    db.add(req)
    await db.commit()
    await db.refresh(req)
    return UploadRequestResponse(
        id=req.id, file_id=req.file_id, file_name=f.original_name,
        target_type=req.target_type, target_database=req.target_database,
        target_schema=req.target_schema, target_table=req.target_table,
        write_mode=req.write_mode, key_columns=req.key_columns,
        justification=req.justification, validation_status=req.validation_status,
        validation_report=req.validation_report, status=req.status,
        created_at=req.created_at,
    )


@router.get("/upload-requests", response_model=list[UploadRequestResponse])
async def my_upload_requests(
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_dm_db),
):
    payload = _parse_token(authorization)
    user_id = uuid.UUID(payload["sub"])
    res = await db.execute(
        select(UploadRequest)
        .where(UploadRequest.user_id == user_id)
        .order_by(UploadRequest.created_at.desc())
    )
    reqs = res.scalars().all()

    # attach file names
    out = []
    for req in reqs:
        fres = await db.execute(select(WorkspaceFile).where(WorkspaceFile.id == req.file_id))
        f = fres.scalar_one_or_none()
        out.append(UploadRequestResponse(
            id=req.id, file_id=req.file_id, file_name=f.original_name if f else None,
            target_type=req.target_type, target_database=req.target_database,
            target_schema=req.target_schema, target_table=req.target_table,
            write_mode=req.write_mode, key_columns=req.key_columns,
            justification=req.justification, validation_status=req.validation_status,
            validation_report=req.validation_report, status=req.status,
            result=req.result, review_note=req.review_note, created_at=req.created_at,
        ))
    return out
