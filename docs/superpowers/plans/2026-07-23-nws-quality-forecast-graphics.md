# NWS-Quality Forecast Graphics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the PHI forecast canvas graphic to match the official NWS product — a full-frame temperature field over a sharp Mapbox-style basemap, county lines, a bold CWA outline, and a tighter/smaller layout.

**Architecture:** Keep the existing client-side canvas renderer in `app/components/ForecastGraphic.tsx`. Bundle a trimmed `public/counties.geojson` produced by a one-time prep script. Rewrite `renderPlot()` to stop clipping the temperature raster to the CWA (fill the whole frame), overlay county + CWA boundaries, upgrade the basemap to CARTO Voyager @2x retina tiles, and shrink the canvas from 1200×800 to 900×760. Polish the page shell in `app/globals.css`.

**Tech Stack:** Next.js 16 (edge runtime), React 19, TypeScript, HTML Canvas 2D, Tailwind v4, Node 22 (`node --test`), CARTO raster basemap tiles, US Census county GeoJSON (via plotly datasets mirror).

## Global Constraints

- Node `>=22.13.0` (top-level await + global `fetch` available in prep scripts).
- No new npm dependencies. No Mapbox/MapLibre GL. No access tokens. No interactivity/pan-zoom.
- No changes to `app/api/forecast/route.ts` or the forecast data model.
- Temperature palette, product list, and color stops stay exactly as-is (`value: -50` … `value: 120`, `verticalLegend: true`).
- County GeoJSON is a committed static asset; no runtime dependency on the plotly source.

---

### Task 1: Build the county boundary asset

**Files:**
- Create: `scripts/build-counties.mjs`
- Create (generated + committed): `public/counties.geojson`
- Modify: `tests/rendered-html.test.mjs` (add a county-asset test)

**Interfaces:**
- Produces: `public/counties.geojson` — a GeoJSON `FeatureCollection`. Each feature has `id` (5-digit FIPS string), `properties.fips` (same string), and `geometry` of type `Polygon` or `MultiPolygon` with `[lon, lat]` coordinate rings. Consumed by Task 2's `traceCounties()`.

- [ ] **Step 1: Write the prep script**

Create `scripts/build-counties.mjs`:

```js
import { writeFile } from "node:fs/promises";

const SOURCE = "https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json";
// State FIPS prefixes that intersect the render frame: NJ, PA, DE, MD, NY, VA.
const STATES = new Set(["34", "42", "10", "24", "36", "51"]);
const BBOX = { west: -77.5, east: -73.0, south: 37.8, north: 42.2 };

function touchesBbox(coordinates) {
  const stack = [coordinates];
  while (stack.length) {
    const node = stack.pop();
    if (typeof node[0] === "number") {
      const [lon, lat] = node;
      if (lon >= BBOX.west && lon <= BBOX.east && lat >= BBOX.south && lat <= BBOX.north) return true;
    } else {
      for (const child of node) stack.push(child);
    }
  }
  return false;
}

function round(node) {
  if (typeof node[0] === "number") return [Math.round(node[0] * 1e4) / 1e4, Math.round(node[1] * 1e4) / 1e4];
  return node.map(round);
}

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`county source ${response.status}`);
const data = await response.json();

const features = data.features
  .filter((feature) => STATES.has(String(feature.id).slice(0, 2)) && touchesBbox(feature.geometry.coordinates))
  .map((feature) => ({
    type: "Feature",
    id: String(feature.id),
    properties: { fips: String(feature.id) },
    geometry: { type: feature.geometry.type, coordinates: round(feature.geometry.coordinates) },
  }));

await writeFile(new URL("../public/counties.geojson", import.meta.url), JSON.stringify({ type: "FeatureCollection", features }));
console.log(`counties.geojson: ${features.length} features`);
```

- [ ] **Step 2: Run the script to generate the asset**

Run: `node scripts/build-counties.mjs`
Expected: prints `counties.geojson: <N> features` where N is roughly 40–90, and creates `public/counties.geojson`.

