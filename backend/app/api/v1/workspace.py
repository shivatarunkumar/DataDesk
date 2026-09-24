"""The signed-in person's workspace: folders, files, versions, and load requests.

Everything here is owner-only: another person's file id answers 404, not 403, so ids
can't be probed. The logic lives in services/workspace.py.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.storage import get_storage
from app.api.deps import current_user
from app.api.v1.requests import request_out
from app.core.config import Settings, get_settings
from app.core.db import get_session
from app.models.user import User
from app.schemas.workspace import (
    FileContentOut,
    FileOut,
    FilePatch,
    FileVersionOut,
    FolderCreate,
    FolderOut,
    SaveContentIn,
    TargetTable,
    TransferIn,
    TransferOut,
    UploadRequestCreate,
    UploadRequestOut,
)
from app.services import file_parser, transfer
from app.services import requests as requests_svc
from app.services import workspace as ws

log = logging.getLogger("datadesk.workspace")

router = APIRouter(prefix="/workspace", tags=["workspace"])


# ------------------------------------------------------------------ folders
@router.get("/folders", response_model=list[FolderOut])
async def list_folders(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    return await ws.list_folders(session, user.id)


@router.post("/folders", response_model=FolderOut, status_code=status.HTTP_201_CREATED)
async def create_folder(
    body: FolderCreate, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
):
    folder = await ws.create_folder(session, user.id, body.name, body.parent_id)
    await session.commit()
    return folder


@router.delete("/folders/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_folder(
    folder_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
) -> None:
    await ws.delete_folder(session, user.id, folder_id)
    await session.commit()


# ------------------------------------------------------------------ files
@router.get("/files", response_model=list[FileOut])
async def list_files(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    return await ws.list_files(session, user.id)


@router.post("/files", response_model=FileOut, status_code=status.HTTP_201_CREATED)
async def upload_file(
    file: UploadFile = File(...),
    folder_id: uuid.UUID | None = Form(default=None),
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    # read one byte past the limit, so an oversized file is refused without buffering it all
    data = await file.read(settings.max_upload_bytes + 1)
    created = await ws.upload_file(session, settings, user, file.filename or "file.csv", data, folder_id)
    await session.commit()
    await session.refresh(created)
    return created


@router.get("/files/{file_id}", response_model=FileOut)
async def get_file(
    file_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
):
    return await ws.owned_file(session, file_id, user.id)


@router.patch("/files/{file_id}", response_model=FileOut)
async def update_file(
    file_id: uuid.UUID,
    body: FilePatch,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    """Rename, or mark as permanent. The name is a label: the bytes keep their path."""
    file = await ws.owned_file(session, file_id, user.id)
    if body.original_name is not None:
        file.original_name = body.original_name.strip()
    if body.is_permanent is not None:
        file.is_permanent = body.is_permanent
    await session.commit()
    await session.refresh(file)
    return file


@router.delete("/files/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_file(
    file_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
) -> None:
    file = await ws.owned_file(session, file_id, user.id)
    await ws.delete_file(session, file)
    await session.commit()


@router.get("/files/{file_id}/versions", response_model=list[FileVersionOut])
async def list_versions(
    file_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
):
    file = await ws.owned_file(session, file_id, user.id)
    return await ws.list_versions(session, file)


@router.post("/files/{file_id}/versions/{version}/restore", response_model=FileOut)
async def restore_version(
    file_id: uuid.UUID,
    version: int,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    """Bring back an earlier version by saving it as the newest one."""
    file = await ws.owned_file(session, file_id, user.id)
    await ws.restore_version(session, settings, user, file, version)
    await session.commit()
    await session.refresh(file)
    return file


@router.get("/files/{file_id}/content", response_model=FileContentOut)
async def file_content(
    file_id: uuid.UUID,
    version: int | None = Query(default=None, ge=1),
    delimiter: str | None = Query(
        default=None, description="auto|comma|tab|semicolon|pipe or a literal char"
    ),
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    file = await ws.owned_file(session, file_id, user.id)
    return await ws.read_content(session, settings, file, version, delimiter)


@router.put("/files/{file_id}/content", response_model=FileOut)
async def save_content(
    file_id: uuid.UUID,
    body: SaveContentIn,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    """Save the edited grid as a new version."""
    file = await ws.owned_file(session, file_id, user.id)
    await ws.save_content(session, settings, user, file, body.columns, body.rows, body.note, body.delimiter)
    await session.commit()
    await session.refresh(file)
    return file


@router.get("/files/{file_id}/download")
async def download_file(
    file_id: uuid.UUID,
    version: int | None = Query(default=None, ge=1),
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Response:
    """The owner's own copy of their file (any version), never data from a target table."""
    file = await ws.owned_file(session, file_id, user.id)
    data = await ws.download(session, file, version)
    name = file.original_name
    if version and version != file.current_version:
        stem, dot, ext = name.rpartition(".")
        name = f"{stem} (v{version}){dot}{ext}" if dot else f"{name} (v{version})"
    return Response(
        content=data,
        media_type=file_parser.CONTENT_TYPES.get(file.format, "application/octet-stream"),
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"},
    )


