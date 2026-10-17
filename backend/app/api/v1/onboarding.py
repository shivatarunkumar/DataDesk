"""Onboarding tables and their data contracts.

Everyone can browse what is onboarded and ask for a new table; an admin approves the
request. Admins' own onboardings are approved at once.

    GET  /onboarding/sources/datasets                                BigQuery datasets
    GET  /onboarding/sources/datasets/{ds}/tables                    tables, marked when onboarded
    GET  /onboarding/sources/datasets/{ds}/tables/{t}/columns        the live schema
    GET  /onboarding/sources/datasets/{ds}/tables/{t}/cloud-run-contract   Cloud Run's rules today
    POST /onboarding/sources/access-check                            can DataDesk read/write it?
    GET  /onboarding/targets                 approved tables (+ your requests; admins see all)
    POST /onboarding/targets                 onboard (admin) or ask to onboard (anyone else)
    GET  /onboarding/targets/{id}
    PATCH /onboarding/targets/{id}           admins; or the requester while it is pending
    POST /onboarding/targets/{id}/approve    admins
    POST /onboarding/targets/{id}/reject     admins
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_admin, current_user
from app.core.db import get_session
from app.models.targets import UploadTarget
from app.models.user import User
from app.schemas.onboarding import (
    AccessCheckIn,
    AccessReport,
    CloudRunContract,
    SourceColumn,
    SourceTable,
    TargetIn,
    TargetOut,
    TargetPatch,
    TargetReviewIn,
)
from app.services import file_upload, onboarding

router = APIRouter(prefix="/onboarding", tags=["onboarding"])


def target_out(
    target: UploadTarget,
    viewer: User,
    request_count: int = 0,
    requester: User | None = None,
    reviewer: User | None = None,
) -> TargetOut:
    out = TargetOut.model_validate(target)
    out.request_count = request_count
    out.requested_by_name = requester.display_name if requester else None
    out.reviewed_by_name = reviewer.display_name if reviewer else None
    out.is_mine = target.created_by == viewer.id
    out.can_edit = onboarding.can_edit(target, viewer)
    return out


async def _full_out(session: AsyncSession, target: UploadTarget, viewer: User) -> TargetOut:
    requester = await session.get(User, target.created_by) if target.created_by else None
    reviewer = await session.get(User, target.reviewed_by) if target.reviewed_by else None
    return target_out(target, viewer, 0, requester, reviewer)


# ------------------------------------------------------------------ discovering sources
@router.get("/sources/datasets", response_model=list[str])
async def source_datasets(_: User = Depends(current_user)):
    return await onboarding.list_datasets()


@router.get("/sources/datasets/{dataset}/tables", response_model=list[SourceTable])
async def source_tables(
    dataset: str, _: User = Depends(current_user), session: AsyncSession = Depends(get_session)
):
    return await onboarding.list_tables(session, dataset)


@router.get("/sources/datasets/{dataset}/tables/{table}/columns", response_model=list[SourceColumn])
async def source_columns(dataset: str, table: str, _: User = Depends(current_user)):
    return await onboarding.table_schema(dataset, table)


@router.post("/sources/access-check", response_model=AccessReport)
async def access_check(body: AccessCheckIn, user: User = Depends(current_user)):
    """Test DataDesk's own access to a table for the chosen write modes. The one check
    that writes (BigQuery's staging table) runs only for admins."""
    return await onboarding.check_access(
        body.database_name,
        body.table_name,
        body.write_modes,
        body.key_columns,
        probe_writes=user.role == "admin",
        file_upload=body.file_upload,
    )


@router.get(
    "/sources/datasets/{dataset}/tables/{table}/cloud-run-contract",
    response_model=CloudRunContract | None,
)
async def cloud_run_contract(dataset: str, table: str, _: User = Depends(current_user)):
    """The contract Cloud Run already has for this table (one DataDesk didn't publish), in
    DataDesk's form, so onboarding starts from the rules that are live today. null if none."""
    return await file_upload.existing_cloud_run_contract(dataset, table)


# ------------------------------------------------------------------ onboarded tables
@router.get("/targets", response_model=list[TargetOut])
async def list_targets(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    rows = await onboarding.list_targets(session, user)
    return [target_out(t, user, n, req, rev) for t, n, req, rev in rows]


@router.post("/targets", response_model=TargetOut, status_code=status.HTTP_201_CREATED)
async def create_target(
    body: TargetIn, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
):
    target = await onboarding.create_target(session, user, body)
    await session.commit()
    await session.refresh(target)
    return await _full_out(session, target, user)


@router.get("/targets/{target_id}", response_model=TargetOut)
async def get_target(
    target_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
):
    return await _full_out(session, await onboarding.get_target(session, target_id, user), user)


@router.patch("/targets/{target_id}", response_model=TargetOut)
async def update_target(
    target_id: uuid.UUID,
    body: TargetPatch,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    target = await onboarding.update_target(session, user, target_id, body)
    await session.commit()
    await session.refresh(target)
    return await _full_out(session, target, user)


@router.post("/targets/{target_id}/approve", response_model=TargetOut)
async def approve_target(
    target_id: uuid.UUID,
    body: TargetReviewIn | None = None,
    admin: User = Depends(current_admin),
    session: AsyncSession = Depends(get_session),
):
    target = await onboarding.approve_target(session, admin, target_id, body.review_note if body else None)
    await session.commit()
    await session.refresh(target)
    return await _full_out(session, target, admin)


@router.post("/targets/{target_id}/reject", response_model=TargetOut)
async def reject_target(
    target_id: uuid.UUID,
    body: TargetReviewIn | None = None,
    admin: User = Depends(current_admin),
    session: AsyncSession = Depends(get_session),
):
    target = await onboarding.reject_target(session, admin, target_id, body.review_note if body else None)
    await session.commit()
    await session.refresh(target)
    return await _full_out(session, target, admin)
