"""Data contracts on onboarded targets: what an admin can write, and what it enforces."""

import pytest
from pydantic import ValidationError

from app.schemas.onboarding import ColumnRule, Contract, TargetIn
from app.services import validators
from app.services.errors import ServiceError
from app.services.onboarding import _check_against_schema, _contract_json

TABLE = [
    {"name": "customer_id", "type": "STRING", "nullable": False},
    {"name": "segment", "type": "STRING", "nullable": True},
    {"name": "credit_limit", "type": "NUMERIC", "nullable": True},
    {"name": "email", "type": "STRING", "nullable": True},
]


def grid(columns, *rows):
    return {"columns": columns, "rows": [dict(zip(columns, r, strict=True)) for r in rows]}


def check(contract: dict, parsed: dict, **kwargs):
    rules = validators.rules_from_contract(contract)
    return validators.validate(
        parsed, TABLE, "append", [], rules, max_rows=contract.get("max_rows"), **kwargs
    )


def rules_hit(report) -> set[tuple]:
    return {(e["row"], e["column"], e["rule"]) for e in report["errors"]}


# ---------------------------------------------------------------- enforcement
def test_unique_flags_the_repeat_not_the_first():
    report = check(
        {"columns": [{"name": "customer_id", "unique": True}]},
        grid(["customer_id"], ("C1",), ("C2",), ("C1",)),
    )
    assert rules_hit(report) == {(2, "customer_id", "unique")}
    assert "repeats row 1" in report["errors"][0]["message"]


def test_lengths_regex_enum_and_range():
    contract = {
        "columns": [
            {"name": "customer_id", "regex": "^C[0-9]+$", "max_length": 4},
            {"name": "segment", "enum": ["retail", "business"]},
            {"name": "credit_limit", "min": 0, "max": 1000},
            {"name": "email", "min_length": 5},
        ]
    }
    report = check(
        contract,
        grid(
            ["customer_id", "segment", "credit_limit", "email"],
            ("C1", "retail", "10", "a@b.co"),  # fine
            ("X1", "retail", "10", "a@b.co"),  # regex
            ("C12345", "retail", "10", "a@b.co"),  # too long
            ("C2", "private", "10", "a@b.co"),  # not in enum
            ("C3", "retail", "5000", "a@b"),  # above max, too short
        ),
    )
    assert {(r, c) for r, c, _ in rules_hit(report)} == {
        (1, "customer_id"),
        (2, "customer_id"),
        (3, "segment"),
        (4, "credit_limit"),
        (4, "email"),
    }


def test_required_column_must_be_in_the_file():
    report = check({"columns": [{"name": "email", "required": True}]}, grid(["customer_id"], ("C1",)))
    assert (None, "email", "missing_column") in rules_hit(report)


def test_required_value_must_be_filled():
    report = check(
        {"columns": [{"name": "email", "required": True}]},
        grid(["customer_id", "email"], ("C1", "x@y.io"), ("C2", None)),
    )
    assert rules_hit(report) == {(1, "email", "rule")}


def test_max_rows():
    report = check({"columns": [], "max_rows": 1}, grid(["customer_id"], ("C1",), ("C2",)))
    assert (None, None, "max_rows") in rules_hit(report)


def test_rules_from_contract_skips_columns_without_rules():
    contract = {
        "columns": [{"name": "segment", "description": "just docs"}, {"name": "email", "unique": True}]
    }
    assert set(validators.rules_from_contract(contract)) == {"email"}


# ---------------------------------------------------------------- what an admin can write
def test_bad_regex_is_refused():
    with pytest.raises(ValidationError, match="regular expression"):
        ColumnRule(name="email", regex="([a-z")


def test_ranges_must_make_sense():
    with pytest.raises(ValidationError, match="min is greater than max"):
        ColumnRule(name="credit_limit", min=10, max=1)
    with pytest.raises(ValidationError, match="min length"):
        ColumnRule(name="email", min_length=10, max_length=2)


def test_upsert_needs_keys_and_bigquery_has_no_schema():
    base = {
        "target_type": "bigquery",
        "database_name": "sales",
        "table_name": "customers",
        "display_name": "C",
    }
    with pytest.raises(ValidationError, match="key columns"):
        TargetIn(**base, write_modes=["upsert"])
    target = TargetIn(
        **base, schema_name="public", write_modes=["append", "upsert", "append"], key_columns=["id"]
    )
    assert target.schema_name is None and target.write_modes == ["append", "upsert"]
    assert TargetIn(**{**base, "target_type": "postgres"}).schema_name == "public"


def test_stored_contract_keeps_only_real_rules():
    contract = Contract(
        columns=[ColumnRule(name="segment"), ColumnRule(name="email", unique=True, enum=[" a ", ""])],
        max_rows=100,
    )
    assert _contract_json(contract) == {
        "columns": [{"name": "email", "unique": True, "enum": ["a"]}],
        "max_rows": 100,
    }


def test_contract_must_name_real_columns():
    with pytest.raises(ServiceError, match="doesn't have: nope"):
        _check_against_schema(TABLE, Contract(columns=[ColumnRule(name="nope", required=True)]), [])
    with pytest.raises(ServiceError, match="Key columns"):
        _check_against_schema(TABLE, Contract(), ["id"])


def test_a_column_appears_once():
    with pytest.raises(ValidationError, match="repeated: email"):
        Contract(columns=[ColumnRule(name="email", unique=True), ColumnRule(name="email", max_length=5)])


# ---------------------------------------------------------------- who can see / change an onboarding
def _target(status: str, owner: str):
    from types import SimpleNamespace

    return SimpleNamespace(onboarding_status=status, created_by=owner)


def _user(uid: str, role: str = "user"):
    from types import SimpleNamespace

    return SimpleNamespace(id=uid, role=role)


def test_everyone_sees_approved_tables_only_requester_sees_their_own_request():
    from app.services.onboarding import can_see

    ann, bo, admin = _user("ann"), _user("bo"), _user("raj", "admin")
    for status in ("pending", "rejected"):
        assert can_see(_target(status, "ann"), ann)
        assert not can_see(_target(status, "ann"), bo)
        assert can_see(_target(status, "ann"), admin)
    assert can_see(_target("approved", "ann"), bo)


def test_requester_edits_only_while_pending_admins_always():
    from app.services.onboarding import can_edit

    ann, bo, admin = _user("ann"), _user("bo"), _user("raj", "admin")
    assert can_edit(_target("pending", "ann"), ann)
    assert not can_edit(_target("approved", "ann"), ann)
    assert not can_edit(_target("rejected", "ann"), ann)
    assert not can_edit(_target("pending", "ann"), bo)
    assert can_edit(_target("approved", "ann"), admin)


def test_zero_valued_rules_are_kept():
    report = check(
        {"columns": [{"name": "credit_limit", "min": 0}]},
        grid(["customer_id", "credit_limit"], ("C1", "-1"), ("C2", "0")),
    )
    assert rules_hit(report) == {(0, "credit_limit", "rule")}
