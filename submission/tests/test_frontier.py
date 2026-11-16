"""Behavioral contracts for registration and cold-start challengers."""

import numpy as np
import pandas as pd
import pytest
from pandas.testing import assert_frame_equal


def _grid():
    return pd.DataFrame({
        "id": ["a"] * 3 + ["b"] * 3,
        "segment_id": [0, 1, 2] * 2,
        "start_m": [0., 10., 20.] * 2,
        "end_m": [10., 20., 30.] * 2,
        "center_m": [5., 15., 25.] * 2,
        "length_m": [30.] * 6,
        "nominal_mm": [10.] * 6,
    })


def _raw():
    return pd.DataFrame({
        "id": ["a", "b"], "date": pd.to_datetime(["2020-01-01"] * 2),
        "distance_m": [9., 29.], "thickness_mm": [6., 4.],
    })


def _sorted(df):
    return df.sort_values(["id", "segment_id"]).reset_index(drop=True)


def test_shift_forecasts_uses_raw_coordinates_and_fixed_scenario_weights():
    from submission.registration import shift_forecasts

    result = _sorted(shift_forecasts(_grid(), _raw(), years=2.))
    assert list(result[["id", "segment_id"]].itertuples(index=False, name=None)) == list(
        _sorted(_grid())[["id", "segment_id"]].itertuples(index=False, name=None)
    )
    # At +5 m, a's observation crosses into segment 1. At -5 m it stays
    # in segment 0. Missing observations fall back to nominal minus loss.
    a = result[result.id == "a"].set_index("segment_id")
    assert a.loc[0, "shift_mix_5"] == pytest.approx(.75 * 5.8 + .25 * 9.8)
    assert a.loc[1, "shift_mix_5"] == pytest.approx(.25 * 5.8 + .75 * 9.8)
    assert a.loc[2, "shift_mix_5"] == pytest.approx(9.8)
    # The +5 m scenario moves b's only point past its end; it must not be
    # clipped back to the last cell or transferred to another section.
    b = result[result.id == "b"].set_index("segment_id")
    assert b.loc[2, "shift_mix_5"] == pytest.approx(.75 * 3.8 + .25 * 9.8)
    assert b.loc[0, "shift_mix_5"] == pytest.approx(9.8)


def test_shift_forecasts_bounds_and_order_are_stable():
    from submission.registration import shift_forecasts

    original = shift_forecasts(_grid(), _raw(), years=2.)
    shuffled = shift_forecasts(_grid().sample(frac=1, random_state=3), _raw().sample(frac=1, random_state=8), years=2.)
    cols = ["shift_mix_5", "shift_mix_10", "shift_mix_20", "shift_lo_mm", "shift_hi_mm"]
    assert_frame_equal(_sorted(original), _sorted(shuffled))
    assert np.isfinite(original[cols].to_numpy()).all()
    assert (original[cols].to_numpy() > 0).all()
    assert (original["shift_lo_mm"] <= original[cols[:3]].min(axis=1)).all()
    assert (original["shift_hi_mm"] >= original[cols[:3]].max(axis=1)).all()


def _train():
    # Both observed and missing cells are retained for every campaign.
    return pd.DataFrame({
        "id": ["x"] * 4 + ["y"] * 4,
        "date": pd.to_datetime(["2019-01-01"] * 4 + ["2020-01-01"] * 4),
        "direction_id": ["dx"] * 4 + ["dy"] * 4,
        "segment_id": [0, 1, 2, 3] * 2,
        "nominal_mm": [10.] * 8,
        "thickness_mm": [8., np.nan, 7., np.nan, np.nan, 9., np.nan, 6.],
        "risk": [0., 1., 2., 3., 0., 1., 2., 3.],
    })


def test_hurdle_predicts_full_grid_with_bounded_probabilities_and_is_order_invariant():
    from submission.cold_challengers import hurdle_forecasts

    grid = _grid()
    features = grid[["id", "segment_id"]].assign(risk=[0., 1., 2., 3., 1., 0.])
    result = hurdle_forecasts(grid, features, _train())
    shuffled = hurdle_forecasts(grid.sample(frac=1, random_state=2), features.sample(frac=1, random_state=3), _train().sample(frac=1, random_state=4))
    assert result.attrs["available"] is True
    assert_frame_equal(_sorted(result), _sorted(shuffled), check_exact=False, rtol=1e-8, atol=1e-8)
    assert not result.duplicated(["id", "segment_id"]).any()
    assert set(map(tuple, result[["id", "segment_id"]].to_numpy())) == set(map(tuple, grid[["id", "segment_id"]].to_numpy()))
    assert result.report_probability.between(0., 1.).all()
    assert np.isfinite(result[["hurdle_conditional", "hurdle_expected"]].to_numpy()).all()
    assert (result[["hurdle_conditional", "hurdle_expected"]] > 0).all().all()


