import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MAP_HEIGHT, PLOT_WIDTH, plotExtent, worldPoint } from "../lib/map-frame.mjs";
import { MESO_STEP_KM, buildMesoLattice } from "../lib/meso-lattice.mjs";

const bundleOf = (view) => JSON.parse(readFileSync(new URL(`../public/offices/${view}.json`, import.meta.url), "utf8"));
const US = bundleOf("US");
const us = buildMesoLattice(US);

// Great-circle distance, km.
function kilometres(a, b) {
  const toRadians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRadians;
  const dLon = (b.lon - a.lon) * toRadians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRadians) * Math.cos(b.lat * toRadians) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}

test("every point sits within one step of the canvas frame", () => {
  const extent = plotExtent(US.bounds, PLOT_WIDTH, MAP_HEIGHT, US.zoom);
  const slack = us.step * 1.001;
  for (const point of us.points) {
    const { x, y } = worldPoint(point.lon, point.lat, extent.zoom);
    assert.ok(x >= extent.left - slack && x <= extent.right + slack, `${point.id} is off the frame horizontally`);
    assert.ok(y >= extent.top - slack && y <= extent.bottom + slack, `${point.id} is off the frame vertically`);
  }
});

test("neighbouring points are 40 km apart at the frame's middle latitude", () => {
  const byId = new Map(us.points.map((point) => [point.id, point]));
  const middleRow = Math.floor(us.rows / 2);
  const spacings = [];
  for (let column = 0; column < us.columns - 1; column += 1) {
    const a = byId.get(`meso-US-${column}-${middleRow}`);
    const b = byId.get(`meso-US-${column + 1}-${middleRow}`);
    if (a && b) spacings.push(kilometres(a, b));
  }
  assert.ok(spacings.length > 20, "expected a run of land points across the middle row");
  for (const spacing of spacings) assert.ok(Math.abs(spacing - MESO_STEP_KM) / MESO_STEP_KM < 0.1, `spacing ${spacing.toFixed(1)} km`);
});

test("open ocean is dropped, but the first row offshore is kept", () => {
  const nearest = (lon, lat) => Math.min(...us.points.map((point) => kilometres(point, { lon, lat })));
  // Mid-Atlantic Ocean, Gulf of Mexico centre, and the Pacific well off California.
  for (const [lon, lat] of [[-66, 32], [-90, 25.5], [-128, 34]]) {
    assert.ok(nearest(lon, lat) > 2 * MESO_STEP_KM, `a point was kept near open water at ${lon},${lat}`);
  }
  // Just off Cape Hatteras and off the Jersey Shore: inside the one-step buffer.
  for (const [lon, lat] of [[-75.3, 35.2], [-73.8, 39.6]]) {
    assert.ok(nearest(lon, lat) < MESO_STEP_KM, `the coastal buffer is missing at ${lon},${lat}`);
  }
});

test("the national lattice is far denser than the forecast lattice it replaces", () => {
  const forecast = JSON.parse(readFileSync(new URL("../public/gridpoints/US.json", import.meta.url), "utf8"));
  assert.ok(us.points.length > 4 * forecast.length, `${us.points.length} vs ${forecast.length}`);
});

test("ids are unique and stable across builds", () => {
  assert.equal(new Set(us.points.map((point) => point.id)).size, us.points.length);
  assert.deepEqual(buildMesoLattice(bundleOf("MA")).points.slice(0, 5), buildMesoLattice(bundleOf("MA")).points.slice(0, 5));
});

test("the committed lattice files are what the builder produces", () => {
  // A changed frame in lib/areas.mjs without a rebuild would leave the pipeline sampling a
  // stale grid. MA stands in for the rest; US is covered above.
  const committed = JSON.parse(readFileSync(new URL("../public/meso-lattice/MA.json", import.meta.url), "utf8"));
  assert.deepEqual(committed, buildMesoLattice(bundleOf("MA")).points);
});
