import assert from "node:assert/strict";
import test from "node:test";
import {
  FLAVORS,
  activeSystems,
  contourLines,
  createScenario,
  isobarLevels,
  pressureAt,
  sampleField,
  systemState,
} from "../lib/intro-field.mjs";

const ASPECTS = [0.45, 1.6, 3.2];
const gridFor = (aspect) => [Math.round(60 * Math.max(1, aspect)), Math.round(60 / Math.min(1, aspect))];
const peakTime = (system) => system.born + system.life * system.rise;
const isClosed = (line) => line.length > 3 && line[0][0] === line.at(-1)[0] && line[0][1] === line.at(-1)[1];

function closedRings(scenario, t, aspect) {
  const [nx, ny] = gridFor(aspect);
  const values = sampleField(nx, ny, t, aspect, scenario);
  let lo = Infinity, hi = -Infinity;
  for (const p of values) { lo = Math.min(lo, p); hi = Math.max(hi, p); }
  const rings = isobarLevels(lo, hi).flatMap((level) => contourLines(values, nx, ny, level)).filter(isClosed);
  return { rings, nx, ny };
}

function encloses(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringsAround(scenario, system, aspect) {
  const t = peakTime(system);
  const { x, y } = systemState(system, t);
  const { rings, nx, ny } = closedRings(scenario, t, aspect);
  return rings.filter((ring) => encloses(ring, x * (nx - 1), y * (ny - 1))).length;
}

test("isobarLevels returns the 4 hPa multiples inside the range", () => {
  assert.deepEqual(isobarLevels(997.3, 1021.1), [1000, 1004, 1008, 1012, 1016, 1020]);
});

test("a scenario is fixed by its seed, and seeds reach every flavour", () => {
  assert.deepEqual(createScenario(42), createScenario(42));
  const seen = new Set();
  for (let seed = 1; seed <= 60; seed += 1) seen.add(createScenario(seed).flavor);
  assert.deepEqual([...seen].sort(), [...FLAVORS].sort());
});

test("a system is exactly absent before it forms and after it dies, and strong at its peak", () => {
  for (const flavor of FLAVORS) {
    for (const system of createScenario(7, flavor).systems.slice(0, 12)) {
      assert.equal(systemState(system, system.born).depth, 0);
      assert.equal(systemState(system, system.born + system.life).depth, 0);
      assert.ok(Math.abs(systemState(system, peakTime(system)).depth) >= 12, `${flavor} ${system.kind}`);
      assert.ok(systemState(system, peakTime(system)).radius < systemState(system, system.born + 0.1).radius, "tightens as it deepens");
    }
  }
});

test("every flavour opens calm: no closed isobars at t = 0", () => {
  for (const flavor of FLAVORS) {
    for (const aspect of ASPECTS) {
      assert.equal(closedRings(createScenario(3, flavor), 0, aspect).rings.length, 0, `${flavor} at ${aspect}`);
    }
  }
});

test("each opening system closes rings around itself at its peak, at every aspect", () => {
  for (const flavor of FLAVORS) {
    const scenario = createScenario(11, flavor);
    for (const system of scenario.systems.filter((s) => !s.genesis)) {
      for (const aspect of ASPECTS) {
        assert.ok(ringsAround(scenario, system, aspect) >= 2, `${flavor} ${system.kind} at ${aspect}`);
      }
    }
  }
});

test("random lows can form anywhere across the map, and always travel east", () => {
  const peaks = [];
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    for (const system of createScenario(seed).systems.filter((s) => s.genesis).slice(0, 40)) {
      peaks.push(systemState(system, peakTime(system)).x);
      assert.ok(system.to.x > system.from.x, "travels east");
    }
  }
  assert.ok(peaks.some((x) => x < 0.3), "some form in the west third");
  assert.ok(peaks.some((x) => x > 0.3 && x < 0.7), "some in the middle");
  assert.ok(peaks.some((x) => x > 0.7), "some in the east third");
});

