"""Audit inspection coordinates and benchmark a scenario for water retention."""

import argparse
import json
from hashlib import file_digest
from math import pi
from pathlib import Path
from tempfile import TemporaryDirectory

import pandas as pd
from filelock import FileLock

from submission.cold_challengers import geometry_forecasts
from submission.data import SOURCES, inspection_targets, load_inputs, make_grid
from submission.features import build_features
from submission.landmarks import audit_landmarks
from submission.models import _physics_prediction, cold_predictions
from submission.validation import KEYS, metrics, validate_prediction_keys
from submission.water_balance import EXPOSURE_RISK_SCALE, SCENARIO_DIAMETER_M, water_balance_forecast


def _evaluate(section, labels, geometry, physics, water, cutoff):
    for forecast in (water, geometry, physics):
        validate_prediction_keys(section, forecast)
    full_volume = pi * (SCENARIO_DIAMETER_M / 2) ** 2 * (section["end_m"] - section["start_m"])
    capacity = (section[[*KEYS, "nominal_mm"]].assign(full_volume=full_volume)
                .merge(water[[*KEYS, "capacity_proxy_m3"]], on=KEYS, validate="one_to_one"))
    risk = EXPOSURE_RISK_SCALE * capacity["capacity_proxy_m3"] / capacity["full_volume"]
    capacity_only = _physics_prediction(capacity.assign(physics_risk=risk))
    joined = (section[[*KEYS, "nominal_mm"]]
              .merge(labels[[*KEYS, "thickness_mm"]], how="left", on=KEYS, validate="one_to_one")
              .merge(geometry, on=KEYS, validate="one_to_one")
              .merge(physics[[*KEYS, "physics"]], on=KEYS, validate="one_to_one")
              .merge(water[[*KEYS, "water_balance_mm"]], on=KEYS, validate="one_to_one"))
    joined = joined.assign(capacity_only_mm=capacity_only)
    observed = joined["thickness_mm"]
    horizon = (cutoff - section["commissioned"].iat[0]).days
    for name in ("nominal_mm", "geometry_only", "directional_basin", "physics", "capacity_only_mm", "water_balance_mm"):
        for mask, actual in (("observed", observed), ("nominal_fill", observed.fillna(joined["nominal_mm"]))):
            yield dict(id=section["id"].iat[0], cutoff=cutoff.date().isoformat(), horizon_days=horizon,
                       model=name, label_policy=mask, grid_n=len(joined), observed_n=int(observed.notna().sum()),
                       **metrics(actual, joined[name]))


def _scenario(section, inputs, cutoff, scored):
    start = section["commissioned"].iat[0]
    water = water_balance_forecast(section, inputs["profile"], inputs["regime"], start, cutoff)
    audit = water.attrs["audit"]
    check = audit["sections"][0]
    tolerance = 1e-9 * max(1.0, check["allocated_m3"])
    if abs(check["mass_residual_m3"]) > tolerance or check["max_step_mass_residual_m3"] > tolerance:
        raise ValueError("Water scenario failed mass closure")
    closure = dict(cutoff=cutoff.date().isoformat(), historical=bool(scored),
                   horizon_days=(cutoff - start).days, **check)
    return water, closure


def _predict_candidates(section, inputs, cutoff):
    if section.empty or cutoff <= section["commissioned"].iat[0]:
        raise ValueError("Cold scenario requires an existing ID and a date after commissioning")
    if (inputs["campaigns"]["id"].eq(section["id"].iat[0]) & inputs["campaigns"]["date"].lt(cutoff)).any():
        raise ValueError("Cold scenario ID has a preceding inspection")
    water, closure = _scenario(section, inputs, cutoff, False)
    result = water.assign(cutoff=cutoff.date().isoformat())
    return result, closure


