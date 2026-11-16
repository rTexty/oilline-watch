import json

import numpy as np
import pandas as pd
import pytest

from submission.data import make_grid
from submission.repeat_accuracy import repeat_predict
from submission.repeat_signal import (
    _campaign_format,
    _attach_metadata,
    _minimum_reported_depth,
    _nearby_mark_weight,
    _paired_spatial_blocks,
    _reported_wall_projection,
    _sector_marks,
    main,
    predict_signal,
    signal_benchmark,
)
from submission.tests.test_repeat_accuracy import _fixture


def _metadata(inputs):
    return inputs["vtd"].assign(
        reported_wall_mm=8.0, angle_deg=0.0, reported_depth=12.0
    )


def test_campaign_depth_unit_diagnostic_uses_formula_and_checks_quantization():
    source = pd.DataFrame(
        {
            "thickness_mm": [7.2, 6.8, 6.13, np.nan],
            "reported_wall_mm": [8.0, 8.0, 8.0, 8.0],
            "reported_depth": [10.0, 15.0, 0.234, np.nan],
        }
    )
    result = _campaign_format(source)
    assert result["thickness_rows"] == 3
    assert result["depth_wall_pairs"] == 3
    assert result["residual_on_0_08_mm_grid_fraction"] == pytest.approx(2 / 3)
    assert result["fraction_depth_p99_mm"] > 1
    assert result["percentage_depth_p99_mm"] > 1
    fraction = _campaign_format(source.iloc[[2]])
    assert fraction["fraction_depth_p99_mm"] == pytest.approx(0.002)
    assert fraction["percentage_depth_p99_mm"] > 1


def test_projects_source_wall_to_target_nominal_on_valid_pairs():
    source = pd.DataFrame(
        {
            "thickness_mm": [6.0, 6.0, 6.0, 8.0],
            "reported_wall_mm": [9.0, np.nan, 5.0, 9.0],
        }
    )
    result = _reported_wall_projection(source, 8.0)
    assert result["thickness_mm"].tolist() == [5.0, 6.0, 6.0, 7.0]
    assert source["thickness_mm"].tolist() == [6.0, 6.0, 6.0, 8.0]


def test_depth_requires_consistency_with_reported_wall_and_residual():
    marks = pd.DataFrame({
        "reported_wall_mm": [8, 8, 8, 8, 8],
        "thickness_mm": [7.2, 6.4, 4, 8, 8],
        "reported_depth": [0.1, 20, 1, 0, np.nan],
    })
    assert _minimum_reported_depth(marks) == pytest.approx(0.1)
    assert _minimum_reported_depth(marks.iloc[2:]) is None


def test_conflicting_depth_keeps_unambiguous_wall_and_angle():
    inputs = _fixture()
    metadata = _metadata(inputs).iloc[:1]
    conflicting = pd.concat([metadata, metadata.assign(reported_depth=20)])
    points = _attach_metadata(inputs["vtd"].iloc[:1], conflicting)
    assert points["reported_wall_mm"].tolist() == [8.0]
    assert points["angle_deg"].tolist() == [0.0]
    assert points["reported_depth"].isna().all()


def test_missing_support_correction_only_changes_uncovered_segments():
    inputs = _fixture()
    grid = make_grid(inputs["passport"])
    cutoff = pd.Timestamp("2021-01-01")
    metadata = _metadata(inputs).assign(
        reported_depth=lambda rows: (1 - rows.thickness_mm / 8) * 100,
    )
    results, audit = predict_signal(inputs, grid, cutoff, metadata)
    changed = results["shift_report_gap"].ne(results["shift_by_history"])
    assert results.loc[changed, "segment_id"].tolist() == [3, 4]
    assert audit["gap_depth_floor_fraction"] == pytest.approx(0.125)
    assert audit["gap_uplift_over_prior_median_mm"] > 0
    assert audit["gap_cells_changed"] == 2
    without_metadata, _ = predict_signal(inputs, grid, cutoff, None)
    np.testing.assert_array_equal(without_metadata["shift_report_gap"], without_metadata["shift_by_history"])


def test_sector_marks_uses_weakest_quartile_and_wraps_degrees():
    marks = _sector_marks(
        pd.DataFrame(
            {
                "distance_m": [2, 8, 4, 3, 10, 15, 16],
                "thickness_mm": [4, 6, 7, 8, 5, 7, 1],
                "angle_deg": [1, 360, 90, 270, 180, 10, np.nan],
            }
        )
    )
    assert marks.index.tolist() == [0, 1]
    assert marks.loc[0] == pytest.approx(4.5)
    assert marks.loc[1] == pytest.approx(5.0)


