"""Repeat-inspection challengers with campaign-cutoff audit and exact scoring masks."""

import argparse
import json
from hashlib import file_digest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import pandas as pd
from filelock import FileLock
from scipy.optimize import linprog
from scipy.sparse import bmat, csr_array, eye_array

from submission.data import (
    SEGMENT_M,
    SOURCES,
    inspection_targets,
    load_inputs,
    make_grid,
)
from submission.models import MIN_THICKNESS_MM, UNIFORM_LOSS_MM_PER_YEAR
from submission.registration import SHIFT_COLUMNS, shift_forecasts
from submission.validation import DAYS_PER_YEAR, KEYS, metrics, validate_prediction_keys

GROWTH_MM_PER_YEAR = 0.025
RELIABILITY_PRIOR_CELLS = 6.0
MAE_TARGET_MM = 0.10
SHIFT_DIAGNOSTIC_BLOCKS_M = (500, 100, 20)
SHIFT_SCENARIO_COLUMNS = ["uniform" if name == "shift_zero_mm" else name for name in SHIFT_COLUMNS]
LOCAL_STATISTICS = ("prior_median", "local_minimum", "local_marked")
SHIFT_RELIABILITY = 0.50
MODEL_NAMES = (
    "uniform",
    "shift_mix_10",
    *LOCAL_STATISTICS,
    "shrunk_calibrated",
    "shift_half_shrink",
)
FOLD_COLUMNS = [
    "id",
    "direction",
    "cutoff",
    "prior_transition_count",
    "prior_calibration_cells",
    "prior_calibration_routes",
    "latest_calibration_end",
    "source_date",
    "horizon_days",
    "prior_raw_count",
    "calibration_mm",
]
SCORE_COLUMNS = [
    *FOLD_COLUMNS,
    "model",
    "label_policy",
    "n",
    "pearson_r",
    "pearson_r2",
    "mae_mm",
    "top10_recall",
    "within_target",
]
DIAGNOSTIC_COLUMNS = [
    *FOLD_COLUMNS,
    "target_raw_count",
    "observed_target_cells",
    "joint_observed_cells",
    "joint_median_change_mm",
    "joint_frac_thicker_by_gt_0_10",
    "diagnostic_nearest_shift_mae_mm",
    "diagnostic_clipped_shift_hull_mae_mm",
    "diagnostic_nominal_fill_shift_hull_mae_mm",
    "outside_shift_hull_n",
    "diagnostic_best_affine_shift_mae_mm",
    "diagnostic_shared_shift_mix_mae_mm",
    *[f"diagnostic_block_{size}m_shift_mix_mae_mm" for size in SHIFT_DIAGNOSTIC_BLOCKS_M],
]


