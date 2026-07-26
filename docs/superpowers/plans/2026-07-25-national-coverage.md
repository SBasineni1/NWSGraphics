# National Coverage Implementation Plan

**Goal:** every NWS forecast office in the picker, a published set covering the national
and regional maps plus the highest-population offices, live rendering for everything
else, and a ZIP/town search so nobody has to scroll 125 offices to find theirs.

**Status:** Phases 1 and 4 complete. Phases 2, 3, 5, 6 not started.

## The constraints this plan is shaped around

All measured or read from vendor docs on 2026-07-25, not estimated:

| Limit | Value | Source |
|---|---|---|
| R2 storage, free | 10 GB-month | Cloudflare |
| R2 Class A ops, free | 1M/month | Cloudflare |
| Workers subrequests/request, free | **50** | Cloudflare Workers limits |
| Worker size, free | 3 MB | Cloudflare Workers limits |
| Worker CPU/invocation, free | 10 ms | Cloudflare Workers limits |
| Storage per office per release | ~143 MB | measured: 40 canvases, full + preview |
| Objects per office per release | 80 | 40 canvases × 2 |
| Render per office | 11.6s prod / 25.1s dev | measured |
| `api.weather.gov` CORS | `Access-Control-Allow-Origin: *` | verified |

Two consequences drive everything below.

**Publishing all 125 offices is impossible on this account.** 125 × 143 MB is ~17.9 GB
per release against a 10 GB quota, and 10,000 objects per release blows 1M Class A ops
within days. Hence the hybrid: publish a featured set, live-render the rest.

**`/api/forecast` cannot serve a live office on the free plan.** It issues one subrequest
per gridpoint — ~281 for PHI — against a 50-subrequest ceiling. This is almost certainly
already broken in production; it is masked because all four current offices serve
published PNGs and never hit the route. Any live-rendered office hits it on every visit.
`api.weather.gov` sends CORS headers, so the fix is to fetch gridpoints **from the
browser**, bypassing the Worker entirely (Phase 3).

## Phase 1 — National registry ✅

- `scripts/build-offices.mjs` generates `app/offices.ts` from the NWS reference map
  service: 125 offices, 6 regions, region membership from the service's own `region`
  field rather than hand-assigned.
- An office carries `ready`, true only when its boundary, lattice slice and labeled
  cities exist. The picker lists every office but disables the rest, and `findOffice`
  falls back to the default for a non-ready id so a deep link can't draw the wrong map.
- Adding an office is: add to `READY`, re-run build-cwa → build-grid-points →
  build-city-points → build-offices.

## Phase 2 — Per-office assets at scale

The three shared asset files do not survive 125 offices as single files:

| Asset | 4 offices | 125 offices | Problem |
|---|---|---|---|
| `public/cwa.geojson` | 420 KB | ~13 MB | Every visitor downloads all of it |
| `grid-points.json` | 49 KB | ~1.5 MB | Imported **into the Worker**, half the 3 MB budget |
| `city-points.json` | 9 KB | ~280 KB | Fine as-is |

- [ ] Split the CWA boundaries per office (`public/cwa/{OFFICE}.geojson`), fetched on
      demand. Keep a small index for the picker.
- [ ] Split the lattice per office and stop importing all of it into the Worker.
- [ ] Replace the hand-authored `CITIES` table in `build-city-points.mjs` with a
      population-ranked source (Census places), auto-assigned to offices. 125 offices ×
      ~15 cities is ~1,900 entries — hand-authoring them is not viable, and the existing
      per-city office verification against `api.weather.gov` must be kept.

## Phase 3 — Live rendering on the free plan

- [ ] Fetch gridpoints directly from `api.weather.gov` in the browser for non-published
      offices, bypassing the Worker's 50-subrequest limit. Responses are
      `public, max-age=3600`, so the browser cache does real work here.
- [ ] Keep `/api/forecast` for the publisher (Node, no limit) and published offices.
- [ ] Decide the per-office lattice density for the live path — ~200 parallel browser
      requests per page load is a lot even when cached.

## Phase 4 — ZIP / town search ✅

- `scripts/build-places.mjs` assigns all 32,237 Census places and 33,719 ZCTAs to the CWA
  containing them, **offline**, by point-in-polygon against the same NWS polygons the
  renderer draws. The plan originally proposed resolving through
  `api.weather.gov/points/{lat},{lon}` at search time; that was dropped because it is a
  network round trip per search, it cannot drive a typeahead at all, and it fails exactly
  when api.weather.gov is down — which is when someone is looking for a forecast.
- `public/place-index.json` is 899 KB raw / **281 KB gzipped**, fetched on first focus of
  the search box rather than with the page: most visits never search.
  Places are packed as tab-separated lines and ZIPs run-length encoded (33,719 ZIPs →
  14,018 runs), which is what keeps it at 281 KB instead of ~1 MB.
