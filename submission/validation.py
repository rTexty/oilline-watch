"""Historical evaluation by inspection date and operating direction."""

from collections.abc import Iterator

import numpy as np
import pandas as pd

from submission.features import build_features
from submission.models import cold_predictions, repeat_predictions

KEYS = ["id", "segment_id"]
DAYS_PER_YEAR = 365.25
METRIC_COLUMNS = [
    "case", "id", "direction", "start", "cutoff", "horizon_days", "model", "label_policy",
    "grid_n", "observed_n", "train_directions", "available", "n", "pearson_r", "pearson_r2",
    "mae_mm", "top10_recall",
]


def _unique_bottom(values: np.ndarray, count: int) -> np.ndarray | None:
    order = np.argsort(values, kind="stable")
    if count < len(order) and values[order[count - 1]] == values[order[count]]:
        return None
    return order[:count]


def metrics(actual, pred) -> dict:
    actual = np.asarray(actual, dtype=float)
    pred = np.asarray(pred, dtype=float)
    if actual.ndim != 1 or actual.shape != pred.shape:
        raise ValueError("Actual and predicted thickness must be aligned vectors")
    if not np.isfinite(pred).all():
        raise ValueError("Predictions must be finite")
    mask = np.isfinite(actual)
    y, p = actual[mask], pred[mask]
    n = len(y)
    r = None
    if n >= 3 and np.ptp(y) > 1e-12 and np.ptp(p) > 1e-12:
        r = float(np.clip(np.corrcoef(y, p)[0, 1], -1.0, 1.0))
    recall = None
    if n >= 2:
        k = (n + 9) // 10
        actual_bottom = _unique_bottom(y, k)
        pred_bottom = _unique_bottom(p, k)
        if actual_bottom is not None and pred_bottom is not None:
            recall = float(len(np.intersect1d(actual_bottom, pred_bottom)) / k)
    return {
        "n": n,
        "pearson_r": r,
        "pearson_r2": None if r is None else r * r,
        "mae_mm": float(np.mean(np.abs(y - p))) if n else None,
        "top10_recall": recall,
    }


def repeat_forecast(section: pd.DataFrame, labels: pd.DataFrame,
                    dates: pd.Series, cutoff: pd.Timestamp) -> tuple[pd.DataFrame, pd.Timestamp]:
    commissioned = section["commissioned"].iat[0]
    if cutoff <= commissioned:
        raise ValueError(f"Target date must be after commissioning for {section['id'].iat[0]}")
    before = dates.loc[dates.gt(commissioned) & dates.lt(cutoff)]
    if before.empty:
        raise ValueError(f"No previous VTD before {cutoff.date()}")
    previous = before.max()
    observed = labels.loc[labels["date"].eq(previous)]
    years = (cutoff - previous).days / DAYS_PER_YEAR
    return repeat_predictions(section, observed, years), previous


def cold_training_rows(inputs: dict, grid: pd.DataFrame, targets: pd.DataFrame) -> pd.DataFrame:
    first = inputs["campaigns"].groupby("id", as_index=False)["date"].min()
    candidates = first.merge(inputs["passport"], on="id", validate="one_to_one")
    usable = candidates.loc[candidates["date"].gt(candidates["commissioned"])]
    frames = []
    for row in usable.itertuples(index=False):
        section = grid.loc[grid["id"].eq(row.id)]
        measured = targets.loc[targets["id"].eq(row.id) & targets["date"].eq(row.date)]
        if measured.empty:
            continue
        features = build_features(section, inputs["profile"], inputs["regime"], row.commissioned, row.date)
        observed = features.merge(measured, on=KEYS, validate="one_to_one")
        frames.append(observed.assign(direction_id=row.direction_id, nominal_mm=row.nominal_mm))
    if frames:
        return pd.concat(frames, ignore_index=True)
    return pd.DataFrame(columns=[*KEYS, "direction_id", "date", "nominal_mm", "thickness_mm"])


