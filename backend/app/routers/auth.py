import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status, Header
from pydantic import BaseModel
from sqlalchemy import select, or_, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth_models import User
from app.auth_schemas import LoginResponse, RegisterRequest, LoginRequest, UserResponse
from app.auth_utils import hash_password, verify_password, create_access_token, decode_token
from app.datamanager_database import get_dm_db

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=UserResponse, status_code=201)
async def register(payload: RegisterRequest, db: AsyncSession = Depends(get_dm_db)):
    existing = await db.execute(select(User).where(User.email == payload.email))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already registered.")
    username = payload.username or payload.first_name
    if username:
        clash = await db.execute(select(User).where(User.username == username))
        if clash.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="Username already taken.")
    user = User(
        email=payload.email,
        password_hash=hash_password(payload.password),
        first_name=payload.first_name,
        last_name=payload.last_name,
        username=username,
        status="pending_approval",
        role="user",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@router.post("/login", response_model=LoginResponse)
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_dm_db)):
    result = await db.execute(
        select(User).where(
            or_(User.email == payload.identifier, User.username == payload.identifier),
            User.deleted_at.is_(None),
        )
    )
    user = result.scalar_one_or_none()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email/username or password.")
    if user.status == "pending_approval":
        raise HTTPException(
            status_code=403,
            detail="Your account is pending approval by an administrator.",
        )
    if user.status == "rejected":
        raise HTTPException(status_code=403, detail="Your registration was not approved.")
    if user.status != "active":
        raise HTTPException(status_code=403, detail=f"Account is {user.status}.")
    token = create_access_token(str(user.id), user.role)
    return LoginResponse(access_token=token, user=UserResponse.model_validate(user))


class ForgotPasswordRequest(BaseModel):
    identifier: str  # email or username


@router.post("/forgot-password", status_code=201)
async def forgot_password(payload: ForgotPasswordRequest, db: AsyncSession = Depends(get_dm_db)):
    result = await db.execute(
        select(User).where(
            or_(User.email == payload.identifier, User.username == payload.identifier),
            User.deleted_at.is_(None),
        )
    )
    user = result.scalar_one_or_none()
    if not user:
        # Don't reveal whether user exists
        return {"detail": "If an account exists, a reset request has been submitted."}

    # Check for existing pending request
    existing = await db.execute(
        text("SELECT id FROM password_reset_requests WHERE user_id = :uid AND status = 'pending'"),
        {"uid": str(user.id)},
    )
    if not existing.scalar_one_or_none():
        await db.execute(
            text("INSERT INTO password_reset_requests (user_id) VALUES (:uid)"),
            {"uid": str(user.id)},
        )
        await db.commit()

    return {"detail": "Reset request submitted. An admin will set a temporary password for you."}


@router.get("/me", response_model=UserResponse)
async def me(authorization: str = Header(...), db: AsyncSession = Depends(get_dm_db)):
    try:
        token = authorization.removeprefix("Bearer ")
        payload = decode_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token.")
    result = await db.execute(
        select(User).where(User.id == uuid.UUID(payload["sub"]))
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    return user
