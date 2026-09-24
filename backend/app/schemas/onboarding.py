"""Onboarding a target table and its data contract."""

import re
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

IDENT = r"^[A-Za-z_][A-Za-z0-9_]*$"


class ColumnRule(BaseModel):
    """What the contract says about one column. Empty fields mean "no rule"."""

    name: str = Field(pattern=IDENT, max_length=300)
    description: str | None = Field(default=None, max_length=500)
    required: bool = False
    unique: bool = False
    regex: str | None = Field(default=None, max_length=500)
    enum: list[str] | None = Field(default=None, max_length=500)
    min: float | None = None
    max: float | None = None
    min_length: int | None = Field(default=None, ge=0)
    max_length: int | None = Field(default=None, ge=1)

    @field_validator("regex")
    @classmethod
    def regex_compiles(cls, value: str | None) -> str | None:
        if not value:
            return None
        try:
            re.compile(value)
        except re.error as exc:
            raise ValueError(f"not a valid regular expression: {exc}") from exc
        return value

    @field_validator("enum")
    @classmethod
    def clean_enum(cls, value: list[str] | None) -> list[str] | None:
        cleaned = [v.strip() for v in value or [] if v.strip()]
        return cleaned or None

    @model_validator(mode="after")
    def ranges_make_sense(self) -> "ColumnRule":
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError(f"{self.name}: min is greater than max")
        if self.min_length is not None and self.max_length is not None and self.min_length > self.max_length:
            raise ValueError(f"{self.name}: min length is greater than max length")
        return self


class Contract(BaseModel):
    columns: list[ColumnRule] = Field(default_factory=list)
    # reject a file with more rows than this
    max_rows: int | None = Field(default=None, ge=1)

    @field_validator("columns")
    @classmethod
    def one_rule_per_column(cls, value: list[ColumnRule]) -> list[ColumnRule]:
        names = [rule.name for rule in value]
        repeated = sorted({n for n in names if names.count(n) > 1})
        if repeated:
            raise ValueError(f"each column may appear once; repeated: {', '.join(repeated)}")
        return value


class TargetIn(BaseModel):
    target_type: Literal["bigquery", "postgres", "oracle"]
    database_name: str = Field(pattern=IDENT, max_length=1024)
    schema_name: str | None = Field(default=None, pattern=IDENT, max_length=63)
    table_name: str = Field(pattern=IDENT, max_length=1024)
    display_name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    write_modes: list[Literal["append", "upsert"]] = Field(default_factory=lambda: ["append"], min_length=1)
    key_columns: list[str] = Field(default_factory=list)
    contract: Contract = Field(default_factory=Contract)
    is_active: bool = True
    # why the table is needed; required when someone who isn't an admin asks for it
    request_reason: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def upsert_needs_keys(self) -> "TargetIn":
        self.write_modes = list(dict.fromkeys(self.write_modes))
        if "upsert" in self.write_modes and not self.key_columns:
            raise ValueError("Pick the key columns that identify a row, or don't allow upsert")
        if self.target_type == "bigquery":
            self.schema_name = None
        elif not self.schema_name:
            self.schema_name = "public"
        return self


class TargetPatch(BaseModel):
    """Everything except where the table is; moving a target means onboarding a new one."""

    display_name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    write_modes: list[Literal["append", "upsert"]] | None = Field(default=None, min_length=1)
    key_columns: list[str] | None = None
    contract: Contract | None = None
    is_active: bool | None = None
    request_reason: str | None = Field(default=None, max_length=2000)


class TargetReviewIn(BaseModel):
    review_note: str | None = Field(default=None, max_length=2000)


class TargetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    target_type: str
    database_name: str
    schema_name: str | None
    table_name: str
    location: str
    display_name: str
    description: str | None
    write_modes: list[str]
    key_columns: list
    contract: dict
    contract_version: int
    schema_snapshot: list | None
    is_active: bool
    created_at: datetime
    updated_at: datetime
    onboarding_status: str
    request_reason: str | None = None
    reviewed_at: datetime | None = None
    review_note: str | None = None
    # filled in by the API
    request_count: int = 0
    requested_by_name: str | None = None
    reviewed_by_name: str | None = None
    is_mine: bool = False
    # the viewer may change it: an admin, or the requester while it is pending
    can_edit: bool = False


class SourceTable(BaseModel):
    schema_name: str | None = None
    table: str
    kind: str = "TABLE"
    onboarded_id: uuid.UUID | None = None


class SourceColumn(BaseModel):
    name: str
    type: str
    nullable: bool


class AccessCheckIn(BaseModel):
    database_name: str = Field(pattern=IDENT, max_length=1024)
    schema_name: str | None = Field(default=None, pattern=IDENT, max_length=63)
    table_name: str = Field(pattern=IDENT, max_length=1024)
    write_modes: list[Literal["append", "upsert"]] = Field(default_factory=lambda: ["append"], min_length=1)
    key_columns: list[str] = Field(default_factory=list)


class AccessCheck(BaseModel):
    name: str
    ok: bool
    detail: str
    # what to do about it, when it failed
    hint: str = ""
    # shown, but doesn't fail the check (e.g. identity while ENFORCE_APP_IDENTITY=false)
    warning: bool = False


class AccessReport(BaseModel):
    ok: bool
    checks: list[AccessCheck]
