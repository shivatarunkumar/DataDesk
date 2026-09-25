import uuid
from datetime import datetime

from pydantic import BaseModel, Field, model_validator

from app.schemas.auth import Role


class PasswordResetOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    user_email: str
    user_name: str
    status: str
    created_at: datetime


class SetPasswordIn(BaseModel):
    new_password: str = Field(min_length=8, max_length=200)


class ReviewIn(BaseModel):
    review_note: str | None = Field(default=None, max_length=2000)


class ApproveUserIn(BaseModel):
    # the role to grant; defaults to the one they asked for
    role: Role | None = None


# the longest admin window anyone can ask for or be given: 90 days
MAX_ADMIN_MINUTES = 90 * 24 * 60


class AccessIn(BaseModel):
    """Set someone's access. For "admin", no duration means permanent."""

    role: Role
    duration_minutes: int | None = Field(default=None, ge=1, le=MAX_ADMIN_MINUTES)

    @model_validator(mode="after")
    def duration_only_for_admin(self) -> "AccessIn":
        if self.role == "user":
            self.duration_minutes = None
        return self


class AdminRequestIn(BaseModel):
    duration_minutes: int = Field(ge=1, le=MAX_ADMIN_MINUTES)
    reason: str | None = Field(default=None, max_length=1000)


class AdminRequestDecisionIn(BaseModel):
    # what to grant; defaults to what was asked. permanent=True ignores the duration
    duration_minutes: int | None = Field(default=None, ge=1, le=MAX_ADMIN_MINUTES)
    permanent: bool = False


class AdminRequestOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    user_name: str
    user_email: str
    duration_minutes: int
    reason: str | None
    status: str
    reviewed_by_name: str | None = None
    reviewed_at: datetime | None = None
    review_note: str | None = None
    granted_until: datetime | None = None
    created_at: datetime
