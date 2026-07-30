import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { targetsFor } from "../lib/areas.mjs";
import { frameBounds } from "../lib/map-frame.mjs";

// Resolves each office's interpolation lattice to the NWS gridpoints that feed it, and
// writes public/gridpoints/{OFFICE}.json.
//
//   node scripts/build-office-gridpoints.mjs [--dry-run] [--only PHI,OKX]
//
// `--dry-run` reports the sample counts without touching the network — worth running
// first, because the real pass is tens of thousands of api.weather.gov lookups.
//
// Two densities, as before: full resolution inside the County Warning Area where the
// forecast actually matters, and a sparse ring out to the frame edges so the field has
// something real to interpolate toward instead of smearing the nearest CWA value into the
// corner of the canvas.
//
// **The step scales with the frame, it is not fixed.** The original 0.22° was tuned for a
// ~3° mid-Atlantic frame; AFC's frame is 46° wide, where that step means ~11,500 samples
// for one office. Sampling a fixed *count* per frame instead keeps every office at a
// comparable cost and a comparable field resolution, which is what the renderer wants —
// the lattice is upsampled to the same 900×760 canvas either way.

const USER_AGENT = "NWS Forecast Graphics (github.com/suchitbasineni/NWSGraphics)";
// Columns of fine samples across a frame. 26 lands ~250 gridpoints per office, matching
// the 264 PHI was built and tuned at — measured, not guessed: 18 gave 123 and would have
// halved the field resolution of the existing maps.
const FINE_COLUMNS = 26;
// The buffer ring outside the CWA is sampled at half the density; it only exists to give
// the interpolation something to lean on past the boundary.
const COARSE_FACTOR = 2;
// Points just past a frame edge still pull their weight: without them the interpolation
// along the canvas border has neighbours on one side only.
const MARGIN_FRACTION = 0.06;
const CONCURRENCY = 12;
const RETRIES = 3;

// Every office's frame is finally filled from the *national* set of resolved gridpoints,
// not just the samples that office happened to issue. Neighbouring offices sample their
// own CWAs at full density, and those points sit inside this office's buffer ring — the
// old shared-lattice build got this for free by sampling "inside any CWA" at the fine
// step, which is why its buffer was dense. Sampling each office in isolation made the
// ring a quarter as dense as the middle, and inverse-distance weighting turns that into
// visible bullseyes over the sparse half of the map.
//
// The points are then thinned onto a uniform grid: even coverage is what the
// interpolation wants, and it bounds the per-office fetch cost, which is one
// api.weather.gov request per point on every publish.
// Per-view targets live in lib/areas.mjs, so the office / area / national densities are
// declared once and read the same way by the lattice and the city labels. The national
// view gets far more than an office because it is one map covering the whole country: at
// 340 the spacing is ~95 miles and the field reads as blobs. That costs one view's worth
// of extra fetches on a publish, not 121.
// `--rebalance` redoes just that last step from the files already on disk, with no
// network at all — the resolving pass above is 30k lookups and ~18 minutes.
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const rebalanceOnly = args.includes("--rebalance");
const onlyArg = args.indexOf("--only");
const only = onlyArg === -1 ? null : new Set(args[onlyArg + 1].split(","));

