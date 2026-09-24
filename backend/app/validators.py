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
_CONTRACTS_DIR = Path(__file__).parent.parent / "data-contracts"

MAX_ERRORS = 200


# ── Type category mapping ─────────────────────────────────────────────────────
# Collapse Postgres information_schema.data_type and BigQuery field_type into a
# small set of categories we know how to check a string value against.

def _category(db_type: str) -> str:
    t = (db_type or "").lower()
    if any(k in t for k in ("int", "serial")):  # int2/4/8, bigint, integer, serial
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
    "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M",
    "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M",
    "%Y/%m/%d %H:%M:%S", "%m/%d/%Y %H:%M:%S", "%d/%m/%Y %H:%M:%S",
)
_DATE_FORMATS = ("%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%d/%m/%Y", "%d-%m-%Y")


def _is_timestamp(v: str) -> bool:
    s = v.strip()
    # Drop a trailing timezone name like "UTC" (BigQuery style) and normalize Z.
    s = re.sub(r"\s+[A-Za-z]{2,5}$", "", s).replace("Z", "+00:00")
    try:
        datetime.fromisoformat(s)  # 3.11+ handles space sep, micros, offset
        return True
    except ValueError:
        pass
    for fmt in _TS_FORMATS:
        try:
            datetime.strptime(s, fmt)
            return True
        except ValueError:
            continue
    return _is_date(s)  # a date-only value is a valid timestamp too


def _is_date(v: str) -> bool:
    s = v.strip()
    try:
        date.fromisoformat(s)
        return True
    except ValueError:
        pass
    for fmt in _DATE_FORMATS:
        try:
            datetime.strptime(s, fmt)
            return True
        except ValueError:
            continue
    return False


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
    if "regex" in rule and not re.fullmatch(rule["regex"], v):
        return f"does not match pattern {rule['regex']}"
    if "enum" in rule and v not in [str(e) for e in rule["enum"]]:
        return f"not in allowed values {rule['enum']}"
    if "min" in rule or "max" in rule:
        try:
            num = float(v)
            if "min" in rule and num < rule["min"]:
                return f"below min {rule['min']}"
            if "max" in rule and num > rule["max"]:
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

    # ── Column presence ───────────────────────────────────────────────────────
    # Required = target column that is NOT nullable and has no default indicator.
    for col in target_columns:
        if not col.get("nullable", True) and col["name"] not in file_set:
            add(None, col["name"], "missing_column",
                f"Required (non-nullable) column '{col['name']}' is missing from the file.")

    unknown = [c for c in file_cols if c not in target_by_name]
    for c in unknown:
        add(None, c, "unknown_column",
            f"Column '{c}' does not exist in target table and will be ignored/blocked.")

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
                    add(i, ", ".join(key_columns), "key_unique",
                        f"Duplicate key {combo} in file (upsert keys must be unique).")
                seen.add(combo)

    # ── Value-level checks (type coercibility, nullability, rules) ────────────
    for i, r in enumerate(rows):
        for c in file_cols:
            tgt = target_by_name.get(c)
            val = r.get(c)
            if tgt is not None:
                cat = _category(tgt["type"])
                if not _coercible(val, cat):
                    add(i, c, "type",
                        f"value {val!r} is not a valid {cat} for column '{c}' ({tgt['type']}).")
                if (val is None or str(val).strip() == "") and not tgt.get("nullable", True):
                    add(i, c, "not_null", f"column '{c}' is NOT NULL but value is empty.")
            rule = rules.get(c)
            if rule:
                msg = _check_rule(val, rule)
                if msg:
                    add(i, c, "rule", f"column '{c}' {msg}.")
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