test("randomly formed lows close rings around themselves at their peak", () => {
  for (const seed of [1, 2, 3]) {
    const scenario = createScenario(seed);
    for (const system of scenario.systems.filter((s) => s.genesis).slice(0, 8)) {
      assert.ok(ringsAround(scenario, system, 1.6) >= 2, `seed ${seed} low born ${system.born.toFixed(1)}`);
    }
  }
});

test("a low's centre is the bottom of its own neighbourhood at peak, a high's the top", () => {
  const aspect = 1.6;
  for (const flavor of FLAVORS) {
    const scenario = createScenario(5, flavor);
    for (const system of scenario.systems.slice(0, 6)) {
      const t = peakTime(system), { x, y, radius } = systemState(system, t);
      const centre = pressureAt(x, y, t, aspect, scenario);
      const sign = system.kind === "low" ? 1 : -1;
      for (let j = 0; j <= 60; j++) for (let i = 0; i <= 96; i++) {
        const px = i / 96, py = j / 60;
        if (Math.hypot((px - x) * aspect, py - y) > 1.5 * radius) continue;
        assert.ok(sign * (pressureAt(px, py, t, aspect, scenario) - centre) >= -1, `${flavor} ${system.kind}`);
      }
    }
  }
});

test("lows keep forming for as long as the intro is open, never more than three systems at once", () => {
  for (const seed of [1, 2, 3, 4]) {
    const scenario = createScenario(seed);
    for (let window = 10; window < 900; window += 15) {
      let any = false;
      for (let t = window; t < window + 15; t += 0.5) {
        const active = activeSystems(scenario, t);
        assert.ok(active.length <= 3, `seed ${seed} t ${t}: ${active.length} systems`);
        if (active.length) any = true;
      }
      assert.ok(any, `seed ${seed}: nothing forming in ${window}–${window + 15}s`);
    }
  }
});

// "Lows form randomly" means a visitor actually sees them: after the opening, a mature low
// (one strong enough to own closed rings and an L) should be on the map most of the time.
test("after the opening, a strong low is on the map most of the time", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const scenario = createScenario(seed);
    let strong = 0, samples = 0;
    for (let t = 12; t < 600; t += 0.5, samples += 1) {
      if (activeSystems(scenario, t).some((s) => s.kind === "low" && s.depth <= -12)) strong += 1;
    }
    assert.ok(strong / samples >= 0.6, `seed ${seed}: strong low only ${(100 * strong / samples).toFixed(0)}% of the time`);
  }
});

// The gradient is per frame height, so without a cap an ultrawide frame spans twice the
// pressure range of a laptop's — labels no surface map shows.
test("an ultrawide frame keeps a laptop's pressure range", () => {
  const scenario = createScenario(1);
  const range = (aspect) => {
    const v = sampleField(Math.round(60 * aspect), 60, 0, aspect, scenario);
    let lo = Infinity, hi = -Infinity;
    for (const p of v) { lo = Math.min(lo, p); hi = Math.max(hi, p); }
    return hi - lo;
  };
  assert.ok(range(3.2) <= range(1.6) + 4, `${range(3.2).toFixed(1)} vs ${range(1.6).toFixed(1)}`);
});

test("contourLines traces a radial bowl as one closed ring at the right radius", () => {
  const n = 41, v = new Float64Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) v[j * n + i] = (i - 20) ** 2 + (j - 20) ** 2;
  const lines = contourLines(v, n, n, 100); // radius 10 grid units
  assert.equal(lines.length, 1);
  const ring = lines[0];
  assert.deepEqual(ring[0], ring.at(-1));
  for (const [x, y] of ring) assert.ok(Math.abs(Math.hypot(x - 20, y - 20) - 10) < 0.15);
  for (let k = 1; k < ring.length; k++) {
    assert.ok(Math.hypot(ring[k][0] - ring[k - 1][0], ring[k][1] - ring[k - 1][1]) <= Math.SQRT2 + 1e-9, "no gaps");
  }
});

test("contourLines handles saddles and edge-touching lines without throwing", () => {
  const v = new Float64Array([0, 1, 1, 0]); // 2x2 saddle
  const lines = contourLines(v, 2, 2, 0.5);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.equal(line.length, 2);
});
