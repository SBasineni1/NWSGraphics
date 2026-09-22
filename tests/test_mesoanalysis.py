import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from scripts.mesoanalysis_pipeline import (
    _es,
    bulk_shear_knots,
    lapse_rate_c_per_km,
    lcl_height_metres,
    lift,
    load_view_points,
    parse_index,
    pressure_layer_lapse_rate,
    record_span,
    rtma_record_span,
    rtma_urls,
    spc_archive_urls,
    spc_sector,
)


class MesoanalysisPipelineTest(unittest.TestCase):
    def test_parses_index_and_bounds_one_contiguous_download(self):
        records = parse_index("\n".join([
            "27:3000:d=2026080914:TMP:225 mb:anl:",
            "28:4000:d=2026080914:HGT:200 mb:anl:",
            "69:5000:d=2026080914:TMP:400 mb:anl:",
            "226:11000:d=2026080914:CAPE:surface:anl:",
            "227:12000:d=2026080914:CIN:surface:anl:",
            "228:13000:d=2026080914:PWAT:entire atmosphere (considered as a single layer):anl:",
            "297:16000:d=2026080914:HGT:level of free convection:anl:",
            "298:17000:d=2026080914:LTNG:surface:anl:",
        ]))
        self.assertEqual(record_span(records), (4000, 16999))

    def test_lcl_uses_temperature_dewpoint_spread(self):
        self.assertEqual(lcl_height_metres(300, 296), 500)
        self.assertEqual(lcl_height_metres(290, 292), 0)

    def test_interpolates_zero_to_three_km_lapse_rate(self):
        profile = [(100, 299), (2100, 286), (4100, 272)]
        value = lapse_rate_c_per_km(300, 100, profile)
        self.assertAlmostEqual(value, 7.0, places=6)

    def test_computes_pressure_layer_lapse_rate(self):
        self.assertAlmostEqual(pressure_layer_lapse_rate(282, 3000, 258, 6000), 8.0)
        self.assertIsNone(pressure_layer_lapse_rate(282, 6000, 258, 3000))

    def test_interpolates_six_km_bulk_shear_in_knots(self):
        profile = [(100, 5, 0), (4100, 15, 0), (8100, 25, 0)]
        value = bulk_shear_knots(5, 0, 100, profile)
        self.assertAlmostEqual(value, 29.157667386609, places=6)

    def test_builds_same_hour_spc_archive_urls(self):
        valid = datetime(2026, 8, 9, 14, tzinfo=timezone.utc)
        urls = spc_archive_urls(valid, 17)
        self.assertEqual(
            urls["surfaceCape"],
            "https://www.spc.noaa.gov/exper/mesoanalysis/s17/sbcp/sbcp_26080914.gif",
        )
        self.assertEqual(urls["surfaceCin"], urls["surfaceCape"])
        self.assertIn("/lllr/lllr_26080914.gif", urls["lowLevelLapseRate"])
        self.assertIn("/mlcp/mlcp_26080914.gif", urls["mixedLayerCape"])
        self.assertEqual(urls["mixedLayerCin"], urls["mixedLayerCape"])
        self.assertIn("/mucp/mucp_26080914.gif", urls["mostUnstableCape"])
        self.assertIn("/srh1/srh1_26080914.gif", urls["stormRelativeHelicity1km"])
        self.assertIn("/srh3/srh3_26080914.gif", urls["stormRelativeHelicity3km"])
        self.assertIn("/shr6/shr6_26080914.gif", urls["bulkShear6km"])
        self.assertIn("/laps/laps_26080914.gif", urls["midLevelLapseRate"])

    def test_selects_mid_atlantic_and_national_sectors(self):
        self.assertEqual(spc_sector(-75.2, 40.0, "PHI"), 17)
        self.assertEqual(spc_sector(-97.0, 38.0, "US"), 19)

    def test_record_span_covers_pressure_level_humidity(self):
        """RH at 200-1000 mb must sit inside the downloaded span, or the parcel
        lift has no environmental moisture and must reconstruct it."""
        records = parse_index("\n".join([
            "28:1564933:d=2026081222:HGT:200 mb:anl:",
            "30:1648810:d=2026081222:RH:200 mb:anl:",
            "191:10345419:d=2026081222:RH:1000 mb:anl:",
            "297:17477825:d=2026081222:HGT:level of free convection:anl:",
            "298:17685677:d=2026081222:LTNG:surface:anl:",
        ]))
        start, end = record_span(records)
        self.assertLessEqual(start, 1648810)
        self.assertGreaterEqual(end, 10345419)

    def test_rtma_urls_use_the_wexp_suffix(self):
        cycle = datetime(2026, 8, 12, 22, tzinfo=timezone.utc)
        grib, index = rtma_urls(cycle)
        self.assertTrue(grib.endswith("rtma2p5.t22z.2dvaranl_ndfd.grb2_wexp"))
        self.assertIn("rtma2p5.20260812", grib)
        self.assertEqual(index, f"{grib}.idx")

    def test_rtma_record_span_covers_surface_through_dewpoint(self):
        records = parse_index("\n".join([
            "1:0:d=2026081222:HGT:surface:anl:",
            "2:7490118:d=2026081222:PRES:surface:anl:",
            "3:14980236:d=2026081222:TMP:2 m above ground:anl:",
            "4:21065993:d=2026081222:DPT:2 m above ground:anl:",
            "5:26683629:d=2026081222:UGRD:10 m above ground:anl:",
        ]))
        self.assertEqual(rtma_record_span(records), (0, 26683628))

    def test_rtma_record_span_rejects_an_incomplete_file(self):
        records = parse_index("\n".join([
            "1:0:d=2026081222:HGT:surface:anl:",
            "2:7490118:d=2026081222:PRES:surface:anl:",
        ]))
        with self.assertRaises(ValueError):
            rtma_record_span(records)

    def test_discovery_reports_which_surface_it_found(self):
        """A cycle with RAP but no RTMA must still publish, flagged as a raw-RAP
        surface. Walking back an hour for RTMA would serve staler data."""
        from scripts.mesoanalysis_pipeline import surface_label
        self.assertEqual(surface_label(None), "rap")
        self.assertEqual(surface_label(("https://example/rtma", (0, 10))), "rtma")

    def test_rtma_and_rap_definitions_differ_on_exactly_the_four_changed_products(self):
        """rtma_definitions() and rap_definitions() must describe the same eight
        untouched products identically, and differ only on the four Task 7 changed
        (surfaceCape, surfaceCin, lclHeight, lowLevelLapseRate) -- otherwise the two
        dicts can silently drift apart as either one is edited."""
        from scripts.mesoanalysis_pipeline import rap_definitions, rtma_definitions
        rap = rap_definitions()
        rtma = rtma_definitions()
        self.assertEqual(set(rap), set(rtma))
        changed = {key for key in rap if rap[key] != rtma[key]}
        self.assertEqual(changed, {"surfaceCape", "surfaceCin", "lclHeight", "lowLevelLapseRate"})
        unchanged = set(rap) - changed
        self.assertEqual(
            unchanged,
            {
                "mixedLayerCape",
                "mixedLayerCin",
                "mostUnstableCape",
                "midLevelLapseRate",
                "precipitableWater",
                "stormRelativeHelicity1km",
                "stormRelativeHelicity3km",
                "bulkShear6km",
            },
        )


