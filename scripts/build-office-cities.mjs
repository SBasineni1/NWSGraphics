import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { plotExtent, project, PLOT_WIDTH, MAP_HEIGHT } from "../lib/map-frame.mjs";

// Picks the cities labelled on each office's map and resolves them to NWS gridpoints,
// writing public/cities/{OFFICE}.json.
//
//   node scripts/build-office-cities.mjs [--only PHI,OKX]
//
// Replaces the hand-authored CITIES table in build-city-points.mjs, which covered four
// offices in ~60 entries. At 125 offices that table would be ~1,750 entries, each needing
// its office verified by hand against api.weather.gov — not viable, and easy to get wrong
// near a CWA border.
//
// Candidates come from scripts/data/office-cities.json (build-places.mjs), already
// assigned to an office by point-in-polygon against the same CWA geometry the renderer
// draws. **The office is still taken from api.weather.gov, not assumed**: the candidate
// list decides *which* towns are interesting, the API decides which office owns them, and
// a town the API assigns elsewhere is dropped. That keeps the original script's guarantee
// — a city is never labelled on a map that does not forecast it — without hand-filing.

const USER_AGENT = "NWS Forecast Graphics (github.com/suchitbasineni/NWSGraphics)";
const TARGET = 14;
// Labels are drawn as a value above a dot with the city name below, roughly 90×34 px on
// the 900×760 map. 66 px is not a guess: the hand-authored PHI layout this replaces put
// its closest pair (Morristown/Somerville) 62 px apart, with every other neighbour at
// 91-144 px. So 62 is the tightest a human accepted, and 66 sits just above it — at 96 px
// the same map lost seven of its seventeen labels.
const MIN_SEPARATION_PX = 66;
// If spacing leaves a sparse office with too few labels, the requirement is relaxed
// rather than shipping a nearly bare map.
const MIN_LABELS = 8;
const RELAXED_SEPARATION_PX = 58;
const CONCURRENCY = 8;

const args = process.argv.slice(2);
const onlyArg = args.indexOf("--only");
const only = onlyArg === -1 ? null : new Set(args[onlyArg + 1].split(","));

const candidates = JSON.parse(await readFile(new URL("../scripts/data/office-cities.json", import.meta.url), "utf8"));
const bundleDir = new URL("../public/offices/", import.meta.url);
const names = (await readdir(bundleDir)).filter((name) => name.endsWith(".json")).sort();

/** Greedy pick in rank order, keeping every accepted label at least `gap` pixels apart. */
function spread(list, toPixel, gap) {
  const kept = [];
  for (const city of list) {
    const [x, y] = toPixel(city);
    // Off-frame candidates exist: a place can sit inside the CWA but outside the drawn
    // frame is impossible, yet a place near the edge can project just past it.
    if (x < 8 || x > PLOT_WIDTH - 8 || y < 8 || y > MAP_HEIGHT - 8) continue;
    if (kept.some((other) => Math.hypot(other.x - x, other.y - y) < gap)) continue;
    kept.push({ ...city, x, y });
    if (kept.length >= TARGET) break;
  }
  return kept;
}

async function resolve(city) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`https://api.weather.gov/points/${city.lat.toFixed(4)},${city.lon.toFixed(4)}`, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`points ${response.status}`);
      const properties = (await response.json()).properties;
      if (!properties?.gridId || properties.gridX == null || properties.gridY == null) return null;
      // `cwa` is the forecast office; `gridId` is the gridpoint domain the forecast is
      // fetched from. They are the same string everywhere in CONUS, which is why the
      // four-office original could conflate them — but NWS splits Alaska's AFC into the
      // AER and ALU gridpoint domains, so comparing gridId to the office rejected every
      // city in Anchorage's area and left AFC with no labels at all.
      return { cwa: properties.cwa ?? properties.gridId, wfo: properties.gridId, x: properties.gridX, y: properties.gridY };
    } catch {
      if (attempt === 2) return null;
      await new Promise((done) => setTimeout(done, 400 * 2 ** attempt));
    }
  }
  return null;
}

const outDir = new URL("../public/cities/", import.meta.url);
await mkdir(outDir, { recursive: true });

const summary = [];
const started = Date.now();

for (const name of names) {
  const bundle = JSON.parse(await readFile(new URL(name, bundleDir), "utf8"));
  const office = bundle.office;
  if (only && !only.has(office)) continue;

  const pool = candidates[office] ?? [];
  const extent = plotExtent(bundle.bounds, PLOT_WIDTH, MAP_HEIGHT, bundle.zoom);
  const shift = bundle.bounds.east > 180 ? (lon) => (lon < 0 ? lon + 360 : lon) : (lon) => lon;
  const toPixel = (city) => project(shift(city.lon), city.lat, extent, 0, 0, PLOT_WIDTH, MAP_HEIGHT);

  let picked = spread(pool, toPixel, MIN_SEPARATION_PX);
  if (picked.length < MIN_LABELS) picked = spread(pool, toPixel, RELAXED_SEPARATION_PX);

  // Resolved in parallel within an office, serially across them, so the API sees a steady
  // trickle rather than 1,750 requests at once.
  const resolved = [];
  for (let index = 0; index < picked.length; index += CONCURRENCY) {
    const batch = picked.slice(index, index + CONCURRENCY);
    const grids = await Promise.all(batch.map((city) => resolve(city)));
    grids.forEach((grid, offset) => {
      const city = batch[offset];
      // The API is the authority on ownership. A candidate it assigns to a neighbour is
      // dropped rather than relabelled — labelling a town on a map that does not forecast
      // it is the exact failure the hand-authored table's verification existed to prevent.
      if (!grid || grid.cwa !== office) return;
      resolved.push({
        id: `${office}-${city.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
        name: city.name,
        state: city.state,
        office,
        // The gridpoint domain to fetch from, which is not always the office id.
        wfo: grid.wfo,
        lat: city.lat,
        lon: city.lon,
        x: grid.x,
        y: grid.y,
      });
    });
  }

  await writeFile(new URL(`${office}.json`, outDir), JSON.stringify(resolved));
  summary.push({ office, kept: resolved.length, considered: pool.length, dropped: picked.length - resolved.length });
  process.stdout.write(`\r  ${summary.length}/${names.length} offices, ${Math.round((Date.now() - started) / 1000)}s   `);
}
process.stdout.write("\n");

summary.sort((a, b) => a.kept - b.kept);
const total = summary.reduce((sum, entry) => sum + entry.kept, 0);
console.log(`public/cities/: ${summary.length} offices, ${total} labelled cities, ${Math.round((Date.now() - started) / 1000)}s`);
console.log(`  mean ${(total / summary.length).toFixed(1)} per office`);
const thin = summary.filter((entry) => entry.kept < MIN_LABELS);
if (thin.length) console.log(`  thin (<${MIN_LABELS}): ${thin.map((entry) => `${entry.office} ${entry.kept}`).join(", ")}`);
const dropped = summary.reduce((sum, entry) => sum + entry.dropped, 0);
console.log(`  ${dropped} candidates dropped because api.weather.gov assigns them to another office`);
