# Multi-Office Forecast Graphics — Design

**Date:** 2026-07-24
**Status:** Implemented — see *Implementation notes* for where the build diverged

## Problem

The forecast graphics cover only the Philadelphia / Mount Holly (PHI) County Warning
Area. Two gaps:

1. **Single office.** PHI is hardcoded end to end — the CWA geojson, the grid-point
   lattice, the labeled cities, the sidebar brand mark, and the R2 publish keys. There is
   no way to view New York (OKX), State College (CTP), or Baltimore/Washington (LWX),
   so the site does not cover the Mid-Atlantic region it sits in.
2. **Blank surroundings.** The color raster is hard-clipped to the CWA polygon
   (`ForecastGraphic.tsx:439-443`), so everything outside the forecast area renders as
   bare Carto basemap. The graphic reads as an island. Filling the frame with real
   neighboring-office data makes the product look complete even though the forecast
   responsibility stops at the boundary.

## Decisions (from brainstorming)

- **Four offices: PHI, OKX, CTP, LWX**, selected by a **region → office dropdown**
  driven by a config table. Eastern Region only for now — no placeholder groups for
  regions with no offices. Adding a fifth office is one config entry plus a rebuild.
- **Uniform full-strength fill edge to edge.** The field renders at the same opacity
  inside and outside the CWA; the forecast area is marked *only* by its heavy outline.
  No dimming, no feathering.
- **Publish all four offices** (4 × 3 days × 5 products = 60 canvases per release) and
  **add release retention** so R2 does not grow unbounded.

## Scope

**In scope:** office registry and dropdown UI, per-office data fetch and rendering,
four-CWA boundary asset, widened overlay assets, regional grid-point lattice, per-office
labeled cities, edge-to-edge raster fill, the render performance work that fill requires,
publisher multi-office output + retention, manifest schema v2, test updates.

**Out of scope (YAGNI):** offices outside Eastern Region, per-office product lists or
color scales, per-office canvas aspect ratios (see Known Limitations), interactive
pan/zoom, marine/offshore gridpoints, changes to the five existing products.

## Reference geometry

CWA bounds and derived render frames, computed at zoom 7 with the existing 1.02/1.03
padding and 900×760 aspect fit:

| Office | CWA bounds (W, S, E, N) | Render frame (W, S, E, N) |
| --- | --- | --- |
| PHI | −76.44, 38.45, −73.97, 41.36 | −77.52, 38.41, −72.89, 41.40 |
| OKX | −74.76, 40.50, −71.79, 41.71 | −74.79, 40.14, −71.76, 42.07 |
| CTP | −79.61, 39.72, −75.76, 42.00 | −79.65, 39.60, −75.72, 42.11 |
| LWX | −79.81, 37.54, −75.77, 39.72 | −79.85, 37.26, −75.73, 39.98 |

Union of all four frames: **−79.85, 37.26, −71.76, 42.11**.

Because each frame sits close to its own CWA, the four offices largely cover one
another. The uncovered remainder is a thin perimeter band — most visibly OKX's northern
strip into interior Connecticut and LWX's southern strip toward Roanoke.

## Design

### 1. Office registry

New `app/offices.ts` — a plain data module imported by both the client component and the
edge route (so `OfficeId` is defined once, unlike `ProductId` which stays duplicated):

```ts
export type OfficeId = "PHI" | "OKX" | "CTP" | "LWX";

export type Office = {
  id: OfficeId;
  city: string;      // "Mount Holly"
  state: string;     // "NJ"
  label: string;     // "Philadelphia / Mount Holly"
};

export const REGIONS: Array<{ id: string; name: string; offices: Office[] }> = [
  {
    id: "eastern",
    name: "Eastern Region",
    offices: [
      { id: "PHI", city: "Mount Holly",   state: "NJ", label: "Philadelphia / Mount Holly" },
      { id: "OKX", city: "Upton",         state: "NY", label: "New York City" },
      { id: "CTP", city: "State College", state: "PA", label: "Central Pennsylvania" },
      { id: "LWX", city: "Sterling",      state: "VA", label: "Baltimore / Washington" },
    ],
  },
];

export const DEFAULT_OFFICE: OfficeId = "PHI";
export const OFFICES = REGIONS.flatMap((region) => region.offices);
export function findOffice(id: string | null | undefined): Office;  // falls back to PHI
```

