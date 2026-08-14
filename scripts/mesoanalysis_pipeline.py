#!/usr/bin/env python3
"""Build hourly RAP mesoanalysis payloads for every CONUS graphics view.

The request path never opens or decodes GRIB.  This publisher downloads one bounded
slice of the latest RAP analysis, samples it onto the lat/lon lattices the graphics suite
already owns, and writes small JSON objects which the Node publisher uploads to R2.

NumPy is imported at module scope: it is pure-pip, already required by the test suite,
and the vectorized parcel lift (``lift``) needs it whenever it is called, not just from
``publish()``.  SciPy and ecCodes stay lazily imported inside ``publish()`` and
``decode_fields()``, since those pull in native GRIB dependencies that unit tests must
not require.
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

import numpy as np


NOMADS_ROOT = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/rap/prod"
RTMA_ROOT = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/rtma/prod"
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


# --- Vectorized parcel lift -------------------------------------------------
#
# Ported from the validated prototype (scratchpad/parcel.py), checked against
# MetPy 1.7.1 on eight synthetic soundings.  Units are Pa, K, m, and J/kg.
# ``lift`` returns a dict of CAPE, CIN, LCL pressure/height AGL, LFC height AGL,
# and EL height AGL.  The first LFC and last EL are used.  No LFC means
# CAPE=CIN=0 and LFC/EL=NaN; no EL means CAPE integrates to the sounding top and
# EL=NaN.  NaN levels are removed, profiles pressure-sorted, and gaps bridged.
# Levels below an elevated parcel are ignored.  For a start below all data,
# heights are extrapolated but integration begins at the first available level.
_RD = 287.04749097718457
_G = 9.80665
_EPSILON = 0.6219569100577033
_KAPPA = 0.2854


def _es(t):
    tc = np.asarray(t) - 273.15
    return 611.2 * np.exp(np.clip(17.67 * tc / (tc + 243.5), -80.0, 80.0))


def _rs(p, t):
    e = np.minimum(_es(t), 0.99 * p)
    return _EPSILON * e / (p - e)


def _tv(t, r):
    return t * (r + _EPSILON) / (_EPSILON * (1.0 + r))


def _tlcl(t, td):
    """Bolton (1980) LCL temperature, equation 15."""
    td = np.minimum(td, t)
    return 56.0 + 1.0 / (1.0 / (td - 56.0) + np.log(t / td) / 800.0)


def _theta_e(p, t, td):
    """Bolton (1980) equivalent potential temperature, equation 43."""
    td = np.minimum(td, t)
    tl = _tlcl(t, td)
    e = np.minimum(_es(td), 0.99 * p)
    r = _EPSILON * e / (p - e)
    th = t * (100000.0 / (p - e)) ** _KAPPA * (t / tl) ** (0.28 * r)
    return th * np.exp(r * (1.0 + 0.448 * r) * (3036.0 / tl - 1.78))


def _theta_es(p, t):
    e = np.minimum(_es(t), 0.99 * p)
    r = _EPSILON * e / (p - e)
    th = t * (100000.0 / (p - e)) ** _KAPPA
    return th * np.exp(r * (1.0 + 0.448 * r) * (3036.0 / t - 1.78))


def _moist_temperature(p, target, guess):
    """Invert saturated Bolton theta-e with eight bounded Newton iterations."""
    t = np.clip(guess, 150.0, 360.0)
    target = target[:, None]
    for _ in range(8):
        value = _theta_es(p, t)
        deriv = (_theta_es(p, t + 0.05) - _theta_es(p, t - 0.05)) / 0.1
        step = np.divide(value - target, deriv, out=np.zeros_like(t),
                         where=np.isfinite(deriv) & (np.abs(deriv) > 1e-8))
        t = np.clip(t - np.clip(step, -12.0, 12.0), 150.0, 360.0)
    return t


def _interp(p, value, valid, target):
    """Row-wise log-pressure interpolation, with two-point extrapolation."""
    n, nz = p.shape
    count = valid.sum(1)
    x, xt = np.log(np.where(valid, p, 1.0)), np.log(target)
    above = valid & (x <= xt[:, None])
    upper = np.where(above.any(1), np.argmax(above, 1), np.maximum(count - 1, 0))
    lower = upper - 1
    bottom = xt >= x[:, 0]
    lower = np.where(bottom, 0, lower)
    upper = np.where(bottom, np.minimum(1, np.maximum(count - 1, 0)), upper)
    last = np.maximum(count - 1, 0)
    top = xt <= x[np.arange(n), last]
    lower, upper = np.where(top, np.maximum(count - 2, 0), lower), np.where(top, last, upper)
    lower, upper = np.clip(lower, 0, nz - 1), np.clip(upper, 0, nz - 1)
    row = np.arange(n)
    x0, x1, y0, y1 = x[row, lower], x[row, upper], value[row, lower], value[row, upper]
    w = np.divide(xt - x0, x1 - x0, out=np.zeros_like(xt), where=abs(x1 - x0) > 1e-12)
    result = np.where(count == 1, value[:, 0], y0 + w * (y1 - y0))
    return np.where(count > 0, result, np.nan)


def _environment_tv(pressure, temperature, relative_humidity):
    """Environmental virtual temperature from RH, replacing the prototype's
    hypsometric reconstruction. RAP ships RH on every pressure level we use, so
    there is nothing to reconstruct."""
    saturation = _es(temperature)
    vapor = np.clip(relative_humidity, 0.0, 100.0) / 100.0 * saturation
    mixing = 0.622 * vapor / np.maximum(pressure - vapor, 1.0)
    return _tv(temperature, mixing)


def _crossing(x0, x1, y0, y1):
    f = np.divide(-y0, y1 - y0, out=np.zeros_like(y0), where=abs(y1 - y0) > 1e-12)
    return x0 + np.clip(f, 0.0, 1.0) * (x1 - x0)


def _integral(x, delta, valid, x_high, x_low):
    """Integrate RD*delta over log pressure between vertical boundaries."""
    x0, x1, d0, d1 = x[:, :-1], x[:, 1:], delta[:, :-1], delta[:, 1:]
    pair, layer_width = valid[:, :-1] & valid[:, 1:], x0 - x1
    hi, lo = np.minimum(x0, x_high[:, None]), np.maximum(x1, x_low[:, None])
    width = np.maximum(hi - lo, 0.0)
    fh = np.divide(x0 - hi, layer_width, out=np.zeros_like(width),
                   where=pair & (layer_width > 0))
    fl = np.divide(x0 - lo, layer_width, out=np.zeros_like(width),
                   where=pair & (layer_width > 0))
    dh, dl = d0 + (d1 - d0) * fh, d0 + (d1 - d0) * fl
    return np.sum(np.where(pair & (width > 0), _RD * 0.5 * (dh + dl) * width, 0.0), 1)


def lift(parcel_pressure, parcel_temperature, parcel_dewpoint,
         level_pressure, level_temperature, level_height, level_relative_humidity):
    """Lift a batch; parcel arrays are (n,), level arrays are (n, n_levels).

    ``level_relative_humidity`` is percent RH at each pressure level, used to
    compute environmental virtual temperature directly rather than
    reconstructing it hypsometrically.

    Returns a dict of ``cape``, ``cin``, ``lcl_pressure``, ``lcl_height``,
    ``lfc_height``, and ``el_height`` (equilibrium-level height AGL), each of
    shape ``(n,)``.
    """
    p0, t0, td0 = (np.asarray(a, dtype=np.float64) for a in
                   (parcel_pressure, parcel_temperature, parcel_dewpoint))
    p, t, z, rh = (np.asarray(a, dtype=np.float64) for a in
                   (level_pressure, level_temperature, level_height, level_relative_humidity))
    if p0.ndim != 1 or t0.shape != p0.shape or td0.shape != p0.shape:
        raise ValueError("parcel inputs must all have shape (n_points,)")
    if p.ndim != 2 or t.shape != p.shape or z.shape != p.shape or rh.shape != p.shape:
        raise ValueError("level inputs must all have shape (n_points, n_levels)")
    if p.shape[0] != p0.size or p.shape[1] < 2:
        raise ValueError("incompatible n_points or fewer than two levels")

    parcel_ok = (np.isfinite(p0) & np.isfinite(t0) & np.isfinite(td0) &
                 (p0 > 0) & (t0 > 150) & (td0 > 150))
    raw = (np.isfinite(p) & np.isfinite(t) & np.isfinite(z) & np.isfinite(rh) &
           (p > 0) & (t > 120))
    order = np.argsort(np.where(raw, -p, np.inf), axis=1)
    p, t, z, rh, raw = (np.take_along_axis(a, order, axis=1) for a in (p, t, z, rh, raw))
    active = raw & (p <= p0[:, None] * (1 + 2e-6))
    order = np.argsort(~active, axis=1, kind="stable")
    p, t, z, rh, valid = (np.take_along_axis(a, order, axis=1)
                          for a in (p, t, z, rh, active))
    count = valid.sum(1)
    ps, ts, zs, rhs = (np.where(valid, p, 10000.0), np.where(valid, t, 250.0),
                       np.where(valid, z, 0.0), np.where(valid, rh, 0.0))

    tlcl = _tlcl(t0, td0)
    plcl = np.minimum(p0 * (tlcl / t0) ** (1 / _KAPPA), p0)
    theta_e = _theta_e(p0, t0, td0)
    dry = t0[:, None] * (ps / p0[:, None]) ** _KAPPA
    guess = tlcl[:, None] * (ps / plcl[:, None]) ** 0.19
    parcel_t = np.where(ps >= plcl[:, None], dry, _moist_temperature(ps, theta_e, guess))
    parcel_t = np.where(valid, parcel_t, np.nan)
    r0 = _rs(p0, np.minimum(td0, t0))
    parcel_r = np.where(ps >= plcl[:, None], r0[:, None], _rs(ps, parcel_t))
    parcel_tv = _tv(parcel_t, parcel_r)
    env_tv = _environment_tv(ps, ts, rhs)
    delta = np.where(valid, parcel_tv - env_tv, np.nan)

    base_z, lcl_z = _interp(ps, zs, valid, p0), _interp(ps, zs, valid, plcl)
    env_lcl = _interp(ps, env_tv, valid, plcl)
    delta_lcl = _tv(tlcl, _rs(plcl, tlcl)) - env_lcl
    x = np.log(ps)
    x0, x1, d0, d1 = x[:, :-1], x[:, 1:], delta[:, :-1], delta[:, 1:]
    pair = valid[:, :-1] & valid[:, 1:]
    cross_x = _crossing(x0, x1, d0, d1)
    frac = np.divide(x0 - cross_x, x0 - x1, out=np.zeros_like(cross_x),
                     where=pair & (x0 > x1))
    cross_z = z[:, :-1] + frac * (z[:, 1:] - z[:, :-1])

    positive = np.any(valid & (ps <= plcl[:, None]) & (delta > 0), 1)
    upward = pair & (d0 <= 0) & (d1 > 0) & (cross_x <= np.log(plcl)[:, None] + 1e-10)
    # USAF/MetPy convention when positive area begins directly above the LCL.
    lfc_is_lcl = positive & ((delta_lcl >= -1e-7) | ~upward.any(1))
    up_index, row = np.argmax(upward, 1), np.arange(p0.size)
    has_lfc = parcel_ok & (count >= 2) & positive & (lfc_is_lcl | upward.any(1))
    x_lfc = np.where(lfc_is_lcl, np.log(plcl), cross_x[row, up_index])
    z_lfc = np.where(lfc_is_lcl, lcl_z, cross_z[row, up_index])

    downward = pair & (d0 > 0) & (d1 <= 0) & (cross_x < x_lfc[:, None])
    indices = np.arange(p.shape[1] - 1)[None, :]
    down_index = np.max(np.where(downward, indices, -1), 1)
    has_el, down_safe = has_lfc & (down_index >= 0), np.maximum(down_index, 0)
    x_el, z_el = cross_x[row, down_safe], cross_z[row, down_safe]
    x_top = x[row, np.maximum(count - 1, 0)]
    cape = np.where(has_lfc, np.maximum(_integral(
        x, delta, valid, x_lfc, np.where(has_el, x_el, x_top)), 0), 0)
    cin = np.where(has_lfc, np.minimum(_integral(x, delta, valid, x[:, 0], x_lfc), 0), 0)

    good = parcel_ok & (count >= 2)
    return {
        "cape": np.where(good, cape, np.nan),
        "cin": np.where(good, cin, np.nan),
        "lcl_pressure": np.where(good, plcl, np.nan),
        "lcl_height": np.where(good, lcl_z - base_z, np.nan),
        "lfc_height": np.where(has_lfc, z_lfc - base_z, np.nan),
        "el_height": np.where(has_el, z_el - base_z, np.nan),
    }


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


def rtma_urls(cycle: datetime) -> tuple[str, str]:
    day, hour = cycle_parts(cycle)
    base = os.environ.get("MESO_RTMA_ROOT", RTMA_ROOT).rstrip("/")
    grib = f"{base}/rtma2p5.{day}/rtma2p5.t{hour}z.2dvaranl_ndfd.grb2_wexp"
    return grib, f"{grib}.idx"


def rtma_record_span(records: list[IndexRecord]) -> tuple[int, int]:
    """One inclusive byte range covering RTMA's surface height, surface pressure,
    2 m temperature and 2 m dewpoint.

    These four are the first four records of the file and are contiguous from byte
    zero, verified against a live index: 0 -> 26,683,628 for the 22Z 2026-08-12 cycle.
    """
    first = next((r for r in records if ":HGT:surface:anl:" in f":{r.description}"), None)
    last_index = next(
        (i for i, r in enumerate(records) if ":DPT:2 m above ground:anl:" in f":{r.description}"),
        None,
    )
    if first is None or last_index is None:
        raise ValueError("RTMA analysis is missing surface height or 2 m dewpoint")
    if last_index + 1 >= len(records):
        raise ValueError("RTMA index cannot determine the end of the 2 m dewpoint record")
    return first.offset, records[last_index + 1].offset - 1


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


def surface_label(rtma) -> str:
    return "rtma" if rtma else "rap"


def probe_rtma(cycle: datetime):
    """Return (grib_url, byte_range) when RTMA exists for this hour, else None.

    RTMA and RAP land at different times, so a missing RTMA hour is routine rather
    than exceptional. Publishing RAP-only beats walking back to an older paired hour.
    """
    grib_url, index_url = rtma_urls(cycle)
    try:
        records = parse_index(fetch_bytes(index_url, timeout=20).decode("utf-8"))
        return grib_url, rtma_record_span(records)
    except (OSError, RuntimeError, ValueError, urllib.error.HTTPError):
        return None


def discover_cycle(now: datetime | None = None) -> tuple[datetime, str, list[IndexRecord], tuple[str, tuple[int, int]] | None]:
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
            return cycle, grib_url, records, probe_rtma(cycle)
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
    humidities: dict[int, np.ndarray] = {}
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
                        elif short_name == "r":
                            humidities[level] = values
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
    common_levels = sorted(
        set(heights) & set(temperatures) & set(u_winds) & set(v_winds) & set(humidities),
        reverse=True,
    )
    if len(common_levels) < 8:
        raise RuntimeError("RAP GRIB span has an incomplete 200--1000-mb temperature/height/wind/humidity profile")
    return latitudes, longitudes, scalars, heights, temperatures, u_winds, v_winds, humidities, surface_height_key, common_levels


def decode_rtma(grib_bytes: bytes):
    """Decode the RTMA surface span into the parcel's starting state.

    Two details are load-bearing and were both verified against a live file:
    the surface height record is ``orog``, not ``gh``; and RTMA longitudes arrive
    in 0-360 convention, so they need the same normalisation RAP gets or every
    nearest-neighbour query lands on the far side of the planet.
    """

    import numpy as np
    from eccodes import codes_get, codes_get_array, codes_grib_multi_support_on, codes_grib_new_from_file, codes_release

    wanted = {
        ("orog", "surface"): "orography",
        ("sp", "surface"): "surfacePressure",
        ("2t", "heightAboveGround"): "temperature2m",
        ("2d", "heightAboveGround"): "dewpoint2m",
    }
    fields: dict[str, "np.ndarray"] = {}
    latitudes = longitudes = None

    codes_grib_multi_support_on()
    with tempfile.NamedTemporaryFile(suffix=".grib2") as temporary:
        temporary.write(grib_bytes)
        temporary.flush()
        with open(temporary.name, "rb") as handle:
            while True:
                gid = codes_grib_new_from_file(handle)
                if gid is None:
                    break
                try:
                    key = (str(codes_get(gid, "shortName")), str(codes_get(gid, "typeOfLevel")))
                    if key in wanted:
                        values = np.asarray(codes_get_array(gid, "values"), dtype=np.float64)
                        values[np.abs(values) >= 1e20] = np.nan
                        # float32 is safe for these ranges -- measured max error
                        # 1.5e-5 K for 2t/2d and exactly 0 Pa for sp -- and saves ~57 MiB.
                        fields[wanted[key]] = values.astype(np.float32)
                        if latitudes is None:
                            latitudes = np.asarray(codes_get_array(gid, "latitudes"), dtype=np.float64)
                            longitudes = np.asarray(codes_get_array(gid, "longitudes"), dtype=np.float64)
                            longitudes = np.where(longitudes > 180, longitudes - 360, longitudes)
                finally:
                    codes_release(gid)

    missing = sorted(set(wanted.values()) - fields.keys())
    if missing or latitudes is None:
        raise RuntimeError(f"RTMA span is missing fields: {', '.join(missing) or 'grid'}")
    return latitudes, longitudes, fields


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
        rtma = probe_rtma(requested_cycle)
    else:
        cycle, grib_url, records, rtma = discover_cycle()
    byte_range = record_span(records)
    grib_bytes = fetch_bytes(grib_url, byte_range=byte_range, timeout=90)
    latitudes, longitudes, scalars, heights, temperatures, u_winds, v_winds, humidities, surface_height_key, levels = decode_fields(grib_bytes)

    # A failure decoding RTMA must not lose the whole run: degrade to the RAP-only
    # surface Task 6 already established, with a logged reason.
    rtma_lat = rtma_lon = None
    rtma_fields = None
    if rtma:
        rtma_url, rtma_range = rtma
        try:
            rtma_lat, rtma_lon, rtma_fields = decode_rtma(fetch_bytes(rtma_url, byte_range=rtma_range, timeout=120))
        except Exception as error:
            print(f"RTMA decode failed, falling back to RAP-only surface: {error}")
            rtma_lat = rtma_lon = rtma_fields = None

    tree = cKDTree(np.column_stack((latitudes, longitudes * np.cos(np.radians(latitudes)))))
    grid_dir = root / "public" / "gridpoints"
    offices = sorted(path.stem for path in grid_dir.glob("*.json") if only is None or path.stem in only)
    valid_time = cycle.astimezone(timezone.utc)
    generated_at = datetime.now(timezone.utc)
    written: list[str] = []

    # Office frames overlap heavily, and a parcel lift is orders of magnitude dearer than
    # a nearest-neighbour lookup, so the loop inverts: union every view's points, dedupe,
    # lift once as an (n_points, n_levels) array, then per-office assembly is a dict lookup.
    all_points: dict[tuple[float, float], dict] = {}
    per_office: dict[str, list[dict]] = {}
    for office in offices:
        points = load_view_points(root, office)
        per_office[office] = points
        for point in points:
            all_points.setdefault((round(point["lat"], 4), round(point["lon"], 4)), point)
    unique = list(all_points.values())

    metrics_by_key: dict[tuple[float, float], dict] = {}
    if unique:
        unique_lat = np.asarray([p["lat"] for p in unique])
        unique_lon = np.asarray([p["lon"] for p in unique])
        rap_query = np.column_stack((unique_lat, unique_lon * np.cos(np.radians(unique_lat))))
        rap_distance, rap_index = tree.query(rap_query, k=1)
        # Reject Hawaii/Alaska/territories and oceanic points outside RAP's domain rather
        # than stretching the nearest edge cell across thousands of miles.
        in_domain = rap_distance <= 0.5

        if rtma_fields is not None:
            # Coordinates stay float64: cKDTree upcasts float32 internally so there is no
            # memory saving, and float32 changed 9 of 50,000 nearest-neighbour results.
            rtma_tree = cKDTree(np.column_stack((rtma_lat, rtma_lon * np.cos(np.radians(rtma_lat)))))
            rtma_distance, rtma_index = rtma_tree.query(rap_query, k=1)
            rtma_in_domain = rtma_distance <= 0.1
        else:
            rtma_index = None
            rtma_in_domain = np.zeros(len(unique), dtype=bool)

        level_pressure = np.tile(np.asarray(levels, dtype=np.float64) * 100.0, (len(unique), 1))
        level_temperature = np.column_stack([temperatures[l][rap_index] for l in levels])
        level_height = np.column_stack([heights[l][rap_index] for l in levels])
        level_humidity = np.column_stack([humidities[l][rap_index] for l in levels])

        # The parcel starts at RTMA's observed surface where RTMA covers the point, and at
        # RAP's own surface otherwise. This is the whole point of the change.
        parcel_pressure = scalars["sp"][rap_index].astype(np.float64) if "sp" in scalars else scalars["pres"][rap_index].astype(np.float64)
        parcel_temperature = scalars["temperature2m"][rap_index].astype(np.float64)
        parcel_dewpoint = scalars["dewpoint2m"][rap_index].astype(np.float64)
        surface_height = scalars[surface_height_key][rap_index].astype(np.float64)
        if rtma_index is not None:
            use = rtma_in_domain
            parcel_pressure[use] = rtma_fields["surfacePressure"][rtma_index[use]].astype(np.float64)
            parcel_temperature[use] = rtma_fields["temperature2m"][rtma_index[use]].astype(np.float64)
            parcel_dewpoint[use] = rtma_fields["dewpoint2m"][rtma_index[use]].astype(np.float64)
            surface_height[use] = rtma_fields["orography"][rtma_index[use]].astype(np.float64)

        # Discard levels below ground in RTMA's finer terrain.
        below_ground = level_pressure > parcel_pressure[:, None]
        level_temperature = np.where(below_ground, np.nan, level_temperature)
        level_height = np.where(below_ground, np.nan, level_height)
        level_humidity = np.where(below_ground, np.nan, level_humidity)

        lifted = lift(parcel_pressure, parcel_temperature, parcel_dewpoint,
                      level_pressure, level_temperature, level_height, level_humidity)

        for i, point in enumerate(unique):
            if not in_domain[i]:
                continue
            model_index = rap_index[i]
            key = (round(point["lat"], 4), round(point["lon"], 4))

            surface_temperature = finite(parcel_temperature[i])
            dewpoint = finite(parcel_dewpoint[i])
            # RTMA-adjusted terrain height, used only for lowLevelLapseRate's anchor below.
            adjusted_surface_height = finite(surface_height[i])
            # RAP's own surface height, unaffected by RTMA -- bulkShear6km must come out
            # unchanged, exactly like mixedLayerCape/Cin, mostUnstableCape,
            # midLevelLapseRate, precipitableWater and both helicities.
            rap_surface_height = finite(scalars[surface_height_key][model_index])
            profile = [
                (finite(heights[level][model_index]), finite(temperatures[level][model_index]))
                for level in levels
            ]
            profile = [(height, temperature) for height, temperature in profile if height is not None and temperature is not None]
            # Re-anchored on the possibly-RTMA surface temperature and terrain height.
            lapse = None if surface_temperature is None or adjusted_surface_height is None else lapse_rate_c_per_km(surface_temperature, adjusted_surface_height, profile)
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
            shear = None if surface_u is None or surface_v is None or rap_surface_height is None else bulk_shear_knots(
                surface_u, surface_v, rap_surface_height, wind_profile
            )
            cape = finite(lifted["cape"][i])
            cin = finite(lifted["cin"][i])
            lcl = finite(lifted["lcl_height"][i])
            mixed_layer_cape = finite(scalars["mixedLayerCape"][model_index])
            mixed_layer_cin = finite(scalars["mixedLayerCin"][model_index])
            most_unstable_cape = finite(scalars["mostUnstableCape"][model_index])
            pwat = finite(scalars["pwat"][model_index])
            helicity1 = finite(scalars["helicity1000"][model_index])
            helicity3 = finite(scalars["helicity3000"][model_index])
            metrics_by_key[key] = {
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

    output.mkdir(parents=True, exist_ok=True)
    for office in offices:
        points = per_office[office]
        if not points:
            continue
        sampled_points: list[dict] = []
        for point in points:
            key = (round(point["lat"], 4), round(point["lon"], 4))
            metrics = metrics_by_key.get(key)
            if metrics is None:
                continue
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
        cycle, source, records, rtma = discover_cycle()
        print(json.dumps({
            "model": "RAP",
            "cycle": cycle.isoformat().replace("+00:00", "Z"),
            "cycleId": cycle.strftime("%Y%m%d%H"),
            "source": source,
            "byteRange": record_span(records),
            "surface": surface_label(rtma),
        }))
        return
    if args.output_dir is None:
        parser.error("--output-dir is required unless --discover-only is used")
    only = {value.strip().upper() for value in args.only.split(",")} if args.only else None
    manifest = publish(args.root, args.output_dir, args.cycle, only)
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
