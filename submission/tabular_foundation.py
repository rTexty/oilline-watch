"""Optional local TabICLv2 challenger for initial-inspection forecasts."""

from hashlib import file_digest
from pathlib import Path
from time import perf_counter

import numpy as np
import pandas as pd

from submission.features import GEOMETRY_FEATURES, REGIME_FEATURES
from submission.models import KEYS, MIN_THICKNESS_MM


CHECKPOINT_NAME = "tabicl-regressor-v2-20260212.ckpt"
CHECKPOINT_URL = (
    "https://huggingface.co/jingang/TabICL/resolve/"
    f"d700cf089377a49ad3cf4d74e3e151c84dfe28b8/{CHECKPOINT_NAME}"
)
CHECKPOINT_SHA256 = "0db9cb538f114e79026bf08f45f41ad8dd7ad2de2aaca9a5ca8cd3bd9748ae7a"
MODEL_COLUMN = "tabicl_conditional"
MODEL_FEATURES = (*GEOMETRY_FEATURES, *REGIME_FEATURES, "physics_risk")
ENSEMBLE_SIZE = 4
CPU_THREADS = 4
SEED = 42


def verify_checkpoint(checkpoint: Path) -> None:
    """Verify the official checkpoint before passing it to the model loader."""
    with checkpoint.open("rb") as stream:
        digest = file_digest(stream, "sha256").hexdigest()
    if digest != CHECKPOINT_SHA256:
        raise ValueError(f"TabICLv2 checkpoint SHA-256 mismatch: {checkpoint}")


def _unavailable(grid: pd.DataFrame, reason: str, started: float) -> pd.DataFrame:
    result = grid.loc[:, KEYS].assign(**{MODEL_COLUMN: np.nan})
    result.attrs.update(
        available=False, reason=reason, elapsed_seconds=perf_counter() - started
    )
    return result


def _predict_loss(
    source: pd.DataFrame, target: pd.DataFrame, loss: np.ndarray, checkpoint: Path
) -> np.ndarray:
    try:
        from tabicl import TabICLRegressor
    except ImportError as exc:
        raise RuntimeError(
            "Install submission/requirements-tabicl.txt to run TabICLv2"
        ) from exc

    model = TabICLRegressor(
        model_path=checkpoint,
        allow_auto_download=False,
        device="cpu",
        use_amp=False,
        n_estimators=ENSEMBLE_SIZE,
        batch_size=2,
        n_jobs=CPU_THREADS,
        random_state=SEED,
    )
    return np.asarray(model.fit(source, loss).predict(target), dtype=float)


def tabicl_forecasts(
    grid: pd.DataFrame, features: pd.DataFrame, train: pd.DataFrame, checkpoint: Path
) -> pd.DataFrame:
    """Estimate thickness conditional on an observed loss in the eligible history."""
    started = perf_counter()
    verify_checkpoint(checkpoint)
    if train.empty:
        return _unavailable(grid, "No eligible observed training rows", started)

    train_nominal = train["nominal_mm"].to_numpy(dtype=float)
    measured = train["thickness_mm"].to_numpy(dtype=float)
    valid = (
        np.isfinite(train_nominal)
        & np.isfinite(measured)
        & (train_nominal > 0)
        & (measured > 0)
    )
    if valid.sum() < 2:
        return _unavailable(
            grid, "Fewer than two valid thickness measurements", started
        )

    shared = [name for name in MODEL_FEATURES if name in features and name in train]
    source = (
        train.loc[valid, shared]
        .replace([np.inf, -np.inf], np.nan)
        .dropna(axis=1, how="all")
    )
    if source.empty:
        return _unavailable(
            grid, "No populated features in eligible training rows", started
        )

    columns = source.columns.tolist()
    aligned = grid.loc[:, KEYS + ["nominal_mm"]].merge(
        features.loc[:, KEYS + columns], on=KEYS, how="left", validate="one_to_one"
    )
    nominal = aligned["nominal_mm"].to_numpy(dtype=float)
    if not np.isfinite(nominal).all() or (nominal <= 0).any():
        raise ValueError("TabICLv2 requires finite positive nominal thickness")
    target = aligned.loc[:, columns].replace([np.inf, -np.inf], np.nan)
    observed_loss = 1.0 - measured[valid] / train_nominal[valid]
    # Reuse predictions for identical feature vectors so numerical noise cannot rank tied segments.
    target_index = pd.MultiIndex.from_frame(target)
    unique_target = target.loc[~target_index.duplicated()]
    unique_loss = _predict_loss(source, unique_target, observed_loss, checkpoint)
    if unique_loss.shape != (len(unique_target),) or not np.isfinite(unique_loss).all():
        raise RuntimeError("TabICLv2 returned invalid relative-loss predictions")

    predicted_loss = unique_loss[
        pd.MultiIndex.from_frame(unique_target).get_indexer(target_index)
    ]
    thickness = np.maximum(nominal * (1.0 - predicted_loss), MIN_THICKNESS_MM)
    result = aligned.loc[:, KEYS].assign(**{MODEL_COLUMN: thickness})
    result.attrs.update(
        available=True, reason=None, elapsed_seconds=perf_counter() - started
    )
    return result
