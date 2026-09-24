"""Data Studio edits, made against the table itself.

An edited row is found by the values it had when it was queried, not by a key, so any
cell can be changed, key columns included. When it is written (at approval) each edit is
an UPDATE … WHERE <those values>: if the row has changed since, nothing matches and the
whole request fails with nothing written, rather than overwriting someone else's change.
Rows that are identical in every queried column can't be told apart, so an edit to one
changes each of them; the request records how many rows each edit matched.

Values travel as text and are cast to each column's type in SQL, the same way on
Postgres (:name) and BigQuery (@name).
"""

from __future__ import annotations

import asyncio
import json
import re
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import text

from app.adapters import bigquery
from app.adapters.target_postgres import target_session
from app.services import loaders
from app.services.errors import ServiceError
from app.services.validators import category

# most rows one search may return: edits are found among these
FIND_LIMIT = 5000

# types a WHERE can't compare with "=": nested, JSON, binary, spatial and array columns
_UNCOMPARABLE = re.compile(
    r"record|struct|json|xml|geography|geometry|bytes|bytea|array|point|line|polygon|box|circle|path|"
    r"tsvector|\[\]",
    re.IGNORECASE,
)
# values a cell can't hold as plain text: nested records and arrays
_NESTED = re.compile(r"^(record|struct|array)\b|\[\]$", re.IGNORECASE)
_BQ_CAST = {"INTEGER": "INT64", "FLOAT": "FLOAT64", "BOOLEAN": "BOOL"}


# ------------------------------------------------------------------ values
def display(value) -> str | None:
    """A database value as the text the grid shows and edits (and a CSV cell holds)."""
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, bytes | bytearray | memoryview):
        return "\\x" + bytes(value).hex()
    if isinstance(value, dict | list):
        return json.dumps(value, ensure_ascii=False, default=str)
    return str(value)


def canonical(value: str | None, db_type: str) -> str | None:
    """Text as the database would show it back ("05" → "5" for an integer, "05/01/2026" →
    "2026-05-01" for a date), so typed values compare and cast cleanly. An empty cell is
    NULL. Text that isn't a valid value stays as it is; validation reports it."""
    if value is None or str(value).strip() == "":
        return None
    kind = category(db_type)
    if kind == "string":
        return str(value)
    try:
        return display(loaders.coerce(value, kind))
    except (ValueError, TypeError):
        return str(value)


def comparable(db_type: str) -> bool:
    return not _UNCOMPARABLE.search(db_type or "")


def nested(db_type: str) -> bool:
    return bool(_NESTED.search(db_type or ""))


# ------------------------------------------------------------------ sql
class _Sql:
    """Quoting, parameters and casts for one target."""

    def __init__(self, target_type: str, database: str, schema: str | None, table: str) -> None:
        self.bq = target_type == "bigquery"
        if self.bq:
            self.ref = bigquery.ref(loaders.ident(database), loaders.ident(table))
        else:
            self.ref = f'"{loaders.ident(schema or "public")}"."{loaders.ident(table)}"'
        self.params: dict[str, str | None] = {}

    def col(self, name: str) -> str:
        return f"`{loaders.ident(name)}`" if self.bq else f'"{loaders.ident(name)}"'

    def value(self, name: str, value: str | None, db_type: str) -> str:
        """A parameter cast to the column's type, or NULL."""
        if value is None:
            return "NULL"
        self.params[name] = value
        if self.bq:
            return f"CAST(@{name} AS {_BQ_CAST.get(db_type.upper(), db_type.upper())})"
        # asyncpg types a parameter from its cast; sent as text, it is cast from text
        return f"CAST(CAST(:{name} AS text) AS {db_type})"

    def where(self, match: dict[str, str | None], types: dict[str, str], prefix: str) -> str:
        parts = []
        for i, (column, value) in enumerate(match.items()):
            if value is None:
                parts.append(f"{self.col(column)} IS NULL")
            else:
                parts.append(f"{self.col(column)} = {self.value(f'{prefix}{i}', value, types[column])}")
        return " AND ".join(parts) or "TRUE"


def usable_match(match: dict[str, str | None], types: dict[str, str]) -> dict[str, str | None]:
    """The columns an edited row can be found by: the table's own, comparable ones."""
    return {c: v for c, v in match.items() if c in types and comparable(types[c])}


