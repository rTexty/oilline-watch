"""Deterministic baseline forecasts on the canonical 10 m segment grid."""

import numpy as np
import pandas as pd
from pandas.api.types import is_numeric_dtype
from sklearn.linear_model import Ridge


KEYS = ["id", "segment_id"]
MIN_THICKNESS_MM = 0.01
UNIFORM_LOSS_MM_PER_YEAR = 0.1
PHYSICS_LOSS_SCALE = 0.25
RIDGE_ALPHA = 10.0


def _grid_with_nominal(grid: pd.DataFrame) -> pd.DataFrame:
    result = grid.loc[:, KEYS + ["nominal_mm"]].copy()
    nominal = result["nominal_mm"].to_numpy(dtype=float)
    if result.duplicated(KEYS).any():
        raise ValueError("segment grid keys must be unique")
    if not np.isfinite(nominal).all() or (nominal <= 0).any():
        raise ValueError("nominal wall thickness must be finite and positive")
    return result


def _neighbor_thickness(
    segments: pd.DataFrame, thickness: pd.Series
) -> pd.Series:
    """Average supplied thicknesses in the current bin and exactly adjacent bins."""
    values = segments.loc[:, KEYS].assign(thickness_mm=thickness)
    indexed = values.set_index(KEYS)["thickness_mm"]
    neighbors = pd.concat(
        [
            values.assign(segment_id=values["segment_id"] + shift)
            .set_index(KEYS)["thickness_mm"]
            .reindex(indexed.index)
            for shift in (-1, 0, 1)
        ],
        axis=1,
    )
    return neighbors.mean(axis=1).reset_index(drop=True)


def repeat_predictions(
    grid: pd.DataFrame, previous: pd.DataFrame, years: float = 0.0
) -> pd.DataFrame:
    """Predict after the latest prior, same-section campaign supplied by the caller."""
    if not np.isfinite(years) or years < 0:
        raise ValueError("forecast horizon must be finite and nonnegative")
    segments = _grid_with_nominal(grid).merge(
        previous.loc[:, KEYS + ["thickness_mm"]],
        how="left",
        on=KEYS,
        validate="one_to_one",
    )
    depth = segments["thickness_mm"]
    direct = depth.where(np.isfinite(depth) & (depth > 0))
    neighbor_mean = _neighbor_thickness(segments, direct)
    persistence = direct.fillna(segments["nominal_mm"])
    loss = years * UNIFORM_LOSS_MM_PER_YEAR
    uniform = (persistence - loss).clip(lower=MIN_THICKNESS_MM)
    observed_smooth = (0.5 * (direct + neighbor_mean)).fillna(neighbor_mean)
    smooth = observed_smooth.fillna(uniform)
    smooth_uniform = (observed_smooth - loss).clip(lower=MIN_THICKNESS_MM).fillna(uniform)
    persisted_mean = _neighbor_thickness(segments, persistence)
    nominal_blend_uniform = (0.5 * (persistence + persisted_mean) - loss).clip(
        lower=MIN_THICKNESS_MM
    )
    return segments.loc[:, KEYS].assign(
        persistence=persistence,
        uniform=uniform,
        smooth=smooth,
        smooth_uniform=smooth_uniform,
        nominal_blend_uniform=nominal_blend_uniform,
    )


def _physics_prediction(segments: pd.DataFrame) -> np.ndarray:
    nominal = segments["nominal_mm"].to_numpy(dtype=float)
    if "physics_risk" not in segments:
        return nominal
    risk = segments["physics_risk"].to_numpy(dtype=float)
    risk = np.where(np.isfinite(risk) & (risk >= 0), risk, 0.0)
    relative_loss = PHYSICS_LOSS_SCALE * (risk / (1.0 + risk))
    return np.maximum(nominal * (1.0 - relative_loss), MIN_THICKNESS_MM)


def _campaign_weights(train: pd.DataFrame) -> np.ndarray:
    campaign_keys = [name for name in ("id", "date") if name in train]
    if not campaign_keys:
        return np.ones(len(train), dtype=float)
    counts = train.groupby(campaign_keys, dropna=False)["thickness_mm"].transform("size")
    weights = 1.0 / counts.to_numpy(dtype=float)
    return weights / weights.mean()


def _finite_features(rows: pd.DataFrame, names: list[str]) -> pd.DataFrame:
    return rows.loc[:, names].replace([np.inf, -np.inf], np.nan)


def _standardize(
    source: np.ndarray, target: np.ndarray, weights: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    # Center on an observed row first so constant columns stay exactly zero.
    reference = source[0]
    shifted = source - reference
    mean = np.average(shifted, axis=0, weights=weights)
    centered = shifted - mean
    rms = np.sqrt(np.average(np.square(centered), axis=0, weights=weights))
    tolerance = 16 * np.finfo(float).eps * np.abs(source).max(axis=0)
    scales = np.where(rms > tolerance, rms, 1.0)
    return centered / scales, (target - reference - mean) / scales


def _ridge_prediction(
    segments: pd.DataFrame, train: pd.DataFrame, names: list[str], physics: np.ndarray
) -> tuple[np.ndarray, bool]:
    if train.empty or not names:
        return physics, False
    nominal = train["nominal_mm"].to_numpy(dtype=float)
    measured = train["thickness_mm"].to_numpy(dtype=float)
    valid = np.isfinite(nominal) & np.isfinite(measured) & (nominal > 0) & (measured > 0)
    if valid.sum() < 2:
        return physics, False

    train = train.loc[valid]
    source = _finite_features(train, names).dropna(axis=1, how="all")
    if source.empty:
        return physics, False
    medians = source.median()
    target = _finite_features(segments, source.columns.tolist()).fillna(medians)
    target = target.clip(lower=source.min(), upper=source.max(), axis="columns")
    source = source.fillna(medians)

    weights = _campaign_weights(train)
    source_matrix, target_matrix = _standardize(
        source.to_numpy(dtype=float), target.to_numpy(dtype=float), weights
    )
    relative_loss = 1.0 - measured[valid] / nominal[valid]
    regressor = Ridge(alpha=RIDGE_ALPHA).fit(source_matrix, relative_loss, sample_weight=weights)
    thickness = segments["nominal_mm"].to_numpy(dtype=float) * (
        1.0 - regressor.predict(target_matrix)
    )
    return np.maximum(thickness, MIN_THICKNESS_MM), True


def cold_predictions(
    grid: pd.DataFrame, features: pd.DataFrame, train: pd.DataFrame
) -> pd.DataFrame:
    """Predict an initial inspection from static and cutoff-safe features."""
    reserved = {*KEYS, "date", "nominal_mm", "thickness_mm"}
    supplied = [name for name in features if name not in reserved]
    segments = _grid_with_nominal(grid).merge(
        features.loc[:, KEYS + supplied],
        how="left",
        on=KEYS,
        validate="one_to_one",
    )
    shared_numeric = [
        name for name in supplied
        if name in train and is_numeric_dtype(features[name]) and is_numeric_dtype(train[name])
    ]
    physics = _physics_prediction(segments)
    ridge, fitted = _ridge_prediction(segments, train, shared_numeric, physics)
    result = segments.loc[:, KEYS].assign(
        nominal=segments["nominal_mm"], physics=physics, ridge=ridge
    )
    result.attrs["ridge_fitted"] = fitted
    return result
