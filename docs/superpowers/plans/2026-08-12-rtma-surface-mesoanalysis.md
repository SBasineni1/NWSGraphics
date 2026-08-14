# RTMA-Adjusted Surface for the Mesoanalysis — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mesoanalysis pipeline's raw-RAP surface with NCEP's observation-assimilated RTMA 2.5 km analysis, and re-lift the convective parcel from it, so the surface-parcel products converge toward SPC's mesoanalysis method.

**Architecture:** `scripts/mesoanalysis_pipeline.py` gains a second GRIB source (RTMA), a vectorized parcel-lift routine, and an inverted `publish()` loop that lifts each unique profile once instead of once per view. The parcel starts at RTMA's surface pressure with RTMA's 2 m temperature and dewpoint, and integrates through RAP's pressure-level profile. Everything stays in the one file, by decision.

**Tech Stack:** Python 3.12, NumPy 2.x, SciPy 1.x, ecCodes 2.x. MetPy is a test-only reference and must never be imported by production code. Node drives publication via `scripts/publish-mesoanalysis.mjs` to Cloudflare R2.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-12-rtma-surface-mesoanalysis-design.md`. Read it before starting; it carries the measurements these tasks assume.
- **One file.** All Python pipeline changes go in `scripts/mesoanalysis_pipeline.py`. Do not split it into a package.
- **Production imports NumPy/SciPy/ecCodes only.** `requirements-mesoanalysis.txt` gains nothing. MetPy goes in a new dev file.
- **Virtual temperature correction is mandatory** in the parcel lift. SPC uses it. Measured on
  synthetic soundings 2026-08-12: applying it versus plain-temperature buoyancy is worth
  **4.8–9.3%** of CAPE, largest on low-CAPE profiles. **Do not confuse that with the difference
  between two *estimators* of environmental Tv** (RH-derived versus hypsometric reconstruction),
  which measures **3.0–5.0%** and cannot structurally exceed the environment-side half of the
  correction. An earlier draft of this constraint conflated the two and sent an implementer
  hunting a 10% figure that this construction can never produce.
- **KD-tree coordinates stay float64.** Measured: float32 coordinates save zero memory (`cKDTree` upcasts internally) and changed 9 of 50,000 nearest-neighbour results, with errors up to 0.82 K dewpoint / 783 Pa. Field *values* may be float32.
- **RTMA longitudes arrive 0–360** and need the same `>180 → −360` normalization RAP gets at line 294.
- **RTMA surface height is `orog`**, not `gh`.
- **Do not touch `bulk_shear_knots()` or the `HLCY` pass-through.** Measured cosmetic; explicitly out of scope.
- **The repository owner commits their own work.** Treat each task's commit step as a checkpoint to stage and hand back for review, not a licence to push.
- **Verification data is staged** at `/private/tmp/claude-501/-Users-suchitbasineni-Documents-GitHub-NWSGraphics/ae9d7200-73a1-42ce-b670-71de1b8895d3/scratchpad/data/` (`rap.t22z.span.grib2`, `rtma.t22z.span.grib2`, plus `.idx` files, cycle 2026-08-12 22Z). Use these for local testing; NOMADS ages files out.
- **A working prototype of the parcel lift** exists at `scratchpad/parcel.py` (213 lines, MetPy-validated). Task 3 adapts it. It lacks the RH input — that is the one substantive change.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scripts/mesoanalysis_pipeline.py` | Modify | All pipeline logic: RAP + RTMA acquisition, decode, parcel lift, per-view assembly |
| `tests/test_mesoanalysis.py` | Modify | Existing helper tests plus parcel, RTMA index, and fallback coverage |
| `requirements-mesoanalysis-dev.txt` | Create | MetPy, test-only |
| `package.json` | Modify | `test` script runs the Python suite |
| `.github/workflows/publish-mesoanalysis.yml` | Modify | Run the Python suite before publishing |
| `app/components/ForecastGraphic.tsx` | Modify | Accept `schemaVersion` 1 or 2; surface provenance in the header |

---

## Task 1: Make the Python tests actually run

`tests/test_mesoanalysis.py` exists and gates nothing — it is in neither `npm test` nor the workflow. Everything downstream depends on this working first.

**Files:**
- Modify: `package.json` (the `test` script)
- Modify: `.github/workflows/publish-mesoanalysis.yml` (after "Install dependencies")
- Modify: `tests/test_mesoanalysis.py`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `npm run test:python` and a CI gate. Later tasks add cases to `tests/test_mesoanalysis.py`.