/* ------------------------------------------------------------------ geometry */

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inCwa(lon, lat, polygons) {
  for (const polygon of polygons) {
    if (!pointInRing(lon, lat, polygon[0])) continue;
    if (polygon.slice(1).some((hole) => pointInRing(lon, lat, hole))) continue;
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ sampling */

const bundleDir = new URL("../public/offices/", import.meta.url);
const names = (await readdir(bundleDir)).filter((name) => name.endsWith(".json")).sort();
if (!names.length) throw new Error("no office bundles — run scripts/build-office-bundles.mjs first");

// Samples keyed by position. Neighbouring frames overlap, but each office derives its own
// step from its own frame width, so two offices practically never sample the exact same
// coordinate and this dedups almost nothing — the real sharing happens after resolution,
// where many samples collapse onto one 2.5 km NWS gridpoint.
const samples = new Map();
const perOffice = [];

for (const name of names) {
  const bundle = JSON.parse(await readFile(new URL(name, bundleDir), "utf8"));
  if (only && !only.has(bundle.office)) continue;
  const frame = frameBounds(bundle.bounds);
  const margin = (frame.east - frame.west) * MARGIN_FRACTION;
  const sampled = {
    west: frame.west - margin,
    east: frame.east + margin,
    south: frame.south - margin,
    north: frame.north + margin,
  };
  const fine = (sampled.east - sampled.west) / FINE_COLUMNS;
  const coarse = fine * COARSE_FACTOR;
  // The national view has no CWA to sample "inside" — and it needs no new lookups at all,
  // because the rebalance below fills it from every point already resolved nationally.
  if (!bundle.cwa) continue;
  const polygons = bundle.cwa.type === "Polygon" ? [bundle.cwa.coordinates] : bundle.cwa.coordinates;

  let count = 0;
  const add = (lat, lon) => {
    // Rounded only to collapse floating-point drift within one office's own sweep.
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    let sample = samples.get(key);
    if (!sample) {
      sample = { lat, lon, offices: [] };
      samples.set(key, sample);
    }
    if (!sample.offices.includes(bundle.office)) sample.offices.push(bundle.office);
    count += 1;
  };

  for (let lat = sampled.south; lat <= sampled.north + 1e-9; lat += fine) {
    for (let lon = sampled.west; lon <= sampled.east + 1e-9; lon += fine) {
      if (inCwa(lon, lat, polygons)) add(lat, lon);
    }
  }
  for (let lat = sampled.south; lat <= sampled.north + 1e-9; lat += coarse) {
    for (let lon = sampled.west; lon <= sampled.east + 1e-9; lon += coarse) {
      if (!inCwa(lon, lat, polygons)) add(lat, lon);
    }
  }
  perOffice.push({ office: bundle.office, count, fine: +fine.toFixed(3), span: +(sampled.east - sampled.west).toFixed(1) });
}

perOffice.sort((a, b) => b.count - a.count);
const total = perOffice.reduce((sum, entry) => sum + entry.count, 0);
console.log(`${perOffice.length} offices, ${total} samples before dedup, ${samples.size} unique lookups`);
// Sampling only ever covers offices with a CWA to sample inside. A run scoped to wide
// views — `--only US` or an area list — legitimately samples nothing and fills entirely
// from the national pool below, so these stats have nothing to report rather than being
// an error to dereference off the end of an empty list.
if (perOffice.length) {
  console.log(`  per office: max ${perOffice[0].count} (${perOffice[0].office}), min ${perOffice.at(-1).count} (${perOffice.at(-1).office}), mean ${Math.round(total / perOffice.length)}`);
  console.log(`  widest frame ${perOffice.reduce((a, b) => (a.span > b.span ? a : b)).span}°, narrowest ${perOffice.reduce((a, b) => (a.span < b.span ? a : b)).span}°`);
} else {
  console.log("  no CWA sampling needed — every selected view fills from the national pool");
}
if (dryRun) {
  console.log("\n--dry-run: no requests issued.");
  process.exit(0);
}

/* ------------------------------------------------------------------ resolving */

/** api.weather.gov speaks ordinary -180..180; a shifted frame carries longitudes past it. */
const apiLon = (lon) => (lon > 180 ? lon - 360 : lon);

async function resolve(sample) {
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      const response = await fetch(
        `https://api.weather.gov/points/${sample.lat.toFixed(4)},${apiLon(sample.lon).toFixed(4)}`,
        { headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" }, signal: AbortSignal.timeout(20_000) },
      );
      // A point in the ocean or outside any CWA is a real 404, not a failure to retry.
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`points ${response.status}`);
      const properties = (await response.json()).properties;
      if (!properties?.gridId || properties.gridX == null || properties.gridY == null) return null;
      return { wfo: properties.gridId, x: properties.gridX, y: properties.gridY };
    } catch (error) {
      if (attempt === RETRIES - 1) return { failed: true, reason: String(error).slice(0, 60) };
      await new Promise((done) => setTimeout(done, 400 * 2 ** attempt));
    }
  }
  return null;
}

const pending = rebalanceOnly ? [] : [...samples.values()];
if (!rebalanceOnly) console.log(`\nresolving ${pending.length} unique samples at ${CONCURRENCY}-wide…`);
const started = Date.now();
let done = 0;
let failed = 0;
let unresolved = 0;

// Keyed by the gridpoint itself: several samples land in one 2.5 km cell, and it then
// serves every office frame those samples belonged to.
const points = new Map();

