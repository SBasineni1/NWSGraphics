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

Above the offices sit **eight synthetic wide views** that ride the identical pipeline: the
national map (`US`) and **seven unofficial multi-state areas** declared in `lib/areas.mjs`
— see "Unofficial regional views" below. They are `Office`s in every respect the code
cares about, so most of this document applies to them unchanged; where it does not, the
test is `isWideView`.

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
fans out one subrequest per gridpoint (~250 per office), and on Vercel it **504s at 91.8
seconds** — twelve sequential batches, each waiting on its slowest upstream request
(measured; `docs/superpowers/specs/2026-07-27-forecast-freshness-design.md`). The production
path is instead `forecast/{OFFICE}.json`, precomputed in the publisher (Node, no limits) and
served from R2; the route survives as the local/dev fallback.

**The binding constraint is function duration, and it did not use to be.** This route was
written against Cloudflare Workers, where it broke a **50-subrequest** ceiling and a **10 ms
CPU** budget — two limits that no longer apply now that the site is on Vercel. Only the
duration wall does. That changes which fixes are even conceivable: widening the batch size
was futile on Workers because batching cannot buy back CPU, but here the cost is wall-clock
latency, so more concurrency is at least the right *shape* of fix. It still isn't worth
doing — the precomputed R2 path already serves every office for free, and a live fan-out to
~250 upstreams per request would be slower and more fragile no matter how it is scheduled.
Treat any surviving "50 subrequests / 10 ms CPU" reasoning elsewhere in the docs as stale.

## Stack

- **Next.js 16 App Router + React 19**, **deployed on Vercel** at
  `www.basinenigraphics.online` (the apex 308-redirects to it). Vercel's GitHub
  integration deploys every push to `main` — there is no deploy workflow in
  `.github/`, and `publish-forecast-plots.yml` publishes to R2, not the site.
- **`vercel.json` pins `buildCommand: next build`, and that is load-bearing.** The
  `build` script in `package.json` is `vinext build`, which emits a Cloudflare Worker
  into `dist/` — output Vercel cannot serve. Don't remove the override on the grounds
  that Vercel's Next.js preset already defaults to `next build`; the fallback if the
  preset ever misfires is the wrong builder, not a warning.
- **Local dev is still vinext, and that is a second build of the same source.**
  `vinext` + Vite + `@cloudflare/vite-plugin` under Wrangler/Miniflare, driven by
  `wrangler.jsonc`. So `npm run dev` and production do not share a builder: a bug that
  only appears under one of them is possible, and `npm test` asserts the *vinext* build
  in `dist/`, not what Vercel ships. `npx next build` is the check that matches
  production.
- **Tailwind CSS 4** (`@tailwindcss/postcss`), **TypeScript** strict mode.
- **Drizzle ORM** targeting Cloudflare **D1** is wired up but unused —
  `db/schema.ts` is intentionally empty. Don't assume a database exists.
- Originated from an OpenAI "site creator" vinext starter; `.openai/hosting.json`
  holds the D1/R2 binding names (both `null` by default) and `worker/index.ts`
  is the Cloudflare Worker entry (image optimization + app-router handler). Both are
  local-dev-only now — nothing in production reads them.
- **R2 is unaffected by the host.** The publisher uploads over the S3 API and the
  client fetches over HTTPS from `NEXT_PUBLIC_FORECAST_ASSET_BASE_URL`, so neither
  end cares what serves the site. That variable is **build-time**: it must be set in
  Vercel's project environment, and changing it needs a redeploy, not just a publish.

## Commands

- `npm run dev` — local dev server (vinext under Wrangler). **Not the production
  builder** — see Stack.
- `npm run build` — vinext build to `dist/`. Despite the name this is the *local*
  build; Vercel runs `next build` into `.next/`. The publisher uses this one, because
  it serves the site itself to drive Playwright.
- `npx next build` — the build that matches production. Run it before pushing anything
  that could plausibly build differently under the two toolchains.
- `npm test` — **builds first** (vinext), then runs `tests/rendered-html.test.mjs`
  (imports the built worker from `dist/` and asserts the SSR HTML) plus
  `tests/place-search.test.mjs` and `tests/map-frame.test.mjs` (pure logic, no build).
  So the SSR assertions cover the vinext output, not the deployed one.
