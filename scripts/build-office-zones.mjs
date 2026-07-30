import { mkdir, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { frameBounds } from "../lib/map-frame.mjs";
import { bboxOf, offsetFor, overlaps, prepare, toleranceFor } from "../lib/geo-simplify.mjs";

// The polygons an active watch/warning is drawn on, one file per office:
//
//   node scripts/build-office-zones.mjs
//
// Writes public/zones/{OFFICE}.json — a map of UGC zone code to geometry.
//
// This file exists because **most alerts carry no geometry of their own.** Of 14 active
// New York alerts sampled while building this, 12 had `geometry: null` and described
// themselves only by `affectedZones`, a list of URLs like
// `https://api.weather.gov/zones/county/NYC105`. Drawing an alert is therefore a join
// against zone shapes, not a fetch of the alert's outline, and resolving those URLs at
// request time would be one subrequest per zone — the same trap /api/forecast fell into.
// Zone boundaries change on the order of years, so the join table is built offline and the
// browser does the lookup locally.
//
// Three zone types, and all three are needed. County (`NYC105`) and forecast (`NYZ072`)
// zones are different shapes covering the same land — a Flash Flood Warning is issued on
// county zones while a Flood Watch is issued on forecast zones — and **marine** (`ANZ335`)
// carries everything over water, so a coastal office like OKX loses its Small Craft
// Advisories entirely without them.
//
// **Geometry comes from the ArcGIS reference map, not from api.weather.gov/zones.** That
// endpoint ignores `include_geometry=true` and answers `geometry: null` for every one of
// its 8,747 zones, whether or not the parameter is set — it can tell you a zone exists and
// who owns it, but never its shape. The reference map is the same service
// build-office-bundles already draws CWAs from, so the shapes agree by construction.
//
// Offshore zones (layer 6) are deliberately not carried: they sit far enough out to sea to
// fall outside every CWA frame, so they would be download with nothing to draw.
//
// Sources are cached in .cache/ (gitignored). Delete it to refresh.

const SERVICE = "https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/nws_reference_map/MapServer";
// The UGC code an alert's `affectedZones` refers to is assembled differently per layer:
// counties from state + FIPS, public zones from state + zone number, marine straight off
// the feature. Getting this wrong doesn't error — it silently matches no alert.
const ZONE_LAYERS = [
  {
    kind: "county",
    layer: 2,
    fields: "state,cwa,fips",
    ugc: (p) => (p.state && p.fips ? `${p.state}C${String(p.fips).slice(-3)}` : null),
    office: (p) => p.cwa,
  },
  {
    kind: "forecast",
    layer: 8,
    fields: "state,cwa,zone",
    ugc: (p) => (p.state && p.zone ? `${p.state}Z${p.zone}` : null),
    office: (p) => p.cwa,
  },
  {
    kind: "marine",
    layer: 5,
    fields: "id,wfo",
    ugc: (p) => p.id,
    office: (p) => p.wfo,
  },
];
// The service caps a query at 2,000 features, so each layer is paged.
const PAGE = 2000;
const cacheDir = new URL("../.cache/", import.meta.url);
const officeDir = new URL("../public/offices/", import.meta.url);
const outDir = new URL("../public/zones/", import.meta.url);

/** Every feature of one layer, paged past the service's 2,000-feature cap. */
async function fetchLayer({ kind, layer, fields }) {
  const path = new URL(`zones-${kind}.json`, cacheDir);
  const hit = await stat(path).catch(() => null);
  if (hit) {
    console.log(`  ${kind}: cached (${(hit.size / 1048576).toFixed(1)} MB)`);
    return JSON.parse(await readFile(path, "utf8"));
  }
  const features = [];
  for (let offset = 0; ; offset += PAGE) {
    const query = new URLSearchParams({
      where: "1=1",
      outFields: fields,
      returnGeometry: "true",
      outSR: "4326",
      resultOffset: String(offset),
      resultRecordCount: String(PAGE),
      f: "geojson",
    });
    const response = await fetch(`${SERVICE}/${layer}/query?${query}`, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`${kind} layer ${layer} @${offset}: ${response.status}`);
    const page = (await response.json()).features ?? [];
    features.push(...page);
    process.stdout.write(`\r  ${kind}: ${features.length}`);
    if (page.length < PAGE) break;
  }
  process.stdout.write("\n");
  const text = JSON.stringify({ features });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path, text);
  return { features };
}

/**
 * The service answers with lowercase field names through the geojson formatter and
 * uppercase through the json one, and neither is guaranteed — the same trap
 * build-office-bundles notes for CWA. Normalising once here means the UGC builders above
 * can read one casing.
 */
const lower = (properties) =>
  Object.fromEntries(Object.entries(properties ?? {}).map(([key, value]) => [key.toLowerCase(), value]));

