"""All DataDesk settings in one place.

Values come from environment variables (the Make targets load them from the repo-root
.env; see .env.example for every key with comments). Nothing else in the codebase reads
os.environ or hardcodes GCP names, hosts or buckets.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

INSECURE_JWT_SECRET = "change-me"
PLACEHOLDER_BUCKETS = {"", "your-workspace-bucket", "REPLACE_WITH_YOUR_BUCKET"}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", populate_by_name=True)

    # --- app ---
    app_env: Literal["local", "dev", "stage", "prod"] = "local"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    log_format: Literal["text", "json"] = "text"
    sql_echo: bool = False  # every statement SQLAlchemy runs; enormous, so opt in
    api_base_url: str = "http://localhost:8001"
    web_base_url: str = "http://localhost:3001"
    cors_origins: str = "http://localhost:3001"

    # --- database (metadata) ---
    database_url: str = "postgresql+asyncpg://datadesk:datadesk@localhost:5432/datadesk"
    db_pool_size: int = 5

    # --- auth ---
    jwt_secret: str = INSECURE_JWT_SECRET
    access_token_ttl_min: int = 720

    # --- gcp ---
    gcp_project_id: str = ""
    gcp_region: str = "us-central1"
    # DataDesk's own service account; every GCP call impersonates it (adapters/gcp.py)
    gcp_service_account: str = ""
    # true → a personal gcloud login FAILS the access check (and so
    # blocks onboarding); false → it is shown as a warning only
    enforce_app_identity: bool = False

    # --- storage (GCS) ---
    gcs_bucket: str = ""
    gcs_workspace_prefix: str = "workspaces"
    gcs_endpoint_url: str = ""  # set → an emulator; empty → real GCS

    # --- bigquery ---
    bq_enabled: bool = True
    bq_project_id: str = ""  # empty → gcp_project_id
    bq_location: str = ""  # empty → each job runs where its dataset lives

    # --- file upload (the Cloud Run file processor: GCS landing → Cloud Run → BigQuery) ---
    # empty → the File upload tab is off and no contracts are published
    file_upload_landing_bucket: str = ""
    # where Cloud Run reads data contracts from; DataDesk publishes one YAML per table there
    file_upload_config_bucket: str = ""
    file_upload_contracts_prefix: str = "contracts/"
    # folder in the landing bucket: {prefix}/{request id}/{landing name}
    file_upload_landing_prefix: str = "datadesk"
    # BigQuery dataset (in bq_project) holding job_metadata and validation_metadata
    file_upload_audit_dataset: str = "file_audit"
    # no Cloud Run job this long after landing → the request says it wasn't picked up
    file_upload_pickup_minutes: int = 5
    # Pub/Sub delivery attempts before the message goes to the dead-letter topic
    file_upload_max_attempts: int = 5
    # how often the API reads Cloud Run's progress for requests still with it; 0 → only on view
    file_upload_poll_seconds: int = 15

    # --- data studio ---
    studio_row_limit: int = 1000  # rows shown (and editable) per query
    studio_max_changes: int = 500  # rows one Studio submission may change; bigger → export a file
    studio_query_timeout_seconds: int = 30
    studio_max_bytes_billed: int = 1024**3  # BigQuery: refuse queries that would scan more (1 GB)

    # --- limits ---
    max_upload_bytes: int = 50 * 1024 * 1024
    max_rows: int = 100_000

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_local(self) -> bool:
        return self.app_env == "local"

    @property
    def storage_configured(self) -> bool:
        return self.gcs_bucket.strip() not in PLACEHOLDER_BUCKETS

    @property
    def file_upload_enabled(self) -> bool:
        return bool(self.file_upload_landing_bucket.strip() and self.file_upload_config_bucket.strip())

    @property
    def bq_project(self) -> str:
        return self.bq_project_id or self.gcp_project_id

    def workspace_object(self, *parts: str) -> str:
        """workspaces/{user_id}/{folder path}/v{n}_{name}"""
        return "/".join([self.gcs_workspace_prefix.strip("/"), *(p for p in parts if p)])

    @model_validator(mode="after")
    def _check_secrets_and_env(self) -> Settings:
        # An empty JWT_SECRET only shows up at the first login, as PyJWT's
        # "HMAC key must not be empty". Refuse to start instead.
        if not self.jwt_secret.strip():
            raise ValueError(
                "JWT_SECRET is empty, so access tokens cannot be signed. Set it in .env, "
                "e.g. JWT_SECRET=$(openssl rand -hex 32)"
            )
        if self.app_env != "local":
            if self.jwt_secret == INSECURE_JWT_SECRET or len(self.jwt_secret) < 32:
                raise ValueError("JWT_SECRET must be a random value of at least 32 characters outside local")
            if self.gcs_endpoint_url:
                raise ValueError("emulator endpoints must not be set outside local")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