- [ ] **Step 1: Confirm the suite currently passes standalone**

Run: `python3 -m unittest tests.test_mesoanalysis -v`
Expected: PASS. If it fails, fix the failure before proceeding — that is a pre-existing bug and worth reporting separately.

- [ ] **Step 2: Prove the gate actually fails a build**

Do **not** add a permanent test for this — a test asserting a function's own name asserts
nothing and would rightly be flagged in review. Instead, prove the wiring temporarily.

Add this to `tests/test_mesoanalysis.py`:

```python
    def test_temporary_gate_probe(self):
        self.fail("temporary — proves the CI gate runs this suite")
```

You will run it in Step 4 and delete it in Step 5. It must never be committed.

- [ ] **Step 3: Add the npm script**

In `package.json`, add to `scripts`:

```json
    "test:python": "python3 -m unittest discover -s tests -p 'test_*.py' -t .",
```

and change `test` to append it:

```json
    "test": "npm run build && node --test tests/rendered-html.test.mjs tests/place-search.test.mjs tests/map-frame.test.mjs tests/office-probe.test.mjs && npm run test:python",
```

- [ ] **Step 4: Verify the gate catches a failure**

Run: `npm run test:python`
Expected: **FAIL** on `test_temporary_gate_probe`, with a nonzero exit code. A passing run here
means the suite is not actually being executed and the wiring is wrong.

- [ ] **Step 5: Delete the probe and confirm green**

Remove `test_temporary_gate_probe` from `tests/test_mesoanalysis.py`.

Run: `npm run test:python`
Expected: PASS.

- [ ] **Step 6: Add the CI step**

In `.github/workflows/publish-mesoanalysis.yml`, immediately after the "Install dependencies" step:

```yaml
      - name: Run mesoanalysis unit tests
        if: steps.publication.outputs.enabled == 'true'
        run: python -m unittest discover -s tests -p 'test_*.py' -t .
```

- [ ] **Step 7: Commit**

```bash
git add package.json .github/workflows/publish-mesoanalysis.yml tests/test_mesoanalysis.py
git commit -m "test: wire the mesoanalysis Python suite into npm test and CI"
```

---

## Task 2: Decode RAP relative humidity

The parcel lift needs the environmental moisture profile for the virtual temperature correction. RAP ships `RH` at all 37 pressure levels, already inside the downloaded byte span, and `decode_fields()` discards it.

**Files:**
- Modify: `scripts/mesoanalysis_pipeline.py` (`decode_fields`, around lines 296–304 and the return at 343–346)
- Modify: `tests/test_mesoanalysis.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `decode_fields()` returns an additional `humidities: dict[int, np.ndarray]` keyed by pressure level in mb, values in percent. The return tuple becomes:
  `(latitudes, longitudes, scalars, heights, temperatures, u_winds, v_winds, humidities, surface_height_key, common_levels)`

- [ ] **Step 1: Write a regression guard**

This one pins an existing property rather than driving new code — it exists so a future change
to `record_span` cannot silently strand the RH records outside the downloaded span. It is
expected to pass immediately; that is correct, not a mistake.

Add to `tests/test_mesoanalysis.py`:

```python
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
```

- [ ] **Step 2: Run it**

Run: `python3 -m unittest tests.test_mesoanalysis -v -k humidity`
Expected: PASS.

- [ ] **Step 3: Collect RH in `decode_fields`**

In `decode_fields`, add alongside the other dictionaries near line 267:

```python
    humidities: dict[int, np.ndarray] = {}
```

In the `isobaricInhPa` branch (around line 296), add a case:

```python
                        elif short_name == "r":
                            humidities[level] = values
```

- [ ] **Step 4: Require RH on the common levels and return it**

Replace the `common_levels` computation near line 343 with:

```python
    common_levels = sorted(
        set(heights) & set(temperatures) & set(u_winds) & set(v_winds) & set(humidities),
        reverse=True,
    )
    if len(common_levels) < 8:
        raise RuntimeError("RAP GRIB span has an incomplete 200--1000-mb temperature/height/wind/humidity profile")
    return latitudes, longitudes, scalars, heights, temperatures, u_winds, v_winds, humidities, surface_height_key, common_levels