// The frame and zoom come from the bundle the renderer actually draws, never recomputed
// here. Simplification tolerance is derived from that zoom, so a zone re-derived against a
// different frame would land a warning polygon slightly off the county under it.
console.log("loading office frames…");
const offices = new Map();
for (const name of (await readdir(officeDir)).filter((n) => n.endsWith(".json"))) {
  const bundle = JSON.parse(await readFile(new URL(name, officeDir), "utf8"));
  // Wide views are built like any other. They were skipped here on the grounds that the
  // national frame claims every zone in the country and would cost "megabytes apiece" —
  // which measured the wrong number. Raw, US is 8.3 MB; **gzipped, which is what a browser
  // actually transfers, it is 110 KB — under a third of PHI's 344 KB** — because the
  // tolerance is derived from the frame's zoom and zoom 4 is ~16x coarser than zoom 8, so
  // each of those 7,451 polygons is a handful of points. A wide view's zone bundle is
  // cheaper than an office's, not dearer.
  offices.set(bundle.office, {
    zoom: bundle.zoom,
    frame: frameBounds(bundle.bounds),
    zones: {},
    counts: { county: 0, forecast: 0, marine: 0 },
  });
}
console.log(`  ${offices.size} office frames`);

console.log("loading zone geometry…");
let skippedNoGeometry = 0;
let skippedNoUgc = 0;
let skippedUnknownOffice = 0;
for (const spec of ZONE_LAYERS) {
  const collection = await fetchLayer(spec);
  for (const feature of collection.features) {
    const properties = lower(feature.properties);
    const id = spec.ugc(properties);
    if (!id) {
      skippedNoUgc += 1;
      continue;
    }
    // A retired or not-yet-active zone can come back without geometry. It cannot be drawn,
    // and an alert naming it simply won't render rather than throwing mid-paint.
    if (!feature.geometry?.coordinates?.length) {
      skippedNoGeometry += 1;
      continue;
    }
    // A zone is carried by any office whose *frame* it reaches, not just the office that
    // issues it. The alerts map fills the whole plot the way the forecast field does — an
    // office's map is a window on the weather, and a warning that stops dead at the CWA
    // border is an artefact of who issued it, not of where the storm is.
    //
    // The owning office is unioned in regardless, so an office never loses a zone it
    // issues for just because that zone sits marginally outside its own render frame.
    const owner = spec.office(properties);
    const plain = bboxOf(feature.geometry.coordinates);
    let placed = false;
    for (const [officeId, office] of offices) {
      const offset = offsetFor(office.frame, plain);
      const box = offset
        ? { west: plain.west + offset, east: plain.east + offset, south: plain.south, north: plain.north }
        : plain;
      if (officeId !== owner && !overlaps(box, office.frame)) continue;
      office.zones[id] = {
        type: feature.geometry.type,
        coordinates: prepare(
          feature.geometry.coordinates,
          (lon) => lon + offset,
          toleranceFor(office.zoom),
          true,
          1e4,
          // Collapse a sub-pixel ring to its bounding quad rather than keeping it whole.
          // Only the zone build asks for this: build-office-bundles must keep producing
          // byte-identical output, and a CWA outline is never sub-pixel on its own map.
          true,
        ),
      };
      office.counts[spec.kind] += 1;
      placed = true;
    }
    if (!placed) skippedUnknownOffice += 1;
  }
}
if (skippedNoUgc) console.log(`  skipped ${skippedNoUgc} zones with no derivable UGC code`);
if (skippedNoGeometry) console.log(`  skipped ${skippedNoGeometry} zones with no geometry`);
if (skippedUnknownOffice) console.log(`  skipped ${skippedUnknownOffice} zones reaching no office frame`);

await mkdir(outDir, { recursive: true });
let total = 0;
const sizes = [];
let empty = [];
for (const [id, office] of offices) {
  const count = Object.keys(office.zones).length;
  // The national view is not a CWA, so no zone declares it. Writing an empty file keeps
  // the client's fetch a plain 200-or-404 rather than a special case.
  if (!count) {
    empty.push(id);
    continue;
  }
  const json = JSON.stringify({ office: id, zones: office.zones });
  await writeFile(new URL(`${id}.json`, outDir), json);
  total += json.length;
  sizes.push({ id, kb: json.length / 1024, count, ...office.counts });
}

sizes.sort((a, b) => b.kb - a.kb);
console.log(`\npublic/zones/: ${sizes.length} files, ${(total / 1048576).toFixed(1)} MB total, ${(total / sizes.length / 1024).toFixed(0)} KB average`);
console.log("largest:");
for (const s of sizes.slice(0, 5)) console.log(`  ${s.id} ${s.kb.toFixed(0)} KB (${s.count} zones: ${s.county} county, ${s.forecast} forecast, ${s.marine} marine)`);
console.log("smallest:");
for (const s of sizes.slice(-3)) console.log(`  ${s.id} ${s.kb.toFixed(0)} KB (${s.count} zones)`);
if (empty.length) console.log(`\nno zones (expected for the national view): ${empty.join(", ")}`);
