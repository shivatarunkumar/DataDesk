"""Admin endpoints: user approvals, password resets, and upload request review."""
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app import file_parser, gcs_client, validators
from app.auth_models import User
from app.auth_schemas import UserResponse
from app.auth_utils import hash_password
from app.datamanager_database import get_dm_db
from app.deps import require_admin
from app.loaders import get_target_columns, load_bigquery, load_postgres
from app.workspace_models import UploadRequest, WorkspaceFile, WorkspaceFileVersion

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/users/pending", response_model=list[UserResponse])
async def list_pending(
    db: AsyncSession = Depends(get_dm_db),
    _: dict = Depends(require_admin),
):
    result = await db.execute(
        select(User).where(User.status == "pending_approval", User.deleted_at.is_(None))
        .order_by(User.created_at.asc())
    )
    return result.scalars().all()


@router.get("/users", response_model=list[UserResponse])
async def list_all_users(
    db: AsyncSession = Depends(get_dm_db),
    _: dict = Depends(require_admin),
):
    result = await db.execute(
        select(User).where(User.deleted_at.is_(None)).order_by(User.created_at.desc())
    )
    return result.scalars().all()


@router.post("/users/{user_id}/approve", response_model=UserResponse)
async def approve_user(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_dm_db),
    _: dict = Depends(require_admin),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    user.status = "active"
    await db.commit()
    await db.refresh(user)
    return user


@router.post("/users/{user_id}/reject", response_model=UserResponse)
async def reject_user(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_dm_db),
    _: dict = Depends(require_admin),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    user.status = "rejected"
    await db.commit()
    await db.refresh(user)
    return user


# ── Password Reset Management ──────────────────────────────────────────────────

