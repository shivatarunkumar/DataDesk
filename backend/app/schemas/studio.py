"""Request/response shapes for Data Studio."""

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.workspace import FileOut


class QueryIn(BaseModel):
    target_type: Literal["bigquery", "postgres"]
    # the Postgres database to connect to; for BigQuery, the dataset unqualified names resolve in
    database: str | None = None
    sql: str = Field(min_length=1, max_length=20_000)


class ResultColumn(BaseModel):
    name: str
    type: str | None = None
    key: bool = False


class QueryOut(BaseModel):
    columns: list[ResultColumn]
    rows: list[list[str | None]]
    row_limit: int
    truncated: bool
    elapsed_ms: int
    bytes_processed: int | None = None
    # the onboarded tables the query read
    tables: list[str]
    # "edit": change any cell and add rows; "append": add rows only; None: read-only
    edit_mode: Literal["edit", "append"] | None = None
    edit_reason: str | None = None
    target_id: uuid.UUID | None = None
    target_label: str | None = None
    key_columns: list[str] = []
    max_changes: int


class CellChange(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    # what the query showed, and what it should become
    before: str | None = Field(default=None, alias="from")
    after: str | None = Field(default=None, alias="to")


class RowEdit(BaseModel):
    # the row's values as the query showed them: how it is found in the table
    match: dict[str, str | None] = Field(min_length=1)
    changes: dict[str, CellChange] = Field(min_length=1)


class StudioSubmitIn(BaseModel):
    target_id: uuid.UUID
    sql: str | None = Field(default=None, max_length=20_000)
    columns: list[str] = []
    edits: list[RowEdit] = []
    added: list[dict[str, str | None]] = []
    justification: str | None = Field(default=None, max_length=2000)


class ExportIn(QueryIn):
    # the file name (".csv" is added) and the folder; no folder = the top of My files
    name: str | None = Field(default=None, max_length=200)
    folder_id: uuid.UUID | None = None


class ExportOut(BaseModel):
    file: FileOut
    truncated: bool
