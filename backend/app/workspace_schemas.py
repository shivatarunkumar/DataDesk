"""Pydantic request/response schemas for the Data Workspace."""
import uuid
from datetime import datetime

from pydantic import BaseModel


class FolderResponse(BaseModel):
    id: uuid.UUID
    parent_id: uuid.UUID | None = None
    name: str
    path: str
    created_at: datetime

    model_config = {"from_attributes": True}


class FolderCreate(BaseModel):
    name: str
    parent_id: uuid.UUID | None = None


class WorkspaceFileResponse(BaseModel):
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

    model_config = {"from_attributes": True}


class FileVersionResponse(BaseModel):
    version: int
    row_count: int | None = None
    size_bytes: int | None = None
    note: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class FileContentResponse(BaseModel):
    columns: list[str]
    rows: list[dict]
    version: int
    inferred_types: dict | None = None
    delimiter: str | None = None  # actual char used for delimited text


class SaveContentRequest(BaseModel):
    columns: list[str]
    rows: list[dict]
    note: str | None = None
    delimiter: str | None = None  # char to write delimited text with


class RenameRequest(BaseModel):
    original_name: str | None = None
    is_permanent: bool | None = None


class TargetColumn(BaseModel):
    name: str
    type: str
    nullable: bool


class TargetTable(BaseModel):
    target_type: str            # postgres | bigquery | oracle
    database: str | None = None  # pg db name / bq dataset
    schema_name: str | None = None
    table: str
    label: str                   # human-friendly display
    enabled: bool = True         # false = "coming soon"


class UploadRequestCreate(BaseModel):
    file_id: uuid.UUID
    target_type: str
    database: str | None = None
    schema_name: str | None = "public"
    table: str
    write_mode: str              # append | upsert
    key_columns: list[str] | None = None
    justification: str | None = None


class UploadRequestResponse(BaseModel):
    id: uuid.UUID | None = None
    file_id: uuid.UUID
    file_name: str | None = None
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
    created_at: datetime | None = None
