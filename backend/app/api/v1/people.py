"""Who is in DataDesk, for everyone signed in: names, how to reach them, who the admins are.

Only active accounts, and nothing about sign-ins or account status; admins manage people
through /admin/users.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user
from app.core.db import get_session
from app.models.user import User
from app.services import reviews
from app.services.access import expire_admin_if_due

router = APIRouter(prefix="/people", tags=["people"])


class PersonOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    display_name: str
    username: str
    email: str
    role: str
    admin_until: datetime | None


@router.get("", response_model=list[PersonOut])
async def list_people(_: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    users = await reviews.list_users(session, "active")
    # nobody is listed as an admin after their time is up, even before they come back
    if any([expire_admin_if_due(u) for u in users]):
        await session.commit()
    return sorted(users, key=lambda u: u.display_name.lower())
