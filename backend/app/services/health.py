"""Dependency checks behind GET /api/v1/health.

Required: database and storage (the workspace can't work without them).
Optional: bigquery (only loads into BigQuery need it) → reported as degraded.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable

from sqlalchemy import text

from app.adapters import bigquery
from app.adapters.storage import get_storage
from app.core.config import Settings
from app.core.db import get_engine

log = logging.getLogger("datadesk.health")

CHECK_TIMEOUT_SECONDS = 8
REQUIRED = ("database", "storage")

MIGRATIONS_SQL = text("SELECT max(version), count(*) FROM schema_migrations")


async def check_database(settings: Settings) -> dict:
    async with get_engine().connect() as conn:
        latest = (await conn.execute(MIGRATIONS_SQL)).one()
    return {"ok": latest[1] > 0, "migrations_applied": latest[1], "latest_migration": latest[0]}


async def check_storage(settings: Settings) -> dict:
    storage = get_storage()
    if not storage.configured:
        return {"ok": False, "error": "GCS_BUCKET is not set in .env"}
    exists = await asyncio.to_thread(storage.bucket_exists)
    return {"ok": exists, "bucket": storage.bucket_name, **({} if exists else {"error": "bucket not found"})}


async def check_bigquery(settings: Settings) -> dict:
    if not settings.bq_enabled:
        return {"ok": True, "enabled": False}
    return {"ok": True, **await asyncio.to_thread(bigquery.reachable)}


CHECKS: dict[str, Callable[[Settings], Awaitable[dict]]] = {
    "database": check_database,
    "storage": check_storage,
    "bigquery": check_bigquery,
}


async def _run(name: str, check: Callable[[Settings], Awaitable[dict]], settings: Settings) -> dict:
    """Run one dependency check, timed. The checks run concurrently, so a slow /health is
    only as slow as its slowest dependency — and this says which one that was."""
    started = time.perf_counter()
    try:
        result = await asyncio.wait_for(check(settings), CHECK_TIMEOUT_SECONDS)
    except TimeoutError:
        log.warning("%s check timed out after %ds", name, CHECK_TIMEOUT_SECONDS)
        return {"ok": False, "error": f"timed out after {CHECK_TIMEOUT_SECONDS}s"}
    except Exception as exc:  # report, don't crash the health endpoint
        log.warning("%s check failed: %s: %s", name, type(exc).__name__, exc)
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:300]}
    elapsed = int((time.perf_counter() - started) * 1000)
    log.debug("  check %-8s %-4s %dms", name, "ok" if result.get("ok") else "FAIL", elapsed)
    return result


async def run_checks(settings: Settings) -> tuple[str, dict[str, dict]]:
    names = list(CHECKS)
    results = await asyncio.gather(*(_run(n, CHECKS[n], settings) for n in names))
    checks = dict(zip(names, results, strict=True))
    if not all(checks[n]["ok"] for n in REQUIRED):
        status = "down"
    elif not all(c["ok"] for c in checks.values()):
        status = "degraded"
    else:
        status = "ok"
    return status, checks
