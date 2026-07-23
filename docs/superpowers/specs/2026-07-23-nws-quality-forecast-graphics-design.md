# NWS-Quality Forecast Graphics — Design

**Date:** 2026-07-23
**Status:** Approved (pending spec review)

## Problem

The PHI forecast graphics render interpolated NWS gridpoint temperatures onto CARTO
`light_all` basemap tiles, but the current output reads as low-craft:

1. The temperature raster is hard-clipped to the CWA polygon, so everything outside the
   Philadelphia/Mount Holly forecast area is blank white — the surrounding region
   disappears.
2. There are no county boundaries, so the map lacks the geographic reference the real
   NWS product provides.
3. Plots are rendered at a fixed oversized 1200×800 landscape, sprawling on the page.
4. Overall styling (basemap sharpness, page chrome, legend) looks templated.

The goal: match the polish of the official NWS Mount Holly "Highs" product — a
Mapbox-quality static, downloadable graphic where the temperature field covers the whole
frame with county + CWA boundaries drawn on top.

## Decisions (from brainstorming)

- **Static, Mapbox-styled** graphic — keep the existing static/PNG-export canvas approach.
  No interactive map, no Mapbox/MapLibre GL, no access token.
- **Fill the whole frame** with the temperature field (like NWS image 2). Emphasize the
  CWA with a bold outline, not by clipping. County lines overlaid on top.
- **Tighter frame + smaller cards** — reduce map padding and canvas size, shrink gallery
  cards.

## Scope

**In scope:** client-side canvas rendering (`app/components/ForecastGraphic.tsx`), page
styling (`app/globals.css`), a bundled `public/counties.geojson` asset + its prep script,
and test updates.

**Out of scope (YAGNI):** interactivity/pan-zoom, Mapbox or MapLibre GL, access tokens,
new forecast products, any change to `/api/forecast` or the data model, auto color-range
scaling, per-day (multi-day) rendering.

## Reference geometry

CWA bounds (from `public/phi-cwa.geojson`):
`W −76.44, E −73.97, S 38.45, N 41.36` — roughly square, slightly taller than wide.

## Design

### 1. Rendering model (core change)

Modify `renderPlot()` in `app/components/ForecastGraphic.tsx`:

- **Remove the CWA clip on the temperature raster.** Today the raster uses
  `globalCompositeOperation = "destination-in"` + `traceBoundary(...CWA...)` to keep only
  the CWA interior. Delete that clip so the interpolated field renders edge-to-edge across
  the full map extent.
- **Semi-transparent temperature fill.** Keep the raster alpha in the ~`0.70–0.75` range
  (currently `210/255 ≈ 0.82`; lower slightly to ~`185/255`) so the basemap reads through
  and the fill has depth rather than looking like flat blocks.
- **County lines.** After drawing the temperature fill and before the CWA outline, trace
  `counties.geojson` and stroke thin lines: `lineWidth ≈ 0.8`, `strokeStyle = "#00000033"`
  (soft black). Clip county drawing to the plot rect (reuse the existing `context.clip()`
  region).
- **Bold CWA outline** stays on top: dark navy (`#102a43`), `lineWidth ≈ 2.5`.
- **Basemap upgrade.** In `drawTiles()`, switch the tile URL from
  `light_all/{z}/{x}/{y}.png` to CARTO **Voyager retina**:
  `https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png`. The `@2x` tiles
  are 512px; draw them at the same map footprint (256px world size) so they render at 2×
  density. Keep the neutral fallback fill for offline/failed tiles.

Draw order (bottom → top): background fill → basemap tiles → 0.5° graticule (existing) →
temperature raster (full frame, semi-transparent) → county lines → CWA outline → city
dots/labels → legend panel → frame border → footer credits.

### 2. Sizing — tighter frame + smaller cards

- **Tighter extent.** In `plotExtent()`, reduce the padding multipliers from `1.1`/`1.08`
  to approximately `1.0`/`1.03` so the CWA fills more of the frame with less dead margin.
- **Compact canvas.** Reduce the canvas from `1200×800` to approximately **`900×760`**
  (portrait-leaning, closer to the NWS product's proportions). Recompute the internal
  layout constants (`plot` rect, legend panel coordinates, title/footer positions) to the
  new dimensions — these are currently hard-coded for 1200×800 and must all be updated
  consistently.
- **Smaller gallery cards.** In `app/globals.css`, reduce `.forecast-gallery`
  `max-width` / column sizing so cards don't sprawl. Preserve the responsive
  2-column → 1-column breakpoints.

### 3. County data prep

- Add a one-time prep script (e.g. `scripts/build-counties.mjs`) that:
  1. Fetches the FIPS-keyed US counties GeoJSON from
     `https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json`.
  2. Filters features to state FIPS prefixes: **34 (NJ), 42 (PA), 10 (DE), 24 (MD),
     36 (NY), 51 (VA)** — the states that intersect the frame.
  3. Clips to a bbox slightly larger than the render extent (approx
     `W −77.5, E −73.0, S 37.8, N 42.2`) to drop far-away counties and shrink the file.
  4. Writes `public/counties.geojson`.
- The script runs once; its output `public/counties.geojson` is committed as a static
  asset. No runtime dependency on the plotly source.
- `ForecastGraphic` fetches `/counties.geojson` alongside `/phi-cwa.geojson` in
  `loadData()` and passes it into `renderPlot()`.

### 4. Page-shell polish

Refine `app/globals.css` (structure unchanged — craft only):

- Tighten nav + header typography and spacing.
- Refine `.forecast-product` card and `.product-bar` (borders, shadow, radius) so cards
  read as intentional.
- Improve the legend panel treatment for legibility over the now full-frame fill.

### 5. Testing

- Extend `tests/rendered-html.test.mjs` so the build + render path stays green and, where
  feasible, assert the page references the counties asset.
- Verify `public/counties.geojson` exists and is valid GeoJSON with the expected states.
- Final canvas appearance verified by build + visual check.

## Risks / notes

- **County file size.** Full-resolution county polygons for 6 states may be large; the
  bbox clip and (if needed) coordinate rounding keep `counties.geojson` reasonable. Target
  well under ~1 MB.
- **Retina tile alignment.** `@2x` tiles are 512px but occupy the same 256px world
  footprint; `drawTiles()` must scale by the world footprint, not the pixel size, or tiles
  will misalign. This is a one-line care point in the draw call.
- **Layout constants.** Moving from 1200×800 to 900×760 touches many hard-coded pixel
  offsets (legend panel, title, footer, city label sizes). All must be updated together;
  leftover 1200/800 constants will break alignment.
