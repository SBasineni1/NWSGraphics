import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { coordinateBounds, fitZoom, frameBounds } from "../lib/map-frame.mjs";
import { bboxOf, offsetFor, overlaps, prepare, toleranceFor } from "../lib/geo-simplify.mjs";

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

// The national view, as a synthetic office so it travels through the same pipeline as
// every real one — same bundle shape, same lattice build, same renderer. The plan called
// for an "area" concept above office; this is the cheap version of it, and it earns its
// place because SPC and WPC issue their outlooks *nationally*, so this is the frame those
// products were drawn for.
//
// It carries no CWA: there is no single boundary to outline, and stroking all 122 of them
// at this scale is unreadable. State lines carry the geography instead.
const NATIONAL = {
  id: "US",
  // The lower 48. Alaska, Hawaii and the territories have their own offices, and
  // stretching the frame to include them would shrink CONUS to a corner of the canvas.
  bounds: { west: -125.0, south: 24.4, east: -66.9, north: 49.4 },
};
offices.push({
  id: NATIONAL.id,
  geometry: null,
  bounds: NATIONAL.bounds,
  zoom: fitZoom(NATIONAL.bounds),
  frame: frameBounds(NATIONAL.bounds),
  counties: [],
  states: [],
  interstates: [],
  // Counties and interstates are skipped for this one: at zoom 4 a county is a couple of
  // pixels, so all 3,143 of them would be unreadable mush and a multi-megabyte download.
  nationalScale: true,
});

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
      // County and interstate detail is meaningless at national scale; states only.
      if (office.nationalScale && key !== "states") continue;
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
  const offset = office.geometry ? offsetFor(office.frame, coordinateBounds(office.geometry.coordinates)) : 0;
  const shift = (lon) => lon + offset;
  const bundle = {
    office: office.id,
    // The renderer takes both from here rather than recomputing: the frame the lattice
    // was built against and the frame drawn have to be the same one.
    zoom: office.zoom,
    bounds: office.bounds,
    // Null for the national view — nothing to outline, and the renderer skips it.
    cwa: office.geometry
      ? {
          type: office.geometry.type,
          coordinates: prepare(office.geometry.coordinates, shift, toleranceFor(office.zoom), true, 1e4),
        }
      : null,
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
