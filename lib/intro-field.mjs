// The invented surface-pressure field behind the weather intro (WeatherIntro.tsx), and the
// marching-squares contouring that turns it into isobars.
//
// Nothing here is a forecast. A *scenario* is a calm background — gently curved, roughly
// parallel isobars that drift slowly — plus pressure systems that form, deepen, travel and
// fill. Each visit picks one of a few scripted openings (a classic passing low, twin lows, a
// rapidly deepening "bomb", a high beside a low), and after that new lows keep forming at
// random, as they would on a loop of real surface analyses. A scenario is fixed by its seed,
// so the tests can pin exactly what a visitor could see.
//
// Coordinates are normalised to the frame: `x` runs 0→1 west→east across the width, `y`
// 0→1 north→south down the height, and `aspect` is width / height. A system's radius is in
// units of the frame's shorter side, so it stays round and whole on any screen.
//
// Plain `.mjs` like map-frame.mjs, so Node can test it directly
// (`tests/intro-field.test.mjs`).

/** Isobar spacing in hPa, as on a WPC surface analysis. */
export const ISOBAR_STEP = 4;

/** The scripted openings a visit can draw. */
export const FLAVORS = Object.freeze(["classic", "twin", "bomb", "highlow"]);

const BASE_PRESSURE = 1012;

// Background: a broad rise toward the south-west plus two slow travelling waves. The waves'
// combined slope stays well under the gradient's, which is what keeps the calm frame free of
// closed isobars (a local extremum needs the wave to overturn the gradient somewhere).
const GRADIENT = 26; // hPa per frame-height unit, at mid-frame
// The gradient slackens toward the east: isobars bunch behind the headline and open out
// where systems form, which lets them close more rings at a readable size.
const GRADIENT_EASING = 0.5;
// Past this aspect the background is compressed horizontally rather than extended, so an
// ultrawide frame shows a laptop's pressure range spread wider, not a continent's worth of
// isobars. Compressing only stretches the existing pattern: it cannot create a closed ring.
const WIDEST_BACKGROUND_ASPECT = 1.6;
const GRADIENT_ANGLE = Math.PI * 0.8; // direction of increase: toward the lower left
const WAVES = [
  { amplitude: 2.4, kx: 4.1, ky: 1.4, speed: 0.11, phase: 0.3 },
  { amplitude: 1.1, kx: -1.6, ky: 4.6, speed: -0.07, phase: 1.9 },
];

// Random genesis, after the opening. A gap of at least GAP_MIN against a life of at most
// GAP_MIN × 3 keeps no more than three of these alive at once, so the map never turns to mush.
// Each holds at full strength for a stretch of its life, so a low is usually on the map rather
// than only flickering through its peak.
const GENESIS_START = 9;
const GENESIS_END = 3600; // an hour; nothing new forms after that, the background drifts on
const GENESIS_GAP_MIN = 4.5;
const GENESIS_GAP_SPREAD = 2.5;
const GENESIS_LIFE_MIN = 9;
const GENESIS_LIFE_SPREAD = 4;
const GENESIS_HOLD = 0.25; // fraction of a life spent mature

/**
 * @typedef {{ x: number, y: number }} XY
 * @typedef {{
 *   kind: "low" | "high", genesis: boolean, born: number, life: number, rise: number,
 *   fall?: number, from: XY, to: XY, depth: number, radiusCalm: number, radiusPeak: number,
 * }} PressureSystem
 *   `depth` is the signed peak anomaly in hPa (negative for a low). `rise` is the fraction of
 *   its life at which it reaches full strength — so a bomb can deepen fast and fill slowly —
 *   and `fall` (default `rise`) the fraction at which it starts to fill.
 * @typedef {{ seed: number, flavor: string, systems: PressureSystem[], showcase: number }} Scenario
 *   `showcase` is the moment that best shows the opening, used as the still frame under
 *   reduced motion.
 * @typedef {{ kind: "low" | "high", x: number, y: number, depth: number, radius: number }} SystemState
 */