class PasswordResetRequest(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    user_email: Optional[str] = None
    status: str
    created_at: datetime


class SetPasswordPayload(BaseModel):
    new_password: str


@router.get("/password-resets", response_model=list[PasswordResetRequest])
async def list_password_resets(
    db: AsyncSession = Depends(get_dm_db),
    _: dict = Depends(require_admin),
):
    result = await db.execute(
        text("SELECT id, user_id, status, created_at FROM password_reset_requests WHERE status = 'pending' ORDER BY created_at ASC")
    )
    rows = result.mappings().all()
    out = []
    for row in rows:
        u = await db.execute(select(User).where(User.id == row["user_id"]))
        user_obj = u.scalar_one_or_none()
        out.append(PasswordResetRequest(
            id=row["id"],
            user_id=row["user_id"],
            user_email=user_obj.email if user_obj else None,
            status=row["status"],
            created_at=row["created_at"],
        ))
    return out


@router.post("/password-resets/{reset_id}/resolve")
async def resolve_password_reset(
    reset_id: uuid.UUID,
    payload: SetPasswordPayload,
    db: AsyncSession = Depends(get_dm_db),
    admin: dict = Depends(require_admin),
):
    row = await db.execute(
        text("SELECT id, user_id, status FROM password_reset_requests WHERE id = :rid"),
        {"rid": str(reset_id)},
    )
    reset = row.mappings().one_or_none()
    if not reset:
        raise HTTPException(status_code=404, detail="Reset request not found.")
    if reset["status"] != "pending":
        raise HTTPException(status_code=400, detail="Request already resolved.")

    u = await db.execute(select(User).where(User.id == reset["user_id"]))
    user_obj = u.scalar_one_or_none()
    if not user_obj:
        raise HTTPException(status_code=404, detail="User not found.")
    user_obj.password_hash = hash_password(payload.new_password)

    admin_user_id = uuid.UUID(admin["sub"])
    await db.execute(
        text("UPDATE password_reset_requests SET status = 'resolved', resolved_by = :by, resolved_at = now() WHERE id = :rid"),
        {"by": str(admin_user_id), "rid": str(reset_id)},
    )
    await db.commit()
    return {"detail": "Password updated successfully."}


# ── Data Workspace Upload Request Management ──────────────────────────────────

class UploadRequestAdminResponse(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    user_email: Optional[str] = None
    file_id: uuid.UUID
    file_name: Optional[str] = None
    file_version: int
    target_type: str
    target_database: Optional[str] = None
    target_schema: Optional[str] = None
    target_table: str
    write_mode: str
    key_columns: Optional[list] = None
    justification: Optional[str] = None
    validation_status: Optional[str] = None
    validation_report: Optional[dict] = None
    status: str
    review_note: Optional[str] = None
    result: Optional[dict] = None
    created_at: datetime


class UploadReviewPayload(BaseModel):
    review_note: Optional[str] = None


async def _enrich_upload(req: UploadRequest, db: AsyncSession) -> dict:
    u = await db.execute(select(User).where(User.id == req.user_id))
    user_obj = u.scalar_one_or_none()
    f = await db.execute(select(WorkspaceFile).where(WorkspaceFile.id == req.file_id))
    file_obj = f.scalar_one_or_none()
    return {
        "user_email": user_obj.email if user_obj else None,
        "file_name": file_obj.original_name if file_obj else None,
        "file": file_obj,
    }


def _upload_response(req: UploadRequest, e: dict) -> "UploadRequestAdminResponse":
    return UploadRequestAdminResponse(
        id=req.id, user_id=req.user_id, user_email=e["user_email"],
        file_id=req.file_id, file_name=e["file_name"], file_version=req.file_version,
        target_type=req.target_type, target_database=req.target_database,
        target_schema=req.target_schema, target_table=req.target_table,
        write_mode=req.write_mode, key_columns=req.key_columns,
        justification=req.justification, validation_status=req.validation_status,
        validation_report=req.validation_report, status=req.status,
        review_note=req.review_note, result=req.result, created_at=req.created_at,
    )


@router.get("/upload-requests", response_model=list[UploadRequestAdminResponse])
async def list_upload_requests(
    db: AsyncSession = Depends(get_dm_db),
    _: dict = Depends(require_admin),
):
    result = await db.execute(
        select(UploadRequest)
        .where(UploadRequest.status == "pending")
        .order_by(UploadRequest.created_at.asc())
    )
    out = []
    for req in result.scalars().all():
        e = await _enrich_upload(req, db)
        out.append(_upload_response(req, e))
    return out


@router.get("/upload-requests/history", response_model=list[UploadRequestAdminResponse])
async def list_upload_request_history(
    db: AsyncSession = Depends(get_dm_db),
    _: dict = Depends(require_admin),
):
    result = await db.execute(
        select(UploadRequest)
        .where(UploadRequest.status.in_(["approved", "rejected", "completed", "failed"]))
        .order_by(UploadRequest.created_at.desc())
    )
    out = []
    for req in result.scalars().all():
        e = await _enrich_upload(req, db)
        out.append(_upload_response(req, e))
    return out


@router.post("/upload-requests/{request_id}/approve", response_model=UploadRequestAdminResponse)
async def approve_upload_request(
    request_id: uuid.UUID,
    db: AsyncSession = Depends(get_dm_db),
    admin: dict = Depends(require_admin),
):
    result = await db.execute(select(UploadRequest).where(UploadRequest.id == request_id))
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Upload request not found.")
    if req.status != "pending":
        raise HTTPException(status_code=400, detail=f"Request is already {req.status}.")

    e = await _enrich_upload(req, db)
    file_obj = e["file"]
    if not file_obj:
        raise HTTPException(status_code=404, detail="Source file no longer exists.")

    req.status = "approved"
    req.reviewed_by = uuid.UUID(admin["sub"])
    req.reviewed_at = datetime.now(timezone.utc)

    # Resolve the exact file version that was submitted (fall back to current).
    vres = await db.execute(
        select(WorkspaceFileVersion).where(
            WorkspaceFileVersion.file_id == req.file_id,
            WorkspaceFileVersion.version == req.file_version,
        )
    )
    version_row = vres.scalar_one_or_none()
    gcs_path = version_row.gcs_path if version_row else file_obj.current_gcs_path

    try:
        # Re-read + re-validate against the live schema (it may have changed).
        data = gcs_client.download_bytes(gcs_path)
        parsed = file_parser.parse(data, file_obj.format)
        target_columns = await get_target_columns(
            req.target_type, req.target_database, req.target_schema, req.target_table
        )
        rules = validators.load_rules(req.target_type, req.target_table)
        report = validators.validate(
            parsed, target_columns, req.write_mode, req.key_columns or [], rules
        )
        if not report["passed"]:
            req.status = "failed"
            req.validation_status = "failed"
            req.validation_report = report
            req.result = {"error": "Re-validation failed at approval time.", "report": report}
            await db.commit()
            await db.refresh(req)
            return _upload_response(req, e)

        if req.target_type == "postgres":
            load_result = await load_postgres(
                req.target_database, req.target_schema or "public", req.target_table,
                parsed["columns"], parsed["rows"], req.write_mode,
                req.key_columns or [], target_columns,
            )
        elif req.target_type == "bigquery":
            load_result = await run_in_threadpool(
                load_bigquery, req.target_database, req.target_table,
                parsed["columns"], parsed["rows"], req.write_mode,
                req.key_columns or [], target_columns,
            )
        else:
            raise ValueError("Oracle support is coming soon.")

        req.status = "completed"
        req.executed_at = datetime.now(timezone.utc)
        req.result = load_result
    except Exception as exc:
        req.status = "failed"
        req.result = {"error": str(exc)}

    await db.commit()
    await db.refresh(req)
    e = await _enrich_upload(req, db)
    return _upload_response(req, e)


@router.post("/upload-requests/{request_id}/reject", response_model=UploadRequestAdminResponse)
async def reject_upload_request(
    request_id: uuid.UUID,
    payload: UploadReviewPayload | None = None,
    db: AsyncSession = Depends(get_dm_db),
    admin: dict = Depends(require_admin),
):
    result = await db.execute(select(UploadRequest).where(UploadRequest.id == request_id))
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Upload request not found.")
    if req.status != "pending":
        raise HTTPException(status_code=400, detail=f"Request is already {req.status}.")
    req.status = "rejected"
    req.reviewed_by = uuid.UUID(admin["sub"])
    req.reviewed_at = datetime.now(timezone.utc)
    if payload and payload.review_note:
        req.review_note = payload.review_note
    await db.commit()
    await db.refresh(req)
    e = await _enrich_upload(req, db)
    return _upload_response(req, e)
