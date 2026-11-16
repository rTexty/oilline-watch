"""Section-local terrain features and strictly historical operating exposure."""

import numpy as np
import pandas as pd


TERRAIN_RADII_M = (10, 30, 100)
REGIME_FIELDS = ("watercut", "v_mix", "v_liquid_true", "t_start", "t_end")
KEYS = ["id", "segment_id"]
REFERENCE_SLOW_SPEED_MPS = 0.3
REFERENCE_WET_SLOW_DAYS = 180.0
REGIME_FEATURES = [
    "regime_days",
    "regime_coverage",
    "regime_watercut_mean_pct",
    "regime_mix_velocity_median_mps",
    "regime_liquid_velocity_median_mps",
    "regime_temperature_start_mean",
    "regime_temperature_end_mean",
    "wet_slow_days",
    "wet_slow_day_equivalents",
    "wet_slow_score",
]
GEOMETRY_FEATURES = [
    "profile_covered",
    *[
        f"{name}_{radius}m"
        for radius in TERRAIN_RADII_M
        for name in ("grade", "forward_rise_m", "backward_rise_m", "trough_m")
    ],
]


def _finite_values(frame, columns):
    values = frame[list(columns)].apply(pd.to_numeric, errors="coerce").astype(float)
    return values.where(np.isfinite(values))


def _window_features(center, left, right, x, z):
    center_z = np.interp(center, x, z)
    left_z, right_z = np.interp(left, x, z), np.interp(right, x, z)
    left_index = np.searchsorted(x, left, side="left")
    center_before = np.searchsorted(x, center, side="left")
    center_after = np.searchsorted(x, center, side="right")
    right_index = np.searchsorted(x, right, side="right")

    def rise(starts, ends, edges):
        barriers = np.fromiter(
            (z[start:end].max(initial=-np.inf) for start, end in zip(starts, ends)),
            dtype=float,
            count=len(edges),
        )
        return np.maximum(0.0, np.maximum(barriers, edges) - center_z)

    span = right - left
    grade = np.divide(right_z - left_z, span, out=np.zeros_like(span), where=span > 0)
    forward = rise(center_after, right_index, right_z)
    backward = rise(left_index, center_before, left_z)
    return grade, forward, backward, np.minimum(forward, backward)


def _terrain(section, profile):
    valid = (
        _finite_values(profile, ("distance_m", "z_m"))
        .dropna()
        .loc[lambda rows: rows["distance_m"].between(0.0, section["length_m"].iloc[0])]
        .groupby("distance_m", sort=True)["z_m"]
        .median()
    )
    if len(valid) < 2:
        return {"profile_covered": 0.0, **dict.fromkeys(GEOMETRY_FEATURES[1:], np.nan)}

    x = valid.index.to_numpy(dtype=float)
    z = valid.to_numpy(dtype=float)
    center = section["center_m"].to_numpy(dtype=float)
    covered = (x[0] <= center) & (center <= x[-1])
    features = {"profile_covered": covered.astype(float)}
    for radius in TERRAIN_RADII_M:
        left = np.clip(center - radius, x[0], x[-1])
        right = np.clip(center + radius, x[0], x[-1])
        names = ("grade", "forward_rise_m", "backward_rise_m", "trough_m")
        for name, values in zip(names, _window_features(center, left, right, x, z)):
            features[f"{name}_{radius}m"] = np.where(covered, values, np.nan)
    return features


def _daily_regime(regime, start, cutoff):
    dates = pd.to_datetime(regime["date"], errors="coerce").dt.normalize()
    eligible = dates.ge(start) & dates.lt(cutoff)
    values = _finite_values(regime.loc[eligible], REGIME_FIELDS)
    water = values["watercut"].where(values["watercut"].between(0.0, 100.0))
    mix = values["v_mix"].where(values["v_mix"].ge(0.0))
    liquid = values["v_liquid_true"].where(values["v_liquid_true"].ge(0.0))
    return (
        values.assign(
            id=regime.loc[eligible, "id"],
            date=dates.loc[eligible],
            watercut=water,
            v_mix=mix,
            v_liquid_true=liquid,
        )
        .groupby(["id", "date"], sort=True)[list(REGIME_FIELDS)]
        .median()
    )


def _regime_features(days, period_days):
    # Each observed day contributes at most once. No observations are carried
    # across calendar gaps or imputed before or after the measured interval.
    water = days["watercut"] / 100.0
    slow_weight = 1.0 / (1.0 + (days["v_mix"] / REFERENCE_SLOW_SPEED_MPS) ** 2)
    wet_slow = water * slow_weight
    observed_days = int(days.notna().any(axis=1).sum())
    return {
        "regime_days": observed_days,
        "regime_coverage": observed_days / period_days if period_days else 0.0,
        "regime_watercut_mean_pct": days["watercut"].mean(),
        "regime_mix_velocity_median_mps": days["v_mix"].median(),
        "regime_liquid_velocity_median_mps": days["v_liquid_true"].median(),
        "regime_temperature_start_mean": days["t_start"].mean(),
        "regime_temperature_end_mean": days["t_end"].mean(),
        "wet_slow_days": int(wet_slow.count()),
        "wet_slow_day_equivalents": wet_slow.sum(),
        "wet_slow_score": wet_slow.mean(),
    }


def _physics_risk(terrain, exposure):
    # Observed wet/slow days increase the weight of broad retention basins.
    # Missing days add no exposure. The reference scales are heuristic.
    trough_grades = np.array(
        [np.nan_to_num(terrain[f"trough_m_{radius}m"]) / radius for radius in TERRAIN_RADII_M],
    )
    observed_exposure = exposure["wet_slow_day_equivalents"]
    broad_weight = observed_exposure / (REFERENCE_WET_SLOW_DAYS + observed_exposure)
    return 100.0 * (trough_grades.mean(axis=0) + broad_weight * trough_grades[-1])


def build_features(grid, profile, regime, start, cutoff):
    """Return spatial features and observed regime summaries for [start, cutoff).

    Invalid measurements stay missing for downstream imputation. Profile
    coverage and wet/slow observation counts indicate whether values exist.
    """
    start = pd.Timestamp(start).normalize()
    cutoff = pd.Timestamp(cutoff).normalize()
    if pd.isna(start) or pd.isna(cutoff) or cutoff < start:
        raise ValueError("Feature window requires valid dates with start at or before cutoff.")

    columns = [*KEYS, *GEOMETRY_FEATURES, *REGIME_FEATURES, "physics_risk"]
    if grid.empty:
        return pd.DataFrame(columns=columns)

    section_ids = grid["id"].unique()
    local_profiles = {
        section_id: rows
        for section_id, rows in profile.loc[profile["id"].isin(section_ids)].groupby("id")
    }
    daily = _daily_regime(regime.loc[regime["id"].isin(section_ids)], start, cutoff)
    daily_groups = {section_id: days for section_id, days in daily.groupby(level="id")}
    empty_profile = profile.iloc[:0]
    empty_regime = daily.iloc[:0]
    period_days = (cutoff - start).days

    records = []
    for section_id, section in grid.groupby("id", sort=False):
        terrain = _terrain(section, local_profiles.get(section_id, empty_profile))
        exposure = _regime_features(daily_groups.get(section_id, empty_regime), period_days)
        records.append(
            section[KEYS].assign(
                **terrain,
                **exposure,
                physics_risk=_physics_risk(terrain, exposure),
            )
        )
    return pd.concat(records, ignore_index=True)[columns]
