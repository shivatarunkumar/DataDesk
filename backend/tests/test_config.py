import pytest
from pydantic import ValidationError

from app.core.config import Settings


def make(**overrides) -> Settings:
    return Settings(_env_file=None, **overrides)


def test_local_defaults_are_valid():
    settings = make(gcs_bucket="", gcp_project_id="")
    assert settings.is_local
    assert not settings.storage_configured


def test_placeholder_bucket_counts_as_unconfigured():
    assert not make(gcs_bucket="your-workspace-bucket").storage_configured
    assert make(gcs_bucket="real-bucket").storage_configured


def test_workspace_object_paths():
    settings = make(gcs_workspace_prefix="workspaces/")
    assert settings.workspace_object("u1", "", "v1_a.csv") == "workspaces/u1/v1_a.csv"


def test_bq_project_falls_back_to_gcp_project():
    assert make(gcp_project_id="main", bq_project_id="").bq_project == "main"
    assert make(gcp_project_id="main", bq_project_id="billing").bq_project == "billing"


def test_cors_origins_are_split():
    settings = make(cors_origins="http://a.test, http://b.test,")
    assert settings.cors_origin_list == ["http://a.test", "http://b.test"]


def test_empty_jwt_secret_is_rejected_everywhere():
    for value in ("", "   "):
        with pytest.raises(ValidationError, match="JWT_SECRET is empty"):
            make(app_env="local", jwt_secret=value)


def test_non_local_requires_strong_jwt_secret():
    with pytest.raises(ValidationError, match="JWT_SECRET"):
        make(app_env="prod", jwt_secret="change-me")


def test_non_local_rejects_emulators():
    with pytest.raises(ValidationError, match="emulator"):
        make(app_env="prod", jwt_secret="x" * 40, gcs_endpoint_url="http://gcs:4443")