**Selection is a `?office=PHI` query param**, read on mount and written on change via
`history.replaceState` (no navigation, no re-fetch of the page shell). Rationale: office
becomes deep-linkable and shareable, and the publisher drives the four variants by
navigating to `?office=XXX` rather than synthesizing dropdown clicks.

### 2. Shared frame geometry

`build-grid-points.mjs` must compute the *exact* frames the client renders, or the
lattice will not line up with the canvas. Duplicating the Mercator math in both a `.mjs`
script and a `.tsx` component invites silent drift.

Extract `worldPoint`, `inverseWorld`, `plotExtent`, `project`, and the new
`frameBounds(cwaBounds)` (extent → lat/lon corners) from `ForecastGraphic.tsx` into
**`lib/map-frame.mjs`** — plain JS with JSDoc types. Imported by the component (through
the bundler) and by the build scripts (through Node).

Add `"**/*.mjs"` to `tsconfig.json`'s `include` array so the module is type-checked;
`allowJs` is already `true`.

`PLOT_WIDTH` (900), `MAP_HEIGHT` (760), and the zoom-7 constant move here too, since
both sides need them to agree.

### 3. Boundary and overlay assets

**`public/cwa.geojson`** replaces `public/phi-cwa.geojson` — one FeatureCollection with
four features carrying the existing `{ wfo, cwa, citystate }` properties.

New **`scripts/build-cwa.mjs`** fetches it (verified working, returns the same property
schema as the current hand-placed file):

```
https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/
  nws_reference_map/MapServer/1/query
  ?where=CWA IN ('PHI','OKX','CTP','LWX')
  &outFields=WFO,CWA,CITYSTATE&returnGeometry=true&outSR=4326&f=geojson
```

Coordinates are rounded to 4 decimals to match the existing asset's precision. Note the
source returns `Polygon` for CTP and `MultiPolygon` for the other three, so consumers
must handle both — `traceBoundary()` currently assumes `MultiPolygon` only and needs the
same Polygon/MultiPolygon normalization `traceCounties()` already does.

**`boundaryBounds()`** currently hardcodes `boundary.features[0]`. It takes an
`OfficeId` and selects the feature by `properties.cwa`.

**`build-counties.mjs`**: widen `BBOX` from `−77.5, 37.8, −73.0, 42.2` to
`−80.0, 37.1, −71.6, 42.2`. Add WV (`54`), CT (`09`), RI (`44`), MA (`25`) to the
`STATES` set alongside the existing NJ/PA/DE/MD/NY/VA. Expected growth: ~186 KB → ~450 KB.

**`build-overlays.mjs`**: widen `FRAME` to the same union box (`REGION`, used for state
outlines, is already `−80.5, 37.0, −71.5, 43.2` and needs no change). Expected growth of
`interstates.geojson`: ~60 KB → ~150 KB.

One asset per layer, shared by all four offices — the extra ~350 KB total is cheaper
than four per-office fetch paths, and the client already loads these once and reuses
them across all fifteen plots.

### 4. Grid-point lattice

`scripts/build-grid-points.mjs` currently lattices the PHI polygon at 0.22° and writes
`{ id, wfo, x, y }`. New behavior:

1. Load all four CWA features and compute each office's frame via `lib/map-frame.mjs`.
2. Lattice the union of the four frames:
   - **0.22° step** at any sample inside any CWA polygon — matches today's PHI density.
   - **0.45° step** at any sample inside some frame but outside every CWA.
3. Resolve each sample through `api.weather.gov/points/{lat},{lon}`, dedupe by
   `{gridId, gridX, gridY}` as today.
