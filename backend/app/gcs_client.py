"""Google Cloud Storage wrapper for the Data Workspace.

Authentication and project come from config/gcp.yaml (same file the BigQuery
client reads), using Application Default Credentials. Blobs are namespaced per
user: workspaces/{safe_username}/{file_id}/v{n}_{original_name}.
"""
import os
import re
from pathlib import Path

_CONFIG_PATH = Path(__file__).parent.parent.parent / "config" / "gcp.yaml"
_PLACEHOLDER_BUCKET = "REPLACE_WITH_YOUR_BUCKET"


def _load_config() -> dict:
    try:
        import yaml
    except ImportError:
        return {}
    if not _CONFIG_PATH.exists():
        return {}
    with open(_CONFIG_PATH) as f:
        return yaml.safe_load(f) or {}


def _storage_cfg() -> dict:
    return _load_config().get("gcp", {}).get("storage", {})


def get_bucket_name() -> str:
    return _storage_cfg().get("default_bucket", "")


def is_configured() -> bool:
    """True only if the storage lib is present, storage is enabled, and a real bucket is set."""
    try:
        from google.cloud import storage  # noqa: F401
    except ImportError:
        return False
    cfg = _storage_cfg()
    bucket = get_bucket_name()
    return bool(cfg.get("enabled") and bucket and bucket != _PLACEHOLDER_BUCKET)


def _require_configured():
    if not is_configured():
        raise RuntimeError(
            "GCS is not configured. Set gcp.storage.enabled=true and a real "
            "default_bucket in config/gcp.yaml, and ensure google-cloud-storage is installed."
        )


def _get_client():
    from google.cloud import storage

    cfg = _load_config().get("gcp", {})
    project_id = cfg.get("project_id") or os.getenv("GCP_PROJECT_ID")
    auth_cfg = cfg.get("auth", {})
    if auth_cfg.get("method") == "service_account":
        from google.oauth2 import service_account

        key_path = os.path.expandvars(auth_cfg.get("service_account_key_path", ""))
        if key_path and Path(key_path).exists():
            creds = service_account.Credentials.from_service_account_file(key_path)
            return storage.Client(project=project_id, credentials=creds)
    return storage.Client(project=project_id)


def _bucket():
    return _get_client().bucket(get_bucket_name())


def safe_username(username: str) -> str:
    """Lowercase, keep [a-z0-9_-], collapse everything else to '-'."""
    slug = re.sub(r"[^a-z0-9_-]+", "-", (username or "user").lower()).strip("-")
    return slug or "user"


def safe_folder_path(path: str) -> str:
    """Sanitize each segment of a slash path; drop empties. '' for root."""
    if not path:
        return ""
    segs = [re.sub(r"[^A-Za-z0-9._ -]+", "-", s).strip() for s in path.split("/")]
    return "/".join(s for s in segs if s)


def user_root(root: str) -> str:
    """Per-user namespace. `root` is the user's unique id (kept stable even if
    the username changes)."""
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", str(root)).strip("-") or "user"
    return f"workspaces/{safe}"


def object_path(root: str, version: int, original_name: str, folder_path: str = "") -> str:
    """Blob path: workspaces/{root}/{folder}/v{n}_{name} — file lives directly in
    its folder (no per-file subfolder). Versions coexist as v1_…, v2_…"""
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", original_name or "file")
    fp = safe_folder_path(folder_path)
    prefix = f"{user_root(root)}/{fp}" if fp else user_root(root)
    return f"{prefix}/v{version}_{safe_name}"


def folder_placeholder_path(root: str, folder_path: str) -> str:
    """Zero-byte marker object so an (even empty) folder exists in GCS."""
    fp = safe_folder_path(folder_path)
    return f"{user_root(root)}/{fp}/.keep"


def create_folder(root: str, folder_path: str) -> str:
    path = folder_placeholder_path(root, folder_path)
    upload_bytes(path, b"", "application/x-directory")
    return path


def upload_bytes(path: str, data: bytes, content_type: str = "application/octet-stream") -> str:
    _require_configured()
    blob = _bucket().blob(path)
    blob.upload_from_string(data, content_type=content_type)
    return path


def download_bytes(path: str) -> bytes:
    _require_configured()
    blob = _bucket().blob(path)
    return blob.download_as_bytes()


def delete(path: str) -> None:
    _require_configured()
    blob = _bucket().blob(path)
    if blob.exists():
        blob.delete()


def list_prefix(prefix: str) -> list[str]:
    _require_configured()
    return [b.name for b in _get_client().list_blobs(get_bucket_name(), prefix=prefix)]