/** @type {Record<string, { showcase: number, systems: Array<Omit<PressureSystem, "genesis">> }>} */
const OPENINGS = {
  classic: {
    showcase: 4.5,
    systems: [
      { kind: "low", born: 1, life: 7, rise: 0.5, from: { x: 0, y: 0.62 }, to: { x: 1.32, y: 0.22 }, depth: -20, radiusCalm: 0.26, radiusPeak: 0.15 },
    ],
  },
  twin: {
    showcase: 5.4,
    systems: [
      { kind: "low", born: 0.8, life: 7.5, rise: 0.45, from: { x: 0.5, y: 0.55 }, to: { x: 1.1, y: 0 }, depth: -18, radiusCalm: 0.24, radiusPeak: 0.13 },
      { kind: "low", born: 2.8, life: 7.5, rise: 0.5, from: { x: 0.42, y: 1.05 }, to: { x: 1.08, y: 0.55 }, depth: -18, radiusCalm: 0.24, radiusPeak: 0.13 },
    ],
  },
  bomb: {
    showcase: 3.8,
    systems: [
      { kind: "low", born: 1, life: 7.5, rise: 0.35, from: { x: 0.62, y: 1 }, to: { x: 0.86, y: 0 }, depth: -28, radiusCalm: 0.24, radiusPeak: 0.12 },
    ],
  },
  highlow: {
    showcase: 4.7,
    systems: [
      { kind: "high", born: 0.4, life: 13, rise: 0.4, from: { x: 0.74, y: 0.3 }, to: { x: 0.86, y: 0.36 }, depth: 14, radiusCalm: 0.26, radiusPeak: 0.17 },
      { kind: "low", born: 1.2, life: 7, rise: 0.5, from: { x: 0.1, y: 0.95 }, to: { x: 1.3, y: 0.6 }, depth: -18, radiusCalm: 0.25, radiusPeak: 0.14 },
    ],
  },
};

/**
 * A complete intro: one scripted opening, then randomly forming lows. Fixed by `seed`.
 * @param {number} seed any integer
 * @param {string} [flavor] force an opening (tests, debugging); otherwise the seed picks one
 * @returns {Scenario}
 */
export function createScenario(seed, flavor) {
  const random = mulberry32(seed);
  const chosen = flavor ?? FLAVORS[Math.floor(random() * FLAVORS.length)];
  const opening = OPENINGS[chosen];
  if (!opening) throw new Error(`Unknown intro flavour: ${chosen}`);
  /** @type {PressureSystem[]} */
  const systems = opening.systems.map((system) => ({ ...system, genesis: false }));
  for (let born = GENESIS_START + random() * 2; born < GENESIS_END; born += GENESIS_GAP_MIN + random() * GENESIS_GAP_SPREAD) {
    systems.push(genesisLow(random, born));
  }
  return { seed, flavor: chosen, systems, showcase: opening.showcase };
}

/**
 * A system's position, strength and size at time `t`.
 * @param {PressureSystem} system
 * @param {number} t seconds since the intro began
 * @returns {SystemState}
 */
export function systemState(system, t) {
  const progress = (t - system.born) / system.life;
  const clamped = Math.min(1, Math.max(0, progress));
  const x = system.from.x + (system.to.x - system.from.x) * clamped;
  const y = system.from.y + (system.to.y - system.from.y) * clamped;
  // Smooth at both ends and into and out of maturity: sin² up to `rise`, full strength to
  // `fall`, cos² back down. Exactly zero outside the life — not a float that rounds to it —
  // so "absent" is absent.
  const fall = system.fall ?? system.rise;
  let envelope = 0;
  // Compared on `t` itself: (born + life − born) / life can land a hair under 1.
  if (t > system.born && t < system.born + system.life) {
    if (progress < system.rise) envelope = Math.sin((Math.PI / 2) * (progress / system.rise)) ** 2;
    else if (progress <= fall) envelope = 1;
    else envelope = Math.cos((Math.PI / 2) * ((progress - fall) / (1 - fall))) ** 2;
  }
  const depth = envelope === 0 ? 0 : system.depth * envelope;
  const radius = system.radiusCalm - (system.radiusCalm - system.radiusPeak) * envelope;
  return { kind: system.kind, x, y, depth, radius };
}

/**
 * The systems alive at time `t`, with their current state.
 * @param {Scenario} scenario
 * @param {number} t
 * @returns {SystemState[]}
 */
export function activeSystems(scenario, t) {
  const active = [];
  for (const system of scenario.systems) {
    if (system.born >= t) {
      if (system.genesis) break; // genesis lows are in birth order: none later is alive yet
      continue;
    }
    if (system.born + system.life <= t) continue;
    active.push(systemState(system, t));
  }
  return active;
}

