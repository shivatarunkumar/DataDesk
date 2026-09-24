"""Read a target table's live schema, and load an approved file into it.

Postgres and BigQuery are supported; Oracle is listed as "coming soon". Every identifier
is checked against a strict pattern before it is put into SQL, and every value is bound
as a parameter (Postgres) or sent as JSON (BigQuery), never concatenated.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import date, datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters import bigquery
from app.adapters.target_postgres import target_session
from app.services.validators import category, parse_date, parse_timestamp

log = logging.getLogger("datadesk.loaders")

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class OracleNotSupported(NotImplementedError):
    def __init__(self) -> None:
        super().__init__("Oracle support is coming soon.")


def ident(name: str) -> str:
    if not _IDENT_RE.match(name or ""):
        raise ValueError(f"Unsafe identifier: {name!r}")
    return name


def coerce(value, kind: str):
    """Convert a string cell to the Python type the driver expects, or None.

    Dates and timestamps become date/datetime objects: asyncpg refuses strings for those
    columns. They are parsed with the validator's own formats, so "05/01/2026" that passed
    validation is loaded as that date and not rejected by the database."""
    if value is None:
        return None
    s = str(value).strip()
    if s == "":
        return None
    if kind == "integer":
        return int(s)
    if kind == "number":
        return float(s)
    if kind == "boolean":
        return s.lower() in ("true", "1", "yes", "t")
    if kind == "date":
        parsed = parse_date(s)
        if parsed is None:
            raise ValueError(f"{s!r} is not a date")
        return parsed
    if kind == "timestamp":
        parsed = parse_timestamp(s)
        if parsed is None:
            raise ValueError(f"{s!r} is not a timestamp")
        return parsed
    return s


def _json_safe(value):
    """BigQuery loads JSON: dates and timestamps go as ISO strings."""
    return value.isoformat() if isinstance(value, date | datetime) else value


# ------------------------------------------------------------------ schema
async def pg_table_columns(session: AsyncSession, schema: str, table: str) -> list[dict]:
    """The table's columns from the catalog, readable by any login (information_schema
    shows nothing for tables the login hasn't been granted yet)."""
    rows = await session.execute(
        text(
            """
            SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull
            FROM pg_attribute a
            WHERE a.attrelid = to_regclass(quote_ident(:s) || '.' || quote_ident(:t))
              AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attnum
            """
        ),
        {"s": schema, "t": table},
    )
    columns = [{"name": r[0], "type": r[1], "nullable": r[2]} for r in rows.fetchall()]
    if not columns:
        raise ValueError(f"Table {schema}.{table} not found or has no columns.")
    return columns


async def target_columns(
    target_type: str, database: str | None, schema: str | None, table: str
) -> list[dict]:
    if target_type == "postgres":
        async with target_session(database or "") as session:
            return await pg_table_columns(session, schema or "public", table)
    if target_type == "bigquery":
        return await asyncio.to_thread(bigquery.table_columns, database or "", table)
    if target_type == "oracle":
        raise OracleNotSupported()
    raise ValueError(f"Unknown target type: {target_type}")


# ------------------------------------------------------------------ loads
def _prepare(columns: list[str], rows: list[dict], target_cols: list[dict]) -> tuple[list[str], list[dict]]:
    """Keep only the file columns the table has, and type every value for the driver."""
    by_name = {c["name"]: c for c in target_cols}
    use = [ident(c) for c in columns if c in by_name]
    kinds = {c: category(by_name[c]["type"]) for c in use}
    return use, [{c: coerce(r.get(c), kinds[c]) for c in use} for r in rows]


async def load_postgres(
    database: str,
    schema: str,
    table: str,
    columns: list[str],
    rows: list[dict],
    mode: str,
    keys: list[str],
    target_cols: list[dict],
) -> dict:
    schema, table = ident(schema or "public"), ident(table)
    use, params = _prepare(columns, rows, target_cols)
    col_sql = ", ".join(f'"{c}"' for c in use)
    placeholders = ", ".join(f":{c}" for c in use)

    async with target_session(database) as session:
        if mode == "append":
            await session.execute(
                text(f'INSERT INTO "{schema}"."{table}" ({col_sql}) VALUES ({placeholders})'), params
            )
            await session.commit()
            log.info("postgres append %s.%s.%s: %d rows", database, schema, table, len(params))
            return {"inserted": len(params), "updated": 0}

        keys = [ident(k) for k in keys]
        non_keys = [c for c in use if c not in keys]
        set_sql = (
            ", ".join(f'"{c}" = EXCLUDED."{c}"' for c in non_keys) or f'"{keys[0]}" = EXCLUDED."{keys[0]}"'
        )
        conflict_sql = ", ".join(f'"{k}"' for k in keys)
        statement = text(
            f'INSERT INTO "{schema}"."{table}" ({col_sql}) VALUES ({placeholders}) '
            f"ON CONFLICT ({conflict_sql}) DO UPDATE SET {set_sql} "
            "RETURNING (xmax = 0) AS inserted"
        )
        inserted = updated = 0
        for p in params:
            row = (await session.execute(statement, p)).first()
            if row and row[0]:
                inserted += 1
            else:
                updated += 1
        await session.commit()
        log.info(
            "postgres upsert %s.%s.%s: %d inserted, %d updated", database, schema, table, inserted, updated
        )
        return {"inserted": inserted, "updated": updated}


async def load_bigquery(
    dataset: str,
    table: str,
    columns: list[str],
    rows: list[dict],
    mode: str,
    keys: list[str],
    target_cols: list[dict],
) -> dict:
    ident(table)
    keys = [ident(k) for k in keys]
    use, typed = _prepare(columns, rows, target_cols)
    typed = [{c: _json_safe(v) for c, v in r.items()} for r in typed]
    return await asyncio.to_thread(bigquery.load, dataset, table, typed, use, mode, keys)


async def load(
    target_type: str,
    database: str | None,
    schema: str | None,
    table: str,
    parsed: dict,
    mode: str,
    keys: list[str],
    target_cols: list[dict],
) -> dict:
    if target_type == "postgres":
        return await load_postgres(
            database or "",
            schema or "public",
            table,
            parsed["columns"],
            parsed["rows"],
            mode,
            keys,
            target_cols,
        )
    if target_type == "bigquery":
        return await load_bigquery(
            database or "", table, parsed["columns"], parsed["rows"], mode, keys, target_cols
        )
    raise OracleNotSupported()
