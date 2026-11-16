"""Exploratory 10 m cold-start forecasts on an inspection campaign grid."""

import numpy as np
import pandas as pd
from pandas.api.types import is_numeric_dtype
from sklearn.linear_model import LogisticRegression

from submission.features import GEOMETRY_FEATURES, REGIME_FEATURES, TERRAIN_RADII_M
from submission.models import (
    KEYS,
    MIN_THICKNESS_MM,
    _campaign_weights,
    _finite_features,
    _grid_with_nominal,
    _physics_prediction,
    _ridge_prediction,
    _standardize,
)


def geometry_forecasts(grid: pd.DataFrame, features: pd.DataFrame) -> pd.DataFrame:
    """Compare symmetric terrain and a basin oriented toward increasing chainage.

    The directional hypothesis assumes increasing chainage as its reference
    orientation. These features do not establish the actual flow direction.
    """
    names = [name for name in GEOMETRY_FEATURES if name in features]
    segments = _grid_with_nominal(grid).merge(
        features.loc[:, [*KEYS, *names]], how="left", on=KEYS, validate="one_to_one"
    )
    terrain = _finite_features(segments, names).fillna(0.0).clip(lower=0.0)
    symmetric = []
    directional = []
    zero = np.zeros(len(segments))
    for radius in TERRAIN_RADII_M:
        forward = terrain.get(f"forward_rise_m_{radius}m", zero)
        backward = terrain.get(f"backward_rise_m_{radius}m", zero)
        symmetric.append(terrain.get(f"trough_m_{radius}m", zero) / radius)
        directional.append(np.minimum(forward, 2.0 * backward) / radius)
    return segments[KEYS].assign(
        geometry_only=_physics_prediction(
            segments.assign(physics_risk=100.0 * np.mean(symmetric, axis=0))
        ),
        directional_basin=_physics_prediction(
            segments.assign(physics_risk=100.0 * np.mean(directional, axis=0))
        ),
    )


def _report_probability(segments, train, reported, names):
    """Fit the probability of an eligible thickness record in this dataset."""
    weights = _campaign_weights(train)
    source = _finite_features(train, names).dropna(axis=1, how="all")
    if source.shape[1] == 0:
        return np.full(len(segments), np.average(reported, weights=weights))
    medians = source.median()
    target = _finite_features(segments, source.columns.tolist()).fillna(medians)
    target = target.clip(lower=source.min(), upper=source.max(), axis="columns")
    source, target = _standardize(
        source.fillna(medians).to_numpy(dtype=float),
        target.to_numpy(dtype=float),
        weights,
    )
    classifier = LogisticRegression().fit(source, reported, sample_weight=weights)
    return classifier.predict_proba(target)[:, 1]


def _conditional_thickness(segments, observed, names):
    nominal = segments["nominal_mm"].to_numpy(dtype=float)
    relative_loss = 1.0 - observed["thickness_mm"] / observed["nominal_mm"]
    intercept = np.average(relative_loss, weights=_campaign_weights(observed))
    fallback = np.maximum(nominal * (1.0 - intercept), MIN_THICKNESS_MM)
    return _ridge_prediction(segments, observed, names, fallback)


def hurdle_forecasts(
    grid: pd.DataFrame, features: pd.DataFrame, train: pd.DataFrame
) -> pd.DataFrame:
    """Predict reported minima and their mixture with the nominal-fill assumption.

    Train contains every grid cell of eligible campaigns, including cells with
    no eligible thickness record. Report probability describes that recording
    event. Conditional Ridge retains signed losses relative to nominal because
    nominal wall thickness can differ from measured base metal thickness. An
    unweighted conditional fit provides a comparison for unweighted models.
    """
    names = [
        name
        for name in (*GEOMETRY_FEATURES, *REGIME_FEATURES, "physics_risk")
        if name in features
        and name in train
        and is_numeric_dtype(features[name])
        and is_numeric_dtype(train[name])
    ]
    segments = _grid_with_nominal(grid).merge(
        features.loc[:, [*KEYS, *names]], how="left", on=KEYS, validate="one_to_one"
    )
    nominal = segments["nominal_mm"].to_numpy(dtype=float)
    result = segments[KEYS].assign(
        report_probability=np.nan,
        hurdle_conditional=nominal,
        hurdle_conditional_unweighted=nominal,
        hurdle_expected=nominal,
    )
    if segments.empty or train.empty:
        reason = (
            "no target segments" if segments.empty else "no eligible training campaigns"
        )
        result.attrs.update(available=False, reason=reason)
        return result

    train = train.sort_values(["id", "date", "segment_id"], ignore_index=True)
    training_nominal = train["nominal_mm"].to_numpy(dtype=float)
    if not np.isfinite(training_nominal).all() or (training_nominal <= 0).any():
        raise ValueError("training nominal wall thickness must be finite and positive")
    measured = train["thickness_mm"].to_numpy(dtype=float)
    reported = np.isfinite(measured) & (measured > 0)
    if reported.sum() < 2 or reported.all():
        result.attrs.update(
            available=False, reason="need measured and unreported training cells"
        )
        return result

    feature_dtypes = dict.fromkeys(names, float)
    train = train.astype(feature_dtypes)
    segments = segments.astype(feature_dtypes)
    observed = train.loc[reported]
    conditional, ridge_fitted = _conditional_thickness(segments, observed, names)
    unweighted, _ = _conditional_thickness(
        segments, observed.drop(columns=["id", "date"]), names
    )
    probability = _report_probability(segments, train, reported, names)
    expected = probability * conditional + (1.0 - probability) * nominal
    fitted = result.assign(
        report_probability=probability,
        hurdle_conditional=conditional,
        hurdle_conditional_unweighted=unweighted,
        hurdle_expected=expected,
    )
    fitted.attrs.update(
        available=True, reason=None if ridge_fitted else "conditional intercept only"
    )
    return fitted
