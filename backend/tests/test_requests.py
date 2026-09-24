"""Who sees what of a load request."""

from app.services.requests import visible_report

REPORT = {
    "passed": False,
    "summary": "2 problem(s) found.",
    "errors": [{"row": 0, "column": "email", "rule": "rule", "message": "value 'ann@x.io' too long"}],
    "contract_version": 3,
}


def test_requester_and_admins_see_every_error():
    assert visible_report(REPORT, full=True) == REPORT


def test_others_see_the_outcome_but_no_values_from_the_file():
    shown = visible_report(REPORT, full=False)
    assert shown["errors"] == []
    assert shown["summary"] == REPORT["summary"] and shown["contract_version"] == 3
    assert "ann@x.io" not in str(shown)


def test_no_report():
    assert visible_report(None, full=False) is None
