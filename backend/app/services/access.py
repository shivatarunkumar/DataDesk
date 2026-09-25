"""Admin rights for a while or for good: delegation by an admin, and requests from users.

A delegated admin has role "admin" and an `admin_until` time. Nothing runs on a timer:
the first request they make after that time turns them back into a user
(`expire_admin_if_due`, called when the session is resolved), so an expired admin can
never pass an admin check.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.models.user import AdminAccessRequest, User
from app.schemas.admin import AdminRequestOut
from app.services.errors import NotFound, ServiceError

log = logging.getLogger("datadesk.access")


def _until(duration_minutes: int | None) -> datetime | None:
    return datetime.now(UTC) + timedelta(minutes=duration_minutes) if duration_minutes else None


def expire_admin_if_due(user: User) -> bool:
    """Turn a delegated admin whose time is up back into a user. True if it did."""
    if user.role == "admin" and user.admin_until is not None and user.admin_until <= datetime.now(UTC):
        log.info("admin rights for %s ended at %s; now a user", user.username, user.admin_until.isoformat())
        user.role = "user"
        user.admin_until = None
        return True
    return False


# ------------------------------------------------------------------ delegation
async def set_access(
    session: AsyncSession, admin: User, user_id: uuid.UUID, role: str, duration_minutes: int | None
) -> User:
    """Make someone an admin (for `duration_minutes`, or permanently), or a user again."""
    user = await session.get(User, user_id)
    if user is None or user.deleted_at is not None:
        raise NotFound("User")
    if user.id == admin.id:
        raise ServiceError("You can't change your own access. Ask another admin.", status_code=409)
    if user.status != "active":
        raise ServiceError("Approve or reactivate the account before changing its access.", status_code=409)

    user.role = role
    user.admin_until = _until(duration_minutes) if role == "admin" else None
    # a pending request is answered by the change
    pending = await _pending_request(session, user.id)
    if pending is not None:
        _decide(pending, admin, "approved" if role == "admin" else "rejected", user.admin_until)
    log.info(
        "%s set %s to %s%s",
        admin.username,
        user.username,
        role,
        f" until {user.admin_until.isoformat()}" if user.admin_until else "",
    )
    return user


# ------------------------------------------------------------------ requests
async def _pending_request(session: AsyncSession, user_id: uuid.UUID) -> AdminAccessRequest | None:
    return await session.scalar(
        select(AdminAccessRequest).where(
            AdminAccessRequest.user_id == user_id, AdminAccessRequest.status == "pending"
        )
    )


def _decide(request: AdminAccessRequest, admin: User, status: str, until: datetime | None) -> None:
    request.status = status
    request.reviewed_by = admin.id
    request.reviewed_at = datetime.now(UTC)
    request.granted_until = until if status == "approved" else None


async def request_admin(
    session: AsyncSession, user: User, duration_minutes: int, reason: str | None
) -> AdminAccessRequest:
    if user.role == "admin" and user.admin_until is None:
        raise ServiceError("You are already a permanent admin.", status_code=409)
    if await _pending_request(session, user.id):
        raise ServiceError(
            "You already have a request waiting. Cancel it to ask for a different time.", status_code=409
        )
    request = AdminAccessRequest(
        user_id=user.id,
        duration_minutes=duration_minutes,
        reason=(reason or "").strip() or None,
        status="pending",
    )
    session.add(request)
    await session.flush()
    log.info("%s asked to be an admin for %d minute(s)", user.username, duration_minutes)
    return request


async def cancel_request(session: AsyncSession, user: User, request_id: uuid.UUID) -> AdminAccessRequest:
    request = await session.get(AdminAccessRequest, request_id)
    if request is None or request.user_id != user.id:
        raise NotFound("Request")
    if request.status != "pending":
        raise ServiceError("Only a waiting request can be cancelled.", status_code=409)
    request.status = "cancelled"
    log.info("%s cancelled their admin request", user.username)
    return request


async def approve_request(
    session: AsyncSession,
    admin: User,
    request_id: uuid.UUID,
    duration_minutes: int | None,
    permanent: bool,
) -> AdminAccessRequest:
    request = await _open_request(session, request_id)
    minutes = None if permanent else (duration_minutes or request.duration_minutes)
    user = await set_access(session, admin, request.user_id, "admin", minutes)
    # set_access has already marked the request approved with the granted time
    log.info("%s approved %s's admin request", admin.username, user.username)
    return request


async def reject_request(
    session: AsyncSession, admin: User, request_id: uuid.UUID, note: str | None
) -> AdminAccessRequest:
    request = await _open_request(session, request_id)
    _decide(request, admin, "rejected", None)
    request.review_note = (note or "").strip() or None
    log.info("%s rejected an admin request", admin.username)
    return request


async def _open_request(session: AsyncSession, request_id: uuid.UUID) -> AdminAccessRequest:
    request = await session.get(AdminAccessRequest, request_id)
    if request is None:
        raise NotFound("Request")
    if request.status != "pending":
        raise ServiceError(f"This request was already {request.status}.", status_code=409)
    return request


async def list_requests(
    session: AsyncSession, *, user_id: uuid.UUID | None = None, pending_only: bool = False
) -> list[AdminRequestOut]:
    reviewer = aliased(User)
    query = (
        select(AdminAccessRequest, User, reviewer)
        .join(User, User.id == AdminAccessRequest.user_id)
        .outerjoin(reviewer, reviewer.id == AdminAccessRequest.reviewed_by)
    )
    if user_id is not None:
        query = query.where(AdminAccessRequest.user_id == user_id)
    if pending_only:
        query = query.where(AdminAccessRequest.status == "pending").order_by(
            AdminAccessRequest.created_at.asc()
        )
    else:
        query = query.order_by(AdminAccessRequest.created_at.desc()).limit(50)
    return [
        AdminRequestOut(
            id=req.id,
            user_id=user.id,
            user_name=user.display_name,
            user_email=user.email,
            duration_minutes=req.duration_minutes,
            reason=req.reason,
            status=req.status,
            reviewed_by_name=rev.display_name if rev else None,
            reviewed_at=req.reviewed_at,
            review_note=req.review_note,
            granted_until=req.granted_until,
            created_at=req.created_at,
        )
        for req, user, rev in await session.execute(query)
    ]
