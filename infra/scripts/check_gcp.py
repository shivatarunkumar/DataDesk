"""Check the GCP connection and resources — without starting the API.

    python infra/scripts/check_gcp.py            # or: make check-gcp
    python infra/scripts/check_gcp.py --no-write # skip the upload/delete probe

The API's /health only reports "timed out" when something is wrong. This tells you which
part is wrong: configuration, credentials, the network (proxy/firewall), permissions, or a
missing bucket/dataset. Exits non-zero if any check fails.
"""

from __future__ import annotations

import argparse
import os
import socket
import sys
import warnings
from pathlib import Path

# We report the quota-project mismatch ourselves, once, instead of letting the auth
# library print the same warning before every call.
warnings.filterwarnings("ignore", category=UserWarning, module="google.auth._default")

REPO_ROOT = Path(__file__).resolve().parents[2]

API_TIMEOUT = 10  # seconds per call: fail fast rather than hang like the health check
TCP_TIMEOUT = 5
ENDPOINTS = ("oauth2.googleapis.com", "storage.googleapis.com", "bigquery.googleapis.com")
ADC_PATH = Path.home() / ".config" / "gcloud" / "application_default_credentials.json"
SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]
# set by check_credentials: what the app itself would use (the impersonated service account)
APP_CREDENTIALS = None
PLACEHOLDERS = {"your-gcp-project", "your-workspace-bucket"}


class Report:
    def __init__(self, title: str) -> None:
        print(f"\n[check-gcp] {title}\n")
        self.failed = 0

    def ok(self, name: str, detail: str = "") -> None:
        print(f"  \033[32mok\033[0m    {name:<14} {detail}")

    def warn(self, name: str, detail: str, hint: str = "") -> None:
        print(f"  \033[33mwarn\033[0m  {name:<14} {detail}")
        if hint:
            print(f"        {'':<14} → {hint}")

    def fail(self, name: str, detail: str, hint: str = "") -> None:
        self.failed += 1
        print(f"  \033[31mFAIL\033[0m  {name:<14} {detail}")
        if hint:
            print(f"        {'':<14} → {hint}")

    def finish(self) -> int:
        if self.failed:
            print(f"\n{self.failed} check(s) failed\n")
            return 1
        print("\nall checks passed\n")
        return 0


def load_env() -> None:
    env_file = REPO_ROOT / ".env"
    if not env_file.is_file():
        sys.exit("[check-gcp] ERROR: no .env file. Copy .env.example to .env first.")
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def describe(exc: Exception) -> str:
    return f"{type(exc).__name__}: {exc}".strip().splitlines()[0][:200]


# ----------------------------------------------------------------- checks
def check_config(report: Report) -> tuple[str, str, bool]:
    project = os.environ.get("GCP_PROJECT_ID", "")
    bucket = os.environ.get("GCS_BUCKET", "")
    emulator = bool(os.environ.get("GCS_ENDPOINT_URL"))
    if not project or project in PLACEHOLDERS:
        report.fail("config", "GCP_PROJECT_ID is not set", "set it in .env")
        project = ""
    elif not bucket or bucket in PLACEHOLDERS:
        report.fail("config", "GCS_BUCKET is not set", "set it in .env to the bucket behind the workspace")
    else:
        report.ok("config", f"project={project} bucket={bucket}")
    bq = os.environ.get("BQ_ENABLED", "true").lower() != "false"
    bq_project = os.environ.get("BQ_PROJECT_ID") or project
    report.ok("bigquery", f"project={bq_project}" if bq else "switched off (BQ_ENABLED=false)")
    report.ok(
        "mode", f"emulator — GCS_ENDPOINT_URL={os.environ['GCS_ENDPOINT_URL']}" if emulator else "real GCP"
    )
    return project, bucket if bucket not in PLACEHOLDERS else "", emulator


def check_network(report: Report) -> bool:
    """A corporate laptop usually fails here, and that is what a health-check timeout really means."""
    proxy = {k: v for k, v in os.environ.items() if k.lower() in ("https_proxy", "http_proxy", "no_proxy")}
    if proxy:
        report.warn("proxy", ", ".join(f"{k}={v}" for k, v in proxy.items()), "these apply to API calls too")
    unreachable = []
    for host in ENDPOINTS:
        try:
            with socket.create_connection((host, 443), timeout=TCP_TIMEOUT):
                pass
        except OSError as exc:
            unreachable.append(f"{host} ({exc.__class__.__name__})")
    if unreachable:
        report.fail(
            "network",
            f"cannot reach {', '.join(unreachable)}",
            "you are offline, behind a firewall, or need HTTPS_PROXY set",
        )
        return False
    report.ok("network", f"reached {', '.join(ENDPOINTS)} on 443")
    return True


