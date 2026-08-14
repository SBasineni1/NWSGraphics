"""Validation and benchmark for the ported parcel lift against MetPy 1.7.1.

This is the only file in the repository allowed to import MetPy: it is the
reference implementation the hand-rolled parcel lift (scripts/mesoanalysis_pipeline.lift)
is validated against. Production never imports MetPy (see requirements-mesoanalysis.txt
vs requirements-mesoanalysis-dev.txt).

Run:
  .venv-meso-dev/bin/python -m unittest tests.test_parcel_metpy -v
  .venv-meso-dev/bin/python tests/test_parcel_metpy.py --benchmark

Any dev/CI environment that is supposed to have MetPy installed should also set
REQUIRE_METPY=1. Without it, `unittest tests.test_parcel_metpy` in a venv where MetPy
is present but broken (partial install, a broken pint/xarray underneath it) silently
reports the comparison as skipped and exits 0 -- the whole point of this file is a
MetPy-agreement check, so that must be a hard failure, not a quiet pass:

  REQUIRE_METPY=1 .venv-meso-dev/bin/python -m unittest tests.test_parcel_metpy -v
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

from scripts.mesoanalysis_pipeline import (
    lift, _es,
    _tlcl as _lift_tlcl,
    _theta_e as _lift_theta_e,
    _rs as _lift_rs,
    _tv as _lift_tv,
    _moist_temperature as _lift_moist_temperature,
    _interp as _lift_interp,
    _crossing as _lift_crossing,
    _integral as _lift_integral,
    _KAPPA as _LIFT_KAPPA,
)

# MetPy is dev/test-only (requirements-mesoanalysis-dev.txt) and absent from production
# CI, which discovers every tests/test_*.py with only requirements-mesoanalysis.txt
# installed (.github/workflows/publish-mesoanalysis.yml). Importing it unconditionally
# would turn that discovery run into a hard failure everywhere but the dev venv, so the
# comparison is skipped rather than erroring when MetPy is not installed -- unless
# REQUIRE_METPY says this environment is supposed to have it, in which case a broken
# import should fail loudly instead of silently skipping (see module docstring).
REQUIRE_METPY = bool(os.environ.get("REQUIRE_METPY"))
try:
    import metpy
    import metpy.calc as mpcalc
    from metpy.units import units
    _METPY_AVAILABLE = True
except ImportError:
    _METPY_AVAILABLE = False
    if REQUIRE_METPY:
        raise

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


def _dry_integrated_sounding():
    """A sounding whose heights are hydrostatically integrated from dry temperature,
    not virtual temperature -- deliberately physically inconsistent, so it is a case
    where a height-based (hypsometric) reconstruction of environmental Tv and an
    RH-based one must genuinely disagree. lift() no longer reconstructs Tv from height
    at all (see _legacy_cape below for the retired path), so its CAPE here should still
    track MetPy's own p/t/td-only reference despite the height field carrying no
    moisture signal whatsoever.

    Built without MetPy (Bolton RH via the production _es, pure NumPy hydrostatics) so
    the identical inputs and CAPE can be pinned as a golden value in
    tests/test_mesoanalysis.py, which must run with no MetPy present.
    """
    base = 1000.0
    p = np.arange(base, 99.9, -25.0)
    anchors = np.array([base, base - 75, base - 150, 700, 500, 300, 200, 100], dtype=float)
    t_values = np.array([30, 26, 22, 10, -8, -36, -55, -72], dtype=float)
    td_values = np.array([28, 24, 20, 8, -10, -38, -57, -74], dtype=float)
    t = _interp(p, anchors, t_values) + 273.15
    td = np.minimum(_interp(p, anchors, td_values) + 273.15, t)
    z = np.zeros_like(p)
    z[1:] = np.cumsum(
        287.04749097718457 * 0.5 * (t[:-1] + t[1:]) / 9.80665
        * np.log(p[:-1] / p[1:])
    )
    rh = np.clip(100.0 * _es(td) / _es(t), 0.0, 100.0)
    return dict(name="dry_integrated_heights", p=p, t=t, td=td, z=z, rh=rh,
                p_in=p.copy(), t_in=t.copy(), z_in=z.copy(), rh_in=rh.copy(),
                kind="surface", nan_indices=())


def _legacy_environment_tv(p, t, z, valid, p0, td0):
    """The pre-Task-3 hypsometric virtual-temperature reconstruction, ported
    unchanged from scratchpad/parcel.py. Production deleted this code path entirely
    when lift() gained an RH input -- it is kept here, nowhere else, purely to prove
    on _dry_integrated_sounding() that the RH-based replacement is not a no-op."""
    rd, g = 287.04749097718457, 9.80665
    env = np.full_like(t, np.nan)
    pair = valid[:, :-1] & valid[:, 1:]
    dlogp, dz = np.log(p[:, :-1] / p[:, 1:]), z[:, 1:] - z[:, :-1]
    layer = np.divide(g * dz, rd * dlogp, out=np.full_like(dz, np.nan),
                      where=pair & (dlogp > 1e-10) & (dz > 0))
    r0 = _lift_rs(p0, np.minimum(td0, t[:, 0]))
    anchored = valid[:, 0] & np.isclose(p[:, 0], p0, rtol=2e-6, atol=0.2)
    first = np.where(anchored, _lift_tv(t[:, 0], r0), layer[:, 0])
    env[:, 0] = np.where(valid[:, 0] & np.isfinite(first), first, t[:, 0])
    for j in range(p.shape[1] - 1):
        reconstructed = np.clip(2 * layer[:, j] - env[:, j],
                                0.998 * t[:, j + 1], 1.060 * t[:, j + 1])
        env[:, j + 1] = np.where(pair[:, j] & np.isfinite(reconstructed), reconstructed,
                                 np.where(valid[:, j + 1], t[:, j + 1], np.nan))
    return env


def _legacy_cape(p0, t0, td0, p, t, z):
    """The full pre-Task-3 lift(), CAPE/CIN/LCL only. Duplicated rather than
    imported -- production has no code path left that reconstructs Tv from height,
    so there is nothing to import."""
    p0, t0, td0 = (np.asarray(a, dtype=np.float64) for a in (p0, t0, td0))
    p, t, z = (np.asarray(a, dtype=np.float64) for a in (p, t, z))
    raw = (np.isfinite(p) & np.isfinite(t) & np.isfinite(z) & (p > 0) & (t > 120))
    order = np.argsort(np.where(raw, -p, np.inf), axis=1)
    p, t, z, raw = (np.take_along_axis(a, order, axis=1) for a in (p, t, z, raw))
    active = raw & (p <= p0[:, None] * (1 + 2e-6))
    order = np.argsort(~active, axis=1, kind="stable")
    p, t, z, valid = (np.take_along_axis(a, order, axis=1) for a in (p, t, z, active))
    count = valid.sum(1)
    ps, ts, zs = np.where(valid, p, 10000.0), np.where(valid, t, 250.0), np.where(valid, z, 0.0)

    tlcl = _lift_tlcl(t0, td0)
    plcl = np.minimum(p0 * (tlcl / t0) ** (1 / _LIFT_KAPPA), p0)
    theta_e = _lift_theta_e(p0, t0, td0)
    dry = t0[:, None] * (ps / p0[:, None]) ** _LIFT_KAPPA
    guess = tlcl[:, None] * (ps / plcl[:, None]) ** 0.19
    parcel_t = np.where(ps >= plcl[:, None], dry, _lift_moist_temperature(ps, theta_e, guess))
    parcel_t = np.where(valid, parcel_t, np.nan)
    r0 = _lift_rs(p0, np.minimum(td0, t0))
    parcel_r = np.where(ps >= plcl[:, None], r0[:, None], _lift_rs(ps, parcel_t))
    parcel_tv = _lift_tv(parcel_t, parcel_r)
    env_tv = _legacy_environment_tv(ps, ts, zs, valid, p0, td0)
    delta = np.where(valid, parcel_tv - env_tv, np.nan)

    lcl_z = _lift_interp(ps, zs, valid, plcl)
    env_lcl = _lift_interp(ps, env_tv, valid, plcl)
    delta_lcl = _lift_tv(tlcl, _lift_rs(plcl, tlcl)) - env_lcl
    x = np.log(ps)
    x0, x1, d0, d1 = x[:, :-1], x[:, 1:], delta[:, :-1], delta[:, 1:]
    pair = valid[:, :-1] & valid[:, 1:]
    cross_x = _lift_crossing(x0, x1, d0, d1)

    positive = np.any(valid & (ps <= plcl[:, None]) & (delta > 0), 1)
    upward = pair & (d0 <= 0) & (d1 > 0) & (cross_x <= np.log(plcl)[:, None] + 1e-10)
    lfc_is_lcl = positive & ((delta_lcl >= -1e-7) | ~upward.any(1))
    up_index, row = np.argmax(upward, 1), np.arange(p0.size)
    parcel_ok = (np.isfinite(p0) & np.isfinite(t0) & np.isfinite(td0) &
                 (p0 > 0) & (t0 > 150) & (td0 > 150))
    has_lfc = parcel_ok & (count >= 2) & positive & (lfc_is_lcl | upward.any(1))
    x_lfc = np.where(lfc_is_lcl, np.log(plcl), cross_x[row, up_index])

    downward = pair & (d0 > 0) & (d1 <= 0) & (cross_x < x_lfc[:, None])
    indices = np.arange(p.shape[1] - 1)[None, :]
    down_index = np.max(np.where(downward, indices, -1), 1)
    has_el, down_safe = has_lfc & (down_index >= 0), np.maximum(down_index, 0)
    x_el = cross_x[row, down_safe]
    x_top = x[row, np.maximum(count - 1, 0)]
    cape = np.where(has_lfc, np.maximum(_lift_integral(
        x, delta, valid, x_lfc, np.where(has_el, x_el, x_top)), 0), 0)
    cin = np.where(has_lfc, np.minimum(_lift_integral(x, delta, valid, x[:, 0], x_lfc), 0), 0)

    good = parcel_ok & (count >= 2)
    return np.where(good, cape, np.nan), np.where(good, cin, np.nan), np.where(good, plcl, np.nan)


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
        _dry_integrated_sounding(),
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

    # Extra proof, specific to dry_integrated_heights: confirm the retired hypsometric
    # reconstruction (_legacy_cape) actually disagrees with the RH-based lift() on this
    # profile, not just that lift() happens to still match MetPy. If this stops
    # disagreeing by a meaningful margin, the fixture no longer exercises anything and
    # needs more low-level moisture contrast -- asserted, not just printed, so a future
    # edit to the profile can't silently defang it.
    dry = next(s for s in soundings if s["name"] == "dry_integrated_heights")
    dp0, dt0, dtd0, dref_cape, _dref_cin, _dref_lcl = _reference(dry)
    dours_cape = lift(
        np.array([dp0]), np.array([dt0]), np.array([dtd0]),
        dry["p_in"][None] * 100.0, dry["t_in"][None], dry["z_in"][None], dry["rh_in"][None],
    )["cape"][0]
    dlegacy_cape, _dlegacy_cin, _dlegacy_lcl = _legacy_cape(
        np.array([dp0]), np.array([dt0]), np.array([dtd0]),
        dry["p_in"][None] * 100.0, dry["t_in"][None], dry["z_in"][None],
    )
    legacy_vs_ours_pct = 100 * (dlegacy_cape[0] - dours_cape) / dours_cape
    print(f"\ndry_integrated_heights: RH-based CAPE {dours_cape:.1f} J/kg vs "
          f"retired-hypsometric CAPE {dlegacy_cape[0]:.1f} J/kg "
          f"({legacy_vs_ours_pct:+.2f}%); MetPy reference {dref_cape:.1f} J/kg.")
    if abs(legacy_vs_ours_pct) < 3.0:
        raise AssertionError(
            "dry_integrated_heights no longer exercises a real disagreement between "
            f"the RH-based and retired hypsometric paths ({legacy_vs_ours_pct:.2f}%); "
            "the profile needs more low-level moisture contrast to be useful."
        )

    if failures:
        raise AssertionError("Agreement findings exceeded declared tolerance:\n" + "\n".join(failures))
    print(f"\nAll {len(soundings)} cases are within the predeclared tolerances.")
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