- [ ] **Step 3: Sanity-check the generated file size and shape**

Run: `ls -la public/counties.geojson && node -e "const g=require('fs').readFileSync('public/counties.geojson','utf8');const j=JSON.parse(g);console.log('features',j.features.length,'states',[...new Set(j.features.map(f=>f.id.slice(0,2)))].sort().join(','));"`
Expected: file is well under 1 MB; `states` includes `10,24,34,36,42` (VA `51` optional depending on bbox), features > 30.

- [ ] **Step 4: Add a failing test for the asset**

In `tests/rendered-html.test.mjs`, append a new test after the existing CWA-boundary test:

```js
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run build && node --test tests/rendered-html.test.mjs`
Expected: all tests pass, including the new "bundles trimmed county boundaries" test. (The two pre-existing assertions on `const width = 1200` and `destination-in` still pass at this point — they are updated in Task 4.)

- [ ] **Step 6: Commit**

```bash
git add scripts/build-counties.mjs public/counties.geojson tests/rendered-html.test.mjs
git commit -m "Add trimmed regional county boundary asset"
```

---

### Task 2: Wire county data into the component and rewrite the graphic renderer

**Files:**
- Modify: `app/components/ForecastGraphic.tsx`

**Interfaces:**
- Consumes: `public/counties.geojson` from Task 1 (fetched at `/counties.geojson`).
- Produces: `renderPlot(canvas, forecast, boundary, counties, spec)` — note the new `counties` parameter (4th arg, before `spec`). `ForecastPlot` gains a `counties: CountyBoundaries` prop; `ForecastGraphic` holds `counties` state.

- [ ] **Step 1: Add the county type**

In `app/components/ForecastGraphic.tsx`, after the `Boundary` type (around line 29), add:

```ts
type CountyBoundaries = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    id?: string;
    geometry: { type: "Polygon"; coordinates: number[][][] } | { type: "MultiPolygon"; coordinates: number[][][][] };
    properties: Record<string, unknown>;
  }>;
};
```

- [ ] **Step 2: Add a county tracer**

Immediately after the existing `traceBoundary` function (around line 118), add:

```ts
function traceCounties(context: CanvasRenderingContext2D, counties: CountyBoundaries, projectPoint: (lon: number, lat: number) => [number, number]) {
  context.beginPath();
  for (const feature of counties.features) {
    const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const polygon of polygons) {
      for (const ring of polygon) {
        ring.forEach((position, index) => {
          const [x, y] = projectPoint(position[0], position[1]);
          if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
        });
        context.closePath();
      }
    }
  }
}
```

- [ ] **Step 3: Upgrade the basemap tiles to Voyager @2x retina**

In `drawTiles` (around line 172), replace the tile URL line:

```ts
        const url = `https://a.basemaps.cartocdn.com/light_all/${extent.zoom}/${tileX}/${tileY}.png`;
```

with:

```ts
        const url = `https://a.basemaps.cartocdn.com/rastertiles/voyager/${extent.zoom}/${tileX}/${tileY}@2x.png`;
```

(No other change in `drawTiles`: the draw call already sizes tiles by the `256 * scale` world footprint, so the 512px retina bitmap simply renders at 2× density.)

- [ ] **Step 4: Tighten the map extent padding**

In `plotExtent` (around lines 95–96), replace:

```ts
  let spanX = (bottomRight.x - topLeft.x) * 1.1;
  let spanY = (bottomRight.y - topLeft.y) * 1.08;
```

with:

```ts
  let spanX = (bottomRight.x - topLeft.x) * 1.02;
  let spanY = (bottomRight.y - topLeft.y) * 1.03;
