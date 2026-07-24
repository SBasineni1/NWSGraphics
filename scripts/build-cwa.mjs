import { writeFile } from "node:fs/promises";

// Official County Warning Area polygons for the offices the site covers, straight from
// the NWS reference map service. Keep the {wfo, cwa, citystate} property names — the
// renderer selects a boundary by `properties.cwa`.
const OFFICES = ["PHI", "OKX", "CTP", "LWX"];
const SERVICE = "https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/nws_reference_map/MapServer/1/query";

// The service ships county-resolution geometry — ~63k vertices for PHI alone, which is
// 12× the hand-placed asset it replaces and would put the boundary file into megabytes.
// One device pixel is ~0.0026° of longitude at the zoom-7 render scale, so simplifying
// at 0.001° stays comfortably sub-pixel while cutting the vertex count by ~90%.
const SIMPLIFY_TOLERANCE = 0.001;

function round(node) {
  if (typeof node[0] === "number") return [Math.round(node[0] * 1e4) / 1e4, Math.round(node[1] * 1e4) / 1e4];
  return node.map(round);
}

function perpendicularDistance([x, y], [x1, y1], [x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
  return Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / Math.hypot(dx, dy);
}

/** Iterative Douglas-Peucker — recursion would blow the stack on a 60k-vertex ring. */
function simplifyLine(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let furthest = -1;
    let maxDistance = tolerance;
    for (let index = first + 1; index < last; index += 1) {
      const distance = perpendicularDistance(points[index], points[first], points[last]);
      if (distance > maxDistance) {
        maxDistance = distance;
        furthest = index;
      }
    }
    if (furthest === -1) continue;
    keep[furthest] = 1;
    stack.push([first, furthest], [furthest, last]);
  }
  return points.filter((_, index) => keep[index]);
}

/** Rings must stay closed and keep at least a triangle, or the fill/clip breaks. */
function simplifyRing(ring, tolerance) {
  const simplified = simplifyLine(ring, tolerance);
  if (simplified.length < 4) return ring;
  const [firstLon, firstLat] = simplified[0];
  const [lastLon, lastLat] = simplified.at(-1);
  if (firstLon !== lastLon || firstLat !== lastLat) simplified.push([firstLon, firstLat]);
  return simplified;
}

function simplifyGeometry(type, coordinates, tolerance) {
  const polygons = type === "Polygon" ? [coordinates] : coordinates;
  const simplified = polygons
    .map((polygon) => polygon.map((ring) => simplifyRing(ring, tolerance)))
    .filter((polygon) => polygon[0].length >= 4);
  return type === "Polygon" ? simplified[0] : simplified;
}

function countVertices(node) {
  if (typeof node[0] === "number") return 1;
  return node.reduce((total, child) => total + countVertices(child), 0);
}

const parameters = new URLSearchParams({
  where: `CWA IN (${OFFICES.map((office) => `'${office}'`).join(",")})`,
  outFields: "WFO,CWA,CITYSTATE",
  returnGeometry: "true",
  outSR: "4326",
  f: "geojson",
});

const response = await fetch(`${SERVICE}?${parameters}`, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error(`CWA source ${response.status}`);
const data = await response.json();
if (!Array.isArray(data.features)) throw new Error("CWA source returned no feature collection");

const features = data.features.map((feature) => {
  const before = countVertices(feature.geometry.coordinates);
  const simplified = simplifyGeometry(feature.geometry.type, feature.geometry.coordinates, SIMPLIFY_TOLERANCE);
  const coordinates = round(simplified);
  return {
    feature: {
      type: "Feature",
      properties: {
        wfo: feature.properties.wfo ?? feature.properties.WFO,
        cwa: feature.properties.cwa ?? feature.properties.CWA,
        citystate: feature.properties.citystate ?? feature.properties.CITYSTATE,
      },
      geometry: { type: feature.geometry.type, coordinates },
    },
    before,
    after: countVertices(coordinates),
  };
});

const missing = OFFICES.filter((office) => !features.some((entry) => entry.feature.properties.cwa === office));
if (missing.length) throw new Error(`CWA source did not return: ${missing.join(", ")}`);

features.sort((a, b) => OFFICES.indexOf(a.feature.properties.cwa) - OFFICES.indexOf(b.feature.properties.cwa));
await writeFile(
  new URL("../public/cwa.geojson", import.meta.url),
  JSON.stringify({ type: "FeatureCollection", features: features.map((entry) => entry.feature) }),
);
console.log(`cwa.geojson: ${features.map((entry) =>
  `${entry.feature.properties.cwa} ${entry.before}→${entry.after} vertices`).join(", ")}`);
