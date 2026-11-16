"""Run local challenger experiments on the existing historical folds."""

import argparse
import hashlib
import json
import platform
from importlib.metadata import version
from tempfile import TemporaryDirectory
from pathlib import Path

import numpy as np
import pandas as pd
from filelock import FileLock

from submission.cold_challengers import geometry_forecasts, hurdle_forecasts
from submission.data import SOURCES, inspection_targets, load_inputs, make_grid
from submission.features import build_features
from submission.registration import SHIFT_COLUMNS, shift_forecasts
from submission.validation import (
    DAYS_PER_YEAR,
    KEYS,
    backtest,
    cold_training_rows,
    eligible_cold_training,
    metrics,
    repeat_forecast,
    validate_prediction_keys,
)

EMPTY_METRICS = dict(n=0, pearson_r=None, pearson_r2=None, mae_mm=None, top10_recall=None)
SCENARIO_COLUMNS = [*KEYS, *SHIFT_COLUMNS, "shift_mix_10", "shift_lo_mm", "shift_hi_mm",
                    "shift_priority_count", "cutoff", "width_mm"]
SENSITIVITY_COLUMNS = [*KEYS, "shift_lo_mm", "shift_hi_mm", "cutoff", "width_mm"]
PLACEBO_COLUMNS = ["id", "cutoff", "model", "offset_bins", "label_policy", *EMPTY_METRICS]
EDGE_COLUMNS = ["id", "cutoff", "prior_date", "offset_m", "dropped_rows"]
REGISTRATION_COLUMNS = [
    "id", "cutoff", "grid_n", "observed_rate", "train_rate", "predicted_rate", "brier", "brier_constant",
]
TRAINING_COLUMNS = ["id", "cutoff", "train_id", "train_date", "train_direction", "grid_n", "observed_n"]


def first_campaign_grid(inputs: dict, grid: pd.DataFrame, targets: pd.DataFrame) -> pd.DataFrame:
    """Make a full feature grid while retaining unknown measured minima."""
    first = inputs["campaigns"].groupby("id", as_index=False)["date"].min()
    frames = []
    for row in first.merge(inputs["passport"], on="id", validate="one_to_one").itertuples():
        actual = targets.loc[targets["id"].eq(row.id) & targets["date"].eq(row.date)]
        if row.date <= row.commissioned or actual.empty:
            continue
        section = grid.loc[grid["id"].eq(row.id)]
        features = build_features(section, inputs["profile"], inputs["regime"], row.commissioned, row.date)
        frame = features.merge(actual[[*KEYS, "thickness_mm"]], on=KEYS, how="left", validate="one_to_one")
        frames.append(frame.assign(date=row.date, nominal_mm=row.nominal_mm, direction_id=row.direction_id))
    if not frames:
        return pd.DataFrame(columns=[*KEYS, "date", "nominal_mm", "direction_id", "thickness_mm"])
    return pd.concat(frames, ignore_index=True)


def _aligned(section: pd.DataFrame, labels: pd.DataFrame, forecast: pd.DataFrame) -> pd.DataFrame:
    validate_prediction_keys(section, forecast)
    return section[[*KEYS, "nominal_mm"]].merge(forecast, on=KEYS, validate="one_to_one").merge(
        labels[[*KEYS, "thickness_mm"]], on=KEYS, how="left", validate="one_to_one"
    )


def _evaluate(fold, aligned, model_names, train, available=True, reason=None):
    label = aligned["thickness_mm"]
    for name in model_names:
        for policy, y in (("observed", label), ("nominal_fill", label.fillna(aligned["nominal_mm"]))):
            yield dict(
                case=fold.case, id=fold.id, direction=fold.direction, cutoff=fold.cutoff, start=fold.start,
                horizon_days=fold.horizon_days, model=name, label_policy=policy, grid_n=len(aligned),
                observed_n=int(label.notna().sum()), train_directions=int(train["direction_id"].nunique()),
                train_grid_n=len(train), train_observed_n=int(train["thickness_mm"].notna().sum()),
                available=bool(available), reason=reason,
                **(metrics(y, aligned[name]) if available else EMPTY_METRICS),
            )


def placebo_metrics(fold, aligned: pd.DataFrame) -> list[dict]:
    """Deterministic cyclic shifts, a diagnostic rather than an exchangeable null."""
    n = len(aligned)
    offsets = np.rint(np.linspace(10, n - 10, 19)).astype(int).tolist() if n >= 38 else []
    original = aligned["directional_basin"].to_numpy()
    actual = aligned["thickness_mm"]
    filled = actual.fillna(aligned["nominal_mm"])
    return [
        dict(id=fold.id, cutoff=fold.cutoff, model="directional_basin", offset_bins=int(shift),
             label_policy=policy, **metrics(y, np.roll(original, shift)))
        for shift in [0, *offsets]
        for policy, y in [("observed", actual), ("nominal_fill", filled)]
    ]


