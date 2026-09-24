"""Moving and copying in My files: names are never overwritten."""

from app.services.transfer import free_name


def test_a_free_name_is_kept():
    assert free_name("sales.csv", {"other.csv"}, is_file=True) == "sales.csv"


def test_a_taken_name_gets_a_number_before_the_extension():
    assert free_name("sales.csv", {"sales.csv"}, is_file=True) == "sales (1).csv"
    assert free_name("sales.csv", {"sales.csv", "sales (1).csv"}, is_file=True) == "sales (2).csv"


def test_folders_and_dotfiles_number_the_whole_name():
    assert free_name("2026.q1", {"2026.q1"}, is_file=False) == "2026.q1 (1)"
    assert free_name(".env", {".env"}, is_file=True) == ".env (1)"


def test_a_numbered_name_counts_on():
    assert free_name("sales (1).csv", {"sales (1).csv"}, is_file=True) == "sales (2).csv"
    assert free_name("C (1)", {"C (1)", "C (2)"}, is_file=False) == "C (3)"
