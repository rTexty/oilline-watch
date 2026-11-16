"""Generate and run a deterministic pipeline forecast using invented data."""

import argparse
import csv
import io
from math import cos, exp, pi, sin
from pathlib import Path

from submission.data import (
    PASSPORT_COLUMNS,
    PROFILE_COLUMNS,
    REGIME_COLUMNS,
    SOURCES,
    VTD_COLUMNS,
)
from submission.run import main as forecast

REPEAT_ID = "900000001"
FIRST_INSPECTION_ID = "900000002"
FORECAST_DATE = "2025-01-01"
ROUTES = ((REPEAT_ID, 420, 9.8), (FIRST_INSPECTION_ID, 540, 8.6))
MORPHOLOGY = ("Wall Thickness", "Angle", "Defect Depth in %")


def write_csv(path, columns, rows):
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(columns)
    writer.writerows(rows)
    payload = buffer.getvalue().encode("utf-8")
    try:
        with path.open("xb") as file:
            file.write(payload)
    except FileExistsError:
        if path.read_bytes() != payload:
            raise ValueError(
                f"Input already exists and differs from the example: {path}"
            ) from None


def make_passports():
    for index, (route_id, length_m, nominal_mm) in enumerate(ROUTES, start=1):
        yield (
            route_id,
            f"SYNTHETIC-{index}",
            f"DEMO-{index}",
            length_m / 1000,
            nominal_mm,
            "01.01.2018",
        )


def make_profiles():
    for index, (route_id, length_m, _) in enumerate(ROUTES, start=1):
        for distance_m in range(0, length_m + 1, 5):
            fraction = distance_m / length_m
            elevation = (
                120 + 8 * cos((2 + index) * pi * fraction) + 2 * sin(11 * pi * fraction)
            )
            yield route_id, distance_m, round(elevation, 4)


def make_regimes():
    for route_id, _, _ in ROUTES:
        for year in range(2018, 2025):
            for month in range(1, 13):
                phase = 2 * pi * month / 12
                watercut = 44 + 12 * sin(phase) + 2 * (year - 2018)
                velocity = 0.55 + 0.2 * cos(phase)
                inlet = 39 + 4 * sin(phase)
                yield (
                    route_id,
                    f"{year}-{month:02d}-15 00:00:00",
                    round(watercut, 3),
                    round(velocity, 3),
                    round(0.87 * velocity, 3),
                    round(inlet, 3),
                    round(inlet - 3, 3),
                )


def make_inspections():
    _, length_m, nominal_mm = ROUTES[0]
    for age, inspection_date in enumerate(("2021-01-01", "2023-01-01")):
        for segment_id, start_m in enumerate(range(0, length_m, 10)):
            if 16 <= segment_id <= 19 or segment_id % 7 == 6:
                continue
            distance_m = start_m + 4 + 2 * age
            fraction = distance_m / length_m
            loss = 0.6 + 1.7 * exp(-(((fraction - 0.66) / 0.13) ** 2))
            loss += 0.16 * age + 0.24 * sin(13 * pi * fraction) ** 2
            yield (
                REPEAT_ID,
                inspection_date,
                distance_m,
                distance_m,
                round(nominal_mm - loss, 4),
                "потеря металла",
                "Synthetic metal loss",
                "false",
                nominal_mm,
                (segment_id * 37) % 360,
                round(loss / nominal_mm * 100, 4),
            )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "workspace", type=Path, help="Directory for generated inputs and forecasts"
    )
    workspace = parser.parse_args().workspace
    inputs = workspace / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    for name, columns, rows in (
        ("passport", PASSPORT_COLUMNS, make_passports()),
        ("profile", PROFILE_COLUMNS, make_profiles()),
        ("regime", REGIME_COLUMNS, make_regimes()),
        ("vtd", (*VTD_COLUMNS, *MORPHOLOGY), make_inspections()),
    ):
        write_csv(inputs / SOURCES[name], columns, rows)

    output = workspace / "forecast"
    status = forecast(
        [
            "--data-dir",
            str(inputs),
            "--out-dir",
            str(output),
            "--repeat-id",
            REPEAT_ID,
            "--repeat-date",
            FORECAST_DATE,
            "--cold-id",
            FIRST_INSPECTION_ID,
            "--cold-date",
            FORECAST_DATE,
            "--repeat-model",
            "shift_report_gap",
        ]
    )
    if status == 0:
        print(f"Synthetic wall-thickness predictions: {output / 'result.csv'}")
    return status


if __name__ == "__main__":
    raise SystemExit(main())
