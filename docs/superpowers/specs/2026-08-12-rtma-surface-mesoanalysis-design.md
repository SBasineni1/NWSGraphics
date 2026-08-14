# RTMA-Adjusted Surface for the Mesoanalysis — Design

**Date:** 2026-08-12
**Status:** Approved, not implemented
**Scope:** `scripts/mesoanalysis_pipeline.py` and its payload contract. Lattice density for
wide views is the designated follow-up and is deliberately out of scope — see *Out of scope*.

## Problem

The experimental plots sample the RAP analysis directly and derive several fields from its
pressure-level data. SPC's mesoanalysis does not. SPC uses RAP as a **first guess**, then
blends in surface observations through SFCOA and re-lifts the parcel from that adjusted
surface with NSHARP.

That difference is the reason our plots and the SPC panel beside them disagree, and it is
concentrated in the surface-parcel fields. Raw-RAP SBCAPE routinely departs from SPC's by
hundreds of J/kg in the warm sector, because the warm sector is exactly where surface
observations correct the model most.

Three of our twelve products compound this with approximations that exist only because RAP's
pressure file lacks the underlying field:

| Field | Current derivation | Location | This release |
|---|---|---|---|
| `lclHeight` | 125 m per °C dewpoint-depression rule of thumb | `mesoanalysis_pipeline.py:118` | retired |
| `lowLevelLapseRate` | anchored on RAP's 2 m temperature and 13 km terrain | `mesoanalysis_pipeline.py:128` | re-anchored |
| `bulkShear6km` | interpolates pressure winds against the **10 m** wind | `mesoanalysis_pipeline.py:162` | **left alone** — measured cosmetic |

The goal is to match SPC's **method**, not to match a different model well. That framing was
chosen deliberately over switching to HRRR, which is sharper but would disagree with the SPC
panel by construction — see *Rejected alternatives*.

## Decisions (from brainstorming)

- **Match SPC's method, not merely improve the analysis.** The comparison page shows our plot
  beside SPC's; convergence is the point.
- **RTMA 2.5 km supplies the observation-adjusted surface.** RTMA *is* a variational objective
  analysis of surface observations over a model first guess — structurally what SFCOA is, at
  finer resolution than SPC's own ~40 km grid, published hourly and free. This avoids writing
  a Barnes analysis and ingesting METARs ourselves.
- **The parcel lift is hand-rolled and vectorized, with MetPy as a test-only reference.**
  Production stays lean and fast; correctness is pinned against the community standard.
- **The free RAP fixes are dropped**, on measurement. They were provisionally included; the
  numbers say they are cosmetic — see *Measured: the shear swap is not worth it*.
- **One file.** `mesoanalysis_pipeline.py` stays whole rather than splitting into a package.

## Constraints

Verified against live data on 2026-08-12, not estimated:

| Fact | Value | How known |
|---|---|---|
| RTMA analysis file | `rtma2p5.tHHz.2dvaranl_ndfd.grb2_wexp` | NOMADS directory listing |
| RTMA records 1–4 | `HGT:surface`, `PRES:surface`, `TMP:2m`, `DPT:2m` | fetched `.idx` |
| RTMA records 1–4 contiguity | offsets 0 → 26,683,628 | fetched `.idx` |
| RTMA range request | HTTP **206**, 26,683,629 bytes | fetched against NOMADS |
| RTMA decoded shortNames | `orog`, `sp`, `2t`, `2d` — **not** `gh` | decoded with ecCodes |
| RTMA units | m, Pa, K, K | decoded with ecCodes |
| RTMA grid | Lambert, 2345 × 1597 = **3,744,965 points** | decoded with ecCodes |
| RTMA longitude convention | **0–360** (221.6…300.9) | decoded with ecCodes |
| RTMA value ranges | `orog` −81…4226 m, `sp` 61510…102838 Pa, `2t` 271…321 K, `2d` 263…302 K | decoded with ecCodes |
| RAP range request | HTTP **206**, 15,912,892 bytes | fetched against NOMADS |
| RAP `RH` at pressure levels | 37 levels; 200 mb at 1,648,810, 1000 mb at 10,345,419 — inside the span | fetched RAP `.idx` |
| RAP `VUCSH`/`VVCSH:0-6000 m` | offset 13,345,664 | fetched RAP `.idx` |
| RAP `USTM`/`VSTM:0-6000 m` | offset 13,207,030 | fetched RAP `.idx` |
| RAP `CAPE:0-3000 m` (3CAPE) | offset 17,354,277 | fetched RAP `.idx` |
| RAP span already downloaded | 1,564,933 → 17,477,824 | `record_span()`, confirmed against live `.idx` |
| RAP pressure levels available | 37 | counted `TMP:* mb:anl` records |
| RAP has no LCL record | only `HGT:level of free convection` and `HGT:equilibrium level` | grepped full `.idx` |
| SPC gridded mesoanalysis | no public data endpoint; GIF only | probed `spc.noaa.gov/exper/mesoanalysis/` |
| `tests/test_mesoanalysis.py` | exists, runs in neither `npm test` nor the workflow | read `package.json`, workflow |
| Codex sandbox PyPI access | none | observed install failure during prototyping |