```

- [ ] **Step 5: Update the caller**

In `publish()`, change the unpack near line 379 to:

```python
    latitudes, longitudes, scalars, heights, temperatures, u_winds, v_winds, humidities, surface_height_key, levels = decode_fields(grib_bytes)
```

- [ ] **Step 6: Verify against staged data**

Run:

```bash
python3 - <<'PY'
import sys; sys.path.insert(0, ".")
from scripts.mesoanalysis_pipeline import decode_fields
data = open("/private/tmp/claude-501/-Users-suchitbasineni-Documents-GitHub-NWSGraphics/ae9d7200-73a1-42ce-b670-71de1b8895d3/scratchpad/data/rap.t22z.span.grib2","rb").read()
out = decode_fields(data)
humidities, levels = out[7], out[9]
print("levels:", len(levels), "rh levels:", len(humidities))
print("rh 500mb range:", humidities[500].min(), humidities[500].max())
PY
```

Expected: at least 30 common levels, RH present, 500 mb RH roughly within 0–100.

- [ ] **Step 7: Commit**

```bash
git add scripts/mesoanalysis_pipeline.py tests/test_mesoanalysis.py
git commit -m "feat: decode RAP pressure-level relative humidity for the parcel lift"
```

---

## Task 3: The vectorized parcel lift

**Files:**
- Modify: `scripts/mesoanalysis_pipeline.py` (new functions, placed after `lapse_rate_c_per_km`)
- Create: `requirements-mesoanalysis-dev.txt`
- Modify: `tests/test_mesoanalysis.py`

**Interfaces:**
- Consumes: nothing at runtime; adapts the prototype at `scratchpad/parcel.py`.
- Produces:

```python
lift(parcel_pressure, parcel_temperature, parcel_dewpoint,
     level_pressure, level_temperature, level_height, level_relative_humidity)
```

`parcel_*` shape `(n_points,)`; `level_*` shape `(n_points, n_levels)`. Pressure Pa, temperature K, height m, RH percent. Returns a dict with keys `cape`, `cin`, `lcl_pressure`, `lcl_height`, `lfc_height`, `el_height`, each shape `(n_points,)`. No LFC returns `cape = cin = 0.0` with `lfc_height`/`el_height` `NaN`.

- [ ] **Step 1: Create the dev requirements file**

Create `requirements-mesoanalysis-dev.txt`:

```
# Test-only. MetPy is the reference implementation the hand-rolled parcel lift is
# validated against. Production (requirements-mesoanalysis.txt) must never install it,
# and scripts/mesoanalysis_pipeline.py must never import it.
-r requirements-mesoanalysis.txt
metpy>=1.7,<2
```

- [ ] **Step 2: Write the failing tests**

Add to `tests/test_mesoanalysis.py`. Note these do **not** import MetPy — they pin behaviour and physical sanity, so the suite still runs in production CI:

```python
import numpy as np

from scripts.mesoanalysis_pipeline import lift


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
```

- [ ] **Step 3: Run to verify they fail**

Run: `python3 -m unittest tests.test_mesoanalysis.ParcelLiftTest -v`
Expected: FAIL with `ImportError: cannot import name 'lift'`.

- [ ] **Step 4: Port the prototype**

Copy the helper functions and `lift` from `scratchpad/parcel.py` into `scripts/mesoanalysis_pipeline.py`, placed after `lapse_rate_c_per_km`.

**Import NumPy at module scope.** The file's docstring currently promises that only `publish()` imports native dependencies, so the helpers stay unit-testable. NumPy is pure-pip and already required by the test suite, so importing it eagerly costs nothing that matters; SciPy and ecCodes stay lazy inside `publish()` and `decode_fields()`. Update the docstring at lines 8–9 to say exactly that.

Then make the one substantive change: replace the prototype's `_environment_tv`, which reconstructs environmental virtual temperature hypsometrically and clips it to `0.998T–1.060T`, with a direct computation from `level_relative_humidity`:

```python
def _environment_tv(pressure, temperature, relative_humidity):
    """Environmental virtual temperature from RH, replacing the prototype's
    hypsometric reconstruction. RAP ships RH on every pressure level we use, so
    there is nothing to reconstruct."""
    saturation = _es(temperature)
    vapor = np.clip(relative_humidity, 0.0, 100.0) / 100.0 * saturation
    mixing = 0.622 * vapor / np.maximum(pressure - vapor, 1.0)
    return _tv(temperature, mixing)