4. Tag each resolved point with **`offices: OfficeId[]`** — every office whose frame
   contains the sample — and keep the sample's `lat`/`lon`.

Output shape (`app/api/forecast/grid-points.json`):

```json
[{ "id": "grid-PHI-50-79", "wfo": "PHI", "x": 50, "y": 79,
   "lat": 39.95, "lon": -75.17, "offices": ["PHI", "OKX"] }]
```

Expected counts, measured against the real polygons:

| Band | Points |
| --- | --- |
| Inside CWAs @ 0.22° | ~330 (CTP 128, LWX 103, PHI 79, OKX 38) |
| Frame-but-outside-CWA @ 0.45° | ~75 |
| **Total lattice** | **~405** |

The coarse outer band is what prevents IDW from smearing a flat blob across frame edges
where no CWA data exists. It is deliberately sparse — it exists for visual continuity,
not for detail.

### 5. Labeled cities

`LABEL_LOCATIONS` in `route.ts` hardcodes gridpoint `x`/`y` per city. Hand-authoring 40
more is error-prone, so add **`scripts/build-city-points.mjs`**: it takes a curated
lat/lon list, resolves each through `api.weather.gov/points/`, and writes
`app/api/forecast/city-points.json` with the same shape as the existing entries plus an
`office` field.

**The script validates that the resolved `gridId` matches the office the city is listed
under, and fails loudly on a mismatch.** Several counties near CWA borders are easy to
misattribute by hand (Somerset PA and McKean PA in particular sit near the CTP/PBZ
line); this check makes the authored list self-correcting rather than silently wrong.

Proposed lists — **please correct these during spec review**:

**PHI (17, unchanged):** Philadelphia, Allentown, Reading, Mt Pocono, Sussex,
Morristown, Somerville, Trenton, Long Branch, Toms River, Wilmington, Vineland, Dover,
Atlantic City, Cape May, Bethany Beach, Easton MD.

**OKX (13):** New York, Newark, Jersey City, Paterson, White Plains, Hempstead, Islip,
Riverhead, Montauk, Bridgeport, New Haven, Danbury, New London.

**CTP (14):** Harrisburg, State College, Williamsport, Altoona, Johnstown, Lancaster,
York, DuBois, Bradford, Wellsboro, Chambersburg, Somerset, Lewistown, Selinsgrove.

**LWX (14):** Washington, Baltimore, Frederick, Hagerstown, Cumberland, Annapolis,
Winchester, Charlottesville, Fredericksburg, Manassas, Culpeper, Martinsburg,
Leonardtown, Luray.

**Only the selected office's cities are labeled.** The fill extends past the boundary,
but annotated values stay inside the area of responsibility.

### 6. Forecast API

`app/api/forecast/route.ts` gains an `?office=` query param (defaults to `PHI`,
unrecognized values fall back to `PHI`):

- `LOCATIONS` is filtered to grid points whose `offices` array contains the requested
  office, plus that office's cities from `city-points.json`. A request fans out to ~200
  gridpoints rather than all ~405.
- Batch size goes **12 → 24** to hold latency near today's, since the point count roughly
  doubles per request.
- The response gains `office` alongside `generatedAt` / `updatedAt` / `days` / `points` /
  `failures`. Cache headers are unchanged.
- Timezone handling (`America/New_York` anchoring, the three-day window) is untouched.
  All four offices are Eastern, so no per-office timezone logic is needed.

**Who actually calls this route.** Worth being precise, because it determines which costs
are real:

| Path | Calls `/api/forecast`? | Where it runs |
| --- | --- | --- |
| Visitor, published assets configured | **No** — reads `latest.json` and PNGs from R2 | — |
| Publisher (GitHub Actions) | Yes, 4× per release | Local Miniflare on the runner (`PLOT_SITE_URL=http://localhost:3000`) |
| Visitor, live-canvas fallback | Yes, 1× per office viewed | Deployed Cloudflare Worker |