def test_new_models_match_baseline_when_morphology_is_absent():
    inputs = _fixture()
    grid = make_grid(inputs["passport"])
    cutoff = pd.Timestamp("2021-01-01")
    metadata = _metadata(inputs).iloc[:0]
    result, audit = predict_signal(inputs, grid, cutoff, metadata)
    existing, _ = repeat_predict(inputs, grid, cutoff)
    np.testing.assert_allclose(
        result["shift_half_shrink"], existing["shift_half_shrink"]
    )
    np.testing.assert_allclose(
        result["reported_wall_half"], existing["shift_half_shrink"]
    )
    np.testing.assert_allclose(
        result["angular_sector_half"], existing["shift_half_shrink"]
    )
    np.testing.assert_allclose(
        result["angular_pooled_half"], existing["shift_half_shrink"]
    )
    assert audit["prior_wall_rows"] == 0
    assert audit["prior_angle_rows"] == 0


def test_future_measurements_and_morphology_do_not_change_prediction():
    inputs = _fixture()
    grid = make_grid(inputs["passport"])
    cutoff = pd.Timestamp("2021-01-01")
    metadata = _metadata(inputs)
    original, audit = predict_signal(inputs, grid, cutoff, metadata)
    future = metadata["date"].ge(cutoff)
    updated = metadata.assign(
        reported_wall_mm=metadata["reported_wall_mm"].mask(future, 30),
        angle_deg=metadata["angle_deg"].mask(future, 270),
    )
    changed_vtd = inputs["vtd"].assign(
        thickness_mm=inputs["vtd"]["thickness_mm"].mask(future, 0.01)
    )
    changed_inputs = {
        **inputs,
        "vtd": pd.concat([changed_vtd, changed_vtd.loc[future]], ignore_index=True),
    }
    changed, new_audit = predict_signal(changed_inputs, grid, cutoff, updated)
    pd.testing.assert_frame_equal(changed, original)
    assert new_audit == audit
    assert audit["source_date"] == "2020-01-01"