```

Update `lift`'s signature to accept `level_relative_humidity` and call the new `_environment_tv(level_pressure, level_temperature, level_relative_humidity)`.

- [ ] **Step 5: Run the tests**

Run: `python3 -m unittest tests.test_mesoanalysis.ParcelLiftTest -v`
Expected: PASS, all five.

- [ ] **Step 6: Validate against MetPy**

Copy `scratchpad/test_parcel.py` to `tests/test_parcel_metpy.py`, update its import to `from scripts.mesoanalysis_pipeline import lift`, and add the RH argument to every call — pass `np.full_like(temperature, 50.0)` where the prototype had no environmental moisture, then adjust per-sounding to match each case's intended humidity.

Install and run:

```bash
python3 -m venv .venv-meso-dev && .venv-meso-dev/bin/pip install -r requirements-mesoanalysis-dev.txt
.venv-meso-dev/bin/python -m unittest tests.test_parcel_metpy -v
```

Expected: all 8 soundings pass. The prototype achieved worst nonzero-CAPE relative error 8.1% and worst LCL error 0.4 hPa **without** environmental RH. With RH the virtual temperature correction is physical rather than reconstructed, so agreement should improve.

**If any case regresses beyond the prototype's numbers, stop and report it.** Do not loosen a tolerance to make it pass.

- [ ] **Step 7: Add the dev file to gitignore hygiene and commit**

```bash
echo ".venv-meso-dev/" >> .gitignore
git add scripts/mesoanalysis_pipeline.py tests/test_mesoanalysis.py tests/test_parcel_metpy.py requirements-mesoanalysis-dev.txt .gitignore
git commit -m "feat: add vectorized parcel lift with virtual temperature correction"
```

---

## Task 4: RTMA acquisition

**Files:**
- Modify: `scripts/mesoanalysis_pipeline.py` (constants near line 28; new functions after `rap_urls`)
- Modify: `tests/test_mesoanalysis.py`

**Interfaces:**
- Consumes: `cycle_parts`, `fetch_bytes`, `parse_index`, `IndexRecord`.
- Produces:
  - `rtma_urls(cycle) -> tuple[str, str]` — `(grib_url, index_url)`
  - `rtma_record_span(records) -> tuple[int, int]` — inclusive byte range covering `HGT:surface` through `DPT:2 m above ground`

- [ ] **Step 1: Write the failing tests**

```python
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `python3 -m unittest tests.test_mesoanalysis -v -k rtma`
Expected: FAIL with `ImportError`/`NameError` on `rtma_urls`.

- [ ] **Step 3: Implement**

Add near line 29:

```python
RTMA_ROOT = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/rtma/prod"
```

Add after `rap_urls`:

```python
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
```

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest tests.test_mesoanalysis -v -k rtma`
Expected: PASS, all three.

- [ ] **Step 5: Verify against the staged index**

```bash
python3 - <<'PY'
import sys; sys.path.insert(0, ".")
from scripts.mesoanalysis_pipeline import parse_index, rtma_record_span
text = open("/private/tmp/claude-501/-Users-suchitbasineni-Documents-GitHub-NWSGraphics/ae9d7200-73a1-42ce-b670-71de1b8895d3/scratchpad/data/rtma.t22z.idx").read()
print(rtma_record_span(parse_index(text)))
PY
```

Expected: `(0, 26683628)`.

- [ ] **Step 6: Commit**

```bash
git add scripts/mesoanalysis_pipeline.py tests/test_mesoanalysis.py
git commit -m "feat: add RTMA 2.5km URL construction and byte-span selection"
```

---

## Task 5: RTMA decode

**Files:**
- Modify: `scripts/mesoanalysis_pipeline.py` (new function after `decode_fields`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `decode_rtma(grib_bytes) -> tuple[np.ndarray, np.ndarray, dict[str, np.ndarray]]` — `(latitudes, longitudes, fields)` where `fields` has keys `orography`, `surfacePressure`, `temperature2m`, `dewpoint2m`. Values are `float32`; latitudes and longitudes stay `float64`.

- [ ] **Step 1: Implement**

```python
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
```

- [ ] **Step 2: Verify against staged data**

```bash
python3 - <<'PY'
import sys; sys.path.insert(0, ".")
from scripts.mesoanalysis_pipeline import decode_rtma
data = open("/private/tmp/claude-501/-Users-suchitbasineni-Documents-GitHub-NWSGraphics/ae9d7200-73a1-42ce-b670-71de1b8895d3/scratchpad/data/rtma.t22z.span.grib2","rb").read()
lat, lon, fields = decode_rtma(data)
print("points:", lat.size)
print("lon range:", lon.min(), lon.max())
for k, v in sorted(fields.items()):
    print(f"  {k}: dtype={v.dtype} min={v.min():.2f} max={v.max():.2f}")
