"""Registration (admin-approved), sign-in and admin-resolved password resets."""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime, timedelta

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import security
from app.models.user import PasswordResetRequest, User
from app.schemas.auth import RegisterIn
from app.services.errors import ServiceError

log = logging.getLogger("datadesk.auth")

MAX_FAILED_LOGINS = 5
LOCKOUT_MINUTES = 15
USERNAME_RE = re.compile(r"[^a-z0-9_.-]+")

STATUS_MESSAGES = {
    "pending_approval": "Your account is waiting for an administrator to approve it.",
    "rejected": "Your registration was not approved.",
    "suspended": "Your account is suspended. Contact an administrator.",
    "deactivated": "Your account is deactivated.",
}


class AuthError(ServiceError):
    """Wrong credentials, duplicate email, unapproved account: reported to the user."""


# ------------------------------------------------------------------ registration
def username_from_email(email: str) -> str:
    """jane.doe@corp.com → jane.doe"""
    base = USERNAME_RE.sub("", email.split("@", 1)[0].lower()).strip("._-")
    base = base or "user"
    if len(base) < 2:
        base = f"{base}user"
    return base[:50]


async def unique_username(session: AsyncSession, wanted: str) -> str:
    """Append a number until the username is free: jane, jane2, jane3 …"""
    candidate, suffix = wanted, 1
    while await session.scalar(select(User.id).where(User.username == candidate)):
        suffix += 1
        tail = str(suffix)
        candidate = f"{wanted[: 50 - len(tail)]}{tail}"
    return candidate


async def register(session: AsyncSession, data: RegisterIn) -> User:
    if await session.scalar(select(User.id).where(User.email == data.email)):
        raise AuthError("An account with this email already exists", status_code=409, field="email")

    if data.username:
        if await session.scalar(select(User.id).where(User.username == data.username)):
            raise AuthError("That username is taken", status_code=409, field="username")
        username = data.username
    else:
        username = await unique_username(session, username_from_email(data.email))

    user = User(
        email=data.email,
        username=username,
        first_name=data.first_name,
        last_name=data.last_name,
        password_hash=security.hash_password(data.password),
        role="user",
        requested_role=data.requested_role,
        status="pending_approval",
        failed_login_count=0,
    )
    session.add(user)
    await session.flush()
    log.info("registered %s as %s: waiting for admin approval", username, data.requested_role)
    return user


# ------------------------------------------------------------------ sign in
async def find_by_login(session: AsyncSession, identifier: str) -> User | None:
    return await session.scalar(
        select(User).where(
            or_(User.email == identifier, User.username == identifier),
            User.deleted_at.is_(None),
        )
    )


async def authenticate(session: AsyncSession, identifier: str, password: str) -> User:
    user = await find_by_login(session, identifier)
    now = datetime.now(UTC)

    # Same message whichever check fails, so the response can't be used to discover
    # which accounts exist.
    invalid = AuthError("Incorrect email, username or password", status_code=401)

    if user is None:
        security.hash_password(password)  # keep the timing similar to a real check
        log.info("login failed: no account for that email/username (the reply does not say so)")
        raise invalid
    if user.locked_until and user.locked_until > now:
        minutes = max(1, int((user.locked_until - now).total_seconds() // 60) + 1)
        log.info("login refused: %s is locked for another %d minute(s)", user.username, minutes)
        raise AuthError(f"Too many failed attempts. Try again in {minutes} minute(s).", status_code=429)

    if not security.verify_password(password, user.password_hash):
        user.failed_login_count += 1
        if user.failed_login_count >= MAX_FAILED_LOGINS:
            user.locked_until = now + timedelta(minutes=LOCKOUT_MINUTES)
            user.failed_login_count = 0
            log.warning(
                "%s locked for %d minutes after %d failed attempts",
                user.username,
                LOCKOUT_MINUTES,
                MAX_FAILED_LOGINS,
            )
        else:
            log.info(
                "login failed: wrong password for %s (attempt %d of %d)",
                user.username,
                user.failed_login_count,
                MAX_FAILED_LOGINS,
            )
        raise invalid

    # Right password: only now is it safe to say why they still can't come in.
    if user.status != "active":
        log.info("login refused: %s is %s", user.username, user.status)
        raise AuthError(STATUS_MESSAGES.get(user.status, f"Account is {user.status}."), status_code=403)

    if security.needs_rehash(user.password_hash):
        user.password_hash = security.hash_password(password)
    user.failed_login_count = 0
    user.locked_until = None
    user.last_login_at = now
    log.info("signed in: %s", user.username)
    return user


# ------------------------------------------------------------------ password resets
async def request_password_reset(session: AsyncSession, identifier: str) -> None:
    """File a reset request for an admin to resolve. Silent when nobody matches."""
    user = await find_by_login(session, identifier)
    if user is None:
        log.info("password reset requested for an unknown account")
        return
    pending = await session.scalar(
        select(PasswordResetRequest.id).where(
            PasswordResetRequest.user_id == user.id, PasswordResetRequest.status == "pending"
        )
    )
    if pending:
        log.info("password reset for %s already pending", user.username)
        return
    session.add(PasswordResetRequest(user_id=user.id, status="pending"))
    log.info("password reset requested for %s: waiting for an admin", user.username)


def set_password(user: User, password: str) -> None:
    user.password_hash = security.hash_password(password)
    user.password_changed_at = datetime.now(UTC)
    user.failed_login_count = 0
    user.locked_until = None