Two consequences drive the design.

**The shear, storm-motion and 3CAPE records are already inside the bytes we download.** They
sit between the span endpoints and are decoded and discarded today. Reading them costs nothing.

**RTMA's resolution advantage is mostly thrown away.** We sample onto lattices of ~250 points
per office and ~1,800 for `US`. We capture the observation *adjustment*, which is the thing
that moves SBCAPE toward SPC, but not the 2.5 km *detail*. This is accepted here and addressed
separately.

## Design

### 1. Source acquisition

`rtma_urls(cycle)` mirrors `rap_urls(cycle)`. One `Range` request, `bytes=0-26683628`, verified
at 26,683,629 bytes, added to RAP's verified 15,912,892 for ~42.6 MB per cycle.

Two decode details that would otherwise be silent bugs, both confirmed against a live file:

- **The surface height record is `orog`, not `gh`.** `decode_fields()` already accepts either for
  RAP, but the RTMA branch must not assume `gh`.
- **RTMA longitudes arrive in 0–360 convention**, so they need the same
  `np.where(longitudes > 180, longitudes - 360, longitudes)` normalization RAP gets at line 294.
  Skipping it puts every RTMA nearest-neighbour query on the far side of the planet from its RAP
  counterpart — a failure that yields plausible-looking numbers, not an error.

`discover_cycle()` gains a companion probe. For a candidate hour it requires **both** RAP and
RTMA indices. If RAP exists and RTMA does not, publish RAP-only for that hour rather than
walking back — a fresher hour on the raw surface beats an hour-old hour on the adjusted one.

**Keying the publisher's skip on cycle and scope alone is what would strand that hour on the raw
surface.** RTMA routinely lands *after* RAP for the same hour, so the hour publishes
`surface: "rap"` and every later run re-discovers the identical cycle and skips — the RTMA data
that arrived minutes later is never picked up. The manifest therefore carries its own `surface`
field (the value actually used, not merely probed), and the publisher compares that against
`--discover-only`'s freshly probed `surface`: it skips on a cycle and scope match **unless** the
compare is an upgrade, `previous.surface === "rap" && discovery.surface === "rtma"`, in which
case the hour is republished on the adjusted surface. A manifest predating the field has no
`surface` to compare, so it is treated as not upgradable and behaves exactly as before.

### 2. The parcel lift

New pure-NumPy functions in the same file, taking batches rather than single points:

```
lift(parcel_pressure, parcel_temperature, parcel_dewpoint,
     level_pressure, level_temperature, level_height, level_relative_humidity)
```

`parcel_*` shape `(n_points,)`, `level_*` shape `(n_points, n_levels)`, pressure in Pa,
temperature in K, height in m, RH in percent. Returns CAPE, CIN, LCL pressure, LCL height AGL,
LFC height and equilibrium level height per point.

**`level_relative_humidity` is not optional, and an earlier draft of this spec wrongly omitted
it.** The virtual temperature correction needs the *environmental* moisture profile. Without it a
prototype reconstructed environmental virtual temperature hypsometrically and clipped the result
to `0.998T–1.060T` to damp the noise — a workaround for a missing input, not a method.

RAP ships `RH` at all 37 pressure levels, and every level from 200 mb down is already inside the
downloaded span: offsets 1,648,810 (200 mb) through 10,345,419 (1000 mb) against a span of
1,564,933–17,477,824. `decode_fields()` discards them today. There is no reason to reconstruct
what is already on disk.

