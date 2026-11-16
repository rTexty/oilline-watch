"""Validate an organizer sample against the configured segment keys."""

import pandas as pd
import pytest


HEADER = "id,segment_id,thickness_pred\n"
ROWS = ("00123,0,0\n", "00123,1,0\n", "00123,2,0\n", "9007199254740993,0,0\n")


@pytest.fixture
def grid():
    return pd.DataFrame(
        {
            "id": ["00123", "00123", "00123", "9007199254740993"],
            "segment_id": [0, 1, 2, 0],
            "start_m": [0.0, 10.0, 20.0, 0.0],
            "end_m": [10.0, 20.0, 20.5, 7.0],
        }
    )


def _sample(tmp_path, text):
    path = tmp_path / "sample_result.csv"
    path.write_text(text, encoding="utf-8")
    return path


def test_sample_accepts_exact_keys_in_any_order_and_ignores_placeholders(
    tmp_path, grid
):
    from submission.sample_grid import check_sample_grid

    text = (
        HEADER
        + '9007199254740993,0,"not a number, either"\n00123,2,\n00123,0,n/a\n00123,1,0.00\n'
    )
    assert check_sample_grid(_sample(tmp_path, text), grid) is None


@pytest.mark.parametrize(
    ("rows", "reason"),
    [
        (
            ("00123,1,0\n", "00123,2,0\n", "00123,3,0\n", ROWS[3]),
            "(?is)(?=.*missing)(?=.*unexpected)",
        ),
        ((ROWS[0], ROWS[1], ROWS[3]), "(?i)missing"),
        ((*ROWS, "00123,3,0\n"), "(?i)unexpected"),
        ((*ROWS[:3], "987,0,0\n"), "(?is)(?=.*missing)(?=.*unexpected)"),
        ((*ROWS[:3], "9007199254740992,0,0\n"), "(?is)(?=.*missing)(?=.*unexpected)"),
        (("123,0,0\n", *ROWS[1:]), "(?is)(?=.*missing)(?=.*unexpected)"),
        ((*ROWS, ROWS[0]), "(?i)duplicate"),
    ],
    ids=[
        "one-based",
        "missing-tail",
        "extra-segment",
        "wrong-pipe",
        "large-pipe-id",
        "leading-zero-id",
        "duplicate",
    ],
)
def test_sample_rejects_grid_mismatch(tmp_path, grid, rows, reason):
    from submission.sample_grid import check_sample_grid

    with pytest.raises(ValueError, match=reason):
        check_sample_grid(_sample(tmp_path, HEADER + "".join(rows)), grid)


@pytest.mark.parametrize(
    "value", ["-0", "-1", "+0", "00", "0.0", "0e0", " 0", "", "０"]
)
def test_sample_requires_canonical_segment_ids(tmp_path, grid, value):
    from submission.sample_grid import check_sample_grid

    with pytest.raises(ValueError):
        check_sample_grid(
            _sample(tmp_path, HEADER + f"00123,{value},0\n" + "".join(ROWS[1:])), grid
        )


@pytest.mark.parametrize(
    "text",
    [
        "segment_id,id,thickness_pred\n" + "".join(ROWS),
        "id,segment_id,thickness_pred,extra\n" + "".join(ROWS),
        HEADER + "00123,0\n" + "".join(ROWS[1:]),
        HEADER + "00123,0,0,extra\n" + "".join(ROWS[1:]),
        HEADER + '00123,0,"unclosed\n' + "".join(ROWS[1:]),
    ],
    ids=["column-order", "extra-column", "short-row", "long-row", "unclosed-quote"],
)
def test_sample_rejects_malformed_csv(tmp_path, grid, text):
    from submission.sample_grid import check_sample_grid

    with pytest.raises(ValueError):
        check_sample_grid(_sample(tmp_path, text), grid)
