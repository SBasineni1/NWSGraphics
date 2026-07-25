import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the default office's apparent-temperature product", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  // PHI is the default office, so the server-rendered shell always shows it.
  assert.match(html, /PHI/);
  assert.match(html, /Philadelphia \/ Mount Holly/);
  assert.match(html, /Forecast Graphics/);
  assert.match(html, /Day (?:<!-- -->)?1(?:<!-- -->)? Forecast Graphics/);
  assert.match(html, /Day (?:<!-- -->)?2/);
  assert.match(html, /Day (?:<!-- -->)?3/);
  assert.match(html, /Forecast catalogue/);
  assert.match(html, /Temperature &amp; heat/);
  assert.match(html, /NWS data source/);
  assert.match(html, />Menu</);
  // Product count is derived, not hardcoded, so adding a product can't leave it stale.
  // React splits the interpolation into its own text node, hence the comment markers.
  assert.match(html, /\[(?:<!-- -->)?10(?:<!-- -->)?\]/);
  assert.match(html, /Data status/);
  assert.doesNotMatch(html, /FORECAST AREA|VALID PERIOD|NWS ISSUED|All charts/);
  assert.doesNotMatch(html, /STATIC FORECAST|900 × 760 PNG|publication-ready/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("uses official NWS apparent-temperature grid data", async () => {
  const [route, component, publishedRoute] = await Promise.all([
    readFile(new URL("../app/api/forecast/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/published-forecast/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /api\.weather\.gov\/gridpoints\/\$\{location\.wfo\}/);
  assert.match(route, /apparentTemperature/);
  assert.match(route, /temperature/);
  // Overnight lows come from NWS's published minTemperature via a "min" aggregation, not
  // from a calendar-day minimum of the hourly series (which straddles two nights).
  assert.match(route, /minTemperature: dailyValues\(data\.properties\.minTemperature[\s\S]*?"min"\)/);
  assert.match(route, /mode: "max" \| "min" \| "sum" \| "mean"/);
  // Sky cover is averaged, not peaked — one cloudy hour must not brand a sunny day.
  assert.match(route, /skyCover: dailyValues\(data\.properties\.skyCover[\s\S]*?"mean"\)/);
  assert.match(route, /dewpoint: dailyValues\(data\.properties\.dewpoint[\s\S]*?"max"\)/);
  assert.match(route, /windSpeed: dailyValues\(data\.properties\.windSpeed[\s\S]*?"max"\)/);
  assert.match(route, /windGust/);
  assert.match(route, /probabilityOfPrecipitation/);
  assert.match(route, /quantitativePrecipitation/);
  assert.match(route, /GRID_LOCATIONS/);
  assert.match(route, /grid-points\.json/);
  assert.match(route, /city-points\.json/);
  assert.match(route, /index \+= 24/);
  assert.match(route, /label: false/);
  assert.match(route, /Cache-Control/);
  assert.match(route, /Array\.from\(\{ length: 3 \}/);
  assert.match(component, /15 \* 60 \* 1000/);
  assert.match(component, /const FORECAST_DAYS = \[0, 1, 2\]/);
  assert.match(component, /const \[dayIndex, setDayIndex\] = useState\(0\)/);
  assert.match(component, /NEXT_PUBLIC_FORECAST_ASSET_BASE_URL/);
  assert.match(component, /\/api\/published-forecast/);
  assert.match(component, /\/api\/forecast-assets\//);
  assert.match(publishedRoute, /latest\.json/);
  assert.match(component, /PublishedForecastPlot/);
  assert.match(component, /data-render-state=/);
  assert.match(component, /data-product-file=/);
  assert.match(component, /Maximum Temperature/);
  assert.match(component, /Minimum Temperature/);
  assert.match(component, /id: "minTemperature"[^\n]*verticalLegend: true/);
  assert.match(component, /Maximum Wind Gust/);
  assert.match(component, /Maximum Sustained Wind/);
  assert.match(component, /Average Sky Cover/);
  assert.match(component, /Maximum Dewpoint/);
  assert.match(component, /Maximum POP %/);
  assert.match(component, /Total Precipitation Forecast/);
  // The graphic must name the issuing office, not just "NWS".
  assert.match(component, /NWS \$\{office\} ISSUED/);
  assert.match(component, /12:00 AM–11:59 PM/);
  assert.match(component, /weather-mark-white\.png/);
  assert.match(component, /drawImage\(headerMark/);
  assert.doesNotMatch(component, /FORECAST GRAPHICS  \/  DAY|PHI FORECAST AREA/);
  assert.match(component, /Download PNG/);
  assert.match(component, /PRODUCT_GROUPS/);
  assert.doesNotMatch(component, /forecast-context|forecast-tabs|section-heading/);
  assert.doesNotMatch(component, /STATIC FORECAST/);
  assert.doesNotMatch(component, /product-meta/);
  assert.match(component, /const RENDER_SCALE = 2/);
  assert.match(component, /canvas\.width = PLOT_WIDTH \* RENDER_SCALE/);
  assert.match(component, /raster\.width = PLOT_WIDTH/);
  assert.match(component, /value: -50/);
  assert.match(component, /value: 120/);
  assert.match(component, /verticalLegend: true/);
  assert.match(component, /id: "windGust"[^\n]*verticalLegend: true/);
  assert.match(component, /id: "probabilityOfPrecipitation"[^\n]*verticalLegend: true/);
  assert.match(component, /id: "quantitativePrecipitation"[^\n]*verticalLegend: true/);
  assert.match(component, /outlinedText/);
  assert.match(component, /traceCounties/);
  assert.match(component, /traceBoundary/);
  // The field now fills the whole frame; the CWA is marked by its outline alone.
  assert.doesNotMatch(component, /context\.clip\("evenodd"\)/);
  assert.match(component, /const neighborCount = 8/);
  assert.match(component, /points\.filter\(\(point\) => !point\.label\)/);
  assert.doesNotMatch(component, /coverageFalloff|maskFar/);
  assert.match(component, /rastertiles\/voyager/);
  assert.match(component, /counties\.geojson/);
  assert.match(component, /item\.label/);
});

test("fills the whole frame without re-solving the field per pixel", async () => {
  const component = await readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8");
  assert.match(component, /const FIELD_STRIDE = 4/);
  assert.match(component, /const COLOR_LUT_SIZE = 1024/);
  // The +1 keeps a lattice sample at or past each far edge; without it the last stride
  // of pixels has no upper neighbour and the raster ends in a seam.
  assert.match(component, /Math\.ceil\(\(raster\.width - 1\) \/ FIELD_STRIDE\) \+ 1/);
  assert.match(component, /Math\.ceil\(\(raster\.height - 1\) \/ FIELD_STRIDE\) \+ 1/);
  assert.match(component, /function colorRamp/);
  assert.match(component, /new Uint8ClampedArray\(COLOR_LUT_SIZE \* 3\)/);
  // Entries must come from colorFor itself — the stops are not evenly spaced.
  assert.match(component, /colorFor\(min \+ span \* \(index \/ \(COLOR_LUT_SIZE - 1\)\), stops\)/);
});

test("selects the forecast office by region", async () => {
  const [offices, component, route] = await Promise.all([
    readFile(new URL("../app/offices.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/forecast/route.ts", import.meta.url), "utf8"),
  ]);
  for (const office of ["PHI", "OKX", "CTP", "LWX"]) {
    assert.match(offices, new RegExp(`id: "${office}"`), `expected ${office} in the registry`);
  }
  assert.match(offices, /Eastern Region/);
  assert.match(offices, /DEFAULT_OFFICE: OfficeId = "PHI"/);
  // Unknown ids must degrade to the default rather than throwing.
  assert.match(offices, /export function findOffice/);
  assert.match(component, /function OfficePicker/);
  assert.match(component, /role="listbox"/);
  assert.match(component, /role="option"/);
  // `expanded` excludes the exit animation, so the trigger doesn't advertise an open
  // listbox while the menu is on its way out.
  assert.match(component, /const expanded = open && !closing/);
  assert.match(component, /aria-expanded=\{expanded\}/);
  assert.match(component, /event\.key === "Escape"/);
  assert.match(component, /window\.history\.replaceState/);
  assert.match(component, /\/api\/forecast\?office=\$\{office\.id\}/);
  assert.match(component, /cwa\.geojson/);
  assert.match(component, /data-office=/);
  assert.match(route, /searchParams\.get\("office"\)/);
  assert.match(route, /function locationsFor/);
  assert.match(route, /location\.offices\.includes\(office\)/);
});

test("animates the office menu open with a staggered cascade", async () => {
  const [component, css] = await Promise.all([
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  // The menu must survive its own exit animation rather than unmounting instantly.
  assert.match(component, /const MENU_EXIT_MS = (\d+)/);
  assert.match(component, /setClosing\(true\)/);
  assert.match(component, /is-closing/);
  // A single running index across headings and options keeps the cascade one sweep.
  assert.match(component, /rowIndex\.get\(`region:\$\{region\.id\}`\)/);
  assert.match(component, /rowIndex\.get\(`office:\$\{entry\.id\}`\)/);

  assert.match(css, /@keyframes office-row-in/);
  assert.match(css, /@keyframes office-row-out/);
  assert.match(css, /animation-delay: calc\(40ms \+ var\(--row, 0\) \* 42ms\)/);
  // `backwards`, not `both` — `both` would pin transform and kill the :active press.
  assert.match(css, /animation: office-row-in [^;]*backwards/);
  assert.doesNotMatch(css, /animation: office-row-in [^;]*\bboth\b/);
  // Motion must be optional.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);

  // The pills are free-standing: the menu is a transparent stack, not a panel. A
  // background or border here would put the box back.
  const menuBlock = /\.office-menu\s*\{([^}]*)\}/.exec(css);
  assert.ok(menuBlock, "could not find the .office-menu rule");
  assert.doesNotMatch(menuBlock[1], /background|border(?!-)|box-shadow/);
  assert.match(css, /\.office-group button\s*\{[^}]*border-radius: 999px/);

  // The CSS exit duration and the unmount timer have to agree, or the pills either
  // disappear mid-animation or linger after it finishes.
  const exitMs = Number(/const MENU_EXIT_MS = (\d+)/.exec(component)[1]);
  const cssExit = /animation:\s*office-row-out\s+\.(\d+)s/.exec(css);
  assert.ok(cssExit, "could not read the office-row-out duration from globals.css");
  assert.equal(Number(cssExit[1]) * 10, exitMs, "MENU_EXIT_MS must match the office-row-out duration");
});

test("publishes changed forecast canvases on the issuance-aware schedule", async () => {
  const [publisher, workflow] = await Promise.all([
    readFile(new URL("../scripts/publish-forecast-plots.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/publish-forecast-plots.yml", import.meta.url), "utf8"),
  ]);
  assert.match(publisher, /previous\?\.updatedAt === forecast\.updatedAt/);
  assert.match(publisher, /previous\?\.sourceRevision === sourceRevision/);
  assert.match(publisher, /dataset\.renderState === "ready"/);
  assert.match(publisher, /preview\.width = 900/);
  assert.match(publisher, /preview\.height = Math\.round/);
  assert.match(publisher, /width: images\.width/);
  assert.match(publisher, /releases\/\$\{id\}\/\$\{office\}\/day-/);
  assert.match(publisher, /publishObject\("latest\.json"/);
  assert.match(workflow, /cron: "27 \* \* \* \*"/);
  assert.match(workflow, /cron: "5,15,25,35,45,55 3,15 \* \* \*"/);
  assert.match(workflow, /timezone: "America\/New_York"/);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /R2_PUBLIC_BASE_URL/);
  assert.match(workflow, /cancel-in-progress: false/);
  // Four offices is roughly 4× the single-office runtime the old timeout allowed.
  assert.match(workflow, /timeout-minutes: 90/);
});

test("publishes every office and prunes aged-out releases", async () => {
  const [publisher, component, assetRoute] = await Promise.all([
    readFile(new URL("../scripts/publish-forecast-plots.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/forecast-assets/[...path]/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(publisher, /const OFFICES = \["PHI", "OKX", "CTP", "LWX"\]/);
  assert.match(publisher, /schemaVersion: 2/);
  assert.match(publisher, /manifest\.offices\[office\] = \{ days \}/);
  assert.match(publisher, /\?office=\$\{office\}/);
  // Each office navigates afresh so the readiness wait can't latch onto stale canvases.
  assert.match(publisher, /canvas\.dataset\.office === selectedOffice/);
  assert.match(publisher, /ListObjectsV2Command/);
  assert.match(publisher, /DeleteObjectsCommand/);
  assert.match(publisher, /function pruneOldReleases/);
  // Retention is a count, not an age: publishes-per-day is set by NWS issuance
  // frequency, so an age window doesn't bound storage. N releases does.
  assert.match(publisher, /RELEASE_RETENTION_COUNT/);
  assert.doesNotMatch(publisher, /RELEASE_RETENTION_DAYS/);
  assert.match(publisher, /const keep = new Set\(\[id, \.\.\.ordered\.slice\(0, retentionCount\)\]\)/);
  // Anything not shaped like a release id must never be a delete candidate.
  assert.match(publisher, /if \(!release \|\| !releaseDate\(release\)\) continue/);
  // Keeping only the newest release leaves no grace window for a stale manifest, so a
  // failed image must trigger a throttled manifest refetch instead of staying broken
  // until the next scheduled refresh.
  assert.match(publisher, /retentionSetting \? Number\(retentionSetting\) : 1/);
  assert.match(component, /onError=\{onAssetMissing\}/);
  assert.match(component, /function recoverFromMissingAsset|const recoverFromMissingAsset/);
  assert.match(component, /lastManifestRecovery\.current < 30_000/);
  assert.match(component, /\}, \[manifestNonce\]\)/);
  // A v1 manifest must keep serving PHI rather than dropping every visitor onto the
  // live-canvas path while waiting for the first v2 publish. Deploying the client ahead
  // of the publisher is the normal order, so this is the normal case, not an edge case.
  assert.match(component, /function publishedDaysFor/);
  assert.match(component, /manifest\.schemaVersion === 2/);
  assert.match(component, /office === "PHI" \? manifest\.days : undefined/);
  assert.match(component, /schemaVersion !== 1 && manifest\.schemaVersion !== 2/);
  // The asset path guard admits both key shapes and nothing else.
  assert.match(assetRoute, /\(\?:\[A-Z\]\{3\}\\\/\)\?day-\[1-3\]/);
});

test("publisher discovers products from the page, so adding one needs no job change", async () => {
  const [publisher, component] = await Promise.all([
    readFile(new URL("../scripts/publish-forecast-plots.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
  ]);
  // Products are read off the DOM, never enumerated here. Hardcoding a list would mean
  // every new product silently stopped being published.
  assert.match(publisher, /querySelectorAll\("canvas\[data-product-id\]"\)/);
  assert.match(publisher, /getAttribute\("data-product-id"\)/);
  assert.match(publisher, /getAttribute\("data-product-file"\)/);
  // Anchored on `kind:` so this scrapes PRODUCTS entries and not PRODUCT_GROUPS, whose
  // entries are also `{ id, title }`.
  const productIds = [...component.matchAll(/kind: "\w+", id: "(\w+)", title:/g)].map((match) => match[1]);
  assert.ok(productIds.length >= 10, `expected the product list to be discovered, got ${productIds.length}`);
  for (const id of productIds) {
    // Whole-word, or a short id like "wind" would match "window" in a comment.
    assert.doesNotMatch(publisher, new RegExp(`\\b${id}\\b`), `publisher must not name product "${id}" — it should discover products`);
  }
  // Every product's file slug has to satisfy the asset-path guard, or its PNG 404s.
  const slugs = [...component.matchAll(/file: "([a-z-]+)"/g)].map((match) => match[1]);
  assert.equal(slugs.length, productIds.length);
  for (const slug of slugs) {
    for (const key of [`${slug}.png`, `${slug}-preview.png`]) {
      assert.match(key, /^[a-z][a-z-]*\.png$/, `asset key ${key} would be rejected by the path guard`);
    }
  }
});

test("renders SPC categorical outlooks alongside the gridpoint fields", async () => {
  const [route, component] = await Promise.all([
    readFile(new URL("../app/api/spc-outlook/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
  ]);
  // Categorical is the only product SPC publishes all three days — torn/wind/hail stop
  // after Day 2 and `prob` has no Day 1 — so this route must stay categorical-only.
  assert.match(route, /day\$\{day\}otlk_cat\.nolyr\.geojson/);
  assert.doesNotMatch(route, /otlk_(?:torn|wind|hail|prob)/);
  assert.match(route, /OUTLOOK_DAYS = \[1, 2, 3\]/);
  // DN encodes severity; painting in that order keeps higher risk on top.
  assert.match(route, /\(a\.properties\.DN \?\? 0\) - \(b\.properties\.DN \?\? 0\)/);
  // One failed day must not fail the whole request.
  assert.match(route, /Promise\.allSettled/);

  // Two product kinds share the catalogue but not the renderer.
  assert.match(component, /kind: "field"/);
  assert.match(component, /kind: "outlook"/);
  assert.match(component, /function renderOutlookPlot/);
  assert.match(component, /spec\.kind === "outlook"/);
  // SPC's convective day is 12Z–12Z, so the graphic labels itself from SPC's own window
  // rather than the site's Eastern calendar day.
  assert.match(component, /function outlookHeaderLines/);
  assert.match(component, /SPC ISSUED/);
  // A national outlook usually misses any single CWA; that must read as a real state.
  assert.match(component, /NO SEVERE WEATHER RISK AREA/);
  assert.match(component, /function outlookTouchesFrame/);
  // The legend shows every category, not just today's, so the scale can't shift meaning.
  assert.match(component, /OUTLOOK_CATEGORIES/);
  for (const label of ["TSTM", "MRGL", "SLGT", "ENH", "MDT", "HIGH"]) {
    assert.match(component, new RegExp(`label: "${label}"`), `expected ${label} in the legend`);
  }
});

test("no render path can hang on an external request", async () => {
  const [component, publisher] = await Promise.all([
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/publish-forecast-plots.mjs", import.meta.url), "utf8"),
  ]);
  // A fetch without a timeout inside the render path is the failure mode that stalls the
  // publisher: the promise never settles, data-render-state stays "rendering", and the
  // readiness wait times out. Basemap tiles hit a third party, so they must be bounded.
  assert.match(component, /const TILE_TIMEOUT_MS = 15_000/);
  assert.match(component, /fetch\(url, \{ signal: AbortSignal\.timeout\(TILE_TIMEOUT_MS\) \}\)/);
  // A failed tile must be evicted: the promise is shared by every canvas at this extent,
  // so caching a rejected or hung one would poison the whole page.
  assert.match(component, /request\.catch\(\(\) => tileCache\.delete\(url\)\)/);
  assert.match(component, /fetch\("\/weather-mark-white\.png", \{ signal: AbortSignal\.timeout/);
  assert.match(component, /fetch\("\/api\/spc-outlook", \{ cache: "no-store", signal: AbortSignal\.timeout/);

  // An unreachable SPC must still produce a finished canvas.
  assert.match(component, /SPC OUTLOOK UNAVAILABLE/);
  assert.match(component, /if \(outlookPending\) return;/);
  assert.match(component, /setOutlookPending\(false\)/);

  // The publisher renders from a fixed SPC snapshot, as it already does for the forecast.
  assert.match(publisher, /page\.route\("\*\*\/api\/spc-outlook"/);
  assert.match(publisher, /outlookSnapshot/);
});

test("resolves both published key shapes and rejects anything else", async () => {
  const source = await readFile(new URL("../app/api/forecast-assets/[...path]/route.ts", import.meta.url), "utf8");
  const pattern = new RegExp(/^releases\/\d{8}T\d{6}Z\/(?:[A-Z]{3}\/)?day-[1-3]\/[a-z][a-z-]*\.png$/);
  // Guard against the literal in the route drifting from what this test asserts.
  assert.ok(source.includes(pattern.source), "route regex no longer matches the tested pattern");
  for (const key of [
    "releases/20260724T205317Z/PHI/day-1/max-apparent-temperature.png",
    "releases/20260724T205317Z/OKX/day-3/total-precipitation-preview.png",
    "releases/20260724T205317Z/day-1/max-apparent-temperature.png",
  ]) {
    assert.ok(pattern.test(key), `expected ${key} to be served`);
  }
  for (const key of [
    "releases/../../etc/passwd.png",
    "releases/20260724T205317Z/phi/day-1/max-temperature.png",
    "releases/20260724T205317Z/PHI/day-9/max-temperature.png",
    "releases/20260724T205317Z/PHI/day-1/../../secret.png",
    "latest.json",
  ]) {
    assert.ok(!pattern.test(key), `expected ${key} to be rejected`);
  }
});

test("uses the official County Warning Area boundary for every office", async () => {
  const source = await readFile(new URL("../public/cwa.geojson", import.meta.url), "utf8");
  const boundary = JSON.parse(source);
  assert.equal(boundary.type, "FeatureCollection");
  assert.equal(boundary.features.length, 4);
  for (const office of ["PHI", "OKX", "CTP", "LWX"]) {
    const feature = boundary.features.find((entry) => entry.properties.cwa === office);
    assert.ok(feature, `expected a boundary for ${office}`);
    assert.equal(feature.properties.wfo, office);
    // The NWS source mixes Polygon and MultiPolygon, so consumers must handle both.
    assert.match(feature.geometry.type, /^(Polygon|MultiPolygon)$/);
  }
});

test("bundles trimmed county boundaries for the region", async () => {
  const source = await readFile(new URL("../public/counties.geojson", import.meta.url), "utf8");
  const counties = JSON.parse(source);
  assert.equal(counties.type, "FeatureCollection");
  assert.ok(counties.features.length > 30, "expected county coverage for the region");
  for (const feature of counties.features.slice(0, 5)) {
    assert.match(feature.geometry.type, /^(Polygon|MultiPolygon)$/);
  }
  const states = new Set(counties.features.map((feature) => String(feature.id).slice(0, 2)));
  // WV and CT are only reachable once the frame widens past the original PHI-only box.
  for (const fips of ["10", "24", "34", "36", "42", "54", "09"]) {
    assert.ok(states.has(fips), `expected state FIPS ${fips}`);
  }
});

test("bundles a regional grid of forecast points tagged by office", async () => {
  const source = await readFile(new URL("../app/api/forecast/grid-points.json", import.meta.url), "utf8");
  const points = JSON.parse(source);
  assert.ok(Array.isArray(points) && points.length > 300, "expected a regional lattice of gridpoints");
  for (const point of points.slice(0, 5)) {
    assert.match(point.wfo, /^[A-Z]{3}$/);
    assert.equal(typeof point.x, "number");
    assert.equal(typeof point.y, "number");
    assert.equal(typeof point.lat, "number");
    assert.equal(typeof point.lon, "number");
  }
  for (const office of ["PHI", "OKX", "CTP", "LWX"]) {
    const forOffice = points.filter((point) => point.offices.includes(office));
    assert.ok(forOffice.length > 80, `expected a usable field for ${office}, got ${forOffice.length}`);
    // Per-office scoping is what keeps each request inside the subrequest budget.
    assert.ok(forOffice.length < points.length, `expected ${office} to fetch less than the whole lattice`);
  }
  // The frame extends past the CWAs, so neighbouring offices supply the outer band.
  const owners = new Set(points.map((point) => point.wfo));
  assert.ok(owners.size > 4, "expected neighbouring offices to supply the buffer band");
});

test("bundles labeled cities attributed to the office that forecasts them", async () => {
  const source = await readFile(new URL("../app/api/forecast/city-points.json", import.meta.url), "utf8");
  const cities = JSON.parse(source);
  assert.ok(Array.isArray(cities) && cities.length > 50, "expected labeled cities for every office");
  for (const office of ["PHI", "OKX", "CTP", "LWX"]) {
    const forOffice = cities.filter((city) => city.office === office);
    assert.ok(forOffice.length >= 10, `expected at least 10 labeled cities for ${office}`);
  }
  for (const city of cities) {
    assert.match(city.office, /^[A-Z]{3}$/);
    assert.equal(typeof city.x, "number");
    assert.equal(typeof city.y, "number");
    assert.equal(typeof city.lat, "number");
    assert.equal(typeof city.lon, "number");
  }
  const ids = cities.map((city) => city.id);
  assert.equal(new Set(ids).size, ids.length, "expected city ids to be unique");
});