In the normal production path the route is never invoked at all. The publisher's calls
execute in local dev on a GitHub runner, where Cloudflare's deployed-runtime limits do
not apply. Only the fallback path — env var unset, or a manifest that is unreadable or
missing the selected office — puts this fan-out on a real Worker invocation.

**Why per-office scoping, then.** Not a Cloudflare limit. It halves the load the hourly
publish job puts on `api.weather.gov`:

| | Upstream gridpoint calls per publish |
| --- | --- |
| Scoped (`?office=`) | 281 + 109 + 221 + 240 = **851** |
| Unscoped | 4 × 481 = **1,924** |

and it keeps the fallback path's response time reasonable rather than fetching ~481
points to draw a frame that shows a fraction of them.

**Subrequest ceiling, for the fallback path only.** Workers allows **10,000** subrequests
per invocation on paid plans and **50** on free (a subrequest is any outbound `fetch()`
plus R2/KV/D1 calls; each hop of a redirect chain counts separately). Peak per-office
fan-out is 281, so paid has ~35× headroom. Free would fail — and because the route uses
`Promise.allSettled` with a `failures` counter, it would degrade silently to a sparse
field rather than erroring. The pre-existing route already issued 78, so a working
deployment is necessarily already on Workers Paid.

The existing `cf: { cacheTtl: 900 }` means
points shared between office frames are served from Cloudflare's cache on the second
through fourth office, so the publisher's four sequential calls cost far less than 4×.

### 7. Rendering

**Edge-to-edge fill.** Remove the `traceBoundary` + `context.clip("evenodd")` wrapper
around `drawImage(raster, …)` at `ForecastGraphic.tsx:439-443` so the raster covers the
full canvas at its existing `fillAlpha` (185 for temps/wind, 235 for precipitation). The
2.4px CWA outline at line 460 stays and becomes the sole marker of the forecast area.
County, state, and interstate overlays continue to draw across the whole frame as they
do today.

**Performance — required, not optional.** `sampleField` runs per pixel against every
point: 900 × 760 = 684,000 pixels × 78 points today. At ~200 in-frame points that is a
2.5× increase on top of an already-expensive loop, pushing a single plot into multiple
seconds and a fifteen-plot day-view well past usable. Two self-contained fixes:

1. **Stride-4 field sampling with bilinear interpolation.** Evaluate `sampleField` on a
   lattice of `ceil(900/4) + 1 = 226` by `ceil(760/4) + 1 = 191` samples — 43,166
   evaluations instead of 684,000, a 16× cut — and bilinearly interpolate between them
   to fill the raster. The `+ 1` matters: the lattice must include a sample *at or past*
   the far edge in each axis, or the last three pixel columns and rows have no upper
   neighbor to interpolate against and will show a hard seam. The field is already
   smooth (IDW over 8 neighbors with a 0.0005 distance floor), so at 4px the difference
   is not visible. **Interpolate the value, then color it** — interpolating colors
   instead would muddy the ramp bands.