- Dry adiabat to the LCL, saturated pseudoadiabat above.
- **Virtual temperature correction**, which SPC uses. Measured on synthetic soundings: applying
  it versus plain-temperature buoyancy is worth **4.8–9.3%** of CAPE, largest where CAPE is
  smallest. A version without it is not acceptable. Note this is a different quantity from the
  gap between two *estimators* of environmental Tv (RH-derived versus hypsometric), which
  measures 3.0–5.0%.
- Bolton (1980) for LCL temperature and equivalent potential temperature.
- Fully vectorized across points. A bounded loop over levels or a fixed-iteration Newton solve
  is fine; a Python loop over points is not.
- Tolerates NaN levels, unsorted levels, parcels starting below the lowest available level, and
  profiles with no LFC.

### 3. Terrain reconciliation

The parcel starts at RTMA's own `PRES:surface` with RTMA's 2 m T/Td, and integrates through
RAP's pressure-level profile with any level below RTMA's surface pressure discarded.

Pressure is the vertical coordinate, so the profile aloft carries no terrain mismatch; only the
bottom boundary needs care. RTMA's `HGT:surface` becomes the AGL datum for locating the 3 km
level in `lowLevelLapseRate`, which is anchored on RTMA's surface temperature and so must be
anchored on RTMA's terrain to match. This mirrors SFCOA: adjust the surface, keep RAP aloft.

**`lclHeight` deliberately does *not* use RTMA's `HGT:surface`, and an earlier draft of this
spec said it did.** The implementation is `lcl_z - base_z`, where both endpoints are
interpolated from **RAP's** height field — `base_z` at RTMA's surface pressure, `lcl_z` at the
LCL pressure. Differencing two heights read from one height coordinate gives a true geometric
depth. Substituting RTMA's terrain for `base_z` would difference two *different* height
coordinates and inject the RAP-minus-RTMA terrain discrepancy — hundreds of metres across the
Rockies, where the 13 km and 2.5 km orographies disagree most — straight into the LCL. The code
is right; do not "fix" it to match the retired wording.

### 4. Restructuring `publish()`

Today `publish()` loops offices and samples per point, which is correct when a point costs a
nearest-neighbour lookup. A parcel lift is orders of magnitude dearer and office frames overlap
heavily, so the same point would be lifted many times.

The loop inverts: union every view's points, dedupe, lift once as an `(n_points, n_levels)`
array, then per-office assembly becomes a dictionary lookup. Expect ~30–50k unique profiles ×
37 levels.

A second `cKDTree` is built over RTMA's 3,744,965 points alongside the existing RAP tree.

### Measured: the RTMA path is cheap, but float32 coordinates are not safe

Measured 2026-08-12 on the staged 22Z files, excluding network time. Five RTMA trials, three RAP
trials; the RAP figures call the repository's existing `decode_fields()`.

| Stage | RTMA median | RAP median |
|---|---:|---:|
| Read file | 0.0017 s | 0.0015 s |
| Decode and extract grid | 0.1652 s | 1.7328 s |
| Build `cKDTree` | 0.5289 s | 0.0184 s |
| Query 50,000 points | 0.0445 s | 0.0203 s |
| **Total** | **0.7429 s** | **1.7718 s** |

RTMA's grid is 24.6× RAP's, which is the tree multiplier — but RTMA carries 4 messages against
RAP's 314, so the whole RTMA path is *faster* than the RAP path already in place. Combined local
work goes from ~1.77 s to ~2.51 s, roughly 0.06% of the 20-minute budget. Peak RSS during tree
construction was 459.7 MiB, of which the tree itself added 161.6 MiB.

**Store values as float32; keep KD-tree coordinates float64.** Converting the value arrays is
free of consequence — maximum error 1.46 × 10⁻⁵ K for `2t`/`2d` and exactly 0 Pa for `sp` — and
saves 57 MiB across the four arrays. Converting the *coordinates* is a trap:

- `cKDTree` upcasts back to float64 internally, so `tree.data` stays 59,919,440 bytes either way.
  **The memory saving is zero.**
- It changed **9 of 50,000** nearest-neighbour results, near cell boundaries, with sampled
  differences up to **0.82 K** in dewpoint and **783 Pa** in surface pressure.

A 0.82 K dewpoint error at the parcel's starting point propagates straight into CAPE and LCL. The
saving is nil and the cost is a wrong answer that looks right.

### 5. Fields affected

