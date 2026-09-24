"""Request/response shapes for the workspace API."""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class FolderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    parent_id: uuid.UUID | None = None
    name: str
    path: str
    created_at: datetime


class FolderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    parent_id: uuid.UUID | None = None


class FileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    folder_id: uuid.UUID | None = None
    original_name: str
    format: str
    current_version: int
    row_count: int | None = None
    column_meta: list | None = None
    size_bytes: int | None = None
    is_permanent: bool
    status: str
    created_at: datetime
    updated_at: datetime


class FileVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    version: int
    row_count: int | None = None
    size_bytes: int | None = None
    note: str | None = None
    created_at: datetime


class FileContentOut(BaseModel):
    columns: list[str]
    rows: list[dict]
    version: int
    inferred_types: dict | None = None
    # the character actually used for delimited text
    delimiter: str | None = None


class SaveContentIn(BaseModel):
    columns: list[str]
    rows: list[dict]
    note: str | None = Field(default=None, max_length=500)
    # the character to write delimited text with
    delimiter: str | None = None


class FilePatch(BaseModel):
    original_name: str | None = Field(default=None, min_length=1, max_length=512)
    is_permanent: bool | None = None


class TargetTable(BaseModel):
    target_type: Literal["postgres", "bigquery", "oracle"]
    database: str | None = None  # Postgres database / BigQuery dataset
    schema_name: str | None = None
    table: str
    label: str
    enabled: bool = True  # false = "coming soon"
    # set for onboarded targets: the contract a file must pass, and what may be chosen
    target_id: uuid.UUID | None = None
    description: str | None = None
    write_modes: list[str] = ["append", "upsert"]
    key_columns: list[str] = []
    contract: dict | None = None
    contract_version: int | None = None
    columns: list[dict] | None = None


class UploadRequestCreate(BaseModel):
    file_id: uuid.UUID
    # an onboarded target; when given, it decides where the file goes and which contract applies
    target_id: uuid.UUID | None = None
    # otherwise a granted table, named directly
    target_type: Literal["postgres", "bigquery", "oracle"] | None = None
    database: str | None = None
    schema_name: str | None = "public"
    table: str | None = None
    write_mode: Literal["append", "upsert"]
    key_columns: list[str] | None = None
    justification: str | None = Field(default=None, max_length=2000)


class UploadRequestOut(BaseModel):
    id: uuid.UUID | None = None
    file_id: uuid.UUID
    file_name: str | None = None
    file_version: int | None = None
    target_type: str
    target_database: str | None = None
    target_schema: str | None = None
    target_table: str
    write_mode: str
    key_columns: list | None = None
    justification: str | None = None
    validation_status: str | None = None
    validation_report: dict | None = None
    status: str
    result: dict | None = None
    review_note: str | None = None
    reviewed_at: datetime | None = None
    created_at: datetime | None = None
    target_id: uuid.UUID | None = None
    target_label: str | None = None
    contract_version: int | None = None
    executed_at: datetime | None = None
    # who asked, and who decided
    user_id: uuid.UUID | None = None
    user_email: str | None = None
    user_name: str | None = None
    reviewed_by_id: uuid.UUID | None = None
    reviewed_by_name: str | None = None
    # the viewer may see the file and every validation error
    is_mine: bool = False
    # "file", or "studio" for edits made in Data Studio: {edited, added, cells, columns, query}
    origin: str = "file"
    change_summary: dict | None = None


class TransferIn(BaseModel):
    """Files and folders to move or copy, and where to (no destination = the top of My files)."""

    file_ids: list[uuid.UUID] = []
    folder_ids: list[uuid.UUID] = []
    destination_id: uuid.UUID | None = None


class TransferOut(BaseModel):
    files: int
    folders: int
    # "old name → new name" for anything renamed because its name was taken
    renamed: list[str] = []