def _profile_prior(grid, previous_raw):
    previous = previous_raw.loc[
        previous_raw["id"].eq(grid["id"].iat[0])
        & previous_raw["distance_m"].ge(0)
        & previous_raw["distance_m"].lt(grid["end_m"].max())
        & np.isfinite(previous_raw["distance_m"])
        & np.isfinite(previous_raw["thickness_mm"])
        & previous_raw["thickness_mm"].gt(0)
    ].assign(segment_id=lambda rows: (rows["distance_m"] // SEGMENT_M).astype(int))
    cells = previous.groupby("segment_id")["thickness_mm"]
    observed = cells.min().rename("prior_min")
    # A low within-cell percentile has bounded sensitivity to the deepest
    # reported point. Tool coverage and reported marks are kept separate.
    marks = cells.quantile(0.25).rename("prior_mark")
    return grid.merge(
        pd.concat([observed, marks], axis=1),
        on="segment_id",
        how="left",
        sort=False,
        validate="one_to_one",
    )


def _smooth_marks(marks: pd.Series, nominal: pd.Series) -> np.ndarray:
    prior = marks.median() if marks.notna().any() else None
    route_center = nominal.to_numpy() if prior is None else float(prior)
    local = marks.rolling(5, center=True, min_periods=1).median().to_numpy()
    support = marks.notna().rolling(5, center=True, min_periods=1).sum().to_numpy()
    weight = support / (support + RELIABILITY_PRIOR_CELLS)
    filled = np.where(np.isfinite(local), local, route_center)
    return weight * filled + (1.0 - weight) * route_center


def local_prior_forecasts(
    grid: pd.DataFrame, previous_raw: pd.DataFrame, horizon_years: float
) -> pd.DataFrame:
    """Shrink neighborhood order statistics toward a prior-only segment median."""
    if (
        grid.empty
        or grid["id"].nunique() != 1
        or not np.isfinite(horizon_years)
        or horizon_years < 0
    ):
        raise ValueError(
            "Expected a nonempty single-section grid and finite nonnegative horizon"
        )
    ordered = grid.sort_values("segment_id").reset_index(drop=True)
    section = _profile_prior(ordered, previous_raw)
    nominal = section["nominal_mm"]
    marked = section["prior_mark"]
    prior_center = (
        np.full(len(section), marked.median())
        if marked.notna().any()
        else nominal.to_numpy()
    )
    fallback_loss = UNIFORM_LOSS_MM_PER_YEAR * horizon_years
    loss = GROWTH_MM_PER_YEAR * horizon_years if marked.notna().any() else fallback_loss
    return section[KEYS].assign(
        prior_median=np.maximum(prior_center - loss, MIN_THICKNESS_MM),
        local_minimum=np.maximum(
            _smooth_marks(section["prior_min"], nominal) - loss, MIN_THICKNESS_MM
        ),
        local_marked=np.maximum(
            _smooth_marks(marked, nominal) - loss, MIN_THICKNESS_MM
        ),
    )


def _dates(inputs, section_id, after):
    campaigns = inputs["campaigns"]
    return sorted(
        campaigns.loc[
            campaigns["id"].eq(section_id) & campaigns["date"].gt(after), "date"
        ].unique()
    )


def _calibration(
    inputs, grid, cutoff, source_date, target_horizon,
    *, predict=local_prior_forecasts, prediction_column="local_marked",
):
    """Estimate a residual rate on completed past transitions from the same direction."""
    direction = grid["direction_id"].iat[0]
    eligible = inputs["passport"].loc[inputs["passport"]["direction_id"].eq(direction)]
    scores = []
    for route in eligible.itertuples(index=False):
        dates = [
            date
            for date in _dates(inputs, route.id, route.commissioned)
            if date <= source_date and date < cutoff
        ]
        if len(dates) < 2:
            continue
        training_grid = make_grid(eligible.loc[eligible["id"].eq(route.id)])
        history = inputs["vtd"].loc[
            inputs["vtd"]["id"].eq(route.id) & inputs["vtd"]["date"].isin(dates)
        ]
        for before, after in zip(dates[:-1], dates[1:], strict=True):
            duration = (after - before).days / DAYS_PER_YEAR
            prior = history.loc[history["date"].eq(before)]
            target = inspection_targets(
                history.loc[history["date"].eq(after)], training_grid
            )
            if len(target) < 3 or prior.empty:
                continue
            estimates = predict(training_grid, prior, duration)
            paired = target.merge(
                estimates[[*KEYS, prediction_column]], on=KEYS, validate="one_to_one"
            )
            correction = (
                paired["thickness_mm"] - paired[prediction_column]
            ).median() / duration
            scores.append(
                (float(correction), len(paired), route.id, after.date().isoformat())
            )
    # With no completed campaign transitions the baseline needs no correction.
    rates = [score[0] for score in scores]
    rate = float(np.clip(np.median(rates), -0.35, 0.35)) if rates else 0.0
    return rate * target_horizon, {
        "prior_transition_count": len(scores),
        "prior_calibration_cells": sum(score[1] for score in scores),
        "prior_calibration_routes": len({score[2] for score in scores}),
        "latest_calibration_end": max((score[3] for score in scores), default=None),
    }


def repeat_predict(
    inputs: dict, grid: pd.DataFrame, cutoff: pd.Timestamp
) -> tuple[pd.DataFrame, dict]:
    """Fit on observations strictly before the forecast date."""
    if grid.empty or grid["id"].nunique() != 1:
        raise ValueError("Expected one target section")
    section_id, commissioned = grid["id"].iat[0], grid["commissioned"].iat[0]
    before = [
        date for date in _dates(inputs, section_id, commissioned) if date < cutoff
    ]
    if not before:
        raise ValueError("No previous eligible campaign")
    source = before[-1]
    prior = inputs["vtd"].loc[
        inputs["vtd"]["id"].eq(section_id) & inputs["vtd"]["date"].eq(source)
    ]
    horizon = (cutoff - source).days / DAYS_PER_YEAR
    shifted = shift_forecasts(grid, prior, horizon)
    local = local_prior_forecasts(grid, prior, horizon)
    correction, audit = _calibration(inputs, grid, cutoff, source, horizon)
    predictions = local.merge(
        shifted[[*KEYS, "shift_mix_10", *SHIFT_COLUMNS]], on=KEYS, validate="one_to_one"
    ).rename(columns={"shift_zero_mm": "uniform"})
    predictions = predictions.assign(
        shrunk_calibrated=(predictions["local_marked"] + correction).clip(
            lower=MIN_THICKNESS_MM
        ),
        shift_half_shrink=(
            SHIFT_RELIABILITY * predictions["shift_mix_10"]
            + (1 - SHIFT_RELIABILITY) * predictions["prior_median"]
        ),
    )
    validate_prediction_keys(grid, predictions)
    return predictions, {
        **audit,
        "source_date": source.date().isoformat(),
        "horizon_days": (cutoff - source).days,
        "prior_raw_count": len(prior),
        "calibration_mm": correction,
    }


def _score_forecasts(predictions, actual, nominal):
    for policy, target in (
        ("observed", actual),
        ("nominal_fill", actual.fillna(nominal)),
    ):
        for model in MODEL_NAMES:
            prediction = predictions[model]
            errors = (prediction - target).abs().dropna()
            yield dict(
                model=model,
                label_policy=policy,
                **metrics(target, prediction),
                within_target=(
                    float(errors.le(MAE_TARGET_MM).mean()) if not errors.empty else None
                ),
            )


def _best_affine_mae(target: np.ndarray, forecast: np.ndarray) -> float:
    """L1 fit on the evaluation labels, used solely as a family-specific diagnostic."""
    count = len(target)
    features = csr_array(np.column_stack([forecast, np.ones(count)]))
    identity = eye_array(count, format="csr")
    objective = np.r_[0.0, 0.0, np.ones(count)]
    result = linprog(
        objective,
        A_ub=bmat([[features, -identity], [-features, -identity]], format="csr"),
        b_ub=np.r_[target, -target],
        bounds=[(0.0, None), (None, None), *[(0.0, None)] * count],
        method="highs",
    )
    if not result.success:
        raise RuntimeError(f"Affine diagnostic could not be solved: {result.message}")
    return float(result.fun / count)


def _shared_shift_mix_error(target: np.ndarray, scenarios: np.ndarray) -> float:
    """Minimum summed absolute error for one common convex mixture."""
    count, shifts = scenarios.shape
    features = csr_array(scenarios)
    identity = eye_array(count, format="csr")
    constraint = csr_array(np.r_[np.ones(shifts), np.zeros(count)].reshape(1, -1))
    result = linprog(
        np.r_[np.zeros(shifts), np.ones(count)],
        A_ub=bmat([[features, -identity], [-features, -identity]], format="csr"),
        b_ub=np.r_[target, -target],
        A_eq=constraint,
        b_eq=[1.0],
        bounds=(0, None),
        method="highs",
    )
    if not result.success:
        raise RuntimeError(f"Shift mixture diagnostic could not be solved: {result.message}")
    return float(result.fun)


def _shift_hull_errors(target: np.ndarray, scenarios: np.ndarray) -> np.ndarray:
    return np.abs(np.clip(target, scenarios.min(axis=1), scenarios.max(axis=1)) - target)


def shift_family_diagnostics(actual: pd.Series, predictions: pd.DataFrame) -> dict:
    """Target-assisted mathematical bounds for the specified scenario family only."""
    observed = actual.notna()
    target = actual.loc[observed].to_numpy()
    scenarios = predictions.loc[observed, SHIFT_SCENARIO_COLUMNS].to_numpy()
    positions = predictions.loc[observed, "start_m"].to_numpy()
    discrete_errors = np.abs(scenarios - target[:, None]).min(axis=1)
    hull_errors = _shift_hull_errors(target, scenarios)
    block_errors = {}
    for size in SHIFT_DIAGNOSTIC_BLOCKS_M:
        block_ids = positions // size
        total = sum(
            _shared_shift_mix_error(target[block_ids == block], scenarios[block_ids == block])
            for block in np.unique(block_ids)
        )
        block_errors[f"diagnostic_block_{size}m_shift_mix_mae_mm"] = total / len(target)
    return {
        "diagnostic_shared_shift_mix_mae_mm": _shared_shift_mix_error(target, scenarios) / len(target),
        **block_errors,
        "diagnostic_nearest_shift_mae_mm": float(discrete_errors.mean()),
        "diagnostic_clipped_shift_hull_mae_mm": float(hull_errors.mean()),
        "outside_shift_hull_n": int(np.count_nonzero(hull_errors)),
        "diagnostic_best_affine_shift_mae_mm": _best_affine_mae(
            target, predictions.loc[observed, "shift_mix_10"].to_numpy()
        ),
    }


def repeat_benchmark(inputs: dict) -> tuple[pd.DataFrame, pd.DataFrame]:
    grid = make_grid(inputs["passport"])
    target = inspection_targets(inputs["vtd"], grid)
    result: list[dict] = []
    diagnostics: list[dict] = []
    for section_id, section in grid.groupby("id", sort=True):
        direction = section["direction_id"].iat[0]
        dates = _dates(inputs, section_id, section["commissioned"].iat[0])
        for cutoff in dates[1:]:
            actual = target.loc[target["id"].eq(section_id) & target["date"].eq(cutoff)]
            if actual.empty:
                continue
            predictions, audit = repeat_predict(inputs, section, pd.Timestamp(cutoff))
            joined = (
                section[[*KEYS, "nominal_mm", "start_m"]]
                .merge(predictions, on=KEYS, validate="one_to_one")
                .merge(
                    actual[[*KEYS, "thickness_mm"]],
                    how="left",
                    on=KEYS,
                    validate="one_to_one",
                )
            )
            fold = dict(
                id=section_id,
                direction=direction,
                cutoff=cutoff.date().isoformat(),
                **audit,
            )
            result.extend(
                {**fold, **score}
                for score in _score_forecasts(
                    joined, joined["thickness_mm"], joined["nominal_mm"]
                )
            )
            source = target.loc[
                target["id"].eq(section_id) & target["date"].eq(audit["source_date"])
            ]
            paired = source.merge(actual, on=KEYS, suffixes=("_before", "_after"))
            changes = paired["thickness_mm_after"] - paired["thickness_mm_before"]
            diagnostics.append(
                {
                    **fold,
                    **shift_family_diagnostics(joined["thickness_mm"], joined),
                    "diagnostic_nominal_fill_shift_hull_mae_mm": float(_shift_hull_errors(
                        joined["thickness_mm"].fillna(joined["nominal_mm"]).to_numpy(),
                        joined[SHIFT_SCENARIO_COLUMNS].to_numpy(),
                    ).mean()),
                    "target_raw_count": int(
                        (
                            inputs["vtd"]["id"].eq(section_id)
                            & inputs["vtd"]["date"].eq(cutoff)
                        ).sum()
                    ),
                    "observed_target_cells": len(actual),
                    "joint_observed_cells": len(paired),
                    "joint_median_change_mm": float(changes.median())
                    if len(changes)
                    else None,
                    "joint_frac_thicker_by_gt_0_10": float(
                        changes.gt(MAE_TARGET_MM).mean()
                    )
                    if len(changes)
                    else None,
                }
            )
    return pd.DataFrame(result, columns=SCORE_COLUMNS), pd.DataFrame(
        diagnostics, columns=DIAGNOSTIC_COLUMNS
    )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    scores, details = repeat_benchmark(load_inputs(args.data_dir))
    inputs_sha256 = {}
    for source in SOURCES.values():
        with (args.data_dir / source).open("rb") as handle:
            inputs_sha256[source] = file_digest(handle, "sha256").hexdigest()
    manifest = {
        "status": "repeat_accuracy_experiment",
        "mae_target_mm": MAE_TARGET_MM,
        "growth_mm_per_year": GROWTH_MM_PER_YEAR,
        "shift_reliability": SHIFT_RELIABILITY,
        "prior_support_cells": RELIABILITY_PRIOR_CELLS,
        "metrics_rows": len(scores),
        "folds": len(details),
        "input_sha256": inputs_sha256,
        "diagnostics": "Target-assisted closest shift, convex mixtures, clipped hull and affine fit are retrospective diagnostics.",
        "shift_diagnostic_blocks_m": SHIFT_DIAGNOSTIC_BLOCKS_M,
    }
    args.out_dir.mkdir(parents=True, exist_ok=True)
    release = args.out_dir / "manifest.json"
    with TemporaryDirectory(prefix=".accuracy-", dir=args.out_dir) as temp:
        stage = Path(temp)
        scores.to_csv(stage / "metrics.csv", index=False, float_format="%.9g")
        details.to_csv(stage / "diagnostics.csv", index=False, float_format="%.9g")
        (stage / "manifest.json").write_text(
            json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
        )
        with FileLock(args.out_dir / ".pipetwin.lock"):
            if (args.out_dir / "result.csv").exists() or (
                release.exists()
                and json.loads(release.read_text()).get("status")
                != "repeat_accuracy_experiment"
            ):
                parser.error("Use a separate repeat accuracy output directory")
            release.unlink(missing_ok=True)
            for name in ("metrics.csv", "diagnostics.csv", "manifest.json"):
                (stage / name).replace(args.out_dir / name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
