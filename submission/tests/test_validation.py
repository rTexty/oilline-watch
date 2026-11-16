import numpy as np
import pandas as pd
import pytest

from submission.run import _priority, write_result
from submission.validation import metrics


def test_metrics_masks_unknown_actual_and_reports_signed_correlation():
    result = metrics([1., 2., 3., np.nan], [3., 2., 1., 99.])
    assert result['n'] == 3
    assert result['pearson_r'] == pytest.approx(-1.)
    assert result['pearson_r2'] == pytest.approx(1.)
    assert result['mae_mm'] == pytest.approx(4 / 3)
    assert result['top10_recall'] == pytest.approx(0.)


@pytest.mark.parametrize('actual,pred', [([1., 2.], [1., 2.]), ([1., 1., 1.], [1., 2., 3.])])
def test_metrics_undefined_correlation(actual, pred):
    result = metrics(actual, pred)
    assert result['pearson_r'] is None
    assert result['pearson_r2'] is None


def test_metrics_rejects_nonfinite_prediction_for_observed_actual():
    with pytest.raises(ValueError):
        metrics([1., 2., 3.], [1., np.nan, 3.])


def test_write_result_sorts_and_writes_exact_grid(tmp_path):
    grid = pd.DataFrame({'id': ['2', '1', '1'], 'segment_id': [0, 1, 0]})
    pred = pd.DataFrame({'id': ['1', '2', '1'], 'segment_id': [1, 0, 0], 'thickness_pred': [8., 9., 7.]})
    path = tmp_path / 'result.csv'
    write_result(grid, pred, path)
    result = pd.read_csv(path, dtype={'id': str})
    assert result.columns.tolist() == ['id', 'segment_id', 'thickness_pred']
    assert list(map(tuple, result.to_numpy())) == [('1', 0, 7.), ('1', 1, 8.), ('2', 0, 9.)]


def test_priority_matches_published_thickness_at_cutoff(tmp_path):
    grid = pd.DataFrame({'id': ['1'] * 11, 'segment_id': range(11)})
    grid = grid.assign(start_m=grid['segment_id'] * 10, end_m=(grid['segment_id'] + 1) * 10)
    prediction = grid[['id', 'segment_id']].assign(
        thickness_pred=[5., 6.0000000001, 6., *([7.] * 8)],
    )
    path = tmp_path / 'result.csv'
    write_result(grid, prediction, path)
    exported = pd.read_csv(path).sort_values(['thickness_pred', 'segment_id']).head(2)
    assert exported['segment_id'].tolist() == [0, 1]
    assert _priority(grid, prediction)['segment_id'].tolist() == exported['segment_id'].tolist()


@pytest.mark.parametrize('rows', [
    [('1', 0, 7.)],
    [('1', 0, 7.), ('1', 0, 8.)],
    [('1', 0, 7.), ('1', 2, 8.)],
    [('1', 0, 7.), ('1', 1, np.nan)],
    [('1', 0, 7.), ('1', 1, 0.)],
])
def test_write_result_rejects_bad_grid_or_values(tmp_path, rows):
    grid = pd.DataFrame({'id': ['1', '1'], 'segment_id': [0, 1]})
    pred = pd.DataFrame(rows, columns=['id', 'segment_id', 'thickness_pred'])
    with pytest.raises(ValueError):
        write_result(grid, pred, tmp_path / 'result.csv')
