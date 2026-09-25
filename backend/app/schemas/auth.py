import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

USERNAME_PATTERN = r"^[a-z0-9][a-z0-9_.-]{1,49}$"

Role = Literal["user", "admin"]


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str | None = Field(default=None, max_length=100)
    # optional: derived from the email when left empty
    username: str | None = Field(default=None, pattern=USERNAME_PATTERN)
    # what they ask for; an admin grants it (or not) when approving the account
    requested_role: Role = "user"

    @field_validator("email")
    @classmethod
    def lowercase_email(cls, value: str) -> str:
        return value.strip().lower()

    @field_validator("first_name")
    @classmethod
    def strip_first_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("First name is required")
        return value

    @field_validator("last_name")
    @classmethod
    def strip_last_name(cls, value: str | None) -> str | None:
        return (value or "").strip() or None

    @field_validator("username", mode="before")
    @classmethod
    def normalise_username(cls, value: str | None) -> str | None:
        return (value or "").strip().lower() or None


class LoginIn(BaseModel):
    # email or username
    identifier: str = Field(min_length=1, max_length=255)
    password: str

    @field_validator("identifier")
    @classmethod
    def lowercase(cls, value: str) -> str:
        return value.strip().lower()


class ForgotPasswordIn(BaseModel):
    identifier: str = Field(min_length=1, max_length=255)

    @field_validator("identifier")
    @classmethod
    def lowercase(cls, value: str) -> str:
        return value.strip().lower()


class MessageOut(BaseModel):
    message: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    username: str
    first_name: str | None
    last_name: str | None
    display_name: str
    role: str
    requested_role: str
    # when a delegated admin's rights end; None for a permanent admin (or a user)
    admin_until: datetime | None = None
    status: str
    last_login_at: datetime | None = None
    created_at: datetime