PY
```

Expected: 3,744,965 points; longitude range roughly −138.3…−60.9 (**negative** — proving the normalization fired); `orography` −81…4226, `surfacePressure` 61510…102838, `temperature2m` 271…321, `dewpoint2m` 263…302; all `float32`.

- [ ] **Step 3: Commit**

```bash
git add scripts/mesoanalysis_pipeline.py
git commit -m "feat: decode the RTMA surface analysis span"
```

---

## Task 6: Cycle pairing with RAP-only fallback

**Files:**
- Modify: `scripts/mesoanalysis_pipeline.py` (`discover_cycle`, `main`'s `--discover-only`)
- Modify: `tests/test_mesoanalysis.py`

**Interfaces:**
- Consumes: `rtma_urls`, `rtma_record_span` from Task 4.
- Produces: `discover_cycle(now=None)` returns `(cycle, grib_url, records, rtma)` where `rtma` is `None` or `(grib_url, byte_range)`. `--discover-only` JSON gains `"surface": "rtma" | "rap"`.

- [ ] **Step 1: Write the failing test**

```python
    def test_discovery_reports_which_surface_it_found(self):
        """A cycle with RAP but no RTMA must still publish, flagged as a raw-RAP
        surface. Walking back an hour for RTMA would serve staler data."""
        from scripts.mesoanalysis_pipeline import surface_label
        self.assertEqual(surface_label(None), "rap")
        self.assertEqual(surface_label(("https://example/rtma", (0, 10))), "rtma")
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 -m unittest tests.test_mesoanalysis -v -k surface`
Expected: FAIL with `ImportError`.

- [ ] **Step 3: Implement**

Add:

```python
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
```

Change `discover_cycle` to return the RTMA probe alongside its existing values — inside the loop, after `record_span(records)` succeeds:

```python
            return cycle, grib_url, records, probe_rtma(cycle)
```

Update `--discover-only` in `main` to unpack four values and emit `"surface": surface_label(rtma)`.

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest tests.test_mesoanalysis -v`
Expected: PASS.

- [ ] **Step 5: Verify against live NOMADS**

Run: `python3 scripts/mesoanalysis_pipeline.py --discover-only`
Expected: JSON including `"surface": "rtma"` for a recent hour. If it reports `"rap"`, re-run a few minutes later — that is the fallback working, not a bug.

- [ ] **Step 6: Commit**

```bash
git add scripts/mesoanalysis_pipeline.py tests/test_mesoanalysis.py
git commit -m "feat: pair the RAP cycle with RTMA, falling back to a raw RAP surface"
```

---

## Task 7: Restructure `publish()` to lift each profile once

Office frames overlap heavily. Sampling per office was fine when a point cost a nearest-neighbour lookup; a parcel lift is far dearer, so the same point must not be lifted repeatedly.

**Files:**
- Modify: `scripts/mesoanalysis_pipeline.py` (`publish`, lines 367–508)

**Interfaces:**
- Consumes: `lift` (Task 3), `decode_rtma` (Task 5), `discover_cycle` (Task 6), `humidities` (Task 2).
- Produces: unchanged per-office JSON shape apart from Task 8's additions.

- [ ] **Step 1: Fetch and decode RTMA inside `publish()`**

`publish()` currently unpacks three values from `discover_cycle()`; Task 6 made it four. Update
the unpack and acquire the RTMA surface before the office loop. When `--cycle` is passed
explicitly, probe RTMA for that same hour rather than inheriting a discovery result:

```python
    if requested_cycle:
        grib_url, index_url = rap_urls(requested_cycle)
        records = parse_index(fetch_bytes(index_url, timeout=20).decode("utf-8"))
        cycle = requested_cycle
        rtma = probe_rtma(requested_cycle)
    else:
        cycle, grib_url, records, rtma = discover_cycle()

    rtma_lat = rtma_lon = None
    rtma_fields = None
    if rtma:
        rtma_url, rtma_range = rtma
        rtma_lat, rtma_lon, rtma_fields = decode_rtma(fetch_bytes(rtma_url, byte_range=rtma_range, timeout=120))
```

