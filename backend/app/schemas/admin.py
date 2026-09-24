import uuid
from datetime import datetime

from pydantic import BaseModel, Field


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
