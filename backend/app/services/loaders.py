"""Read a target BigQuery table's live schema, and load an approved file into it.

Every identifier is checked against a strict pattern before it is put into SQL, and every
value is sent as JSON, never concatenated.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import date, datetime

from app.adapters import bigquery
from app.services.validators import category, parse_date, parse_timestamp

log = logging.getLogger("datadesk.loaders")

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def ident(name: str) -> str:
    if not _IDENT_RE.match(name or ""):
        raise ValueError(f"Unsafe identifier: {name!r}")
    return name


def coerce(value, kind: str):
    """Convert a string cell to the Python type BigQuery expects, or None.

    Dates and timestamps are parsed with the validator's own formats, so "05/01/2026" that
    passed validation is loaded as that date and not rejected by BigQuery."""
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
async def target_columns(dataset: str, table: str) -> list[dict]:
    """[{name, type, nullable}] of a BigQuery table, as it is now."""
    return await asyncio.to_thread(bigquery.table_columns, dataset, table)


# ------------------------------------------------------------------ loads
def _prepare(columns: list[str], rows: list[dict], target_cols: list[dict]) -> tuple[list[str], list[dict]]:
    """Keep only the file columns the table has, and type every value for the driver."""
    by_name = {c["name"]: c for c in target_cols}
    use = [ident(c) for c in columns if c in by_name]
    kinds = {c: category(by_name[c]["type"]) for c in use}
    return use, [{c: coerce(r.get(c), kinds[c]) for c in use} for r in rows]


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
    dataset: str, table: str, parsed: dict, mode: str, keys: list[str], target_cols: list[dict]
) -> dict:
    return await load_bigquery(dataset, table, parsed["columns"], parsed["rows"], mode, keys, target_cols)
