import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.v1.router import api_router
from app.core.config import get_settings
from app.core.db import get_engine
from app.core.logging import configure_logging
from app.core.middleware import RequestLogMiddleware
from app.services.errors import ServiceError

log = logging.getLogger("datadesk.startup")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    log.info(
        "DataDesk API starting: env=%s db=%s bucket=%s bigquery=%s",
        settings.app_env,
        settings.database_url.rsplit("@", 1)[-1],  # host/db only: no password in the log
        settings.gcs_bucket or "-",
        settings.bq_project if settings.bq_enabled else "off",
    )
    yield
    log.info("DataDesk API stopping")
    await get_engine().dispose()


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings)
    app = FastAPI(title="DataDesk API", version="0.2.0", lifespan=lifespan)
    app.add_middleware(RequestLogMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(api_router)

    @app.exception_handler(ServiceError)
    async def service_error(request: Request, exc: ServiceError) -> JSONResponse:
        detail: dict = {"message": exc.message}
        if exc.field:
            detail["field"] = exc.field
        return JSONResponse(status_code=exc.status_code, content={"detail": detail})

    @app.get("/healthz", tags=["health"])
    async def liveness() -> dict:
        """Liveness: the process is up (no dependency checks)."""
        return {"status": "ok"}

    return app


app = create_app()
