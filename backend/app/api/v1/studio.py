"""Data Studio: query onboarded tables, edit a few rows, submit them for approval.

GET  /studio/tables    onboarded BigQuery and Postgres tables, open to everyone signed in
POST /studio/query     run one read-only SELECT over onboarded tables of one source
POST /studio/export    the result as a CSV in a folder of My files, for big edits
POST /studio/submit    edited and new rows → contract checks → a load request (201),
                       or the failed report (422, nothing filed)
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user
from app.api.v1.requests import request_out
from app.core.config import Settings, get_settings
from app.core.db import get_session
from app.models.user import User
from app.schemas.studio import ExportIn, ExportOut, QueryIn, QueryOut, ResultColumn, StudioSubmitIn
from app.schemas.workspace import FileOut, TargetTable, UploadRequestOut
from app.services import requests as requests_svc
from app.services import studio

router = APIRouter(prefix="/studio", tags=["studio"])


@router.get("/tables", response_model=list[TargetTable])
async def list_tables(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    return await studio.list_tables(session)


@router.post("/query", response_model=QueryOut)
async def run_query(
    body: QueryIn,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    limit = settings.studio_row_limit
    result = await studio.run(session, settings, body.target_type, body.database, body.sql, limit)
    mode, reason, target = await studio.edit_mode(result)
    keys = list(target.key_columns or []) if target else []
    return QueryOut(
        columns=[
            ResultColumn(name=c["name"], type=c.get("type"), key=c["name"] in keys) for c in result.columns
        ],
        rows=[[studio.display(v) for v in r] for r in result.rows],
        row_limit=limit,
        truncated=result.truncated,
        elapsed_ms=result.elapsed_ms,
        bytes_processed=result.bytes_processed,
        tables=[t.location for t in result.tables],
        edit_mode=mode,
        edit_reason=reason,
        target_id=target.id if target else None,
        target_label=target.display_name if target else None,
        key_columns=keys,
        max_changes=settings.studio_max_changes,
    )


@router.post("/export", response_model=ExportOut, status_code=status.HTTP_201_CREATED)
async def export(
    body: ExportIn,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    file, truncated = await studio.export(
        session, settings, user, body.target_type, body.database, body.sql, body.name, body.folder_id
    )
    await session.commit()
    await session.refresh(file)
    return ExportOut(file=FileOut.model_validate(file), truncated=truncated)


@router.post("/submit", response_model=UploadRequestOut)
async def submit(
    body: StudioSubmitIn,
    response: Response,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    request, file, report, target = await studio.submit(session, settings, user, body)
    await session.commit()
    if request is None:
        response.status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
        return UploadRequestOut(
            file_id=file.id,
            file_name=file.original_name,
            target_type=target.target_type,
            target_database=target.database,
            target_schema=target.schema_name,
            target_table=target.table,
            write_mode="upsert" if body.edits else "append",
            validation_status="failed",
            validation_report=report,
            status="failed",
            target_id=target.target_id,
            target_label=target.label,
            contract_version=target.contract_version,
            origin="studio",
            change_summary=report.get("studio"),
        )
    response.status_code = status.HTTP_201_CREATED
    return request_out(await requests_svc.get_request(session, request.id), user)
