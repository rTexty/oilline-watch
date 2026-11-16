"""Audit named VTD landmarks in campaign chainage coordinates."""

import json
from collections.abc import Callable
from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd
from numpy.typing import ArrayLike

from submission.data import SEGMENT_M, _normalize_id, _numeric, _read

BRACKETS = ("against_flow", "with_flow")
COLUMNS = {
    "id": "id",
    "date": "date",
    "Distance": "chainage_m",
    "Reference Point 1 (Against Flow)": "against_flow",
    "Distance to Reference Point 1, m": "against_flow_offset",
    "Reference Point 2 (With Flow)": "with_flow",
    "Distance to Reference Point 2, m": "with_flow_offset",
}
# Require reconstructed positions to agree within half a forecast bin.
MAX_SPREAD_M = SEGMENT_M / 2
KEYS = ["id", "date", "landmark"]
ESTIMATE_COLUMNS = [
    *KEYS,
    "position_m",
    "mad_m",
    "spread_m",
    "rows",
    "distinct_chainages",
    "against_flow_sign",
    "with_flow_sign",
    "orientation_resolved",
    "stable",
]
PAIR_COLUMNS = [
    "id",
    "source_date",
    "target_date",
    "source_landmarks",
    "target_landmarks",
    "exact_matches",
    "stable_exact_matches",
    "matched_landmarks_json",
    "unmatched_source_json",
    "unmatched_target_json",
    "status",
    "observational_only",
    "median_shift_m",
    "identity_mae_m",
    "constant_shift_loo_mae_m",
    "monotone_loo_mae_m",
    "monotone_loo_max_error_m",
]


def fit_monotone(source_m: ArrayLike, target_m: ArrayLike) -> Callable:
    """Interpolate increasing anchors and extrapolate with the nearest anchor shift."""
    source = np.array(source_m, dtype=float, copy=True)
    target = np.array(target_m, dtype=float, copy=True)
    if (
        source.ndim != 1
        or source.size < 2
        or source.shape != target.shape
        or not np.isfinite(source).all()
        or not np.isfinite(target).all()
        or not np.all(np.diff(source) > 0)
        or not np.all(np.diff(target) > 0)
    ):
        raise ValueError(
            "provide at least two finite, strictly increasing landmark pairs"
        )

    def map_chainage(positions_m: ArrayLike):
        positions = np.asarray(positions_m, dtype=float)
        interior = np.interp(positions, source, target)
        return np.where(
            positions < source[0],
            positions + (target[0] - source[0]),
            np.where(
                positions > source[-1], positions + (target[-1] - source[-1]), interior
            ),
        )

    return map_chainage


def _bracket_readings(raw: pd.DataFrame, bracket: str) -> pd.DataFrame:
    readings = (
        raw[["id", "date", "chainage_m"]]
        .assign(
            landmark=raw[bracket]
            .str.normalize("NFKC")
            .str.casefold()
            .str.split()
            .str.join(" "),
            offset_m=_numeric(raw[f"{bracket}_offset"]),
            bracket=bracket,
        )
        .dropna()
    )
    return readings.loc[readings["landmark"].ne("")]


def _scatter(positions: np.ndarray) -> float:
    return float(np.median(np.abs(positions - np.median(positions))))


def _choose_sign(readings: pd.DataFrame) -> tuple[int, np.ndarray, bool]:
    chainage = readings["chainage_m"].to_numpy(dtype=float)
    offset = readings["offset_m"].to_numpy(dtype=float)
    plus, minus = chainage + offset, chainage - offset
    plus_scatter, minus_scatter = _scatter(plus), _scatter(minus)
    if np.isclose(plus_scatter, minus_scatter, rtol=0, atol=1e-8):
        same_positions = np.array_equal(plus, minus)
        candidates = plus if same_positions else np.concatenate((plus, minus))
        return 0, candidates, same_positions
    if plus_scatter < minus_scatter:
        return 1, plus, True
    return -1, minus, True


