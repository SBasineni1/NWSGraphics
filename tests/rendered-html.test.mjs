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
  assert.match(html, /\[5\]/);
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
  assert.match(component, /Maximum Wind Gust/);
  assert.match(component, /Maximum POP %/);
  assert.match(component, /Total Precipitation Forecast/);
  assert.match(component, /NWS ISSUED/);
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
  assert.match(component, /canvas\.width = width \* RENDER_SCALE/);
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
  assert.match(component, /aria-expanded=\{open\}/);
  assert.match(component, /event\.key === "Escape"/);
  assert.match(component, /window\.history\.replaceState/);
  assert.match(component, /\/api\/forecast\?office=\$\{office\.id\}/);
  assert.match(component, /cwa\.geojson/);
  assert.match(component, /data-office=/);
  assert.match(route, /searchParams\.get\("office"\)/);
  assert.match(route, /function locationsFor/);
  assert.match(route, /location\.offices\.includes\(office\)/);
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
  assert.match(publisher, /RELEASE_RETENTION_DAYS/);
  // The release being published must never be a prune candidate.
  assert.match(publisher, /release === id\) continue/);
  // The client must refuse a manifest it doesn't understand.
  assert.match(component, /manifest\.schemaVersion !== 2/);
  assert.match(component, /publishedForecast\?\.offices\?\.\[office\.id\]\?\.days/);
  // The asset path guard has to admit the office segment and nothing else.
  assert.match(assetRoute, /releases\\\/\\d\{8\}T\\d\{6\}Z\\\/\[A-Z\]\{3\}\\\/day-\[1-3\]/);
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
