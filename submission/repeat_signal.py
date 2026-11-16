"""Evaluate repeat-inspection signals derived from earlier VTD morphology."""

import argparse
import json
from hashlib import file_digest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import pandas as pd
from filelock import FileLock

from submission.data import (
    SEGMENT_M,
    SOURCES,
    VTD_COLUMNS,
    _normalize_id,
    _numeric,
    _read,
    inspection_targets,
    load_inputs,
    make_grid,
)
from submission.models import MIN_THICKNESS_MM
from submission.registration import shift_forecasts
from submission.repeat_accuracy import (
    GROWTH_MM_PER_YEAR,
    MAE_TARGET_MM,
    SHIFT_RELIABILITY,
    _calibration,
    _dates,
    _smooth_marks,
    repeat_predict,
)
from submission.validation import DAYS_PER_YEAR, KEYS, metrics, validate_prediction_keys

POINT_COLUMNS = ["id", "date", "distance_m", "thickness_mm"]
MORPHOLOGY_COLUMNS = ["reported_wall_mm", "angle_deg", "reported_depth"]
COUNT_PRIOR_MARKS = 5
NEARBY_MARK_RADIUS_M = SEGMENT_M
SPATIAL_BLOCK_M = 500
MODEL_NAMES = (
    "shift_mix_10",
    "shift_transport",
    "shift_half_shrink",
    "shift_count_shrink",
    "shift_nearby_shrink",
    "shift_by_history",
    "shift_report_gap",
    "reported_wall_half",
    "angular_pooled_half",
    "angular_sector_half",
)
STATUS = "repeat_signal_experiment"
SCORE_COLUMNS = [
    "id",
    "direction",
    "cutoff",
    "source_date",
    "horizon_days",
    "prior_raw_rows",
    "prior_wall_rows",
    "prior_angle_rows",
    "transport_transitions",
    "transport_latest_end",
    "transport_offset_mm",
    "gap_depth_floor_fraction",
    "gap_uplift_over_prior_median_mm",
    "gap_cells_changed",
    "model",
    "label_policy",
    "n",
    "pearson_r",
    "pearson_r2",
    "mae_mm",
    "top10_recall",
    "within_target",
]
BLOCK_COLUMNS = [
    "id",
    "cutoff",
    "block_start_m",
    "n_observed",
    "shift_mae_mm",
    "nearby_mae_mm",
    "mae_gain_mm",
]


def load_morphology(data_dir: Path) -> pd.DataFrame:
    """Read documented wall reference and circumferential angle, without target context."""
    raw = _read(
        data_dir,
        "vtd",
        {
            **VTD_COLUMNS,
            "Wall Thickness": "reported_wall_mm",
            "Angle": "angle_deg",
            "Defect Depth in %": "reported_depth",
        },
    )
    trait = raw["trait"].str.strip().str.casefold()
    metal = trait.eq("потеря металла") | (
        trait.eq("")
        & raw["description"].str.strip().str.casefold().str.startswith("потеря металла")
    )
    eligible = metal & ~raw["beyond"].str.strip().str.casefold().eq("true")
    raw = raw.loc[eligible]
    return raw.assign(
        id=_normalize_id(raw["id"]),
        date=pd.to_datetime(
            raw["date"].str.strip(), format="%Y-%m-%d", errors="coerce"
        ),
        **{
            column: _numeric(raw[column])
            for column in ["distance_m", "thickness_mm", *MORPHOLOGY_COLUMNS]
        },
    )[[*POINT_COLUMNS, *MORPHOLOGY_COLUMNS]].dropna(subset=POINT_COLUMNS)


def _attach_metadata(prior: pd.DataFrame, morphology: pd.DataFrame) -> pd.DataFrame:
    """Preserve the canonical population. Ambiguous duplicates get missing metadata."""
    result = prior
    for columns in (["reported_wall_mm", "angle_deg"], ["reported_depth"]):
        unique = morphology[[*POINT_COLUMNS, *columns]].drop_duplicates()
        unambiguous = unique.loc[~unique.duplicated(POINT_COLUMNS, keep=False)]
        result = result.merge(
            unambiguous, on=POINT_COLUMNS, how="left", validate="many_to_one"
        )
    return result