def test_hurdle_declares_unavailable_without_full_reporting_labels():
    from submission.cold_challengers import hurdle_forecasts

    grid = _grid()
    features = grid[["id", "segment_id"]].assign(risk=1.)
    for train in (_train().iloc[0:0], _train().dropna(subset=["thickness_mm"])):
        result = hurdle_forecasts(grid, features, train)
        assert result.attrs["available"] is False


def test_hurdle_rejects_nonphysical_grid_nominal():
    from submission.cold_challengers import hurdle_forecasts

    grid = _grid().assign(nominal_mm=0.)
    features = grid[["id", "segment_id"]].assign(risk=1.)
    with pytest.raises(ValueError):
        hurdle_forecasts(grid, features, _train())


def test_tabicl_checkpoint_authentication_and_empty_train(tmp_path, monkeypatch):
    import hashlib

    from submission import tabular_foundation as tabicl

    checkpoint = tmp_path / "model.ckpt"
    checkpoint.write_bytes(b"synthetic checkpoint")
    features = _grid()[["id", "segment_id"]].assign(grade_10m=2.)
    with pytest.raises(ValueError, match="SHA-256"):
        tabicl.tabicl_forecasts(_grid(), features, _train().iloc[:0], checkpoint)
    monkeypatch.setattr(tabicl, "CHECKPOINT_SHA256", hashlib.sha256(checkpoint.read_bytes()).hexdigest())
    result = tabicl.tabicl_forecasts(_grid(), features, _train().iloc[:0], checkpoint)
    assert result.attrs["available"] is False
    assert result[tabicl.MODEL_COLUMN].isna().all()


def test_tabicl_aligns_features_and_converts_relative_loss(monkeypatch, tmp_path):
    from submission import tabular_foundation as tabicl

    grid = _grid().iloc[:3].assign(nominal_mm=[10., 12., 8.])
    features = grid[["id", "segment_id"]].assign(grade_10m=[.2, .3, .4], arbitrary_id=[1, 2, 3]).iloc[::-1]
    train = _train().assign(grade_10m=np.arange(8, dtype=float), arbitrary_id=999)

    def predict(source, target, loss, checkpoint):
        assert list(source.columns) == ["grade_10m"]
        assert loss == pytest.approx([.2, .3, .1, .4])
        return target["grade_10m"].to_numpy()

    monkeypatch.setattr(tabicl, "verify_checkpoint", lambda path: None)
    monkeypatch.setattr(tabicl, "_predict_loss", predict)
    pred = tabicl.tabicl_forecasts(grid, features, train, tmp_path / "model.ckpt")
    assert pred.attrs["available"] is True
    assert list(pred[tabicl.MODEL_COLUMN]) == pytest.approx([8., 8.4, 4.8])


def test_hurdle_rejects_nonphysical_training_nominal():
    from submission.cold_challengers import hurdle_forecasts

    grid = _grid()
    features = grid[["id", "segment_id"]].assign(trough_m_10m=1.)
    train = _train().assign(trough_m_10m=1.)
    train.loc[0, "nominal_mm"] = 0.
    with pytest.raises(ValueError):
        hurdle_forecasts(grid, features, train)


def test_hurdle_uses_allowed_terrain_predictor_for_reporting():
    from submission.cold_challengers import hurdle_forecasts

    grid = _grid()
    features = grid[["id", "segment_id"]].assign(trough_m_10m=[0., 1., 2., 0., 1., 2.])
    train = _train().assign(trough_m_10m=[0., 2., 0., 2.] * 2)
    train["thickness_mm"] = [8., np.nan, 7., np.nan, 9., np.nan, 6., np.nan]
    result = hurdle_forecasts(grid, features, train)
    assert result.attrs["available"] is True
    assert result.loc[result.segment_id == 0, "report_probability"].min() > result.loc[result.segment_id == 2, "report_probability"].max()


def test_geometry_forecasts_use_symmetric_and_oriented_basin_risks():
    from submission.cold_challengers import geometry_forecasts

    grid = _grid()
    features = grid[["id", "segment_id"]].copy()
    for radius in (10, 30, 100):
        features[f"trough_m_{radius}m"] = radius * 0.02
        features[f"forward_rise_m_{radius}m"] = radius * 0.06
        features[f"backward_rise_m_{radius}m"] = radius * 0.01
    # One asymmetry reverses forward/backward rise and changes directional risk.
    features.loc[0, "forward_rise_m_10m"] = 0.1
    features.loc[0, "backward_rise_m_10m"] = 0.6
    result = geometry_forecasts(grid, features).set_index(["id", "segment_id"])
    def wall(risk):
        return 10. * (1. - .25 * risk / (1. + risk))
    assert result.loc[("a", 1), "geometry_only"] == pytest.approx(wall(2.))
    assert result.loc[("a", 1), "directional_basin"] == pytest.approx(wall(2.))
    assert result.loc[("a", 0), "directional_basin"] == pytest.approx(wall(100. * (.01 + .02 + .02) / 3.))


