"""Shared FastAPI dependencies: the signed-in user, from the access-token cookie.

A 401 from here is the most common "why doesn't this work?" in the app, so each way it can
happen is logged with its reason: no token at all, an expired or tampered token, or a user
who has since been suspended.

The browser sends the httpOnly cookie; scripts and API clients may send the same token as
`Authorization: Bearer …` instead.
"""

from __future__ import annotations

import logging
import uuid

from fastapi import Cookie, Depends, Header, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.core.db import get_session
from app.core.logging import user_var
from app.core.security import decode_access_token
from app.models.user import User
from app.services.access import expire_admin_if_due

ACCESS_COOKIE = "datadesk_access"

log = logging.getLogger("datadesk.auth")


async def current_user_optional(
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
    datadesk_access: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> User | None:
    token = datadesk_access
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if not token:
        log.debug("no %s cookie or bearer token: treating as anonymous", ACCESS_COOKIE)
        return None

    claims = decode_access_token(settings, token)
    if not claims:
        log.debug("access token rejected: expired, wrong signature, or not an access token")
        return None

    try:
        user_id = uuid.UUID(claims["sub"])
    except (KeyError, ValueError):
        log.warning("access token has no usable subject claim: %s", sorted(claims))
        return None

    user = await session.get(User, user_id)
    if user is None:
        log.warning("access token names user %s, who no longer exists", user_id)
        return None
    if user.status != "active" or user.deleted_at is not None:
        log.info("user %s is %s; treating as signed out", user.username, user.status)
        return None

    if expire_admin_if_due(user):
        await session.commit()  # their admin time is up: every check from here on sees "user"

    user_var.set(user.username)  # every later log line in this request names them
    log.debug("  signed in as %s (%s)", user.username, user.role)
    return user


async def current_user(user: User | None = Depends(current_user_optional)) -> User:
    """The signed-in user, or 401. Used by everything that needs an account."""
    if user is None:
        log.info(
            "401: this endpoint needs an account and the request had no valid session "
            "(missing or expired %s cookie); the person signs in again",
            ACCESS_COOKIE,
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"message": "Sign in to continue"},
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


async def current_admin(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        log.info("403: %s is not an admin", user.username)
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={"message": "Admins only"})
    return user