A failure decoding RTMA must not lose the whole run: wrap the decode so an exception degrades to
`rtma = None` with a logged reason, taking the same RAP-only path Task 6 established.

- [ ] **Step 2: Build the unique point set before the office loop**

Replace the per-office sampling with a two-phase structure. Phase one, before the loop:

```python
    all_points: dict[tuple[float, float], dict] = {}
    per_office: dict[str, list[dict]] = {}
    for office in offices:
        points = load_view_points(root, office)
        per_office[office] = points
        for point in points:
            all_points.setdefault((round(point["lat"], 4), round(point["lon"], 4)), point)
    unique = list(all_points.values())
```

- [ ] **Step 3: Query both trees once over the unique set**

```python
    unique_lat = np.asarray([p["lat"] for p in unique])
    unique_lon = np.asarray([p["lon"] for p in unique])
    rap_query = np.column_stack((unique_lat, unique_lon * np.cos(np.radians(unique_lat))))
    rap_distance, rap_index = tree.query(rap_query, k=1)
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
```

- [ ] **Step 4: Assemble the profile arrays and lift once**

```python
    n_levels = len(levels)
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
```

- [ ] **Step 5: Key the results and rebuild the office loop**

Build `metrics_by_key: dict[tuple[float, float], dict]` from `lifted` plus the existing RAP scalars, then let the per-office loop look each point up rather than recompute. `surfaceCape` becomes `lifted["cape"]`, `surfaceCin` becomes `-abs(lifted["cin"])`, `lclHeight` becomes `lifted["lcl_height"]`, and `lowLevelLapseRate` re-anchors on the possibly-RTMA `parcel_temperature` and `surface_height`. `mixedLayerCape`/`Cin` and `mostUnstableCape` keep reading RAP's layer-parcel records for now — re-lifting those from the adjusted surface is a follow-up, and the spec's field table says so.

- [ ] **Step 6: Run a scoped end-to-end publish**

```bash
MESO_OUTPUT_ONLY=true python3 scripts/mesoanalysis_pipeline.py --output-dir /tmp/meso-test --only PHI,OUN,FWD
```

Expected: three JSON files. Check that `surfaceCape` values are finite and plausible (0 to ~6000 J/kg), that `lclHeight` is no longer a clean multiple of 125 × the dewpoint depression, and that the run completes in well under a minute.

- [ ] **Step 7: Verify the dedupe actually saved work**

Add a temporary print of `len(unique)` against `sum(len(p) for p in per_office.values())` and confirm the unique count is materially smaller. Remove the print before committing.

- [ ] **Step 8: Commit**

```bash
git add scripts/mesoanalysis_pipeline.py
git commit -m "feat: lift each unique profile once from the RTMA-adjusted surface"
```

---

## Task 8: Payload schema version 2

**Files:**
- Modify: `scripts/mesoanalysis_pipeline.py` (the `payload` dict, lines 463–493)

**Interfaces:**
- Consumes: `surface_label` (Task 6).
- Produces: payload with `schemaVersion: 2` and a top-level `surface: "rtma" | "rap"`.

- [ ] **Step 1: Bump the version and add provenance**

```python
            "schemaVersion": 2,
            "office": office,
            "model": "RAP",
            "surface": surface_label(rtma),
```

- [ ] **Step 2: Rewrite the definitions that are no longer approximations**

```python
                "surfaceCape": "Surface-based CAPE, parcel lifted from the RTMA 2.5 km observation-adjusted surface through the RAP profile",
                "surfaceCin": "Surface-based CIN from the same lift; normalized to negative J/kg",
                "lclHeight": "Surface-parcel LCL AGL from the parcel lift, using Bolton (1980)",
                "lowLevelLapseRate": "0-3 km AGL lapse rate anchored on the RTMA surface temperature and terrain",
```

Leave `mixedLayerCape`, `mixedLayerCin`, `mostUnstableCape`, `midLevelLapseRate`, `precipitableWater`, the two helicities and `bulkShear6km` exactly as they are — none of them changed.

- [ ] **Step 3: Make the fallback honest**

When `surface_label(rtma) == "rap"`, the four definitions above overstate what happened. Select the definition text on the surface actually used:

```python
            "definitions": rtma_definitions() if rtma else rap_definitions(),
```

with `rap_definitions()` returning the current strings and `rtma_definitions()` the new ones.

- [ ] **Step 4: Verify both paths**

