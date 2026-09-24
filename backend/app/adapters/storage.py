"""Workspace file storage in GCS (or an emulator when GCS_ENDPOINT_URL is set).

Blobs are namespaced per user by id, which stays stable even if the username changes:
    {GCS_WORKSPACE_PREFIX}/{user_id}/{folder path}/v{n}_{file name}
Versions of one file sit side by side as v1_…, v2_…. Every call here is blocking; the
services run them in a thread so the event loop stays free.
"""

from __future__ import annotations

import logging
import re
import time
from functools import lru_cache

from google.cloud import storage

from app.adapters import gcp
from app.core.config import Settings, get_settings

log = logging.getLogger("datadesk.storage")


class StorageNotConfigured(RuntimeError):
    """GCS_BUCKET is unset or still the placeholder from .env.example."""


def safe_folder_path(path: str) -> str:
    """Sanitize each segment of a slash path; drop empties, '.' and '..'. '' for the root."""
    if not path:
        return ""
    segments = [re.sub(r"[^A-Za-z0-9._ -]+", "-", s).strip() for s in path.split("/")]
    return "/".join(s for s in segments if s and s not in (".", ".."))


def safe_file_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name or "file")


class GcsStorage:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client: storage.Client | None = None

    # ---------------------------------------------------------------- paths
    def user_root(self, user_id: str) -> str:
        safe = re.sub(r"[^A-Za-z0-9._-]+", "-", str(user_id)).strip("-") or "user"
        return self._settings.workspace_object(safe)

    def object_path(self, user_id: str, version: int, file_name: str, folder_path: str = "") -> str:
        folder = safe_folder_path(folder_path)
        prefix = f"{self.user_root(user_id)}/{folder}" if folder else self.user_root(user_id)
        return f"{prefix}/v{version}_{safe_file_name(file_name)}"

    def folder_marker_path(self, user_id: str, folder_path: str) -> str:
        """Zero-byte marker object so an (even empty) folder shows up in the bucket."""
        return f"{self.user_root(user_id)}/{safe_folder_path(folder_path)}/.keep"

    # ---------------------------------------------------------------- client
    @property
    def configured(self) -> bool:
        return self._settings.storage_configured

    @property
    def bucket_name(self) -> str:
        return self._settings.gcs_bucket

    def _bucket(self) -> storage.Bucket:
        if not self.configured:
            raise StorageNotConfigured(
                "File storage is not configured: set GCS_BUCKET in .env and restart the API"
            )
        if self._client is None:
            if self._settings.gcs_endpoint_url:
                from google.auth.credentials import AnonymousCredentials

                self._client = storage.Client(
                    project=self._settings.gcp_project_id or "datadesk-local",
                    credentials=AnonymousCredentials(),
                    client_options={"api_endpoint": self._settings.gcs_endpoint_url},
                )
            else:
                self._client = storage.Client(
                    project=self._settings.gcp_project_id or None, credentials=gcp.credentials()
                )
        return self._client.bucket(self.bucket_name)

    # ---------------------------------------------------------------- operations
    def bucket_exists(self) -> bool:
        started = time.perf_counter()
        bucket = self._bucket()
        found = bucket.client.lookup_bucket(bucket.name, timeout=5) is not None
        log.debug(
            "  gcs lookup %s: %s in %dms", bucket.name, found, int((time.perf_counter() - started) * 1000)
        )
        return found

    def upload(self, path: str, data: bytes, content_type: str) -> None:
        started = time.perf_counter()
        self._bucket().blob(path).upload_from_string(data, content_type=content_type)
        log.debug(
            "  gcs upload %s (%s, %d bytes) in %dms",
            path,
            content_type,
            len(data),
            int((time.perf_counter() - started) * 1000),
        )

    def download(self, path: str) -> bytes:
        started = time.perf_counter()
        data = self._bucket().blob(path).download_as_bytes()
        log.debug(
            "  gcs download %s (%d bytes) in %dms",
            path,
            len(data),
            int((time.perf_counter() - started) * 1000),
        )
        return data

    def copy(self, source: str, destination: str) -> None:
        """Copy an object inside the bucket; the bytes never leave Google's side."""
        started = time.perf_counter()
        bucket = self._bucket()
        bucket.copy_blob(bucket.blob(source), bucket, destination)
        log.debug(
            "  gcs copy %s → %s in %dms", source, destination, int((time.perf_counter() - started) * 1000)
        )

    def delete(self, path: str) -> None:
        blob = self._bucket().blob(path)
        if blob.exists():
            blob.delete()
            log.debug("  gcs delete %s", path)
        else:
            log.debug("  gcs delete %s: already gone", path)


@lru_cache
def get_storage() -> GcsStorage:
    return GcsStorage(get_settings())
