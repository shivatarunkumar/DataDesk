"""Data-contract validation for governed uploads.

Given a parsed file grid, the live target-table schema, and optional per-table
rules, produce a report of every problem that would block the load. Value-level
errors are capped so a badly-formatted file doesn't produce a giant payload.
"""

import json
import re
from datetime import date, datetime
from pathlib import Path

# backend/data-contracts/{target_type}/{table}.json
_CONTRACTS_DIR = Path(__file__).resolve().parents[2] / "data-contracts"

MAX_ERRORS = 200


# ── Type category mapping ─────────────────────────────────────────────────────
# Collapse Postgres information_schema.data_type and BigQuery field_type into a
# small set of categories we know how to check a string value against.


def category(db_type: str) -> str:
    t = (db_type or "").lower()
    # whole words only: "interval" and "point" contain "int" but aren't integers
    if re.search(r"\b(smallint|integer|bigint|int|int2|int4|int8|int64|smallserial|serial|bigserial)\b", t):
        return "integer"
    if any(k in t for k in ("numeric", "decimal", "real", "double", "float")):
        return "number"
    if "bool" in t:
        return "boolean"
    if "timestamp" in t or "datetime" in t:
        return "timestamp"
    if t == "date":
        return "date"
    # char, varchar, text, string, uuid, json, bytes, etc. -> treat as free text
    return "string"


_TS_FORMATS = (
    "%Y-%m-%d %H:%M:%S.%f",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M",
    "%Y/%m/%d %H:%M:%S",
    "%m/%d/%Y %H:%M:%S",
    "%d/%m/%Y %H:%M:%S",
)
_DATE_FORMATS = ("%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%d/%m/%Y", "%d-%m-%Y")


def parse_date(v: str) -> date | None:
    """The date in `v` in any of the accepted formats, or None."""
    s = v.strip()
    try:
        return date.fromisoformat(s)
    except ValueError:
        pass
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def parse_timestamp(v: str) -> datetime | None:
    """The timestamp in `v` (a date alone counts, at midnight), or None. The loaders use
    this too, so whatever validation accepts is exactly what gets written."""
    s = v.strip()
    # Drop a trailing timezone name like "UTC" (BigQuery style) and normalize Z.
    s = re.sub(r"\s+[A-Za-z]{2,5}$", "", s).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s)  # 3.11+ handles space sep, micros, offset
    except ValueError:
        pass
    for fmt in _TS_FORMATS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    day = parse_date(s)
    return datetime(day.year, day.month, day.day) if day else None


def _is_timestamp(v: str) -> bool:
    return parse_timestamp(v) is not None


def _is_date(v: str) -> bool:
    return parse_date(v) is not None


def _coercible(value: str, category: str) -> bool:
    if value is None:
        return True
    v = str(value).strip()
    if v == "":
        return True
    try:
        if category == "integer":
            int(v)
        elif category == "number":
            float(v)
        elif category == "boolean":
            return v.lower() in ("true", "false", "0", "1", "yes", "no", "t", "f")
        elif category == "date":
            return _is_date(v)
        elif category == "timestamp":
            return _is_timestamp(v)
        else:
            return True
        return True
    except (ValueError, TypeError):
        return False


RULE_KEYS = ("required", "unique", "regex", "enum", "min", "max", "min_length", "max_length")


def rules_from_contract(contract: dict | None) -> dict:
    """An onboarded target's contract → {column: rule}, keeping only columns with rules."""
    rules = {}
    for col in (contract or {}).get("columns", []):
        if col.get("name") and any(_is_set(col.get(k)) for k in RULE_KEYS):
            rules[col["name"]] = col
    return rules


def _is_set(value) -> bool:
    """A rule is set unless empty. `0 in (None, False)` is true in Python, so a plain
    membership test would drop rules like min: 0."""
    return value is not None and value is not False and value != "" and value != []


def load_rules(target_type: str, table: str) -> dict:
    """Optional extra rules keyed by column name, or {} if no contract file exists."""
    path = _CONTRACTS_DIR / target_type / f"{table}.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
        return {c["name"]: c for c in data.get("columns", []) if "name" in c}
    except Exception:
        return {}


def _check_rule(value, rule: dict) -> str | None:
    """Return an error message if `value` violates `rule`, else None."""
    if value is None or str(value).strip() == "":
        if rule.get("required"):
            return "value is required but empty"
        return None
    v = str(value)
    if rule.get("regex") and not re.fullmatch(rule["regex"], v):
        return f"does not match pattern {rule['regex']}"
    if rule.get("enum") and v not in [str(e) for e in rule["enum"]]:
        return f"not in allowed values {rule['enum']}"
    if rule.get("min_length") is not None and len(v) < rule["min_length"]:
        return f"is shorter than {rule['min_length']} characters"
    if rule.get("max_length") is not None and len(v) > rule["max_length"]:
        return f"is longer than {rule['max_length']} characters"
    if rule.get("min") is not None or rule.get("max") is not None:
        try:
            num = float(v)
            if rule.get("min") is not None and num < rule["min"]:
                return f"below min {rule['min']}"
            if rule.get("max") is not None and num > rule["max"]:
                return f"above max {rule['max']}"
        except (ValueError, TypeError):
            return "expected a number for min/max check"
    return None


