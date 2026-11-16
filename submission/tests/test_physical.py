"""Behavioral checks for physical registration and storage accounting."""

import numpy as np
import pytest

from submission.landmarks import fit_monotone
from submission.water_balance import step_storage


def test_landmark_mapping_honors_anchors_and_is_monotone():
    source = np.array([0.0, 10.0, 30.0])
    target = np.array([2.0, 15.0, 35.0])
    mapping = fit_monotone(source, target)

    np.testing.assert_allclose(mapping(source), target)
    assert np.all(np.diff(mapping(np.linspace(0, 30, 301))) >= 0)
    assert np.isfinite(mapping(5.0))


def test_landmark_mapping_extrapolates_with_unit_slope():
    mapping = fit_monotone([0.0, 10.0, 30.0], [2.0, 15.0, 35.0])
    np.testing.assert_allclose(mapping(np.array([-10.0, -1.0, 31.0, 40.0])),
                               [-8.0, 1.0, 36.0, 45.0])


@pytest.mark.parametrize("source,target", [
    ([], []),
    ([1.0], [2.0]),
    ([0.0, 0.0], [1.0, 2.0]),
    ([0.0, 1.0], [2.0, 2.0]),
    ([0.0, 1.0, 2.0], [0.0, 2.0, 1.0]),
    ([0.0, float('nan')], [0.0, 1.0]),
    ([0.0, 1.0], [0.0, float('inf')]),
    ([0.0, 1.0], [0.0]),
])
def test_landmark_mapping_rejects_invalid_anchors(source, target):
    with pytest.raises(ValueError):
        fit_monotone(source, target)


@pytest.mark.parametrize("storage,capacity,inflow,fraction", [
    (0.0, 100.0, 0.0, 0.0),
    (10.0, 100.0, 20.0, 0.0),
    (10.0, 100.0, 20.0, 1.0),
    (90.0, 100.0, 30.0, 0.25),
    (0.0, 0.0, 30.0, 0.5),
    (120.0, 100.0, 0.0, 0.0),
])
def test_water_balance_conserves_water_and_obeys_bounds(storage, capacity, inflow, fraction):
    remaining, flushed, spill = step_storage(storage, capacity, inflow, fraction)
    assert 0 <= remaining <= capacity
    assert flushed >= 0
    assert spill >= 0
    assert remaining + flushed + spill == pytest.approx(storage + inflow)


@pytest.mark.parametrize("args", [
    (-1.0, 10.0, 0.0, 0.0),
    (0.0, -1.0, 0.0, 0.0),
    (0.0, 10.0, -1.0, 0.0),
    (0.0, 10.0, 0.0, -0.1),
    (0.0, 10.0, 0.0, 1.1),
    (float('nan'), 10.0, 0.0, 0.0),
    (0.0, float('inf'), 0.0, 0.0),
    (0.0, 10.0, float('nan'), 0.0),
    (0.0, 10.0, 0.0, float('nan')),
])
def test_water_balance_rejects_invalid_inputs(args):
    with pytest.raises(ValueError):
        step_storage(*args)


def test_physical_experiment_in_process_and_output_isolation(tmp_path):
    import json
    import pandas as pd
    from submission.physical_experiment import main
    from submission.tests.test_cli import write_inputs

    data = tmp_path / 'data'
    write_inputs(data)
    from submission.data import SOURCES
    path = data / SOURCES['vtd']
    raw = pd.read_csv(path)
    raw = raw.loc[~((raw['id'].astype(str) == '1') & (raw['date'] == '2018-01-01') & (raw['Distance'] == 21))].copy()
    raw['Reference Point 1 (Against Flow)'] = 'start'
    raw['Distance to Reference Point 1, m'] = raw['Distance']
    raw['Reference Point 2 (With Flow)'] = 'end'
    raw['Distance to Reference Point 2, m'] = 25 - raw['Distance']
    raw.to_csv(path, index=False)
    out = tmp_path / 'physical'
    args = ['--data-dir', str(data), '--out-dir', str(out),
            '--cold-id', '3', '--cold-date', '2021-01-01']
    assert main(args) == 0
    manifest = json.loads((out / 'manifest.json').read_text())
    metrics = pd.read_csv(out / 'water_metrics.csv', dtype={'id': str})
    ledger = pd.read_csv(out / 'water_ledger.csv', dtype={'id': str})
    candidate = pd.read_csv(out / 'candidate_water_scenario.csv', dtype={'id': str})
    assert manifest['counts']['water_metrics'] == len(metrics) == 24
    assert manifest['counts']['water_ledger'] == len(ledger) == 3
    assert manifest['counts']['candidate_water_scenario'] == len(candidate) == 3
    assert set(candidate.id) == {'3'}
    assert set(metrics.id) == {'1', '2'}
    assert set(metrics.label_policy) == {'observed', 'nominal_fill'}
    assert metrics.grid_n.eq(3).all()
    first = metrics.loc[metrics.id == '1']
    assert first.observed_n.eq(2).all()
    assert first.loc[first.label_policy == 'observed', 'n'].eq(2).all()
    assert first.loc[first.label_policy == 'nominal_fill', 'n'].eq(3).all()
    assert metrics.loc[metrics.id == '2', 'n'].eq(3).all()
    assert ledger.historical.sum() == 2
    assert ledger.mass_residual_m3.abs().max() < 1e-8
    assert ledger.max_step_mass_residual_m3.abs().max() < 1e-8
    assert not (out / 'result.csv').exists()

    protected = tmp_path / 'protected'
    protected.mkdir()
    (protected / 'result.csv').write_text('keep me')
    with pytest.raises(SystemExit):
        main(['--data-dir', str(data), '--out-dir', str(protected)])
    assert (protected / 'result.csv').read_text() == 'keep me'
    assert not (protected / 'manifest.json').exists()


def test_water_forecast_cutoff_dry_and_gap_conservation(tmp_path):
    import pandas as pd
    from submission.data import load_inputs, make_grid
    from submission.tests.test_cli import write_inputs
    from submission.water_balance import water_balance_forecast

    data = tmp_path / 'data'
    write_inputs(data)
    inputs = load_inputs(data)
    grid = make_grid(inputs['passport'])
    grid = grid.loc[grid.id == '1']
    regime = inputs['regime'].loc[inputs['regime'].id == '1'].copy()
    start, cutoff = pd.Timestamp('2018-01-01'), pd.Timestamp('2021-01-01')
    forecast = water_balance_forecast(grid, inputs['profile'], regime, start, cutoff)
    extra = regime.iloc[[0]].assign(date=pd.Timestamp('2022-01-01'), watercut=100, v_mix=999)
    changed = water_balance_forecast(grid, inputs['profile'], pd.concat([regime, extra]), start, cutoff)
    pd.testing.assert_frame_equal(forecast, changed)
    dry = water_balance_forecast(grid, inputs['profile'], regime.assign(watercut=0), start, cutoff)
    assert dry.water_exposure.eq(0).all()
    assert dry.attrs['audit']['sections'][0]['allocated_m3'] == 0
    audit = forecast.attrs['audit']['sections'][0]
    assert audit['discarded_at_gaps_m3'] > 0
    assert abs(audit['mass_residual_m3']) < 1e-8
