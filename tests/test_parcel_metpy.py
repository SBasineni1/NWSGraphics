"""Validation and benchmark for the ported parcel lift against MetPy 1.7.1.

This is the only file in the repository allowed to import MetPy: it is the
reference implementation the hand-rolled parcel lift (scripts/mesoanalysis_pipeline.lift)
is validated against. Production never imports MetPy (see requirements-mesoanalysis.txt
vs requirements-mesoanalysis-dev.txt).

Run:
  .venv-meso-dev/bin/python -m unittest tests.test_parcel_metpy -v
  .venv-meso-dev/bin/python tests/test_parcel_metpy.py --benchmark
"""
import argparse
import os
import resource
import time
import tracemalloc
import unittest
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", str(Path(__file__).parent / "tmp" / "mpl"))
import numpy as np

from scripts.mesoanalysis_pipeline import lift

# MetPy is dev/test-only (requirements-mesoanalysis-dev.txt) and absent from production
# CI, which discovers every tests/test_*.py with only requirements-mesoanalysis.txt
# installed (.github/workflows/publish-mesoanalysis.yml). Importing it unconditionally
# would turn that discovery run into a hard failure everywhere but the dev venv, so the
# comparison is skipped rather than erroring when MetPy is not installed.
try:
    import metpy
    import metpy.calc as mpcalc
    from metpy.units import units
    _METPY_AVAILABLE = True
except ImportError:
    _METPY_AVAILABLE = False

CAPE_RTOL = 0.15
CAPE_ATOL = 100.0
LCL_ATOL_HPA = 10.0


def _interp(p, anchors_p, anchors_v):
    return np.interp(p, np.asarray(anchors_p)[::-1], np.asarray(anchors_v)[::-1])


def _sounding(name, t_values, td_values, kind="surface", base=1000.0,
              nan_indices=(), scramble=False):
    p = np.arange(base, 99.9, -25.0)
    anchors = np.array([base, max(base - 75, 100), max(base - 150, 100),
                        700, 500, 300, 200, 100], dtype=float)
    # Remove duplicate anchors for elevated terrain profiles.
    keep = np.r_[True, np.diff(anchors) != 0]
    anchors = anchors[keep]
    t = _interp(p, anchors, np.asarray(t_values)[keep]) + 273.15
    td = np.minimum(_interp(p, anchors, np.asarray(td_values)[keep]) + 273.15, t)

    pq, tq, tdq = p * units.hPa, t * units.K, td * units.K
    tv = mpcalc.virtual_temperature_from_dewpoint(pq, tq, tdq).to("K").m
    z = np.zeros_like(p)
    z[1:] = np.cumsum(
        287.04749097718457 * 0.5 * (tv[:-1] + tv[1:]) / 9.80665
        * np.log(p[:-1] / p[1:])
    )
    # The environmental RH consistent with this profile's own t/td, so the
    # lift's RH-driven virtual temperature matches what MetPy computes from
    # dewpoint directly rather than a flat placeholder.
    rh = mpcalc.relative_humidity_from_dewpoint(tq, tdq).to("percent").m

    p_in, t_in, z_in, rh_in = p.copy(), t.copy(), z.copy(), rh.copy()
    for index in nan_indices:
        p_in[index] = np.nan
        t_in[index] = np.nan
        z_in[index] = np.nan
        rh_in[index] = np.nan
    if scramble:
        # Fixed permutation: reproducible and intentionally non-monotone.
        permutation = np.r_[np.arange(p.size)[::2], np.arange(p.size)[1::2]][::-1]
        p_in, t_in, z_in, rh_in = (
            p_in[permutation], t_in[permutation], z_in[permutation], rh_in[permutation]
        )
    return dict(name=name, p=p, t=t, td=td, z=z, rh=rh, p_in=p_in, t_in=t_in,
                z_in=z_in, rh_in=rh_in, kind=kind, nan_indices=tuple(nan_indices))


