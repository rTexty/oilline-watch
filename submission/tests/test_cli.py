"""Exercise the executable using synthetic versions of the four source CSVs."""
import json
import subprocess
import sys

import pandas as pd
import pytest

from submission.data import PASSPORT_COLUMNS, PROFILE_COLUMNS, REGIME_COLUMNS, SOURCES, VTD_COLUMNS


def write_inputs(root):
    root.mkdir()
    passport = []
    profile = []
    regime = []
    vtd = []
    for ident in ('1', '2', '3'):
        passport.append([ident, ident, ident, .025, 10., '01.01.2000'])
        profile.extend([[ident, 0, 10], [ident, 10, 8], [ident, 25, 12]])
        regime.extend([[ident, '2019-01-01 00:00:00', 20, 1, 1, 20, 20],
                       [ident, '2020-01-01 00:00:00', 30, 1, 1, 20, 20]])
        if ident != '3':
            for date in (('2018-01-01', '2020-01-01') if ident == '1' else ('2019-01-01', '2020-01-01')):
                for distance, thickness in [(1, 9), (11, 8), (21, 7)]:
                    vtd.append([ident, date, distance, distance, thickness, 'потеря металла', '', 'false'])
    for name, columns, rows in [('passport', PASSPORT_COLUMNS, passport), ('profile', PROFILE_COLUMNS, profile),
                                ('regime', REGIME_COLUMNS, regime), ('vtd', VTD_COLUMNS, vtd)]:
        pd.DataFrame(rows, columns=list(columns)).to_csv(root / SOURCES[name], index=False)


def invoke(data, out, *args):
    return subprocess.run([sys.executable, '-m', 'submission.run', '--data-dir', str(data), '--out-dir', str(out), *args],
                          capture_output=True, text=True, check=False)


TARGETS = ('--repeat-id', '1', '--repeat-date', '2021-01-01', '--cold-id', '3', '--cold-date', '2021-01-01')


def test_cli_history_targets_reproducibility_and_future_data(tmp_path):
    data = tmp_path / 'data'
    write_inputs(data)
    out = tmp_path / 'out'
    historical = invoke(data, out)
    assert historical.returncode == 0, historical.stderr
    assert json.loads((out / 'manifest.json').read_text())['targets'] == 'historical_only'
    assert (out / 'forecast_metrics.csv').exists()
    assert not (out / 'result.csv').exists()

    candidate = invoke(data, out, *TARGETS)
    assert candidate.returncode == 0, candidate.stderr
    assert json.loads((out / 'manifest.json').read_text())['targets'] == 'candidate'
    first = (out / 'result.csv').read_bytes()
    results = pd.read_csv(out / 'result.csv', dtype={'id': str})
    assert list(results.columns) == ['id', 'segment_id', 'thickness_pred']
    assert list(zip(results.id, results.segment_id)) == [('1', 0), ('1', 1), ('1', 2), ('3', 0), ('3', 1), ('3', 2)]
    assert results.thickness_pred.gt(0).all()
    assert (out / 'priority.csv').exists()

    confirmed = invoke(data, out, *TARGETS, '--targets-confirmed', '--target-source', 'test fixture')
    assert confirmed.returncode == 0, confirmed.stderr
    manifest = json.loads((out / 'manifest.json').read_text())
    assert manifest['targets'] == 'confirmed_by_caller'
    assert manifest['target_source'] == 'test fixture'
    assert (out / 'result.csv').read_bytes() == first

    vtd = data / SOURCES['vtd']
    rows = pd.read_csv(vtd)
    future = pd.DataFrame([['1', '2022-01-01', 1, 1, 1., 'потеря металла', '', 'false']], columns=rows.columns)
    pd.concat([rows, future]).to_csv(vtd, index=False)
    regime = data / SOURCES['regime']
    rows = pd.read_csv(regime)
    future = pd.DataFrame([['3', '2021-01-01 00:00:00', 999, 999, 999, 999, 999]], columns=rows.columns)
    pd.concat([rows, future]).to_csv(regime, index=False)
    changed = invoke(data, out, *TARGETS)
    assert changed.returncode == 0, changed.stderr
    assert (out / 'result.csv').read_bytes() == first

    historical_again = invoke(data, out)
    assert historical_again.returncode != 0
    assert 'separate output directory' in historical_again.stderr
    assert (out / 'result.csv').read_bytes() == first
    assert json.loads((out / 'manifest.json').read_text())['targets'] == 'candidate'


