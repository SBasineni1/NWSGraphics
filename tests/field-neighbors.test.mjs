import assert from "node:assert/strict";
import test from "node:test";
import { createNeighborIndex } from "../lib/field-neighbors.mjs";

const K = 8;

// The renderer's original full scan, kept verbatim as the reference the index must match.
function bruteForce(points, lon, lat, k) {
  const scale = Math.cos(lat * Math.PI / 180);
  const near = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const dx = (lon - point.lon) * scale;
    const dy = lat - point.lat;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared < 0.000001) return { exact: index, near: [] };
    const insertAt = near.findIndex((neighbor) => distanceSquared < neighbor.distanceSquared);
    if (insertAt === -1) {
      if (near.length < k) near.push({ distanceSquared, index });
    } else {
      near.splice(insertAt, 0, { distanceSquared, index });
      if (near.length > k) near.pop();
    }
  }
  return { exact: -1, near };
}

// Deterministic, so a failure reproduces.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function assertMatches(points, queries) {
  const index = createNeighborIndex(points);
  for (const { lon, lat } of queries) {
    const expected = bruteForce(points, lon, lat, K);
    const actual = index.nearest(lon, lat, K);
    const where = `query ${lon},${lat}`;
    assert.equal(actual.exact, expected.exact, `exact hit differs at ${where}`);
    if (expected.exact !== -1) continue;
    assert.equal(actual.count, expected.near.length, `neighbour count differs at ${where}`);
    for (let slot = 0; slot < expected.near.length; slot += 1) {
      assert.equal(actual.indices[slot], expected.near[slot].index, `slot ${slot} differs at ${where}`);
      // Bit-identical, not approximately equal: the renderer's weights are built from these.
      assert.equal(actual.distances[slot], expected.near[slot].distanceSquared, `distance ${slot} differs at ${where}`);
    }
  }
}

test("matches the full scan on a scattered national-scale set", () => {
  const next = random(1);
  const points = Array.from({ length: 3000 }, () => ({ lon: -125 + next() * 58, lat: 24 + next() * 25 }));
  const queries = Array.from({ length: 2000 }, () => ({ lon: -128 + next() * 64, lat: 21 + next() * 31 }));
  assertMatches(points, queries);
});

test("matches the full scan on a regular lattice, where distance ties are everywhere", () => {
  const points = [];
  for (let row = 0; row < 40; row += 1) {
    for (let column = 0; column < 50; column += 1) points.push({ lon: -100 + column * 0.5, lat: 30 + row * 0.5 });
  }
  const queries = [];
  // Cell centres and edge midpoints sit equidistant from four and two points respectively.
  for (let row = 0; row < 39; row += 3) {
    for (let column = 0; column < 49; column += 3) {
      queries.push({ lon: -100 + column * 0.5 + 0.25, lat: 30 + row * 0.5 + 0.25 });
      queries.push({ lon: -100 + column * 0.5 + 0.25, lat: 30 + row * 0.5 });
    }
  }
  assertMatches(points, queries);
});

test("an exact hit takes the lowest-indexed coincident point", () => {
  const points = [
    { lon: -75, lat: 40 },
    { lon: -74, lat: 40 },
    { lon: -75.0002, lat: 40.0002 },
    { lon: -75, lat: 40 },
  ];
  assertMatches(points, [{ lon: -75, lat: 40 }, { lon: -75.0001, lat: 40.0001 }, { lon: -74, lat: 40 }]);
  assert.equal(createNeighborIndex(points).nearest(-75.0002, 40.0002, K).exact, 0);
});

test("queries far outside the points' box still find the true nearest", () => {
  const next = random(7);
  const points = Array.from({ length: 500 }, () => ({ lon: -90 + next() * 4, lat: 35 + next() * 4 }));
  assertMatches(points, [
    { lon: -140, lat: 60 },
    { lon: -60, lat: 20 },
    { lon: -88, lat: 10 },
    { lon: -70, lat: 37 },
  ]);
});

test("fewer points than neighbours returns them all, and no points returns none", () => {
  const points = [{ lon: -80, lat: 35 }, { lon: -81, lat: 36 }, { lon: -79, lat: 34 }];
  assertMatches(points, [{ lon: -80.5, lat: 35.5 }, { lon: -50, lat: 10 }]);
  const empty = createNeighborIndex([]).nearest(-80, 35, K);
  assert.equal(empty.exact, -1);
  assert.equal(empty.count, 0);
});

test("clustered points with duplicates match the full scan", () => {
  const next = random(42);
  const points = [];
  for (let cluster = 0; cluster < 20; cluster += 1) {
    const lon = -120 + next() * 50;
    const lat = 26 + next() * 20;
    for (let member = 0; member < 30; member += 1) points.push({ lon: lon + next() * 0.3, lat: lat + next() * 0.3 });
    // Two points exactly on top of each other.
    points.push({ lon, lat }, { lon, lat });
  }
  const queries = Array.from({ length: 1500 }, () => ({ lon: -122 + next() * 55, lat: 24 + next() * 25 }));
  queries.push(...points.slice(0, 60).map(({ lon, lat }) => ({ lon, lat })));
  assertMatches(points, queries);
});
