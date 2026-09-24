"""Execute an approved upload into a target table (Postgres or BigQuery).

Also exposes live schema introspection used both for validation and loading.
Oracle is stubbed as "coming soon". All identifiers are validated against a
strict pattern before being interpolated, and all values are bound as params /
JSON — never string-concatenated.
"""
import re
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.bq_client import get_bq_client
from app.target_database import _get_db_session
from app.validators import _category

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _ident(name: str) -> str:
    if not _IDENT_RE.match(name or ""):
        raise ValueError(f"Unsafe identifier: {name!r}")
    return name


def _coerce(value, category: str):
    """Convert a string cell to the Python type the driver expects, or None."""
    if value is None:
        return None
    s = str(value).strip()
    if s == "":
        return None
    if category == "integer":
        return int(s)
    if category == "number":
        return float(s)
    if category == "boolean":
        return s.lower() in ("true", "1", "yes", "t")
    return s  # string / date / timestamp handled as text by the driver


# ── Schema introspection ──────────────────────────────────────────────────────

async def pg_table_columns(session: AsyncSession, schema: str, table: str) -> list[dict]:
    rows = await session.execute(
        text(
            """
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_schema = :s AND table_name = :t
            ORDER BY ordinal_position
            """
        ),
        {"s": schema, "t": table},
    )
    cols = [{"name": r[0], "type": r[1], "nullable": r[2] == "YES"} for r in rows.fetchall()]
    if not cols:
        raise ValueError(f"Table {schema}.{table} not found or has no columns.")
    return cols


def bq_table_columns(dataset: str, table: str) -> list[dict]:
    client = get_bq_client()
    tbl = client.get_table(f"{client.project}.{dataset}.{table}")
    return [
        {"name": f.name, "type": f.field_type, "nullable": (f.mode != "REQUIRED")}
        for f in tbl.schema
    ]


async def get_target_columns(
    target_type: str, database: str | None, schema: str | None, table: str
) -> list[dict]:
    if target_type == "postgres":
        session, engine = await _get_db_session(database, None)
        # _get_db_session returns (default_db, None) when database is falsy; we
        # always pass an explicit database for uploads, so engine is set.
        try:
            return await pg_table_columns(session, schema or "public", table)
        finally:
            if engine:
                await session.close()
                await engine.dispose()
    if target_type == "bigquery":
        return bq_table_columns(database, table)
    if target_type == "oracle":
        raise NotImplementedError("Oracle support is coming soon.")
    raise ValueError(f"Unknown target_type: {target_type}")


# ── Loaders ───────────────────────────────────────────────────────────────────

async def load_postgres(
    database: str, schema: str, table: str, columns: list[str], rows: list[dict],
    mode: str, keys: list[str], target_columns: list[dict],
) -> dict:
    schema = _ident(schema or "public")
    table = _ident(table)
    # Only load columns that exist in the target table.
    tgt_by_name = {c["name"]: c for c in target_columns}
    use_cols = [c for c in columns if c in tgt_by_name]
    cat = {c: _category(tgt_by_name[c]["type"]) for c in use_cols}
    for c in use_cols:
        _ident(c)

    session, engine = await _get_db_session(database, None)
    if engine is None:
        raise ValueError("A target database must be specified for Postgres uploads.")
    try:
        col_sql = ", ".join(f'"{c}"' for c in use_cols)
        ph_sql = ", ".join(f":{c}" for c in use_cols)
        params = [{c: _coerce(r.get(c), cat[c]) for c in use_cols} for r in rows]

        if mode == "append":
            await session.execute(
                text(f'INSERT INTO "{schema}"."{table}" ({col_sql}) VALUES ({ph_sql})'),
                params,
            )
            await session.commit()
            return {"inserted": len(params), "updated": 0}

        # upsert
        for k in keys:
            _ident(k)
        non_keys = [c for c in use_cols if c not in keys]
        set_sql = ", ".join(f'"{c}" = EXCLUDED."{c}"' for c in non_keys) or \
            f'"{keys[0]}" = EXCLUDED."{keys[0]}"'
        conflict_sql = ", ".join(f'"{k}"' for k in keys)
        stmt = text(
            f'INSERT INTO "{schema}"."{table}" ({col_sql}) VALUES ({ph_sql}) '
            f'ON CONFLICT ({conflict_sql}) DO UPDATE SET {set_sql} '
            f"RETURNING (xmax = 0) AS inserted"
        )
        inserted = updated = 0
        for p in params:
            res = await session.execute(stmt, p)
            row = res.first()
            if row and row[0]:
                inserted += 1
            else:
                updated += 1
        await session.commit()
        return {"inserted": inserted, "updated": updated}
    finally:
        await session.close()
        await engine.dispose()


def load_bigquery(
    dataset: str, table: str, columns: list[str], rows: list[dict],
    mode: str, keys: list[str], target_columns: list[dict],
) -> dict:
    from google.cloud import bigquery

    client = get_bq_client()
    tgt_by_name = {c["name"]: c for c in target_columns}
    use_cols = [c for c in columns if c in tgt_by_name]
    cat = {c: _category(tgt_by_name[c]["type"]) for c in use_cols}
    typed_rows = [{c: _coerce(r.get(c), cat[c]) for c in use_cols} for r in rows]

    target_ref = f"{client.project}.{dataset}.{table}"
    tbl = client.get_table(target_ref)
    load_schema = [f for f in tbl.schema if f.name in use_cols]

    if mode == "append":
        job = client.load_table_from_json(
            typed_rows, target_ref,
            job_config=bigquery.LoadJobConfig(
                write_disposition=bigquery.WriteDisposition.WRITE_APPEND,
                schema=load_schema,
            ),
        )
        job.result()
        return {"inserted": len(typed_rows), "updated": 0}

    # upsert: load to a staging table, MERGE, then drop staging
    staging = f"_stg_{uuid.uuid4().hex[:12]}"
    staging_ref = f"{client.project}.{dataset}.{staging}"
    for k in keys:
        _ident(k)
    _ident(table)
    try:
        job = client.load_table_from_json(
            typed_rows, staging_ref,
            job_config=bigquery.LoadJobConfig(
                write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
                schema=load_schema,
            ),
        )
        job.result()

        on_clause = " AND ".join(f"T.`{k}` = S.`{k}`" for k in keys)
        non_keys = [c for c in use_cols if c not in keys]
        set_clause = ", ".join(f"T.`{c}` = S.`{c}`" for c in non_keys) or f"T.`{keys[0]}` = S.`{keys[0]}`"
        insert_cols = ", ".join(f"`{c}`" for c in use_cols)
        insert_vals = ", ".join(f"S.`{c}`" for c in use_cols)
        merge_sql = (
            f"MERGE `{target_ref}` T USING `{staging_ref}` S ON {on_clause} "
            f"WHEN MATCHED THEN UPDATE SET {set_clause} "
            f"WHEN NOT MATCHED THEN INSERT ({insert_cols}) VALUES ({insert_vals})"
        )
        merge_job = client.query(merge_sql)
        merge_job.result()
        affected = merge_job.num_dml_affected_rows or 0
        return {"affected": affected, "rows": len(typed_rows)}
    finally:
        client.delete_table(staging_ref, not_found_ok=True)


def load_oracle(*args, **kwargs) -> dict:
    raise NotImplementedError("Oracle support is coming soon.")
