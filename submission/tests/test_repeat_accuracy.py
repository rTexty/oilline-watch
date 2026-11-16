import json

import numpy as np
import pandas as pd
import pytest

from submission.data import make_grid
from submission.repeat_accuracy import (
    local_prior_forecasts,
    repeat_benchmark,
    repeat_predict,
    shift_family_diagnostics,
)
from submission.registration import SHIFT_COLUMNS


def _fixture():
    dates = pd.to_datetime(["2020-01-01", "2021-01-01", "2022-01-01"])
    passport = pd.DataFrame(
        {
            "id": ["P"],
            "main_id": ["M"],
            "direction_id": ["D"],
            "length_m": [65.0],
            "nominal_mm": [8.0],
            "commissioned": pd.to_datetime(["2018-01-01"]),
        }
    )
    campaigns = pd.DataFrame({"id": ["P"] * 3, "date": dates})
    values = [[5.0, 6.0, 7.0], [4.9, 5.8, 6.9], [5.1, 6.0, 6.0]]
    vtd = pd.DataFrame(
        [
            {"id": "P", "date": date, "distance_m": distance, "thickness_mm": thickness}
            for date, measurements in zip(dates, values, strict=True)
            for distance, thickness in zip([9.0, 19.0, 61.0], measurements, strict=True)
        ]
    )
    return {"passport": passport, "campaigns": campaigns, "vtd": vtd}


def test_predict_uses_only_strictly_prior_campaigns():
    inputs = _fixture()
    grid = make_grid(inputs["passport"])
    cutoff = pd.Timestamp("2021-01-01")
    baseline, provenance = repeat_predict(inputs, grid, cutoff)
    raw = inputs["vtd"].assign(
        thickness_mm=inputs["vtd"]["thickness_mm"].where(
            inputs["vtd"]["date"] < cutoff, 0.01
        )
    )
    mutated, changed_provenance = repeat_predict({**inputs, "vtd": raw}, grid, cutoff)
    pd.testing.assert_frame_equal(baseline, mutated)
    assert provenance == changed_provenance
    assert provenance["prior_transition_count"] == 0
    assert provenance["source_date"] == "2020-01-01"


def test_completed_transition_prior_date_and_exact_grid():
    inputs = _fixture()
    grid = make_grid(inputs["passport"])
    estimates, provenance = repeat_predict(inputs, grid, pd.Timestamp("2022-01-01"))
    assert provenance["prior_transition_count"] == 1
    assert provenance["source_date"] == "2021-01-01"
    assert len(estimates) == 7
    assert estimates["segment_id"].tolist() == list(range(7))
    assert np.isfinite(
        estimates.filter(regex="^(prior_|local_|shrunk|shift_mix|uniform)").to_numpy()
    ).all()


def test_all_missing_prior_remains_a_named_fallback():
    inputs = _fixture()
    grid = make_grid(inputs["passport"])
    empty_raw = inputs["vtd"].iloc[:0]
    result = local_prior_forecasts(grid, empty_raw, horizon_years=1)
    assert result["prior_median"].tolist() == pytest.approx([7.9] * 7)
    assert result["local_marked"].tolist() == pytest.approx([7.9] * 7)


def test_historical_scores_use_same_masks_and_no_duplicate_keys():
    metrics, diagnostics = repeat_benchmark(_fixture())
    sizes = metrics.groupby(["cutoff", "label_policy"])["n"].unique().to_dict()
    assert list(sizes["2021-01-01", "observed"]) == [3]
    assert list(sizes["2021-01-01", "nominal_fill"]) == [7]
    assert not metrics.duplicated(["id", "cutoff", "model", "label_policy"]).any()
    assert len(diagnostics) == 2
    assert (
        diagnostics["diagnostic_clipped_shift_hull_mae_mm"]
        .le(diagnostics["diagnostic_nearest_shift_mae_mm"])
        .all()
    )
    assert diagnostics["diagnostic_nominal_fill_shift_hull_mae_mm"].notna().all()


def test_shared_shift_weights_are_less_flexible_than_block_or_cell_weights():
    # Blocks need different weights. The unmeasured cell must not enter the fit.
    predictions = pd.DataFrame({
        "start_m": [0, 10, 20, 100, 110, 500],
        "shift_mix_10": [6] * 6,
        **{
            ("uniform" if name == "shift_zero_mm" else name): [4 if index < 3 else 8] * 6
            for index, name in enumerate(SHIFT_COLUMNS)
        },
    })
    report = shift_family_diagnostics(
        pd.Series([4.0, 4.0, 8.0, 8.0, 8.0, np.nan]), predictions
    )
    assert report["diagnostic_shared_shift_mix_mae_mm"] == pytest.approx(8 / 5)
    assert report["diagnostic_block_100m_shift_mix_mae_mm"] == pytest.approx(4 / 5)
    assert report["diagnostic_block_20m_shift_mix_mae_mm"] == 0
    assert report["diagnostic_clipped_shift_hull_mae_mm"] == 0
    assert shift_family_diagnostics(
        pd.Series([4.0, 4.0, 8.0, 8.0, 8.0, 10.0]), predictions
    )["diagnostic_clipped_shift_hull_mae_mm"] == pytest.approx(2 / 6)


def test_reject_typo_precommissioned_fold():
    inputs = _fixture()
    with pytest.raises(ValueError, match="previous"):
        repeat_predict(
            inputs, make_grid(inputs["passport"]), pd.Timestamp("2020-01-01")
        )


def test_positive_affine_shrink_preserves_pearson_on_each_mask():
    metrics, _ = repeat_benchmark(_fixture())
    old = metrics.loc[metrics.model.eq("shift_mix_10"), "pearson_r"].to_numpy()
    new = metrics.loc[metrics.model.eq("shift_half_shrink"), "pearson_r"].to_numpy()
    np.testing.assert_allclose(old, new, atol=1e-12)


def test_cli_keeps_other_experiment_receipt(tmp_path, monkeypatch):
    from submission.data import SOURCES
    from submission.repeat_accuracy import main

    root = tmp_path / "inputs"
    root.mkdir()
    for name in SOURCES.values():
        (root / name).write_text("fixture")
    monkeypatch.setattr("submission.repeat_accuracy.load_inputs", lambda _: _fixture())
    out = tmp_path / "out"
    out.mkdir()
    receipt = out / "manifest.json"
    receipt.write_text(json.dumps({"status": "historical_experiment"}))
    args = ["--data-dir", str(root), "--out-dir", str(out)]
    with pytest.raises(SystemExit):
        main(args)
    assert not (out / "metrics.csv").exists()
    assert json.loads(receipt.read_text())["status"] == "historical_experiment"

    receipt.unlink()
    assert main(args) == 0
    manifest = json.loads(receipt.read_text())
    assert manifest["status"] == "repeat_accuracy_experiment"
    assert manifest["metrics_rows"] == 28
    assert set(manifest["input_sha256"]) == set(SOURCES.values())
