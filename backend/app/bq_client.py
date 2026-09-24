"""BigQuery client wrapper configured via config/gcp.yaml."""
import os
from pathlib import Path

# config/gcp.yaml lives two levels above backend/app/
_CONFIG_PATH = Path(__file__).parent.parent.parent / "config" / "gcp.yaml"


def _load_config() -> dict:
    try:
        import yaml
    except ImportError:
        return {}
    if not _CONFIG_PATH.exists():
        return {}
    with open(_CONFIG_PATH) as f:
        return yaml.safe_load(f) or {}


def is_configured() -> bool:
    """Return True only if BQ deps are installed and the project ID looks real."""
    try:
        from google.cloud import bigquery  # noqa: F401
    except ImportError:
        return False
    cfg = _load_config().get("gcp", {})
    project = cfg.get("project_id") or os.getenv("GCP_PROJECT_ID", "")
    return bool(project and project != "your-gcp-project-id")


def get_bq_client():
    """Return an authenticated BigQuery client."""
    try:
        from google.cloud import bigquery
    except ImportError:
        raise RuntimeError("google-cloud-bigquery is not installed. Run: pip install google-cloud-bigquery")

    cfg = _load_config().get("gcp", {})
    project_id = cfg.get("project_id") or os.getenv("GCP_PROJECT_ID")
    auth_cfg = cfg.get("auth", {})
    method = auth_cfg.get("method", "application_default")

    if method == "service_account":
        from google.oauth2 import service_account
        key_path = os.path.expandvars(auth_cfg.get("service_account_key_path", ""))
        if key_path and Path(key_path).exists():
            creds = service_account.Credentials.from_service_account_file(key_path)
            return bigquery.Client(project=project_id, credentials=creds)

    return bigquery.Client(project=project_id)


def get_bq_config() -> dict:
    return _load_config().get("gcp", {}).get("bigquery", {})