def benchmark(inputs: dict, checkpoint: Path | None = None) -> dict[str, pd.DataFrame]:
    grid = make_grid(inputs["passport"])
    targets = inspection_targets(inputs["vtd"], grid)
    examples = cold_training_rows(inputs, grid, targets)
    full_examples = first_campaign_grid(inputs, grid, targets)
    baseline = backtest(inputs, grid, targets, examples)
    folds = baseline[["case", "id", "direction", "cutoff", "start", "horizon_days"]].drop_duplicates()
    reports, sensitivity, placebos, runtimes, registration_scores = [], [], [], [], []
    edge_audit: list[dict] = []
    fit_folds: list[dict] = []
    empty_train = full_examples.iloc[:0]
    for fold in folds.itertuples(index=False):
        section = grid.loc[grid["id"].eq(fold.id)]
        cutoff, start = pd.Timestamp(fold.cutoff), pd.Timestamp(fold.start)
        actual = targets.loc[targets["id"].eq(fold.id) & targets["date"].eq(cutoff)]
        if fold.case == "repeat":
            previous = inputs["vtd"].loc[inputs["vtd"]["id"].eq(fold.id) & inputs["vtd"]["date"].eq(start)]
            shifted = shift_forecasts(section, previous, fold.horizon_days / DAYS_PER_YEAR)
            aligned = _aligned(section, actual, shifted)
            edge_audit.extend(
                dict(id=fold.id, cutoff=fold.cutoff, prior_date=fold.start, offset_m=offset, dropped_rows=dropped)
                for offset, dropped in shifted.attrs["edge_loss_by_offset_m"].items()
            )
            reports.extend(_evaluate(fold, aligned, ["shift_mix_5", "shift_mix_10", "shift_mix_20"], empty_train))
            sidecar = aligned[[*KEYS, "shift_lo_mm", "shift_hi_mm"]].assign(cutoff=fold.cutoff)
            sensitivity.append(sidecar.assign(width_mm=sidecar["shift_hi_mm"] - sidecar["shift_lo_mm"]))
            continue
        features = build_features(section, inputs["profile"], inputs["regime"], start, cutoff)
        geometry = _aligned(section, actual, geometry_forecasts(section, features))
        geometry = geometry.assign(regime_only_constant=geometry["nominal_mm"])
        reports.extend(_evaluate(fold, geometry, ["geometry_only", "directional_basin", "regime_only_constant"],
                                 empty_train))
        placebos.extend(placebo_metrics(fold, geometry))
        train = eligible_cold_training(full_examples, fold.direction, cutoff)
        fit_folds.extend(
            dict(id=fold.id, cutoff=fold.cutoff, train_id=key[0], train_date=key[1].date().isoformat(),
                 train_direction=key[2], grid_n=len(campaign), observed_n=int(campaign["thickness_mm"].notna().sum()))
            for key, campaign in train.groupby(["id", "date", "direction_id"], sort=True)
        )
        hurdle = hurdle_forecasts(section, features, train)
        available = hurdle.attrs["available"]
        names = ["hurdle_conditional", "hurdle_expected"]
        aligned_hurdle = _aligned(section, actual, hurdle)
        if "hurdle_conditional_unweighted" in aligned_hurdle:
            names.append("hurdle_conditional_unweighted")
        reports.extend(_evaluate(fold, aligned_hurdle, names, train, available, hurdle.attrs.get("reason")))
        if available:
            event = aligned_hurdle["thickness_mm"].notna()
            prevalence = train["thickness_mm"].notna().groupby([train["id"], train["date"]]).mean().mean()
            probability = aligned_hurdle["report_probability"]
            if not probability.between(0, 1).all():
                raise ValueError("Expected finite report probabilities in [0, 1]")
            registration_scores.append(dict(
                id=fold.id, cutoff=fold.cutoff, grid_n=len(event), observed_rate=float(event.mean()),
                train_rate=float(prevalence), predicted_rate=float(probability.mean()),
                brier=float(np.mean((probability - event) ** 2)),
                brier_constant=float(np.mean((prevalence - event) ** 2)),
            ))
        if checkpoint is not None:
            from submission.tabular_foundation import tabicl_forecasts

            tabicl = tabicl_forecasts(section, features, train.loc[train["thickness_mm"].notna()], checkpoint)
            reports.extend(_evaluate(fold, _aligned(section, actual, tabicl), ["tabicl_conditional"],
                                     train, tabicl.attrs["available"], tabicl.attrs.get("reason")))
            runtimes.append(dict(id=fold.id, cutoff=fold.cutoff, seconds=tabicl.attrs.get("elapsed_seconds")))
    return {
        "metrics": pd.concat([baseline, pd.DataFrame(reports)], ignore_index=True),
        "repeat_sensitivity": pd.concat(sensitivity, ignore_index=True) if sensitivity else pd.DataFrame(columns=SENSITIVITY_COLUMNS),
        "geometry_placebos": pd.DataFrame(placebos, columns=PLACEBO_COLUMNS),
        "tabicl_runtime": pd.DataFrame(runtimes, columns=["id", "cutoff", "seconds"]),
        "repeat_edge_audit": pd.DataFrame(edge_audit, columns=EDGE_COLUMNS),
        "registration_scores": pd.DataFrame(registration_scores, columns=REGISTRATION_COLUMNS),
        "training_folds": pd.DataFrame(fit_folds, columns=TRAINING_COLUMNS),
    }