class ParcelLiftTest(unittest.TestCase):
    def _profile(self, surface_t=303.0, surface_td=294.0, lapse=7.0):
        """A single synthetic sounding: 37 levels, 1000 mb to 200 mb."""
        pressure = np.linspace(100000.0, 20000.0, 37)[None, :]
        height = np.linspace(100.0, 12000.0, 37)[None, :]
        temperature = (surface_t - lapse * (height - height[0, 0]) / 1000.0)
        humidity = np.full_like(temperature, 60.0)
        return pressure, temperature, height, humidity

    def test_moist_unstable_profile_has_positive_cape(self):
        pressure, temperature, height, humidity = self._profile()
        out = lift(
            np.array([100000.0]), np.array([303.0]), np.array([294.0]),
            pressure, temperature, height, humidity,
        )
        self.assertGreater(out["cape"][0], 0.0)
        self.assertLessEqual(out["cin"][0], 0.0)
        self.assertTrue(np.isfinite(out["lcl_height"][0]))

    def test_no_lfc_returns_zero_cape_and_nan_levels(self):
        # A deeply stable profile: 2 C/km lapse rate and a dry parcel.
        pressure, temperature, height, humidity = self._profile(surface_t=283.0, lapse=2.0)
        out = lift(
            np.array([100000.0]), np.array([283.0]), np.array([253.0]),
            pressure, temperature, height, np.full_like(humidity, 10.0),
        )
        self.assertEqual(out["cape"][0], 0.0)
        self.assertTrue(np.isnan(out["lfc_height"][0]))

    def test_lcl_rises_as_the_parcel_dries(self):
        pressure, temperature, height, humidity = self._profile()
        moist = lift(np.array([100000.0]), np.array([303.0]), np.array([298.0]),
                     pressure, temperature, height, humidity)
        dry = lift(np.array([100000.0]), np.array([303.0]), np.array([283.0]),
                   pressure, temperature, height, humidity)
        self.assertLess(moist["lcl_height"][0], dry["lcl_height"][0])

    def test_tolerates_nan_levels_without_returning_nan_cape(self):
        pressure, temperature, height, humidity = self._profile()
        temperature = temperature.copy()
        temperature[0, 5] = np.nan
        height = height.copy()
        height[0, 5] = np.nan
        out = lift(
            np.array([100000.0]), np.array([303.0]), np.array([294.0]),
            pressure, temperature, height, humidity,
        )
        self.assertFalse(np.isnan(out["cape"][0]))

    def test_is_vectorized_across_points(self):
        pressure, temperature, height, humidity = self._profile()
        n = 64
        out = lift(
            np.full(n, 100000.0), np.full(n, 303.0), np.full(n, 294.0),
            np.repeat(pressure, n, axis=0), np.repeat(temperature, n, axis=0),
            np.repeat(height, n, axis=0), np.repeat(humidity, n, axis=0),
        )
        self.assertEqual(out["cape"].shape, (n,))
        self.assertTrue(np.allclose(out["cape"], out["cape"][0]))

    def test_pins_standard_profile_cape_against_scale_regressions(self):
        """The other ParcelLiftTest cases only check sign, monotonicity, NaN
        tolerance and vectorization -- none constrains magnitude, so a uniform scale
        error survives every one of them (verified: swapping the integral's RD
        constant for G, halving the integral, or dropping the virtual-temperature
        correction entirely all pass every other test in this file). This pins the
        actual CAPE lift() computes for the standard profile, cross-checked against
        MetPy 1.7.1 in tests/test_parcel_metpy.py (see task-3-report.md for that run's
        output) so a magnitude regression is caught here with no MetPy present."""
        pressure, temperature, height, humidity = self._profile()
        out = lift(
            np.array([100000.0]), np.array([303.0]), np.array([294.0]),
            pressure, temperature, height, humidity,
        )
        self.assertAlmostEqual(out["cape"][0], 5956.173836227748, delta=1.0)

    def test_pins_dry_integrated_heights_cape_against_scale_regressions(self):
        """A second magnitude gate, on a profile whose heights are hydrostatically
        integrated from dry temperature rather than virtual temperature --
        deliberately physically inconsistent, so it can only match MetPy if lift()
        gets environmental buoyancy from RH rather than leaking it in through height.
        The retired pre-Task-3 hypsometric reconstruction disagreed with the RH path
        on this exact profile by +5.01% (see tests/test_parcel_metpy.py's
        dry_integrated_heights case and task-3-report.md). Built without MetPy: the
        anchor interpolation, dry hydrostatic integration, and Bolton RH (via the
        production _es) below are plain NumPy, matching that case's inputs exactly."""
        base = 1000.0
        p = np.arange(base, 99.9, -25.0)
        anchors = np.array([base, base - 75, base - 150, 700, 500, 300, 200, 100])
        t_values = np.array([30, 26, 22, 10, -8, -36, -55, -72], dtype=float)
        td_values = np.array([28, 24, 20, 8, -10, -38, -57, -74], dtype=float)
        t = np.interp(p, anchors[::-1], t_values[::-1]) + 273.15
        td = np.minimum(np.interp(p, anchors[::-1], td_values[::-1]) + 273.15, t)
        z = np.zeros_like(p)
        z[1:] = np.cumsum(
            287.04749097718457 * 0.5 * (t[:-1] + t[1:]) / 9.80665 * np.log(p[:-1] / p[1:])
        )
        rh = np.clip(100.0 * _es(td) / _es(t), 0.0, 100.0)
        out = lift(
            np.array([p[0] * 100.0]), np.array([t[0]]), np.array([td[0]]),
            (p * 100.0)[None], t[None], z[None], rh[None],
        )
        self.assertAlmostEqual(out["cape"][0], 7972.4205080191905, delta=1.0)
        self.assertAlmostEqual(out["cin"][0], -5.69075932046221, delta=0.5)
        self.assertAlmostEqual(out["lcl_pressure"][0], 97144.41346726583, delta=50.0)


