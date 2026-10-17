"""File upload: the contract Cloud Run gets, the names files land under, the checks that
mirror Cloud Run's, and how its job_metadata rows move a request on."""

from datetime import UTC, date, datetime, timedelta

import pytest
import yaml

from app.models.targets import UploadTarget
from app.schemas.onboarding import Contract
from app.services import file_upload, validators

SCHEMA = [
    {"name": "customer_id", "type": "INTEGER", "nullable": False},
    {"name": "email", "type": "STRING", "nullable": True},
    {"name": "phone", "type": "STRING", "nullable": True},
    {"name": "country", "type": "STRING", "nullable": True},
    {"name": "signup_date", "type": "DATE", "nullable": True},
    {"name": "score", "type": "NUMERIC", "nullable": True},
    {"name": "_job_id", "type": "STRING", "nullable": True},
    {"name": "_source_file", "type": "STRING", "nullable": True},
    {"name": "_loaded_at", "type": "TIMESTAMP", "nullable": True},
]

CONTRACT = {
    "columns": [
        {"name": "customer_id", "unique": True},
        {"name": "email", "required": True, "regex": r"^[^@\s]+@[^@\s]+$", "description": "Work email"},
        {"name": "phone", "max_length": 20, "severity": "warning"},
        {"name": "country", "enum": ["UK", "US"]},
        {"name": "signup_date", "format": "%d/%m/%Y"},
        {"name": "score", "min": 0, "max": 100},
    ],
    "min_rows": 2,
    "max_rows": 500,
    "file_upload": {
        "enabled": True,
        "file_prefix": "customer",
        "load_mode": "append",
        "formats": ["csv", "xlsx"],
    },
}


def target(**overrides) -> UploadTarget:
    fields = dict(
        target_type="bigquery",
        database_name="supplementary_data",
        table_name="customer",
        display_name="Customers",
        write_modes=["append"],
        key_columns=[],
        contract=CONTRACT,
        contract_version=4,
        schema_snapshot=SCHEMA,
        is_active=True,
        onboarding_status="approved",
    )
    return UploadTarget(**(fields | overrides))


# ------------------------------------------------------------------ the contract Cloud Run gets
def test_cloud_run_contract_has_every_file_column_in_order_and_the_merged_rules():
    out = file_upload.cloud_run_contract(target())
    assert out["name"] == "customer"
    assert out["version"] == 4
    assert out["target_table"] == "supplementary_data.customer"
    assert out["file_pattern"] == r"^customer_(\d{8})\.(csv|xlsx)$"
    assert out["file_date_group"] == 1
    assert out["load_mode"] == "append"
    assert (out["min_rows"], out["max_rows"]) == (2, 500)
    # Cloud Run's own audit columns are never in the file
    assert [c["name"] for c in out["columns"]] == [
        "customer_id",
        "email",
        "phone",
        "country",
        "signup_date",
        "score",
    ]
    cols = {c["name"]: c for c in out["columns"]}
    assert cols["customer_id"] == {"name": "customer_id", "type": "INT64", "required": True, "unique": True}
    assert cols["email"]["required"] and cols["email"]["description"] == "Work email"
    assert cols["phone"]["severity"] == "WARNING"
    assert cols["country"]["allowed_values"] == ["UK", "US"]
    assert cols["signup_date"] == {"name": "signup_date", "type": "DATE", "format": "%d/%m/%Y"}
    assert (cols["score"]["type"], cols["score"]["min"], cols["score"]["max"]) == ("NUMERIC", 0, 100)


def test_contract_yaml_round_trips_and_says_who_owns_it():
    text = file_upload.contract_yaml(target())
    assert text.startswith("# Published by DataDesk")
    assert yaml.safe_load(text) == file_upload.cloud_run_contract(target())


def test_prefix_defaults_to_the_table_name():
    contract = {**CONTRACT, "file_upload": {"enabled": True, "load_mode": "overwrite", "formats": ["csv"]}}
    out = file_upload.cloud_run_contract(target(contract=contract))
    assert out["file_pattern"] == r"^customer_(\d{8})\.(csv)$"
    assert out["load_mode"] == "overwrite"