```

- [ ] **Step 5: Replace `renderPlot` with the new full-frame renderer**

Replace the entire `renderPlot` function (from `async function renderPlot(...)` through its closing brace, currently lines ~191–352) with:

```ts
async function renderPlot(canvas: HTMLCanvasElement, forecast: ForecastPayload, boundary: Boundary, counties: CountyBoundaries, spec: ProductSpec) {
  const width = 900;
  const height = 760;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#0f172a";
  context.font = "700 25px Arial, sans-serif";
  context.fillText(spec.title, 24, 33);
  context.textAlign = "right";
  context.font = "700 14px Arial, sans-serif";
  context.fillText(forecast.days[DAY]?.label ?? "Day 1", 876, 25);
  context.font = "12px Arial, sans-serif";
  context.fillStyle = "#64748b";
  context.fillText(`NWS issued ${formatTime(forecast.updatedAt || forecast.generatedAt)}`, 876, 44);
  context.textAlign = "left";

  const plot = { x: 24, y: 56, width: 852, height: 650 };
  context.fillStyle = "#e6f1f5";
  context.fillRect(plot.x, plot.y, plot.width, plot.height);
  const bounds = boundaryBounds(boundary);
  const extent = plotExtent(bounds, plot.width, plot.height);
  await drawTiles(context, extent, plot.x, plot.y, plot.width, plot.height);

  context.save();
  context.beginPath();
  context.rect(plot.x, plot.y, plot.width, plot.height);
  context.clip();

  context.strokeStyle = "#64748b";
  context.lineWidth = 0.8;
  context.setLineDash([2, 4]);
  for (let lon = Math.ceil(bounds.west * 2) / 2; lon <= bounds.east; lon += 0.5) {
    const a = project(lon, bounds.south - 0.5, extent, plot.x, plot.y, plot.width, plot.height);
    const b = project(lon, bounds.north + 0.5, extent, plot.x, plot.y, plot.width, plot.height);
    context.beginPath(); context.moveTo(...a); context.lineTo(...b); context.stroke();
  }
  for (let lat = Math.ceil(bounds.south * 2) / 2; lat <= bounds.north; lat += 0.5) {
    const a = project(bounds.west - 1, lat, extent, plot.x, plot.y, plot.width, plot.height);
    const b = project(bounds.east + 1, lat, extent, plot.x, plot.y, plot.width, plot.height);
    context.beginPath(); context.moveTo(...a); context.lineTo(...b); context.stroke();
  }
  context.setLineDash([]);

  const points = forecast.points.filter((point) => point.metrics[spec.id][DAY] !== null);
  const raster = document.createElement("canvas");
  raster.width = 760;
  raster.height = 640;
  const rasterContext = raster.getContext("2d")!;
  const image = rasterContext.createImageData(raster.width, raster.height);
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const worldX = extent.left + x / (raster.width - 1) * (extent.right - extent.left);
      const worldY = extent.top + y / (raster.height - 1) * (extent.bottom - extent.top);
      const coordinate = inverseWorld(worldX, worldY, extent.zoom);
      const [red, green, blue] = colorFor(interpolate(points, spec.id, coordinate.lon, coordinate.lat), spec.stops);
      const offset = (y * raster.width + x) * 4;
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = 185;
    }
  }
  rasterContext.putImageData(image, 0, 0);
  context.drawImage(raster, plot.x, plot.y, plot.width, plot.height);

  traceCounties(context, counties, (lon, lat) => project(lon, lat, extent, plot.x, plot.y, plot.width, plot.height));
  context.strokeStyle = "#00000033";
  context.lineWidth = 0.8;
  context.stroke();

  traceBoundary(context, boundary, (lon, lat) => project(lon, lat, extent, plot.x, plot.y, plot.width, plot.height));
  context.strokeStyle = "#102a43";
  context.lineWidth = 2.5;
  context.stroke();
  context.restore();

  context.textAlign = "center";
  for (const point of points.filter((item) => item.label)) {
    const value = point.metrics[spec.id][DAY];
    if (value === null) continue;
    const [x, y] = project(point.lon, point.lat, extent, plot.x, plot.y, plot.width, plot.height);
    const formatted = displayValue(value, spec);
    context.font = "700 14px Arial, sans-serif";
    context.fillStyle = "#ffffff";
    context.strokeStyle = "#111827";
    context.lineWidth = 4;
    context.strokeText(formatted, x, y - 9);
    context.fillText(formatted, x, y - 9);
    context.beginPath(); context.arc(x, y, 3.2, 0, Math.PI * 2); context.fillStyle = "#dc2626"; context.fill(); context.strokeStyle = "#fff"; context.lineWidth = 1.5; context.stroke();
    context.font = "700 9px Arial, sans-serif";
    context.fillStyle = "#fff"; context.strokeStyle = "#111827"; context.lineWidth = 3;
    context.strokeText(point.name, x, y + 12); context.fillText(point.name, x, y + 12);
  }
  context.textAlign = "left";

  if (spec.verticalLegend) {
    const panelX = 36;
    const panelY = 80;
    const panelWidth = 98;
    const panelHeight = 596;
    const barX = 61;
    const barY = 98;
    const barWidth = 20;
    const arrow = 9;
    const colorHeight = 552;
    const bandHeight = colorHeight / spec.stops.length;
    context.fillStyle = "#ffffffe8";
    context.fillRect(panelX, panelY, panelWidth, panelHeight);
    context.save();
    context.translate(50, panelY + panelHeight / 2);
    context.rotate(-Math.PI / 2);
    context.textAlign = "center";
    context.fillStyle = "#111827";
    context.font = "700 10px Arial, sans-serif";
    context.fillText(spec.legend, 0, 0);
    context.restore();
    const reversed = [...spec.stops].reverse();
    reversed.forEach((stop, index) => {
      context.fillStyle = stop.color;
      context.fillRect(barX, barY + arrow + index * bandHeight, barWidth, bandHeight + 0.5);
    });
    context.fillStyle = reversed[0].color;
    context.beginPath(); context.moveTo(barX, barY + arrow); context.lineTo(barX + barWidth / 2, barY); context.lineTo(barX + barWidth, barY + arrow); context.closePath(); context.fill();
    context.fillStyle = reversed.at(-1)!.color;
    const bottomY = barY + arrow + colorHeight;
    context.beginPath(); context.moveTo(barX, bottomY); context.lineTo(barX + barWidth / 2, bottomY + arrow); context.lineTo(barX + barWidth, bottomY); context.closePath(); context.fill();
    context.textAlign = "left";
    context.font = "700 9px Arial, sans-serif";
    context.fillStyle = "#111827";
    reversed.forEach((stop, index) => context.fillText(`${stop.value}°`, barX + barWidth + 6, barY + arrow + (index + 0.64) * bandHeight));
  } else {
    const legendX = 46;
    const legendY = 660;
    const legendWidth = 300;
    context.fillStyle = "#ffffffdf";
    context.fillRect(36, 612, 326, 84);
    context.fillStyle = "#111827";
    context.font = "700 10px Arial, sans-serif";
    context.fillText(spec.legend, legendX, 636);
    const gradient = context.createLinearGradient(legendX, 0, legendX + legendWidth, 0);
    spec.stops.forEach((stop, index) => gradient.addColorStop(index / (spec.stops.length - 1), stop.color));
    context.fillStyle = gradient;
    context.fillRect(legendX, legendY, legendWidth, 12);
    context.font = "9px Arial, sans-serif";
    context.fillStyle = "#111827";
    spec.stops.forEach((stop, index) => context.fillText(String(stop.value), legendX + index / (spec.stops.length - 1) * legendWidth - 4, 685));
  }
  context.strokeStyle = "#0f172a";
  context.lineWidth = 1.5;
  context.strokeRect(plot.x, plot.y, plot.width, plot.height);

  context.fillStyle = "#64748b";
  context.font = "10px Arial, sans-serif";
  context.fillText(`Forecast: NOAA / NWS · ${points.length} PHI grid samples · Counties: US Census · Basemap: CARTO Voyager`, 24, 728);
  context.textAlign = "right";
  context.font = "700 10px Arial, sans-serif";
  context.fillText("PHI FORECAST GRAPHICS", 876, 728);
  context.textAlign = "left";
}
```

- [ ] **Step 6: Thread `counties` through `ForecastPlot`**

Update the `ForecastPlot` component signature and its render effect (around lines 354–363):

```ts
function ForecastPlot({ spec, forecast, boundary, counties }: { spec: ProductSpec; forecast: ForecastPayload; boundary: Boundary; counties: CountyBoundaries }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!canvas.current) return;
    let active = true;
    setReady(false);
    void renderPlot(canvas.current, forecast, boundary, counties, spec).then(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, [forecast, boundary, counties, spec]);
