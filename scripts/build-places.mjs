import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

// Builds the ZIP / town search index: every US place and ZCTA, each assigned to the NWS
// forecast office whose County Warning Area contains it.
//
// The assignment is done here, once, rather than at search time. api.weather.gov/points
// would answer "which office owns this lat/lon" directly, but that is a network round
// trip per keystroke-completed search, and it can't drive a typeahead at all. Doing it
// offline against the same CWA polygons the renderer draws makes search instant and
// keeps it working when api.weather.gov is down — which is exactly when someone is
// looking for a forecast.
//
//   node scripts/build-places.mjs
//
// Writes:
//   public/place-index.json          — lazy-loaded by the office picker's search box
//   scripts/data/office-population.json — population served per office, for deciding
//                                          which offices are worth publishing (Phase 6)
//
// Sources, all keyless and public domain:
//   Census 2024 Gazetteer (place + ZCTA centroids)
//   Census Vintage 2024 subcounty population estimates
//   NWS reference map service (the CWA polygons build-cwa.mjs uses)

const GAZETTEER = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer";
const POPULATION = "https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/cities/totals/sub-est2024.csv";
const SERVICE = "https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/nws_reference_map/MapServer/1/query";

// The service ships county-resolution CWA geometry. We only ever ask it "which office
// contains this town", so sub-kilometre precision is irrelevant and the full geometry is
// tens of megabytes; 0.005° (~500 m) keeps the point-in-polygon pass cheap. A town that
// lands on the wrong side of a 500 m shift is one that sits on the CWA line, where either
// answer is defensible.
const SIMPLIFY_TOLERANCE = 0.005;
// The service caps a single query's feature count, so offices are fetched in chunks.
const CHUNK = 10;

const log = (message) => console.log(message);

/* ------------------------------------------------------------------ fetching */

async function getText(url, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`${label}: ${url} returned ${response.status}`);
  return response.text();
}

/**
 * The gazetteer ships as a zip of a single tab-separated file. Node has no zip reader in
 * core, so this pulls the one stored/deflated entry out by hand rather than adding a
 * dependency for a build script that runs a few times a year.
 */
async function getGazetteer(name) {
  const response = await fetch(`${GAZETTEER}/${name}.zip`, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`gazetteer ${name}: ${response.status}`);
  const zip = Buffer.from(await response.arrayBuffer());

  // Local file header: signature(4) version(2) flags(2) method(2) time(2) date(2)
  // crc(4) compressed(4) uncompressed(4) nameLen(2) extraLen(2)
  if (zip.readUInt32LE(0) !== 0x04034b50) throw new Error(`gazetteer ${name}: not a zip`);
  const method = zip.readUInt16LE(8);
  const nameLength = zip.readUInt16LE(26);
  const extraLength = zip.readUInt16LE(28);
  const start = 30 + nameLength + extraLength;
  let compressed = zip.readUInt32LE(18);
  // With a streamed entry the sizes live in a trailing descriptor, not the header; the
  // payload then runs to the central directory.
  if (compressed === 0) {
    const directory = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), start);
    if (directory === -1) throw new Error(`gazetteer ${name}: no central directory`);
    compressed = directory - start - 16;
  }
  const body = zip.subarray(start, start + compressed);
  if (method === 0) return body.toString("utf8");
  const { inflateRawSync } = await import("node:zlib");
  return inflateRawSync(body).toString("utf8");
}

/* ------------------------------------------------------- CWA polygon geometry */

