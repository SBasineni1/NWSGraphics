import { readFile, writeFile } from "node:fs/promises";
import { coordinateBounds, frameBounds, withinBounds } from "../lib/map-frame.mjs";

// Resolve a lat/lon lattice covering every covered office's render frame to its owning
// NWS gridpoints. Two densities: full resolution inside the County Warning Areas, where
// the forecast actually matters, and a sparse ring out to the frame edges purely so the
// field has something real to interpolate toward instead of smearing the nearest CWA
// value across the corner of the canvas.
const USER_AGENT = "PHI Forecast Graphics (weather.gov/phi)";
const CWA_STEP = 0.22;
const BUFFER_STEP = 0.45;
// Points just past a frame edge still pull their weight: without them the interpolation
// along the canvas border has neighbours on one side only.
const FRAME_MARGIN = 0.3;
const BATCH_SIZE = 12;

const boundary = JSON.parse(await readFile(new URL("../public/cwa.geojson", import.meta.url), "utf8"));

const offices = boundary.features.map((feature) => {
  const frame = frameBounds(coordinateBounds(feature.geometry.coordinates));
  return {
    id: feature.properties.cwa,
    polygons: feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates,
    frame,
    sampled: {
      west: frame.west - FRAME_MARGIN,
      east: frame.east + FRAME_MARGIN,
      south: frame.south - FRAME_MARGIN,
      north: frame.north + FRAME_MARGIN,
    },
  };
});

const union = {
  west: Math.min(...offices.map((office) => office.sampled.west)),
  east: Math.max(...offices.map((office) => office.sampled.east)),
  south: Math.min(...offices.map((office) => office.sampled.south)),
  north: Math.max(...offices.map((office) => office.sampled.north)),
};

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inOffice(lon, lat, office) {
  for (const polygon of office.polygons) {
    if (!pointInRing(lon, lat, polygon[0])) continue;
    if (polygon.slice(1).some((hole) => pointInRing(lon, lat, hole))) continue;
    return true;
  }
  return false;
}

const inAnyCwa = (lon, lat) => offices.some((office) => inOffice(lon, lat, office));
const framesFor = (lon, lat) => offices.filter((office) => withinBounds(office.sampled, lon, lat)).map((office) => office.id);

// Sample keys are rounded so the two lattices can never emit the same coordinate twice.
const samples = new Map();
function addSample(lat, lon) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (samples.has(key)) return;
  const offices = framesFor(lon, lat);
  if (!offices.length) return;
  samples.set(key, { lat, lon, offices });
}

for (let lat = union.south; lat <= union.north + 1e-9; lat += CWA_STEP) {
  for (let lon = union.west; lon <= union.east + 1e-9; lon += CWA_STEP) {
    if (inAnyCwa(lon, lat)) addSample(lat, lon);
  }
}
for (let lat = union.south; lat <= union.north + 1e-9; lat += BUFFER_STEP) {
  for (let lon = union.west; lon <= union.east + 1e-9; lon += BUFFER_STEP) {
    if (!inAnyCwa(lon, lat)) addSample(lat, lon);
  }
}

const pending = [...samples.values()];
console.log(`resolving ${pending.length} samples across ${offices.map((office) => office.id).join(", ")}…`);

async function resolve(lat, lon) {
  try {
    const response = await fetch(`https://api.weather.gov/points/${lat.toFixed(3)},${lon.toFixed(3)}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const properties = (await response.json()).properties;
    if (!properties?.gridId || properties.gridX == null || properties.gridY == null) return null;
    return { wfo: properties.gridId, x: properties.gridX, y: properties.gridY };
  } catch {
    return null;
  }
}

const points = new Map();
let unresolved = 0;
for (let index = 0; index < pending.length; index += BATCH_SIZE) {
  const batch = pending.slice(index, index + BATCH_SIZE);
  const results = await Promise.all(batch.map((sample) => resolve(sample.lat, sample.lon)));
  results.forEach((result, offset) => {
    if (!result) {
      unresolved += 1;
      return;
    }
    const sample = batch[offset];
    const key = `${result.wfo}-${result.x}-${result.y}`;
    const existing = points.get(key);
    if (existing) {
      // Several samples can land in one gridpoint; it serves every frame they touch.
      for (const office of sample.offices) if (!existing.offices.includes(office)) existing.offices.push(office);
      return;
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
  });
}

const resolved = [...points.values()].sort((a, b) => a.id.localeCompare(b.id));
for (const point of resolved) point.offices.sort();
await writeFile(new URL("../app/api/forecast/grid-points.json", import.meta.url), JSON.stringify(resolved));

const byWfo = {};
for (const point of resolved) byWfo[point.wfo] = (byWfo[point.wfo] ?? 0) + 1;
const perOffice = offices.map((office) =>
  `${office.id} ${resolved.filter((point) => point.offices.includes(office.id)).length}`).join(", ");
console.log(`grid-points.json: ${resolved.length} gridpoints (${unresolved} samples unresolved)`);
console.log(`  owning office: ${Object.entries(byWfo).sort().map(([wfo, count]) => `${wfo} ${count}`).join(", ")}`);
console.log(`  fetched per map: ${perOffice}`);