def check_credentials(report: Report, project: str) -> bool:
    key_file = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "")
    if key_file and not Path(key_file).is_file():
        report.fail("credentials", f"GOOGLE_APPLICATION_CREDENTIALS points at a missing file: {key_file}")
        return False
    if not key_file and not ADC_PATH.is_file():
        report.fail(
            "credentials",
            "no Application Default Credentials on this machine",
            "run: gcloud auth application-default login",
        )
        return False

    import google.auth
    import google.auth.transport.requests

    try:
        credentials, detected = google.auth.default()
        credentials.refresh(google.auth.transport.requests.Request())
    except Exception as exc:
        report.fail("credentials", describe(exc), "run: gcloud auth application-default login")
        return False

    who = getattr(credentials, "service_account_email", None) or getattr(
        credentials, "quota_project_id", None
    )
    report.ok("credentials", f"valid token ({who or 'user account'}) from {key_file or ADC_PATH}")

    # The app runs as its own service account; prove this machine may act as it.
    global APP_CREDENTIALS
    target = os.environ.get("GCP_SERVICE_ACCOUNT", "").strip()
    if target:
        from google.auth import impersonated_credentials

        try:
            app_credentials = impersonated_credentials.Credentials(
                source_credentials=credentials.with_scopes(SCOPES)
                if hasattr(credentials, "with_scopes")
                else credentials,
                target_principal=target,
                target_scopes=SCOPES,
            )
            app_credentials.refresh(google.auth.transport.requests.Request())
        except Exception as exc:
            report.fail(
                "identity",
                f"can't act as {target}: {describe(exc)}",
                f"gcloud iam service-accounts add-iam-policy-binding {target} "
                "--member=user:$(gcloud config get-value account)"
                " --role=roles/iam.serviceAccountTokenCreator",
            )
            return False
        APP_CREDENTIALS = app_credentials
        report.ok("identity", f"DataDesk runs as {target} (impersonated, no key file)")
    elif getattr(credentials, "service_account_email", None):
        report.ok("identity", f"DataDesk runs as {credentials.service_account_email}")
    else:
        report.warn(
            "identity",
            "DataDesk would run as your personal gcloud login",
            "set GCP_SERVICE_ACCOUNT in .env to DataDesk's own service account (see README)",
        )
    if detected and project and detected != project:
        report.warn(
            "quota project",
            f"credentials default to '{detected}', .env says '{project}'",
            f"run: gcloud auth application-default set-quota-project {project}",
        )
    return True


def check_bucket(report: Report, project: str, bucket_name: str, emulator: bool, write: bool) -> None:
    if not bucket_name:
        return

    from google.api_core import exceptions
    from google.auth.credentials import AnonymousCredentials
    from google.cloud import storage

    try:
        if emulator:
            client = storage.Client(
                project=project,
                credentials=AnonymousCredentials(),
                client_options={"api_endpoint": os.environ["GCS_ENDPOINT_URL"]},
            )
        else:
            client = storage.Client(project=project, credentials=APP_CREDENTIALS)
        bucket = client.lookup_bucket(bucket_name, timeout=API_TIMEOUT)
    except exceptions.Forbidden as exc:
        report.fail("bucket", describe(exc), f"the account needs roles/storage.objectAdmin on {bucket_name}")
        return
    except Exception as exc:
        report.fail("bucket", describe(exc), "check the project, the network and your credentials")
        return

    if bucket is None:
        report.fail(
            "bucket",
            f"gs://{bucket_name} does not exist (or is invisible to this account)",
            f"create it (gcloud storage buckets create gs://{bucket_name}), or fix GCS_BUCKET in .env",
        )
        return
    report.ok("bucket", f"gs://{bucket_name} exists ({bucket.location or 'unknown location'})")

    prefix = os.environ.get("GCS_WORKSPACE_PREFIX", "workspaces").strip("/")
    try:
        found = any(
            True
            for _ in client.list_blobs(bucket_name, prefix=f"{prefix}/", max_results=1, timeout=API_TIMEOUT)
        )
        report.ok("read", f"{prefix}/ {'has files' if found else 'is empty'}")
    except exceptions.Forbidden as exc:
        report.fail("read", describe(exc), "the account needs at least roles/storage.objectViewer")
    except Exception as exc:
        report.fail("read", describe(exc))

    if not write:
        report.warn("write", "skipped (--no-write)")
        return
    probe = bucket.blob(f"{prefix}/_checks/connectivity.txt")
    try:
        probe.upload_from_string("datadesk check-gcp", content_type="text/plain", timeout=API_TIMEOUT)
        probe.delete(timeout=API_TIMEOUT)
        report.ok("write", f"uploaded and deleted {probe.name}")
    except exceptions.Forbidden as exc:
        report.fail("write", describe(exc), "uploads will fail: the account needs roles/storage.objectAdmin")
    except Exception as exc:
        report.fail("write", describe(exc))


def check_bigquery(report: Report, project: str) -> None:
    if os.environ.get("BQ_ENABLED", "true").lower() == "false":
        return
    from google.api_core import exceptions
    from google.cloud import bigquery

    bq_project = os.environ.get("BQ_PROJECT_ID") or project
    try:
        client = bigquery.Client(
            project=bq_project, location=os.environ.get("BQ_LOCATION") or None, credentials=APP_CREDENTIALS
        )
        datasets = [d.dataset_id for d in client.list_datasets(max_results=50, timeout=API_TIMEOUT)]
    except exceptions.Forbidden as exc:
        report.fail(
            "datasets", describe(exc), "the account needs roles/bigquery.dataViewer (and jobUser to load)"
        )
        return
    except Exception as exc:
        report.fail("datasets", describe(exc), "check BQ_PROJECT_ID / GCP_PROJECT_ID and your credentials")
        return
    if datasets:
        shown = ", ".join(datasets[:5]) + (" …" if len(datasets) > 5 else "")
        report.ok("datasets", f"{len(datasets)} visible in {bq_project}: {shown}")
    else:
        report.warn("datasets", f"no datasets visible in {bq_project}", "BigQuery targets need at least one")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-write", action="store_true", help="skip the upload/delete probe")
    args = parser.parse_args()

    load_env()
    report = Report("checking configuration, credentials, bucket and BigQuery")
    project, bucket, emulator = check_config(report)
    if not project:
        return report.finish()

    if not emulator:
        if not check_network(report):
            return report.finish()  # every API call would just time out
        if not check_credentials(report, project):
            return report.finish()

    check_bucket(report, project, bucket, emulator, write=not args.no_write)
    check_bigquery(report, project)
    return report.finish()


if __name__ == "__main__":
    sys.exit(main())
