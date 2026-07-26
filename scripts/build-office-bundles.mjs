import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { coordinateBounds, fitZoom, frameBounds } from "../lib/map-frame.mjs";

// One self-contained map bundle per NWS forecast office: its CWA outline plus the
// counties, state lines and interstates that fall inside the frame the renderer draws,
// and the tile zoom that frame wants.
//
//   node scripts/build-office-bundles.mjs
//
// Writes public/offices/{OFFICE}.json — replacing the four shared files in public/, which
// are clipped to the union of the *current four* offices' frames. Going national with
// those would mean every visitor downloading every county in the country to draw one
// office; a bundle is the slice that one map actually needs, so the cost per visitor is
// flat no matter how many offices exist.
//
// The upstream sources total ~128 MB and change roughly never, so they are cached in
// .cache/ (gitignored). Delete it to force a refresh.

const SERVICE = "https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/nws_reference_map/MapServer/1/query";
const SOURCES = {
  counties: "https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json",
  states: "https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/10m/cultural/ne_10m_admin_1_states_provinces.json",
  roads: "https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/10m/cultural/ne_10m_roads.json",
};
// Natural Earth road classes that read as the interstate / limited-access network.
const FREEWAY_TYPES = new Set(["Major Highway", "Beltway", "Bypass"]);
// The service caps a single query's feature count, so geometry is fetched in chunks.
const CHUNK = 10;
// Overlays are kept a little past the frame so a county or highway entering at the very
// edge still has the vertices to be drawn into it, rather than stopping short.
const MARGIN = 0.25;

const cacheDir = new URL("../.cache/", import.meta.url);

async function cached(name, url) {
  const path = new URL(`${name}.json`, cacheDir);
  const hit = await stat(path).catch(() => null);
  if (hit) {
    console.log(`  ${name}: cached (${(hit.size / 1048576).toFixed(1)} MB)`);
    return JSON.parse(await readFile(path, "utf8"));
  }
  console.log(`  ${name}: downloading…`);
  const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`${name}: ${response.status}`);
  const text = await response.text();
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path, text);
  console.log(`  ${name}: ${(text.length / 1048576).toFixed(1)} MB`);
  return JSON.parse(text);
}

/* ------------------------------------------------------------------ geometry */

function perpendicularDistance([x, y], [x1, y1], [x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
  return Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / Math.hypot(dx, dy);
}

/** Iterative Douglas-Peucker — recursion blows the stack on a 60k-vertex ring. */
function simplify(points, tolerance, closed) {
  if (points.length < (closed ? 5 : 3)) return points;
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
  const out = points.filter((_, index) => keep[index]);
  if (!closed) return out.length >= 2 ? out : points;
  if (out.length < 4) return points;
  const [fx, fy] = out[0];
  const [lx, ly] = out.at(-1);
  if (fx !== lx || fy !== ly) out.push([fx, fy]);
  return out;
}

const round = (node, factor) =>
  typeof node[0] === "number"
    ? [Math.round(node[0] * factor) / factor, Math.round(node[1] * factor) / factor]
    : node.map((child) => round(child, factor));

/**
 * A frame that crosses the antimeridian is expressed with `east` past 180 (see
 * coordinateBounds), so a feature sitting at -175° has to be read as 185° to land in it.
 *
 * The offset is decided **once per feature, from that feature's own position**, and then
 * applied to every one of its coordinates. Shifting each coordinate independently — "any
 * negative longitude gains 360" — tears apart anything that straddles the *prime*
 * meridian: a road crossing 0° became points at 359.5 and 0.5, a bounding box spanning the
 * entire globe, which then "overlapped" every frame and drew as a line straight across
 * Alaska. Six European roads were being painted over the Aleutians that way.
 *
 * @returns the number of degrees to add to every longitude of this feature, or null when
 *   the feature belongs to a different part of the world entirely.
 */
function offsetFor(frame, plainBox) {
  if (frame.east <= 180) return 0;
  // Anything west of the frame by more than half the globe is really east of it, reached
  // the short way round; everything else is already in the frame's own space.
  const centre = (plainBox.west + plainBox.east) / 2;
  return centre < frame.west - 180 ? 360 : 0;
}

function bboxOf(coordinates, shift = (lon) => lon) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const walk = (node) => {
    if (typeof node[0] === "number") {
      const lon = shift(node[0]);
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (node[1] < south) south = node[1];
      if (node[1] > north) north = node[1];
    } else {
      for (const child of node) walk(child);
    }
  };
  walk(coordinates);
  return { west, south, east, north };
}

const overlaps = (box, frame) =>
  box.east >= frame.west - MARGIN &&
  box.west <= frame.east + MARGIN &&
  box.north >= frame.south - MARGIN &&
  box.south <= frame.north + MARGIN;

/** Rings/lines carried into a bundle, shifted, simplified and rounded for that frame. */
function prepare(coordinates, shift, tolerance, closed, factor) {
  const walk = (node) => {
    if (typeof node[0][0] === "number") {
      const shifted = node.map(([lon, lat]) => [shift(lon), lat]);
      return round(simplify(shifted, tolerance, closed), factor);
    }
    return node.map(walk);
  };
  return walk(coordinates);
}

/* --------------------------------------------------------------- office frames */

