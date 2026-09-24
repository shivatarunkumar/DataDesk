"""Data Studio: what a query may be, what the grid shows, and when results are editable."""

from datetime import date, datetime
from decimal import Decimal
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError

from app.models.targets import UploadTarget
from app.schemas.studio import StudioSubmitIn
from app.services import studio, studio_changes
from app.services.errors import ServiceError


# ---------------------------------------------------------------- the SQL guard
@pytest.mark.parametrize(
    "sql",
    [
        "SELECT * FROM orders",
        "  select id from orders;  ",
        "WITH x AS (SELECT 1) SELECT * FROM x",
        "(SELECT 1)",
        "-- the latest\nSELECT * FROM orders",
        "/* note; not a statement */ SELECT 1",
        "SELECT 'a;b', \"odd;name\" FROM t",
        "SELECT 'it''s; fine'",
        "SELECT * FROM `proj.ds.t`",
    ],
)
def test_one_select_is_allowed(sql):
    assert studio.check_select(sql) == sql.strip().rstrip(";").rstrip()


def test_trailing_semicolon_is_dropped():
    assert studio.check_select("SELECT 1;;  ") == "SELECT 1"


@pytest.mark.parametrize(
    "sql, message",
    [
        ("DELETE FROM orders", "only runs SELECT"),
        ("UPDATE orders SET qty = 1", "only runs SELECT"),
        ("-- SELECT\nDROP TABLE orders", "only runs SELECT"),
        ("SELECT 1; DROP TABLE orders", "one statement"),
        ("SELECT 1; SELECT 2", "one statement"),
        ("SELECT 'open", "never closed"),
        ("SELECT 1 /* open", "never closed"),
        ("   ", "Write a SELECT"),
    ],
)
def test_anything_else_is_refused(sql, message):
    with pytest.raises(ServiceError, match=message):
        studio.check_select(sql)


def test_plan_relations_walk_the_whole_plan():
    plan = [
        {
            "Plan": {
                "Node Type": "Hash Join",
                "Plans": [
                    {"Node Type": "Seq Scan", "Relation Name": "orders", "Schema": "public"},
                    {
                        "Node Type": "Hash",
                        "Plans": [{"Node Type": "Seq Scan", "Relation Name": "users", "Schema": "auth"}],
                    },
                ],
            }
        }
    ]
    assert studio._plan_relations(plan) == {("public", "orders"), ("auth", "users")}


# ---------------------------------------------------------------- values
@pytest.mark.parametrize(
    "value, shown",
    [
        (None, None),
        (True, "true"),
        (5, "5"),
        (Decimal("12.50"), "12.50"),
        (Decimal("1E+2"), "100"),
        (date(2026, 5, 1), "2026-05-01"),
        (datetime(2026, 5, 1, 9, 30), "2026-05-01 09:30:00"),
        ({"a": 1}, '{"a": 1}'),
        (b"\x01\xff", "\\x01ff"),
    ],
)
def test_display(value, shown):
    assert studio.display(value) == shown


def test_normalize_matches_hand_typed_keys():
    assert studio.normalize("05", "integer") == "5"
    assert studio.normalize(" ", "integer") is None
    assert studio.normalize("abc", "integer") == "abc"  # left for validation to report
    assert studio.normalize("2026-05-01T09:30", "timestamp") == "2026-05-01 09:30:00"


# ---------------------------------------------------------------- editability
COLUMNS = [
    {"name": "id", "type": "integer", "nullable": False},
    {"name": "name", "type": "text", "nullable": False},
    {"name": "qty", "type": "integer", "nullable": True},
]


def target(modes=("append", "upsert"), keys=("id",)) -> UploadTarget:
    return UploadTarget(
        target_type="postgres",
        database_name="shop",
        schema_name="public",
        table_name="items",
        display_name="Items",
        write_modes=list(modes),
        key_columns=list(keys),
        contract={"columns": []},
    )