| Moves with RTMA, this release | Unaffected by RTMA |
|---|---|
| `surfaceCape`, `surfaceCin` | `midLevelLapseRate` (700–500 mb) |
| `lclHeight` — exact, retires the rule of thumb | `precipitableWater` (column) |
| `lowLevelLapseRate` — RTMA surface T and terrain | `stormRelativeHelicity1km` / `3km` |
| | `bulkShear6km` |

**`mixedLayerCape` / `Cin` and `mostUnstableCape` are deferred, and this is a deliberate scope
reduction.** Physically they *should* move — the surface is the base of the 90 mb mixed layer,
and the surface parcel is sometimes the most unstable one. But re-lifting them from an adjusted
surface needs a layer-mixing routine that the parcel lift does not provide, and inventing one is
a larger and riskier change than the four fields above.

They keep reading RAP's own `CAPE:90-0 mb` and `CAPE:255-0 mb` records, exactly as today. That is
internally consistent — those records were computed by RAP from RAP's surface — but it does mean
a published office can show an RTMA-based SBCAPE beside a RAP-based MLCAPE. The `surface` field
in the payload describes the surface-parcel fields; it does not claim the layer parcels moved.

**The right column is untouched by this release.** `bulk_shear_knots()` stays, `HLCY` keeps being
passed through, and `lcl_height_metres()` is the only approximation retired — by the parcel lift,
not by a new record.

The 90 mb mixed-layer parcel stays. RAP also ships `CAPE:180-0 mb`, but 90 mb is closer to SPC's
100 mb layer, so the current choice is already correct.

### Measured: the shear swap is not worth it

Measured 2026-08-12 against RAP cycle 22Z, 5,000 points sampled from the 151,987-point grid
(seed 20260812), comparing `bulk_shear_knots()` against `hypot(VUCSH, VVCSH)`:

| Statistic | Value |
|---|---|
| Median absolute difference | **1.297 kt** |
| Mean absolute difference | 1.798 kt |
| RMS difference | 2.431 kt |
| 95th percentile absolute | 5.116 kt |
| Maximum absolute | 10.604 kt |
| Differ by > 10 kt | 5 / 5,000 (0.10%) |
| `bulk_shear_knots()` returned `None` | **0 / 5,000** |

Terrain made less difference than expected: the ≥2500 m bin carries a +1.585 kt signed bias
against +0.385 kt below 500 m, on only 39 sampled points. The suspected failure mode — the
interpolation not bracketing 6 km AGL over high terrain — did not occur once.

Two further reasons to leave it alone. ecCodes reports `VUCSH`/`VVCSH` units as `s**-1` while the
magnitudes behave as m/s bulk wind differences, an unresolved metadata inconsistency; and RAP's
`HLCY` records sit immediately before `USTM`/`VSTM` in the file, so RAP's helicity almost
certainly already assumes that storm motion. Recomputing SRH ourselves from the pressure-level
profile would add numerical difference against RAP's native vertical integration without adding
information.

That last point is circumstantial, reasoned from data layout rather than documentation, because
the measurement environment had no network. **The documentation check on RAP's `HLCY` storm-motion
assumption is outstanding** — but it argues for the status quo, so nothing blocks on it.

### 6. Payload contract

`schemaVersion` 1 → 2. New top-level `surface: "rtma" | "rap"` so a reader can distinguish an
adjusted hour from a fallback hour. `definitions` rewritten — several current strings say
"derived" precisely because of approximations this removes.

The client must tolerate both versions during rollout: R2 objects carry a 5-minute cache and
offices land incrementally, so a mixed fleet is the normal state for several minutes after a
publish.

## Testing

`tests/test_mesoanalysis.py` currently gates nothing. This change is a bad one to land on an
untested pipeline, so:

- Wire it into the `test` script in `package.json`.
- Add a `python -m unittest` step to `publish-mesoanalysis.yml` before the publish step.
- Add `requirements-mesoanalysis-dev.txt` carrying MetPy. It stays out of the hourly production
  install; `requirements-mesoanalysis.txt` is unchanged.
- Validate the lift against MetPy across at least 8 diverse soundings: high-CAPE Great Plains,
  capped warm sector with strong CIN, elevated convection, dry high-desert with a high LCL,
  cold-season low-CAPE, saturated tropical, no-LFC, and one with NaN gaps.
- Tolerances are reported, not tuned to pass. A case that disagrees badly with MetPy is a
  finding.
- Pin the RTMA index parsing and byte-span selection the way `record_span()` is already pinned.
- Pin the RAP-only fallback: a cycle where RTMA is absent must still publish, with
  `surface: "rap"`.