- Deploying is `git push` — Vercel builds from `main`. There is no manual deploy step
  and no `deploy` script.
- `npm run lint` — ESLint (`eslint-config-next`).
- `npm run plots:publish` — run the R2 publisher (see below).
- `node --max-old-space-size=6144 scripts/build-office-bundles.mjs` → `build-office-gridpoints.mjs`
  → `build-office-cities.mjs` → `build-offices.mjs` — the national asset chain, in that
  order. Bundles ~12s, the lattice ~18 min (31k `api.weather.gov/points` lookups; use
  `--dry-run` to size it first), cities ~70s, registry seconds. The wide views are built by
  this same chain — **editing `lib/areas.mjs` means re-running all four**, since an area's
  frame, lattice, labels and registry entry are all derived. `--only NW,WE` scopes the
  *middle two* (gridpoints and cities) to just the areas you touched; bundles and the
  registry take no such flag and always do everything, which is cheap. A scoped lattice run
  legitimately samples no CWA and fills entirely from the national pool — that is reported,
  not treated as an error.
- `scripts/build-cwa.mjs`, `build-grid-points.mjs`, `build-city-points.mjs`,
  `build-counties.mjs`, `build-overlays.mjs` are the **superseded four-office chain**.
  They still write `public/cwa.geojson` and friends, which nothing in the client reads
  any more. Keep them only until the last reference goes.
- `node scripts/build-office-zones.mjs` — regenerate `public/zones/{OFFICE}.json`, the
  alert zone geometry (~58 MB across 125 files, seconds once cached). Depends on
  `public/offices/` already existing: it reads each bundle's frame and zoom so the zone
  simplification matches the counties drawn under it.
- `node scripts/build-alert-colors.mjs` — regenerate `app/alert-colors.ts` from the NWS
  watch/warning renderer. Generated, like `app/offices.ts` — don't hand-edit.
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

## Unofficial regional views ("areas")

Seven multi-state views sit between one office and the whole country — North West, West,
South West, Mid-West, South East, Mid-Atlantic, North East — declared in **`lib/areas.mjs`**.
**NWS does not publish these groupings.** They are an editorial convenience, which is why
they are data in this repo rather than derived from anything upstream.

- **They are not `REGIONS`.** That name is taken in `app/offices.ts` by the six *official*
  NWS regions (Eastern, Southern, Central, Western, Alaska, Pacific), which group offices
  administratively and look nothing like these — an area cuts straight across them.
  CLAUDE.md's word for the level above an office is "area", so that is the word used.
- **Area ids are two letters, because every real CWA is three.** An id can therefore never
  collide with an office id in a URL, an asset filename, or the picker. `NE` is the North
  East *area*, not Nebraska.
- **An area is a synthetic `Office`**, so it travels the whole existing pipeline unchanged:
  same bundle shape, same lattice, same `?office=` parameter, same `findOffice`, and
  `ready` is derived from assets on disk exactly as it is for a real office.
- **Frames are derived from the member states' bounding box**, not hand-written, so adding
  a state in `lib/areas.mjs` reframes the map with no numbers to update by hand. A postal
  code with no state geometry **throws** rather than quietly shrinking the frame — that is
  the wrong-but-plausible map that is hard to notice.