console.log("fetching CWA geometry…");
const listing = await fetch(`${SERVICE}?${new URLSearchParams({ where: "1=1", outFields: "CWA", returnGeometry: "false", f: "json" })}`, { signal: AbortSignal.timeout(120_000) });
if (!listing.ok) throw new Error(`office listing ${listing.status}`);
// The service answers with lowercase field names through the geojson formatter and
// uppercase through the json one; neither is guaranteed, so accept both everywhere.
const ids = [...new Set((await listing.json()).features.map((f) => f.attributes.CWA ?? f.attributes.cwa))].sort();

const offices = [];
for (let index = 0; index < ids.length; index += CHUNK) {
  const batch = ids.slice(index, index + CHUNK);
  const query = new URLSearchParams({
    where: `CWA IN (${batch.map((id) => `'${id}'`).join(",")})`,
    outFields: "CWA,WFO,CITYSTATE",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
  });
  const response = await fetch(`${SERVICE}?${query}`, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`CWA geometry ${batch.join(",")}: ${response.status}`);
  for (const feature of (await response.json()).features ?? []) {
    const id = feature.properties.CWA ?? feature.properties.cwa;
    const bounds = coordinateBounds(feature.geometry.coordinates);
    const zoom = fitZoom(bounds);
    offices.push({ id, geometry: feature.geometry, bounds, zoom, frame: frameBounds(bounds), counties: [], states: [], interstates: [] });
  }
  process.stdout.write(`\r  ${offices.length}/${ids.length}`);
}
process.stdout.write("\n");
const missing = ids.filter((id) => !offices.some((office) => office.id === id));
if (missing.length) throw new Error(`no geometry returned for: ${missing.join(", ")}`);

/**
 * One device pixel in degrees at the office's own zoom, which is what "sub-pixel" means
 * here. A fixed tolerance would over-simplify a zoom-9 office and leave a zoom-4 one
 * carrying tens of thousands of vertices nobody can see.
 */
const toleranceFor = (zoom) => 360 / (256 * 2 ** zoom * 2) / 2;

console.log("loading overlay sources…");
const sources = {
  counties: await cached("counties", SOURCES.counties),
  states: await cached("states", SOURCES.states),
  roads: await cached("roads", SOURCES.roads),
};

/**
 * Each source is walked once and offered to every office, rather than re-scanning the
 * source per office: 125 bbox tests against a precomputed feature box is far cheaper than
 * 125 passes over a 60 MB file.
 */
function distribute(features, key, { closed, factor, filter }) {
  let kept = 0;
  for (const feature of features) {
    if (filter && !filter(feature)) continue;
    const plain = bboxOf(feature.geometry.coordinates);
    for (const office of offices) {
      const offset = offsetFor(office.frame, plain);
      const box = offset
        ? { west: plain.west + offset, east: plain.east + offset, south: plain.south, north: plain.north }
        : plain;
      if (!overlaps(box, office.frame)) continue;
      const shift = (lon) => lon + offset;
      office[key].push({
        type: feature.geometry.type,
        coordinates: prepare(feature.geometry.coordinates, shift, toleranceFor(office.zoom), closed, factor),
      });
      kept += 1;
    }
  }
  console.log(`  ${key}: ${kept} features placed across ${offices.length} offices`);
}

distribute(sources.counties.features, "counties", { closed: true, factor: 1e4 });
distribute(sources.states.features, "states", {
  closed: true,
  factor: 1e4,
  filter: (f) => f.properties?.admin === "United States of America",
});
distribute(sources.roads.features, "interstates", {
  closed: false,
  factor: 1e3,
  filter: (f) => FREEWAY_TYPES.has(f.properties?.type),
});

/* ------------------------------------------------------------------ write out */

const outDir = new URL("../public/offices/", import.meta.url);
await mkdir(outDir, { recursive: true });

let total = 0;
const sizes = [];
for (const office of offices) {
  // Computed once per office, not inside the closure: coordinateBounds walks the full
  // unsimplified CWA, so calling it per longitude turned a 21-second build into minutes.
  const offset = offsetFor(office.frame, coordinateBounds(office.geometry.coordinates));
  const shift = (lon) => lon + offset;
  const bundle = {
    office: office.id,
    // The renderer takes both from here rather than recomputing: the frame the lattice
    // was built against and the frame drawn have to be the same one.
    zoom: office.zoom,
    bounds: office.bounds,
    cwa: {
      type: office.geometry.type,
      coordinates: prepare(office.geometry.coordinates, shift, toleranceFor(office.zoom), true, 1e4),
    },
    counties: office.counties,
    states: office.states,
    interstates: office.interstates,
  };
  const json = JSON.stringify(bundle);
  await writeFile(new URL(`${office.id}.json`, outDir), json);
  total += json.length;
  sizes.push({ id: office.id, kb: json.length / 1024, zoom: office.zoom, counties: office.counties.length, roads: office.interstates.length });
}

sizes.sort((a, b) => b.kb - a.kb);
console.log(`\npublic/offices/: ${offices.length} bundles, ${(total / 1048576).toFixed(1)} MB total, ${(total / offices.length / 1024).toFixed(0)} KB average`);
console.log("largest:");
for (const s of sizes.slice(0, 5)) console.log(`  ${s.id} ${s.kb.toFixed(0)} KB (zoom ${s.zoom}, ${s.counties} counties, ${s.roads} roads)`);
console.log("smallest:");
for (const s of sizes.slice(-3)) console.log(`  ${s.id} ${s.kb.toFixed(0)} KB (zoom ${s.zoom}, ${s.counties} counties, ${s.roads} roads)`);
const empty = sizes.filter((s) => !s.counties);
if (empty.length) console.log(`\nno counties (expected for ocean/territory domains): ${empty.map((s) => s.id).join(", ")}`);
