import numpy as np
import pandas as pd

from submission.models import cold_predictions, repeat_predictions


def grid():
    return pd.DataFrame({'id': ['1'] * 3, 'segment_id': [0, 1, 2], 'start_m': [0., 10., 20.], 'end_m': [10., 20., 25.], 'center_m': [5., 15., 22.5], 'length_m': [25.] * 3, 'nominal_mm': [10.] * 3})


def assert_full_positive(result, cols):
    assert set(map(tuple, result[['id', 'segment_id']].to_numpy())) == {('1', 0), ('1', 1), ('1', 2)}
    assert not result.duplicated(['id', 'segment_id']).any()
    assert np.isfinite(result[cols].to_numpy(dtype=float)).all()
    assert (result[cols].to_numpy(dtype=float) > 0).all()


def test_repeat_with_sparse_and_empty_history_is_finite_on_full_grid():
    previous = pd.DataFrame({'id': ['1'], 'segment_id': [1], 'date': [pd.Timestamp('2020-01-01')], 'thickness_mm': [8.]})
    for history in (previous, previous.iloc[0:0]):
        assert_full_positive(repeat_predictions(grid(), history, years=2.), ['persistence', 'uniform', 'smooth'])


def test_cold_with_empty_training_and_missing_features_is_finite():
    features = pd.DataFrame({'id': ['1'] * 3, 'segment_id': [0, 1, 2], 'z': [np.nan, 1., np.nan]})
    train = pd.DataFrame(columns=['id', 'segment_id', 'date', 'nominal_mm', 'thickness_mm', 'z'])
    assert_full_positive(cold_predictions(grid(), features, train), ['nominal', 'physics', 'ridge'])
