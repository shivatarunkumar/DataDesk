"""Data Studio: query onboarded tables with SQL, edit a few rows, and submit the edits.

Nothing here writes to a target table. Queries are read-only: one SELECT, over onboarded
BigQuery tables only, as DataDesk's own identity, with a row limit, a timeout and a cap on
bytes scanned. Submitted edits become a small CSV in the person's "Data Studio"
folder and go through the same schema and contract checks and the same approval as a file;
the load runs when an admin approves it.

Edits are never taken on trust from the grid. The server reads the edited rows again by
key, refuses the submission if a value the person changed is no longer what they saw,
and writes only the key, the changed columns and the columns the table requires.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters import bigquery
from app.core.config import Settings
from app.models.targets import UploadTarget
from app.models.user import User
from app.models.workspace import UploadRequest, WorkspaceFile, WorkspaceFolder
from app.schemas.studio import StudioSubmitIn
from app.schemas.workspace import TargetTable
from app.services import file_parser, loaders, studio_changes, validators, workspace
from app.services.errors import ServiceError
from app.services.studio_changes import display

log = logging.getLogger("datadesk.studio")

STUDIO_FOLDER = "Data Studio"


# display/normalize are shared with the code that writes the edits
normalize = studio_changes.canonical


# ------------------------------------------------------------------ sql
def check_select(sql: str) -> str:
    """The query without a trailing semicolon, if it is one SELECT (or WITH) statement.

    A small scanner skips string literals, quoted identifiers and comments, so a ';' or a
    keyword inside them doesn't count. BigQuery has the last word anyway: its dry run reports
    the statement type."""
    body = (sql or "").strip()
    i, n = 0, len(body)
    first_word = ""
    end = n
    while i < n:
        ch = body[i]
        if ch in ("'", '"', "`"):
            close = body.find(ch, i + 1)
            while close != -1 and ch == "'" and close + 1 < n and body[close + 1] == "'":
                close = body.find(ch, close + 2)  # '' is an escaped quote
            if close == -1:
                raise ServiceError("A quote in the query is never closed.", field="sql")
            i = close + 1
            continue
        if body.startswith("--", i):
            newline = body.find("\n", i)
            i = n if newline == -1 else newline + 1
            continue
        if body.startswith("/*", i):
            close = body.find("*/", i + 2)
            if close == -1:
                raise ServiceError("A /* comment in the query is never closed.", field="sql")
            i = close + 2
            continue
        if ch == ";":
            if body[i + 1 :].strip(" \t\r\n;"):
                raise ServiceError("Run one statement at a time.", field="sql")
            end = i
            break
        if not first_word and (ch.isalpha() or ch == "("):
            j = i
            while j < n and (body[j].isalpha() or body[j] == "_"):
                j += 1
            first_word = body[i:j].lower() if j > i else "("
        i += 1
    if not first_word:
        raise ServiceError("Write a SELECT query to run.", field="sql")
    if first_word not in ("select", "with", "("):
        raise ServiceError(
            "Data Studio only runs SELECT queries. Change data by editing the results and submitting them.",
            field="sql",
        )
    return body[:end].rstrip()


# ------------------------------------------------------------------ tables
def _in_studio(target: UploadTarget) -> bool:
    return target.target_type == "bigquery"


async def open_targets(session: AsyncSession) -> list[UploadTarget]:
    query = select(UploadTarget).where(
        UploadTarget.is_active.is_(True), UploadTarget.onboarding_status == "approved"
    )
    rows = await session.scalars(query.order_by(UploadTarget.database_name, UploadTarget.table_name))
    return [t for t in rows if _in_studio(t)]


async def list_tables(session: AsyncSession) -> list[TargetTable]:
    """Every onboarded table Data Studio can open: approved and open."""
    return [workspace.onboarded_option(t) for t in await open_targets(session)]


async def open_target(session: AsyncSession, target_id: uuid.UUID) -> UploadTarget:
    target = await session.get(UploadTarget, target_id)
    if target is None or not target.is_open or not _in_studio(target):
        raise ServiceError("That table is no longer open in Data Studio.", status_code=404)
    return target


# ------------------------------------------------------------------ queries
@dataclass
class QueryResult:
    columns: list[dict]  # [{name, type}]
    rows: list[list]  # raw values
    truncated: bool
    tables: list[UploadTarget]  # the onboarded tables it read
    elapsed_ms: int
    bytes_processed: int | None = None


async def _column_types(tables: list[UploadTarget]) -> dict[str, str]:
    """Column name → type, from the tables a query read (for the grid's column headers)."""
    types: dict[str, str] = {}
    for t in tables:
        for col in t.schema_snapshot or []:
            types.setdefault(col["name"], col.get("type"))
    return types


async def _query_bigquery(
    settings: Settings, dataset: str | None, sql: str, allowed: list[UploadTarget], limit: int
) -> QueryResult:
    started = time.perf_counter()
    dry = await asyncio.to_thread(bigquery.dry_run, sql, dataset)
    if dry["statement_type"] != "SELECT":
        raise ServiceError(
            f"Data Studio only runs SELECT queries (this is a {dry['statement_type']}).", field="sql"
        )
    by_name = {(t.database_name, t.table_name): t for t in allowed}
    outside = sorted(
        f"{p}.{d}.{t}" for p, d, t in dry["tables"] if p != dry["project"] or (d, t) not in by_name
    )
    if outside:
        raise ServiceError(
            f"Data Studio can only read onboarded tables; this query reads {', '.join(outside)}.",
            status_code=403,
            field="sql",
        )
    if dry["bytes"] > settings.studio_max_bytes_billed:
        raise ServiceError(
            f"This query would scan {dry['bytes'] / 1024**3:.1f} GB; Data Studio allows "
            f"{settings.studio_max_bytes_billed / 1024**3:.1f} GB. Select fewer columns or filter "
            "on the table's partition.",
            field="sql",
        )
    out = await asyncio.to_thread(
        bigquery.run_query,
        sql,
        dataset,
        limit,
        settings.studio_max_bytes_billed,
        settings.studio_query_timeout_seconds,
    )
    return QueryResult(
        columns=out["columns"],
        rows=[list(r) for r in out["rows"]],
        truncated=out["truncated"],
        tables=[by_name[(d, t)] for _, d, t in sorted(set(dry["tables"]))],
        elapsed_ms=int((time.perf_counter() - started) * 1000),
        bytes_processed=out["bytes"],
    )


def _error_text(exc: Exception) -> str:
    message = getattr(exc, "message", None) or str(exc)
    return message.splitlines()[0][:400]


async def run(
    session: AsyncSession, settings: Settings, dataset: str | None, sql: str, limit: int
) -> QueryResult:
    """Run one read-only query against onboarded tables."""
    statement = check_select(sql)
    allowed = await open_targets(session)
    if not allowed:
        raise ServiceError("No tables are onboarded yet.", status_code=404)
    try:
        return await _query_bigquery(settings, dataset, statement, allowed, limit)
    except ServiceError:
        raise
    except bigquery.BigQueryDisabled as exc:
        raise ServiceError(str(exc), status_code=503) from exc
    except Exception as exc:
        message = _error_text(exc)
        log.info("studio query failed (%s): %s", type(exc).__name__, message)
        raise ServiceError(message, field="sql") from exc


async def edit_mode(result: QueryResult) -> tuple[str | None, str | None, UploadTarget | None]:
    """(mode, why not, the table) for a result: "edit" changes any cell and adds rows,
    "append" only adds rows, None means read-only."""
    if len(result.tables) != 1:
        return None, "Results from more than one table are read-only.", None
    target = result.tables[0]
    names = [c["name"] for c in result.columns]
    try:
        live = await loaders.target_columns(target.database_name, target.table_name)
    except Exception as exc:
        return None, f"Could not read {target.display_name}'s columns: {_error_text(exc)}", target
    types = {c["name"]: c["type"] for c in live}
    # the grid shows the table's own types for its columns
    for col in result.columns:
        col["type"] = types.get(col["name"], col.get("type"))
    if len(set(names)) != len(names):
        return None, "Two result columns have the same name.", target
    foreign = [n for n in names if n not in types]
    if foreign:
        return None, f"Computed or renamed columns ({', '.join(foreign)}) are read-only.", target
    if not any(studio_changes.comparable(types[n]) for n in names):
        return None, "None of these columns can identify a row.", target
    if "upsert" in target.write_modes:
        return "edit", None, target
    return "append", f"{target.display_name} accepts new rows only.", target


# ------------------------------------------------------------------ files
async def studio_folder(session: AsyncSession, user: User) -> WorkspaceFolder:
    folder = await session.scalar(
        select(WorkspaceFolder).where(
            WorkspaceFolder.user_id == user.id, WorkspaceFolder.path == STUDIO_FOLDER
        )
    )
    return folder or await workspace.create_folder(session, user.id, STUDIO_FOLDER, None)


def _stamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%d-%H%M%S")


async def save_csv(
    session: AsyncSession, settings: Settings, user: User, stem: str, columns: list[str], rows: list[dict]
) -> WorkspaceFile:
    folder = await studio_folder(session, user)
    safe = "".join(ch if ch.isalnum() or ch in "-_." else "-" for ch in stem).strip("-.") or "query"
    data = file_parser.serialize(columns, rows, "csv")
    return await workspace.upload_file(session, settings, user, f"{safe}-{_stamp()}.csv", data, folder.id)


def export_name(name: str | None, fallback: str) -> str:
    """The file name to save an export as: what the person typed (".csv" added), else a
    dated default. Refuses names a file can't have."""
    wanted = (name or "").strip()
    if not wanted:
        return f"{fallback}-{_stamp()}.csv"
    if "/" in wanted or "\\" in wanted or wanted in (".", ".."):
        raise ServiceError("File names can't contain / or \\.", field="name")
    return wanted if wanted.lower().endswith(".csv") else f"{wanted}.csv"


async def export(
    session: AsyncSession,
    settings: Settings,
    user: User,
    database: str | None,
    sql: str,
    name: str | None,
    folder_id: uuid.UUID | None,
) -> tuple[WorkspaceFile, bool]:
    """The whole result (up to the file row limit) as a CSV in the folder the person chose
    (None = the top of My files), for edits too big for the grid: edit it there and load
    it as any file."""
    await workspace.folder_path(session, folder_id, user.id)  # it must be theirs
    fallback = "query"
    result = await run(session, settings, database, sql, settings.max_rows)
    names = [c["name"] for c in result.columns]
    if len(set(names)) != len(names):
        raise ServiceError("Two result columns have the same name; rename one with AS.", field="sql")
    rows = [dict(zip(names, (display(v) for v in r), strict=True)) for r in result.rows]
    if len(result.tables) == 1:
        fallback = f"{result.tables[0].table_name}-export"
    filename = export_name(name, fallback)
    clash = await session.scalar(
        select(WorkspaceFile.id).where(
            WorkspaceFile.user_id == user.id,
            WorkspaceFile.folder_id.is_(None) if folder_id is None else WorkspaceFile.folder_id == folder_id,
            WorkspaceFile.original_name == filename,
            WorkspaceFile.status == "active",
        )
    )
    if clash:
        raise ServiceError(
            f"A file named {filename} is already in that folder.", status_code=409, field="name"
        )
    data = file_parser.serialize(names, rows, "csv")
    file = await workspace.upload_file(session, settings, user, filename, data, folder_id)
    log.info("studio export %s: %d rows (truncated=%s)", file.original_name, len(rows), result.truncated)
    return file, result.truncated


# ------------------------------------------------------------------ submit
def _label(match: dict, keys: list[str]) -> dict:
    """What a row is called in the review: its key, else its first two values."""
    if keys and all(k in match for k in keys):
        return {k: match[k] for k in keys}
    return dict(list(match.items())[:2])


def _fingerprint(row: dict) -> str:
    return json.dumps(row, sort_keys=True, default=str)


async def submit(
    session: AsyncSession, settings: Settings, user: User, body: StudioSubmitIn
) -> tuple[UploadRequest | None, WorkspaceFile, dict, TargetTable]:
    """Turn grid edits into a load request (or a failed validation report, filing nothing)."""
    target = await open_target(session, body.target_id)
    count = len(body.edits) + len(body.added)
    if count == 0:
        raise ServiceError("There are no changes to submit.")
    if count > settings.studio_max_changes:
        raise ServiceError(
            f"Data Studio submits up to {settings.studio_max_changes} changed rows at a time; this has "
            f"{count}. Export the data to a file and load it from My files instead.",
            status_code=413,
        )
    if body.edits and "upsert" not in target.write_modes:
        raise ServiceError(f"{target.display_name} accepts new rows only.")

    try:
        table_cols = await loaders.target_columns(target.database_name, target.table_name)
    except Exception as exc:
        raise ServiceError(f"Could not read the table's schema: {_error_text(exc)}", status_code=502) from exc
    types = {c["name"]: c["type"] for c in table_cols}
    touched = {c for e in body.edits for c in e.changes} | {c for r in body.added for c in r}
    unknown = sorted(c for c in touched if c not in types)
    if unknown:
        raise ServiceError(f"{', '.join(unknown)} {'is' if len(unknown) == 1 else 'are'} not in the table.")
    filled = {c for e in body.edits for c in e.changes} | {c for r in body.added for c, v in r.items() if v}
    deep = sorted(c for c in filled if studio_changes.nested(types[c]))
    if deep:
        raise ServiceError(f"{', '.join(deep)} holds nested data, which Data Studio can't edit; use a file.")

    keys = list(target.key_columns or [])
    matches = [studio_changes.usable_match(e.match, types) for e in body.edits]
    if any(not m for m in matches):
        raise ServiceError("An edited row has no values to find it by. Run the query again.")

    # the rows as they are now: each edit must still find its row
    found: list[list[dict]] = []
    if matches:
        try:
            found = await studio_changes.find_rows(
                target.database_name,
                target.table_name,
                matches,
                types,
            )
        except Exception as exc:
            raise ServiceError(
                f"Could not re-read the edited rows: {_error_text(exc)}", status_code=502
            ) from exc
    conflicts = []
    owner: dict[str, int] = {}
    for i, rows in enumerate(found):
        label = ", ".join(f"{k} {v}" for k, v in _label(matches[i], keys).items())
        if not rows:
            conflicts.append(f"{label} changed or was removed since you ran the query.")
        for row in rows:
            other = owner.setdefault(_fingerprint(row), i)
            if other != i:
                conflicts.append(f"Two of your edits change the same row in the table ({label}); keep one.")
                break
    if keys and "upsert" in target.write_modes and body.added:
        # a new row whose key already exists would duplicate it
        new_keys = [{k: r.get(k) for k in keys} for r in body.added if all(r.get(k) for k in keys)]
        if new_keys:
            existing = await studio_changes.find_rows(
                target.database_name,
                target.table_name,
                new_keys,
                types,
            )
            for key, hits in zip(new_keys, existing, strict=True):
                if hits:
                    named = ", ".join(f"{k} {v}" for k, v in key.items())
                    conflicts.append(f"A row with {named} already exists; edit it instead.")
    if conflicts:
        shown = " ".join(conflicts[:10]) + (
            f" (and {len(conflicts) - 10} more)" if len(conflicts) > 10 else ""
        )
        raise ServiceError(f"The table doesn't match your edits any more. {shown}", status_code=409)

    # what gets checked (and kept as the record): each edited row as it will be, then the new rows
    columns = [c["name"] for c in table_cols]
    rows = [
        {**hits[0], **{c: ch.after for c, ch in e.changes.items()}}
        for e, hits in zip(body.edits, found, strict=True)
    ]
    rows += [{c: r.get(c) for c in columns} for r in body.added]
    rows = [{c: r.get(c) for c in columns} for r in rows]
    file = await save_csv(session, settings, user, f"{target.table_name}-edits", columns, rows)
    parsed = await asyncio.to_thread(
        file_parser.parse, file_parser.serialize(columns, rows, "csv"), "csv", ",", settings.max_rows
    )
    rules, max_rows = workspace.contract_rules(target.table_name, target)
    report = validators.validate(parsed, table_cols, "append", [], rules, max_rows=max_rows)
    report["contract_version"] = target.contract_version
    report["contract_rules"] = len(rules)
    report["file"] = {"format": "csv", "delimiter": ",", "version": 1}
    summary = {
        "edited": len(body.edits),
        "added": len(body.added),
        "cells": sum(len(e.changes) for e in body.edits),
        # rows the edits will change: more than edited when identical rows share the values
        "matched": sum(len(hits) for hits in found),
        "columns": columns,
        "query": (body.sql or "")[:4000] or None,
        "changes": [
            {
                "label": _label(m, keys),
                "match": m,
                "rows": len(hits),
                "cells": {c: [ch.before, ch.after] for c, ch in e.changes.items()},
            }
            for e, m, hits in zip(body.edits, matches, found, strict=True)
        ],
        "added_rows": [{c: v for c, v in r.items() if v not in (None, "")} for r in body.added],
    }
    report["studio"] = summary
    option = workspace.onboarded_option(target)
    if not report["passed"]:
        # nothing was filed: don't leave a file behind for every failed try
        await workspace.delete_file(session, file)
        return None, file, report, option

    request = UploadRequest(
        user_id=user.id,
        file_id=file.id,
        file_version=file.current_version,
        target_database=target.database_name,
        target_table=target.table_name,
        write_mode="update" if body.edits else "append",
        key_columns=None,
        justification=(body.justification or "").strip() or None,
        validation_status="passed",
        validation_report=report,
        status="pending",
        target_id=target.id,
        contract_version=target.contract_version,
        origin="studio",
        change_summary=summary,
    )
    session.add(request)
    await session.flush()
    log.info(
        "studio request %s → %s: %d edited (%d rows), %d added",
        request.id,
        target.location,
        len(body.edits),
        summary["matched"],
        len(body.added),
    )
    return request, file, report, option
