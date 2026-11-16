"""Normalize inspection input tables and build measured targets on the local 10 m grid."""

from pathlib import Path

import numpy as np
import pandas as pd

SEGMENT_M = 10
PASSPORT_PREFIX = "Данные по протяжённости в структуре сети OISPIPE Паспортизация_"
SOURCES = {
    "passport": "pot_south.csv",
    "profile": "altitudes_south.csv",
    "regime": "tech_mode_for_embedings_with_length_with_temperatures_ids16.csv",
    "vtd": "vtd_south_train.csv",
}
PASSPORT_COLUMNS = {
    PASSPORT_PREFIX + "ID простого участка трубопровода": "id",
    PASSPORT_PREFIX + "ID основного участка трубопровода": "main_id",
    PASSPORT_PREFIX + "ID направления трубопровода": "direction_id",
    PASSPORT_PREFIX + "L простого участка, км": "length_m",
    "Общие данные_Толщина  стенки по исполнительной доку-ии, мм": "nominal_mm",
    "Общие данные_Дата ввода": "commissioned",
}
PROFILE_COLUMNS = {"id": "id", "total_distance": "distance_m", "z": "z_m"}
REGIME_VALUES = ("watercut", "v_mix", "v_liquid_true", "t_start", "t_end")
REGIME_COLUMNS = {
    "simple_section_id": "id",
    "calc_date": "date",
    **{name: name for name in REGIME_VALUES},
}
VTD_COLUMNS = {
    "id": "id",
    "date": "date",
    "Distance": "distance_m",
    "Distance_adjusted": "adjusted_m",
    "Residual Wall Thickness": "thickness_mm",
    "trait": "trait",
    "Feature Description": "description",
    "is_beyond_pot": "beyond",
}


def load_inputs(data_dir: Path | str) -> dict[str, pd.DataFrame]:
    """Read the allowed fields and preserve VTD campaign keys even without labels."""
    root = Path(data_dir)
    passport = _load_passport(root)
    profile = _load_profile(root, passport)
    regime = _load_regime(root, passport)
    vtd, campaigns = _load_vtd(root, passport)
    return {
        "passport": passport,
        "profile": profile,
        "regime": regime,
        "vtd": vtd,
        "campaigns": campaigns,
    }


def _read(root: Path, source: str, columns: dict[str, str]) -> pd.DataFrame:
    path = root / SOURCES[source]
    try:
        raw = pd.read_csv(path, usecols=list(columns), dtype=str, keep_default_na=False)
    except ValueError as exc:
        raise ValueError(f"{path.name}: {exc}") from exc
    return raw.rename(columns=columns).loc[:, list(columns.values())]


def _normalize_id(raw: pd.Series) -> pd.Series:
    return raw.str.strip().str.extract(r"^([0-9]+)(?:\.0+)?$", expand=False)


def _numeric(raw: pd.Series) -> pd.Series:
    values = pd.to_numeric(raw, errors="coerce").astype(float)
    return values.where(np.isfinite(values))


def _load_passport(root: Path) -> pd.DataFrame:
    raw = _read(root, "passport", PASSPORT_COLUMNS)
    passport = raw.assign(
        id=_normalize_id(raw["id"]),
        main_id=raw["main_id"].str.strip(),
        direction_id=raw["direction_id"].str.strip(),
        length_m=_numeric(raw["length_m"]).mul(1000).round(9),
        nominal_mm=_numeric(raw["nominal_mm"]),
        commissioned=pd.to_datetime(
            raw["commissioned"].str.strip(), format="%d.%m.%Y", errors="coerce"
        ),
    )
    _validate_geometry(passport)
    if passport["commissioned"].isna().any():
        raise ValueError("Passport commissioning dates must use DD.MM.YYYY")
    if passport[["main_id", "direction_id"]].eq("").any().any():
        raise ValueError(
            "Passport main and direction IDs are required for grouped validation"
        )
    return passport.sort_values("id", ignore_index=True)


def _validate_geometry(passport: pd.DataFrame) -> None:
    if (
        passport.empty
        or passport["id"].isna().any()
        or passport["id"].duplicated().any()
    ):
        raise ValueError("Passport must contain unique, valid section IDs")
    geometry = passport[["length_m", "nominal_mm"]].to_numpy(dtype=float)
    if not np.isfinite(geometry).all() or (geometry <= 0).any():
        raise ValueError(
            "Passport length and nominal thickness must be positive and finite"
        )


def _load_profile(root: Path, passport: pd.DataFrame) -> pd.DataFrame:
    raw = _read(root, "profile", PROFILE_COLUMNS)
    values = raw.assign(
        id=_normalize_id(raw["id"]),
        distance_m=_numeric(raw["distance_m"]),
        z_m=_numeric(raw["z_m"]),
    )
    known = values["id"].isin(passport["id"])
    valid_geometry = values["distance_m"].ge(0) & values["z_m"].notna()
    result = values.loc[known & valid_geometry].sort_values(
        ["id", "distance_m"], kind="stable", ignore_index=True
    )
    result.attrs["audit"] = {
        "input_rows": len(raw),
        "unknown_id": int((~known).sum()),
        "invalid_geometry": int((known & ~valid_geometry).sum()),
        "duplicate_distance_rows": int(result.duplicated(["id", "distance_m"]).sum()),
        "retained_rows": len(result),
    }
    return result


