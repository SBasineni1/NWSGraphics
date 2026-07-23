# PHI Forecast Graphics

Publication-ready forecast graphics for the National Weather Service
Philadelphia / Mount Holly forecast area. The site uses official
`api.weather.gov` grid data and produces three forecast days for every product.

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
5. Generates a 900×760 web preview and 1800×1520 download for every product
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

An R2 lifecycle rule can remove objects under `releases/` after the desired
history period. Keep `latest.json` excluded from that rule.

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

`app/api/forecast/grid-points.json` contains the dense PHI sampling lattice.
Rebuild it from the official CWA boundary with:

```bash
node scripts/build-grid-points.mjs
```
