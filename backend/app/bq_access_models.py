"""SQLAlchemy models for BigQuery access management (stored in datamanager DB)."""
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, String, Text, DateTime, Integer, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.auth_models import DMBase


class BqDatasetCache(DMBase):
    __tablename__ = "bq_datasets_cache"

    id: Mapped[str] = mapped_column(String(255), primary_key=True)  # dataset_id
    description: Mapped[str | None] = mapped_column(Text)
    location: Mapped[str | None] = mapped_column(String(100))
    table_count: Mapped[int | None] = mapped_column(Integer)
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class BqTableCache(DMBase):
    __tablename__ = "bq_tables_cache"

    dataset_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    id: Mapped[str] = mapped_column(String(255), primary_key=True)  # table_id
    description: Mapped[str | None] = mapped_column(Text)
    num_rows: Mapped[int | None] = mapped_column(BigInteger)
    num_bytes: Mapped[int | None] = mapped_column(BigInteger)
    created_bq: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    modified_bq: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class BqAccessRequest(DMBase):
    __tablename__ = "bq_access_requests"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    scope_type: Mapped[str] = mapped_column(String(20), nullable=False)   # 'dataset' | 'table'
    dataset_id: Mapped[str | None] = mapped_column(String(255))           # BQ dataset name
    table_id: Mapped[str | None] = mapped_column(String(255))             # BQ table name
    justification: Mapped[str | None] = mapped_column(Text)
    duration_hours: Mapped[int | None] = mapped_column(Integer)   # None = permanent
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")  # pending|approved|rejected
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))        # set on approval
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
