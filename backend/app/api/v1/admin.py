"""Admin-only: approve accounts, resolve password resets, review loads into tables."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_admin
from app.api.v1.requests import request_out
from app.core.config import Settings, get_settings
from app.core.db import get_session
from app.models.user import User
from app.schemas.admin import (
    AccessIn,
    AdminRequestDecisionIn,
    AdminRequestOut,
    ApproveUserIn,
    PasswordResetOut,
    ReviewIn,
    SetPasswordIn,
)
from app.schemas.auth import UserOut
from app.schemas.workspace import UploadRequestOut
from app.services import access, reviews
from app.services import requests as requests_svc

router = APIRouter(prefix="/admin", tags=["admin"])


# ------------------------------------------------------------------ accounts
@router.get("/users", response_model=list[UserOut])
async def list_users(
    status_filter: str | None = Query(default=None, alias="status"),
    _: User = Depends(current_admin),
    session: AsyncSession = Depends(get_session),
):
    return await reviews.list_users(session, status_filter)


@router.post("/users/{user_id}/approve", response_model=UserOut)
async def approve_user(
    user_id: uuid.UUID,
    body: ApproveUserIn | None = None,
    admin: User = Depends(current_admin),
    session: AsyncSession = Depends(get_session),
):
    """Activate an account. A new one gets `role` if given, else the role it asked for."""
    user = await reviews.set_user_status(session, admin, user_id, "active", body.role if body else None)
    await session.commit()
    return user


@router.post("/users/{user_id}/reject", response_model=UserOut)
async def reject_user(
    user_id: uuid.UUID, admin: User = Depends(current_admin), session: AsyncSession = Depends(get_session)
):
    user = await reviews.set_user_status(session, admin, user_id, "rejected")
    await session.commit()
    return user


@router.post("/users/{user_id}/suspend", response_model=UserOut)
async def suspend_user(
    user_id: uuid.UUID, admin: User = Depends(current_admin), session: AsyncSession = Depends(get_session)
):
    user = await reviews.set_user_status(session, admin, user_id, "suspended")
    await session.commit()
    return user


@router.put("/users/{user_id}/access", response_model=UserOut)
async def set_user_access(
    user_id: uuid.UUID,
    body: AccessIn,
    admin: User = Depends(current_admin),
    session: AsyncSession = Depends(get_session),
):
    """Make someone an admin for a while or permanently, or a user again. Any time."""
    user = await access.set_access(session, admin, user_id, body.role, body.duration_minutes)
    await session.commit()
    return user


# ------------------------------------------------------------------ admin access requests
@router.get("/admin-requests", response_model=list[AdminRequestOut])
async def pending_admin_requests(
    _: User = Depends(current_admin), session: AsyncSession = Depends(get_session)
):
    return await access.list_requests(session, pending_only=True)


@router.post("/admin-requests/{request_id}/approve", status_code=status.HTTP_204_NO_CONTENT)
async def approve_admin_request(
    request_id: uuid.UUID,
    body: AdminRequestDecisionIn | None = None,
    admin: User = Depends(current_admin),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Grant admin rights: for the time asked, a different time, or permanently."""
    body = body or AdminRequestDecisionIn()
    await access.approve_request(session, admin, request_id, body.duration_minutes, body.permanent)
    await session.commit()


@router.post("/admin-requests/{request_id}/reject", status_code=status.HTTP_204_NO_CONTENT)
async def reject_admin_request(
    request_id: uuid.UUID,
    body: ReviewIn | None = None,
    admin: User = Depends(current_admin),
    session: AsyncSession = Depends(get_session),
) -> None:
    await access.reject_request(session, admin, request_id, body.review_note if body else None)
    await session.commit()


# ------------------------------------------------------------------ password resets
@router.get("/password-resets", response_model=list[PasswordResetOut])
async def list_password_resets(
    _: User = Depends(current_admin), session: AsyncSession = Depends(get_session)
):
    return [
        PasswordResetOut(
            id=req.id,
            user_id=user.id,
            user_email=user.email,
            user_name=user.display_name,
            status=req.status,
            created_at=req.created_at,
        )
        for req, user in await reviews.pending_password_resets(session)
    ]


@router.post("/password-resets/{reset_id}/resolve", status_code=status.HTTP_204_NO_CONTENT)
async def resolve_password_reset(
    reset_id: uuid.UUID,
    body: SetPasswordIn,
    admin: User = Depends(current_admin),
    session: AsyncSession = Depends(get_session),
) -> None:
    await reviews.resolve_password_reset(session, admin, reset_id, body.new_password)
    await session.commit()


# ------------------------------------------------------------------ loads into tables
@router.get("/pending-counts")
async def pending_counts(
    _: User = Depends(current_admin), session: AsyncSession = Depends(get_session)
) -> dict:
    """What is waiting for an admin: the badge on "Approvals"."""
    return await requests_svc.pending_counts(session)


@router.get("/upload-requests", response_model=list[UploadRequestOut])
async def pending_upload_requests(
    admin: User = Depends(current_admin), session: AsyncSession = Depends(get_session)
):
    rows = await requests_svc.find_requests(session, statuses=("pending",), oldest_first=True)
    return [request_out(row, admin) for row in rows]


@router.get("/upload-requests/history", response_model=list[UploadRequestOut])
async def upload_request_history(
    admin: User = Depends(current_admin), session: AsyncSession = Depends(get_session)
):
    rows = await requests_svc.find_requests(session, statuses=requests_svc.REVIEWED)
    return [request_out(row, admin) for row in rows]


@router.post("/upload-requests/{request_id}/approve", response_model=UploadRequestOut)
async def approve_upload_request(
    request_id: uuid.UUID,
    admin: User = Depends(current_admin),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    """Re-validate, then load. The response says whether it completed or failed."""
    request = await reviews.approve_upload(session, settings, admin, request_id)
    await session.commit()
    return request_out(await requests_svc.get_request(session, request.id), admin)


@router.post("/upload-requests/{request_id}/reject", response_model=UploadRequestOut)
async def reject_upload_request(
    request_id: uuid.UUID,
    body: ReviewIn | None = None,
    admin: User = Depends(current_admin),
    session: AsyncSession = Depends(get_session),
):
    request = await reviews.reject_upload(session, admin, request_id, body.review_note if body else None)
    await session.commit()
    return request_out(await requests_svc.get_request(session, request.id), admin)