@pytest.mark.parametrize(
    "overrides",
    [
        {"is_active": False},
        {"onboarding_status": "pending"},
        {"contract": {**CONTRACT, "file_upload": {**CONTRACT["file_upload"], "enabled": False}}},
    ],
)
def test_only_open_bigquery_tables_with_file_upload_are_published(overrides):
    settings = type("S", (), {"file_upload_enabled": True})()
    assert file_upload.should_publish(settings, target()) is True
    assert file_upload.should_publish(settings, target(**overrides)) is False


def test_cloud_run_yaml_comes_back_as_a_datadesk_contract():
    contract, notes = file_upload.from_cloud_run(
        {
            "file_pattern": r"^customer_(\d{8})\.(csv|xlsx)$",
            "target_table": "supplementary_data.customer",
            "load_mode": "append",
            "file_format": ["csv", "xlsx"],
            "min_rows": 1,
            "unique_key": ["customer_id"],
            "columns": [
                {"name": "customer_id", "type": "INT64", "required": True},
                {"name": "phone", "type": "STRING", "regex": "^[0-9]+$", "severity": "WARNING"},
                {"name": "country", "type": "STRING", "allowed_values": ["UK", "US"]},
            ],
        }
    )
    assert notes == []
    rules = {r.name: r for r in contract.columns}
    assert rules["customer_id"].required and rules["customer_id"].unique
    assert rules["phone"].severity == "warning"
    assert rules["country"].enum == ["UK", "US"]
    assert contract.min_rows is None  # 1 is Cloud Run's default
    assert contract.file_upload.file_prefix == "customer"
    assert contract.file_upload.formats == ["csv", "xlsx"]


def test_a_combined_unique_key_is_reported_not_dropped_silently():
    _, notes = file_upload.from_cloud_run(
        {
            "file_pattern": r"^x_(\d{8})\.csv$",
            "unique_key": ["a", "b"],
            "columns": [{"name": "a"}, {"name": "b"}],
        }
    )
    assert any("a, b" in n for n in notes)


def test_contract_schema_accepts_the_merged_fields():
    contract = Contract.model_validate(CONTRACT)
    assert contract.columns[2].severity == "warning"
    assert contract.file_upload.file_prefix == "customer"
    with pytest.raises(ValueError, match="strptime"):
        Contract.model_validate({"columns": [{"name": "d", "format": "DD/MM/YYYY"}]})
    with pytest.raises(ValueError, match="fewest rows"):
        Contract.model_validate({"columns": [], "min_rows": 10, "max_rows": 5})


# ------------------------------------------------------------------ naming
@pytest.mark.parametrize(
    "original, fmt, chosen, expected, matched",
    [
        ("customer_20261015.csv", "csv", None, "customer_20261015.csv", True),
        ("Customers Oct.csv", "csv", date(2026, 10, 17), "customer_20261017.csv", False),
        ("export-2026-10-15.xlsx", "xlsx", None, "customer_20261015.xlsx", False),
        # the date chosen on the form wins over the one in the name
        ("customer_20261015.csv", "csv", date(2026, 10, 16), "customer_20261016.csv", False),
    ],
)
def test_landing_name(original, fmt, chosen, expected, matched):
    t = target()
    naming = file_upload.name_file(t, file_upload.settings_of(t), original, fmt, chosen)
    assert (naming.landing_name, naming.matched) == (expected, matched)
    assert naming.expected == "customer_YYYYMMDD.csv or .xlsx"


def test_no_date_in_the_name_means_today():
    t = target()
    naming = file_upload.name_file(t, file_upload.settings_of(t), "data.csv", "csv", None)
    assert naming.file_date == datetime.now(UTC).date()


def test_date_in_name_ignores_impossible_dates():
    assert file_upload.date_in_name("run_20261399_20261015.csv") == date(2026, 10, 15)
    assert file_upload.date_in_name("v12.csv") is None


# ------------------------------------------------------------------ checks that mirror Cloud Run
def test_header_must_be_every_column_in_contract_order():
    expected = ["a", "b", "c"]
    assert file_upload.header_problems(["a", "b", "c"], expected) == []
    assert [p["column"] for p in file_upload.header_problems(["a", "c", "x"], expected)] == ["b", "x"]
    order = file_upload.header_problems(["c", "b", "a"], expected)
    assert len(order) == 1 and "wrong order" in order[0]["message"]


COLUMNS = [c for c in SCHEMA if not c["name"].startswith("_")]


