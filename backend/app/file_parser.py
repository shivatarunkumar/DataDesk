"""Parse/serialize workspace files to a normalized {columns, rows} grid.

Supported formats: csv, xlsx (first sheet), json (array of records). Values are
kept as strings/None on parse so the validator can decide type-coercibility
against the target schema; empty strings become None.
"""
import csv
import io
import json

SUPPORTED_FORMATS = ("csv", "xlsx", "json")

# Rows above this are rejected at parse time (v1 synchronous validation cap).
MAX_ROWS = 100_000


def detect_format(filename: str) -> str | None:
    name = (filename or "").lower()
    if name.endswith(".csv"):
        return "csv"
    if name.endswith(".xlsx"):
        return "xlsx"
    if name.endswith(".json"):
        return "json"
    return None


def _norm(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        s = value.strip()
        return s if s != "" else None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        if value != value:  # NaN
            return None
        if value.is_integer():
            return str(int(value))  # 9999.0 -> "9999"
        return repr(value)
    return str(value)


def _infer_type(values: list) -> str:
    """Cheap type hint for UI/metadata: integer | number | boolean | string."""
    seen = [v for v in values if v is not None]
    if not seen:
        return "string"

    def is_int(v):
        try:
            int(str(v))
            return True
        except (ValueError, TypeError):
            return False

    def is_num(v):
        try:
            float(str(v))
            return True
        except (ValueError, TypeError):
            return False

    if all(is_int(v) for v in seen):
        return "integer"
    if all(is_num(v) for v in seen):
        return "number"
    if all(str(v).lower() in ("true", "false", "0", "1") for v in seen):
        return "boolean"
    return "string"


_DELIM_CANDIDATES = [",", "\t", ";", "|"]


def sniff_delimiter(text: str) -> str:
    """Pick the delimiter by counting candidates in the header line."""
    first = next((ln for ln in text.splitlines() if ln.strip() != ""), "")
    best, best_count = ",", -1
    for d in _DELIM_CANDIDATES:
        n = first.count(d)
        if n > best_count:
            best, best_count = d, n
    return best if best_count > 0 else ","


def parse(data: bytes, fmt: str, delimiter: str | None = None) -> dict:
    """Return {columns, rows, inferred_types, row_count, delimiter}.

    For delimited text (csv/tsv), `delimiter` forces a specific char; when None
    it is auto-detected among comma/tab/semicolon/pipe.
    """
    if fmt not in SUPPORTED_FORMATS:
        raise ValueError(f"Unsupported format: {fmt}")

    used_delim: str | None = None

    if fmt == "csv":
        text = data.decode("utf-8-sig", errors="replace")
        used_delim = delimiter or sniff_delimiter(text)
        reader = csv.DictReader(io.StringIO(text), delimiter=used_delim)
        columns = [c for c in (reader.fieldnames or []) if c is not None]
        rows = [{c: _norm(r.get(c)) for c in columns} for r in reader]

    elif fmt == "json":
        payload = json.loads(data.decode("utf-8", errors="replace"))
        if isinstance(payload, dict):
            payload = [payload]
        if not isinstance(payload, list):
            raise ValueError("JSON must be an array of records (or a single object).")
        columns = []
        for rec in payload:
            if not isinstance(rec, dict):
                raise ValueError("Each JSON record must be an object.")
            for k in rec.keys():
                if k not in columns:
                    columns.append(k)
        rows = [{c: _norm(rec.get(c)) for c in columns} for rec in payload]

    else:  # xlsx — pandas is far more robust than manual openpyxl iteration
        import pandas as pd

        df = pd.read_excel(io.BytesIO(data), sheet_name=0, engine="openpyxl")
        # Drop fully-empty leading rows/cols that some exports include.
        df = df.dropna(axis=0, how="all").dropna(axis=1, how="all")
        # Excel columns that are entirely blank get names like "Unnamed: 3".
        columns = [str(c) for c in df.columns if not str(c).startswith("Unnamed:")]
        rows = []
        for rec in df.to_dict(orient="records"):
            rows.append({str(k): _norm(v) for k, v in rec.items() if str(k) in columns})

    if len(rows) > MAX_ROWS:
        raise ValueError(f"File has {len(rows)} rows; the {MAX_ROWS} row limit is exceeded.")

    inferred = {c: _infer_type([r.get(c) for r in rows]) for c in columns}
    return {"columns": columns, "rows": rows, "inferred_types": inferred,
            "row_count": len(rows), "delimiter": used_delim}


def serialize(columns: list[str], rows: list[dict], fmt: str, delimiter: str = ",") -> bytes:
    """Serialize an edited grid back to bytes in the given format."""
    if fmt == "csv":
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=columns, extrasaction="ignore", delimiter=delimiter or ",")
        writer.writeheader()
        for r in rows:
            writer.writerow({c: ("" if r.get(c) is None else r.get(c)) for c in columns})
        return buf.getvalue().encode("utf-8")

    if fmt == "json":
        records = [{c: r.get(c) for c in columns} for r in rows]
        return json.dumps(records, ensure_ascii=False, indent=2).encode("utf-8")

    if fmt == "xlsx":
        from openpyxl import Workbook

        wb = Workbook()
        ws = wb.active
        ws.append(columns)
        for r in rows:
            ws.append([r.get(c) for c in columns])
        out = io.BytesIO()
        wb.save(out)
        return out.getvalue()

    raise ValueError(f"Unsupported format: {fmt}")


CONTENT_TYPES = {
    "csv": "text/csv",
    "json": "application/json",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}
