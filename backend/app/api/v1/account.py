"""The signed-in person's own account: asking to be an admin for a while."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user
from app.core.db import get_session
from app.models.user import User
from app.schemas.admin import AdminRequestIn, AdminRequestOut
from app.services import access

router = APIRouter(prefix="/account", tags=["account"])


@router.get("/admin-requests", response_model=list[AdminRequestOut])
async def my_admin_requests(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    return await access.list_requests(session, user_id=user.id)


@router.post("/admin-requests", status_code=status.HTTP_201_CREATED)
async def request_admin(
    body: AdminRequestIn, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
) -> dict:
    """Ask to be an admin for `duration_minutes`. An admin decides; nothing changes until then."""
    request = await access.request_admin(session, user, body.duration_minutes, body.reason)
    await session.commit()
    return {"id": str(request.id)}


@router.post("/admin-requests/{request_id}/cancel", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_admin_request(
    request_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
) -> None:
    await access.cancel_request(session, user, request_id)
    await session.commit()
