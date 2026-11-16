import pandas as pd
from pandas.testing import assert_frame_equal

from submission.features import build_features


def test_regime_window_excludes_start_prior_and_cutoff_and_future():
    grid = pd.DataFrame({'id': ['1', '1'], 'segment_id': [0, 1], 'start_m': [0., 10.], 'end_m': [10., 20.], 'center_m': [5., 15.], 'length_m': [20., 20.], 'nominal_mm': [10., 10.]})
    profile = pd.DataFrame({'id': ['1', '1'], 'distance_m': [0., 20.], 'z_m': [1., 2.]})
    regime = pd.DataFrame({'id': ['1'] * 4, 'date': pd.to_datetime(['2019-12-31', '2020-01-01', '2021-01-01', '2021-01-02']), 'watercut': [90., 20., 80., 70.], 'v_mix': [90., 1., 80., 70.], 'v_liquid_true': [90., 1., 80., 70.], 't_start': [90., 1., 80., 70.], 't_end': [90., 1., 80., 70.]})
    args = (grid, profile)
    actual = build_features(*args, regime, pd.Timestamp('2020-01-01'), pd.Timestamp('2021-01-01'))
    expected = build_features(*args, regime.iloc[[1]], pd.Timestamp('2020-01-01'), pd.Timestamp('2021-01-01'))
    assert_frame_equal(actual.sort_index(axis=1), expected.sort_index(axis=1))
    assert set(actual.segment_id) == {0, 1}


def test_features_with_missing_profile_and_regime_cover_grid():
    grid = pd.DataFrame({'id': ['1', '1'], 'segment_id': [0, 1], 'start_m': [0., 10.], 'end_m': [10., 20.], 'center_m': [5., 15.], 'length_m': [20., 20.], 'nominal_mm': [10., 10.]})
    profile = pd.DataFrame({'id': ['1'], 'distance_m': [0.], 'z_m': [float('nan')]})
    regime = pd.DataFrame(columns=['id', 'date', 'watercut', 'v_mix', 'v_liquid_true', 't_start', 't_end'])
    result = build_features(grid, profile, regime, pd.Timestamp('2020-01-01'), pd.Timestamp('2021-01-01'))
    assert set(map(tuple, result[['id', 'segment_id']].to_numpy())) == {('1', 0), ('1', 1)}