Run the scoped publish from Task 7 twice — once normally, once with `MESO_RTMA_ROOT` pointed at a nonexistent host to force the fallback:

```bash
MESO_RTMA_ROOT=https://127.0.0.1:9 python3 scripts/mesoanalysis_pipeline.py --output-dir /tmp/meso-fallback --only PHI
```

Expected: succeeds, `"surface": "rap"`, and the definitions describe a RAP surface.

- [ ] **Step 5: Commit**

```bash
git add scripts/mesoanalysis_pipeline.py
git commit -m "feat: publish mesoanalysis schema v2 with surface provenance"
```

---

## Task 9: Client accepts both schema versions

**Files:**
- Modify: `app/components/ForecastGraphic.tsx` (type at line 35, `mesoanalysisHeaderLines` at line 906)

**Interfaces:**
- Consumes: the Task 8 payload.
- Produces: no new exports.

- [ ] **Step 1: Widen the type**

At line 36, change `schemaVersion: 1;` to:

```ts
  schemaVersion: 1 | 2;
```

and add after `model`:

```ts
  /** Absent on schemaVersion 1 payloads, which always used the raw RAP surface. */
  surface?: "rtma" | "rap";
```

- [ ] **Step 2: Surface the provenance in the header**

Replace `mesoanalysisHeaderLines`:

```ts
function mesoanalysisHeaderLines(payload: MesoanalysisPayload) {
  // A v1 payload predates the RTMA surface and was always raw RAP.
  const surface = payload.surface ?? "rap";
  return {
    valid: `VALID  ${stampLabel(payload.validTime)}`,
    issued: `${payload.model} ANALYSIS CYCLE  ${stampLabel(payload.cycle)}${surface === "rtma" ? "  ·  RTMA SURFACE" : ""}`,
  };
}
```

- [ ] **Step 3: Verify the build**

Run: `npx next build`
Expected: succeeds with no type errors. This is the build that matches production — `npm run build` is vinext and is not the same check.

- [ ] **Step 4: Commit**

```bash
git add app/components/ForecastGraphic.tsx
git commit -m "feat: accept mesoanalysis schema v2 and show surface provenance"
```

---

## Task 10: Scoped rollout

**Files:** none — this is a verification task.

- [ ] **Step 1: Full local suite**

Run: `npm test`
Expected: PASS, including the Python suite from Task 1.

- [ ] **Step 2: MetPy validation still green**

Run: `.venv-meso-dev/bin/python -m unittest tests.test_parcel_metpy -v`
Expected: PASS on all 8 soundings.

- [ ] **Step 3: Scoped manual publish**

Dispatch `publish-mesoanalysis.yml` with `offices: OUN,FWD,TOP`. These are high-convection offices where SFCOA departs most from raw RAP, so a difference should be visible.

- [ ] **Step 4: Compare against the SPC panel**

Open each office's SBCAPE, MLCAPE and LCL products with the SPC comparison shown. Record whether disagreement narrowed against the pre-change state. **The success criterion is reduced and explicable disagreement, not agreement** — SFCOA is not RTMA and this lift is not NSHARP.

- [ ] **Step 5: Go full-domain**

Dispatch with a blank `offices` input. Confirm the run stays inside its 20-minute budget; measured local cost predicts ~2.5 s of added compute, so a timeout means something else is wrong.

- [ ] **Step 6: Update the spec status**

Change the spec header from `Status: Approved, not implemented` to `Status: Implemented YYYY-MM-DD`.

---

## Self-Review

**Spec coverage:** Source acquisition → Tasks 4, 6. Parcel lift → Task 3. Terrain reconciliation → Task 7 Step 3. `publish()` restructure → Task 7. Fields affected → Tasks 7–8. Payload contract → Tasks 8–9. Testing → Tasks 1, 3. Rollout → Task 10. Environmental RH → Task 2. Dropped shear swap → correctly absent, and Global Constraints forbids touching it.

**Known gap, deliberate:** `mixedLayerCape`/`Cin` and `mostUnstableCape` are listed in the spec as moving with RTMA, but Task 7 Step 4 keeps them on RAP's layer-parcel records. Re-lifting a 90 mb mixed-layer parcel from an adjusted surface needs a mixing routine that does not exist yet. **This is a real scope reduction against the approved spec** and should be raised with the repository owner rather than silently shipped — the honest options are to add a Task 11 for the ML parcel or to amend the spec's field table.