def test_count_shrink_weights_the_shift_by_earlier_marks_in_the_same_cell():
    inputs = _fixture()
    grid = make_grid(inputs["passport"]).sample(frac=1, random_state=42)
    cutoff = pd.Timestamp("2021-01-01")
    result, audit = predict_signal(inputs, grid, cutoff, _metadata(inputs))
    baseline, _ = repeat_predict(inputs, grid, cutoff)
    previous = inputs["vtd"].loc[inputs["vtd"]["date"].eq(audit["source_date"])]
    counts = (previous["distance_m"] // 10).value_counts()
    cells = result["segment_id"].map(counts).fillna(0)
    weight = cells / (cells + 5)
    expected = baseline["prior_median"] + weight * (
        baseline["shift_mix_10"] - baseline["prior_median"]
    )
    np.testing.assert_allclose(result["shift_count_shrink"], expected)
    nearby_support = np.array([0.6, 1.0, 0.4, 0, 0, 0.4, 0.85])
    nearby_weight = nearby_support / (nearby_support + 5)
    np.testing.assert_allclose(
        result["shift_nearby_shrink"],
        baseline["prior_median"]
        + nearby_weight * (baseline["shift_mix_10"] - baseline["prior_median"]),
    )
    assert cells.eq(0).any()
    assert cells.gt(0).any()


def test_nearby_marks_uses_triangle_center_and_cutoff():
    centers = np.array([5.0, 15.0, 22.0, 45.0])
    positions = np.array([19.0, 5.0, 11.0, 2.0])
    expected = np.array([2.1, 1.2, 0.7, 0.0])
    np.testing.assert_allclose(_nearby_mark_weight(positions, centers), expected)
    np.testing.assert_array_equal(_nearby_mark_weight(np.array([]), centers), 0)


def test_shift_transport_only_uses_completed_earlier_transition():
    from submission.data import inspection_targets
    from submission.registration import shift_forecasts
    from submission.validation import DAYS_PER_YEAR, KEYS

    inputs = _fixture()
    grid = make_grid(inputs["passport"])
    first, second, cutoff = inputs["campaigns"]["date"]
    first_result, first_audit = predict_signal(inputs, grid, second, _metadata(inputs))
    np.testing.assert_array_equal(first_result["shift_transport"], first_result["shift_mix_10"])
    np.testing.assert_array_equal(first_result["shift_by_history"], first_result["shift_nearby_shrink"])
    assert first_audit["transport_transitions"] == 0

    vtd = inputs["vtd"]
    prior = vtd.loc[vtd["date"].eq(first)]
    duration = (second - first).days / DAYS_PER_YEAR
    prior_shift = shift_forecasts(grid, prior, duration)
    observed = inspection_targets(vtd.loc[vtd["date"].eq(second)], grid)
    joined = observed.merge(prior_shift, on=KEYS)
    rate = np.clip((joined["thickness_mm"] - joined["shift_mix_10"]).median() / duration, -0.35, 0.35)
    expected = rate * (cutoff - second).days / DAYS_PER_YEAR
    result, audit = predict_signal(inputs, grid, cutoff, _metadata(inputs))
    np.testing.assert_allclose(result["shift_transport"], result["shift_mix_10"] + expected)
    np.testing.assert_array_equal(result["shift_by_history"], result["shift_transport"])
    assert audit["transport_offset_mm"] == pytest.approx(expected)
    assert audit["transport_transitions"] == 1
    assert audit["transport_latest_end"] == "2021-01-01"


def test_benchmark_scores_every_model_on_identical_observed_and_fill_masks():
    inputs = _fixture()
    rows = signal_benchmark(inputs, _metadata(inputs))
    assert len(rows) == 2 * 2 * 10
    assert not rows.duplicated(["id", "cutoff", "model", "label_policy"]).any()
    assert rows.loc[rows["label_policy"].eq("observed"), "n"].eq(3).all()
    assert rows.loc[rows["label_policy"].eq("nominal_fill"), "n"].eq(7).all()


def test_spatial_blocks_score_paired_observations_and_keep_chainage_boundaries():
    rows = pd.DataFrame({
        "start_m": [490.0, 0.0, 500.0, 510.0, 1000.0],
        "thickness_mm": [5.0, 6.0, 7.0, np.nan, 5.0],
        "shift_mix_10": [4.0, 4.0, 6.0, 2.0, 5.0],
        "shift_nearby_shrink": [5.5, 5.5, 5.0, 8.0, 5.0],
    })
    blocks = _paired_spatial_blocks(rows)
    assert blocks["block_start_m"].tolist() == [0, 500, 1000]
    assert blocks["n_observed"].tolist() == [2, 1, 1]
    assert blocks["mae_gain_mm"].tolist() == [1.0, -1.0, 0.0]
    assert _paired_spatial_blocks(rows.iloc[[3]]).empty


def test_cli_preserves_other_report(tmp_path, monkeypatch):
    from submission.data import SOURCES

    inputs = _fixture()
    monkeypatch.setattr("submission.repeat_signal.load_inputs", lambda _: inputs)
    monkeypatch.setattr(
        "submission.repeat_signal.load_morphology", lambda _: _metadata(inputs)
    )
    data = tmp_path / "sources"
    data.mkdir()
    for source in SOURCES.values():
        (data / source).write_text("fixture")
    out = tmp_path / "report"
    out.mkdir()
    manifest_path = out / "manifest.json"
    manifest_path.write_text(json.dumps({"status": "other_experiment"}))
    args = ["--data-dir", str(data), "--out-dir", str(out)]
    with pytest.raises(SystemExit):
        main(args)
    assert not (out / "metrics.csv").exists()
    assert json.loads(manifest_path.read_text())["status"] == "other_experiment"

    manifest_path.unlink()
    assert main(args) == 0
    reported = pd.read_csv(out / "metrics.csv")
    manifest = json.loads(manifest_path.read_text())
    assert manifest["status"] == "repeat_signal_experiment"
    assert manifest["metrics_rows"] == len(reported) == 40
    assert manifest["nearby_mark_radius_m"] == 10
    assert manifest["spatial_block_m"] == 500
    blocks = pd.read_csv(out / "spatial_blocks.csv")
    assert len(blocks) == manifest["spatial_block_rows"] == 2
    assert blocks["n_observed"].tolist() == [3, 3]
    assert set(manifest["input_sha256"]) == set(SOURCES.values())
    assert len(manifest["campaign_format_ex_post"]) == 3
