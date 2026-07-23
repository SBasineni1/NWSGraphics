import { readFile, writeFile } from "node:fs/promises";

// Resolve a dense lat/lon lattice inside the official PHI County Warning Area
// to its owning NWS gridpoints. The published maps are clipped to this same
// boundary, so concentrating requests here gives a cleaner field with fewer API
// calls than a sparse grid spread over the entire Northeast.
const USER_AGENT = "PHI Forecast Graphics (weather.gov/phi)";
const STEP = 0.22;

const boundary = JSON.parse(await readFile(new URL("../public/phi-cwa.geojson", import.meta.url), "utf8"));
const polygons = boundary.features[0].geometry.coordinates;
const positions = polygons.flat(2);
const frame = {
  west: Math.min(...positions.map((position) => position[0])),
  east: Math.max(...positions.map((position) => position[0])),
  south: Math.min(...positions.map((position) => position[1])),
  north: Math.max(...positions.map((position) => position[1])),
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

function inForecastArea(lon, lat) {
  for (const polygon of polygons) {
    if (!pointInRing(lon, lat, polygon[0])) continue;
    if (polygon.slice(1).some((hole) => pointInRing(lon, lat, hole))) continue;
    return true;
  }
  return false;
}

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

const samples = [];
for (let lat = frame.south; lat <= frame.north + 1e-9; lat += STEP) {
  for (let lon = frame.west; lon <= frame.east + 1e-9; lon += STEP) {
    if (inForecastArea(lon, lat)) samples.push([lat, lon]);
  }
}
console.log(`resolving ${samples.length} PHI CWA samples…`);

const seen = new Set();
const points = [];
for (let index = 0; index < samples.length; index += 10) {
  const batch = samples.slice(index, index + 10);
  const results = await Promise.all(batch.map(([lat, lon]) => resolve(lat, lon)));
  for (const result of results) {
    if (!result) continue;
    const key = `${result.wfo}-${result.x}-${result.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push({ id: `grid-${key}`, wfo: result.wfo, x: result.x, y: result.y });
  }
}
points.sort((a, b) => a.id.localeCompare(b.id));
await writeFile(new URL("../app/api/forecast/grid-points.json", import.meta.url), JSON.stringify(points));
const offices = [...new Set(points.map((point) => point.wfo))].sort();
console.log(`grid-points.json: ${points.length} unique gridpoints across ${offices.length} offices (${offices.join(", ")})`);
