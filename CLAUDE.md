# CLAUDE.md

Guidance for working in this repository.

## What this is

**NWS Forecast Graphics** — publication-ready 3-day weather graphics for **121 of the
125 National Weather Service forecast offices**, nationwide. PHI (Philadelphia / Mount
Holly) is the default and the four Eastern Region offices — PHI, OKX, CTP, LWX — are the
ones with published PNGs; everything else renders live from precomputed forecast data.
It pulls official `api.weather.gov` gridpoint
data and renders Day 1–3 maps for nine gridpoint fields (apparent temperature,
temperature, minimum temperature, wind gust, sustained wind, sky cover, dewpoint,
probability of precipitation, quantitative precipitation) plus five outlook
products off SPC and WPC (categorical convective risk, tornado / hail / damaging
wind probability, any-severe probability, and excessive rainfall).

`app/offices.ts` lists **all 125 NWS forecast offices** in their six regions and is
**generated** by `scripts/build-offices.mjs` from the NWS reference map service —
don't hand-edit it. **121 of the 125 are drawable.** `ready` is *derived from the assets
on disk*, not declared: an office needs a bundle in `public/offices/`, a lattice of at
least 40 points in `public/gridpoints/`, and labelled cities in `public/cities/`.
The picker lists every office but disables the rest, and `findOffice` falls back to the
default for a non-ready id, because rendering one would silently draw a *different*
office's boundary rather than fail.

The four that stay out are all Pacific, and for two different reasons: **PQW and PQE** are
open-ocean domains where NWS publishes no gridded forecast (PQW resolved to 2 gridpoints,
PQE to none), and **GUM and PPG** have no labels because the Census place gazetteer covers
the states, DC and Puerto Rico but not Guam or American Samoa. Guam is a real populated
CWA — it needs a different place source, not a lower threshold.

To rebuild everything: `build-office-bundles` → `build-office-gridpoints` →
`build-office-cities` → `build-offices`.

The selected office lives in the `?office=` query parameter, read through
`useSyncExternalStore` so deep links, browser history, and the publisher's
per-office navigation all agree.

**Rendering is national; publishing is not** — see
`docs/superpowers/plans/2026-07-25-national-coverage.md`. Publishing PNGs for all 125
offices would need ~17.9 GB per release against R2's 10 GB free tier, so only a subset
ever gets pre-rendered imagery.

**`/api/forecast` cannot serve a live office in production, and that is by design.** It
fans out one subrequest per gridpoint (~250 per office) against a **50-subrequest** free-tier
ceiling, and parses ~66 MB of JSON against a **10 ms CPU** budget per invocation — it breaks
both, not just one. The production path is instead `forecast/{OFFICE}.json`, precomputed in
the publisher (Node, no limits) and served from R2; the route survives as the local/dev
fallback. Don't "fix" it by widening the batch size — batching cannot buy back CPU.

## Stack

- **Next.js 16 App Router + React 19**, but built and served on **Cloudflare
  Workers** via **vinext** (`vinext` + Vite + `@cloudflare/vite-plugin`), not
  the `next` CLI. Local dev runs under Wrangler/Miniflare.
- **Tailwind CSS 4** (`@tailwindcss/postcss`), **TypeScript** strict mode.
- **Drizzle ORM** targeting Cloudflare **D1** is wired up but unused —
  `db/schema.ts` is intentionally empty. Don't assume a database exists.
- Originated from an OpenAI "site creator" vinext starter; `.openai/hosting.json`
  holds the D1/R2 binding names (both `null` by default) and `worker/index.ts`
  is the Cloudflare Worker entry (image optimization + app-router handler).

## Commands

- `npm run dev` — local dev server (vinext under Wrangler).
- `npm run build` — production build to `dist/`.
- `npm test` — **builds first**, then runs `tests/rendered-html.test.mjs`
  (imports the built worker from `dist/` and asserts the SSR HTML) plus
  `tests/place-search.test.mjs` and `tests/map-frame.test.mjs` (pure logic, no build).