/**
 * Pressure in hPa at a normalised point.
 * @param {number} x
 * @param {number} y
 * @param {number} t seconds
 * @param {number} aspect width / height
 * @param {Scenario} scenario
 */
export function pressureAt(x, y, t, aspect, scenario) {
  let p = backgroundAt(x * backgroundWidth(aspect), y, t, x);
  for (const system of activeSystems(scenario, t)) p += systemTerm(system, x, y, aspect);
  return p;
}

/**
 * Sample the field on an `nx` × `ny` lattice spanning the frame, row-major
 * (`j * nx + i` at `(i / (nx - 1), j / (ny - 1))`).
 * @param {number} nx
 * @param {number} ny
 * @param {number} t
 * @param {number} aspect
 * @param {Scenario} scenario
 * @param {Float64Array} [into] reused buffer of length nx × ny, to spare a per-frame allocation
 * @returns {Float64Array}
 */
export function sampleField(nx, ny, t, aspect, scenario, into) {
  const values = into && into.length === nx * ny ? into : new Float64Array(nx * ny);
  const systems = activeSystems(scenario, t);
  const width = backgroundWidth(aspect);
  for (let j = 0; j < ny; j += 1) {
    const y = j / (ny - 1);
    for (let i = 0; i < nx; i += 1) {
      const x = i / (nx - 1);
      let p = backgroundAt(x * width, y, t, x);
      for (const system of systems) p += systemTerm(system, x, y, aspect);
      values[j * nx + i] = p;
    }
  }
  return values;
}

/**
 * The multiples of `step` strictly inside (min, max), ascending.
 * @param {number} min
 * @param {number} max
 * @param {number} [step]
 * @returns {number[]}
 */
export function isobarLevels(min, max, step = ISOBAR_STEP) {
  const levels = [];
  for (let k = Math.floor(min / step) + 1; k * step < max; k += 1) levels.push(k * step);
  return levels;
}

/**
 * Marching squares: the `level` isoline of a row-major lattice, chained into polylines in
 * grid units (`0..nx-1`, `0..ny-1`). A closed ring repeats its first point last.
 *
 * Crossings are keyed by the lattice edge they sit on, so two cells sharing an edge share
 * the identical point and chaining is exact — no tolerance matching of coordinates.
 *
 * @param {Float64Array} values
 * @param {number} nx
 * @param {number} ny
 * @param {number} level
 * @returns {Array<Array<[number, number]>>}
 */
export function contourLines(values, nx, ny, level) {
  // Edge ids: horizontal (i,j)→(i+1,j) first, then vertical (i,j)→(i,j+1).
  const verticalBase = (nx - 1) * ny;
  /** @type {Map<number, [number, number]>} */
  const points = new Map();
  /** @type {Map<number, number[]>} */
  const links = new Map();

  const crossing = (id, i0, j0, i1, j1) => {
    if (!points.has(id)) {
      const v0 = values[j0 * nx + i0];
      const v1 = values[j1 * nx + i1];
      const s = v1 === v0 ? 0.5 : (level - v0) / (v1 - v0);
      points.set(id, [i0 + (i1 - i0) * s, j0 + (j1 - j0) * s]);
    }
    return id;
  };
  const link = (a, b) => {
    const la = links.get(a);
    if (la) la.push(b); else links.set(a, [b]);
    const lb = links.get(b);
    if (lb) lb.push(a); else links.set(b, [a]);
  };

  for (let j = 0; j < ny - 1; j += 1) {
    for (let i = 0; i < nx - 1; i += 1) {
      const a = values[j * nx + i] >= level; // top-left
      const b = values[j * nx + i + 1] >= level; // top-right
      const c = values[(j + 1) * nx + i + 1] >= level; // bottom-right
      const d = values[(j + 1) * nx + i] >= level; // bottom-left
      if (a === b && b === c && c === d) continue;

      const top = () => crossing(j * (nx - 1) + i, i, j, i + 1, j);
      const bottom = () => crossing((j + 1) * (nx - 1) + i, i, j + 1, i + 1, j + 1);
      const left = () => crossing(verticalBase + j * nx + i, i, j, i, j + 1);
      const right = () => crossing(verticalBase + j * nx + i + 1, i + 1, j, i + 1, j + 1);

      if (a === c && b === d) {
        // Saddle: the cell-centre average decides which pair of corners is joined.
        const centre = (values[j * nx + i] + values[j * nx + i + 1]
          + values[(j + 1) * nx + i + 1] + values[(j + 1) * nx + i]) / 4 >= level;
        if (centre === a) {
          // a and c connect through the middle: cut off b and d.
          link(top(), right());
          link(bottom(), left());
        } else {
          link(top(), left());
          link(right(), bottom());
        }
        continue;
      }

      /** @type {number[]} */
      const crossed = [];
      if (a !== b) crossed.push(top());
      if (b !== c) crossed.push(right());
      if (c !== d) crossed.push(bottom());
      if (d !== a) crossed.push(left());
      link(crossed[0], crossed[1]);
    }
  }

  /** @type {Set<number>} */
  const visited = new Set();
  /** @type {Array<Array<[number, number]>>} */
  const lines = [];
  const walk = (start) => {
    const ids = [start];
    visited.add(start);
    let current = start;
    for (;;) {
      const next = (links.get(current) ?? []).find((id) => !visited.has(id));
      if (next === undefined) break;
      visited.add(next);
      ids.push(next);
      current = next;
    }
    const line = ids.map((id) => /** @type {[number, number]} */ (points.get(id)));
    const closed = ids.length > 2 && (links.get(current) ?? []).includes(start);
    if (closed) line.push(line[0]);
    lines.push(line);
  };

  // Open lines first, from an end (an edge on the lattice boundary links once), so each is
  // walked whole; whatever remains unvisited is a ring.
  for (const [id, neighbours] of links) if (neighbours.length === 1 && !visited.has(id)) walk(id);
  for (const id of links.keys()) if (!visited.has(id)) walk(id);
  return lines;
}