def result(names, tables):
    return studio.QueryResult(
        columns=[{"name": n, "type": None} for n in names],
        rows=[],
        truncated=False,
        tables=tables,
        elapsed_ms=1,
    )


async def mode_of(names, tables):
    with patch.object(studio.loaders, "target_columns", AsyncMock(return_value=COLUMNS)):
        return await studio.edit_mode(result(names, tables))


async def test_any_single_table_query_is_editable():
    # no key needed: an edited row is found by the values it had
    assert (await mode_of(["id", "qty"], [target()]))[:2] == ("edit", None)
    assert (await mode_of(["name", "qty"], [target()]))[:2] == ("edit", None)


async def test_append_only_tables_only_take_new_rows():
    mode, reason, _ = await mode_of(["id", "name"], [target(modes=("append",), keys=())])
    assert mode == "append"
    assert "new rows only" in reason


async def test_joins_and_computed_columns_are_read_only():
    assert (await mode_of(["id"], [target(), target()]))[0] is None
    mode, reason, _ = await mode_of(["id", "total"], [target()])
    assert mode is None
    assert "total" in reason
    assert (await mode_of(["id", "id"], [target()]))[0] is None


async def test_the_grid_shows_the_tables_own_types():
    res = result(["id", "qty"], [target()])
    with patch.object(studio.loaders, "target_columns", AsyncMock(return_value=COLUMNS)):
        await studio.edit_mode(res)
    assert [c["type"] for c in res.columns] == ["integer", "integer"]


# ---------------------------------------------------------------- submissions
def test_an_edit_says_what_changed():
    body = StudioSubmitIn.model_validate(
        {
            "target_id": "00000000-0000-0000-0000-000000000001",
            "edits": [{"match": {"id": "1", "qty": "2"}, "changes": {"qty": {"from": "2", "to": "3"}}}],
        }
    )
    change = body.edits[0].changes["qty"]
    assert (change.before, change.after) == ("2", "3")


def test_an_edit_without_changes_is_refused():
    with pytest.raises(ValidationError):
        StudioSubmitIn.model_validate(
            {
                "target_id": "00000000-0000-0000-0000-000000000001",
                "edits": [{"match": {"id": "1"}, "changes": {}}],
            }
        )


def test_datadesks_own_database_is_never_offered():
    own = target()
    own.database_name = "datadesk"
    with patch.object(studio, "_own_database", return_value="datadesk"):
        assert not studio._in_studio(own)
        assert studio._in_studio(target())


def test_export_names():
    assert studio.export_name("march fixes", "orders-export") == "march fixes.csv"
    assert studio.export_name("march.CSV", "x") == "march.CSV"
    assert studio.export_name("  ", "orders-export").startswith("orders-export-")
    with pytest.raises(ServiceError):
        studio.export_name("a/b", "x")


def test_rows_are_found_by_comparable_columns_only():
    types = {"id": "integer", "tags": "text[]", "doc": "jsonb", "name": "text", "RAW": "RECORD"}
    match = {"id": "1", "tags": "{a}", "doc": "{}", "name": None, "RAW": "{}", "gone": "x"}
    assert studio_changes.usable_match(match, types) == {"id": "1", "name": None}


def test_where_casts_each_value_to_its_column_type():
    with patch.object(studio_changes.bigquery, "ref", return_value="`p.ds.t`"):
        sql = studio_changes._Sql("bigquery", "ds", None, "t")
    where = sql.where(
        {"n": "5", "d": "2026-05-01", "s": None}, {"n": "INTEGER", "d": "DATE", "s": "STRING"}, "w"
    )
    assert where == "`n` = CAST(@w0 AS INT64) AND `d` = CAST(@w1 AS DATE) AND `s` IS NULL"
    assert sql.params == {"w0": "5", "w1": "2026-05-01"}


def test_typed_values_become_what_the_table_stores():
    assert studio_changes.canonical("05/01/2026", "date") == "2026-05-01"
    assert studio_changes.canonical("yes", "boolean") == "true"
    assert studio_changes.canonical("", "text") is None
