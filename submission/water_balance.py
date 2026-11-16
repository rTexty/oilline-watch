"""Scenario for water storage in local terrain depressions on the 10 m grid."""

from math import fsum, isfinite, pi

import numpy as np
import pandas as pd

from submission.features import REGIME_FIELDS, _daily_regime, _finite_values, _terrain
from submission.models import KEYS, _grid_with_nominal, _physics_prediction

SCENARIO_DIAMETER_M = 0.219
CREST_RADIUS_M = 30
CAPTURE_FRACTION = 0.10
WASHOUT_SPEED_MPS = 0.30
SECONDS_PER_DAY = 86_400.0
EXPOSURE_RISK_SCALE = 10.0


def _storage_update(storage, capacity, inflow, flush_fraction):
    available = storage + inflow
    retained = np.minimum(available, capacity)
    remaining = retained * (1.0 - flush_fraction)
    return remaining, retained - remaining, available - retained


def step_storage(storage_m3, capacity_m3, inflow_m3, flush_fraction):
    """Return remaining, flushed and spilled volumes after a fill-then-flush step."""
    volumes = (storage_m3, capacity_m3, inflow_m3, storage_m3 + inflow_m3)
    if any(not isfinite(value) or value < 0 for value in volumes):
        raise ValueError(
            "Storage volumes and available mass must be finite and nonnegative"
        )
    if not 0 <= flush_fraction <= 1:
        raise ValueError("Flush fraction must be between zero and one")
    remaining, flushed, spilled = _storage_update(
        storage_m3, capacity_m3, inflow_m3, flush_fraction
    )
    return float(remaining), float(flushed), float(spilled)


def _capacity(section, profile, diameter_m, full_volume):
    # Center depth relative to the lower of two crests in the 30 m windows.
    terrain = _terrain(section, profile)
    depth = np.clip(
        np.nan_to_num(terrain[f"trough_m_{CREST_RADIUS_M}m"]), 0.0, diameter_m
    )
    radius = diameter_m / 2.0
    normalized_height = np.clip((radius - depth) / radius, -1.0, 1.0)
    fill_fraction = (
        np.arccos(normalized_height)
        - normalized_height * np.sqrt(np.maximum(0.0, 1.0 - normalized_height**2))
    ) / pi
    downstream_rise = np.nan_to_num(terrain[f"forward_rise_m_{CREST_RADIUS_M}m"])
    # The downstream crest hinders washout. The scenario doubles the reference
    # speed at a one-diameter rise and uses a bounded response above that rise.
    washout_speed = WASHOUT_SPEED_MPS * (
        1.0 + np.clip(downstream_rise / diameter_m, 0.0, 1.0)
    )
    return (
        np.clip(fill_fraction, 0.0, 1.0) * full_volume,
        washout_speed,
        int(np.sum(terrain["profile_covered"])),
    )


def _usable_days(regime, start, cutoff):
    fields = ["watercut", "v_mix"]
    values = _finite_values(regime, fields)
    valid = values["watercut"].between(0.0, 100.0) & values["v_mix"].ge(0.0)
    daily = _daily_regime(
        regime.loc[valid].reindex(columns=["id", "date", *REGIME_FIELDS]), start, cutoff
    )
    return dict(tuple(daily.groupby(level="id", sort=False)))


def _balance(days, capacity, full_volume, washout_speed, capture_volume):
    storage = np.zeros_like(capacity)
    exposure_sum = np.zeros_like(capacity)
    # Equal capture per eligible meter. Each section contributes one upstream
    # volume per day. Dry terrain cells receive zero of that volume.
    length_weights = np.where(capacity > 0.0, full_volume, 0.0)
    eligible_weight = length_weights.sum()
    weights = length_weights / eligible_weight if eligible_weight else length_weights
    previous_day = None
    allocated = spill = flushed = discarded = max_step_residual = 0.0
    for (_, date), watercut, speed in days[["watercut", "v_mix"]].itertuples():
        if previous_day is not None and (date - previous_day).days > 1:
            discarded += float(storage.sum())
            storage = np.zeros_like(capacity)
        previous_day = date
        inflow_m3 = speed * (capture_volume * (watercut / 100.0))
        if not isfinite(inflow_m3):
            raise ValueError("Scenario inflow exceeds the floating-point range")
        inflow = inflow_m3 * weights
        washout = -np.expm1(-speed / washout_speed)
        next_storage, day_flushed, day_spill = _storage_update(
            storage, capacity, inflow, washout
        )
        residual = (storage + inflow) - (next_storage + day_flushed + day_spill)
        max_step_residual = max(max_step_residual, float(np.abs(residual).sum()))
        allocated += float(inflow.sum())
        flushed += float(day_flushed.sum())
        spill += float(day_spill.sum())
        storage = next_storage
        exposure_sum += storage

    remaining = float(storage.sum())
    totals = {
        "observed_days": len(days),
        "last_observed_date": (
            previous_day.date().isoformat() if previous_day is not None else None
        ),
        "allocated_m3": allocated,
        "flushed_m3": flushed,
        "spilled_m3": spill,
        "discarded_at_gaps_m3": discarded,
        "remaining_m3": remaining,
        "mass_residual_m3": fsum((allocated, -flushed, -spill, -discarded, -remaining)),
        "max_step_mass_residual_m3": max_step_residual,
    }
    exposure = np.clip(exposure_sum / full_volume / max(len(days), 1), 0.0, 1.0)
    return exposure, totals


