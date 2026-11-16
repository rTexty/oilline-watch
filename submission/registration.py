"""Evaluate fixed shifts of prior inspection readings before segment aggregation."""

import numpy as np
import pandas as pd

from submission.data import inspection_targets
from submission.models import KEYS, repeat_predictions


SHIFT_RADII_M = (5, 10, 20)
SHIFT_OFFSETS_M = (-20, -10, -5, 0, 5, 10, 20)
SHIFT_COLUMNS = (
    "shift_m20_mm", "shift_m10_mm", "shift_m5_mm", "shift_zero_mm",
    "shift_p5_mm", "shift_p10_mm", "shift_p20_mm",
)


def _prior_readings(previous_raw: pd.DataFrame, ends: pd.Series) -> pd.DataFrame:
    distance = pd.to_numeric(previous_raw["distance_m"], errors="coerce")
    thickness = pd.to_numeric(previous_raw["thickness_mm"], errors="coerce")
    section_end = previous_raw["id"].map(ends)
    valid = (
        np.isfinite(distance)
        & distance.ge(0)
        & distance.lt(section_end)
        & np.isfinite(thickness)
        & thickness.gt(0)
        & previous_raw["date"].notna()
    )
    readings = previous_raw.loc[valid, ["id", "date"]].assign(
        distance_m=distance[valid], thickness_mm=thickness[valid]
    )
    if readings.groupby("id")["date"].nunique().gt(1).any():
        raise ValueError("shift forecasts require one prior inspection campaign per section")
    return readings


def shift_forecasts(
    grid: pd.DataFrame, previous_raw: pd.DataFrame, years: float
) -> pd.DataFrame:
    """Return fixed shift mixtures and their scenario bounds in canonical grid order.

    The caller selects the prior inspection for each section. Each scenario uses
    the uniform baseline after shifting and aggregating its raw positions.
    """
    if grid[KEYS].isna().any().any() or grid.duplicated(KEYS).any():
        raise ValueError("segment grid keys must be present and unique")
    grid = grid.sort_values(KEYS, ignore_index=True)
    ends = grid.groupby("id")["end_m"].max()
    readings = _prior_readings(previous_raw, ends)
    section_end = readings["id"].map(ends)

    shifted_positions = {
        offset: readings["distance_m"] + offset for offset in SHIFT_OFFSETS_M
    }
    scenarios = {
        offset: repeat_predictions(
            grid, inspection_targets(readings.assign(distance_m=positions), grid), years
        )["uniform"].to_numpy()
        for offset, positions in shifted_positions.items()
    }
    mixtures = {
        f"shift_mix_{radius}": (
            0.25 * scenarios[-radius] + 0.5 * scenarios[0] + 0.25 * scenarios[radius]
        )
        for radius in SHIFT_RADII_M
    }
    scenario_values = np.stack(list(scenarios.values()))
    priority_count = np.zeros(len(grid), dtype=int)
    for positions in grid.groupby("id", sort=False).indices.values():
        k = (len(positions) + 9) // 10
        bottom = np.argsort(scenario_values[:, positions], axis=1, kind="stable")[:, :k]
        priority_count[positions] = np.bincount(bottom.ravel(), minlength=len(positions))
    result = grid.loc[:, KEYS].assign(
        **mixtures, **dict(zip(SHIFT_COLUMNS, scenarios.values(), strict=True)),
        shift_priority_count=priority_count,
        shift_lo_mm=scenario_values.min(axis=0),
        shift_hi_mm=scenario_values.max(axis=0),
    )
    result.attrs["edge_loss_by_offset_m"] = {
        offset: int((positions.lt(0) | positions.ge(section_end)).sum())
        for offset, positions in shifted_positions.items()
    }
    return result