def eligible_cold_training(examples: pd.DataFrame, direction: str, cutoff: pd.Timestamp) -> pd.DataFrame:
    return examples.loc[examples["direction_id"].ne(direction) & examples["date"].lt(cutoff)]


def cold_forecast(section: pd.DataFrame, inputs: dict, examples: pd.DataFrame,
                  cutoff: pd.Timestamp) -> tuple[pd.DataFrame, pd.DataFrame]:
    route = section.iloc[0]
    if cutoff <= route["commissioned"]:
        raise ValueError(f"Target date must be after commissioning for {route['id']}")
    train = eligible_cold_training(examples, route["direction_id"], cutoff)
    features = build_features(section, inputs["profile"], inputs["regime"], route["commissioned"], cutoff)
    return cold_predictions(section, features, train), train


def validate_prediction_keys(grid: pd.DataFrame, predictions: pd.DataFrame) -> None:
    for frame in (grid, predictions):
        if not set(KEYS).issubset(frame) or frame[KEYS].isna().any().any() or frame.duplicated(KEYS).any():
            raise ValueError("Segment keys must be present and unique")
    grid_keys = set(grid[KEYS].itertuples(index=False, name=None))
    prediction_keys = set(predictions[KEYS].itertuples(index=False, name=None))
    if not grid_keys or prediction_keys != grid_keys:
        raise ValueError("Prediction keys must exactly match the grid")


def _score(section: pd.DataFrame, labels: pd.DataFrame, predictions: pd.DataFrame,
           case: str, start: pd.Timestamp, cutoff: pd.Timestamp,
           training_directions: int = 0) -> Iterator[dict]:
    validate_prediction_keys(section, predictions)
    joined = section[[*KEYS, "nominal_mm"]].merge(predictions, on=KEYS, validate="one_to_one").merge(
        labels[[*KEYS, "thickness_mm"]], on=KEYS, how="left", validate="one_to_one")
    measured = joined["thickness_mm"]
    provisional = measured.fillna(joined["nominal_mm"])
    models = [c for c in predictions.columns if c not in KEYS]
    for model in models:
        for mask_name, actual in [("observed", measured), ("nominal_fill", provisional)]:
            available = model != "ridge" or bool(predictions.attrs["ridge_fitted"])
            yield {
                "case": case,
                "id": section["id"].iat[0],
                "direction": section["direction_id"].iat[0],
                "start": start.date().isoformat(),
                "cutoff": cutoff.date().isoformat(),
                "horizon_days": (cutoff - start).days,
                "model": model,
                "label_policy": mask_name,
                "grid_n": len(section),
                "observed_n": int(measured.notna().sum()),
                "train_directions": training_directions,
                "available": available,
                **(metrics(actual, joined[model]) if available else
                   dict(n=0, pearson_r=None, pearson_r2=None, mae_mm=None, top10_recall=None)),
            }


def backtest(inputs: dict, grid: pd.DataFrame, targets: pd.DataFrame, examples: pd.DataFrame) -> pd.DataFrame:
    records: list[dict] = []
    for section_id, campaigns in inputs["campaigns"].sort_values("date").groupby("id"):
        section = grid.loc[grid["id"].eq(section_id)]
        commissioned = section["commissioned"].iat[0]
        dates = campaigns["date"].reset_index(drop=True)
        labels = targets.loc[targets["id"].eq(section_id)]
        for i, cutoff in enumerate(dates):
            actual = labels.loc[labels["date"].eq(cutoff)]
            if actual.empty:
                continue
            if i and (dates.iloc[:i] > commissioned).any():
                predictions, start = repeat_forecast(section, labels, dates, cutoff)
                records.extend(_score(section, actual, predictions, "repeat", start, cutoff))
            elif i == 0 and cutoff > commissioned:
                predictions, train = cold_forecast(section, inputs, examples, cutoff)
                records.extend(_score(section, actual, predictions, "cold", section["commissioned"].iat[0],
                                      cutoff, train["direction_id"].nunique()))
    return pd.DataFrame.from_records(records, columns=METRIC_COLUMNS)