# ------------------------------------------------------------------ finding rows
async def find_rows(
    target_type: str,
    database: str,
    schema: str | None,
    table: str,
    matches: list[dict[str, str | None]],
    types: dict[str, str],
) -> list[list[dict]]:
    """For each match, the table's rows that have those values now (every column, as text)."""
    sql = _Sql(target_type, database, schema, table)
    conditions = " OR ".join(f"({sql.where(m, types, f'm{i}_')})" for i, m in enumerate(matches))
    statement = f"SELECT * FROM {sql.ref} WHERE {conditions} LIMIT {FIND_LIMIT}"
    if sql.bq:
        raw = await asyncio.to_thread(bigquery.query, statement, sql.params)
    else:
        async with target_session(database) as session:
            raw = [dict(r._mapping) for r in await session.execute(text(statement), sql.params)]

    found: list[list[dict]] = [[] for _ in matches]
    for r in raw:
        shown = {c: display(v) for c, v in r.items()}
        for i, m in enumerate(matches):
            if all(canonical(shown.get(c), types[c]) == canonical(v, types[c]) for c, v in m.items()):
                found[i].append(shown)
    return found


# ------------------------------------------------------------------ writing
def _label(change: dict) -> str:
    return ", ".join(f"{k} {v}" for k, v in (change.get("label") or {}).items()) or "A row"


async def apply(
    target_type: str,
    database: str,
    schema: str | None,
    table: str,
    summary: dict,
    types: dict[str, str],
) -> dict:
    """Write a Studio request: every edit as an UPDATE on the row's original values, every
    new row as an INSERT, all in one transaction. If an edited row no longer matches, it
    all rolls back and the reason says which row."""
    changes = summary.get("changes") or []
    added = summary.get("added_rows") or []
    sql = _Sql(target_type, database, schema, table)
    updates: list[tuple[str, str]] = []
    for i, change in enumerate(changes):
        sets = ", ".join(
            f"{sql.col(c)} = {sql.value(f's{i}_{j}', canonical(after, types[c]), types[c])}"
            for j, (c, (_before, after)) in enumerate(change["cells"].items())
        )
        where = sql.where(change["match"], types, f"w{i}_")
        updates.append((f"UPDATE {sql.ref} SET {sets} WHERE {where}", _label(change)))
    inserts = []
    for i, row in enumerate(added):
        columns = [c for c in row if c in types]
        values = ", ".join(
            sql.value(f"a{i}_{j}", canonical(row[c], types[c]), types[c]) for j, c in enumerate(columns)
        )
        inserts.append(f"INSERT INTO {sql.ref} ({', '.join(sql.col(c) for c in columns)}) VALUES ({values})")
    stale = (
        "{label} changed or was removed after it was edited, so nothing was written. "
        "Run the query again and redo the edit."
    )

    if sql.bq:
        # one script, one transaction: an edit that matches nothing raises, which rolls it all back
        lines = ["DECLARE updated INT64 DEFAULT 0;", "BEGIN TRANSACTION;"]
        for i, (statement, label) in enumerate(updates):
            sql.params[f"stale{i}"] = stale.format(label=label)
            lines += [
                f"{statement};",
                f"IF @@row_count = 0 THEN RAISE USING MESSAGE = @stale{i}; END IF;",
                "SET updated = updated + @@row_count;",
            ]
        lines += [f"{statement};" for statement in inserts]
        lines += ["COMMIT TRANSACTION;", "SELECT updated;"]
        try:
            rows = await asyncio.to_thread(bigquery.query, "\n".join(lines), sql.params, 600)
        except Exception as exc:
            message = getattr(exc, "message", None) or str(exc)
            # "GET https://bigquery…/queries/…: <reason> at [3:1]" → the reason
            if message.startswith(("GET ", "POST ")) and ": " in message:
                message = message.split(": ", 1)[1]
            raise ServiceError(message.split(" at [")[0]) from exc
        return {"updated": int(rows[0]["updated"]) if rows else 0, "inserted": len(inserts)}

    updated = 0
    async with target_session(database) as session:
        for statement, label in updates:
            result = await session.execute(text(statement), sql.params)
            if result.rowcount == 0:
                raise ServiceError(stale.format(label=label))  # the session closes without committing
            updated += result.rowcount
        for statement in inserts:
            await session.execute(text(statement), sql.params)
        await session.commit()
    return {"updated": updated, "inserted": len(inserts)}
