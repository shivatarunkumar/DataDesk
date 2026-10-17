"""BigQuery upload targets, and who may load into them (V003, V006, V014)."""

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, ForeignKey, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, CreatedAt, UUIDPrimaryKey


# ------------------------------------------------------------------ BigQuery
class BqDatasetCache(Base):
    __tablename__ = "bq_datasets_cache"

    id: Mapped[str] = mapped_column(primary_key=True)  # dataset id
    description: Mapped[str | None]
    location: Mapped[str | None]
    table_count: Mapped[int | None]
    synced_at: Mapped[datetime] = mapped_column(server_default=func.now())


class BqTableCache(Base):
    __tablename__ = "bq_tables_cache"

    dataset_id: Mapped[str] = mapped_column(primary_key=True)
    id: Mapped[str] = mapped_column(primary_key=True)  # table id
    description: Mapped[str | None]
    num_rows: Mapped[int | None] = mapped_column(BigInteger)
    num_bytes: Mapped[int | None] = mapped_column(BigInteger)
    created_bq: Mapped[datetime | None]
    modified_bq: Mapped[datetime | None]
    synced_at: Mapped[datetime] = mapped_column(server_default=func.now())


class BqAccessRequest(UUIDPrimaryKey, CreatedAt, Base):
    __tablename__ = "bq_access_requests"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    scope_type: Mapped[str]  # dataset | table
    dataset_id: Mapped[str | None]
    table_id: Mapped[str | None]
    justification: Mapped[str | None]
    duration_hours: Mapped[int | None]  # None = permanent
    status: Mapped[str] = mapped_column(default="pending")
    expires_at: Mapped[datetime | None]  # set on approval
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    reviewed_at: Mapped[datetime | None]


# ------------------------------------------------------------------ onboarded targets
class UploadTarget(UUIDPrimaryKey, CreatedAt, Base):
    """A table an admin onboarded, with its data contract (V006)."""

    __tablename__ = "upload_targets"

    target_type: Mapped[str] = mapped_column(default="bigquery")  # always bigquery (V014)
    database_name: Mapped[str]  # the BigQuery dataset
    table_name: Mapped[str]
    display_name: Mapped[str]
    description: Mapped[str | None]
    write_modes: Mapped[list[str]] = mapped_column(ARRAY(Text), default=lambda: ["append"])
    key_columns: Mapped[list] = mapped_column(JSONB, default=list)
    contract: Mapped[dict] = mapped_column(JSONB, default=lambda: {"columns": []})
    contract_version: Mapped[int] = mapped_column(default=1)
    schema_snapshot: Mapped[list | None] = mapped_column(JSONB)
    is_active: Mapped[bool] = mapped_column(default=True)
    # pending until an admin approves it (V008); created_by is who asked
    onboarding_status: Mapped[str] = mapped_column(default="approved")
    request_reason: Mapped[str | None]
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    reviewed_at: Mapped[datetime | None]
    review_note: Mapped[str | None]
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now())
    # where the contract was last published for Cloud Run: {uri, version, published_at} (V013)
    contract_published: Mapped[dict | None] = mapped_column(JSONB)

    @property
    def is_open(self) -> bool:
        """Offered in "Load to table": approved, and not paused."""
        return self.onboarding_status == "approved" and self.is_active

    @property
    def location(self) -> str:
        return f"{self.database_name}.{self.table_name}"