def make_soundings():
    return [
        _sounding(
            "great_plains_high_cape",
            [32, 25, 19, 5, -13, -40, -57, -72],
            [24, 21, 17, 1, -17, -43, -61, -76],
        ),
        _sounding(
            "capped_warm_sector",
            [31, 27, 29, 7, -12, -39, -56, -72],
            [22, 20, 14, 0, -18, -43, -61, -76],
        ),
        _sounding(
            "elevated_convection",
            [16, 15, 20, 3, -16, -42, -58, -73],
            [6, 8, 18, -2, -20, -45, -62, -77],
            kind="most_unstable",
        ),
        _sounding(
            "dry_high_desert",
            [30, 23, 15, 0, -19, -44, -59, -73],
            [2, -2, -8, -18, -31, -49, -64, -78],
            base=850,
        ),
        _sounding(
            "cold_season_low_cape",
            [6, 1, -4, -15, -34, -56, -66, -76],
            [4, -1, -6, -18, -38, -60, -70, -80],
        ),
        _sounding(
            "saturated_tropical",
            [30, 26, 22, 10, -8, -36, -55, -72],
            [29.5, 25.5, 21.5, 9, -10, -39, -59, -76],
        ),
        _sounding(
            "no_lfc_stable",
            [12, 10, 8, 3, -4, -18, -35, -55],
            [5, 2, -1, -8, -16, -28, -43, -62],
        ),
        _sounding(
            "nan_gaps_unsorted",
            [31, 24, 18, 4, -14, -41, -58, -73],
            [23, 20, 16, 0, -18, -45, -62, -77],
            nan_indices=(4, 9, 17, 25),
            scramble=True,
        ),
    ]


def _reference(s):
    mask = np.ones(s["p"].size, dtype=bool)
    mask[list(s["nan_indices"])] = False
    p, t, td = s["p"][mask], s["t"][mask], s["td"][mask]
    pq, tq, tdq = p * units.hPa, t * units.K, td * units.K
    if s["kind"] == "most_unstable":
        pp, pt, ptd, _ = mpcalc.most_unstable_parcel(pq, tq, tdq, depth=300 * units.hPa)
        cape, cin = mpcalc.most_unstable_cape_cin(pq, tq, tdq, depth=300 * units.hPa)
    else:
        pp, pt, ptd = pq[0], tq[0], tdq[0]
        cape, cin = mpcalc.surface_based_cape_cin(pq, tq, tdq)
    lp, _ = mpcalc.lcl(pp, pt, ptd)
    return (pp.to("Pa").m, pt.to("K").m, ptd.to("K").m,
            cape.to("J/kg").m, cin.to("J/kg").m, lp.to("hPa").m)


def validate():
    soundings = make_soundings()
    rows, failures = [], []
    for s in soundings:
        p0, t0, td0, ref_cape, ref_cin, ref_lcl = _reference(s)
        ours = lift(
            np.array([p0]), np.array([t0]), np.array([td0]),
            s["p_in"][None] * 100.0, s["t_in"][None], s["z_in"][None], s["rh_in"][None],
        )
        cape, cin, lcl = ours["cape"][0], ours["cin"][0], ours["lcl_pressure"][0] / 100.0
        cape_error = cape - ref_cape
        cape_pct = (100 * cape_error / ref_cape) if ref_cape > 1e-6 else np.nan
        lcl_error = lcl - ref_lcl
        cape_tol = CAPE_ATOL + CAPE_RTOL * abs(ref_cape)
        passed = abs(cape_error) <= cape_tol and abs(lcl_error) <= LCL_ATOL_HPA
        if not passed:
            failures.append(
                f'{s["name"]}: CAPE error {cape_error:.1f} (allowed {cape_tol:.1f}), '
                f'LCL error {lcl_error:.2f} hPa (allowed {LCL_ATOL_HPA:.1f})'
            )
        rows.append((s["name"], cape, ref_cape, cape_error, cape_pct,
                     cin, ref_cin, lcl, ref_lcl, lcl_error, passed))

    print(f"MetPy {metpy.__version__}; declared tolerances before comparison: "
          f"CAPE <= {CAPE_ATOL:.0f} J/kg + {CAPE_RTOL:.0%} of reference; "
          f"LCL <= {LCL_ATOL_HPA:.0f} hPa")
    header = ("sounding                    oursCAPE refCAPE  dCAPE    d%  "
              "oursCIN  refCIN oursLCL refLCL dLCL status")
    print(header)
    print("-" * len(header))
    for row in rows:
        name, cape, rc, dc, pct, cin, rcin, lcl, rlcl, dlcl, passed = row
        pct_text = "   n/a" if np.isnan(pct) else f"{pct:6.1f}"
        print(f"{name:27s} {cape:8.1f} {rc:7.1f} {dc:7.1f} {pct_text} "
              f"{cin:8.1f} {rcin:7.1f} {lcl:7.1f} {rlcl:7.1f} "
              f"{dlcl:5.1f} {'PASS' if passed else 'FINDING'}")

    # Explicit edge checks not used to tune the MetPy comparison tolerance.
    base = soundings[0]
    p_below = np.array([102500.0])
    edge = lift(p_below, np.array([base["t"][0] + 1]), np.array([base["td"][0]]),
                base["p"][None] * 100, base["t"][None], base["z"][None], base["rh"][None])
    assert np.isfinite(edge["cape"][0]) and np.isfinite(edge["lcl_pressure"][0])
    assert np.isnan(lift(
        np.array([100000.0]), np.array([303.0]), np.array([295.0]),
        np.full((1, 5), np.nan), np.full((1, 5), np.nan), np.full((1, 5), np.nan),
        np.full((1, 5), np.nan),
    )["cape"][0])

    if failures:
        raise AssertionError("Agreement findings exceeded declared tolerance:\n" + "\n".join(failures))
    print("\nAll eight cases are within the predeclared tolerances.")
    return rows