def _estimate(key: tuple, readings: pd.DataFrame) -> dict:
    by_bracket = {
        bracket: _choose_sign(rows) for bracket, rows in readings.groupby("bracket")
    }
    positions = np.concatenate([values for _, values, _ in by_bracket.values()])
    orientation_resolved = all(resolved for _, _, resolved in by_bracket.values())
    spread = float(np.ptp(positions))
    distinct = readings["chainage_m"].nunique()
    return {
        **dict(zip(KEYS, key, strict=True)),
        "position_m": float(np.median(positions)),
        "mad_m": _scatter(positions),
        "spread_m": spread,
        "rows": len(readings),
        "distinct_chainages": distinct,
        **{f"{name}_sign": by_bracket.get(name, (None,))[0] for name in BRACKETS},
        "orientation_resolved": orientation_resolved,
        "stable": orientation_resolved and distinct >= 2 and spread <= MAX_SPREAD_M,
    }


def _loo_scores(matches: pd.DataFrame) -> dict:
    if len(matches) < 3:
        return {"status": "insufficient_stable_matches"}
    source = matches["position_m_source"].to_numpy(dtype=float)
    target = matches["position_m_target"].to_numpy(dtype=float)
    if np.any(np.diff(source) <= 0) or np.any(np.diff(target) <= 0):
        return {"status": "nonmonotone_matches"}

    shifts = target - source
    identity_errors = np.abs(shifts)
    shift_errors, mapped_errors = [], []
    for index in range(len(matches)):
        retained = np.arange(len(matches)) != index
        shift_errors.append(abs(shifts[index] - np.median(shifts[retained])))
        mapping = fit_monotone(source[retained], target[retained])
        mapped_errors.append(abs(float(mapping(source[index])) - target[index]))
    return {
        "status": "loo_available",
        "median_shift_m": float(np.median(shifts)),
        "identity_mae_m": float(np.mean(identity_errors)),
        "constant_shift_loo_mae_m": float(np.mean(shift_errors)),
        "monotone_loo_mae_m": float(np.mean(mapped_errors)),
        "monotone_loo_max_error_m": float(max(mapped_errors)),
    }


def _pair_summary(section_id: str, source: tuple, target: tuple) -> dict:
    source_date, before = source
    target_date, after = target
    matches = before.merge(
        after,
        on="landmark",
        suffixes=("_source", "_target"),
        validate="one_to_one",
    ).sort_values("position_m_source")
    stable = matches.loc[matches["stable_source"] & matches["stable_target"]]
    details = matches[
        [
            "landmark",
            "position_m_source",
            "position_m_target",
            "stable_source",
            "stable_target",
        ]
    ]
    return {
        "id": section_id,
        "source_date": source_date,
        "target_date": target_date,
        "source_landmarks": len(before),
        "target_landmarks": len(after),
        "exact_matches": len(matches),
        "stable_exact_matches": len(stable),
        "matched_landmarks_json": details.to_json(orient="records", force_ascii=False),
        "unmatched_source_json": _unmatched(before, matches),
        "unmatched_target_json": _unmatched(after, matches),
        "observational_only": True,
        **_loo_scores(stable),
    }


def _unmatched(landmarks: pd.DataFrame, matches: pd.DataFrame) -> str:
    return json.dumps(
        sorted(set(landmarks["landmark"]) - set(matches["landmark"])),
        ensure_ascii=False,
    )


def audit_landmarks(data_dir: Path | str) -> dict[str, pd.DataFrame]:
    """Audit all pairs of observed campaigns without producing forecast inputs."""
    raw = _read(Path(data_dir), "vtd", COLUMNS)
    values = raw.assign(
        id=_normalize_id(raw["id"]),
        date=pd.to_datetime(
            raw["date"].str.strip(), format="%Y-%m-%d", errors="coerce"
        ),
        chainage_m=_numeric(raw["chainage_m"]),
    ).dropna(subset=["id", "date"])
    readings = pd.concat([_bracket_readings(values, bracket) for bracket in BRACKETS])
    landmarks = pd.DataFrame(
        [_estimate(key, group) for key, group in readings.groupby(KEYS)],
        columns=ESTIMATE_COLUMNS,
    ).astype({"stable": bool})
    pairs: list[dict] = []
    for section_id, section in values.groupby("id"):
        estimates = landmarks.loc[landmarks["id"].eq(section_id)]
        campaigns = [
            (date, estimates.loc[estimates["date"].eq(date)])
            for date in sorted(section["date"].unique())
        ]
        pairs.extend(
            _pair_summary(section_id, source, target)
            for source, target in combinations(campaigns, 2)
        )
    return {
        "landmark_estimates": landmarks,
        "landmark_pairs": pd.DataFrame(pairs, columns=PAIR_COLUMNS),
    }
