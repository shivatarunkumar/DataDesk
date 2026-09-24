"""Load requests, visible to everyone signed in.

Seeing what is already pending for a table is what stops two people loading the same data.
Only admins decide (POST /admin/upload-requests/{id}/approve|reject); only the requester
and admins see row-level validation errors, since those quote a private file.
"""

from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user
from app.core.db import get_session
from app.models.user import User
from app.schemas.workspace import UploadRequestOut
from app.services import requests as svc

router = APIRouter(prefix="/requests", tags=["requests"])


def request_out(row: svc.RequestRow, viewer: User | None = None) -> UploadRequestOut:
    """Everything the list and the detail page show. With no viewer (internal use), full."""
    r = row.request
    mine = viewer is not None and viewer.id == r.user_id
    full = viewer is None or mine or viewer.role == "admin"
    return UploadRequestOut(
        id=r.id,
        file_id=r.file_id,
        file_name=row.file_name,
        file_version=r.file_version,
        target_type=r.target_type,
        target_database=r.target_database,
        target_schema=r.target_schema,
        target_table=r.target_table,
        write_mode=r.write_mode,
        key_columns=r.key_columns,
        justification=r.justification,
        validation_status=r.validation_status,
        validation_report=svc.visible_report(r.validation_report, full=full),
        status=r.status,
        result=r.result,
        review_note=r.review_note,
        reviewed_at=r.reviewed_at,
        executed_at=r.executed_at,
        created_at=r.created_at,
        target_id=r.target_id,
        target_label=row.target_label,
        contract_version=r.contract_version,
        user_id=row.owner.id,
        user_email=row.owner.email,
        user_name=row.owner.display_name,
        reviewed_by_id=row.reviewer.id if row.reviewer else None,
        reviewed_by_name=row.reviewer.display_name if row.reviewer else None,
        is_mine=mine,
        origin=r.origin,
        change_summary=r.change_summary,
    )


@router.get("", response_model=list[UploadRequestOut])
async def list_requests(
    scope: Literal["all", "mine"] = "all",
    status: str | None = Query(
        default=None, description="pending | approved | rejected | completed | failed | reviewed"
    ),
    target_id: uuid.UUID | None = None,
    target_type: str | None = None,
    database: str | None = None,
    table: str | None = None,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    statuses = svc.REVIEWED if status == "reviewed" else (status,) if status in svc.STATUSES else None
    target = (target_type, database, table) if target_type and table else None
    rows = await svc.find_requests(
        session,
        user_id=user.id if scope == "mine" else None,
        statuses=statuses,
        target_id=target_id,
        target=target,
    )
    return [request_out(row, user) for row in rows]


@router.get("/{request_id}", response_model=UploadRequestOut)
async def get_request(
    request_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
):
    return request_out(await svc.get_request(session, request_id), user)
