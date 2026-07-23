import { readFile, writeFile } from "node:fs/promises";

// Resolve a lat/lon grid over the Northeast render frame to the NWS gridpoints
// that own each sample. Every point carries its forecast office (gridId), so the
// runtime route can fetch real data across office boundaries (PHI, OKX, LWX, BGM,
// ALY, CTP, …) instead of extrapolating PHI's grid across the whole frame.
// Ocean samples are dropped: isolated offshore points create IDW "bullseyes",
// and water areas fill smoothly from the coastal land points instead.
const USER_AGENT = "PHI Forecast Graphics (weather.gov/phi)";
const FRAME = { west: -78.2, east: -71.8, south: 37.4, north: 42.6 };
const STEP = 0.45;

const states = JSON.parse(await readFile(new URL("../public/states.geojson", import.meta.url), "utf8"));

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function onLand(lon, lat) {
  for (const feature of states.features) {
    const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const polygon of polygons) {
      if (!pointInRing(lon, lat, polygon[0])) continue;
      if (polygon.slice(1).some((hole) => pointInRing(lon, lat, hole))) continue;
      return true;
    }
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
for (let lat = FRAME.south; lat <= FRAME.north + 1e-9; lat += STEP) {
  for (let lon = FRAME.west; lon <= FRAME.east + 1e-9; lon += STEP) {
    if (onLand(lon, lat)) samples.push([lat, lon]);
  }
}
console.log(`resolving ${samples.length} land samples…`);

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
