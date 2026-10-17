"""File upload: files sent to BigQuery through the Cloud Run file processor.

    GET  /file-uploads/config          is it on, and the tables that take files (with the name each expects)
    POST /file-uploads/folder          My files › File uploads, made if missing (new uploads go there)
    POST /file-uploads                 check a file as Cloud Run will: 201 + the request, or 422 + the report
    GET  /file-uploads?scope=mine|all  the requests, newest first; the ones still with Cloud Run are refreshed
    POST /file-uploads/{id}/refresh    read Cloud Run's attempts and checks for one request now

Admins approve them with the other loads (POST /admin/upload-requests/{id}/approve): that
puts the file in the landing bucket. The logic lives in services/file_upload.py.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user
from app.api.v1.requests import request_out
from app.core.config import Settings, get_settings
from app.core.db import get_session
from app.models.user import User
from app.schemas.workspace import FileUploadConfig, FileUploadIn, FolderOut, UploadRequestOut
from app.services import file_upload
from app.services import requests as requests_svc
from app.services import workspace as ws

router = APIRouter(prefix="/file-uploads", tags=["file upload"])

# a list asked for again within this long doesn't query BigQuery again
LIST_REFRESH_SECONDS = 10


@router.get("/config", response_model=FileUploadConfig)
async def config(
    _: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    enabled = settings.file_upload_enabled
    return FileUploadConfig(
        enabled=enabled,
        landing_bucket=settings.file_upload_landing_bucket or None,
        config_bucket=settings.file_upload_config_bucket or None,
        pickup_minutes=settings.file_upload_pickup_minutes,
        targets=await file_upload.targets(session) if enabled else [],
    )


@router.post("/folder", response_model=FolderOut)
async def uploads_folder(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    """My files › File uploads, where the form saves new uploads (made the first time)."""
    folder = await ws.ensure_folder(session, user.id, file_upload.UPLOADS_FOLDER)
    await session.commit()
    return folder


@router.post("", response_model=UploadRequestOut)
async def create(
    body: FileUploadIn,
    response: Response,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    request, file, report, target = await file_upload.create_request(
        session,
        settings,
        user,
        body.file_id,
        body.target_id,
        body.file_date,
        body.justification,
        body.load_mode,
    )
    if request is None:
        response.status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
        return UploadRequestOut(
            file_id=file.id,
            file_name=file.original_name,
            file_version=file.current_version,
            target_type="bigquery",
            target_database=target.database_name,
            target_table=target.table_name,
            write_mode=report["pipeline"]["load_mode"],
            justification=body.justification,
            validation_status="failed",
            validation_report=report,
            status="failed",
            target_id=target.id,
            target_label=target.display_name,
            contract_version=target.contract_version,
            origin="pipeline",
            landing_name=report["pipeline"]["landing_name"],
            is_mine=True,
        )
    await session.commit()
    response.status_code = status.HTTP_201_CREATED
    return request_out(await requests_svc.get_request(session, request.id), user)


@router.get("", response_model=list[UploadRequestOut])
async def list_uploads(
    scope: Literal["all", "mine"] = "mine",
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    """Newest first. The ones still with Cloud Run are refreshed from file_audit first."""
    rows = await requests_svc.find_requests(
        session, user_id=user.id if scope == "mine" else None, origin="pipeline"
    )
    stale = datetime.now(UTC) - timedelta(seconds=LIST_REFRESH_SECONDS)
    moving = [
        row.request
        for row in rows
        if row.request.status == "approved"
        and (row.request.pipeline_checked_at is None or row.request.pipeline_checked_at < stale)
    ]
    if moving:
        await file_upload.refresh(session, settings, moving)
        await session.commit()
    return [request_out(row, user) for row in rows]


@router.post("/{request_id}/refresh", response_model=UploadRequestOut)
async def refresh(
    request_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    """What Cloud Run has done with it so far: every attempt, and the checks of the latest."""
    request = await file_upload.get_request(session, request_id)
    await file_upload.refresh(session, settings, [request], with_checks=True)
    await session.commit()
    return request_out(await requests_svc.get_request(session, request.id), user)
