"""The Google credentials every GCP call uses: DataDesk's own service account.

GCP_SERVICE_ACCOUNT set → impersonate it. The machine's Application Default Credentials
(a developer's `gcloud auth application-default login`, or the runtime's attached account on
GCP) only need roles/iam.serviceAccountTokenCreator on it; no key file exists anywhere, and
every BigQuery load and bucket write is done — and audited — as the service account.

GCP_SERVICE_ACCOUNT empty → use Application Default Credentials as they are. Fine on GCP,
where those *are* a service account; locally that means a person's own account, which the
access check reports as a problem.
"""

from __future__ import annotations

import logging
from functools import lru_cache

import google.auth
from google.auth import impersonated_credentials

from app.core.config import get_settings

log = logging.getLogger("datadesk.gcp")

SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]
TOKEN_LIFETIME_SECONDS = 3600


@lru_cache
def credentials():
    source, _ = google.auth.default(scopes=SCOPES)
    target = get_settings().gcp_service_account.strip()
    if not target:
        return source
    log.info("GCP calls run as %s (impersonated)", target)
    return impersonated_credentials.Credentials(
        source_credentials=source,
        target_principal=target,
        target_scopes=SCOPES,
        lifetime=TOKEN_LIFETIME_SECONDS,
    )


def identity() -> tuple[str, bool]:
    """(who GCP calls run as, whether that is a service account)."""
    target = get_settings().gcp_service_account.strip()
    if target:
        return target, True
    source, _ = google.auth.default(scopes=SCOPES)
    email = getattr(source, "service_account_email", None)
    if email and email != "default":
        return email, True
    return "a personal gcloud login (Application Default Credentials)", False