function perpendicularDistance([x, y], [x1, y1], [x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
  return Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / Math.hypot(dx, dy);
}

/** Iterative Douglas-Peucker — recursion blows the stack on a 60k-vertex ring. */
function simplifyRing(points, tolerance) {
  if (points.length < 5) return points;
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
  const simplified = points.filter((_, index) => keep[index]);
  return simplified.length >= 4 ? simplified : points;
}

async function fetchOffices() {
  const listing = await getText(
    `${SERVICE}?${new URLSearchParams({ where: "1=1", outFields: "CWA", returnGeometry: "false", f: "json" })}`,
    "office listing",
  );
  const ids = [...new Set(JSON.parse(listing).features.map((f) => f.attributes.CWA ?? f.attributes.cwa))].sort();
  if (!ids.length) throw new Error("reference map service listed no offices");
  log(`fetching CWA geometry for ${ids.length} offices…`);

  const offices = [];
  for (let index = 0; index < ids.length; index += CHUNK) {
    const batch = ids.slice(index, index + CHUNK);
    const body = await getText(
      `${SERVICE}?${new URLSearchParams({
        where: `CWA IN (${batch.map((id) => `'${id}'`).join(",")})`,
        outFields: "CWA",
        returnGeometry: "true",
        outSR: "4326",
        f: "geojson",
      })}`,
      `CWA geometry ${batch.join(",")}`,
    );
    for (const feature of JSON.parse(body).features ?? []) {
      const id = feature.properties.CWA ?? feature.properties.cwa;
      // The source ships some offices as Polygon and others as MultiPolygon.
      const raw = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
      // Only outer rings matter: a CWA hole would mean territory no office forecasts,
      // which does not happen, and skipping them halves the work.
      const rings = raw.map((polygon) => simplifyRing(polygon[0], SIMPLIFY_TOLERANCE));
      offices.push({ id, rings: rings.map(boundRing) });
    }
    process.stdout.write(`\r  ${offices.length}/${ids.length}`);
  }
  process.stdout.write("\n");

  const missing = ids.filter((id) => !offices.some((office) => office.id === id));
  if (missing.length) throw new Error(`no geometry returned for: ${missing.join(", ")}`);
  return offices;
}

/** Pre-computing each ring's bounding box is what makes 66k × 125 tractable. */
function boundRing(ring) {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { ring, west, east, south, north };
}

function pointInRing(lon, lat, { ring, west, east, south, north }) {
  if (lon < west || lon > east || lat < south || lat > north) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* ---------------------------------------------------------------- assignment */

function makeLocator(offices) {
  // One flat list of rings, so a lookup is a single bbox-rejected scan rather than a
  // nested loop over offices and then their rings.
  const rings = offices.flatMap((office, index) => office.rings.map((ring) => ({ ...ring, office: index })));
  rings.sort((a, b) => a.west - b.west);
  return (lon, lat) => {
    for (const ring of rings) {
      if (ring.west > lon) break;
      if (pointInRing(lon, lat, ring)) return ring.office;
    }
    return -1;
  };
}

/* --------------------------------------------------------------------- main */

const [placeText, zctaText, populationText, offices] = await Promise.all([
  getGazetteer("2024_Gaz_place_national"),
  getGazetteer("2024_Gaz_zcta_national"),
  getText(POPULATION, "population estimates"),
  fetchOffices(),
]);

const officeIds = offices.map((office) => office.id);
const locate = makeLocator(offices);

// Populations, keyed by the gazetteer's 7-digit state+place GEOID. SUMLEV 162 is an
// incorporated place and 157 a census designated place; the file also carries state,
// county and minor-civil-division rows, which would collide on the same key.
const populations = new Map();
for (const line of populationText.split("\n").slice(1)) {
  if (!line) continue;
  const cells = line.split(",");
  const level = cells[0];
  if (level !== "162" && level !== "157") continue;
  const geoid = `${cells[1]}${cells[3]}`;
  const value = Number(cells[15]);
  if (Number.isFinite(value) && value > (populations.get(geoid) ?? 0)) populations.set(geoid, value);
}
log(`populations: ${populations.size} places`);

// The gazetteer's NAME carries its legal type — "Abbeville city", "Abanda CDP",
// "Lake Ronkonkoma CDP". Searching for "Abbeville" should match, so the suffix is
// stripped for display and matching. It is only a suffix, never the whole name.
const SUFFIX =
  /\s+(CDP|city|town|village|borough|municipality|township|city and borough|consolidated government|metro government|metropolitan government|unified government|urban county|corporation|comunidad|zona urbana|plantation|gore|grant|location|reservation|district|precinct)$/i;

const places = [];
let unassignedPlaces = 0;
for (const line of placeText.split("\n").slice(1)) {
  const cells = line.split("\t");
  if (cells.length < 12) continue;
  const state = cells[0].trim();
  const geoid = cells[1].trim();
  const lat = Number(cells[10]);
  const lon = Number(cells[11]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  const office = locate(lon, lat);
  if (office === -1) {
    unassignedPlaces += 1;
    continue;
  }
  let name = cells[3].trim();
  // Some names carry two ("Athens-Clarke County unified government"); strip until stable.
  // Trailing parentheticals first, or they shield the suffix behind them: the Census
  // calls Nashville "Nashville-Davidson metropolitan government (balance)", and with
  // "(balance)" on the end the government suffix is never at the end to be stripped.
  name = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
  for (let previous = ""; previous !== name; ) {
    previous = name;
    name = name.replace(SUFFIX, "").trim();
  }
  if (!name) continue;
  // Land area is a weak stand-in used only for ordering label candidates where the
  // estimates file has nothing. It is never exposed as population.
  const area = Number(cells[6]) || 0;
  places.push({ name, state, office, population: populations.get(geoid) ?? 0, area, lat, lon });
}

// A ZCTA is a postal-geography approximation, so its centroid is the honest answer for
// "where is this ZIP". Assignment is by that centroid, exactly like a town.
const zips = [];
let unassignedZips = 0;
for (const line of zctaText.split("\n").slice(1)) {
  const cells = line.split("\t");
  if (cells.length < 7) continue;
  const zip = cells[0].trim();
  const lat = Number(cells[5]);
  const lon = Number(cells[6]);
  if (zip.length !== 5 || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  const office = locate(lon, lat);
  if (office === -1) {
    unassignedZips += 1;
    continue;
  }
  zips.push({ zip, office, lat, lon });
}

log(`assigned ${places.length} places (${unassignedPlaces} outside every CWA), ${zips.length} ZIPs (${unassignedZips} outside)`);

/* ------------------------------------------------------------------ encoding */

// The index is downloaded by every visitor who opens search, so it is encoded as packed
// strings rather than JSON objects — the same data as arrays-of-objects is roughly
// four times the bytes in key names alone.
places.sort((a, b) => b.population - a.population || a.name.localeCompare(b.name));
zips.sort((a, b) => a.zip.localeCompare(b.zip));

// ZIPs are dense and contiguous within an office, so consecutive ZIPs sharing an office
// collapse to a run. This is the difference between ~400 KB and ~30 KB.
const runs = [];
for (const entry of zips) {
  const previous = runs.at(-1);
  const numeric = Number(entry.zip);
  if (previous && previous.office === entry.office && previous.start + previous.count === numeric) {
    previous.count += 1;
    continue;
  }
  runs.push({ start: numeric, count: 1, office: entry.office });
}

const index = {
  // Office ids by position; every `o` field below is an index into this.
  offices: officeIds,
  // "name\tstate\toffice\tpopulation" per line, most populous first.
  places: places.map((place) => `${place.name}\t${place.state}\t${place.office}\t${place.population}`).join("\n"),
  // "startZip.count.office" per run, ascending.
  zips: runs.map((run) => `${String(run.start).padStart(5, "0")}.${run.count}.${run.office}`).join(","),
};

const json = JSON.stringify(index);
await writeFile(new URL("../public/place-index.json", import.meta.url), json);

// Population served per office — the ranking that decides which offices are worth
// publishing pre-rendered PNGs for. Summed from the places inside each CWA, so it is
// "population in incorporated places and CDPs", not total resident population; rural
// population outside any place is not counted. It is a ranking input, not a census.
const served = new Map(officeIds.map((id) => [id, 0]));
for (const place of places) served.set(officeIds[place.office], served.get(officeIds[place.office]) + place.population);
const ranked = [...served.entries()]
  .map(([id, population]) => ({ id, population }))
  .sort((a, b) => b.population - a.population);

await mkdir(new URL("../scripts/data/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../scripts/data/office-population.json", import.meta.url),
  `${JSON.stringify(ranked, null, 2)}\n`,
);

// Candidate cities to label on each office's map, most populous first. Hand-authoring
// these stopped being viable at 125 offices — that is ~1,900 entries, each needing its
// office checked against api.weather.gov — so the candidates come from the same
// point-in-polygon pass as everything else and build-office-cities.mjs does the
// separating and gridpoint resolution. More are kept than any map will draw, because the
// spacing pass needs something to fall back to when the top few cluster in one metro.
const CANDIDATES_PER_OFFICE = 60;
const candidates = {};
// Ordered by population, falling back to land area where the estimates file has no row.
// That fallback is not cosmetic: the Census estimates one place in all of Hawaii (Urban
// Honolulu) and none at all in Puerto Rico, so HFO and SJU would otherwise be labelled
// with whatever sorted first alphabetically.
const byLabelRank = [...places].sort(
  (a, b) => b.population - a.population || b.area - a.area || a.name.localeCompare(b.name),
);
for (const place of byLabelRank) {
  const office = officeIds[place.office];
  if (!candidates[office]) candidates[office] = [];
  if (candidates[office].length >= CANDIDATES_PER_OFFICE) continue;
  candidates[office].push({
    name: place.name,
    state: place.state,
    lat: Math.round(place.lat * 1e4) / 1e4,
    lon: Math.round(place.lon * 1e4) / 1e4,
    population: place.population,
    area: place.area,
  });
}
// The national view labels the biggest cities in the country rather than any one office's.
// build-office-cities.mjs spaces them for the CONUS frame, so this only has to be a
// generous ranked pool.
candidates.US = byLabelRank
  .filter((place) => place.population > 0 && place.lat < 50 && place.lat > 24 && place.lon < -66 && place.lon > -126)
  .slice(0, 120)
  .map((place) => ({
    name: place.name,
    state: place.state,
    lat: Math.round(place.lat * 1e4) / 1e4,
    lon: Math.round(place.lon * 1e4) / 1e4,
    population: place.population,
    area: place.area,
  }));

await writeFile(
  new URL("../scripts/data/office-cities.json", import.meta.url),
  `${JSON.stringify(candidates)}\n`,
);
log(`office-cities.json: candidates for ${Object.keys(candidates).length} offices`);

log(`place-index.json: ${(json.length / 1024).toFixed(0)} KB (${places.length} places, ${runs.length} ZIP runs from ${zips.length} ZIPs)`);
log(`  sha ${createHash("sha256").update(json).digest("hex").slice(0, 12)}`);
log(`office-population.json: top 10 by population served`);
for (const [rank, office] of ranked.slice(0, 10).entries()) {
  log(`  ${String(rank + 1).padStart(2)}. ${office.id}  ${office.population.toLocaleString()}`);
}