async function worker() {
  for (;;) {
    const sample = pending.pop();
    if (!sample) return;
    const result = await resolve(sample);
    done += 1;
    if (done % 500 === 0) {
      const rate = done / ((Date.now() - started) / 1000);
      process.stdout.write(`\r  ${done}/${samples.size}  ${rate.toFixed(0)}/s  eta ${Math.round((samples.size - done) / rate)}s   `);
    }
    if (!result) {
      unresolved += 1;
      continue;
    }
    if (result.failed) {
      failed += 1;
      continue;
    }
    const key = `${result.wfo}-${result.x}-${result.y}`;
    const existing = points.get(key);
    if (existing) {
      for (const office of sample.offices) if (!existing.offices.includes(office)) existing.offices.push(office);
      continue;
    }
    points.set(key, {
      id: `grid-${key}`,
      wfo: result.wfo,
      x: result.x,
      y: result.y,
      lat: Math.round(sample.lat * 1e4) / 1e4,
      lon: Math.round(sample.lon * 1e4) / 1e4,
      offices: [...sample.offices],
    });
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
process.stdout.write("\n");

if (!rebalanceOnly && failed > samples.size * 0.02) {
  throw new Error(`${failed} lookups failed after ${RETRIES} attempts (>2%) — refusing to write a lattice with holes`);
}

/* ------------------------------------------------------------------ write out */

const outDir = new URL("../public/gridpoints/", import.meta.url);
await mkdir(outDir, { recursive: true });

/**
 * Thin a frame's candidate points onto a uniform grid, keeping the one nearest each cell
 * centre. Even spacing is what inverse-distance weighting wants — a field that is dense in
 * the middle and sparse at the edges reads as bullseyes over the sparse part — and the
 * cell size is solved for the target count so every office costs about the same to fetch.
 */
function thin(candidates, frame, target) {
  if (candidates.length <= target) return candidates;
  const width = frame.east - frame.west;
  const height = frame.north - frame.south;
  // cols * rows ≈ target while cols/rows matches the frame's own aspect.
  const cols = Math.max(1, Math.round(Math.sqrt((target * width) / height)));
  const rows = Math.max(1, Math.round(target / cols));
  const best = new Map();
  for (const point of candidates) {
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(((point.lon - frame.west) / width) * cols)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(((point.lat - frame.south) / height) * rows)));
    const key = cy * cols + cx;
    const centreLon = frame.west + ((cx + 0.5) / cols) * width;
    const centreLat = frame.south + ((cy + 0.5) / rows) * height;
    const distance = Math.hypot(point.lon - centreLon, point.lat - centreLat);
    const current = best.get(key);
    if (!current || distance < current.distance) best.set(key, { point, distance });
  }
  return [...best.values()].map((entry) => entry.point);
}

// Every point resolved anywhere, so a frame can draw on its neighbours' sampling.
//
// Kept in its own file rather than reconstructed from the per-office outputs. Those are
// already thinned, so rebuilding the pool from them is lossy: the first --rebalance read
// 29,464 points and the second only 25,028, and each further run would erode it again.
// The pool is the authoritative record of what the 31k-lookup resolving pass found.
const poolPath = new URL("../scripts/data/gridpoints-national.json", import.meta.url);
const national = new Map();
if (rebalanceOnly) {
  const saved = await readFile(poolPath, "utf8").catch(() => null);
  if (!saved) throw new Error("no scripts/data/gridpoints-national.json — run without --rebalance first");
  for (const point of JSON.parse(saved)) national.set(`${point.wfo}-${point.x}-${point.y}`, point);
} else {
  for (const point of points.values()) national.set(`${point.wfo}-${point.x}-${point.y}`, point);
  await mkdir(new URL("../scripts/data/", import.meta.url), { recursive: true });
  await writeFile(poolPath, JSON.stringify([...national.values()]));
}
if (!national.size) throw new Error("no gridpoints to distribute");

let bytes = 0;
const counts = [];
for (const name of names) {
  const office = name.replace(".json", "");
  if (only && !only.has(office)) continue;
  const bundle = JSON.parse(await readFile(new URL(name, bundleDir), "utf8"));
  const frame = frameBounds(bundle.bounds);
  const shift = bundle.bounds.east > 180 ? (lon) => (lon < 0 ? lon + 360 : lon) : (lon) => lon;

  const candidates = [];
  for (const point of national.values()) {
    const lon = shift(point.lon);
    if (lon < frame.west || lon > frame.east || point.lat < frame.south || point.lat > frame.north) continue;
    candidates.push({ ...point, lon });
  }
  if (!candidates.length) continue;

  const list = thin(candidates, frame, targetsFor(office).points)
    // Written back in the office's own coordinate space so the client never has to shift.
    .map((point) => ({ id: point.id, wfo: point.wfo, x: point.x, y: point.y, lat: point.lat, lon: point.lon }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const json = JSON.stringify(list);
  await writeFile(new URL(`${office}.json`, outDir), json);
  bytes += json.length;
  counts.push({ office, n: list.length, pool: candidates.length });
}
counts.sort((a, b) => b.n - a.n);

console.log(`\npublic/gridpoints/: ${counts.length} offices, ${national.size} distinct gridpoints nationally, ${(bytes / 1024).toFixed(0)} KB`);
console.log(`  per office: max ${counts[0].n} (${counts[0].office}), min ${counts.at(-1).n} (${counts.at(-1).office}), mean ${Math.round(counts.reduce((s, c) => s + c.n, 0) / counts.length)}`);
console.log(`  drawn from a mean pool of ${Math.round(counts.reduce((s, c) => s + c.pool, 0) / counts.length)} in-frame candidates`);
if (!rebalanceOnly) console.log(`  ${unresolved} samples outside any gridded forecast (ocean/foreign), ${failed} hard failures`);
console.log(`  elapsed ${Math.round((Date.now() - started) / 1000)}s`);
const thinOffices = counts.filter((c) => c.n < 40);
if (thinOffices.length) console.log(`  too thin to interpolate: ${thinOffices.map((c) => `${c.office} ${c.n}`).join(", ")}`);
