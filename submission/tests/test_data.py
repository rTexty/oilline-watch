import pandas as pd

from submission.data import inspection_targets, make_grid


def test_grid_includes_partial_tail_and_half_open_boundaries():
    passport = pd.DataFrame([{'id': '123', 'main_id': '1', 'direction_id': '2', 'length_m': 20.5, 'nominal_mm': 10., 'commissioned': pd.Timestamp('2000-01-01')}])
    grid = make_grid(passport)
    assert list(grid.segment_id) == [0, 1, 2]
    assert list(grid.start_m) == [0, 10, 20]
    assert list(grid.end_m) == [10, 20, 20.5]
    assert list(grid.center_m) == [5, 15, 20.25]
    assert not grid.duplicated(['id', 'segment_id']).any()


def test_targets_only_positive_finite_observations_inside_grid_and_minimum():
    grid = make_grid(pd.DataFrame([{'id': '123', 'main_id': '1', 'direction_id': '2', 'length_m': 20.5, 'nominal_mm': 10., 'commissioned': pd.Timestamp('2000-01-01')}]))
    vtd = pd.DataFrame({'id': ['123'] * 9, 'date': [pd.Timestamp('2020-01-01')] * 9,
                        'distance_m': [-0.1, 0, 9.99, 10, 20, 20.49, 20.5, 1, 2],
                        'thickness_mm': [1., 8., 7., 6., 9., 8., 1., float('nan'), -1.]})
    targets = inspection_targets(vtd, grid).sort_values('segment_id')
    assert targets.segment_id.tolist() == [0, 1, 2]
    assert targets.thickness_mm.tolist() == [7., 6., 8.]


def test_unmeasured_segments_are_not_reported_as_nominal():
    grid = make_grid(pd.DataFrame([{'id': '123', 'main_id': '1', 'direction_id': '2', 'length_m': 20., 'nominal_mm': 10., 'commissioned': pd.Timestamp('2000-01-01')}]))
    vtd = pd.DataFrame({'id': ['123'], 'date': [pd.Timestamp('2020-01-01')], 'distance_m': [2.], 'thickness_mm': [8.]})
    assert inspection_targets(vtd, grid).segment_id.tolist() == [0]