def _reported_wall_projection(prior: pd.DataFrame, nominal_mm: float) -> pd.DataFrame:
    wall = prior["reported_wall_mm"]
    thickness = prior["thickness_mm"]
    valid = np.isfinite(wall) & wall.ge(thickness) & wall.gt(0)
    depth = wall - thickness
    projected = (nominal_mm - depth).clip(lower=MIN_THICKNESS_MM)
    return prior.assign(thickness_mm=thickness.where(~valid, projected))


def _minimum_reported_depth(points: pd.DataFrame) -> float | None:
    """Retain a depth only if its interpretation agrees with the same VTD record."""
    wall = points["reported_wall_mm"].to_numpy()
    residual = points["thickness_mm"].to_numpy()
    depth = points["reported_depth"].to_numpy()
    candidates = depth[:, None] / np.array([1, 100])
    reconstructed = wall[:, None] * (1 - candidates)
    valid = (
        (wall[:, None] > 0)
        & (candidates >= 0.01)
        & (candidates <= 1)
        & np.isclose(reconstructed, residual[:, None], rtol=0, atol=0.01)
    )
    unambiguous = valid & (valid.sum(axis=1, keepdims=True) == 1)
    return float(candidates[unambiguous].min()) if unambiguous.any() else None


def _sector_marks(prior: pd.DataFrame, *, pooled: bool = False) -> pd.Series:
    """Estimate lower-tail residual thickness by four fixed quarter-turn sectors."""
    angles = prior["angle_deg"]
    valid = prior.loc[
        np.isfinite(angles)
        & angles.between(0, 360)
        & np.isfinite(prior["distance_m"])
        & np.isfinite(prior["thickness_mm"])
        & prior["distance_m"].ge(0)
        & prior["thickness_mm"].gt(0)
    ]
    if valid.empty:
        return pd.Series(dtype=float, name="thickness_mm")
    bins = (valid["distance_m"] // SEGMENT_M).astype(int)
    if pooled:
        return valid.groupby(bins.rename("segment_id"))["thickness_mm"].quantile(0.25)
    sectors = (valid["angle_deg"] % 360 // 90).astype(int)
    return (
        valid.groupby([bins.rename("segment_id"), sectors])["thickness_mm"]
        .quantile(0.25)
        .groupby(level=0)
        .min()
    )


def _angular_prior(
    grid: pd.DataFrame,
    marks: pd.Series,
    prior_center: pd.Series,
    horizon_years: float,
) -> pd.Series:
    if marks.empty:
        return prior_center
    ordered = grid["segment_id"].map(marks)
    prior_with_growth = prior_center + horizon_years * GROWTH_MM_PER_YEAR
    local = _smooth_marks(ordered, prior_with_growth)
    return pd.Series(
        np.maximum(local - horizon_years * GROWTH_MM_PER_YEAR, MIN_THICKNESS_MM),
        index=grid.index,
    )


def _nearby_mark_weight(positions: np.ndarray, centers: np.ndarray) -> np.ndarray:
    """Sum triangle weights around the physical center of each segment."""
    ordered = np.sort(positions)
    radius = NEARBY_MARK_RADIUS_M
    left = np.searchsorted(ordered, centers - radius, side="left")
    right = np.searchsorted(ordered, centers + radius, side="right")
    return np.asarray([
        np.maximum(0, 1 - np.abs(ordered[start:stop] - center) / radius).sum()
        for start, stop, center in zip(left, right, centers, strict=True)
    ])


def predict_signal(
    inputs: dict,
    section: pd.DataFrame,
    cutoff: pd.Timestamp,
    morphology: pd.DataFrame | None,
) -> tuple[pd.DataFrame, dict]:
    baseline, audit = repeat_predict(inputs, section, cutoff)
    section_id = section["id"].iat[0]
    prior_date = pd.Timestamp(audit["source_date"])
    horizon_years = audit["horizon_days"] / DAYS_PER_YEAR
    transport_offset, transport_audit = _calibration(
        inputs, section, cutoff, prior_date, horizon_years,
        predict=shift_forecasts, prediction_column="shift_mix_10",
    )
    raw = inputs["vtd"]
    prior = raw.loc[
        raw["id"].eq(section_id) & raw["date"].eq(prior_date), POINT_COLUMNS
    ]
    if morphology is None:
        points = prior.assign(**dict.fromkeys(MORPHOLOGY_COLUMNS, np.nan))
    else:
        previous_metadata = morphology.loc[
            morphology["id"].eq(section_id) & morphology["date"].eq(prior_date)
        ]
        points = _attach_metadata(prior, previous_metadata)
    nominal_mm = float(section["nominal_mm"].iat[0])
    projected = _reported_wall_projection(points, nominal_mm)
    wall = points["reported_wall_mm"]
    prior_wall_rows = int(
        (np.isfinite(wall) & wall.ge(points["thickness_mm"]) & wall.gt(0)).sum()
    )
    prior_angle_rows = int(points["angle_deg"].between(0, 360).sum())

    predictions = baseline[[*KEYS, "shift_mix_10", "shift_half_shrink", "prior_median"]]
    valid_marks = prior.loc[
        prior["distance_m"].ge(0)
        & prior["distance_m"].lt(section["end_m"].max())
        & np.isfinite(prior["thickness_mm"])
        & prior["thickness_mm"].gt(0)
    ]
    counts = (valid_marks["distance_m"] // SEGMENT_M).value_counts()
    support = predictions["segment_id"].map(counts).fillna(0)
    density_weight = support / (support + COUNT_PRIOR_MARKS)
    centers = predictions["segment_id"].map(section.set_index("segment_id")["center_m"])
    nearby_support = _nearby_mark_weight(valid_marks["distance_m"].to_numpy(), centers.to_numpy())
    nearby_weight = nearby_support / (nearby_support + COUNT_PRIOR_MARKS)
    if prior_wall_rows:
        corrected = shift_forecasts(section, projected, horizon_years)
        predictions = predictions.merge(
            corrected[[*KEYS, "shift_mix_10"]].rename(
                columns={"shift_mix_10": "wall_shift"}
            ),
            on=KEYS,
            validate="one_to_one",
        )
    else:
        predictions = predictions.assign(wall_shift=predictions["shift_mix_10"])
    angular_prior = _angular_prior(
        predictions, _sector_marks(points), predictions["prior_median"], horizon_years
    )
    pooled_prior = _angular_prior(
        predictions,
        _sector_marks(points, pooled=True),
        predictions["prior_median"],
        horizon_years,
    )
    result = predictions.assign(
        shift_transport=(predictions["shift_mix_10"] + transport_offset).clip(
            lower=MIN_THICKNESS_MM
        ),
        shift_count_shrink=predictions["prior_median"] + density_weight
        * (predictions["shift_mix_10"] - predictions["prior_median"]),
        shift_nearby_shrink=predictions["prior_median"] + nearby_weight
        * (predictions["shift_mix_10"] - predictions["prior_median"]),
        reported_wall_half=SHIFT_RELIABILITY * predictions["wall_shift"]
        + (1 - SHIFT_RELIABILITY) * predictions["prior_median"],
        angular_pooled_half=SHIFT_RELIABILITY * predictions["shift_mix_10"]
        + (1 - SHIFT_RELIABILITY) * pooled_prior,
        angular_sector_half=SHIFT_RELIABILITY * predictions["shift_mix_10"]
        + (1 - SHIFT_RELIABILITY) * angular_prior,
    )
    history_model = "shift_transport" if transport_audit["prior_transition_count"] else "shift_nearby_shrink"
    history = result[history_model]
    depth_floor = _minimum_reported_depth(points.loc[
        points["distance_m"].ge(0)
        & points["distance_m"].lt(section["end_m"].max())
        & points["thickness_mm"].gt(0)
        & np.isfinite(points["thickness_mm"])
    ])
    gap_adjustment = 0.0
    gap_forecast = history
    if depth_floor is not None:
        prior_center = float(predictions["prior_median"].iat[0])
        reference = nominal_mm * (1 - depth_floor) - GROWTH_MM_PER_YEAR * horizon_years
        gap_adjustment = float(support.eq(0).mean()) * max(0.0, reference - prior_center)
        if gap_adjustment > 0:
            gap_forecast = history.where(nearby_support > 0, prior_center + gap_adjustment)
    result = result.assign(
        shift_by_history=history, shift_report_gap=gap_forecast,
    )[[*KEYS, *MODEL_NAMES]]
    validate_prediction_keys(section, result)
    return result, {
        "source_date": audit["source_date"],
        "horizon_days": audit["horizon_days"],
        "prior_raw_rows": len(prior),
        "prior_wall_rows": prior_wall_rows,
        "prior_angle_rows": prior_angle_rows,
        "transport_transitions": transport_audit["prior_transition_count"],
        "transport_latest_end": transport_audit["latest_calibration_end"],
        "transport_offset_mm": transport_offset,
        "gap_depth_floor_fraction": depth_floor,
        "gap_uplift_over_prior_median_mm": gap_adjustment,
        "gap_cells_changed": int(gap_forecast.ne(history).sum()),
    }


def _paired_spatial_blocks(joined: pd.DataFrame) -> pd.DataFrame:
    observed = joined.dropna(subset=["thickness_mm"])
    target = observed["thickness_mm"]
    errors = observed.assign(
        block_start_m=(observed["start_m"] // SPATIAL_BLOCK_M).astype(int) * SPATIAL_BLOCK_M,
        shift_mae_mm=(target - observed["shift_mix_10"]).abs(),
        nearby_mae_mm=(target - observed["shift_nearby_shrink"]).abs(),
    )
    blocks = errors.groupby("block_start_m", as_index=False).agg(
        n_observed=("thickness_mm", "size"),
        shift_mae_mm=("shift_mae_mm", "mean"),
        nearby_mae_mm=("nearby_mae_mm", "mean"),
    )
    return blocks.assign(mae_gain_mm=blocks["shift_mae_mm"] - blocks["nearby_mae_mm"])


def _benchmark_tables(
    inputs: dict, morphology: pd.DataFrame
) -> tuple[pd.DataFrame, pd.DataFrame]:
    grid = make_grid(inputs["passport"])
    targets = inspection_targets(inputs["vtd"], grid)
    result: list[dict] = []
    spatial_blocks: list[pd.DataFrame] = []
    for section_id, section in grid.groupby("id", sort=True):
        dates = _dates(inputs, section_id, section["commissioned"].iat[0])
        for cutoff in dates[1:]:
            actual = targets.loc[
                targets["id"].eq(section_id) & targets["date"].eq(cutoff)
            ]
            if actual.empty:
                continue
            predictions, audit = predict_signal(
                inputs, section, pd.Timestamp(cutoff), morphology
            )
            joined = (
                section[[*KEYS, "nominal_mm", "start_m"]]
                .merge(
                    predictions,
                    on=KEYS,
                    validate="one_to_one",
                )
                .merge(
                    actual[[*KEYS, "thickness_mm"]],
                    how="left",
                    on=KEYS,
                    validate="one_to_one",
                )
            )
            spatial_blocks.append(_paired_spatial_blocks(joined).assign(
                id=section_id, cutoff=cutoff.date().isoformat()
            ))
            raw = joined["thickness_mm"]
            for label_policy, target in (
                ("observed", raw),
                ("nominal_fill", raw.fillna(joined["nominal_mm"])),
            ):
                for model in MODEL_NAMES:
                    errors = (joined[model] - target).abs().dropna()
                    result.append(
                        {
                            "id": section_id,
                            "direction": section["direction_id"].iat[0],
                            "cutoff": cutoff.date().isoformat(),
                            **audit,
                            "model": model,
                            "label_policy": label_policy,
                            **metrics(target, joined[model]),
                            "within_target": float(errors.le(MAE_TARGET_MM).mean()),
                        }
                    )
    blocks = pd.concat(spatial_blocks)[BLOCK_COLUMNS] if spatial_blocks else pd.DataFrame(columns=BLOCK_COLUMNS)
    return pd.DataFrame(result, columns=SCORE_COLUMNS), blocks


def signal_benchmark(inputs: dict, morphology: pd.DataFrame) -> pd.DataFrame:
    scores, _ = _benchmark_tables(inputs, morphology)
    return scores


def _campaign_format(rows: pd.DataFrame) -> dict:
    """Check competing reporting-unit hypotheses, after the forecasts are scored."""
    thickness = rows["thickness_mm"]
    observed = thickness[np.isfinite(thickness)]
    pairs = rows[["thickness_mm", "reported_wall_mm", "reported_depth"]]
    pairs = pairs.loc[np.isfinite(pairs).all(axis=1)]
    wall, depth = pairs["reported_wall_mm"], pairs["reported_depth"]
    scaled = observed / 0.08
    return {
        "thickness_rows": len(observed),
        "depth_wall_pairs": len(pairs),
        "depth_min": None if depth.empty else float(depth.min()),
        "depth_max": None if depth.empty else float(depth.max()),
        "residual_p95_mm": None if observed.empty else float(observed.quantile(0.95)),
        "residual_max_mm": None if observed.empty else float(observed.max()),
        "residual_on_0_08_mm_grid_fraction": None
        if observed.empty
        else float(np.isclose(scaled, scaled.round(), rtol=0, atol=1e-8).mean()),
        **{
            key: None
            if pairs.empty
            else float(
                (wall * (1 - depth / divisor) - pairs["thickness_mm"])
                .abs()
                .quantile(0.99)
            )
            for key, divisor in (
                ("fraction_depth_p99_mm", 1),
                ("percentage_depth_p99_mm", 100),
            )
        },
    }


def _campaign_formats(scores: pd.DataFrame, morphology: pd.DataFrame) -> list[dict]:
    dates = pd.concat(
        [
            scores[["id", column]].rename(columns={column: "date"})
            for column in ["source_date", "cutoff"]
        ],
        ignore_index=True,
    ).drop_duplicates()
    rows = morphology.merge(
        dates.assign(date=pd.to_datetime(dates["date"])),
        on=["id", "date"],
        validate="many_to_one",
    )
    return [
        {"id": section_id, "date": date.date().isoformat(), **_campaign_format(group)}
        for (section_id, date), group in rows.groupby(["id", "date"], sort=True)
    ]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    morphology = load_morphology(args.data_dir)
    scores, blocks = _benchmark_tables(load_inputs(args.data_dir), morphology)
    hashes = {}
    for source in SOURCES.values():
        with (args.data_dir / source).open("rb") as handle:
            hashes[source] = file_digest(handle, "sha256").hexdigest()
    manifest = {
        "status": STATUS,
        "metrics_rows": len(scores),
        "spatial_block_rows": len(blocks),
        "spatial_block_m": SPATIAL_BLOCK_M,
        "models": MODEL_NAMES,
        "mae_target_mm": MAE_TARGET_MM,
        "input_sha256": hashes,
        "method": "Earlier VTD mark-count weighting, wall-reference projection and four-sector lower-tail spatial shrinkage",
        "count_prior_marks": COUNT_PRIOR_MARKS,
        "nearby_mark_radius_m": NEARBY_MARK_RADIUS_M,
        "transport": "Median annual residual of each completed same-direction transition, then median across transitions, clipped at ±0.35 mm/year.",
        "history_rule": "Nearby-mark weighting when no eligible prior transitions exist; otherwise use the transported residual correction.",
        "report_gap_rule": "Only cells without nearby marks use a prior median blended toward nominal minus the smallest consistent historical reported depth.",
        "interpretation": "Fixed exploratory hypotheses on reused historical folds. The official export is not changed.",
        "campaign_format_ex_post": _campaign_formats(scores, morphology),
    }
    args.out_dir.mkdir(parents=True, exist_ok=True)
    receipt = args.out_dir / "manifest.json"
    with TemporaryDirectory(prefix=".signal-", dir=args.out_dir) as temp:
        stage = Path(temp)
        scores.to_csv(stage / "metrics.csv", index=False, float_format="%.9g")
        blocks.to_csv(stage / "spatial_blocks.csv", index=False, float_format="%.9g")
        (stage / "manifest.json").write_text(
            json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
        )
        with FileLock(args.out_dir / ".pipetwin.lock"):
            if (args.out_dir / "result.csv").exists() or (
                receipt.exists()
                and json.loads(receipt.read_text(encoding="utf-8")).get("status")
                != STATUS
            ):
                parser.error("Use a dedicated repeat signal output directory")
            receipt.unlink(missing_ok=True)
            (stage / "metrics.csv").replace(args.out_dir / "metrics.csv")
            (stage / "spatial_blocks.csv").replace(args.out_dir / "spatial_blocks.csv")
            (stage / "manifest.json").replace(receipt)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
