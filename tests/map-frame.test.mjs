import assert from "node:assert/strict";
import test from "node:test";

import { coordinateBounds, fitZoom, plotExtent, PLOT_WIDTH, MAP_HEIGHT } from "../lib/map-frame.mjs";

test("bounds of a simple ring", () => {
  const bounds = coordinateBounds([[[-75, 39], [-74, 39], [-74, 40], [-75, 40], [-75, 39]]]);
  assert.deepEqual(bounds, { west: -75, south: 39, east: -74, north: 40 });
});

test("bounds survive a ring larger than the engine's argument limit", () => {
  // `Math.min(...lons)` throws RangeError past ~65k arguments, and an unsimplified CWA
  // ring runs to 60k+ vertices. This is the case that actually broke.
  const ring = Array.from({ length: 200_000 }, (_, i) => [-80 + (i % 1000) / 1000, 35 + (i % 500) / 1000]);
  const bounds = coordinateBounds([ring]);
  assert.ok(Number.isFinite(bounds.west) && Number.isFinite(bounds.east));
  assert.ok(bounds.west >= -80 && bounds.east <= -79);
});

test("an area crossing the antimeridian is measured the short way round", () => {
  // Alaska's CWA runs from the mainland across 180° into the Aleutians. Naive min/max
  // over longitude calls that a 359°-wide area — it is really ~20° wide the other way.
  const aleutians = [[[170, 52], [179, 52], [-179, 52], [-172, 52], [-172, 54], [170, 54], [170, 52]]];
  const bounds = coordinateBounds(aleutians);
  const span = bounds.east - bounds.west;
  assert.ok(span > 0 && span < 30, `expected a short span, got ${span}`);
  // East is allowed past 180 — that is what keeps the range continuous.
  assert.ok(bounds.east > 180, `expected east past the dateline, got ${bounds.east}`);
  assert.equal(bounds.west, 170);
});

test("an ordinary area is unaffected by the antimeridian handling", () => {
  // Every current office is well inside one hemisphere; the unwrapped reading must not
  // win for them or all four maps would silently move.
  const phi = [[[-76.1, 38.9], [-73.9, 38.9], [-73.9, 41.2], [-76.1, 41.2], [-76.1, 38.9]]];
  assert.deepEqual(coordinateBounds(phi), { west: -76.1, south: 38.9, east: -73.9, north: 41.2 });
});

test("a western-hemisphere area never shifts, however the float arithmetic lands", () => {
  // Adding 360 to a longitude near -76 costs low-order precision, so the shifted span can
  // measure a few ulps *under* the direct one. Comparing spans alone let that win and
  // moved PHI's frame to 283..286, which put every city label off the canvas. Swept
  // across the CONUS longitudes so it can't pass by luck on one value.
  for (let west = -125; west <= -68; west += 0.37) {
    const bounds = coordinateBounds([[[west, 30], [west + 2.47, 30], [west + 2.47, 33], [west, 33], [west, 30]]]);
    assert.ok(bounds.east <= 0, `${west.toFixed(2)} shifted to ${bounds.west}..${bounds.east}`);
  }
});

test("a whole-world extent is not mistaken for a dateline crossing", () => {
  const world = [[[-180, -60], [180, -60], [180, 70], [-180, 70], [-180, -60]]];
  const bounds = coordinateBounds(world);
  assert.equal(bounds.west, -180);
  assert.equal(bounds.east, 180);
});

test("zoom is chosen so the frame is about one canvas wide", () => {
  // A ~2.7° office and a ~14° one cannot share a zoom: at a fixed 7 the first upscales a
  // single tile across 900px and the second pulls dozens and throws most away.
  const small = fitZoom({ west: -78, east: -75.3, south: 33.5, north: 36.2 });
  const large = fitZoom({ west: -141, east: -127, south: 55, north: 60 });
  assert.ok(small > large, `expected a smaller area to zoom in further (${small} vs ${large})`);
  for (const zoom of [small, large]) {
    assert.ok(Number.isInteger(zoom), `zoom must be an integer tile level, got ${zoom}`);
    assert.ok(zoom >= 1 && zoom <= 12, `zoom ${zoom} out of range`);
  }
});

test("the chosen zoom keeps the tile count bounded for every real office shape", () => {
  // AFC at a fixed zoom 7 needed 14,541 tiles. Whatever the shape, one map should cost
  // tens of tiles, not thousands.
  const shapes = [
    { west: -76.1, east: -73.9, south: 38.9, north: 41.2 },   // PHI
    { west: -141, east: -129, south: 54, north: 60 },          // AJK, large
    { west: 170, east: 200, south: 51, north: 72 },            // AFC, unwrapped
    { west: -97.6, east: -95.3, south: 25.8, north: 27.5 },    // BRO, small
  ];
  for (const bounds of shapes) {
    const extent = plotExtent(bounds, PLOT_WIDTH, MAP_HEIGHT, fitZoom(bounds));
    const tiles =
      (Math.floor(extent.right / 256) - Math.floor(extent.left / 256) + 1) *
      (Math.floor(extent.bottom / 256) - Math.floor(extent.top / 256) + 1);
    assert.ok(tiles <= 40, `${JSON.stringify(bounds)} needs ${tiles} tiles`);
  }
});
