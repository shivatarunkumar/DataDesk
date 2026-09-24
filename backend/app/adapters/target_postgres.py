"""Short-lived connections to the Postgres databases that approved loads write into.

TARGET_DATABASE_URL names the server; the database at the end is swapped per target.
One engine per call keeps it simple: loads are rare and admin-triggered.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings


def target_url(database: str) -> str:
    base = get_settings().target_database_url.rsplit("/", 1)[0]
    return f"{base}/{database}"


@asynccontextmanager
async def target_session(database: str) -> AsyncIterator[AsyncSession]:
    if not database:
        raise ValueError("A target database must be given for Postgres loads.")
    engine = create_async_engine(target_url(database), pool_size=1, max_overflow=0)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            yield session
    finally:
        await engine.dispose()


async def list_databases() -> list[str]:
    """Databases on the target server that the configured login can connect to."""
    default_db = get_settings().target_database_url.rsplit("/", 1)[-1].split("?")[0]
    async with target_session(default_db) as session:
        rows = await session.execute(
            text(
                "SELECT datname FROM pg_database WHERE NOT datistemplate "
                "AND has_database_privilege(datname, 'CONNECT') ORDER BY datname"
            )
        )
        return [r[0] for r in rows]


async def list_tables(database: str) -> list[dict]:
    """Every table in the database, from the catalog. information_schema only lists tables
    the login already has privileges on, and DataDesk's login has none until an admin
    grants them, so it would hide exactly the tables being onboarded."""
    async with target_session(database) as session:
        rows = await session.execute(
            text(
                "SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition "
                "AND n.nspname NOT IN ('pg_catalog', 'information_schema') "
                "AND n.nspname NOT LIKE 'pg_toast%' "
                "ORDER BY 1, 2"
            )
        )
        return [{"schema": r[0], "table": r[1], "kind": "TABLE"} for r in rows]


async def access_checks(
    database: str, schema: str, table: str, modes: list[str], keys: list[str]
) -> list[dict]:
    """What the TARGET_DATABASE_URL login can do with this table. Read-only: it only asks
    Postgres about privileges and indexes."""
    checks: list[dict] = []

    def add(name: str, ok: bool, detail: str, hint: str = "") -> None:
        checks.append({"name": name, "ok": ok, "detail": detail, "hint": hint})

    try:
        async with target_session(database) as session:
            who = await session.scalar(text("SELECT current_user"))
            add("connect", True, f"signed in to {database} as {who}")
            # DataDesk must load with its own, least-privilege login: a superuser (or a
            # person's own login) passes every check below whatever the grants say
            superuser = await session.scalar(
                text("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")
            )
            if not superuser:
                add("identity", True, f"loads run as {who}, which only has the privileges granted to it")
            else:
                detail = f"{who} is a superuser, so these checks prove nothing"
                hint = (
                    "point TARGET_DATABASE_URL at DataDesk's own login (make db-init creates datadesk_loader)"
                )
                if get_settings().enforce_app_identity:
                    add("identity", False, detail, hint)
                else:
                    checks.append(
                        {
                            "name": "identity",
                            "ok": True,
                            "warning": True,
                            "detail": detail + " (not enforced: ENFORCE_APP_IDENTITY=false)",
                            "hint": hint,
                        }
                    )

            if not await session.scalar(text("SELECT has_schema_privilege(:s, 'USAGE')"), {"s": schema}):
                add(
                    "schema",
                    False,
                    f"{who} can't use schema {schema}",
                    f"GRANT USAGE ON SCHEMA {schema} TO {who};",
                )
                return checks
            oid = await session.scalar(
                text("SELECT to_regclass(quote_ident(:s) || '.' || quote_ident(:t))::oid"),
                {"s": schema, "t": table},
            )
            if oid is None:
                add(
                    "table",
                    False,
                    f"{schema}.{table} not found in {database}",
                    "check the schema and table name",
                )
                return checks
            columns = [
                r[0]
                for r in await session.execute(
                    text(
                        "SELECT attname FROM pg_attribute"
                        " WHERE attrelid = :o AND attnum > 0 AND NOT attisdropped"
                    ),
                    {"o": oid},
                )
            ]
            add("table", True, f"{schema}.{table} has {len(columns)} columns")

            needed = ["SELECT", "INSERT"] + (["UPDATE"] if "upsert" in modes else [])
            for privilege in needed:
                ok = await session.scalar(
                    text("SELECT has_table_privilege(CAST(:o AS oid), :p)"), {"o": oid, "p": privilege}
                )
                add(
                    privilege.lower(),
                    bool(ok),
                    f"{who} has {privilege}" if ok else f"{who} lacks {privilege}",
                    "" if ok else f"GRANT {privilege} ON {schema}.{table} TO {who};",
                )

            if "upsert" in modes:
                missing = [k for k in keys if k not in columns]
                if missing or not keys:
                    add("upsert key", False, f"not in the table: {', '.join(missing) or '—'}")
                else:
                    # ON CONFLICT (keys) only works when a unique index covers exactly those columns
                    unique_sets = [
                        set(r[0])
                        for r in await session.execute(
                            text(
                                "SELECT array_agg(a.attname) FROM pg_index i "
                                "JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) "
                                "WHERE i.indrelid = :o AND i.indisunique AND i.indpred IS NULL "
                                "GROUP BY i.indexrelid"
                            ),
                            {"o": oid},
                        )
                    ]
                    ok = set(keys) in unique_sets
                    listed = ", ".join(keys)
                    if ok:
                        add("upsert key", True, f"a unique index covers {listed}")
                    else:
                        add(
                            "upsert key",
                            False,
                            f"no primary key or unique index on exactly ({listed}), so upserts would fail",
                            f"CREATE UNIQUE INDEX ON {schema}.{table} ({listed}); or pick the table's key",
                        )
    except Exception as exc:
        message = str(exc).splitlines()[0][:300]
        if not checks:  # never got in: the URL, the login or the database is wrong
            add(
                "connect", False, message, "check TARGET_DATABASE_URL in .env: the server, login and password"
            )
        else:
            add("check", False, f"stopped with an error: {message}")
    return checks
