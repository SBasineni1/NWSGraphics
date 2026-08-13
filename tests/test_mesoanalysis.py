import unittest
from datetime import datetime, timezone

import numpy as np

from scripts.mesoanalysis_pipeline import (
    bulk_shear_knots,
    lapse_rate_c_per_km,
    lcl_height_metres,
    lift,
    parse_index,
    pressure_layer_lapse_rate,
    record_span,
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


if __name__ == "__main__":
    unittest.main()