2. **Precomputed 1024-entry color LUT per product.** `colorFor` calls `hexToRgb`, which
   runs three `parseInt`s on string slices, once per pixel — 684,000 times per plot for
   a function with at most 18 distinct inputs. Build one `Uint8ClampedArray(1024 * 3)`
   per `ProductSpec`, memoized by product id. Index it by the value normalized across
   the product's own stop range — `(value - stops[0].value) / (stops.at(-1).value -
   stops[0].value)`, clamped to `[0, 1]` — which preserves today's clamping behavior at
   both ends of `colorFor`. Note the stops are **not** evenly spaced (QPF runs 0, 0.01,
   0.1, 0.25, 0.5, 1, 2, 3), so the LUT must be filled by evaluating the existing
   piecewise-linear `colorFor` at each of the 1024 positions — not by interpolating
   between stops at uniform intervals.

Net effect: each plot should render *faster* than today despite carrying more data.

**Bounds and labels** derive from the selected office: `boundaryBounds(boundary, office)`
sets the frame, and the label pass filters to that office's cities.

### 8. UI

The `PHI` pill (`ForecastGraphic.tsx:690`, `.brand-mark` in `globals.css`) becomes the
dropdown trigger, keeping its current shape and position:

- Click or `Enter`/`Space` opens a listbox grouped by region — one `EASTERN REGION`
  heading over four options, each showing code plus city (`PHI · Mount Holly NJ`).
- Arrow keys move between offices across group boundaries; `Escape` closes and restores
  focus to the trigger; click-outside closes. `role="listbox"` / `role="option"` with
  `aria-selected`, and `aria-expanded` on the trigger.
- Selecting an office sets `?office=`, which re-runs the forecast fetch and re-renders.

The `weather.gov/phi` external link currently wrapping the brand mark moves out of the
trigger (a button cannot nest an anchor) and becomes a separate link in the sidebar
footer, pointing at the selected office's `weather.gov/{office}` page.

Sidebar footer text, the `<h1>`, and each canvas `aria-label` use the office label
instead of the hardcoded "PHI".

### 9. Publishing

`scripts/publish-forecast-plots.mjs`:

- Wrap the existing day loop in an **office loop**, navigating to
  `${siteUrl}/?office=${id}` per office and re-running the existing
  `data-render-state === "ready"` wait.
- Fetch `/api/forecast?office=${id}` per office for the route-interception stub; the
  change-detection check (`updatedAt` + `sourceRevision`) uses the **PHI** payload as the
  trigger for the whole release, since all four offices publish together.
- Keys become `releases/{releaseId}/{office}/day-{n}/{product}.png` (and
  `-preview.png`).

**Manifest schema v2:**

```jsonc
{
  "schemaVersion": 2,
  "releaseId": "20260724T1530Z",
  "updatedAt": "...", "generatedAt": "...", "sourceRevision": "...",
  "offices": {
    "PHI": { "days": [ { "date": "...", "label": "...", "shortLabel": "...",
                         "products": { "apparentTemperature": { "preview": "...",
                           "download": "...", "width": 1800, "height": 1712 } } } ] }
  }
}
```

The client's guard at `ForecastGraphic.tsx:646` retargets to `schemaVersion !== 2` and
additionally requires the selected office to be present in `offices`; failing either,
it falls back to the live canvas path. `/api/published-forecast` and
`/api/forecast-assets/[...path]` are unchanged — but **the path-validation regex in the
asset route must be widened to admit the new `{office}` path segment**, and must stay
strict (anchored, no traversal).

**Retention.** After `latest.json` is written, a prune step lists objects under
`releases/` (`ListObjectsV2`, paginated), groups them by release id, and deletes every
release older than `RELEASE_RETENTION_DAYS` (default **7**), never touching the release
just written. Seven days is far beyond the client's 15-minute refresh interval, so no
viewer can hold a manifest referencing deleted objects. Without this, R2 accumulates
roughly 36 GB/month at ~150 MB per release.

`.github/workflows/publish-forecast-plots.yml`: `timeout-minutes` **30 → 90**. Cron
schedule is unchanged.

### 10. Tests

`tests/rendered-html.test.mjs` asserts heavily against source text, and this change
invalidates several assertions that must be retargeted rather than deleted:

- `context.clip("evenodd")` — the raster clip is removed.
- `index += 12` — batch size is now 24.
- `phiPoints.length / points.length > 0.8` — PHI is now ~20% of the lattice; this
  becomes a per-office coverage assertion (every office has a non-trivial share).
- `boundary.features[0].properties.wfo === "PHI"` — becomes: `cwa.geojson` contains all
  four offices, each with a Polygon or MultiPolygon geometry.
- `releases/${id}/day-` in the publisher — key shape now includes the office segment.
- `PHI Forecast Graphics` in the rendered HTML — the SSR default is still PHI, so this
  holds, but the assertion should key off the office label rather than the bare code.

New coverage: the office registry shape, `?office=` handling in `route.ts`, per-office
`offices[]` tagging in `grid-points.json`, `city-points.json` office attribution, the
widened asset-route path regex, manifest v2 in the publisher, and the retention step.

## Implementation notes

Where the build diverged from the design above, and why:

- **CWA geometry needed simplification.** The map service returns county-resolution
  polygons — 62,870 vertices for PHI alone, 12× the hand-placed asset, for a 2.3 MB
  file. `build-cwa.mjs` now applies iterative Douglas-Peucker at 0.001°, which is well
  under one device pixel at the zoom-7 render scale: 420 KB for all four, with PHI at
  10,882 vertices (still twice the detail of the old asset).
- **A 0.3° frame margin was added** to office membership in the lattice. Points slightly
  past a frame edge give the interpolation neighbours on both sides; without them the
  canvas border is extrapolated from one direction only.
- **The office parameter uses `useSyncExternalStore`,** not `useState` seeded from an
  effect. The `react-hooks/set-state-in-effect` lint rule rejected the planned approach,
  and the store version is better regardless: the URL becomes the sole source of truth
  and browser back/forward works. `getServerSnapshot` returns the default office, so SSR
  and hydration agree without a markup mismatch.
- **Stale-office data is derived, not cleared.** Rather than `setForecast(null)` on
  switch (also a `set-state-in-effect` violation), the payload's own `office` field is
  compared against the selection, so a previous office's data can never be drawn against
  the new office's boundary.
- **The asset path regex was tightened, not widened.** The original
  `^releases\/[A-Za-z0-9._/-]+\.png$` already admitted an office segment. It is now
  anchored to the exact published shape:
  `^releases\/\d{8}T\d{6}Z\/[A-Z]{3}\/day-[1-3]\/[a-z][a-z-]*\.png$`.
- **Overlay loading was split from forecast loading.** The design implied one combined
  fetch; keeping them separate avoids re-downloading ~800 KB of geojson on every office
  switch, since the overlays are identical for all four.
- **`tsconfig.json` includes `lib/**/*.mjs`,** not `**/*.mjs` — scoping it to the shared
  module avoids type-checking the build scripts and their Playwright/AWS imports.
- **`RELEASE_RETENTION_DAYS` treats blank as unset.** A GitHub repository variable that
  isn't defined arrives as `""`, and `Number("")` is `0`, which would have silently
  disabled pruning. Blank now means the 7-day default; an explicit `0` disables.

### Verification

- `npm test` — 10/10 pass. `npm run lint` and `tsc --noEmit` clean.
- All four offices fetched live: PHI 281 points / 17 labels, OKX 109 / 13, CTP 221 / 14,
  LWX 240 / 14 — **zero failures**, 4–9 s per response.
- Full publisher dry run produced all 120 PNGs (4 offices × 3 days × 5 products × 2
  sizes) with a valid v2 manifest. Rendered output confirmed edge-to-edge fill, no
  bilinear seam at the far edges, and correct non-uniform QPF ramp behaviour.
- The city-office validator passed all 58 cities, including the two borderline PA
  entries (Somerset, Bradford) flagged as uncertain in §5 — both are genuinely CTP.

## Known limitations

**CTP framing.** CTP's CWA is 3.85° × 2.28° — much squatter than PHI's near-square
2.47° × 2.91°. On the fixed 900×760 canvas it will render correctly but will look
noticeably different in framing from the PHI graphic. A per-office canvas aspect ratio
is the fix if it proves distracting; deliberately deferred rather than designed
speculatively.

**Frame-edge extrapolation.** The 0.45° outer band improves but does not eliminate IDW
extrapolation at the extreme corners of each frame, particularly over open ocean
southeast of OKX and PHI where no gridpoints exist at all. Values there are visual
continuation, not forecast.

**Attribution risk accepted.** With uniform full-strength fill, a shared screenshot
gives no visual cue that values outside the outlined CWA come from a neighboring office.
This was chosen deliberately over the dimmed alternative for the stronger regional look.