def candidate_repeat_scenarios(inputs: dict, section_id: str, cutoff: pd.Timestamp) -> pd.DataFrame:
    grid = make_grid(inputs["passport"])
    section = grid.loc[grid["id"].eq(section_id)]
    if section.empty:
        raise ValueError("Repeat scenario ID must exist in the passport")
    raw = inputs["vtd"].loc[inputs["vtd"]["id"].eq(section_id)]
    labels = inspection_targets(raw, section)
    dates = inputs["campaigns"].loc[inputs["campaigns"]["id"].eq(section_id), "date"]
    baseline, start = repeat_forecast(section, labels, dates, cutoff)
    shifted = shift_forecasts(section, raw.loc[raw["date"].eq(start)], (cutoff - start).days / DAYS_PER_YEAR)
    parity = baseline[[*KEYS, "uniform"]].merge(shifted, on=KEYS, validate="one_to_one")
    if not np.array_equal(parity["uniform"].to_numpy(), parity["shift_zero_mm"].to_numpy()):
        raise ValueError("Zero-shift forecast differs from Uniform")
    return shifted.assign(
        cutoff=cutoff.date().isoformat(), width_mm=shifted["shift_hi_mm"] - shifted["shift_lo_mm"],
    )[SCENARIO_COLUMNS]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--tabicl-checkpoint", type=Path)
    parser.add_argument("--repeat-scenario-id")
    parser.add_argument("--repeat-scenario-date", type=pd.Timestamp)
    args = parser.parse_args(argv)
    has_scenario = args.repeat_scenario_id is not None
    if has_scenario != (args.repeat_scenario_date is not None):
        parser.error("Provide both repeat scenario ID and date")
    if has_scenario and (
        pd.isna(args.repeat_scenario_date) or args.repeat_scenario_date.tzinfo is not None
        or args.repeat_scenario_date != args.repeat_scenario_date.normalize()
    ):
        parser.error("Repeat scenario requires a valid date without time or time zone")
    checkpoint = args.tabicl_checkpoint
    checkpoint_hash = None
    if checkpoint is not None:
        from submission.tabular_foundation import CHECKPOINT_SHA256, verify_checkpoint

        verify_checkpoint(checkpoint)
        checkpoint_hash = CHECKPOINT_SHA256
    inputs = load_inputs(args.data_dir)
    reports = benchmark(inputs, checkpoint)
    reports["candidate_repeat_scenarios"] = (
        candidate_repeat_scenarios(inputs, args.repeat_scenario_id, args.repeat_scenario_date)
        if has_scenario else pd.DataFrame(columns=SCENARIO_COLUMNS)
    )
    args.out_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "status": "historical_experiment",
        "seed": 42,
        "python": platform.python_version(),
        "machine": platform.machine(),
        "tabicl_checkpoint_sha256": checkpoint_hash,
        "tabicl_environment": {pkg: version(pkg) for pkg in ("tabicl", "torch")} if checkpoint else None,
        "input_sha256": {name: hashlib.sha256((args.data_dir / name).read_bytes()).hexdigest()
                         for name in sorted(SOURCES.values())},
        "counts": {name: len(table) for name, table in reports.items()},
    }
    with TemporaryDirectory(prefix=".frontier-", dir=args.out_dir) as temp:
        staging = Path(temp)
        for name, content in reports.items():
            content.to_csv(staging / f"{name}.csv", index=False, float_format="%.10g")
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        with FileLock(args.out_dir / ".pipetwin.lock"):
            release = args.out_dir / "manifest.json"
            if (args.out_dir / "result.csv").exists():
                parser.error("Use a dedicated output directory for frontier experiments")
            if release.exists() and json.loads(release.read_text(encoding="utf-8")).get("status") != "historical_experiment":
                parser.error("Output directory belongs to a submission run")
            release.unlink(missing_ok=True)
            for name in reports:
                filename = f"{name}.csv"
                (staging / filename).replace(args.out_dir / filename)
            (staging / "manifest.json").replace(release)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