@pytest.mark.parametrize('args', [('--repeat-id', '1'), TARGETS + ('--cold-id', '1'),
                                  ('--repeat-id', '1', '--repeat-date', 'bad', '--cold-id', '3', '--cold-date', '2021-01-01'),
                                  ('--repeat-id', '1', '--repeat-date', '2021-01-01', '--cold-id', '2', '--cold-date', '2021-01-01')])
def test_cli_rejects_invalid_target_configuration(tmp_path, args):
    data = tmp_path / 'data'
    write_inputs(data)
    result = invoke(data, tmp_path / 'out', *args)
    assert result.returncode != 0


def test_experimental_repeat_export_uses_its_own_output_and_keeps_cold_forecast(tmp_path):
    from submission.run import main

    data = tmp_path / 'data'
    write_inputs(data)
    baseline = tmp_path / 'baseline'
    trial = tmp_path / 'trial'
    args = ['--data-dir', str(data), *TARGETS]
    variant = ['--repeat-model', 'shift_by_history']
    assert main([*args, '--out-dir', str(baseline)]) == 0
    assert main([*args, '--out-dir', str(trial), *variant]) == 0
    reference = pd.read_csv(baseline / 'result.csv')
    experiment = pd.read_csv(trial / 'result.csv')
    pd.testing.assert_frame_equal(reference.loc[reference.id.eq(3)], experiment.loc[experiment.id.eq(3)])
    assert not reference.loc[reference.id.eq(1), 'thickness_pred'].equals(
        experiment.loc[experiment.id.eq(1), 'thickness_pred']
    )
    case = json.loads((trial / 'manifest.json').read_text())['cases'][0]
    assert case['model'] == 'shift_by_history'
    assert case['historical_transitions'] == 1
    with pytest.raises(SystemExit):
        main([*args, '--out-dir', str(baseline), *variant])
    with pytest.raises(SystemExit):
        main([*args, '--out-dir', str(trial)])
    pd.testing.assert_frame_equal(reference, pd.read_csv(baseline / 'result.csv'))
    (trial / 'manifest.json').unlink()
    for mode in ([], variant):
        with pytest.raises(SystemExit):
            main([*args, '--out-dir', str(trial), *mode])
    pd.testing.assert_frame_equal(experiment, pd.read_csv(trial / 'result.csv'))
    foreign = tmp_path / 'foreign'
    foreign.mkdir()
    receipt = foreign / 'manifest.json'
    receipt.write_text('{"status":"repeat_signal_experiment"}')
    for mode in ([], list(TARGETS), [*TARGETS, *variant]):
        with pytest.raises(SystemExit):
            main(['--data-dir', str(data), '--out-dir', str(foreign), *mode])
    assert receipt.read_text() == '{"status":"repeat_signal_experiment"}'


def test_report_gap_export_records_calibration_and_preserves_history_candidate(tmp_path):
    from submission.run import main

    data = tmp_path / 'data'
    write_inputs(data)
    source = data / SOURCES['vtd']
    rows = pd.read_csv(source)
    rows.assign(**{
        'Wall Thickness': 10,
        'Angle': 0,
        'Defect Depth in %': (10 - rows['Residual Wall Thickness']) * 10,
    }).to_csv(source, index=False)
    args = ['--data-dir', str(data), *TARGETS]
    history = tmp_path / 'history'
    gap = tmp_path / 'gap'
    assert main([*args, '--out-dir', str(history), '--repeat-model', 'shift_by_history']) == 0
    assert main([*args, '--out-dir', str(gap), '--repeat-model', 'shift_report_gap']) == 0
    manifest = json.loads((gap / 'manifest.json').read_text())
    assert manifest['cases'][0]['model'] == 'shift_report_gap'
    assert manifest['cases'][0]['gap_depth_floor_fraction'] == pytest.approx(0.1)
    old = (history / 'result.csv').read_bytes()
    with pytest.raises(SystemExit):
        main([*args, '--out-dir', str(history), '--repeat-model', 'shift_report_gap'])
    assert (history / 'result.csv').read_bytes() == old
    receipt = history / 'manifest.json'
    for invalid in ('{', 'null', '[]', '{"targets":"candidate","cases":[]}'):
        receipt.write_text(invalid)
        with pytest.raises(SystemExit) as rejected:
            main([*args, '--out-dir', str(history), '--repeat-model', 'shift_by_history'])
        assert rejected.value.code == 2
        assert receipt.read_text() == invalid
        assert (history / 'result.csv').read_bytes() == old