# ------------------------------------------------------------------ move and copy
async def _drop_objects(paths: list[str]) -> None:
    """Delete bucket objects: what a committed move left behind, or what a failed one wrote."""
    storage = get_storage()
    for path in paths:
        try:
            await asyncio.to_thread(storage.delete, path)
        except Exception as exc:  # best effort: the database is already right
            log.warning("could not delete object %s: %s", path, exc)


@router.post("/move", response_model=TransferOut)
async def move_items(
    body: TransferIn, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
):
    """Move files and folders (with everything in them) into a folder, or to the top."""
    out = transfer.Outcome()
    try:
        await transfer.move(session, user, body, out)
        await session.commit()
    except Exception:
        await _drop_objects(out.new_objects)  # nothing moved: the originals are untouched
        raise
    await _drop_objects(out.stale_objects)
    return TransferOut(files=out.files, folders=out.folders, renamed=out.renamed)


@router.post("/copy", response_model=TransferOut)
async def copy_items(
    body: TransferIn, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
):
    """Copy files (their current version) and folders (with everything in them)."""
    out = transfer.Outcome()
    try:
        await transfer.copy(session, user, body, out)
        await session.commit()
    except Exception:
        await _drop_objects(out.new_objects)
        raise
    return TransferOut(files=out.files, folders=out.folders, renamed=out.renamed)


# ------------------------------------------------------------------ loads into tables
@router.get("/targets", response_model=list[TargetTable])
async def list_targets(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    return await ws.allowed_targets(session, user.id, is_admin=user.role == "admin")


@router.post("/upload-requests", response_model=UploadRequestOut)
async def create_upload_request(
    body: UploadRequestCreate,
    response: Response,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    """Validate the file against the table. If it passes, file a request for an admin
    (201); if not, return the report and file nothing (422 with status "failed")."""
    request, file, report, target = await ws.create_upload_request(session, settings, user, body)
    if request is None:
        response.status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
        return UploadRequestOut(
            file_id=file.id,
            file_name=file.original_name,
            file_version=file.current_version,
            target_type=target.target_type,
            target_database=target.database,
            target_schema=target.schema_name,
            target_table=target.table,
            write_mode=body.write_mode,
            key_columns=body.key_columns,
            justification=body.justification,
            validation_status="failed",
            validation_report=report,
            status="failed",
            target_id=target.target_id,
            target_label=target.label if target.target_id else None,
            contract_version=target.contract_version,
        )
    await session.commit()
    response.status_code = status.HTTP_201_CREATED
    return request_out(await requests_svc.get_request(session, request.id), user)


@router.get("/upload-requests", response_model=list[UploadRequestOut])
async def my_upload_requests(
    user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
):
    return [request_out(row, user) for row in await requests_svc.find_requests(session, user_id=user.id)]
