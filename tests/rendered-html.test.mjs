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

test("server-renders the PHI apparent-temperature product", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /PHI Forecast Graphics/);
  assert.match(html, /Day 1 Forecast Graphics/);
  assert.match(html, /Philadelphia \/ Mount Holly/);
  assert.match(html, /Forecast catalogue/);
  assert.match(html, /Temperature &amp; heat/);
  assert.match(html, /NWS data source/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("uses official NWS apparent-temperature grid data", async () => {
  const [route, component] = await Promise.all([
    readFile(new URL("../app/api/forecast/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /api\.weather\.gov\/gridpoints\/\$\{location\.wfo\}/);
  assert.match(route, /apparentTemperature/);
  assert.match(route, /temperature/);
  assert.match(route, /windGust/);
  assert.match(route, /probabilityOfPrecipitation/);
  assert.match(route, /quantitativePrecipitation/);
  assert.match(route, /GRID_LOCATIONS/);
  assert.match(route, /grid-points\.json/);
  assert.match(route, /index \+= 12/);
  assert.match(route, /label: false/);
  assert.match(route, /Cache-Control/);
  assert.match(component, /15 \* 60 \* 1000/);
  assert.match(component, /const DAY = 0/);
  assert.match(component, /Maximum Temperature/);
  assert.match(component, /Maximum Wind Gust/);
  assert.match(component, /Maximum Probability of Precipitation/);
  assert.match(component, /Total Precipitation Forecast/);
  assert.match(component, /Download PNG/);
  assert.match(component, /PRODUCT_GROUPS/);
  assert.match(component, /FORECAST AREA/);
  assert.match(component, /STATIC FORECAST/);
  assert.match(component, /const width = 900/);
  assert.match(component, /value: -50/);
  assert.match(component, /value: 120/);
  assert.match(component, /verticalLegend: true/);
  assert.match(component, /traceCounties/);
  assert.match(component, /rastertiles\/voyager/);
  assert.match(component, /counties\.geojson/);
  assert.match(component, /item\.label/);
});

test("uses the official PHI County Warning Area boundary", async () => {
  const source = await readFile(new URL("../public/phi-cwa.geojson", import.meta.url), "utf8");
  const boundary = JSON.parse(source);
  assert.equal(boundary.type, "FeatureCollection");
  assert.equal(boundary.features[0].geometry.type, "MultiPolygon");
  assert.equal(boundary.features[0].properties.wfo, "PHI");
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
  for (const fips of ["10", "24", "34", "36", "42"]) {
    assert.ok(states.has(fips), `expected state FIPS ${fips}`);
  }
});

test("bundles multi-office gridpoints covering the Northeast frame", async () => {
  const source = await readFile(new URL("../app/api/forecast/grid-points.json", import.meta.url), "utf8");
  const points = JSON.parse(source);
  assert.ok(Array.isArray(points) && points.length > 80, "expected a broad grid of gridpoints");
  for (const point of points.slice(0, 5)) {
    assert.match(point.wfo, /^[A-Z]{3}$/);
    assert.equal(typeof point.x, "number");
    assert.equal(typeof point.y, "number");
  }
  const offices = new Set(points.map((point) => point.wfo));
  for (const wfo of ["PHI", "OKX", "LWX"]) {
    assert.ok(offices.has(wfo), `expected office ${wfo}`);
  }
});