def validate(
    parsed: dict,
    target_columns: list[dict],
    write_mode: str,
    key_columns: list[str] | None,
    rules: dict | None = None,
    max_rows: int | None = None,
) -> dict:
    """
    parsed:        {columns, rows, ...} from file_parser.parse
    target_columns: [{name, type, nullable}] from live table introspection
    Returns {passed: bool, errors: [{row, column, rule, message}], summary, stats}.
    """
    rules = rules or {}
    key_columns = key_columns or []
    errors: list[dict] = []

    def add(row, column, rule, message):
        if len(errors) < MAX_ERRORS:
            errors.append({"row": row, "column": column, "rule": rule, "message": message})

    file_cols = parsed["columns"]
    rows = parsed["rows"]
    target_by_name = {c["name"]: c for c in target_columns}
    file_set = set(file_cols)

    # ── File-level checks ─────────────────────────────────────────────────────
    if not file_cols:
        add(None, None, "file", "File has no columns.")
    if not rows:
        add(None, None, "file", "File has no data rows.")
    if max_rows and len(rows) > max_rows:
        add(None, None, "max_rows", f"File has {len(rows)} rows; this table's contract allows {max_rows}.")

    # A contract column marked required must be present, not just filled in.
    for name, rule in rules.items():
        if rule.get("required") and name not in file_set:
            add(None, name, "missing_column", f"Column '{name}' is required by the data contract.")

    # ── Column presence ───────────────────────────────────────────────────────
    # Required = target column that is NOT nullable and has no default indicator.
    for col in target_columns:
        if not col.get("nullable", True) and col["name"] not in file_set:
            add(
                None,
                col["name"],
                "missing_column",
                f"Required (non-nullable) column '{col['name']}' is missing from the file.",
            )

    unknown = [c for c in file_cols if c not in target_by_name]
    for c in unknown:
        add(
            None,
            c,
            "unknown_column",
            f"Column '{c}' does not exist in target table and will be ignored/blocked.",
        )

    # ── Upsert key checks ─────────────────────────────────────────────────────
    if write_mode == "upsert":
        if not key_columns:
            add(None, None, "key", "Upsert requires at least one key column.")
        for k in key_columns:
            if k not in target_by_name:
                add(None, k, "key", f"Key column '{k}' is not in the target table.")
            if k not in file_set:
                add(None, k, "key", f"Key column '{k}' is missing from the file.")
        # Key uniqueness within the file
        if key_columns and all(k in file_set for k in key_columns):
            seen = set()
            for i, r in enumerate(rows):
                combo = tuple(r.get(k) for k in key_columns)
                if combo in seen:
                    add(
                        i,
                        ", ".join(key_columns),
                        "key_unique",
                        f"Duplicate key {combo} in file (upsert keys must be unique).",
                    )
                seen.add(combo)

    # ── Value-level checks (type coercibility, nullability, rules) ────────────
    unique_seen: dict[str, dict] = {
        c: {} for c, rule in rules.items() if rule.get("unique") and c in file_set
    }
    for i, r in enumerate(rows):
        for c in file_cols:
            tgt = target_by_name.get(c)
            val = r.get(c)
            if tgt is not None:
                cat = category(tgt["type"])
                if not _coercible(val, cat):
                    add(i, c, "type", f"value {val!r} is not a valid {cat} for column '{c}' ({tgt['type']}).")
                if (val is None or str(val).strip() == "") and not tgt.get("nullable", True):
                    add(i, c, "not_null", f"column '{c}' is NOT NULL but value is empty.")
            rule = rules.get(c)
            if rule:
                msg = _check_rule(val, rule)
                if msg:
                    add(i, c, "rule", f"column '{c}' {msg}.")
            if c in unique_seen and val is not None and str(val).strip() != "":
                first = unique_seen[c].setdefault(str(val), i)
                if first != i:
                    add(
                        i,
                        c,
                        "unique",
                        f"column '{c}' value {val!r} repeats row {first + 1} (must be unique).",
                    )
        if len(errors) >= MAX_ERRORS:
            break

    passed = len(errors) == 0
    summary = "All checks passed." if passed else f"{len(errors)} problem(s) found."
    if len(errors) >= MAX_ERRORS:
        summary += f" (showing first {MAX_ERRORS})"
    return {
        "passed": passed,
        "errors": errors,
        "summary": summary,
        "stats": {
            "file_rows": len(rows),
            "file_columns": len(file_cols),
            "unknown_columns": unknown,
        },
    }
