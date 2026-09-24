"""Workspace folders, files, versions and load requests (V004, V005).
File bytes live in GCS; only metadata lives in these tables."""

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, ForeignKey, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, CreatedAt, UUIDPrimaryKey


class WorkspaceFolder(UUIDPrimaryKey, CreatedAt, Base):
    __tablename__ = "workspace_folders"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workspace_folders.id", ondelete="CASCADE")
    )
    name: Mapped[str]
    path: Mapped[str]  # full path under the user's root


class WorkspaceFile(UUIDPrimaryKey, CreatedAt, Base):
    __tablename__ = "workspace_files"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    folder_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workspace_folders.id", ondelete="SET NULL")
    )
    original_name: Mapped[str]
    format: Mapped[str]  # csv | xlsx | json
    current_version: Mapped[int] = mapped_column(default=1)
    current_gcs_path: Mapped[str]
    row_count: Mapped[int | None]
    column_meta: Mapped[list | None] = mapped_column(JSONB)  # [{name, inferred_type}]
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    is_permanent: Mapped[bool] = mapped_column(default=False)
    status: Mapped[str] = mapped_column(default="active")  # active | archived
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now())


class WorkspaceFileVersion(UUIDPrimaryKey, CreatedAt, Base):
    __tablename__ = "workspace_file_versions"

    file_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspace_files.id", ondelete="CASCADE"))
    version: Mapped[int]
    gcs_path: Mapped[str]
    row_count: Mapped[int | None]
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    note: Mapped[str | None]
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))


class UploadRequest(UUIDPrimaryKey, CreatedAt, Base):
    __tablename__ = "upload_requests"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    file_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspace_files.id", ondelete="CASCADE"))
    file_version: Mapped[int]
    target_type: Mapped[str]  # postgres | bigquery | oracle
    target_database: Mapped[str | None]
    target_schema: Mapped[str | None]
    target_table: Mapped[str]
    write_mode: Mapped[str]  # append | upsert
    key_columns: Mapped[list | None] = mapped_column(JSONB)
    justification: Mapped[str | None]
    validation_status: Mapped[str | None]  # passed | failed
    validation_report: Mapped[dict | None] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(default="pending")
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    reviewed_at: Mapped[datetime | None]
    review_note: Mapped[str | None]
    executed_at: Mapped[datetime | None]
    result: Mapped[dict | None] = mapped_column(JSONB)
    # the onboarded target, and the version of its data contract the file was checked against
    target_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("upload_targets.id", ondelete="SET NULL"))
    contract_version: Mapped[int | None]
    # "file" (uploaded and edited in My files) or "studio" (edited in Data Studio)
    origin: Mapped[str] = mapped_column(default="file")
    change_summary: Mapped[dict | None] = mapped_column(JSONB)