@unittest.skipUnless(_METPY_AVAILABLE, "metpy not installed; pip install -r requirements-mesoanalysis-dev.txt")
class ParcelMetPyValidationTest(unittest.TestCase):
    def test_validate_against_metpy(self):
        validate()


def benchmark():
    n, nz = 50_000, 37
    p1 = np.linspace(100000.0, 10000.0, nz)
    t1 = np.linspace(304.0, 207.0, nz)
    td1 = np.minimum(t1 - np.linspace(7.0, 20.0, nz), t1)
    # The moisture profile affects synthetic hydrostatic heights.
    pq, tq, tdq = p1 * units.Pa, t1 * units.K, td1 * units.K
    tv1 = mpcalc.virtual_temperature_from_dewpoint(pq, tq, tdq).to("K").m
    rh1 = mpcalc.relative_humidity_from_dewpoint(tq, tdq).to("percent").m
    z1 = np.zeros(nz)
    z1[1:] = np.cumsum(
        287.04749097718457 * 0.5 * (tv1[:-1] + tv1[1:]) / 9.80665
        * np.log(p1[:-1] / p1[1:])
    )
    # Broadcast views keep input construction outside the measured working set.
    p = np.broadcast_to(p1, (n, nz))
    t = np.broadcast_to(t1, (n, nz))
    z = np.broadcast_to(z1, (n, nz))
    rh = np.broadcast_to(rh1, (n, nz))
    p0, t0, td0 = np.full(n, p1[0]), np.full(n, t1[0]), np.full(n, td1[0])
    lift(p0[:100], t0[:100], td0[:100], p[:100], t[:100], z[:100], rh[:100])

    tracemalloc.start()
    start = time.perf_counter()
    result = lift(p0, t0, td0, p, t, z, rh)
    elapsed = time.perf_counter() - start
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # macOS reports bytes; Linux reports KiB.
    rss_mib = rss / (1024 ** 2) if rss > 10_000_000 else rss / 1024
    assert all(a.shape == (n,) for a in result.values())
    print(f"\nBenchmark: {n:,} points x {nz} levels")
    print(f"wall_clock_s={elapsed:.3f}")
    print(f"throughput_points_per_s={n / elapsed:,.0f}")
    print(f"tracemalloc_peak_working_MiB={peak / 1024**2:.1f}")
    print(f"process_peak_RSS_MiB={rss_mib:.1f}")


if __name__ == "__main__":
    if not _METPY_AVAILABLE:
        raise SystemExit(
            "metpy is not installed; run with the dev venv: "
            "pip install -r requirements-mesoanalysis-dev.txt"
        )
    parser = argparse.ArgumentParser()
    parser.add_argument("--benchmark", action="store_true")
    args = parser.parse_args()
    validate()
    if args.benchmark:
        benchmark()