- **Counties are dropped, interstates are kept** (`omit` on the bundle, which replaced the
  national view's `nationalScale` boolean). At an area's zoom a county is a few pixels of
  unreadable mush, but the interstate network is what makes a regional map legible and it
  is two orders of magnitude fewer features. The national view drops both.
- **Sampling density is per *kind* of view**, in `VIEW_TARGETS`: office 340 points / 14
  labels, area 900 / 20, national 1800 / 26. The office numbers were tuned for a ~3° frame
  and leave a 13-state area visibly under-resolved.
- **An area's label pool is the union of its member states' per-office pools**, not the
  `US` pool — that one is already thinned to 120 nationally-ranked cities, which leaves a
  small area like the North East almost nothing to choose from.
- **Alaska, Hawaii and the territories are deliberately absent.** Folding them into a CONUS
  area shrinks the mainland into a corner of the canvas, the same reason the national view
  is the lower 48.
- **`isWideView` is the test that matters**, in both `lib/areas.mjs` (build scripts) and
  `app/offices.ts` (client): "is there a CWA behind this id", not which flavour of wide
  view it is. Both a city-ownership check and the alerts join need exactly that question.
  See the alerts section below for the trap.

## Active watches & warnings

An **Alerts** tab sits before Day 1 in the day switcher. It is a view, not a fourth day —
alerts describe what is in force right now — so `dayIndex` stays a real day index and the
view rides its own `showAlerts` flag rather than a sentinel value.

- **Wide views draw alerts too, and they get there by a different route than an office.**
  The nation and the seven areas each carry a zone bundle like any office; what changes is
  how the alerts are *asked for*. An office sends its zone list comma-joined. A wide view
  cannot: the national frame reaches **7,451 zones**, which blows past the ~8 KB outbound
  URL the upstream accepts long before the list ends. So a wide view asks **unfiltered**
  (`/api/alerts?scope=all`, ~250 alerts, one request) and narrows the result itself. One
  cached response serves the national map *and* all seven areas — cheaper than querying
  per view, not dearer.
- **Membership is decided by the zones an alert names, never by whether it is drawable.**
  `alertGeometries` hands back an alert's *own* polygon whenever it has one, without asking
  where that polygon is, so once wide views began receiving every alert in force, a
  storm-based warning in Texas counted as drawable on the Mid-Atlantic map. `alertInView`
  tests `affectedZones` against the view's zone index instead — which *is* the frame test,
  already computed. Safe because **every** active alert lists `affectedZones`, including all
  27 of 251 that also carry a polygon. It runs before anything counts, draws or lists an
  alert, so the header total, the map and the ticker cannot disagree. For a single office it
  changes nothing; the route has already narrowed by zone.
- **This was documented as impossible, on a bad measurement — don't trust the old reasoning
  if you find it quoted elsewhere.** The claim was that a wide-view zone bundle costs
  "megabytes apiece". Raw, US *is* 5.4 MB — but a browser transfers gzip, and the numbers
  that matter are **US 1,163 KB gzipped against PHI's 326 KB**, for 7,451 zones against 318.
  Heavy, not prohibitive, and only ever fetched when the Alerts tab is opened.
- **Most alerts carry no geometry.** 12 of 14 sampled NY alerts had `geometry: null` and
  described themselves only through `affectedZones`, a list of zone URLs. Drawing one is a
  join against zone shapes, not a fetch of its outline. Storm-based warnings *do* carry a
  polygon, and it is preferred when present — it is far tighter than the counties it clips.
- **`public/zones/{OFFICE}.json`** is that join table, built by `build-office-zones.mjs`:
  UGC code → polygon, ~536 KB average across 133 files (~70 MB total; **US is the largest at
  5.4 MB raw / 1,163 KB gzipped**, then SE at 2.6 MB, and AKQ leads the offices at 1.7 MB raw
  / 425 KB gzipped). **Zones are claimed by frame overlap, not by the `cwa` that issues
  them**, so the map fills the plot the way the forecast field does rather than stopping at
  the office border — PHI draws 318 zones and pulls alerts from nine offices. The owning
  office is unioned in regardless, so a zone marginally outside its own frame is not lost.
  That is what took this from 22 MB to 58 MB; ownership-only is the lever if it needs to
  shrink, at the cost of masking back to the CWA. Fetched only when the tab is opened, like the
  place index, because most visits never need it. All three zone families are required —
  county (`NYC105`) and forecast (`NYZ072`) are different shapes over the same land and
  alerts use both interchangeably, while marine (`ANZ335`) carries everything over water,
  so dropping it costs a coastal office every Small Craft Advisory.
- **Zone geometry comes from the ArcGIS reference map, not `api.weather.gov/zones`.** That
  endpoint ignores `include_geometry=true` and returns `geometry: null` for all 8,747
  zones. The reference map is the same service the CWA outlines come from, so the shapes
  agree by construction. The UGC code is assembled per layer — counties from state+FIPS,
  public zones from state+zone, marine straight off the feature — and getting it wrong
  doesn't error, it just matches no alert.
- **`/api/alerts` must send one comma-joined `zone` value, never repeated `zone=`
  parameters.** Repeating them does not union: results *fall* as zones are added, and at 66
  zones the upstream returns nothing at all — indistinguishable from a quiet day. Measured
  side by side: repeated 1→5, 5→1, 20→2, 66→0; comma 1→5, 5→8, 20→11, 66→16. A test pins
  this. The route makes exactly one upstream request regardless of zone count, which is why
  it is affordable where `/api/forecast` is not.
- Colours are the NWS renderer's own, generated into `app/alert-colors.ts` by
  `build-alert-colors.mjs` (111 event types, keyed by the alerts API's `event` string).
  CAP `severity` cannot substitute — a Flood Watch and a Tornado Warning are both "Severe".
- **Alerts composite on their own layer at full opacity, then that layer goes over the map
  once** (`ALERT_LAYER_ALPHA`). Painting each alert at 0.55 straight onto the map blended
  every overlap: a Severe Thunderstorm Watch over a Flood Watch came out olive — a colour
  in neither the legend nor NWS's palette — and a hazard changed colour depending on what
  happened to sit under it. Alerts overlap almost everywhere, so this is the normal case.
  Opaque within the layer means the highest-ranked alert covering a pixel is the only one
  seen there. Measured after the change, every alert fill on the map is within 4–10 RGB of
  its legend swatch. The legend swatch is drawn on a white backing at the same alpha so the
  key can be matched against the map rather than merely resembling it.
  Paint and sort order is **tier first, hazard second** (`alertRank`): warnings above
  watches above advisories above statements, then the hazard breaks ties inside a tier so a
  Severe Thunderstorm Watch lands above a Flood Watch. Tier alone is not enough — those two
  are both watches and both report CAP severity "Severe" — and tier is multiplied out so a
  hazard score can never overturn it. Ordering is tested, not just its shape.
- The alerts canvas deliberately carries **no `data-product-id`**: the publisher discovers
  what to capture with `canvas[data-product-id]`, and this is a live map with no `PRODUCTS`
  entry and no day. The refresh interval is 2 minutes, far shorter than anything else on
  the page, because a warning's lifetime is measured in tens of minutes.

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
that 504s. A test pins this.

**The render tier is off, at the publisher, and that is the deployed state.**
`RENDER_OFFICE_COUNT: ${{ vars.RENDER_OFFICE_COUNT || '0' }}` in the workflow, gating
`RENDER_ENABLED` in the publisher: no pins, no browser, no capture, no PNG uploads, no
manifest, no prune. A run writes `forecast/{OFFICE}.json` plus the index and exits with
`reason: "imagery disabled"`. The render path itself is untouched — set the repository
variable to a positive number and it comes back, which a dry run at
`RENDER_OFFICE_COUNT=1` verifies still produces all 80 objects for an office.

**Why off:** nothing served the PNGs. The client gates imagery on
`NEXT_PUBLIC_PUBLISHED_PLOTS`, which is unset in Vercel, so `PublishedForecastPlot` never
mounted and no release object was ever requested. Measured 2026-07-30, the render tier was
**1,120 of ~1,190 R2 writes per run — ~94% of Class A, ~570k/month against a 1M free
tier** — and ~15 minutes of a ~28-minute run. That run length is what broke *data*
freshness: `concurrency: forecast-plot-publisher` does not cancel, so 28-minute runs
serialised behind a `*/15` cron into ~one run every two hours, and 36 offices were sitting
6–24 hours stale (MOB published Jul 29 21:15Z while upstream had reissued at Jul 30
11:51Z). Data-only runs are ~12 minutes and ~68 writes.

**Turning imagery back on is two switches, not one.** `RENDER_OFFICE_COUNT` publishes the
PNGs; `NEXT_PUBLIC_PUBLISHED_PLOTS=true` in Vercel (build-time — needs a redeploy) is what
makes a client ask for them. Setting only the first recreates exactly the state this
removed. Budget it at ~80 writes per office per run: at 16 runs/day that is ~38k Class A
per office per month.

**`latest.json` freezes when imagery is off, and that is why two things are conditional on
`RENDER_ENABLED`:** the publisher's pre-fetch `sourceRevision` compare and the pre-build
gate's manifest read (`scripts/probe-offices.mjs`). Both read a file that only a successful
render rewrites, so with imagery off an unconditional compare reports a deploy on *every*
run forever — which costs the gate its entire purpose, ~2 minutes of `npm ci` and a build
before the publisher exits anyway.

**Clearing the orphaned releases is `npm run plots:prune-releases -- --delete`**, a one-off,
because `pruneOldReleases` runs only inside the render path and therefore never runs at all
now. It deletes `releases/**` *and* `latest.json`, in that order and deliberately: a
manifest that outlives its objects is worse than no manifest, because
`PublishedForecastPlot` renders missing assets as broken images while an absent manifest
just leaves every view on the live canvas. It never touches `forecast/`, which is the only
prefix production reads. Dry run by default.

`app/api/forecast/route.ts` (`runtime = "edge"`) is the data source: it fans out
batched requests to `api.weather.gov/gridpoints/{wfo}/{x},{y}` for the selected
office's labeled cities (`city-points.json`) plus the slice of the regional
lattice (`grid-points.json`) tagged for that office, aggregates each day's
values (max for temps/wind/PoP, sum for QPF; unit-converted to °F / mph /
inches), and returns JSON with edge cache headers. It is the local/dev path only —
in production this route 504s (see above).

**The field fills the whole canvas, not just the CWA.** Each office's lattice
slice covers its full render frame using real gridpoint data from neighbouring
offices, and the CWA is marked by its outline alone. Two things make that
affordable and must not be undone casually:

**…but a wide-frame view clips the field to land.** A view with no CWA (`bundle.cwa ===
null` — national, and regions built the same way) reaches far past the nearest gridpoint,
so the distance fade trailed colour hundreds of miles into the Gulf, the Atlantic and
Mexico, implying a forecast where NWS publishes none. `renderPlot` clips the raster to the
bundle's own state polygons, accumulated into **one** path so the nonzero fill rule unions
them — clipping per state would intersect them and leave nothing. This is land, not the
exact CWA union: carrying all 125 CWA outlines measured **~6 MB against a 187 KB bundle**,
and simplifying them harder makes it *worse*, because `simplify` returns the original ring
whenever a closed ring drops under four points. A single office stays unclipped — its
lattice legitimately covers the frame with neighbours' data.

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
- **Field products blend; categorical ones don't — and they are separate code paths.**
  `colorFor` interpolates between stops for the interpolated rasters. Banding it was tried
  and reverted: the temperature stops are 10° apart, so a real 78–90°F day collapsed into
  two flat blocks and the map lost every gradient that made it readable. The legend's flat
  per-stop swatches key the scale; they are not a claim that the field is quantised. The
  discrete look belongs to the alerts layer and the SPC/WPC outlooks, which never touch
  `colorFor`.
- `colorRamp()` — a 4096-entry LUT per product, since `colorFor` re-parses hex
  strings and can't run 684,000 times per plot. Entries must be produced *by*
  `colorFor`; the stops aren't evenly spaced (QPF runs 0, 0.01, 0.1, 0.25 … 12).
  **The LUT is uniform in value while the stops are not, so its size is set by the
  worst ratio, not by a round number.** QPF tops out at 12" but crowds five stops below
  0.5", so widening its scale silently starved the low end: at 1024 the 0.01–0.1 band —
  most of the coloured area on a typical map — got 8 steps for a 68-unit RGB traverse and
  banded visibly. Raise the size along with the top stop.

## Publishing pipeline

**Two tiers, both derived from `scripts/data/offices.json` — never a list in the script.**

- **Data tier** — every drawable office (121) gets `forecast/{OFFICE}.json`, ~117 KB each,
  ~14 MB total. This is *how a live office renders at all*; it is not an optimisation.
  Written under a stable key, not inside a release, so `pruneOldReleases` (scoped to
  `Prefix: "releases/"`) can never delete it.
- **Render tier** — `RENDER_OFFICE_COUNT` offices get PNGs, taken from
  `scripts/data/office-population.json`, with PHI and US pinned in regardless of rank.
  **The workflow sets this to 0, so in practice no run renders anything** — see "the render
  tier is off" above for why and for what turning it back on takes. The script's own
  default is still 24, which is what a local run gets unless it says otherwise.

**The seven areas are data tier only, and that falls out of the ranking rather than being
enforced.** `office-population.json` is scored per CWA, so no area appears in it and none
can be sliced into the render tier — only PHI and US are pinned past the ranking. That is
the right default: an area renders live from `forecast/{AREA}.json` like any live office,
and imagery is switched off at the client anyway. If you ever pin an area in, re-measure
first — an area's lattice is ~700 points against an office's ~290.

**An area's freshness probe speaks for one city, so an area can lag one office's revision.**
The probe anchors on `cities[0]` (New York for MA, Chicago for MW), which stands in for the
whole view. For an office that is fine; for a 13-state area the lattice draws on many
offices, so a reissue by a *different* office in the area does not mark it stale and its
data waits for the anchor city's office to reissue. Bounded in practice — offices reissue
several times a day and the workflow runs hourly — but it is a real weaker guarantee than
an office gets, and the lever if it matters is probing more than one anchor per area.

**A HEAD on a gridpoint returns `last-modified` and downloads zero bytes**, against ~285 KB
for a GET. That probe is what makes 121 offices affordable: `forecast/index.json` records
each office's last probe, so a run costs 121 HEADs plus a fan-out only for the offices that
actually reissued. A cold run with no index refreshes everything — **~35,000 upstream
requests**. `PLOT_OFFICES=PHI,OKX` narrows both tiers for testing or for re-running one
office after a failure.

**The fetch queue is ordered by how far behind a view is, and it has to be.** The budget
(`PLOT_FETCH_BUDGET_MS`, 12 min) cuts the queue on most runs, so the *order* decides who
gets served — and registry order is a fixed priority, which turns a cut into permanent
starvation instead of a rotation. Measured on run #121: 43 views written between 16:02 and
16:14, the render tier and then stale offices ABR→DVN, so everything sorting later waited
for a next run that made the identical cut. The seven areas sort at M–W and had never been
published at all, so three consecutive runs on the commit that added them left every
regional view with no forecast object — the one failure the live canvas cannot render
through, since `/api/forecast` 504s in production. `behindnessOf` sorts never-published
first (absent draws nothing; stale still draws a map), then oldest published issuance, so
anything a cut skips outranks everything on the next run. Use **0, not `-Infinity`**, for
never-published: `-Infinity - -Infinity` is NaN and a NaN comparator leaves tie order to
the engine — observed shuffling the areas among themselves. The run log prints the queue
head, which is the only thing that distinguishes a fair cut from a starving one.

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
- `lib/geo-simplify.mjs` holds the Douglas-Peucker simplification, longitude shifting and
  rounding shared by `build-office-bundles` and `build-office-zones`, for the same reason
  `map-frame.mjs` exists: both must agree exactly, or an alert polygon stops sitting on the
  county it covers. Extracting it was verified byte-identical across all 126 bundles.
  **`simplify`'s closed-ring fallback is a trap worth knowing.** When simplification drops a
  ring under four points it returns the *original* — correct, since three points are not a
  polygon, but it means the hardest-simplified rings are the ones that keep every vertex. At
  a wide zoom that is backwards: a zone smaller than a pixel is precisely the one that
  collapses, and it came back at full resolution. It put **88% of `US.json`'s 689,078 points
  into 10% of its zones**, one of them 14,243 points for a shape covering about a pixel. The
  opt-in `collapse` argument substitutes the ring's bounding quad — five points, and it
  fires on 72% of rings, saving 540,803 of them. Only 261 collapsed rings exceed one pixel,
  the largest ~6 px, and a ring that reduces below four points at a given tolerance is a
  sliver whose bounding box is a *better* representation than a degenerate triangle.
  **Only `build-office-zones` opts in**; `build-office-bundles` must keep its byte-identical
  output, and a CWA outline is never sub-pixel on its own map. This is the same floor
  CLAUDE.md notes for CWA outlines under "How it renders" — simplifying harder made those
  worse for exactly this reason.
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
