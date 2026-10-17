"""Convertor: Excel sheets to CSV text, written the way Cloud Run reads Excel."""

import io
from datetime import date, datetime

from openpyxl import Workbook

from app.services import convertor


def workbook(**sheets) -> bytes:
    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(name)
        for row in rows:
            ws.append(row)
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def test_every_sheet_is_read_with_its_name_and_cells_as_cloud_run_writes_them():
    data = workbook(
        Customers=[
            ["id", "joined", "score", "active"],
            [1, date(2026, 10, 15), 12.0, True],
            [2, None, 3.5, False],
        ],
        Orders=[["order", "at"], [7, datetime(2026, 10, 15, 9, 30)]],
    )
    sheets = convertor.read_sheets(data, max_rows=100)
    assert [s.name for s in sheets] == ["Customers", "Orders"]
    assert sheets[0].rows[1] == ["1", "2026-10-15", "12", "true"]
    assert sheets[0].rows[2] == ["2", "", "3.5", "false"]
    assert sheets[1].rows[1] == ["7", "2026-10-15 09:30:00"]


def test_empty_rows_and_trailing_empty_cells_are_dropped():
    data = workbook(S=[["a", "b", None], [None, None], ["1", None, None], ["2", "x"]])
    (sheet,) = convertor.read_sheets(data, max_rows=100)
    assert sheet.rows == [["a", "b"], ["1", ""], ["2", "x"]]


def test_csv_uses_the_chosen_delimiter_and_quotes_when_needed():
    rows = [["name", "note"], ["Ann", "a;b"], ["Bob", 'say "hi"']]
    assert convertor.to_csv(rows, ";").decode() == 'name;note\nAnn;"a;b"\nBob;"say ""hi"""\n'
    assert convertor.to_csv(rows, "\t").decode().splitlines()[1] == "Ann\ta;b"


def test_file_names():
    assert convertor.csv_name("Customers") == "Customers.csv"
    assert convertor.csv_name("Q1/Q2: sales") == "Q1-Q2- sales.csv"
    assert convertor.csv_name("report.CSV") == "report.CSV"
    assert convertor.csv_name("  ") == "Sheet.csv"
