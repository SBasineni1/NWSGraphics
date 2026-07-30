import { mkdir, readFile, writeFile } from "node:fs/promises";
import { AREAS } from "../lib/areas.mjs";

// Generates app/offices.ts — every NWS Weather Forecast Office, grouped by region,
// straight from the same reference map service that build-cwa.mjs takes geometry from.
// Hand-maintaining 125 offices (and which region each belongs to) is exactly the kind of
// thing that goes quietly stale, and the service already carries `region`.
//
// An office is only `ready` when the site has the assets to draw it. That is checked
// against the files on disk rather than declared — see isReady below.
const SERVICE = "https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/nws_reference_map/MapServer/1/query";

// Whether an office is drawable is *derived from the assets on disk*, not listed here.
// A hand-maintained set goes stale in the dangerous direction: marking an office ready
// before its assets exist draws a different office's map rather than failing visibly.
//
// An office needs all three — a map bundle, a lattice dense enough to interpolate, and at
// least one labelled city. The lattice floor matters: NWS publishes no gridded forecast
// over open ocean, so the Pacific domains resolve to a handful of points (PQW got 2, GUM
// 15) and would render an almost uniform field. Those stay listed but unselectable.
const MIN_LATTICE = 40;

async function countJson(path) {
  try {
    const parsed = JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
    return Array.isArray(parsed) ? parsed.length : 1;
  } catch {
    return 0;
  }
}

async function isReady(id) {
  const [bundle, lattice, cities] = await Promise.all([
    countJson(`../public/offices/${id}.json`),
    countJson(`../public/gridpoints/${id}.json`),
    countJson(`../public/cities/${id}.json`),
  ]);
  return bundle > 0 && lattice >= MIN_LATTICE && cities > 0;
}

// How the site names an office to readers, where that differs from the bare location of
// the office itself — "New York City" reads better than "Upton NY" for OKX. Offices not
// listed here fall back to their `citystate`.
const LABELS = {
  PHI: "Philadelphia / Mount Holly",
  OKX: "New York City",
  CTP: "Central Pennsylvania",
  LWX: "Baltimore / Washington",
};

// Region order is the order the picker lists them in; `hq` is where NWS headquarters
// each one, as it labels them on its own regions map.
const REGIONS = [
  { id: "eastern", short: "ER", name: "Eastern Region", hq: "Bohemia, NY" },
  { id: "central", short: "CR", name: "Central Region", hq: "Kansas City, MO" },
  { id: "southern", short: "SR", name: "Southern Region", hq: "Fort Worth, TX" },
  { id: "western", short: "WR", name: "Western Region", hq: "Salt Lake City, UT" },
  { id: "alaska", short: "AR", name: "Alaska Region", hq: "Anchorage, AK" },
  { id: "pacific", short: "PR", name: "Pacific Region", hq: "Honolulu, HI" },
];

/**
 * `citystate` is usually "Mount Holly NJ" — a trailing two-letter state, sometimes with
 * slashes in the city. Three offices don't follow it: IWX is "Northern Indiana" and the
 * two Micronesia domains are named for their area rather than a town. They carry the
 * right code in `st`, so that is the fallback rather than a special case per office.
 */
function splitCityState(value, st) {
  const match = /^(.*)\s+([A-Z]{2})$/.exec(value.trim());
  if (match) return { city: match[1].trim(), state: match[2] };
  if (!st) throw new Error(`Unparseable citystate with no state code: ${value}`);
  return { city: value.trim(), state: st };
}

const query = new URLSearchParams({
  where: "1=1",
  outFields: "wfo,cwa,citystate,region,st",
  returnGeometry: "false",
  f: "json",
});
const response = await fetch(`${SERVICE}?${query}`, { signal: AbortSignal.timeout(60_000) });
if (!response.ok) throw new Error(`Reference map service returned ${response.status}`);
const { features } = await response.json();
if (!features?.length) throw new Error("Reference map service returned no offices");

const byRegion = new Map(REGIONS.map((region) => [region.short, []]));
for (const feature of features) {
  const { cwa, citystate, region, st } = feature.attributes;
  const bucket = byRegion.get(region);
  if (!bucket) throw new Error(`${cwa} reports unknown region ${region}`);
  const { city, state } = splitCityState(citystate, st);
  bucket.push({ id: cwa, city, state, label: LABELS[cwa] ?? city, ready: await isReady(cwa) });
}
for (const bucket of byRegion.values()) bucket.sort((a, b) => a.id.localeCompare(b.id));

// The national view. Deliberately *not* inside a region — it belongs to all of them, and
// putting it in one would list it under that region in the picker. It still joins OFFICES
// so findOffice/isOfficeId resolve "US" like any other id.
const NATIONAL = {
  id: "US",
  city: "United States",
  state: "US",
  label: "National",
  ready: await isReady("US"),
};

// The unofficial multi-state areas. Like the national view they sit outside the NWS
// regions — they cut across them — but they are still Offices, so an area id resolves
// through findOffice/isOfficeId and rides the `?office=` parameter like anything else.
// Readiness is derived from assets on disk exactly as it is for a real office.
const areas = [];
for (const area of AREAS) {
  areas.push({ id: area.id, city: area.label, state: "US", label: area.label, ready: await isReady(area.id) });
}

const regionOffices = REGIONS.flatMap((region) => byRegion.get(region.short));
const offices = [...regionOffices, NATIONAL, ...areas];
if (!offices.some((office) => office.ready)) {
  throw new Error("no office has a complete asset set — run build-office-bundles → build-office-gridpoints → build-office-cities first");
}

const line = (office) =>
  `      { id: "${office.id}", city: ${JSON.stringify(office.city)}, state: "${office.state}", label: ${JSON.stringify(office.label)}${office.ready ? ", ready: true" : ""} },`;

