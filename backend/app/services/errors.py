"""The one error type services raise for things the person can act on.

app.main turns it into `{"detail": {"message": ..., "field": ...}}` with its status code,
the same shape FastAPI's validation errors are unpacked into on the frontend.
"""

from __future__ import annotations


class ServiceError(Exception):
    def __init__(self, message: str, *, status_code: int = 400, field: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.field = field


class NotFound(ServiceError):
    def __init__(self, what: str) -> None:
        super().__init__(f"{what} not found.", status_code=404)
