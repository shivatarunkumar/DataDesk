"""Admins onboard target tables and their data contracts.

An onboarded, active target is offered to everyone in "Load to table". A file sent to it
must pass the table's live schema and the contract (services/validators.py) before the
request reaches an admin, and again when the admin approves it.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.adapters import bigquery, target_postgres
from app.models.targets import UploadTarget
from app.models.user import User
from app.models.workspace import UploadRequest
from app.schemas.onboarding import Contract, TargetIn, TargetPatch
from app.services import loaders
from app.services.errors import NotFound, ServiceError

log = logging.getLogger("datadesk.onboarding")

ORACLE_SOON = "Oracle support is coming soon."


# ------------------------------------------------------------------ discovering sources
async def list_databases(target_type: str) -> list[str]:
    """BigQuery datasets, or databases on the target Postgres server."""
    try:
        if target_type == "bigquery":
            return await asyncio.to_thread(bigquery.list_datasets)
        if target_type == "postgres":
            return await target_postgres.list_databases()
    except Exception as exc:
        raise ServiceError(f"Could not list {target_type} databases: {exc}", status_code=502) from exc
    raise ServiceError(ORACLE_SOON)


async def list_tables(session: AsyncSession, target_type: str, database: str) -> list[dict]:
    try:
        if target_type == "bigquery":
            tables = await asyncio.to_thread(bigquery.list_tables, database)
        elif target_type == "postgres":
            tables = await target_postgres.list_tables(database)
        else:
            raise ServiceError(ORACLE_SOON)
    except ServiceError:
        raise
    except Exception as exc:
        raise ServiceError(f"Could not list tables in {database}: {exc}", status_code=502) from exc

    # mark the ones already onboarded, so the picker can say so
    onboarded = {
        (t.schema_name, t.table_name): t.id
        for t in await session.scalars(
            select(UploadTarget).where(
                UploadTarget.target_type == target_type, UploadTarget.database_name == database
            )
        )
    }
    return [
        {**t, "schema_name": t["schema"], "onboarded_id": onboarded.get((t["schema"], t["table"]))}
        for t in tables
    ]


async def table_schema(target_type: str, database: str, schema: str | None, table: str) -> list[dict]:
    if target_type == "oracle":
        raise ServiceError(ORACLE_SOON)
    try:
        return await loaders.target_columns(target_type, database, schema, table)
    except Exception as exc:
        raise ServiceError(f"Could not read {database}.{table}: {exc}", status_code=502) from exc


async def check_access(
    target_type: str,
    database: str,
    schema: str | None,
    table: str,
    modes: list[str],
    keys: list[str],
    probe_writes: bool = True,
) -> dict:
    """Can DataDesk, with its own credentials, do what these write modes need? Run before
    onboarding, so a missing grant shows up now and not on the first approved load."""
    if target_type == "oracle":
        raise ServiceError(ORACLE_SOON)
    if target_type == "bigquery":
        checks = await asyncio.to_thread(bigquery.access_checks, database, table, modes, keys, probe_writes)
    else:
        checks = await target_postgres.access_checks(database, schema or "public", table, modes, keys)
    ok = all(c["ok"] for c in checks)
    log.info(
        "access check %s %s.%s (%s): %s",
        target_type,
        database,
        table,
        "+".join(modes),
        "ok" if ok else "failed: " + ", ".join(c["name"] for c in checks if not c["ok"]),
    )
    return {"ok": ok, "checks": checks}


async def require_access(
    target_type: str,
    database: str,
    schema: str | None,
    table: str,
    modes: list[str],
    keys: list[str],
    probe_writes: bool,
) -> None:
    """Refuse to onboard (or approve) a table DataDesk can't actually load into. Run on the
    server, so it holds however the request arrives."""
    report = await check_access(target_type, database, schema, table, modes, keys, probe_writes=probe_writes)
    failed = [c for c in report["checks"] if not c["ok"]]
    if failed:
        listed = "; ".join(f"{c['name']}: {c['detail']}" for c in failed)
        raise ServiceError(
            f"The access check must pass first. Failed: {listed}. Run Test access for the fixes.",
            status_code=422,
            field="access",
        )


# ------------------------------------------------------------------ targets
def _check_against_schema(columns: list[dict], contract: Contract, key_columns: list[str]) -> None:
    """Every rule and every key must name a real column of the table."""
    names = {c["name"] for c in columns}
    unknown = [r.name for r in contract.columns if r.name not in names]
    if unknown:
        raise ServiceError(
            f"The contract names columns the table doesn't have: {', '.join(unknown)}", field="contract"
        )
    missing_keys = [k for k in key_columns if k not in names]
    if missing_keys:
        raise ServiceError(f"Key columns not in the table: {', '.join(missing_keys)}", field="key_columns")


def _contract_json(contract: Contract) -> dict:
    """Store only the rules that say something, so an untouched column adds nothing."""
    columns = []
    for rule in contract.columns:
        data = rule.model_dump(exclude_none=True)
        if any(v not in (False, None, "", []) for k, v in data.items() if k != "name"):
            columns.append({k: v for k, v in data.items() if v is not False})
    out: dict = {"columns": columns}
    if contract.max_rows:
        out["max_rows"] = contract.max_rows
    return out


async def list_targets(
    session: AsyncSession, viewer: User
) -> list[tuple[UploadTarget, int, User | None, User | None]]:
    """(target, load requests, who asked, who reviewed). Admins see every table and pending
    request; everyone else sees approved tables plus their own pending requests."""
    counts = (
        select(UploadRequest.target_id, func.count().label("n"))
        .where(UploadRequest.target_id.is_not(None))
        .group_by(UploadRequest.target_id)
        .subquery()
    )
    requester, reviewer = aliased(User), aliased(User)
    query = (
        select(UploadTarget, func.coalesce(counts.c.n, 0), requester, reviewer)
        .outerjoin(counts, counts.c.target_id == UploadTarget.id)
        .outerjoin(requester, requester.id == UploadTarget.created_by)
        .outerjoin(reviewer, reviewer.id == UploadTarget.reviewed_by)
        .order_by(UploadTarget.display_name)
    )
    # rejected requests leave the list; the requester still reaches theirs from the link
    query = query.where(UploadTarget.onboarding_status != "rejected")
    if viewer.role != "admin":
        query = query.where(
            or_(UploadTarget.onboarding_status == "approved", UploadTarget.created_by == viewer.id)
        )
    return [tuple(row) for row in await session.execute(query)]


def can_see(target: UploadTarget, viewer: User) -> bool:
    return viewer.role == "admin" or target.onboarding_status == "approved" or target.created_by == viewer.id


def can_edit(target: UploadTarget, viewer: User) -> bool:
    if viewer.role == "admin":
        return True
    return target.created_by == viewer.id and target.onboarding_status == "pending"


async def get_target(session: AsyncSession, target_id: uuid.UUID, viewer: User | None = None) -> UploadTarget:
    target = await session.get(UploadTarget, target_id)
    if target is None or (viewer is not None and not can_see(target, viewer)):
        raise NotFound("Table")
    return target


async def create_target(session: AsyncSession, user: User, body: TargetIn) -> UploadTarget:
    """An admin's onboarding is approved at once; anyone else's waits for an admin."""
    is_admin = user.role == "admin"
    reason = (body.request_reason or "").strip() or None
    if not is_admin and not reason:
        raise ServiceError(
            "Say why this table is needed; the admin reviewing it sees this.", field="request_reason"
        )

    existing = await session.scalar(
        select(UploadTarget).where(
            UploadTarget.target_type == body.target_type,
            UploadTarget.database_name == body.database_name,
            func.coalesce(UploadTarget.schema_name, "") == (body.schema_name or ""),
            UploadTarget.table_name == body.table_name,
            UploadTarget.onboarding_status != "rejected",
        )
    )
    if existing is not None:
        if existing.onboarding_status == "pending":
            raise ServiceError(
                "Someone has already asked for this table; it is waiting for an admin.", status_code=409
            )
        raise ServiceError("That table is already onboarded.", status_code=409)

    columns = await table_schema(body.target_type, body.database_name, body.schema_name, body.table_name)
    _check_against_schema(columns, body.contract, body.key_columns)
    await require_access(
        body.target_type,
        body.database_name,
        body.schema_name,
        body.table_name,
        body.write_modes,
        body.key_columns,
        probe_writes=is_admin,
    )

    now = datetime.now(UTC)
    target = UploadTarget(
        target_type=body.target_type,
        database_name=body.database_name,
        schema_name=body.schema_name,
        table_name=body.table_name,
        display_name=body.display_name.strip(),
        description=(body.description or "").strip() or None,
        write_modes=body.write_modes,
        key_columns=body.key_columns,
        contract=_contract_json(body.contract),
        contract_version=1,
        schema_snapshot=columns,
        is_active=body.is_active,
        onboarding_status="approved" if is_admin else "pending",
        request_reason=reason,
        created_by=user.id,
        updated_by=user.id,
        reviewed_by=user.id if is_admin else None,
        reviewed_at=now if is_admin else None,
    )
    session.add(target)
    await session.flush()
    log.info(
        "%s %s %s %s with %d contract rule(s)",
        user.username,
        "onboarded" if is_admin else "asked to onboard",
        body.target_type,
        target.location,
        len(target.contract["columns"]),
    )
    return target


async def update_target(
    session: AsyncSession, user: User, target_id: uuid.UUID, body: TargetPatch
) -> UploadTarget:
    target = await get_target(session, target_id, user)
    if not can_edit(target, user):
        raise ServiceError("Only an admin can change an onboarded table.", status_code=403)

    write_modes = body.write_modes if body.write_modes is not None else target.write_modes
    key_columns = body.key_columns if body.key_columns is not None else list(target.key_columns or [])
    if "upsert" in write_modes and not key_columns:
        raise ServiceError(
            "Pick the key columns that identify a row, or don't allow upsert", field="key_columns"
        )

    # upsert needs more rights than append: check again when what loads may do changes
    modes_now = list(dict.fromkeys(write_modes))
    loads_changed = modes_now != list(target.write_modes) or key_columns != list(target.key_columns or [])
    if loads_changed and target.onboarding_status != "rejected":
        await require_access(
            target.target_type,
            target.database_name,
            target.schema_name,
            target.table_name,
            modes_now,
            key_columns,
            probe_writes=user.role == "admin",
        )

    if body.contract is not None or body.key_columns is not None:
        # check against the table as it is now, and keep the snapshot current
        columns = await table_schema(
            target.target_type, target.database_name, target.schema_name, target.table_name
        )
        _check_against_schema(columns, body.contract or Contract.model_validate(target.contract), key_columns)
        target.schema_snapshot = columns

    if body.contract is not None:
        new_contract = _contract_json(body.contract)
        if new_contract != target.contract:
            target.contract = new_contract
            # versions count what loads were checked against: nothing loads before approval
            if target.onboarding_status == "approved":
                target.contract_version += 1
                log.info(
                    "%s changed the contract of %s → v%d",
                    user.username,
                    target.location,
                    target.contract_version,
                )

    if body.display_name is not None:
        target.display_name = body.display_name.strip()
    if body.description is not None:
        target.description = body.description.strip() or None
    if body.request_reason is not None and target.onboarding_status == "pending":
        target.request_reason = body.request_reason.strip() or None
    target.write_modes = list(dict.fromkeys(write_modes))
    target.key_columns = key_columns
    if body.is_active is not None:
        target.is_active = body.is_active
    target.updated_by = user.id
    await session.flush()
    return target


async def _pending(session: AsyncSession, target_id: uuid.UUID) -> UploadTarget:
    target = await get_target(session, target_id)
    if target.onboarding_status != "pending":
        raise ServiceError(f"That request is already {target.onboarding_status}.", status_code=409)
    return target


async def approve_target(
    session: AsyncSession, admin: User, target_id: uuid.UUID, note: str | None
) -> UploadTarget:
    """Open a requested table for loads, after checking the table still matches the contract."""
    target = await _pending(session, target_id)
    columns = await table_schema(
        target.target_type, target.database_name, target.schema_name, target.table_name
    )
    _check_against_schema(columns, Contract.model_validate(target.contract), list(target.key_columns or []))
    # the full check, including the one a requester can't run (BigQuery's staging table)
    await require_access(
        target.target_type,
        target.database_name,
        target.schema_name,
        target.table_name,
        list(target.write_modes),
        list(target.key_columns or []),
        probe_writes=True,
    )
    target.schema_snapshot = columns
    target.onboarding_status = "approved"
    target.reviewed_by = admin.id
    target.reviewed_at = datetime.now(UTC)
    target.review_note = (note or "").strip() or None
    await session.flush()
    log.info("%s approved onboarding %s", admin.username, target.location)
    return target


async def reject_target(
    session: AsyncSession, admin: User, target_id: uuid.UUID, note: str | None
) -> UploadTarget:
    target = await _pending(session, target_id)
    target.onboarding_status = "rejected"
    target.reviewed_by = admin.id
    target.reviewed_at = datetime.now(UTC)
    target.review_note = (note or "").strip() or None
    await session.flush()
    log.info("%s rejected onboarding %s", admin.username, target.location)
    return target
