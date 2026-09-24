"""Registration, sign-in, sign-out, and "forgot password".

The access token travels as an httpOnly cookie, so JavaScript can't read it (an XSS bug
can't steal the session) and the browser sends it automatically. The web app and the API
are same-origin (Next.js proxies /api/* to FastAPI), so no CORS or CSRF token is needed
for this setup; the cookie is SameSite=Lax, which blocks cross-site posts.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import ACCESS_COOKIE, current_user
from app.core.config import Settings, get_settings
from app.core.db import get_session
from app.core.security import create_access_token
from app.models.user import User
from app.schemas.auth import ForgotPasswordIn, LoginIn, MessageOut, RegisterIn, UserOut
from app.services import auth as auth_service

router = APIRouter(prefix="/auth", tags=["auth"])

RESET_ANSWER = (
    "If that account exists, an administrator has been asked to reset its password. "
    "They will give you a temporary one."
)


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def register(data: RegisterIn, session: AsyncSession = Depends(get_session)) -> User:
    """Create an account. It stays pending until an admin approves it, so no sign-in yet."""
    user = await auth_service.register(session, data)
    await session.commit()
    return user


@router.post("/login", response_model=UserOut)
async def login(
    data: LoginIn,
    response: Response,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> User:
    try:
        user = await auth_service.authenticate(session, data.identifier, data.password)
    finally:
        await session.commit()  # keep the failed-attempt counter even when it raises
    response.set_cookie(
        ACCESS_COOKIE,
        create_access_token(settings, user.id, user.role),
        max_age=settings.access_token_ttl_min * 60,
        httponly=True,
        secure=not settings.is_local,  # plain http on localhost, https everywhere else
        samesite="lax",
        path="/",
    )
    return user


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(response: Response) -> None:
    """Sign out on this device. Always succeeds, so the browser can clean up."""
    response.delete_cookie(ACCESS_COOKIE, path="/")


@router.post("/forgot-password", response_model=MessageOut, status_code=status.HTTP_202_ACCEPTED)
async def forgot_password(data: ForgotPasswordIn, session: AsyncSession = Depends(get_session)) -> MessageOut:
    """File a reset request for an admin. The answer is the same whether or not the
    account exists, so this can't be used to find out who is registered."""
    await auth_service.request_password_reset(session, data.identifier)
    await session.commit()
    return MessageOut(message=RESET_ANSWER)


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(current_user)) -> User:
    return user