- Ranking lives in `lib/place-search.mjs` with 17 tests in `tests/place-search.test.mjs`:
  exact name > prefix > word start > substring, population as the tiebreak, `Town, ST`
  and `Town ST` both narrow by state, and a numeric query is always a ZIP query.
- An office that search finds but the site can't draw is **listed and disabled**, never
  silently swapped for the default — `findOffice`'s fallback is deliberately bypassed.

Two data quirks worth knowing before "fixing" them:

- The Census calls Honolulu **"Urban Honolulu"**; the word-start match tier is what makes
  a search for "Honolulu" find it. Don't special-case the name.
- PO-box-only ZIPs (77001, for example) have **no ZCTA** and so no centroid. "Not found"
  is the correct answer there, not a gap in the data — 77002 resolves fine.

## Phase 4a — Population ranking (input to Phase 6) ✅

The same build writes `scripts/data/office-population.json`: population served per office,
summed from places inside each CWA. It is "population in incorporated places and CDPs",
not total resident population — rural population outside any place is not counted — so it
is a ranking input, not a census. The top of it is the expected metro order: OKX 14.1M,
LOX 10.0M, SGX 9.8M, LOT 9.2M, FWD 8.8M, MTR 6.8M, PSR 4.9M, PHI 4.7M, BOX 4.6M, HGX 4.5M.

**The coverage curve is what should set N, and it flattens early:**

| Published offices | Share of place population |
|---|---|
| top 10 | 36.2% |
| top 25 | 61.5% |
| top 40 | 76.8% |
| top 50 | 83.1% |
| top 60 | 88.0% |

Going from 40 to 60 offices costs 50% more storage, render time and objects to buy 11
points of coverage. The knee is around 40.

## Phase 5 — Regional and national maps

New territory: every frame today is a CWA. A region or the CONUS needs its own frame,
its own much coarser lattice, and a decision about which products make sense at that
scale (a national apparent-temperature raster is reasonable; a national city-label layer
is not).

- [ ] Introduce an "area" concept above office: `{ id, bounds, lattice }`, with an
      office being one kind of area.
- [ ] Generate coarse lattices for 6 regions + CONUS.
- [ ] Decide the product set per area scale.

## Phase 6 — Size the published set

**Publish rate, measured 2026-07-25** from ~11.5 h of workflow history: the schedule
fired ~46 times a day, but only **~6–10 of those actually published** — the rest found
the NWS update time unchanged and exited in about two minutes. Extra scheduled runs
therefore cost GitHub Actions minutes, not R2 quota. The schedule has since been thinned
from 46 to ~36 checks a day.

With `80 objects × N offices × P publishes/month ≤ 1,000,000` and storage
`143 MB × N ≤ 10 GB`:

| Real publishes/day | Ops ceiling | Storage ceiling | Usable N |
|---|---|---|---|
| 10 (≈300/mo) | 41 offices | 70 | **~40** |
| 7 (≈200/mo) | 62 offices | 70 | **~60** |
| 4 (≈120/mo) | 104 offices | 70 | **~60** (storage binds) |

So cutting publishes is worth doing down to roughly 7/day, which moves the ceiling from
~40 to ~60 offices. Below that, storage binds and further cuts buy nothing.

**Two limits bind before R2 does, and neither is in the table above.**

*Render time.* The publisher renders offices **serially** (`for (const office of OFFICES)`,
`publish-forecast-plots.mjs`) at ~11.6s each on a local production build, under a 15-minute
`CAPTURE_BUDGET_MS` for the whole capture phase. 40 offices is ~8 minutes of pure render
before fetch or upload, on hardware faster than a GitHub runner. The budget starts skipping
offices — publishing a partial release, by design — well before 10 GB is in sight. This is
why "optimize plot runtime" is not a side quest: it *is* the lever on N.

*Upstream request volume.* `/api/forecast` issues one `api.weather.gov` request per
gridpoint, ~250 per office standalone. 40 published offices is **~10,000 gridpoint requests
per real publish**, 7–10× a day. Nothing in the plan bounds this, and being throttled by
NWS would break the publisher and the live path at once. Measure the actual rate before
scaling the office count, and consider whether the lattice can be coarsened or whether
NDFD's gridded files replace the per-point fan-out entirely.

*Not a constraint:* GitHub Actions minutes. The repo is public, so they are unmetered —
the workflow's own comment says this and it is correct.

- [ ] Rank offices by population served and publish the top ~50, plus national +
      regional, leaving headroom rather than sitting on the quota line.
- [ ] Make the publisher's office list derive from the registry (`ready` + a `published`
      flag) rather than its own hardcoded array.
- [ ] Re-measure the publish rate once the thinned schedule has run for a week — the
      table above is the whole budget, and it rests on that one number.
