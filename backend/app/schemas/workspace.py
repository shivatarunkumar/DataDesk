"""Request/response shapes for the workspace API."""

import uuid
from datetime import date, datetime

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
    """A BigQuery table someone may load into."""

    database: str | None = None  # the BigQuery dataset
    table: str
    label: str
    # set for onboarded targets: the contract a file must pass, and what may be chosen
    target_id: uuid.UUID | None = None
    description: str | None = None
    write_modes: list[str] = ["append", "upsert"]
    key_columns: list[str] = []
    contract: dict | None = None
    contract_version: int | None = None
    columns: list[dict] | None = None


class UploadRequestOut(BaseModel):
    id: uuid.UUID | None = None
    file_id: uuid.UUID
    file_name: str | None = None
    file_version: int | None = None
    target_type: str = "bigquery"
    target_database: str | None = None
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
    # "file", "studio" for edits made in Data Studio ({edited, added, cells, columns, query}),
    # or "pipeline" for a file sent through the Cloud Run file processor (File upload)
    origin: str = "file"
    change_summary: dict | None = None
    # pipeline: the name it lands under, where it landed, and what Cloud Run did with it
    file_date: date | None = None
    landing_name: str | None = None
    landing_uri: str | None = None
    landed_at: datetime | None = None
    pipeline: dict | None = None
    pipeline_checked_at: datetime | None = None


class FileUploadIn(BaseModel):
    """A file to send to BigQuery through Cloud Run (the File upload tab)."""

    file_id: uuid.UUID
    target_id: uuid.UUID
    # the date in the landing name; empty → the one in the file's name, else today
    file_date: date | None = None
    justification: str | None = Field(default=None, max_length=2000)


class FileUploadTarget(BaseModel):
    """A BigQuery table that takes files through Cloud Run, as the File upload form shows it."""

    target_id: uuid.UUID
    dataset: str
    table: str
    label: str
    description: str | None = None
    file_prefix: str
    # "customer_YYYYMMDD.csv or .xlsx"
    expected_name: str
    load_mode: str
    formats: list[str]
    contract: dict
    contract_version: int
    # the columns a file must have, in order
    columns: list[dict]
    published: dict | None = None


class FileUploadConfig(BaseModel):
    enabled: bool
    landing_bucket: str | None = None
    config_bucket: str | None = None
    pickup_minutes: int
    targets: list[FileUploadTarget]


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