- `npm run lint` — ESLint (`eslint-config-next`).
- `npm run plots:publish` — run the R2 publisher (see below).
- `node --max-old-space-size=6144 scripts/build-office-bundles.mjs` → `build-office-gridpoints.mjs`
  → `build-office-cities.mjs` → `build-offices.mjs` — the national asset chain, in that
  order. Bundles ~12s, the lattice ~18 min (31k `api.weather.gov/points` lookups; use
  `--dry-run` to size it first), cities ~70s, registry seconds.
- `scripts/build-cwa.mjs`, `build-grid-points.mjs`, `build-city-points.mjs`,
  `build-counties.mjs`, `build-overlays.mjs` are the **superseded four-office chain**.
  They still write `public/cwa.geojson` and friends, which nothing in the client reads
  any more. Keep them only until the last reference goes.
- `node scripts/build-places.mjs` — regenerate the search index. Independent of the
  chain above: it fetches all 125 CWA polygons itself and doesn't read `public/`.
  Re-run when the Census ships a new gazetteer, not when an office becomes ready.
- `node --max-old-space-size=6144 scripts/build-office-bundles.mjs` — regenerate
  `public/offices/{OFFICE}.json` for all 125 offices (~20s once the sources are cached).
  Caches ~128 MB of upstream geo sources in `.cache/` (gitignored); delete to refresh.

## Per-office map bundles

Each office's map is drawn from **one** file, `public/offices/{OFFICE}.json`: its CWA
outline, the counties / state lines / interstates inside its frame, its `bounds`, and the
tile `zoom` that frame wants. This replaced four national geojson files in `public/` that
were clipped to the union of the *four original* offices' frames — going national with
those meant every visitor downloading every county in the country to draw one map.
~114 KB average, ~30 KB gzipped, and flat per visitor no matter how many offices exist.

`public/cwa.geojson`, `counties.geojson`, `states.geojson` and `interstates.geojson` are
**no longer read by the client**. `build-grid-points.mjs` still reads `cwa.geojson`.

Three things in `lib/map-frame.mjs` are load-bearing here and were all real bugs:

- **`coordinateBounds` must not spread.** `Math.min(...lons)` throws `RangeError` past the
  engine's ~65k argument limit, and an unsimplified CWA ring runs to 60k+ vertices. It
  survived only because it was fed pre-simplified geometry.
- **Longitudes only unwrap when the direct span exceeds 180°.** Adding 360 to a longitude
  near -76 costs low-order precision, so a "shifted span is smaller" test alone let *every
  CONUS office* flip into 283..286. That one bug put city labels off-canvas, made
  `drawTiles` request tile x=328 at zoom 8 (valid range is 0–255, so CartoCDN 503'd the
  whole basemap), and — because `loadTile` evicts failures — turned 20 tile fetches into a
  320-request retry storm. Exactly one office, **AFC**, genuinely crosses the dateline.
- **`fitZoom` per office, never a global `PLOT_ZOOM`.** Zoom does not change what is drawn
  (`plotExtent` stretches any extent to the canvas); it only selects basemap tiles. Across
  the real CWAs the right level runs 4–9. Held at 7, AFC alone asked for 14,541 tiles;
  per-office it is 9, and the whole country drops 15,620 → 1,466.

