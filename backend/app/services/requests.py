"""Load requests as everyone sees them: who asked, who decided, and what for.

Every signed-in person can see every request, so nobody files the same load twice.
Only the requester and admins see the row-level validation errors, which quote values
from a private file; everyone else gets the summary.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.models.targets import UploadTarget
from app.models.user import AdminAccessRequest, PasswordResetRequest, User
from app.models.workspace import UploadRequest, WorkspaceFile
from app.services.errors import NotFound

STATUSES = ("pending", "approved", "rejected", "completed", "failed")
REVIEWED = ("approved", "rejected", "completed", "failed")


@dataclass
class RequestRow:
    request: UploadRequest
    file_name: str | None
    owner: User
    target_label: str | None
    reviewer: User | None


async def find_requests(
    session: AsyncSession,
    *,
    request_id: uuid.UUID | None = None,
    user_id: uuid.UUID | None = None,
    statuses: tuple[str, ...] | None = None,
    target_id: uuid.UUID | None = None,
    target: tuple[str, str | None, str] | None = None,
    oldest_first: bool = False,
    limit: int = 500,
) -> list[RequestRow]:
    """One query for every list of requests: owner, reviewer, file and target resolved."""
    owner = aliased(User)
    reviewer = aliased(User)
    query = (
        select(UploadRequest, WorkspaceFile.original_name, owner, UploadTarget.display_name, reviewer)
        .join(owner, owner.id == UploadRequest.user_id)
        .outerjoin(reviewer, reviewer.id == UploadRequest.reviewed_by)
        .outerjoin(WorkspaceFile, WorkspaceFile.id == UploadRequest.file_id)
        .outerjoin(UploadTarget, UploadTarget.id == UploadRequest.target_id)
    )
    if request_id:
        query = query.where(UploadRequest.id == request_id)
    if user_id:
        query = query.where(UploadRequest.user_id == user_id)
    if statuses:
        query = query.where(UploadRequest.status.in_(statuses))
    if target_id:
        query = query.where(UploadRequest.target_id == target_id)
    if target:
        target_type, database, table = target
        query = query.where(
            and_(
                UploadRequest.target_type == target_type,
                UploadRequest.target_database == database,
                UploadRequest.target_table == table,
            )
        )
    order = UploadRequest.created_at.asc() if oldest_first else UploadRequest.created_at.desc()
    rows = await session.execute(query.order_by(order).limit(limit))
    return [RequestRow(*row) for row in rows]


async def get_request(session: AsyncSession, request_id: uuid.UUID) -> RequestRow:
    rows = await find_requests(session, request_id=request_id)
    if not rows:
        raise NotFound("Load request")
    return rows[0]


def visible_report(report: dict | None, *, full: bool) -> dict | None:
    """The requester and admins see every error; others see only the outcome."""
    if report is None or full:
        return report
    return {k: v for k, v in report.items() if k != "errors"} | {"errors": []}


async def pending_counts(session: AsyncSession) -> dict:
    """What is waiting for an admin, for the badge on "Approvals"."""
    loads = await session.scalar(select(func.count()).where(UploadRequest.status == "pending")) or 0
    accounts = (
        await session.scalar(
            select(func.count()).where(User.status == "pending_approval", User.deleted_at.is_(None))
        )
        or 0
    )
    resets = await session.scalar(select(func.count()).where(PasswordResetRequest.status == "pending")) or 0
    admin_access = (
        await session.scalar(select(func.count()).where(AdminAccessRequest.status == "pending")) or 0
    )
    tables = (
        await session.scalar(select(func.count()).where(UploadTarget.onboarding_status == "pending")) or 0
    )
    return {
        "loads": loads,
        "tables": tables,
        "accounts": accounts,
        "password_resets": resets,
        "admin_access": admin_access,
        "total": loads + tables + accounts + resets + admin_access,
    }
