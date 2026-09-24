"""Password hashing and the JWT access token.

- Passwords: argon2id (memory-hard, the current recommendation for password storage).
- Access token: a JWT sent as an httpOnly cookie, so page scripts can never read it.
  API clients and scripts may send the same token as `Authorization: Bearer …`.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

from app.core.config import Settings

log = logging.getLogger("datadesk.auth")

_hasher = PasswordHasher()
ALGORITHM = "HS256"


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    """True when argon2's parameters changed since this hash was made."""
    try:
        return _hasher.check_needs_rehash(password_hash)
    except InvalidHashError:
        return False


def create_access_token(settings: Settings, user_id: uuid.UUID, role: str) -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "role": role,
        "iat": now,
        "exp": now + timedelta(minutes=settings.access_token_ttl_min),
        "typ": "access",
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=ALGORITHM)


def decode_access_token(settings: Settings, token: str) -> dict[str, Any] | None:
    """Return the claims, or None if the token is invalid, expired or the wrong type."""
    try:
        claims = jwt.decode(token, settings.jwt_secret, algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError:
        log.debug("access token expired: the person signs in again")
        return None
    except jwt.InvalidSignatureError:
        log.warning("access token signature does not match JWT_SECRET: was the secret changed?")
        return None
    except jwt.PyJWTError as exc:
        log.warning("access token could not be decoded: %s", exc.__class__.__name__)
        return None
    if claims.get("typ") != "access":
        log.warning("token is a %r, not an access token", claims.get("typ"))
        return None
    return claims