Anything projecting a forecast point must go through `projectPoint` (which applies the
office's longitude shift), never `project` directly — that is what stranded the labels.

**Shift a feature by one offset chosen from the whole feature, never per coordinate.**
`build-office-bundles.mjs` decides `offsetFor` from a feature's own bounding box. Adding
360 to each negative longitude independently tears apart anything crossing the *prime*
meridian: a European road at ±0.5° became points at 359.5 and 0.5, a bbox spanning the
globe, which "overlapped" every frame — six of them were drawn as straight red lines
across Alaska. And compute that offset **outside** the per-coordinate closure;
`coordinateBounds` walks the full unsimplified CWA, so calling it per longitude turned a
12-second build into minutes.

## Forecast data at 125 offices

Labelled cities and the interpolation lattice are generated, not authored:

- `public/gridpoints/{OFFICE}.json` — ~250 points per office, sampled at a **fixed count
  per frame, not a fixed degree step**. The original 0.22° was tuned for a ~3° mid-Atlantic
  frame; AFC's frame is 46° wide, where that step means ~11,500 samples for one office.
- `public/cities/{OFFICE}.json` — ~13 labels per office, greedy by population and spaced
  **66 px** apart. That number is measured, not chosen: the hand-authored PHI layout it
  replaces put its closest pair 62 px apart with every other neighbour at 91–144 px.
- **`cwa` and `gridId` are different fields and only coincide in CONUS.** NWS splits
  Alaska's AFC into the **AER** and **ALU** gridpoint domains, so a city's forecast is
  fetched from `wfo` (the domain) while ownership is checked against `cwa` (the office).
  Conflating them rejected every city around Anchorage and left AFC with no labels.
- Census population has real holes: **Hawaii has one row** in the estimates file (Urban
  Honolulu — it has no other incorporated places) and **Puerto Rico has none** (separate
  file). Label ranking falls back to land area, which is why HFO and SJU are sensible
  rather than alphabetical. The gazetteer is decoded as **UTF-8**, not latin1, or Spanish
  names arrive as "BayamÃ³n".

## Finding an office (ZIP / town search)

The picker's search box resolves a town or ZIP to its forecast office **entirely in the
browser**. `scripts/build-places.mjs` does the geography offline — point-in-polygon of
every Census place and ZCTA centroid against the CWA polygons — and writes
`public/place-index.json` (899 KB raw, **281 KB gzipped**). It is fetched on first focus
of the search box, never with the page: most visits never search.

- Ranking lives in `lib/place-search.mjs` (plain `.mjs` like `map-frame.mjs`, so Node can
  test it directly): exact > prefix > word-start > substring, population as the tiebreak.
  `tests/place-search.test.mjs` pins every one of those rules — change the tiers there.
- **A numeric query is always a ZIP query.** Letting digits reach the name ranking would
  sort towns by population for something that isn't a name.
- **ZIP runs are sorted in `parsePlaceIndex`, not trusted from the generator.** Both ZIP
  lookups scan in order and break early; unsorted input silently returns nothing.
- **A found-but-unbuilt office is listed and disabled, never swapped for the default.**
  Search deliberately does *not* go through `findOffice` — its fallback would answer a
  search for a Maine town with Philadelphia's forecast.
- Two data quirks that are correct, not bugs: the Census calls Honolulu **"Urban
  Honolulu"** (the word-start tier is what finds it), and PO-box-only ZIPs like 77001
  have **no ZCTA**, so "not found" is the right answer there.

The same build writes `scripts/data/office-population.json` — population served per
office, the ranking that should decide which offices get published PNGs. It counts only
population inside incorporated places and CDPs, so it is a ranking input, not a census.

## How it renders (two paths)

The frontend (`app/components/ForecastGraphic.tsx`, a large `"use client"`
component) chooses at runtime:

1. **Published assets — now opt-in, and off by default.** Requires *both*
   `NEXT_PUBLIC_FORECAST_ASSET_BASE_URL` and `NEXT_PUBLIC_PUBLISHED_PLOTS=true`.
   `/api/published-forecast` fetches `latest.json` from R2;
   `/api/forecast-assets/[...path]` proxies the versioned `releases/*.png`
   (path is validated against a strict regex — keep that guard). A published office
   serves pixels baked at render time, so a palette or scale change can't reach it until
   the next publish run; the canvas is fast enough that this mostly bought staleness.
2. **Live canvas — the normal path now.** Renders maps in the browser: samples the
   forecast field with inverse-distance weighting (`fieldSolveFor`) and paints geojson
   overlays plus city labels onto a `<canvas>` at 900×760 (`RENDER_SCALE = 2`).

**The two R2 tiers are on separate switches, and only one is optional.** Turning the PNGs
off does *not* turn off `forecast/{OFFICE}.json` — `loadForecast` gates that on the base
URL alone, deliberately, because `/api/forecast` cannot serve an office in production at
all (see below). Collapsing them onto one flag, or reaching for
`NEXT_PUBLIC_FORECAST_ASSET_BASE_URL` to disable imagery, drops production onto a route
that breaks two Workers limits. A test pins this.

**There is no publisher-side kill switch for imagery, despite appearances.**
`RENDER_OFFICE_COUNT=0` does not disable rendering: PHI and US are force-pinned back into
the render tier right after the slice, an empty `renderable` throws, and an empty manifest
throws again on purpose. And `latest.json` is only overwritten by a *successful* render
run, so a publisher that stops rendering leaves the last manifest live and clients keep
being served the old release. Imagery is switched off at the client, not the publisher.

`app/api/forecast/route.ts` (`runtime = "edge"`) is the data source: it fans out
batched requests to `api.weather.gov/gridpoints/{wfo}/{x},{y}` for the selected
office's labeled cities (`city-points.json`) plus the slice of the regional
lattice (`grid-points.json`) tagged for that office, aggregates each day's
values (max for temps/wind/PoP, sum for QPF; unit-converted to °F / mph /
inches), and returns JSON with Cloudflare edge caching.

**The field fills the whole canvas, not just the CWA.** Each office's lattice
slice covers its full render frame using real gridpoint data from neighbouring
offices, and the CWA is marked by its outline alone. Two things make that
affordable and must not be undone casually:

- `solveFieldWeights` / `fieldSolveFor` — which eight gridpoints are nearest a lattice
  cell, and their weights, depend only on geometry, so an office solves that once and
  all forty of its plots reuse it. This was the largest single cost in a render
  (17% of CPU) before caching; days 2 and 3 dropped from ~3.2s to ~1.3s. The cache key
  is the **contributing point set**, not the office: a product where some gridpoints
  report null is a different set with different neighbours. Weights are `Float64Array`
  so the reused sum stays bit-identical to a per-pixel solve.
- `FIELD_STRIDE = 4` — the field is solved on a coarse lattice and
  bilinearly upsampled. The `Math.ceil((size - 1) / FIELD_STRIDE) + 1` sample
  counts are deliberate; drop the `+ 1` and the last stride of pixels has no
  upper neighbour and the raster ends in a visible seam.
- `colorRamp()` — a 4096-entry LUT per product, since `colorFor` re-parses hex
  strings and can't run 684,000 times per plot. Entries must be produced *by*
  `colorFor`; the stops aren't evenly spaced (QPF runs 0, 0.01, 0.1, 0.25 … 12).
  **The LUT is uniform in value while the stops are not, so its size is set by the
  worst ratio, not by a round number.** QPF tops out at 12" but crowds five stops
  below 0.5", so widening its scale silently starved the low end: at 1024 the
  0.01–0.1 band — most of the coloured area on a typical map — got 8 steps for a
  68-unit RGB traverse and banded visibly. Raise the size along with the top stop.

## Publishing pipeline

**Two tiers, both derived from `scripts/data/offices.json` — never a list in the script.**

- **Data tier** — every drawable office (121) gets `forecast/{OFFICE}.json`, ~117 KB each,
  ~14 MB total. This is *how a live office renders at all*; it is not an optimisation.
  Written under a stable key, not inside a release, so `pruneOldReleases` (scoped to
  `Prefix: "releases/"`) can never delete it.
- **Render tier** — only `RENDER_OFFICE_COUNT` offices (default 24) get PNGs, taken from
  `scripts/data/office-population.json`. PHI is always included, since it is the default
  office and must have imagery wherever it ranks.

**A HEAD on a gridpoint returns `last-modified` and downloads zero bytes**, against ~285 KB
for a GET. That probe is what makes 121 offices affordable: `forecast/index.json` records
each office's last probe, so a run costs 121 HEADs plus a fan-out only for the offices that
actually reissued. A cold run with no index refreshes everything — **~35,000 upstream
requests**. `PLOT_OFFICES=PHI,OKX` narrows both tiers for testing or for re-running one
office after a failure.

**Forecast data publishes before the imagery change-check**, deliberately. A run where no
render-tier office moved must still refresh the offices that did, so the old
"unchanged → exit(0)" now only skips rendering.

Measured 2026-07-26 on a scoped dry run (PHI, OKX, LOX):

| | measured |
|---|---|
| release size | **~110 MB/office** (PHI 138, OKX 121, LOX 72) |
| render | **~60 s/office dev**, ~27 s prod-equivalent |
| storage ceiling | 10 GB / 110 MB = **~93 offices** at retention 1 |
| capture-budget ceiling | 900 s / 27 s = **~33 offices** |

Render time, not storage, is the binding constraint — and it has roughly doubled from the
11.6 s/office in the older table, so **re-measure before raising `RENDER_OFFICE_COUNT`
past ~24**. At 32 the budget is essentially spent.

Fetch concurrency is **4**, not higher: each office is itself ~290 gridpoint requests
fanned out by the route, so four is already ~1,200 upstream in flight. At six the local
Worker returned 500s that were pure overload — the same office fetched alone succeeded —
so the fetch retries with backoff rather than writing an office off.


`scripts/publish-forecast-plots.mjs` drives a headless Playwright Chromium over
the running site, navigating to `?office=…` per office, and captures each
office/day/product canvas as a PNG. The catalogue is day-aware, so it is not a
flat multiplication: 14 products on Days 1 and 2 and 12 on Day 3 is 40 canvases
per office, **160 per release** across the four, each written twice (full-size +
preview) for 320 objects. It uploads
immutable `releases/{releaseId}/{OFFICE}/day-{n}/…` objects + a fresh
`latest.json` (**manifest `schemaVersion: 2`**, keyed by office) to Cloudflare
R2 via the S3 client. It skips work when the NWS `updateTime` and source
revision are unchanged unless `FORCE_PUBLISH=true`. Driven hourly (and every
10 min in the early-AM/PM update windows) by
`.github/workflows/publish-forecast-plots.yml`.

After `latest.json` is written, `pruneOldReleases()` keeps only the newest
`RELEASE_RETENTION_COUNT` releases (**default 1**, `0` disables) and always keeps
the one just published. Without it the bucket grows by a full release per publish
forever. A failed prune is logged and ignored — the release is already live.

**Retention is a count, not an age.** Publishes per day is driven by NWS
issuance frequency, so an age window doesn't bound storage; N releases is a hard
ceiling of N × one release. R2's free tier is 10 GB-month. Don't convert this
back to a day-based window without recalculating against that quota.

**Release size is an estimate, not a measurement.** The last measured figure was
~174 MB back when a release was 60 canvases (~2.9 MB per full-size + preview
pair); at 160 canvases that scales to **~460 MB**, but it has not been
re-measured. Measure it with `PLOT_OUTPUT_ONLY=true npm run plots:publish` and
`du -sh` before relying on it for a quota decision.

**The default of 1 leaves no grace window**, so a client holding a manifest from
before the last publish references deleted objects. `PublishedForecastPlot`'s
`onError` calls `recoverFromMissingAsset()`, which bumps `manifestNonce` to force
an off-schedule manifest re-fetch, throttled to once per 30s so a genuinely
missing asset can't spin. If you raise retention, keep that recovery — it also
covers a publish landing mid-session.

Local dry run: `PLOT_OUTPUT_ONLY=true npm run plots:publish` writes to
`outputs/forecast-publish/` without uploading or pruning. See `README.md` for
the full R2 / GitHub secrets setup.

**Measured cost of a release** (local, 2026-07-25 — re-measure before trusting):

| Phase | Cost | Notes |
|---|---|---|
| Forecast fetch, 4 offices | ~34s | Concurrent. Serial was 42s — the ceiling is shared upstream, not per-office, so this is ~20%, not 4×. |
| Render, per office | 11.6s prod / 25.1s dev | 40 canvases. Day 1 is dominated by basemap tile fetches; days 2–3 are ~1.3s each. |
| Canvas capture, 14 canvases | 0.6s | Encode *and* CDP transfer. Not a bottleneck — don't optimize it without re-measuring. |
| Upload | ~571 MB, 320 objects | Pooled 8-wide; latency-bound, not bandwidth-bound. |

The whole pipeline is minutes. **If a run takes tens of minutes it has stalled, it
is not "a lot of plots"** — workflow history bears this out: every run over ~16
minutes failed or was cancelled, while successful ones clustered at 2–9 minutes.
Profile with the CDP sampling profiler (`Profiler.start` over a page that renders all
three days) rather than guessing; the two things that looked expensive by eye
(reference-layer tracing, PNG encoding) measured at under 1% each.

**The capture phase is bounded, deliberately.** `PAGE_LOAD_TIMEOUT_MS` (60s),
`RENDER_READY_TIMEOUT_MS` (120s) and `CAPTURE_BUDGET_MS` (15 min for the phase as a
whole) exist because a render that never settles used to cost 18 minutes per attempt —
a 3-minute page load plus three 5-minute readiness waits — doubled by the retry and
repeated per office, for a two-hour worst case. Once the budget is spent the remaining
offices are skipped and the release publishes what it has. Don't loosen these back to
"safe" values: a day renders in ~1–10s, so they already carry an order of magnitude of
headroom, and their job is to convert a stall into a partial release instead of a
cancelled run.

**Most scheduled runs publish nothing.** The change-detection check means ~36 runs a
day yield ~6–10 real publishes; the rest exit in ~2 minutes. Extra schedule entries
cost Actions minutes, not R2 quota — which is the opposite of the intuition, so size
the schedule against Actions and the *published office count* against R2.

## Conventions & gotchas

- Dates are anchored to **`America/New_York`**; the three forecast days are
  computed in Eastern time — preserve the timezone handling in `route.ts`.
- Products, color stops, legends, and units are declared in the `PRODUCTS`
  array in `ForecastGraphic.tsx`; the `ProductId` union is duplicated in
  `route.ts`. Change both together. (`OfficeId` is *not* duplicated — it lives
  only in `app/offices.ts`.)
- **Products come in two kinds** (`ProductSpec` is a discriminated union on `kind`).
  `field` products are interpolated rasters off the NWS gridpoints and go through
  `renderPlot`; `outlook` products are categorical polygons from SPC and go
  through `renderOutlookPlot`. Both share `beginMapCanvas`, `drawReferenceLayers`,
  `drawSignature`, and `commitPlot`, so basemap/overlay/header changes only need
  making once.
- **SPC outlooks** come from `app/api/spc-outlook/route.ts`, which proxies
  `spc.noaa.gov` (no CORS there). The `SOURCES` table there is the source of truth
  for coverage: categorical runs all three days, split `torn`/`hail`/`wind`
  probabilities stop after Day 2, and Day 3 carries only the combined `prob`
  ("any severe"). **WPC's Excessive Rainfall Outlook** comes from
  `app/api/wpc-outlook/route.ts`, which queries layers 0–2 of the
  `wpc_precip_hazards` MapServer. Neither centre's outlook day is the site's Eastern
  calendar day — SPC's convective day runs **12Z–12Z** and WPC's periods end at 12Z —
  so the graphic labels itself from the outlook's own valid window rather than the day
  tab. A national outlook usually misses any one CWA; that renders as an explicit
  per-hazard notice ("NO DAMAGING WIND RISK AREA"), not a blank map.
- **The catalogue is day-aware.** `ProductCommon.days` lists the day tabs a product
  is issued for (absent = all three), and the sidebar, the gallery and the publisher
  all follow it. Day 1 and 2 carry 14 products, Day 3 carries 12. A group that a
  day empties out is dropped from the nav — don't index into `availableProducts`
  for a group without checking.
- **Conditional Intensity Groups are not a probability tier.** They ride *inside*
  the probability files on the same `DN` scale but mean something else — day-1 wind
  `DN: 2` is `CIG1`, day-2 tornado `DN: 2` is 2% probability — so the route splits
  them into `hatches` before anything sorts or legends on `DN`, and the renderer
  paints them as hatching *over* the fills. CIG replaced the old significant-severe
  hatch: `day{1,2}otlk_sig*` and `day3otlk_sigprob` have not been reissued since
  2026-03-03, so fetching them would paint a months-old area onto today's map.
  `SIGN` is still recognised in case a file carries it again.
- **Tornado is on its own scale.** It starts at 2% where hail/wind start at 5%, and
  its tiers are coloured differently at the same number (15% tornado is red, 15%
  wind is yellow). `SPC_TORNADO_PROBABILITIES` and `SPC_WIND_PROBABILITIES` cannot
  be merged. Every palette here is the issuing centre's own, read from the
  `drawingInfo` renderer on `mapservices.weather.noaa.gov` — don't eyeball hexes.
- `outlookTouchesFrame` decides whether the "no risk area" notice fires. It tests a
  vertex *and* whether the frame centre is enclosed, because a continental-scale
  area can cover a CWA without putting a single vertex in the frame — the vertex
  test alone painted the map and stamped "no risk area" over it.
- **Adding a product needs no publisher or workflow change.** The publisher
  discovers products by querying `canvas[data-product-id]` and reading the id and
  `data-product-file` off each one — it never enumerates them. A test asserts the
  publisher names no product id, so don't hardcode a list there. A new product's
  `file` slug must match `^[a-z][a-z-]*$` or the asset-path guard in
  `forecast-assets/[...path]/route.ts` will reject its PNG.
  What a new product *does* need: an entry in `PRODUCTS`, the `ProductId` union in
  both files, and a `metrics` line in `fetchLocation`. Aggregation modes are
  `max | min | sum` (`dailyValues`).
- A product the client knows but the current manifest lacks renders as nothing on
  the published path (`asset ? <Plot/> : null`) until the next publish run. Not an
  error, but expect a newly added product to be missing from published offices
  until the job runs again — which it will, since a changed `GITHUB_SHA` defeats
  the unchanged-check.
- `lib/map-frame.mjs` holds the Web Mercator math shared by the renderer and
  the build scripts. Both must agree exactly: `build-grid-points.mjs` lattices
  the frames `ForecastGraphic.tsx` draws, so drift here shows up as missing
  data along a canvas edge. It's `.mjs` so Node can import it directly; it's
  type-checked via the `lib/**/*.mjs` entry in `tsconfig.json`.
- The CWA source ships some offices as `Polygon` and others as `MultiPolygon`
  (CTP is a `Polygon`) — normalize before iterating coordinates.
- `build-city-points.mjs` verifies each city's office against what
  `api.weather.gov` reports and fails the build on a mismatch. Don't relax it;
  cities near CWA borders are easy to misfile by hand.
- `app/chatgpt-auth.ts` reads `oai-authenticated-user-*` request headers for
  optional ChatGPT-hosted auth; it's not used by the public forecast page.
- `dist/`, `.next/`, `.wrangler/`, and `outputs/` are build/tooling artifacts —
  don't hand-edit them.