def experiment(inputs, data_dir, cold_id, cold_date):
    grid = make_grid(inputs["passport"])
    targets = inspection_targets(inputs["vtd"], grid)
    first = inputs["campaigns"].groupby("id", sort=True, as_index=False)["date"].min()
    reports, balances = [], []
    candidate = pd.DataFrame(columns=[*KEYS, "water_exposure", "capacity_proxy_m3",
                                      "water_balance_mm", "cutoff"])
    if cold_id is not None:
        section = grid.loc[grid["id"].eq(cold_id)]
        candidate, closure = _predict_candidates(section, inputs, cold_date)
        balances.append(closure)
    for row in first.itertuples(index=False):
        section = grid.loc[grid["id"].eq(row.id)]
        start = section["commissioned"].iat[0]
        labels = targets.loc[targets["id"].eq(row.id) & targets["date"].eq(row.date)]
        if row.date <= start or labels.empty:
            continue
        water, audit = _scenario(section, inputs, row.date, True)
        features = build_features(section, inputs["profile"], inputs["regime"], start, row.date)
        geometry = geometry_forecasts(section, features)
        physics = cold_predictions(section, features, pd.DataFrame())
        reports.extend(_evaluate(section, labels, geometry, physics, water, row.date))
        balances.append(audit)
    counts = ["id", "cutoff", "horizon_days", "model", "label_policy", "grid_n", "observed_n",
              "n", "pearson_r", "pearson_r2", "mae_mm", "top10_recall"]
    ledger = ["cutoff", "historical", "horizon_days", "id", "profile_cells", "observed_days", "last_observed_date",
              "allocated_m3", "flushed_m3", "spilled_m3", "discarded_at_gaps_m3", "remaining_m3",
              "mass_residual_m3", "max_step_mass_residual_m3"]
    return {**audit_landmarks(data_dir), "water_metrics": pd.DataFrame(reports, columns=counts),
            "water_ledger": pd.DataFrame(balances, columns=ledger), "candidate_water_scenario": candidate}


def _sha256(path):
    with path.open("rb") as handle:
        return file_digest(handle, "sha256").hexdigest()


def _iso_date(raw):
    try:
        day = pd.Timestamp(raw)
        if day.date().isoformat() != raw:
            raise ValueError
        return day
    except ValueError as exc:
        raise argparse.ArgumentTypeError("Expected date YYYY-MM-DD") from exc


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--cold-id")
    parser.add_argument("--cold-date", type=_iso_date)
    args = parser.parse_args(argv)
    if (args.cold_id is None) != (args.cold_date is None):
        parser.error("Provide both cold scenario ID and date")
    reports = experiment(load_inputs(args.data_dir), args.data_dir, args.cold_id, args.cold_date)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".physical-", dir=args.out_dir) as temp:
        stage = Path(temp)
        for name, content in reports.items():
            content.to_csv(stage / f"{name}.csv", index=False, float_format="%.10g")
        data = dict(status="physical_experiment", landmark_use="observational_only",
                    water_use="scenario_proxy", cold_id=args.cold_id,
                    cold_date=None if args.cold_date is None else str(args.cold_date.date()),
                    input_sha256={name: _sha256(args.data_dir / name) for name in sorted(SOURCES.values())},
                    scenario_bore_m=SCENARIO_DIAMETER_M, exposure_risk_scale=EXPOSURE_RISK_SCALE,
                    counts={name: len(table) for name, table in reports.items()})
        (stage / "manifest.json").write_text(json.dumps(data, indent=2) + "\n")
        with FileLock(args.out_dir / ".pipetwin.lock"):
            manifest = args.out_dir / "manifest.json"
            if (args.out_dir / "result.csv").exists() or (
                manifest.exists() and json.loads(manifest.read_text()).get("status") != "physical_experiment"
            ):
                parser.error("Use a dedicated output directory")
            manifest.unlink(missing_ok=True)
            for file in stage.glob("*.csv"):
                file.replace(args.out_dir / file.name)
            (stage / "manifest.json").replace(manifest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
