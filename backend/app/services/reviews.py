"""Everything an admin approves: new accounts, password resets, and loads into tables."""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.storage import get_storage
from app.core.config import Settings
from app.models.targets import UploadTarget
from app.models.user import PasswordResetRequest, User
from app.models.workspace import UploadRequest, WorkspaceFile, WorkspaceFileVersion
from app.services import auth, file_parser, loaders, studio_changes, validators
from app.services.errors import NotFound, ServiceError
from app.services.workspace import contract_rules, run_storage

log = logging.getLogger("datadesk.reviews")

REVIEWED = ("approved", "rejected", "completed", "failed")


# ------------------------------------------------------------------ accounts
async def list_users(session: AsyncSession, status: str | None = None) -> list[User]:
    query = select(User).where(User.deleted_at.is_(None))
    if status:
        query = query.where(User.status == status).order_by(User.created_at.asc())
    else:
        query = query.order_by(User.created_at.desc())
    return list(await session.scalars(query))


async def set_user_status(
    session: AsyncSession, admin: User, user_id: uuid.UUID, status: str, role: str | None = None
) -> User:
    user = await session.get(User, user_id)
    if user is None or user.deleted_at is not None:
        raise NotFound("User")
    if user.id == admin.id:
        raise ServiceError("You can't change your own account's status.", status_code=409)
    if status == "active" and user.status == "pending_approval":
        # approval is the only point where an account gets its role
        user.role = role or user.requested_role
        user.admin_until = None  # approved as an admin means a permanent one
    user.status = status
    user.reviewed_by = admin.id
    user.reviewed_at = datetime.now(UTC)
    log.info("%s set %s to %s (%s)", admin.username, user.username, status, user.role)
    return user


# ------------------------------------------------------------------ password resets
async def pending_password_resets(session: AsyncSession) -> list[tuple[PasswordResetRequest, User]]:
    rows = await session.execute(
        select(PasswordResetRequest, User)
        .join(User, User.id == PasswordResetRequest.user_id)
        .where(PasswordResetRequest.status == "pending")
        .order_by(PasswordResetRequest.created_at.asc())
    )
    return [(req, user) for req, user in rows]


async def resolve_password_reset(
    session: AsyncSession, admin: User, reset_id: uuid.UUID, password: str
) -> None:
    request = await session.get(PasswordResetRequest, reset_id)
    if request is None:
        raise NotFound("Reset request")
    if request.status != "pending":
        raise ServiceError("That request has already been resolved.", status_code=409)
    user = await session.get(User, request.user_id)
    if user is None:
        raise NotFound("User")
    auth.set_password(user, password)
    request.status = "resolved"
    request.resolved_by = admin.id
    request.resolved_at = datetime.now(UTC)
    log.info("%s set a temporary password for %s", admin.username, user.username)


# ------------------------------------------------------------------ load requests
async def _pending_request(session: AsyncSession, request_id: uuid.UUID) -> UploadRequest:
    request = await session.get(UploadRequest, request_id)
    if request is None:
        raise NotFound("Load request")
    if request.status != "pending":
        raise ServiceError(f"That request is already {request.status}.", status_code=409)
    return request


async def approve_upload(
    session: AsyncSession, settings: Settings, admin: User, request_id: uuid.UUID
) -> UploadRequest:
    """Re-validate the exact version that was submitted against the table as it is now,
    then load it. The outcome (completed or failed) is recorded either way."""
    request = await _pending_request(session, request_id)
    file = await session.get(WorkspaceFile, request.file_id)
    if file is None or file.status != "active":
        raise ServiceError("The source file no longer exists.", status_code=410)

    request.status = "approved"
    request.reviewed_by = admin.id
    request.reviewed_at = datetime.now(UTC)

    version = await session.scalar(
        select(WorkspaceFileVersion).where(
            WorkspaceFileVersion.file_id == request.file_id,
            WorkspaceFileVersion.version == request.file_version,
        )
    )
    path = version.gcs_path if version else file.current_gcs_path
    keys = list(request.key_columns or [])

    try:
        data = await run_storage(get_storage().download, path)
        parsed = await asyncio.to_thread(file_parser.parse, data, file.format, None, settings.max_rows)
        target_cols = await loaders.target_columns(
            request.target_type, request.target_database, request.target_schema, request.target_table
        )
        # the contract as it is now: if an admin tightened it since the request, that counts
        onboarded = await session.get(UploadTarget, request.target_id) if request.target_id else None
        rules, max_rows = contract_rules(request.target_type, request.target_table, onboarded)
        report = validators.validate(parsed, target_cols, request.write_mode, keys, rules, max_rows=max_rows)
        report["contract_version"] = onboarded.contract_version if onboarded else None
        report["contract_rules"] = len(rules)
        report["file"] = {
            "format": file.format,
            "delimiter": parsed.get("delimiter"),
            "version": request.file_version,
        }
        if not report["passed"]:
            request.status = "failed"
            request.validation_status = "failed"
            request.validation_report = report
            changed = onboarded is not None and onboarded.contract_version != request.contract_version
            request.result = {
                "error": "The file no longer passes: the data contract changed since the request (now v"
                f"{onboarded.contract_version})."
                if changed
                else "The file no longer matches the table (checked again at approval)."
            }
            log.info("load %s failed re-validation: %s", request.id, report["summary"])
            return request

        if request.origin == "studio" and request.write_mode != "upsert":
            # Data Studio edits change rows in place, found by their original values
            request.result = await studio_changes.apply(
                request.target_type,
                request.target_database or "",
                request.target_schema,
                request.target_table,
                request.change_summary or {},
                {c["name"]: c["type"] for c in target_cols},
            )
        else:
            request.result = await loaders.load(
                request.target_type,
                request.target_database,
                request.target_schema,
                request.target_table,
                parsed,
                request.write_mode,
                keys,
                target_cols,
            )
        request.status = "completed"
        request.executed_at = datetime.now(UTC)
        log.info(
            "%s approved load %s → %s.%s: %s",
            admin.username,
            request.id,
            request.target_database,
            request.target_table,
            request.result,
        )
    except Exception as exc:
        message = exc.message if isinstance(exc, ServiceError) else str(exc)
        request.status = "failed"
        request.result = {"error": message}
        log.warning("load %s failed: %s: %s", request.id, type(exc).__name__, message)
    return request


async def reject_upload(
    session: AsyncSession, admin: User, request_id: uuid.UUID, note: str | None
) -> UploadRequest:
    request = await _pending_request(session, request_id)
    request.status = "rejected"
    request.reviewed_by = admin.id
    request.reviewed_at = datetime.now(UTC)
    request.review_note = (note or "").strip() or None
    log.info("%s rejected load %s", admin.username, request.id)
    return request
