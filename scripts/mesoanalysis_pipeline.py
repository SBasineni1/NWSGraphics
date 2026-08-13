#!/usr/bin/env python3
"""Build hourly RAP mesoanalysis payloads for every CONUS graphics view.

The request path never opens or decodes GRIB.  This publisher downloads one bounded
slice of the latest RAP analysis, samples it onto the lat/lon lattices the graphics suite
already owns, and writes small JSON objects which the Node publisher uploads to R2.

Only ``publish()`` imports NumPy/SciPy/ecCodes.  Keeping those imports lazy lets the
cycle/index/meteorology helpers remain unit-testable without native GRIB dependencies.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable


NOMADS_ROOT = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/rap/prod"
SPC_ROOT = "https://www.spc.noaa.gov/exper/mesoanalysis"
USER_AGENT = "NWSGraphics mesoanalysis publisher (github.com/suchitbasineni/NWSGraphics)"

PRODUCT_IDS = (
    "surfaceCape",
    "surfaceCin",
    "mixedLayerCape",
    "mixedLayerCin",
    "mostUnstableCape",
    "lowLevelLapseRate",
    "midLevelLapseRate",
    "lclHeight",
    "precipitableWater",
    "stormRelativeHelicity1km",
    "stormRelativeHelicity3km",
    "bulkShear6km",
)

# SPC's fixed comparison sectors.  Nearest-centre selection is intentional: their
# sectors overlap substantially, and choosing the closest centre gives each CWA the most
# useful comparison frame without maintaining a brittle 121-office lookup table.
SPC_SECTORS = {
    11: (-120.0, 45.0),  # Pacific Northwest
    12: (-114.0, 34.0),  # Southwest
    13: (-101.0, 45.0),  # Northern Plains
    14: (-98.0, 39.0),   # Central Plains
    15: (-97.0, 32.0),   # Southern Plains
    16: (-74.0, 44.0),   # Northeast
    17: (-77.0, 39.0),   # Mid-Atlantic
    18: (-83.0, 32.0),   # Southeast
    20: (-88.0, 41.0),   # Midwest
    21: (-86.0, 45.0),   # Great Lakes
    22: (-113.0, 40.0),  # Great Basin
}

SPC_PRODUCTS = {
    # SPC combines SBCAPE contours and SBCIN shading in one comparison image.
    "surfaceCape": "sbcp",
    "surfaceCin": "sbcp",
    "mixedLayerCape": "mlcp",
    "mixedLayerCin": "mlcp",
    "mostUnstableCape": "mucp",
    "lowLevelLapseRate": "lllr",
    "midLevelLapseRate": "laps",
    "lclHeight": "lclh",
    "precipitableWater": "pwtr",
    "stormRelativeHelicity1km": "srh1",
    "stormRelativeHelicity3km": "srh3",
    "bulkShear6km": "shr6",
}


@dataclass(frozen=True)
class IndexRecord:
    number: str
    offset: int
    description: str


def parse_index(text: str) -> list[IndexRecord]:
    records: list[IndexRecord] = []
    for line in text.splitlines():
        match = re.match(r"^([^:]+):(\d+):(.*)$", line.strip())
        if match:
            records.append(IndexRecord(match.group(1), int(match.group(2)), match.group(3)))
    if not records:
        raise ValueError("RAP index contained no GRIB records")
    return records


def record_span(records: list[IndexRecord]) -> tuple[int, int]:
    """Return a single inclusive byte range covering every field we need.

    RAP keeps the 200--1000-mb profile, surface fields, helicity, and parcel diagnostics
    in one contiguous section. One ~15 MB request is kinder to NOMADS than dozens of tiny
    requests and also leaves ecCodes a valid concatenation of complete GRIB messages.
    """

    # Six kilometres AGL reaches nearly 200 mb over the highest Rockies, so the profile
    # must extend this high or national bulk shear develops terrain-shaped holes.
    first = next((record for record in records if ":HGT:200 mb:anl:" in f":{record.description}"), None)
    last_index = next((i for i, record in enumerate(records) if ":HGT:level of free convection:anl:" in f":{record.description}"), None)
    if first is None or last_index is None:
        raise ValueError("RAP pressure file is missing the 200-mb profile or parcel diagnostics")
    if last_index + 1 >= len(records):
        raise ValueError("RAP index cannot determine the end of the parcel diagnostics")
    return first.offset, records[last_index + 1].offset - 1


def lcl_height_metres(temperature_kelvin: float, dewpoint_kelvin: float) -> float | None:
    """Approximate surface-parcel LCL height AGL from the temperature/dewpoint spread."""

    if not math.isfinite(temperature_kelvin) or not math.isfinite(dewpoint_kelvin):
        return None
    # The operational rule of thumb is about 125 m per °C of dewpoint depression.  It is
    # deliberately named/labelled as derived; SPC runs a full parcel sounding routine.
    return max(0.0, min(5000.0, 125.0 * (temperature_kelvin - dewpoint_kelvin)))


def lapse_rate_c_per_km(
    surface_temperature: float,
    surface_height: float,
    profile: Iterable[tuple[float, float]],
    depth_metres: float = 3000.0,
) -> float | None:
    """Interpolate profile temperature at ``depth_metres`` AGL and return T0-Ttop / km."""

    if not math.isfinite(surface_temperature) or not math.isfinite(surface_height):
        return None
    target = surface_height + depth_metres
    levels = sorted((height, temperature) for height, temperature in profile if math.isfinite(height) and math.isfinite(temperature) and height >= surface_height - 50)
    for (lower_height, lower_temperature), (upper_height, upper_temperature) in zip(levels, levels[1:]):
        if lower_height <= target <= upper_height and upper_height > lower_height:
            fraction = (target - lower_height) / (upper_height - lower_height)
            top_temperature = lower_temperature + (upper_temperature - lower_temperature) * fraction
            return (surface_temperature - top_temperature) / (depth_metres / 1000.0)
    return None


def pressure_layer_lapse_rate(
    lower_temperature: float,
    lower_height: float,
    upper_temperature: float,
    upper_height: float,
) -> float | None:
    """Temperature lapse rate between two pressure surfaces in degrees C per km."""

    values = (lower_temperature, lower_height, upper_temperature, upper_height)
    if not all(math.isfinite(value) for value in values) or upper_height <= lower_height:
        return None
    return (lower_temperature - upper_temperature) / ((upper_height - lower_height) / 1000.0)


def bulk_shear_knots(
    surface_u: float,
    surface_v: float,
    surface_height: float,
    profile: Iterable[tuple[float, float, float]],
    depth_metres: float = 6000.0,
) -> float | None:
    """Interpolate wind at ``depth_metres`` AGL and return surface-to-top shear."""

    if not all(math.isfinite(value) for value in (surface_u, surface_v, surface_height)):
        return None
    target = surface_height + depth_metres
    levels = sorted(
        (height, u_wind, v_wind)
        for height, u_wind, v_wind in profile
        if all(math.isfinite(value) for value in (height, u_wind, v_wind)) and height >= surface_height - 50
    )
    for (lower_height, lower_u, lower_v), (upper_height, upper_u, upper_v) in zip(levels, levels[1:]):
        if lower_height <= target <= upper_height and upper_height > lower_height:
            fraction = (target - lower_height) / (upper_height - lower_height)
            top_u = lower_u + (upper_u - lower_u) * fraction
            top_v = lower_v + (upper_v - lower_v) * fraction
            return math.hypot(top_u - surface_u, top_v - surface_v) * 1.9438444924406
    return None


def spc_sector(longitude: float, latitude: float, office: str = "") -> int:
    if office == "US":
        return 19
    cosine = max(0.25, math.cos(math.radians(latitude)))
    return min(
        SPC_SECTORS,
        key=lambda sector: ((longitude - SPC_SECTORS[sector][0]) * cosine) ** 2 + (latitude - SPC_SECTORS[sector][1]) ** 2,
    )


def spc_archive_urls(valid_time: datetime, sector: int) -> dict[str, str]:
    stamp = valid_time.astimezone(timezone.utc).strftime("%y%m%d%H")
    return {
        product: f"{SPC_ROOT}/s{sector}/{spc_name}/{spc_name}_{stamp}.gif"
        for product, spc_name in SPC_PRODUCTS.items()
    }


def cycle_parts(value: datetime) -> tuple[str, str]:
    utc = value.astimezone(timezone.utc)
    return utc.strftime("%Y%m%d"), utc.strftime("%H")


def rap_urls(cycle: datetime) -> tuple[str, str]:
    day, hour = cycle_parts(cycle)
    base = os.environ.get("MESO_NOMADS_ROOT", NOMADS_ROOT).rstrip("/")
    grib = f"{base}/rap.{day}/rap.t{hour}z.awp130pgrbf00.grib2"
    return grib, f"{grib}.idx"


def fetch_bytes(url: str, byte_range: tuple[int, int] | None = None, timeout: int = 45) -> bytes:
    headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    if byte_range:
        headers["Range"] = f"bytes={byte_range[0]}-{byte_range[1]}"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = response.read()
        if byte_range and response.status != 206:
            raise RuntimeError(f"{url} ignored the requested byte range")
        return data


def discover_cycle(now: datetime | None = None) -> tuple[datetime, str, list[IndexRecord]]:
    # Probe the current hour first. RAP f00 usually appears late in the hour, so early
    # probes fall through to the previous cycle while a :50-ish probe can publish the
    # new one without deliberately holding it back for another hour.
    cursor = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    last_error: Exception | None = None
    for age in range(8):
        cycle = cursor - timedelta(hours=age)
        grib_url, index_url = rap_urls(cycle)
        try:
            records = parse_index(fetch_bytes(index_url, timeout=20).decode("utf-8"))
            record_span(records)
            return cycle, grib_url, records
        except (OSError, RuntimeError, ValueError, urllib.error.HTTPError) as error:
            last_error = error
    raise RuntimeError(f"No complete RAP analysis found in the last eight cycles: {last_error}")


def parse_cycle(value: str) -> datetime:
    try:
        return datetime.strptime(value, "%Y%m%d%H").replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise argparse.ArgumentTypeError("cycle must be YYYYMMDDHH") from error


def finite(value: float) -> float | None:
    return float(value) if math.isfinite(float(value)) and abs(float(value)) < 1e20 else None


def decode_fields(grib_bytes: bytes):
    """Decode the downloaded RAP span into scalar grids and a pressure profile."""

    import numpy as np
    from eccodes import codes_get, codes_get_array, codes_grib_multi_support_on, codes_grib_new_from_file, codes_release

    scalars: dict[str, np.ndarray] = {}
    heights: dict[int, np.ndarray] = {}
    temperatures: dict[int, np.ndarray] = {}
    u_winds: dict[int, np.ndarray] = {}
    v_winds: dict[int, np.ndarray] = {}
    latitudes = longitudes = None

    # RAP packages U/V pairs as multi-field GRIB messages. Without this switch ecCodes
    # returns only the first component and 0-6 km shear silently becomes unavailable.
    codes_grib_multi_support_on()
    with tempfile.NamedTemporaryFile(suffix=".grib2") as temporary:
        temporary.write(grib_bytes)
        temporary.flush()
        # ecCodes' CFFI layer needs a real buffered file, not NamedTemporaryFile's
        # Python wrapper object (the latter cannot be converted to ``FILE *``).
        with open(temporary.name, "rb") as handle:
            while True:
                gid = codes_grib_new_from_file(handle)
                if gid is None:
                    break
                try:
                    short_name = str(codes_get(gid, "shortName"))
                    level_type = str(codes_get(gid, "typeOfLevel"))
                    level = int(codes_get(gid, "level"))
                    values = np.asarray(codes_get_array(gid, "values"), dtype=np.float64)
                    values[np.abs(values) >= 1e20] = np.nan
                    if latitudes is None:
                        latitudes = np.asarray(codes_get_array(gid, "latitudes"), dtype=np.float64)
                        longitudes = np.asarray(codes_get_array(gid, "longitudes"), dtype=np.float64)
                        longitudes = np.where(longitudes > 180, longitudes - 360, longitudes)

                    if level_type == "isobaricInhPa" and 200 <= level <= 1000:
                        if short_name in {"gh", "z"}:
                            heights[level] = values / 9.80665 if short_name == "z" else values
                        elif short_name == "t":
                            temperatures[level] = values
                        elif short_name == "u":
                            u_winds[level] = values
                        elif short_name == "v":
                            v_winds[level] = values
                    elif level_type == "surface":
                        if short_name in {"cape", "cin", "sp", "pres", "gh", "orog"}:
                            scalars[short_name] = values
                    elif level_type == "heightAboveGround" and level == 2:
                        if short_name in {"2t", "t"}:
                            scalars["temperature2m"] = values
                        elif short_name in {"2d", "dpt"}:
                            scalars["dewpoint2m"] = values
                    elif level_type == "heightAboveGround" and level == 10:
                        if short_name in {"10u", "u"}:
                            scalars["wind10u"] = values
                        elif short_name in {"10v", "v"}:
                            scalars["wind10v"] = values
                    elif level_type == "heightAboveGroundLayer" and short_name == "hlcy":
                        top_level = int(codes_get(gid, "topLevel"))
                        if top_level in {1000, 3000}:
                            scalars[f"helicity{top_level}"] = values
                    elif level_type == "pressureFromGroundLayer" and short_name in {"cape", "cin"}:
                        top_level = int(codes_get(gid, "topLevel"))
                        if top_level == 9000:
                            scalars["mixedLayerCape" if short_name == "cape" else "mixedLayerCin"] = values
                        elif top_level == 25500:
                            scalars["mostUnstableCape" if short_name == "cape" else "mostUnstableCin"] = values
                    elif short_name == "pwat":
                        scalars["pwat"] = values
                finally:
                    codes_release(gid)

    if latitudes is None or longitudes is None:
        raise RuntimeError("RAP GRIB span decoded no grid")
    required = {
        "cape", "cin", "temperature2m", "dewpoint2m", "pwat", "wind10u", "wind10v",
        "helicity1000", "helicity3000", "mixedLayerCape", "mixedLayerCin", "mostUnstableCape",
    }
    missing = sorted(required - scalars.keys())
    surface_height_key = "gh" if "gh" in scalars else "orog" if "orog" in scalars else None
    if missing or surface_height_key is None:
        raise RuntimeError(f"RAP GRIB span is missing fields: {', '.join(missing + ([] if surface_height_key else ['surface height']))}")
    common_levels = sorted(set(heights) & set(temperatures) & set(u_winds) & set(v_winds), reverse=True)
    if len(common_levels) < 8:
        raise RuntimeError("RAP GRIB span has an incomplete 200--1000-mb temperature/height/wind profile")
    return latitudes, longitudes, scalars, heights, temperatures, u_winds, v_winds, surface_height_key, common_levels


def load_view_points(root: Path, office: str) -> list[dict]:
    grid_path = root / "public" / "gridpoints" / f"{office}.json"
    city_path = root / "public" / "cities" / f"{office}.json"
    if not grid_path.exists():
        return []
    grid = json.loads(grid_path.read_text())
    cities = json.loads(city_path.read_text()) if city_path.exists() else []
    points = [
        {"id": point["id"], "name": "", "state": "", "lat": point["lat"], "lon": point["lon"], "label": False}
        for point in grid
    ]
    points.extend(
        {"id": city["id"], "name": city["name"], "state": city["state"], "lat": city["lat"], "lon": city["lon"], "label": True}
        for city in cities
    )
    return points


def publish(root: Path, output: Path, requested_cycle: datetime | None = None, only: set[str] | None = None) -> dict:
    import numpy as np
    from scipy.spatial import cKDTree

    if requested_cycle:
        grib_url, index_url = rap_urls(requested_cycle)
        records = parse_index(fetch_bytes(index_url, timeout=20).decode("utf-8"))
        cycle = requested_cycle
    else:
        cycle, grib_url, records = discover_cycle()
    byte_range = record_span(records)
    grib_bytes = fetch_bytes(grib_url, byte_range=byte_range, timeout=90)
    latitudes, longitudes, scalars, heights, temperatures, u_winds, v_winds, surface_height_key, levels = decode_fields(grib_bytes)

    tree = cKDTree(np.column_stack((latitudes, longitudes * np.cos(np.radians(latitudes)))))
    grid_dir = root / "public" / "gridpoints"
    offices = sorted(path.stem for path in grid_dir.glob("*.json") if only is None or path.stem in only)
    valid_time = cycle.astimezone(timezone.utc)
    generated_at = datetime.now(timezone.utc)
    written: list[str] = []

    output.mkdir(parents=True, exist_ok=True)
    for office in offices:
        points = load_view_points(root, office)
        if not points:
            continue
        point_latitudes = np.asarray([point["lat"] for point in points])
        point_longitudes = np.asarray([point["lon"] for point in points])
        query = np.column_stack((point_latitudes, point_longitudes * np.cos(np.radians(point_latitudes))))
        distance, nearest = tree.query(query, k=1)
        # Reject Hawaii/Alaska/territories and oceanic points outside RAP's domain rather
        # than stretching the nearest edge cell across thousands of miles.
        keep = distance <= 0.5
        sampled_points: list[dict] = []
        for position, (point, model_index) in enumerate(zip(points, nearest)):
            if not keep[position]:
                continue
            surface_temperature = finite(scalars["temperature2m"][model_index])
            dewpoint = finite(scalars["dewpoint2m"][model_index])
            surface_height = finite(scalars[surface_height_key][model_index])
            profile = [
                (finite(heights[level][model_index]), finite(temperatures[level][model_index]))
                for level in levels
            ]
            profile = [(height, temperature) for height, temperature in profile if height is not None and temperature is not None]
            lapse = None if surface_temperature is None or surface_height is None else lapse_rate_c_per_km(surface_temperature, surface_height, profile)
            mid_lapse_values = [finite(temperatures[level][model_index]) for level in (700, 500)]
            mid_height_values = [finite(heights[level][model_index]) for level in (700, 500)]
            mid_lapse = None if None in (*mid_lapse_values, *mid_height_values) else pressure_layer_lapse_rate(
                mid_lapse_values[0], mid_height_values[0], mid_lapse_values[1], mid_height_values[1]
            )
            wind_profile = [
                (finite(heights[level][model_index]), finite(u_winds[level][model_index]), finite(v_winds[level][model_index]))
                for level in levels
            ]
            wind_profile = [
                (height, u_wind, v_wind)
                for height, u_wind, v_wind in wind_profile
                if height is not None and u_wind is not None and v_wind is not None
            ]
            surface_u = finite(scalars["wind10u"][model_index])
            surface_v = finite(scalars["wind10v"][model_index])
            shear = None if surface_u is None or surface_v is None or surface_height is None else bulk_shear_knots(
                surface_u, surface_v, surface_height, wind_profile
            )
            lcl = None if surface_temperature is None or dewpoint is None else lcl_height_metres(surface_temperature, dewpoint)
            cape = finite(scalars["cape"][model_index])
            cin = finite(scalars["cin"][model_index])
            mixed_layer_cape = finite(scalars["mixedLayerCape"][model_index])
            mixed_layer_cin = finite(scalars["mixedLayerCin"][model_index])
            most_unstable_cape = finite(scalars["mostUnstableCape"][model_index])
            pwat = finite(scalars["pwat"][model_index])
            helicity1 = finite(scalars["helicity1000"][model_index])
            helicity3 = finite(scalars["helicity3000"][model_index])
            metrics = {
                "surfaceCape": [None if cape is None else round(max(0.0, cape))],
                # Normalise to the meteorological signed convention used on our legend.
                "surfaceCin": [None if cin is None else round(-abs(cin))],
                "mixedLayerCape": [None if mixed_layer_cape is None else round(max(0.0, mixed_layer_cape))],
                "mixedLayerCin": [None if mixed_layer_cin is None else round(-abs(mixed_layer_cin))],
                "mostUnstableCape": [None if most_unstable_cape is None else round(max(0.0, most_unstable_cape))],
                "lowLevelLapseRate": [None if lapse is None else round(lapse, 1)],
                "midLevelLapseRate": [None if mid_lapse is None else round(mid_lapse, 1)],
                "lclHeight": [None if lcl is None else round(lcl)],
                "precipitableWater": [None if pwat is None else round(pwat / 25.4, 2)],
                "stormRelativeHelicity1km": [None if helicity1 is None else round(helicity1)],
                "stormRelativeHelicity3km": [None if helicity3 is None else round(helicity3)],
                "bulkShear6km": [None if shear is None else round(shear)],
            }
            sampled_points.append({**point, "metrics": metrics})

        if not sampled_points:
            continue
        longitude = sum(point["lon"] for point in sampled_points) / len(sampled_points)
        latitude = sum(point["lat"] for point in sampled_points) / len(sampled_points)
        sector = spc_sector(longitude, latitude, office)
        payload = {
            "schemaVersion": 1,
            "office": office,
            "model": "RAP",
            "cycle": valid_time.isoformat().replace("+00:00", "Z"),
            "validTime": valid_time.isoformat().replace("+00:00", "Z"),
            "generatedAt": generated_at.isoformat().replace("+00:00", "Z"),
            "source": grib_url,
            "definitions": {
                "surfaceCape": "RAP surface-based CAPE analysis",
                "surfaceCin": "RAP surface-based CIN analysis; normalized to negative J/kg",
                "mixedLayerCape": "RAP 90-mb mixed-layer CAPE analysis; nearest available match to SPC's 100-mb product",
                "mixedLayerCin": "RAP 90-mb mixed-layer CIN analysis; normalized negative and compared with SPC's 100-mb product",
                "mostUnstableCape": "RAP most-unstable CAPE from the lowest-255-mb parcel search layer",
                "lowLevelLapseRate": "Derived 0-3 km AGL lapse rate from RAP pressure-level temperature and height",
                "midLevelLapseRate": "Derived RAP 700-500 mb lapse rate from pressure-level temperature and height",
                "lclHeight": "Derived surface-parcel LCL AGL from RAP 2 m temperature/dewpoint spread",
                "precipitableWater": "RAP total-column precipitable water analysis",
                "stormRelativeHelicity1km": "RAP 0-1 km storm-relative helicity analysis",
                "stormRelativeHelicity3km": "RAP 0-3 km storm-relative helicity analysis",
                "bulkShear6km": "Derived RAP 10 m to 6 km AGL bulk wind difference",
            },
            "comparison": {
                "provider": "NOAA/NWS Storm Prediction Center",
                "sector": sector,
                "validTime": valid_time.isoformat().replace("+00:00", "Z"),
                "products": spc_archive_urls(valid_time, sector),
            },
            "points": sampled_points,
            "failures": len(points) - len(sampled_points),
        }
        (output / f"{office}.json").write_text(json.dumps(payload, separators=(",", ":")))
        written.append(office)

    manifest = {
        "schemaVersion": 1,
        "model": "RAP",
        "cycle": valid_time.isoformat().replace("+00:00", "Z"),
        "generatedAt": generated_at.isoformat().replace("+00:00", "Z"),
        # A targeted manual publication must not make the next full-domain schedule
        # mistake this RAP hour for complete. The publisher compares cycle and scope.
        "scope": "all" if only is None else sorted(only),
        "offices": written,
    }
    (output / "latest.json").write_text(json.dumps(manifest, separators=(",", ":")))
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--cycle", type=parse_cycle, help="fixed RAP cycle, YYYYMMDDHH")
    parser.add_argument("--only", help="comma-separated office/view ids")
    parser.add_argument(
        "--discover-only",
        action="store_true",
        help="print the latest complete RAP cycle without downloading or decoding GRIB",
    )
    args = parser.parse_args()
    if args.discover_only:
        cycle, source, records = discover_cycle()
        print(json.dumps({
            "model": "RAP",
            "cycle": cycle.isoformat().replace("+00:00", "Z"),
            "cycleId": cycle.strftime("%Y%m%d%H"),
            "source": source,
            "byteRange": record_span(records),
        }))
        return
    if args.output_dir is None:
        parser.error("--output-dir is required unless --discover-only is used")
    only = {value.strip().upper() for value in args.only.split(",")} if args.only else None
    manifest = publish(args.root, args.output_dir, args.cycle, only)
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