def run(rows: list[dict], *, strict: bool = True, min_rows=None):
    parsed = {"columns": [c["name"] for c in COLUMNS], "rows": rows}
    return validators.validate(
        parsed,
        COLUMNS,
        "append",
        None,
        validators.rules_from_contract(CONTRACT),
        min_rows=min_rows,
        strict=strict,
    )


def row(**values):
    base = {
        "customer_id": "1",
        "email": "a@x.io",
        "phone": None,
        "country": "UK",
        "signup_date": None,
        "score": None,
    }
    return base | values


def test_a_warning_is_reported_but_does_not_stop_the_file():
    report = run([row(phone="1" * 25)])
    assert report["passed"]
    assert [w["column"] for w in report["warnings"]] == ["phone"]
    assert "warning" in report["summary"]


def test_strict_dates_are_iso_or_the_column_format():
    assert run([row(signup_date="2026-10-15")])["passed"]
    assert run([row(signup_date="15/10/2026")])["passed"]  # the column's format
    assert run([row(signup_date="2026-10-15 00:00:00")])["passed"]  # an Excel date cell
    failed = run([row(signup_date="10/15/2026")])
    assert not failed["passed"] and failed["errors"][0]["rule"] == "type"


def test_strict_booleans_match_cloud_run():
    cols = [{"name": "flag", "type": "BOOLEAN", "nullable": True}]
    ok = validators.validate(
        {"columns": ["flag"], "rows": [{"flag": "y"}]}, cols, "append", None, strict=True
    )
    loose = validators.validate({"columns": ["flag"], "rows": [{"flag": "y"}]}, cols, "append", None)
    assert ok["passed"] and not loose["passed"]


def test_range_unique_and_min_rows():
    report = run([row(score="101"), row(customer_id="1", score="5")], min_rows=3)
    rules = sorted(e["rule"] for e in report["errors"])
    assert rules == ["min_rows", "rule", "unique"]


# ------------------------------------------------------------------ following Cloud Run
LANDED = datetime(2026, 10, 17, 9, 0, tzinfo=UTC)


def job(status, **fields):
    return {"job_id": "j1", "status": status, "attempt_number": 1, "delivery_attempt": 1} | fields


def summarize(jobs, minutes=1, in_landing=None):
    return file_upload.summarize(jobs, LANDED, LANDED + timedelta(minutes=minutes), 5, 5, in_landing)


def test_waiting_then_not_picked_up():
    assert summarize([])["state"] == "waiting"
    late = summarize([], minutes=7, in_landing=True)
    assert late["state"] == "not_picked_up" and late["status"] == "approved"
    assert "still in the landing bucket" in late["message"]


@pytest.mark.parametrize(
    "jobs, state, status",
    [
        ([job("IN_PROGRESS")], "processing", "approved"),
        ([job("SUCCESS", rows_loaded=20, target_table="p.ds.t")], "succeeded", "completed"),
        ([job("REJECTED", status_reason="Failed checks: email.REGEX (2 rows)")], "rejected", "failed"),
        ([job("FAILED", error_code="TRANSIENT", error_message="503")], "retrying", "approved"),
        ([job("FAILED", error_code="TRANSIENT", delivery_attempt=5)], "failed", "failed"),
        ([job("FAILED", error_code="ValueError", error_message="bad")], "failed", "failed"),
        # the latest attempt decides
        ([job("FAILED", error_code="TRANSIENT"), job("SUCCESS", attempt_number=2)], "succeeded", "completed"),
    ],
)
def test_job_status_moves_the_request(jobs, state, status):
    got = summarize(jobs)
    assert (got["state"], got["status"]) == (state, status)


def test_rejected_says_why():
    got = summarize([job("REJECTED", status_reason="Failed checks: email.REGEX (2 rows)")])
    assert got["error"] == "Cloud Run rejected the file: Failed checks: email.REGEX (2 rows)"
    assert "no contract" in summarize([job("REJECTED", error_code="NO_CONTRACT")])["error"]


def test_failures_come_out_of_the_data_contract_details():
    check = {
        "check_name": "data_contract",
        "severity": "ERROR",
        "details": {
            "file": {"header_match": {"result": "PASS", "evaluated": 1}},
            "columns": {
                "email": {
                    "not_null": {"result": "PASS", "evaluated": 3},
                    "regex": {
                        "result": "FAIL",
                        "severity": "ERROR",
                        "failed": 2,
                        "expected": "^.+@.+$",
                        "samples": [{"row_number": 2, "value": "nope"}],
                    },
                }
            },
        },
    }
    assert file_upload.failures_of(check) == [
        {
            "column": "email",
            "check": "REGEX",
            "severity": "ERROR",
            "failed": 2,
            "evaluated": None,
            "expected": "^.+@.+$",
            "actual": None,
            "error": None,
            "samples": [{"row_number": 2, "value": "nope"}],
        }
    ]


