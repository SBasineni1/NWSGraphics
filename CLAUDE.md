# CLAUDE.md

Guidance for working in this repository.

## What this is

**NWS Forecast Graphics** — publication-ready 3-day weather graphics for four
National Weather Service forecast offices in Eastern Region: Philadelphia /
Mount Holly (**PHI**), New York City (**OKX**), State College (**CTP**), and
Baltimore / Washington (**LWX**). It pulls official `api.weather.gov` gridpoint
data and renders Day 1–3 maps for five products: apparent temperature,
temperature, wind gust, probability of precipitation, and quantitative
precipitation.

The covered offices are declared in `app/offices.ts` (`REGIONS` → offices) —
that table is the single source of truth. The selected office lives in the
`?office=` query parameter, read through `useSyncExternalStore` so deep links,
browser history, and the publisher's per-office navigation all agree.

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
  (imports the built worker from `dist/` and asserts the SSR HTML).
- `npm run lint` — ESLint (`eslint-config-next`).
- `npm run plots:publish` — run the R2 publisher (see below).
- `node scripts/build-cwa.mjs` / `build-grid-points.mjs` /
  `build-city-points.mjs` / `build-counties.mjs` / `build-overlays.mjs` —
  regenerate the geojson + grid-point assets in `public/` and
  `app/api/forecast/`. After adding an office to `app/offices.ts`, re-run
  `build-cwa` → `build-grid-points` → `build-city-points` in that order
  (`build-grid-points` reads `public/cwa.geojson`).

## How it renders (two paths)

The frontend (`app/components/ForecastGraphic.tsx`, a large `"use client"`
component) chooses at runtime:

1. **Published assets (preferred in prod).** If
   `NEXT_PUBLIC_FORECAST_ASSET_BASE_URL` is set, it loads pre-generated PNGs.
   `/api/published-forecast` fetches `latest.json` from R2;
   `/api/forecast-assets/[...path]` proxies the versioned `releases/*.png`
   (path is validated against a strict regex — keep that guard).
2. **Live canvas fallback.** Otherwise it renders maps in the browser: fetches
   `/api/forecast?office=…`, samples the forecast field with inverse-distance
   weighting (`sampleField`), and paints geojson overlays (`public/*.geojson`)
   plus city labels onto a `<canvas>` at 900×760 (`RENDER_SCALE = 2`).

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

- `FIELD_STRIDE = 4` — `sampleField` is solved on a coarse lattice and
  bilinearly upsampled. The `Math.ceil((size - 1) / FIELD_STRIDE) + 1` sample
  counts are deliberate; drop the `+ 1` and the last stride of pixels has no
  upper neighbour and the raster ends in a visible seam.
- `colorRamp()` — a 1024-entry LUT per product, since `colorFor` re-parses hex
  strings and can't run 684,000 times per plot. Entries must be produced *by*
  `colorFor`; the stops aren't evenly spaced (QPF runs 0, 0.01, 0.1, 0.25 …).

## Publishing pipeline

`scripts/publish-forecast-plots.mjs` drives a headless Playwright Chromium over
the running site, navigating to `?office=…` per office, and captures each
office/day/product canvas as a PNG — 4 × 3 × 5 = 60 per release. It uploads
immutable `releases/{releaseId}/{OFFICE}/day-{n}/…` objects + a fresh
`latest.json` (**manifest `schemaVersion: 2`**, keyed by office) to Cloudflare
R2 via the S3 client. It skips work when the NWS `updateTime` and source
revision are unchanged unless `FORCE_PUBLISH=true`. Driven hourly (and every
10 min in the early-AM/PM update windows) by
`.github/workflows/publish-forecast-plots.yml`.

After `latest.json` is written, `pruneOldReleases()` deletes release prefixes
older than `RELEASE_RETENTION_DAYS` (default 7, `0` disables) and never the one
just published. Without it the bucket grows ~150 MB per publish forever. A
failed prune is logged and ignored — the release is already live.

Local dry run: `PLOT_OUTPUT_ONLY=true npm run plots:publish` writes to
`outputs/forecast-publish/` without uploading or pruning. See `README.md` for
the full R2 / GitHub secrets setup.

## Conventions & gotchas

- Dates are anchored to **`America/New_York`**; the three forecast days are
  computed in Eastern time — preserve the timezone handling in `route.ts`.
- Products, color stops, legends, and units are declared in the `PRODUCTS`
  array in `ForecastGraphic.tsx`; the `ProductId` union is duplicated in
  `route.ts`. Change both together. (`OfficeId` is *not* duplicated — it lives
  only in `app/offices.ts`.)
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