class LoadViewPointsTest(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.root = Path(self._dir.name)
        for sub in ("gridpoints", "cities", "meso-lattice"):
            (self.root / "public" / sub).mkdir(parents=True)
        city = {"id": "US-new-york", "name": "New York", "state": "NY", "lat": 40.66, "lon": -73.94}
        for view in ("US", "PHI"):
            (self.root / "public" / "gridpoints" / f"{view}.json").write_text(json.dumps([
                {"id": f"grid-{view}-1", "wfo": "PHI", "x": 1, "y": 1, "lat": 40.0, "lon": -75.0},
            ]))
            (self.root / "public" / "cities" / f"{view}.json").write_text(json.dumps([city]))
        (self.root / "public" / "meso-lattice" / "US.json").write_text(json.dumps([
            {"id": "meso-US-0-0", "lat": 41.0, "lon": -76.0},
            {"id": "meso-US-1-0", "lat": 41.0, "lon": -75.5},
        ]))

    def tearDown(self):
        self._dir.cleanup()

    def test_a_wide_view_samples_its_meso_lattice_instead_of_the_forecast_lattice(self):
        points = load_view_points(self.root, "US")
        unlabelled = [point for point in points if not point.get("label")]
        self.assertEqual([point["id"] for point in unlabelled], ["meso-US-0-0", "meso-US-1-0"])
        # Trimmed to what the renderer reads; a missing label means unlabelled.
        self.assertEqual(set(unlabelled[0]), {"id", "lat", "lon"})

    def test_cities_still_come_from_the_view_labels(self):
        labelled = [point for point in load_view_points(self.root, "US") if point.get("label")]
        self.assertEqual([(point["name"], point["state"]) for point in labelled], [("New York", "NY")])

    def test_a_view_without_a_meso_lattice_keeps_the_forecast_lattice(self):
        points = load_view_points(self.root, "PHI")
        self.assertEqual(points[0], {"id": "grid-PHI-1", "name": "", "state": "", "lat": 40.0, "lon": -75.0, "label": False})
        self.assertEqual(len(points), 2)

    def test_a_view_with_no_forecast_lattice_is_skipped_even_with_a_meso_lattice(self):
        # The office list is enumerated from public/gridpoints/, so a stray lattice file for
        # a view that no longer exists must not resurrect it.
        (self.root / "public" / "gridpoints" / "US.json").unlink()
        self.assertEqual(load_view_points(self.root, "US"), [])


if __name__ == "__main__":
    unittest.main()
