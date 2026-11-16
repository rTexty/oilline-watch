"""Check organizer-provided CSV keys against the grid used for a forecast."""

import csv
import re
from pathlib import Path

import pandas as pd

from submission.validation import KEYS

RESULT_COLUMNS = [*KEYS, "thickness_pred"]
SEGMENT_ID = re.compile(r"(?:0|[1-9][0-9]*)")


def check_sample_grid(path: Path, grid: pd.DataFrame) -> None:
    expected = {
        (str(pipe), str(segment))
        for pipe, segment in grid[KEYS].itertuples(index=False, name=None)
    }
    provided: set[tuple[str, str]] = set()
    try:
        with path.open(encoding="utf-8-sig", newline="") as file:
            reader = csv.reader(file, strict=True)
            if next(reader, None) != RESULT_COLUMNS:
                raise ValueError("sample_result.csv must have columns id,segment_id,thickness_pred")
            for row in reader:
                if len(row) != len(RESULT_COLUMNS):
                    raise ValueError(f"Invalid sample CSV row at line {reader.line_num}")
                pipe, segment, _ = row
                if not pipe or pipe.strip() != pipe or SEGMENT_ID.fullmatch(segment) is None:
                    raise ValueError(f"Invalid sample key at line {reader.line_num}")
                key = (pipe, segment)
                if key in provided:
                    raise ValueError(f"Duplicate sample key at line {reader.line_num}: {key}")
                provided.add(key)
    except (OSError, UnicodeError, csv.Error) as exc:
        raise ValueError(f"Could not read sample_result.csv: {exc}") from exc

    missing, unexpected = expected - provided, provided - expected
    if missing or unexpected:
        raise ValueError(
            f"Sample grid mismatch: missing {len(missing)} (e.g. {min(missing, default=None)}), "
            f"unexpected {len(unexpected)} (e.g. {min(unexpected, default=None)}). "
            "Check target IDs and 10 m grid conventions."
        )