## Rollout

`MESO_OFFICES` already exists for scoped manual dispatches. Publish RTMA-based payloads for a
few high-convection offices first — OUN, FWD, TOP — and compare against the SPC panel already on
the page. Then go full-domain. The manifest's `scope` field already prevents a targeted run from
being mistaken for a complete cycle.

## Open measurements

Dispatched to Codex on 2026-08-12; findings fold into this spec before implementation.

1. ~~**RTMA cost.**~~ **Resolved 2026-08-12: fits comfortably.** See *Measured: the RTMA path is
   cheap, but float32 coordinates are not safe*.
2. ~~**Parcel lift prototype.**~~ **Resolved 2026-08-12: viable.** A vectorized prototype agreed
   with MetPy 1.7.1 on all 8 soundings — worst nonzero-CAPE relative error 8.1% (on a 248 J/kg
   cold-season case, i.e. 20 J/kg absolute), worst LCL error 0.4 hPa — and ran 50,000 × 37 points
   in **0.762 s**. That prototype lacked `level_relative_humidity`; the production implementation
   takes it, so its virtual temperature correction should agree better, not worse.

   Prototype behaviours worth carrying forward: LFC is the first/bottom LFC and EL the last/top
   EL; no LFC returns CAPE = CIN = 0 with LFC/EL `NaN`, matching MetPy's convention; parcel
   *selection* stays outside `lift()`, which diagnoses whatever parcel it is handed. Known and
   accepted departures from MetPy: Bolton LCL against MetPy's Romps formulation, Newton-iterated
   Bolton pseudoadiabat against MetPy's LSODA integration, and liquid-only saturation with no
   ice phase.
3. ~~**Shear and SRH.**~~ **Resolved 2026-08-12: cosmetic, dropped.** See *Measured: the shear
   swap is not worth it*.

## Risks / notes

- **The parcel routine is the risk.** It is the only genuinely new meteorology, it is easy to get
  subtly wrong, and a wrong CAPE looks plausible. The MetPy gate exists for this.
- **RTMA and RAP land at different times.** The fallback path is not an edge case; it will run.
- **Memory.** Measured peak 459.7 MiB with float64 values; float32 values bring that down ~57 MiB.
  Comfortable on a GitHub runner.
- **Convergence is not guaranteed.** Matching SPC's method should move the surface-parcel fields
  toward SPC, but SFCOA is not RTMA and NSHARP is not this routine. The honest success criterion
  is *reduced and explicable* disagreement, not agreement.
- **Verification data must be staged by hand.** The Codex sandbox used for measurement has no
  network — DNS fails outright — so GRIB slices and any new Python dependency have to be placed
  in the working directory before dispatch. Live-fetch verification cannot run there at all.

## Out of scope

- **Lattice density for wide views.** `US` and the seven areas sample at roughly 180 km spacing,
  so they will stay visibly softer than SPC's contours no matter how good the numbers are. This
  is the largest remaining visual gap and the designated follow-up.
- **Switching to HRRR.** See below.
- **New products.** 3CAPE and 0-1 km shear are both cheaply available and both deliberately
  deferred; this release improves the existing twelve rather than widening the catalogue.
- **The `VUCSH`/`VVCSH` shear swap and any SRH recomputation.** Measured cosmetic; see above.
  `bulk_shear_knots()` and the `HLCY` pass-through both stay exactly as they are.

## Rejected alternatives

**HRRR analysis.** `hrrr.tHHz.wrfsfcf00.grib2` carries 11 of the 12 products precomputed,
including `HGT:level of adiabatic condensation from sfc` — a true model LCL, the field RAP lacks
and the reason `lcl_height_metres()` exists at all. It would delete three approximations
outright and resolve convective-scale detail at 3 km.

Rejected because SPC runs RAP. HRRR is a different model, so its output would legitimately
disagree with the SPC panel sitting next to it, and next to that panel a legitimate disagreement
reads as an error. Worth revisiting if the page's framing ever changes from *comparison* to
*best available analysis*.

**Direct SPC grids.** No public data endpoint was found; the mesoanalysis is served as GIFs,
which `app/api/spc-mesoanalysis/route.ts` already relays.

**Ingesting surface observations ourselves.** A Barnes or Cressman analysis of METAR/mesonet
obs is what SFCOA actually does, but NCEP already publishes the result at higher resolution than
SPC uses. Writing our own would be strictly more work for a strictly worse analysis.