```

- [ ] **Step 7: Fetch and store counties in `ForecastGraphic`**

In `ForecastGraphic`, add county state and fetch. Replace the state declarations (around lines 386–388) and `loadData` (around lines 389–399):

```ts
  const [forecast, setForecast] = useState<ForecastPayload | null>(null);
  const [boundary, setBoundary] = useState<Boundary | null>(null);
  const [counties, setCounties] = useState<CountyBoundaries | null>(null);
  const [error, setError] = useState(false);
  const loadData = useCallback(async () => {
    try {
      const [forecastResponse, boundaryResponse, countyResponse] = await Promise.all([
        fetch("/api/forecast", { cache: "no-store" }),
        fetch("/phi-cwa.geojson"),
        fetch("/counties.geojson"),
      ]);
      if (!forecastResponse.ok || !boundaryResponse.ok || !countyResponse.ok) throw new Error("Data unavailable");
      setForecast(await forecastResponse.json() as ForecastPayload);
      setBoundary(await boundaryResponse.json() as Boundary);
      setCounties(await countyResponse.json() as CountyBoundaries);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
```

- [ ] **Step 8: Pass counties into the gallery**

Update the final render (around line 418). Replace:

```tsx
      {forecast && boundary && <section className="forecast-gallery">{availableProducts.map((spec) => <ForecastPlot key={spec.id} spec={spec} forecast={forecast} boundary={boundary} />)}</section>}
```

with:

```tsx
      {forecast && boundary && counties && <section className="forecast-gallery">{availableProducts.map((spec) => <ForecastPlot key={spec.id} spec={spec} forecast={forecast} boundary={boundary} counties={counties} />)}</section>}
```

- [ ] **Step 9: Type-check and build**

Run: `npm run build`
Expected: build succeeds with no TypeScript errors. (Tests are updated in Task 4; the pre-existing `destination-in` / `const width = 1200` assertions will fail if run now — that is expected and fixed in Task 4.)

- [ ] **Step 10: Commit**

```bash
git add app/components/ForecastGraphic.tsx
git commit -m "Render full-frame temperature field with county and CWA overlays"
```

---

### Task 3: Polish the page shell

**Files:**
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: nothing new. Purely CSS refinement of existing class names.
- Produces: no API surface; visual only.

- [ ] **Step 1: Tighten the gallery to the smaller canvas**

In `app/globals.css`, replace the `.forecast-gallery` rule:

```css
.forecast-gallery { width: min(1560px, 100%); margin: 0 auto; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; align-items: start; }
```

with:

```css
.forecast-gallery { width: min(1200px, 100%); margin: 0 auto; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; align-items: start; }
```

- [ ] **Step 2: Refine card and product-bar styling**

Replace the `.forecast-product` and `.product-bar` rules:

```css
.forecast-product { min-width: 0; border: 1px solid var(--line); background: #fff; box-shadow: 0 8px 24px #20324a12; }
.product-bar { min-height: 62px; display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 11px 13px 10px 16px; border-bottom: 1px solid var(--line); }
```

with:

```css
.forecast-product { min-width: 0; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: #fff; box-shadow: 0 10px 30px #1e293b14, 0 1px 2px #1e293b0f; transition: box-shadow .18s ease; }
.forecast-product:hover { box-shadow: 0 16px 40px #1e293b1f, 0 1px 2px #1e293b14; }
.product-bar { min-height: 58px; display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 10px 12px 10px 16px; border-bottom: 1px solid var(--line); background: linear-gradient(180deg, #fbfcfd, #f4f6f9); }
```

- [ ] **Step 3: Match the header widths to the narrower gallery**

Replace the `.gallery-header` and `.gallery-message` widths:

```css
.gallery-header { width: min(1560px, 100%); margin: 30px auto 22px; display: flex; align-items: end; justify-content: space-between; gap: 28px; }
```

```css
.gallery-message { width: min(1560px, 100%); margin: 0 auto; min-height: 360px; display: grid; place-items: center; border: 1px solid var(--line); color: #536174; background: #fff; font: 600 11px var(--font-geist-mono), monospace; }
```

with (change `1560px` → `1200px` in both):

```css
.gallery-header { width: min(1200px, 100%); margin: 30px auto 22px; display: flex; align-items: end; justify-content: space-between; gap: 28px; }
```

```css
.gallery-message { width: min(1200px, 100%); margin: 0 auto; min-height: 360px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 10px; color: #536174; background: #fff; font: 600 11px var(--font-geist-mono), monospace; }
```

- [ ] **Step 4: Build to confirm CSS compiles**

Run: `npm run build`
Expected: build succeeds (Tailwind v4 compiles `globals.css` with no errors).

- [ ] **Step 5: Commit**

```bash
git add app/globals.css
git commit -m "Polish forecast gallery cards and header spacing"
```

---

### Task 4: Update tests and verify the full result

**Files:**
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: the rewritten `ForecastGraphic.tsx` from Task 2.
- Produces: a green `npm test`.

- [ ] **Step 1: Update the stale component assertions**

In `tests/rendered-html.test.mjs`, in the test "uses official NWS apparent-temperature grid data", replace these two lines:

```js
  assert.match(component, /const width = 1200/);
```
```js
  assert.match(component, /destination-in/);
```

with:

```js
  assert.match(component, /const width = 900/);
```
```js
  assert.match(component, /traceCounties/);
```

- [ ] **Step 2: Add assertions for the new rendering features**

In the same test, after the `assert.match(component, /traceCounties/);` line, add:

```js
  assert.match(component, /rastertiles\/voyager/);
  assert.match(component, /counties\.geojson/);
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: `npm test` runs `npm run build` then `node --test tests/rendered-html.test.mjs`; all tests pass, including the Task 1 county-asset test and the updated component assertions.

- [ ] **Step 4: Visual verification**

Run: `npm run dev` and open the app (default `http://localhost:3000`). Confirm by eye:
- Temperature fill covers the whole frame (no white outside the CWA).
- County lines are visible as thin soft-grey lines; the CWA is a bold dark outline.
- The basemap looks crisp (retina Voyager), not soft.
- Each product card is noticeably more compact than before (900×760).
- City labels, legend, and footer are all inside the frame with no overlap or clipping.

If any pixel offsets look off (legend overlap, labels clipped), nudge the specific constants in `renderPlot` (Task 2, Step 5) and rebuild. Stop the dev server when done.

- [ ] **Step 5: Commit**

```bash
git add tests/rendered-html.test.mjs
git commit -m "Update rendered-html tests for full-frame county graphic"
```

---

## Notes for the implementer

- **Retina tile alignment:** `drawTiles` sizes each tile by `256 * scale` (the Web-Mercator world footprint), independent of the bitmap's pixel dimensions, so swapping to 512px `@2x` tiles needs no math change — only the URL.
- **Layout constants are a set:** the 900×760 values in `renderPlot` (title, plot rect, legend panel, footer) are internally consistent. If you change the canvas size, re-derive all of them together — a leftover 1200/800 constant will misalign the frame.
- **County file weight:** if `public/counties.geojson` comes out larger than ~1 MB, tighten `BBOX` in the prep script or reduce coordinate precision from `1e4` to `1e3` and re-run Task 1.
