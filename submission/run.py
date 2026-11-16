"""Reproduce masked historical scores and export both candidate predictions."""

import argparse
import hashlib
import json
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import pandas as pd
from filelock import FileLock

from submission.data import SOURCES, load_inputs, make_grid, inspection_targets
from submission.repeat_signal import load_morphology, predict_signal
from submission.sample_grid import RESULT_COLUMNS, check_sample_grid
from submission.validation import (
    KEYS, backtest, cold_forecast, cold_training_rows, repeat_forecast, validate_prediction_keys,
)

REPEAT_EXPORT_MODELS = ("uniform", "shift_by_history", "shift_report_gap")
CSV_FLOAT_FORMAT = "%.10g"


def _put_csv(frame: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.to_csv(path, index=False, lineterminator="\n", float_format=CSV_FLOAT_FORMAT)


def write_result(grid: pd.DataFrame, predictions: pd.DataFrame, path: Path) -> None:
    if not set(KEYS).issubset(grid) or not set(RESULT_COLUMNS).issubset(predictions):
        raise ValueError("Missing grid or prediction columns")
    result = predictions[RESULT_COLUMNS]
    validate_prediction_keys(grid, result)
    thickness = pd.to_numeric(result["thickness_pred"], errors="coerce")
    if not np.isfinite(thickness).all() or thickness.le(0).any():
        raise ValueError("Thickness predictions must be finite and positive")
    validated = result.assign(thickness_pred=thickness)
    _put_csv(validated.sort_values(KEYS), path)


def _priority(grid: pd.DataFrame, prediction: pd.DataFrame) -> pd.DataFrame:
    locations = grid[[*KEYS, "start_m", "end_m"]].merge(prediction, on=KEYS, validate="one_to_one")
    published_thickness = locations["thickness_pred"].map(lambda value: float(CSV_FLOAT_FORMAT % value))
    locations = locations.assign(published_thickness=published_thickness)
    selected = []
    for _, section in locations.groupby("id"):
        k = (len(section) + 9) // 10
        top = section.sort_values(["published_thickness", "segment_id"]).head(k)
        selected.append(top.assign(rank=range(1, k + 1)))
    return pd.concat(selected, ignore_index=True).drop(columns="published_thickness")


def _date(value: str) -> pd.Timestamp:
    try:
        parsed = date.fromisoformat(value)
        if parsed.isoformat() != value:
            raise ValueError
        return pd.Timestamp(parsed)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("Expected date YYYY-MM-DD") from exc


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--repeat-id")
    parser.add_argument("--repeat-date", type=_date)
    parser.add_argument("--cold-id")
    parser.add_argument("--cold-date", type=_date)
    parser.add_argument("--repeat-model", choices=REPEAT_EXPORT_MODELS,
                        default="uniform", help="Optional experimental repeat forecast")
    parser.add_argument("--target-source", help="Name or link of the target confirmation")
    parser.add_argument("--targets-confirmed", action="store_true",
                        help="Mark the IDs and dates as confirmed by the caller")
    parser.add_argument("--sample-result", type=Path,
                        help="Require exact output keys from the supplied sample_result.csv")
    return parser


def _predict(args, grid, inputs, targets, examples) -> tuple[pd.DataFrame, pd.DataFrame, list[dict]]:
    repeat = grid.loc[grid["id"].eq(args.repeat_id)]
    cold = grid.loc[grid["id"].eq(args.cold_id)]
    if repeat.empty or cold.empty:
        raise ValueError("Both target IDs must exist in the simple-section passport")
    repeat_dates = inputs["campaigns"].loc[inputs["campaigns"]["id"].eq(args.repeat_id), "date"]
    cold_dates = inputs["campaigns"].loc[inputs["campaigns"]["id"].eq(args.cold_id), "date"]
    if cold_dates.lt(args.cold_date).any():
        raise ValueError("The cold-start ID has a previous VTD")
    repeat_labels = targets.loc[targets["id"].eq(args.repeat_id)]
    r, previous = repeat_forecast(repeat, repeat_labels, repeat_dates, args.repeat_date)
    repeat_audit = {}
    if args.repeat_model != "uniform":
        morphology = load_morphology(args.data_dir) if args.repeat_model == "shift_report_gap" else None
        r, audit = predict_signal(inputs, repeat, args.repeat_date, morphology=morphology)
        repeat_audit = {
            "historical_transitions": audit["transport_transitions"],
            "latest_historical_transition_end": audit["transport_latest_end"],
            "transport_offset_mm": audit["transport_offset_mm"],
        }
        if args.repeat_model == "shift_report_gap":
            repeat_audit.update({
                "gap_depth_floor_fraction": audit["gap_depth_floor_fraction"],
                "gap_uplift_over_prior_median_mm": audit["gap_uplift_over_prior_median_mm"],
                "gap_cells_changed": audit["gap_cells_changed"],
            })
    c, train = cold_forecast(cold, inputs, examples, args.cold_date)
    prediction = pd.concat([
        r[[*KEYS, args.repeat_model]].rename(columns={args.repeat_model: "thickness_pred"}),
        c[[*KEYS, "physics"]].rename(columns={"physics": "thickness_pred"}),
    ], ignore_index=True)
    cases = [
        dict(case="repeat", id=args.repeat_id, cutoff=str(args.repeat_date.date()),
             start=str(previous.date()), model=args.repeat_model, segments=len(repeat), **repeat_audit),
        dict(case="cold", id=args.cold_id, cutoff=str(args.cold_date.date()),
             start=str(cold["commissioned"].iat[0].date()), model="physics", segments=len(cold),
             ridge_train_directions=int(train["direction_id"].nunique())),
    ]
    return pd.concat([repeat, cold]), prediction, cases


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    target_flags = (args.repeat_id, args.repeat_date, args.cold_id, args.cold_date)
    if args.sample_result is not None and not all(target_flags):
        parser.error("--sample-result requires all four target flags")
    if args.sample_result is not None:
        sample_path = args.sample_result.resolve()
        for name in ("result.csv", "priority.csv", "forecast_metrics.csv", "manifest.json", ".pipetwin.lock"):
            if sample_path == (args.out_dir / name).resolve():
                parser.error(f"--sample-result must be separate from the output {name}")
    if (any(target_flags) or args.targets_confirmed) and not all(target_flags):
        parser.error("Provide all four target flags to export results")
    if args.targets_confirmed and not (args.target_source or "").strip():
        parser.error("--targets-confirmed requires a nonempty --target-source")
    if args.target_source is not None and not args.targets_confirmed:
        parser.error("--target-source requires --targets-confirmed")
    if args.repeat_id is not None and args.repeat_id == args.cold_id:
        parser.error("Target IDs must be distinct")
    predicting = all(target_flags)
    if args.repeat_model != "uniform" and (not predicting or args.targets_confirmed):
        parser.error("Experimental repeat export requires candidate targets and a separate output directory")
    if not predicting and any((args.out_dir / name).exists() for name in ("result.csv", "priority.csv")):
        parser.error("Use a separate output directory for a historical-only run")
    inputs = load_inputs(args.data_dir)
    grid = make_grid(inputs["passport"])
    targets = inspection_targets(inputs["vtd"], grid)
    examples = cold_training_rows(inputs, grid, targets)
    scores = backtest(inputs, grid, targets, examples)
    cases: list[dict] = []
    if predicting:
        try:
            selected, prediction, cases = _predict(args, grid, inputs, targets, examples)
            if args.sample_result is not None:
                check_sample_grid(args.sample_result, selected)
        except ValueError as exc:
            parser.error(str(exc))
    sources = [args.data_dir / name for name in sorted(SOURCES.values())]
    manifest = {
        "targets": "confirmed_by_caller" if args.targets_confirmed else "candidate" if cases else "historical_only",
        "target_source": args.target_source,
        "cases": cases,
        "grid_rows": len(grid),
        "inspection_campaigns": len(inputs["campaigns"]),
        "input_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                         for p in sources},
        "input_audit": {name: table.attrs.get("audit", {}) for name, table in inputs.items()},
    }
    if args.repeat_model != "uniform":
        manifest["experimental"] = True
    if args.sample_result is not None:
        manifest["sample_result_grid_checked"] = True
    args.out_dir.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".pipetwin-", dir=args.out_dir) as temp:
        staging = Path(temp)
        outputs = ["forecast_metrics.csv"]
        _put_csv(scores, staging / outputs[0])
        if predicting:
            write_result(selected, prediction, staging / "result.csv")
            _put_csv(_priority(selected, prediction), staging / "priority.csv")
            outputs.extend(["result.csv", "priority.csv"])
        (staging / "manifest.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        with FileLock(args.out_dir / ".pipetwin.lock"):
            if not predicting and any((args.out_dir / n).exists() for n in ("result.csv", "priority.csv")):
                parser.error("Use a separate output directory for a historical-only run")
            # Serialize publication; the manifest is the completion marker.
            manifest_path = args.out_dir / "manifest.json"
            existing = None
            if manifest_path.exists():
                try:
                    existing = json.loads(manifest_path.read_text(encoding="utf-8"))
                except (UnicodeError, json.JSONDecodeError):
                    parser.error("Existing manifest is invalid; use a new output directory")
                if not isinstance(existing, dict):
                    parser.error("Existing manifest is invalid; use a new output directory")
            if existing is not None and existing.get("targets") not in (
                "historical_only", "candidate", "confirmed_by_caller",
            ):
                parser.error("Output directory contains a different kind of report")
            if predicting:
                has_report = any((args.out_dir / n).exists() for n in ("result.csv", "priority.csv"))
                if has_report:
                    if existing is None:
                        parser.error("Prediction files exist without a manifest; use a new output directory")
                    existing_cases = existing.get("cases")
                    if not isinstance(existing_cases, list):
                        parser.error("Prediction manifest has no repeat model; use a new output directory")
                    repeat_models = [
                        case.get("model") for case in existing_cases
                        if isinstance(case, dict) and case.get("case") == "repeat"
                    ]
                    if len(repeat_models) != 1 or repeat_models[0] not in REPEAT_EXPORT_MODELS:
                        parser.error("Prediction manifest has no unique repeat model; use a new output directory")
                    if repeat_models[0] != args.repeat_model:
                        parser.error("Use a separate output directory for the experimental repeat export")
            manifest_path.unlink(missing_ok=True)
            for name in outputs:
                (staging / name).replace(args.out_dir / name)
            (staging / "manifest.json").replace(manifest_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
