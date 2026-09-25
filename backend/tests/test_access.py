"""Admin rights for a while: they end on their own, and inputs stay in bounds."""

from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from app.models.user import User
from app.schemas.admin import MAX_ADMIN_MINUTES, AccessIn, AdminRequestIn
from app.services.access import expire_admin_if_due


def admin(until: datetime | None) -> User:
    return User(username="ann", role="admin", admin_until=until)


def test_delegated_admin_becomes_a_user_when_time_is_up():
    user = admin(datetime.now(UTC) - timedelta(seconds=1))
    assert expire_admin_if_due(user)
    assert user.role == "user" and user.admin_until is None


def test_delegated_admin_keeps_rights_until_then():
    user = admin(datetime.now(UTC) + timedelta(hours=1))
    assert not expire_admin_if_due(user)
    assert user.role == "admin"


def test_permanent_admin_never_expires():
    user = admin(None)
    assert not expire_admin_if_due(user)
    assert user.role == "admin"


def test_user_gets_no_duration():
    assert AccessIn(role="user", duration_minutes=60).duration_minutes is None


def test_admin_without_duration_is_permanent():
    assert AccessIn(role="admin").duration_minutes is None


@pytest.mark.parametrize("minutes", [0, -5, MAX_ADMIN_MINUTES + 1])
def test_request_duration_is_bounded(minutes):
    with pytest.raises(ValidationError):
        AdminRequestIn(duration_minutes=minutes)