const source = `// Generated by scripts/build-offices.mjs — do not edit by hand.
//
// Every NWS Weather Forecast Office, grouped by region, from the same reference map
// service build-cwa.mjs takes geometry from. Regenerate with:
//
//   node scripts/build-offices.mjs
//
// An office is \`ready\` only once the site has the assets to draw it — a map bundle in
// public/offices/, a lattice in public/gridpoints/ and labeled cities in public/cities/.
// That is derived from the files themselves, so this can't claim an office is drawable
// when it isn't. Offices that aren't ready are still listed, so the picker shows the real
// national map rather than pretending the country is four offices wide, but they can't be
// selected. To add one, build its assets:
//
//   build-office-bundles → build-office-gridpoints → build-office-cities → build-offices

export type OfficeId =
${offices.map((office) => `  | "${office.id}"`).join("\n")};

export type RegionId = ${REGIONS.map((region) => `"${region.id}"`).join(" | ")};

export type Office = {
  id: OfficeId;
  /** The office's own location, as NWS states it. */
  city: string;
  state: string;
  /** How the office is named to readers. */
  label: string;
  /** Whether the site has the assets to draw this office yet. */
  ready?: boolean;
};

export type Region = {
  id: RegionId;
  /** NWS's own shorthand for the region, e.g. ER. */
  short: string;
  name: string;
  /** Where NWS headquarters the region, as it labels it. */
  hq: string;
  offices: Office[];
};

export const REGIONS: Region[] = [
${REGIONS.map((region) => `  {
    id: "${region.id}",
    short: "${region.short}",
    name: "${region.name}",
    hq: "${region.hq}",
    offices: [
${byRegion.get(region.short).map(line).join("\n")}
    ],
  },`).join("\n")}
];

/** The national view, which sits above the regions rather than inside one. */
export const NATIONAL: Office = ${JSON.stringify({ id: NATIONAL.id, city: NATIONAL.city, state: NATIONAL.state, label: NATIONAL.label, ...(NATIONAL.ready ? { ready: true } : {}) })};

/**
 * The unofficial multi-state areas, defined in lib/areas.mjs.
 *
 * Not \`REGIONS\` — that is the six *official* NWS regions, which group offices
 * administratively. These cut across them and exist for regional forecasts.
 */
export const AREAS: Office[] = [
${areas.map((area) => `  ${JSON.stringify({ id: area.id, city: area.city, state: area.state, label: area.label, ...(area.ready ? { ready: true } : {}) })},`).join("\n")}
];

export const OFFICES: Office[] = [...REGIONS.flatMap((region) => region.offices), NATIONAL, ...AREAS];
export const OFFICE_IDS: OfficeId[] = OFFICES.map((office) => office.id);
/** The offices the site can actually draw today. */
export const READY_OFFICES: Office[] = OFFICES.filter((office) => office.ready);
export const DEFAULT_OFFICE: OfficeId = "PHI";

export function isOfficeId(value: string | null | undefined): value is OfficeId {
  return typeof value === "string" && (OFFICE_IDS as string[]).includes(value);
}

/**
 * Unknown ids fall back to the default office rather than erroring — and so do offices
 * that exist but have no assets yet, because rendering one would draw another office's
 * boundary rather than fail visibly.
 */
export function findOffice(value: string | null | undefined): Office {
  const office = isOfficeId(value) ? OFFICES.find((entry) => entry.id === value) : undefined;
  if (office?.ready) return office;
  return OFFICES.find((entry) => entry.id === DEFAULT_OFFICE)!;
}

export function findRegion(id: string | null | undefined) {
  return REGIONS.find((region) => region.id === id) ?? null;
}

/** The region that forecasts a given office, for opening the picker where you are. */
export function regionOf(office: OfficeId) {
  return REGIONS.find((region) => region.offices.some((entry) => entry.id === office)) ?? REGIONS[0];
}

/** The national view spans every region, so it is never "in" one. */
export function isNational(office: OfficeId) {
  return office === NATIONAL.id;
}

const AREA_IDS = AREAS.map((area) => area.id);
/** An area spans several offices and several regions, so it is never "in" one either. */
export function isArea(office: OfficeId) {
  return (AREA_IDS as string[]).includes(office);
}

/**
 * A synthetic view — the nation or an area — rather than a real forecast office.
 *
 * The distinction anything asking this actually cares about is "does a CWA back this id",
 * not which flavour of wide view it is: a wide view has no zone file to join alerts
 * against and no single office to verify a city's ownership against. Mirrors
 * \`isWideView\` in lib/areas.mjs, which the build scripts use for the same test.
 */
export function isWideView(office: OfficeId) {
  return isNational(office) || isArea(office);
}
`;

// The publisher is plain .mjs and cannot import a .ts module, so the same registry is
// emitted as JSON beside it. Generated from the identical data in the same run, so the
// two cannot drift the way a hand-kept copy would.
await mkdir(new URL("../scripts/data/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../scripts/data/offices.json", import.meta.url),
  `${JSON.stringify(offices.map(({ id, label, ready }) => ({ id, label, ready: Boolean(ready) })), null, 2)}\n`,
);

const path = new URL("../app/offices.ts", import.meta.url);
const previous = await readFile(path, "utf8").catch(() => "");
await writeFile(path, source);
console.log(`wrote app/offices.ts: ${offices.length} offices across ${REGIONS.length} regions, ${offices.filter((o) => o.ready).length} ready (was ${previous.split("id: \"").length - 1} entries)`);
for (const region of REGIONS) {
  const bucket = byRegion.get(region.short);
  console.log(`  ${region.short} ${region.name}: ${bucket.length} offices, ${bucket.filter((o) => o.ready).length} ready`);
}
