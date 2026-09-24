"""File parsing, validation against a target schema, and storage paths: no services needed."""

import io
import json
from datetime import date, datetime

import pytest

from app.adapters.storage import GcsStorage, safe_folder_path
from app.core.config import Settings
from app.services import file_parser, validators
from app.services.loaders import coerce, ident
from app.services.workspace import resolve_delimiter


# ---------------------------------------------------------------- parsing
def test_detect_format():
    assert file_parser.detect_format("Sales.CSV") == "csv"
    assert file_parser.detect_format("export.tsv") == "csv"
    assert file_parser.detect_format("book.xlsx") == "xlsx"
    assert file_parser.detect_format("rows.json") == "json"
    assert file_parser.detect_format("notes.txt") is None


def test_csv_parses_and_infers_types():
    parsed = file_parser.parse(b"id,name,score,active\n1,Ann,9.5,true\n2,,7,false\n", "csv")
    assert parsed["columns"] == ["id", "name", "score", "active"]
    assert parsed["rows"][1]["name"] is None  # empty strings become None
    assert parsed["inferred_types"] == {
        "id": "integer",
        "name": "string",
        "score": "number",
        "active": "boolean",
    }
    assert parsed["delimiter"] == ","


@pytest.mark.parametrize(
    ("text", "delimiter"), [("a\tb\n1\t2\n", "\t"), ("a;b\n1;2\n", ";"), ("a|b\n1|2\n", "|")]
)
def test_delimiter_is_sniffed(text, delimiter):
    parsed = file_parser.parse(text.encode(), "csv")
    assert parsed["delimiter"] == delimiter
    assert parsed["columns"] == ["a", "b"]


def test_json_records_merge_columns_in_order():
    data = json.dumps([{"a": 1}, {"a": 2, "b": "x"}]).encode()
    parsed = file_parser.parse(data, "json")
    assert parsed["columns"] == ["a", "b"]
    assert parsed["rows"][0] == {"a": "1", "b": None}


def test_json_must_be_records():
    with pytest.raises(ValueError, match="array of records"):
        file_parser.parse(b"42", "json")


def test_row_limit_is_enforced():
    with pytest.raises(ValueError, match="row limit"):
        file_parser.parse(b"a\n1\n2\n3\n", "csv", max_rows=2)


def test_xlsx_roundtrip():
    data = file_parser.serialize(["id", "name"], [{"id": "1", "name": "Ann"}], "xlsx")
    parsed = file_parser.parse(data, "xlsx")
    assert parsed["columns"] == ["id", "name"]
    assert parsed["rows"] == [{"id": "1", "name": "Ann"}]


def test_csv_serialize_keeps_the_delimiter():
    data = file_parser.serialize(["a", "b"], [{"a": "1", "b": None}], "csv", delimiter="\t")
    assert io.StringIO(data.decode()).read() == "a\tb\r\n1\t\r\n"


@pytest.mark.parametrize(
    ("value", "expected"),
    [(None, None), ("auto", None), ("tab", "\t"), ("comma", ","), ("pipe", "|"), ("#", "#")],
)
def test_resolve_delimiter(value, expected):
    assert resolve_delimiter(value) == expected


# ---------------------------------------------------------------- validation
TABLE = [
    {"name": "id", "type": "integer", "nullable": False},
    {"name": "name", "type": "text", "nullable": True},
    {"name": "joined", "type": "date", "nullable": True},
]


def grid(columns, *rows):
    return {"columns": columns, "rows": [dict(zip(columns, r, strict=True)) for r in rows]}


def test_valid_file_passes():
    report = validators.validate(grid(["id", "name"], ("1", "Ann"), ("2", None)), TABLE, "append", [])
    assert report["passed"], report


def test_type_and_not_null_errors_are_reported_per_row():
    report = validators.validate(
        grid(["id", "joined"], ("x", "2026-01-01"), (None, "yesterday")), TABLE, "append", []
    )
    rules = {(e["row"], e["rule"]) for e in report["errors"]}
    assert (0, "type") in rules  # "x" is not an integer
    assert (1, "not_null") in rules  # id is NOT NULL
    assert (1, "type") in rules  # "yesterday" is not a date


def test_missing_required_and_unknown_columns():
    report = validators.validate(grid(["name", "extra"], ("Ann", "?")), TABLE, "append", [])
    rules = {e["rule"] for e in report["errors"]}
    assert {"missing_column", "unknown_column"} <= rules


def test_upsert_needs_unique_keys():
    report = validators.validate(grid(["id", "name"], ("1", "a"), ("1", "b")), TABLE, "upsert", ["id"])
    assert any(e["rule"] == "key_unique" for e in report["errors"])
    report = validators.validate(grid(["id"], ("1",)), TABLE, "upsert", [])
    assert any(e["rule"] == "key" for e in report["errors"])


def test_contract_rules():
    rules = {"name": {"name": "name", "regex": "^[A-Z][a-z]+$", "required": True}}
    report = validators.validate(grid(["id", "name"], ("1", "ann"), ("2", None)), TABLE, "append", [], rules)
    assert [e["row"] for e in report["errors"]] == [0, 1]


# ---------------------------------------------------------------- loading helpers
def test_identifiers_are_checked():
    assert ident("customer_id") == "customer_id"
    for bad in ('x"; DROP TABLE users; --', "1abc", "", "a-b"):
        with pytest.raises(ValueError):
            ident(bad)


def test_coerce():
    assert coerce(" 42 ", "integer") == 42
    assert coerce("1.5", "number") == 1.5
    assert coerce("Yes", "boolean") is True
    assert coerce("", "integer") is None
    assert coerce("2026-01-01", "date") == date(2026, 1, 1)
    assert coerce("31/01/2026", "date") == date(2026, 1, 31)
    assert coerce("2026-01-01 09:30", "timestamp") == datetime(2026, 1, 1, 9, 30)
    assert coerce("2026-01-01", "timestamp") == datetime(2026, 1, 1)
    assert coerce("free text", "string") == "free text"
    with pytest.raises(ValueError):
        coerce("yesterday", "date")


# ---------------------------------------------------------------- storage paths
def test_object_paths_are_namespaced_and_sanitised():
    storage = GcsStorage(Settings(_env_file=None, gcs_bucket="b", gcs_workspace_prefix="workspaces"))
    path = storage.object_path("user-1", 3, "Q1 sales (final).csv", "Finance/2026")
    assert path == "workspaces/user-1/Finance/2026/v3_Q1_sales_final_.csv"
    assert storage.folder_marker_path("user-1", "a//b") == "workspaces/user-1/a/b/.keep"
    assert safe_folder_path("../etc/./x") == "etc/x"


@pytest.mark.parametrize(
    ("db_type", "kind"),
    [
        ("integer", "integer"),
        ("bigint", "integer"),
        ("INT64", "integer"),
        ("interval", "string"),
        ("numeric(10,2)", "number"),
        ("double precision", "number"),
        ("character varying(50)", "string"),
        ("timestamp with time zone", "timestamp"),
        ("date", "date"),
        ("boolean", "boolean"),
    ],
)
def test_type_categories(db_type, kind):
    assert validators.category(db_type) == kind
