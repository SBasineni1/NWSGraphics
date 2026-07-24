# NWS Forecast Graphics

Publication-ready forecast graphics for four National Weather Service forecast
offices in Eastern Region — Philadelphia / Mount Holly (PHI), New York City
(OKX), State College (CTP), and Baltimore / Washington (LWX). Pick an office
from the sidebar dropdown, or link straight to one with `?office=OKX`.

The site uses official `api.weather.gov` grid data and produces three forecast
days for every product. Each map's colour field covers the whole frame using
real gridpoint data from neighbouring offices; the selected office's County
Warning Area is marked by its outline.

## Local development

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
npm test
```

Without a published-image URL, the site uses its built-in live canvas renderer.
That fallback keeps local development and unconfigured deployments functional.

## Scheduled image publication

The workflow at `.github/workflows/publish-forecast-plots.yml`:

1. Checks once an hour throughout the day.
2. Checks every ten minutes from 2:45–4:25 AM and PM in
   `America/New_York`.
3. Reads the NWS `updateTime` before doing expensive work.
4. Skips publication when both the forecast and source revision are unchanged.
5. Generates a 900-pixel-wide web preview and 1800-pixel-wide download for every product
   across all three days.
6. Uploads immutable, versioned PNGs and replaces `latest.json` only after the
   full release succeeds.

The workflow can also be run manually from GitHub Actions. Select **force** to
republish an unchanged forecast.

### One-time Cloudflare R2 setup

Create a public R2 bucket and an R2 API token with object read/write access to
that bucket. Add these GitHub repository settings:

**Actions secrets**

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

**Actions variables**

- `R2_BUCKET` — the bucket name
- `R2_PUBLIC_BASE_URL` — the public bucket or custom-domain URL, without a
  trailing slash

Until all five values exist, scheduled workflow runs exit successfully without
publishing.

Because the website fetches `latest.json` in the browser, allow `GET` and
`HEAD` requests from the production website in the bucket CORS policy:

```json
[
  {
    "AllowedOrigins": ["https://your-forecast-domain.example"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

The publisher prunes release prefixes older than `RELEASE_RETENTION_DAYS`
(default 7) after each successful publish, so no R2 lifecycle rule is required.
Set the repository variable to override it, or to `0` to disable pruning and
keep every release. `latest.json` is never pruned.

### Website configuration

Set this build-time environment variable on Vercel or another web host:

```bash
NEXT_PUBLIC_FORECAST_ASSET_BASE_URL=https://your-public-r2-domain.example
```

Redeploy after setting it. The frontend will then load pre-generated previews,
lazy-load plots below the fold, and link downloads directly to the
high-resolution PNGs. If R2 is temporarily unavailable, the live renderer
remains available as a fallback.

### Local publisher test

Install the Playwright Chromium browser, start the site, and write a release to
`outputs/forecast-publish` without uploading:

```bash
npx playwright install chromium
PLOT_OUTPUT_ONLY=true npm run plots:publish
```

The output directory is ignored by Git.

## Forecast-point maintenance

`app/api/forecast/grid-points.json` contains the regional sampling lattice for
every covered office, and `city-points.json` the labeled cities.
Rebuild them from the official CWA boundaries with:

```bash
node scripts/build-cwa.mjs          # public/cwa.geojson for every office
node scripts/build-grid-points.mjs  # regional lattice, tagged per office
node scripts/build-city-points.mjs  # labeled cities, office-verified
```

Run them in that order — `build-grid-points.mjs` reads `public/cwa.geojson`.
`build-city-points.mjs` checks each city against the office `api.weather.gov`
actually assigns it to and fails on a mismatch.