def _load_regime(root: Path, passport: pd.DataFrame) -> pd.DataFrame:
    raw = _read(root, "regime", REGIME_COLUMNS)
    values = raw.assign(
        id=_normalize_id(raw["id"]),
        date=pd.to_datetime(
            raw["date"].str.strip(), format="%Y-%m-%d %H:%M:%S", errors="coerce"
        ).dt.normalize(),
        **{name: _numeric(raw[name]) for name in REGIME_VALUES},
    )
    known = values["id"].isin(passport["id"])
    valid_date = values["date"].notna()
    result = values.loc[known & valid_date].sort_values(
        ["id", "date"], kind="stable", ignore_index=True
    )
    result.attrs["audit"] = {
        "input_rows": len(raw),
        "unknown_id": int((~known).sum()),
        "invalid_date": int((known & ~valid_date).sum()),
        "duplicate_day_rows": int(result.duplicated(["id", "date"]).sum()),
        "retained_rows": len(result),
    }
    return result


def _load_vtd(root: Path, passport: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    raw = _read(root, "vtd", VTD_COLUMNS)
    data = raw.assign(
        id=_normalize_id(raw["id"]),
        date=pd.to_datetime(
            raw["date"].str.strip(), format="%Y-%m-%d", errors="coerce"
        ),
        distance_m=_numeric(raw["distance_m"]),
        thickness_mm=_numeric(raw["thickness_mm"]),
    )
    known = data["id"].isin(passport["id"])
    valid_date = data["date"].notna()
    campaigns = data.loc[known & valid_date, ["id", "date"]].drop_duplicates()
    candidates = data.loc[known & valid_date]
    trait = candidates["trait"].str.strip().str.casefold()
    legacy_loss = trait.eq("") & candidates[
        "description"
    ].str.strip().str.casefold().str.startswith("потеря металла")
    metal_loss = trait.eq("потеря металла") | legacy_loss
    has_thickness = candidates["thickness_mm"].gt(0)
    beyond = candidates["beyond"].str.strip().str.casefold().eq("true")
    length = candidates["id"].map(passport.set_index("id")["length_m"])
    in_bounds = candidates["distance_m"].ge(0) & candidates["distance_m"].lt(length)
    eligible = metal_loss & has_thickness & ~beyond & in_bounds
    result = candidates.loc[eligible, ["id", "date", "distance_m", "thickness_mm"]]
    result = result.sort_values(
        ["id", "date", "distance_m"], kind="stable", ignore_index=True
    )
    adjusted = _numeric(candidates["adjusted_m"])
    result.attrs["audit"] = {
        "input_rows": len(raw),
        "unknown_id": int((~known).sum()),
        "invalid_date": int((known & ~valid_date).sum()),
        "non_metal_loss": int((~metal_loss).sum()),
        "invalid_thickness_on_metal_loss": int((metal_loss & ~has_thickness).sum()),
        "flagged_beyond_passport": int(beyond.sum()),
        "out_of_grid_or_missing_distance": int((~in_bounds).sum()),
        "both_chainages_present": int(
            (candidates["distance_m"].notna() & adjusted.notna()).sum()
        ),
        "adjusted_chainage_differs": int(
            candidates["distance_m"].sub(adjusted).abs().gt(1e-6).sum()
        ),
        "retained_rows": len(result),
    }
    return result, campaigns.sort_values(["id", "date"], ignore_index=True)


def make_grid(passport: pd.DataFrame) -> pd.DataFrame:
    """Create half-open section-local segments, including the partial tail."""
    _validate_geometry(passport)
    registry = passport.sort_values("id").reset_index(drop=True)
    lengths = registry["length_m"].to_numpy(dtype=float)
    counts = np.ceil(lengths / SEGMENT_M).astype(int)
    rows = registry.iloc[np.repeat(np.arange(len(registry)), counts)].reset_index(
        drop=True
    )
    ids = np.arange(len(rows)) - np.repeat(counts.cumsum() - counts, counts)
    start = SEGMENT_M * ids
    end = np.minimum(start + SEGMENT_M, rows["length_m"].to_numpy(dtype=float))
    return rows.assign(
        segment_id=ids, start_m=start, end_m=end, center_m=(start + end) / 2
    )


def inspection_targets(vtd: pd.DataFrame, grid: pd.DataFrame) -> pd.DataFrame:
    """Return one observed residual minimum per section, date, and segment."""
    distance = pd.to_numeric(vtd["distance_m"], errors="coerce")
    thickness = pd.to_numeric(vtd["thickness_mm"], errors="coerce")
    valid = (
        np.isfinite(distance)
        & distance.ge(0)
        & np.isfinite(thickness)
        & thickness.gt(0)
    )
    valid &= vtd["date"].notna()
    readings = vtd.loc[valid, ["id", "date"]].assign(
        distance_m=distance[valid],
        thickness_mm=thickness[valid],
        segment_id=(distance[valid] // SEGMENT_M).astype(int),
    )
    merged = readings.merge(
        grid[["id", "segment_id", "start_m", "end_m"]],
        on=["id", "segment_id"],
        validate="many_to_one",
    )
    in_bounds = merged["distance_m"].ge(merged["start_m"]) & merged["distance_m"].lt(
        merged["end_m"]
    )
    return (
        merged.loc[in_bounds]
        .groupby(["id", "date", "segment_id"], as_index=False)["thickness_mm"]
        .min()
    )