def water_balance_forecast(
    grid, profile, regime, start, cutoff, *, diameter_m=SCENARIO_DIAMETER_M
):
    """Return scenario capacity, mean observed-day storage fraction and proxy mm.

    Geometry treats the provided diameter as an effective bore for the scenario.
    Exposure equals mean post-flush volume divided by full cell volume across
    observed days. The millimeter mapping reuses Physics with a fixed risk scale.
    """
    grid_with_nominal = _grid_with_nominal(grid)
    if grid[KEYS].isna().any().any():
        raise ValueError("Segment grid keys must be present")
    lengths = (grid["end_m"] - grid["start_m"]).to_numpy(dtype=float)
    if not np.isfinite(lengths).all() or (lengths <= 0).any():
        raise ValueError("Segment lengths must be positive and finite")
    if not isfinite(diameter_m) or diameter_m <= 0:
        raise ValueError("Scenario diameter must be positive and finite")
    bore_area = pi * (diameter_m / 2.0) * (diameter_m / 2.0)
    capture_volume = bore_area * SECONDS_PER_DAY * CAPTURE_FRACTION
    full_volumes = bore_area * lengths
    if (
        not isfinite(capture_volume)
        or capture_volume == 0.0
        or (not np.isfinite(full_volumes).all() or (full_volumes <= 0.0).any())
    ):
        raise ValueError(
            "Scenario diameter and cell lengths must yield representable volumes"
        )
    start = pd.Timestamp(start).normalize()
    cutoff = pd.Timestamp(cutoff).normalize()
    if pd.isna(start) or pd.isna(cutoff) or cutoff < start:
        raise ValueError(
            "Forecast window requires valid dates with start at or before cutoff"
        )

    daily = _usable_days(regime, start, cutoff)
    empty_days = pd.DataFrame(columns=["watercut", "v_mix"])
    exposure = np.zeros(len(grid))
    capacity = np.zeros(len(grid))
    audits = []
    profile_groups = dict(tuple(profile.groupby("id", sort=False)))
    for section_id, positions in grid.groupby("id", sort=False).indices.items():
        section = grid.iloc[positions]
        local_profile = profile_groups.get(section_id, profile.iloc[:0])
        full_volume = full_volumes[positions]
        local_capacity, washout_speed, profile_cells = _capacity(
            section, local_profile, diameter_m, full_volume
        )
        capacity[positions] = local_capacity
        local_exposure, audit = _balance(
            daily.get(section_id, empty_days),
            local_capacity,
            full_volume,
            washout_speed,
            capture_volume,
        )
        exposure[positions] = local_exposure
        audits.append({"id": str(section_id), "profile_cells": profile_cells, **audit})

    forecast = _physics_prediction(
        grid_with_nominal.assign(physics_risk=EXPOSURE_RISK_SCALE * exposure)
    )
    result = grid[KEYS].assign(
        water_exposure=exposure, capacity_proxy_m3=capacity, water_balance_mm=forecast
    )
    residuals = [audit["mass_residual_m3"] for audit in audits]
    result.attrs["audit"] = {
        "diameter_m": diameter_m,
        "diameter_basis": "nominal outer diameter used as scenario bore",
        "crest_radius_m": CREST_RADIUS_M,
        "capacity_basis": "circular area below lower crest at segment center times segment length",
        "watercut_basis": "percent assumed",
        "regime_aggregation": "daily median speed and watercut from complete pairs",
        "capture_fraction": CAPTURE_FRACTION,
        "capture_allocation": "eligible segment length within section",
        "washout_speed_mps": WASHOUT_SPEED_MPS,
        "washout_basis": "reference speed times 1 + min(1, downstream crest rise / diameter)",
        "downstream_basis": "increasing local chainage assumed",
        "exposure_risk_scale": EXPOSURE_RISK_SCALE,
        "remaining_basis": "end of the last observed day",
        "mass_residual_m3": fsum(residuals),
        "max_step_mass_residual_m3": max(
            (audit["max_step_mass_residual_m3"] for audit in audits), default=0.0
        ),
        "sections": audits,
    }
    return result