def test_frontier_cli_preserves_baseline_and_excludes_future_and_same_direction_training(tmp_path):
    import json
    import subprocess
    import sys

    from submission.data import PASSPORT_COLUMNS, SOURCES
    from submission.tests.test_cli import invoke, write_inputs

    data = tmp_path / "data"
    write_inputs(data)
    passport_path = data / SOURCES["passport"]
    passport = pd.read_csv(passport_path)
    passport[list(PASSPORT_COLUMNS)[3]] = .035  # retain an unreported grid cell
    passport.to_csv(passport_path, index=False)
    baseline_dir = tmp_path / "baseline"
    baseline = invoke(data, baseline_dir)
    assert baseline.returncode == 0, baseline.stderr
    out = tmp_path / "frontier"
    command = [sys.executable, "-m", "submission.frontier", "--data-dir", str(data), "--out-dir", str(out)]
    run = subprocess.run(command, capture_output=True, text=True, check=False)
    assert run.returncode == 0, run.stderr
    assert json.loads((out / "manifest.json").read_text())["status"] == "historical_experiment"
    baseline_metrics = pd.read_csv(baseline_dir / "forecast_metrics.csv")
    metrics = pd.read_csv(out / "metrics.csv")
    actual = metrics[metrics.model.isin(baseline_metrics.model.unique())][baseline_metrics.columns].reset_index(drop=True)
    assert_frame_equal(actual, baseline_metrics, check_dtype=False)
    folds = pd.read_csv(out / "training_folds.csv")
    assert not folds.empty
    assert (pd.to_datetime(folds.train_date) < pd.to_datetime(folds.cutoff)).all()
    # In this fixture every section has its own direction, so training IDs
    # also serve as a direct check of direction exclusion.
    assert folds.train_id.ne(folds.id).all()
    scores = pd.read_csv(out / "registration_scores.csv")
    assert not scores.empty
    assert scores.predicted_rate.between(0, 1).all()
    assert scores.brier.between(0, 1).all()

    protected = subprocess.run(command[:-1] + [str(baseline_dir)], capture_output=True, text=True, check=False)
    assert protected.returncode != 0
    assert "output directory" in protected.stderr.lower()
    assert_frame_equal(pd.read_csv(baseline_dir / "forecast_metrics.csv"), baseline_metrics)


def test_frontier_empty_history_writes_parseable_csvs_and_validates_explicit_model(tmp_path):
    from submission.data import SOURCES
    from submission.frontier import main
    from submission.tests.test_cli import write_inputs

    data = tmp_path / "data"
    write_inputs(data)
    raw = data / SOURCES["vtd"]
    pd.read_csv(raw).iloc[:0].to_csv(raw, index=False)
    out = tmp_path / "out"
    args = ["--data-dir", str(data), "--out-dir", str(out)]
    assert main(args) == 0
    for report in out.glob("*.csv"):
        assert pd.read_csv(report).empty
    checkpoint = tmp_path / "bad.ckpt"
    checkpoint.write_bytes(b"invalid")
    with pytest.raises(ValueError, match="SHA-256"):
        main([*args, "--tabicl-checkpoint", str(checkpoint)])


def test_scenario_priority_votes_and_zero_match_uniform():
    from submission.data import inspection_targets
    from submission.models import repeat_predictions
    from submission.registration import SHIFT_OFFSETS_M, shift_forecasts

    grid, raw = _grid(), _raw()
    result = shift_forecasts(grid, raw, years=2.)
    baseline = repeat_predictions(grid, inspection_targets(raw, grid), years=2.)
    assert np.array_equal(result["shift_zero_mm"], baseline["uniform"])
    assert result.groupby("id")["shift_priority_count"].sum().eq(len(SHIFT_OFFSETS_M)).all()


def test_repeat_scenario_uses_only_latest_strictly_earlier_campaign(tmp_path):
    from submission.data import load_inputs
    from submission.frontier import candidate_repeat_scenarios
    from submission.tests.test_cli import write_inputs

    data_dir = tmp_path / "data"
    write_inputs(data_dir)
    inputs = load_inputs(data_dir)
    cutoff = pd.Timestamp("2020-01-01")
    expected = candidate_repeat_scenarios(inputs, "1", cutoff)
    vtd = inputs["vtd"]
    on_or_after = vtd["date"].ge(cutoff)
    changed = {**inputs, "vtd": vtd.assign(thickness_mm=vtd["thickness_mm"].where(~on_or_after, .01))}
    assert_frame_equal(expected, candidate_repeat_scenarios(changed, "1", cutoff))
    assert expected["cutoff"].eq("2020-01-01").all()