def test_others_do_not_see_sample_values():
    pipeline = {
        "checks": [{"failures": [{"check": "REGEX", "samples": [{"value": "secret"}], "actual": "x"}]}]
    }
    hidden = file_upload.visible_pipeline(pipeline, full=False)
    assert "secret" not in str(hidden)
    assert file_upload.visible_pipeline(pipeline, full=True) == pipeline


def test_a_trailing_separator_on_the_prefix_is_dropped():
    contract = {**CONTRACT, "file_upload": {**CONTRACT["file_upload"], "file_prefix": "customer_"}}
    assert Contract.model_validate(contract).file_upload.file_prefix == "customer"
    # targets saved before the fix still land under the right name
    t = target(contract=contract)
    assert file_upload.cloud_run_contract(t)["file_pattern"] == r"^customer_(\d{8})\.(csv|xlsx)$"
    naming = file_upload.name_file(t, file_upload.settings_of(t), "customer_20261015.csv", "csv", None)
    assert (naming.landing_name, naming.matched) == ("customer_20261015.csv", True)


# ------------------------------------------------------------------ DataDesk's database is the record
import asyncio  # noqa: E402
import uuid  # noqa: E402

from app.models.workspace import UploadRequest  # noqa: E402


class _Settings:
    file_upload_pickup_minutes = 5
    file_upload_max_attempts = 5


def landed_request(**fields) -> UploadRequest:
    base = dict(
        id=uuid.uuid4(),
        origin="pipeline",
        status="approved",
        landing_uri="gs://landing/datadesk/x/customer_20261015.csv",
        landing_generation="111",
        landed_at=datetime.now(UTC) - timedelta(minutes=1),
        pipeline=None,
    )
    return UploadRequest(**(base | fields))


def run_refresh(monkeypatch, requests, jobs):
    calls = []

    def fake_jobs(uris, since):
        calls.append(uris)
        return jobs

    monkeypatch.setattr(file_upload.file_pipeline, "jobs_for", fake_jobs)
    monkeypatch.setattr(file_upload.file_pipeline, "checks_for", lambda ids, since: [])
    monkeypatch.setattr(file_upload.file_pipeline, "landing_object_exists", lambda uri, gen: False)
    asyncio.run(file_upload.refresh(None, _Settings(), requests))
    return calls


def test_a_job_seen_once_is_kept_when_its_row_disappears(monkeypatch):
    seen = {"job_id": "j1", "status": "IN_PROGRESS", "attempt_number": 1, "created_at": "2026-10-17T12:57:13"}
    r = landed_request(pipeline={"state": "processing", "jobs": [seen], "checks": []})
    run_refresh(monkeypatch, [r], jobs=[])  # file_audit was truncated
    assert r.pipeline["state"] == "processing"
    assert [j["job_id"] for j in r.pipeline["jobs"]] == ["j1"]


def test_the_outcome_is_saved_and_finished_requests_are_never_read_again(monkeypatch):
    r = landed_request()
    success = {
        "job_id": "j1",
        "status": "SUCCESS",
        "file_path": r.landing_uri,
        "file_generation": "111",
        "rows_loaded": 20,
        "created_at": "2026-10-17T12:57:13",
    }
    run_refresh(monkeypatch, [r], jobs=[success])
    assert (r.status, r.result["rows_loaded"]) == ("completed", 20)

    calls = run_refresh(monkeypatch, [r], jobs=[])
    assert calls == []  # completed: BigQuery isn't asked again
    assert r.status == "completed" and r.pipeline["state"] == "succeeded"


def test_another_generation_of_the_same_name_is_not_this_request(monkeypatch):
    r = landed_request()
    other = {"job_id": "j9", "status": "SUCCESS", "file_path": r.landing_uri, "file_generation": "999"}
    run_refresh(monkeypatch, [r], jobs=[other])
    assert r.status == "approved" and r.pipeline["jobs"] == []