/** The frame's width in frame-height units as the background sees it. */
function backgroundWidth(aspect) {
  return Math.min(aspect, WIDEST_BACKGROUND_ASPECT);
}

/** Background pressure; `X` is in frame-height units (see backgroundWidth), `x` normalised. */
function backgroundAt(X, Y, t, x) {
  const along = Math.cos(GRADIENT_ANGLE) * (X - 0.8) + Math.sin(GRADIENT_ANGLE) * (Y - 0.5);
  let p = BASE_PRESSURE + GRADIENT * (1 + GRADIENT_EASING * (0.5 - x)) * along;
  for (const w of WAVES) p += w.amplitude * Math.sin(w.kx * X + w.ky * Y - w.speed * t * Math.PI * 2 + w.phase);
  return p;
}

/** @param {SystemState} system */
function systemTerm(system, x, y, aspect) {
  const dx = (x - system.x) * aspect;
  const dy = y - system.y;
  // Sized to the frame's shorter side, so a portrait phone still fits whole rings across.
  const r = system.radius * Math.min(1, aspect);
  return system.depth * Math.exp(-(dx * dx + dy * dy) / (r * r));
}

/**
 * One randomly forming low. It can form anywhere on the map — one passing behind the headline
 * simply shows its rings there, without an L — and always travels east-ish, from north-east
 * to just south of east, as mid-latitude lows do.
 * @param {() => number} random
 * @param {number} born
 * @returns {PressureSystem}
 */
function genesisLow(random, born) {
  const life = GENESIS_LIFE_MIN + random() * GENESIS_LIFE_SPREAD;
  const rise = 0.25 + random() * 0.15;
  const fall = rise + GENESIS_HOLD;
  const peak = { x: 0.12 + random() * 0.76, y: 0.22 + random() * 0.56 };
  const heading = (-0.45 + random() * 0.5) * Math.PI; // from north-east to just south of east
  const travel = 0.25 + random() * 0.3;
  const dx = Math.cos(heading) * travel;
  const dy = Math.sin(heading) * travel;
  const radiusPeak = 0.12 + random() * 0.04;
  return {
    kind: "low",
    genesis: true,
    born,
    life,
    rise,
    fall,
    from: { x: peak.x - dx * rise, y: peak.y - dy * rise },
    to: { x: peak.x + dx * (1 - rise), y: peak.y + dy * (1 - rise) },
    depth: -(16 + random() * 8),
    radiusCalm: radiusPeak + 0.1,
    radiusPeak,
  };
}

/** Small, fast, seedable PRNG (mulberry32): the same seed always yields the same intro. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