def test_in_process_runner_scores_fitted_ridge_and_empty_latest_campaign(tmp_path):
    from submission.run import main

    data = tmp_path / 'data'
    write_inputs(data)
    path = data / SOURCES['vtd']
    rows = pd.read_csv(path)
    # This campaign exists but has no valid measured metal-loss thickness.
    latest = pd.DataFrame([['1', '2020-06-01', 1, 1, 0., 'потеря металла', '', 'false']], columns=rows.columns)
    pd.concat([rows, latest]).to_csv(path, index=False)
    out = tmp_path / 'out'
    assert main(['--data-dir', str(data), '--out-dir', str(out), *TARGETS]) == 0
    manifest = json.loads((out / 'manifest.json').read_text())
    assert manifest['cases'][0]['start'] == '2020-06-01'
    scored = pd.read_csv(out / 'forecast_metrics.csv')
    ridge = scored.loc[(scored['case'] == 'cold') & (scored['id'] == 2) & (scored['model'] == 'ridge')]
    assert len(ridge) == 2
    assert ridge['available'].all()
    assert ridge['n'].eq(3).all()
    result = pd.read_csv(out / 'result.csv', dtype={'id': str})
    repeat = result.loc[result['id'] == '1', 'thickness_pred']
    assert repeat.gt(9.9).all()


def test_confirmed_targets_require_source(tmp_path):
    data = tmp_path / 'data'
    write_inputs(data)
    result = invoke(data, tmp_path / 'out', *TARGETS, '--targets-confirmed')
    assert result.returncode != 0
    assert 'source' in result.stderr.lower()


def test_history_without_campaigns_has_metrics_header(tmp_path):
    from submission.run import main

    data = tmp_path / 'data'
    write_inputs(data)
    path = data / SOURCES['vtd']
    pd.read_csv(path).iloc[:0].to_csv(path, index=False)
    out = tmp_path / 'out'
    assert main(['--data-dir', str(data), '--out-dir', str(out)]) == 0
    metrics = pd.read_csv(out / 'forecast_metrics.csv')
    assert metrics.empty
    assert {'case', 'id', 'model', 'n', 'pearson_r', 'mae_mm'}.issubset(metrics.columns)


def test_sample_result_checks_grid_before_publishing(tmp_path):
    data = tmp_path / 'data'
    write_inputs(data)
    out = tmp_path / 'out'
    sample = tmp_path / 'sample_result.csv'
    sample.write_text('id,segment_id,thickness_pred\n3,2,\n3,1,\n3,0,\n1,2,\n1,1,\n1,0,\n')
    flag = ('--sample-result', str(sample))
    result = invoke(data, out, *TARGETS, *flag)
    assert result.returncode == 0, result.stderr
    manifest = json.loads((out / 'manifest.json').read_text())
    assert manifest['targets'] == 'candidate'
    assert manifest['sample_result_grid_checked'] is True
    before = {name: (out / name).read_bytes() for name in ('result.csv', 'priority.csv', 'manifest.json')}

    sample.write_text('id,segment_id,thickness_pred\n3,1,\n3,0,\n1,2,\n1,1,\n1,0,\n')
    rejected = invoke(data, out, *TARGETS, *flag)
    assert rejected.returncode != 0
    assert 'missing 1' in rejected.stderr
    assert {name: (out / name).read_bytes() for name in before} == before

    no_targets = invoke(data, tmp_path / 'history', *flag)
    assert no_targets.returncode != 0
    assert '--sample-result requires all four target flags' in no_targets.stderr

    for name in ('result.csv', 'priority.csv', 'forecast_metrics.csv', 'manifest.json', '.pipetwin.lock'):
        self_sample = invoke(data, out, *TARGETS, '--sample-result', str(out / name))
        assert self_sample.returncode != 0
        assert f'must be separate from the output {name}' in self_sample.stderr
    assert {name: (out / name).read_bytes() for name in before} == before
