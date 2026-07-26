// ZIP / town search over the index scripts/build-places.mjs generates.
//
// Kept as plain .mjs beside lib/map-frame.mjs so the ranking rules can be tested in Node
// directly — they are the whole substance of the feature, and asserting them through a
// rendered React tree would test the menu instead.
//
// The index is the packed form build-places.mjs writes: offices as a lookup table, places
// as tab-separated lines ordered most-populous-first, ZIPs run-length encoded. Parsing is
// done once, at load, not per keystroke.

/** @typedef {{ offices: string[], places: string, zips: string }} RawPlaceIndex */
/** @typedef {{ name: string, fold: string, state: string, office: number, population: number }} IndexedPlace */
/** @typedef {{ start: number, count: number, office: number }} ZipRun */
/** @typedef {{ offices: string[], places: IndexedPlace[], zips: ZipRun[] }} PlaceIndex */
/** @typedef {{ kind: "place" | "zip", name: string, state: string, office: string, population: number }} PlaceMatch */

const DEFAULT_LIMIT = 8;

/**
 * Lowercase, strip accents, and drop the punctuation that people leave out when typing —
 * "St. Louis" has to be reachable from "st louis", and "Coeur d'Alene" from "coeur dalene".
 * @param {string} value
 */
export function fold(value) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * @param {RawPlaceIndex} raw
 * @returns {PlaceIndex}
 */
export function parsePlaceIndex(raw) {
  const places = [];
  for (const line of raw.places.split("\n")) {
    if (!line) continue;
    const [name, state, office, population] = line.split("\t");
    places.push({ name, fold: fold(name), state, office: Number(office), population: Number(population) });
  }
  const zips = [];
  for (const entry of raw.zips.split(",")) {
    if (!entry) continue;
    const [start, count, office] = entry.split(".");
    zips.push({ start: Number(start), count: Number(count), office: Number(office) });
  }
  // Both ZIP lookups below scan in order and stop early, so the ordering is sorted here
  // rather than trusted from the encoder — a generator change that reordered the runs
  // would otherwise turn into silently missing search results.
  zips.sort((a, b) => a.start - b.start);
  return { offices: raw.offices, places, zips };
}

/**
 * The office owning a ZIP, or null when no ZCTA covers it. PO-box-only ZIPs genuinely
 * have no ZCTA, so "not found" is a real answer and not a gap in the data.
 * @param {PlaceIndex} index
 * @param {number} zip
 */
function officeForZip(index, zip) {
  for (const run of index.zips) {
    if (run.start > zip) break;
    if (zip < run.start + run.count) return run.office;
  }
  return null;
}

const zipName = (zip) => String(zip).padStart(5, "0");

/**
 * Whole ZIPs resolve exactly; a partial one offers the runs it could still grow into, one
 * suggestion per run so the list stays short instead of enumerating a hundred ZIPs.
 * @param {PlaceIndex} index
 * @param {string} digits
 * @param {number} limit
 * @returns {PlaceMatch[]}
 */
function searchZips(index, digits, limit) {
  const match = (office, zip) => ({
    kind: /** @type {const} */ ("zip"),
    name: zipName(zip),
    state: "",
    office: index.offices[office],
    population: 0,
  });

  if (digits.length === 5) {
    const office = officeForZip(index, Number(digits));
    return office === null ? [] : [match(office, Number(digits))];
  }

  const span = 10 ** (5 - digits.length);
  const low = Number(digits) * span;
  const high = low + span - 1;
  const results = [];
  for (const run of index.zips) {
    if (run.start > high) break;
    const first = Math.max(run.start, low);
    if (first > Math.min(run.start + run.count - 1, high)) continue;
    results.push(match(run.office, first));
    if (results.length >= limit) break;
  }
  return results;
}

// Lower sorts first. The tiers are what stop "Phil" putting Phil Campbell, Alabama above
// Philadelphia: an exact name beats a prefix, a prefix beats a later word, and a word
// start beats a match buried mid-word.
const EXACT = 0;
const PREFIX = 1;
const WORD = 2;
const ANYWHERE = 3;

/**
 * @param {IndexedPlace} place
 * @param {string} needle
 */
function tierOf(place, needle) {
  if (place.fold === needle) return EXACT;
  if (place.fold.startsWith(needle)) return PREFIX;
  const at = place.fold.indexOf(needle);
  if (at === -1) return null;
  return place.fold[at - 1] === " " ? WORD : ANYWHERE;
}

/**
 * @param {PlaceIndex} index
 * @param {string} needle
 * @param {string | null} state two-letter USPS code, or null for any
 * @param {number} limit
 * @returns {PlaceMatch[]}
 */
function searchNames(index, needle, state, limit) {
  const scored = [];
  for (const place of index.places) {
    if (state && place.state !== state) continue;
    const tier = tierOf(place, needle);
    if (tier === null) continue;
    scored.push({ tier, place });
  }
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      b.place.population - a.place.population ||
      a.place.name.localeCompare(b.place.name) ||
      a.place.state.localeCompare(b.place.state),
  );
  return scored.slice(0, limit).map(({ place }) => ({
    kind: /** @type {const} */ ("place"),
    name: place.name,
    state: place.state,
    office: index.offices[place.office],
    population: place.population,
  }));
}

/**
 * @param {PlaceIndex} index
 * @param {string} query
 * @param {{ limit?: number }} [options]
 * @returns {PlaceMatch[]}
 */
export function searchPlaces(index, query, { limit = DEFAULT_LIMIT } = {}) {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // A numeric query is a ZIP query and nothing else — "1" is a prefix of no town, and
  // letting digits fall through to names would rank on population for no reason. ZIP+4 is
  // accepted because it is what gets pasted out of an address.
  const digits = /^\d{1,5}(?:-\d{0,4})?$/.test(trimmed) ? trimmed.replace(/-.*$/, "") : null;
  if (digits) return searchZips(index, digits, limit);

  const needle = fold(trimmed);
  if (!needle) return [];

  // "Springfield, PA" and "Springfield PA" both mean the same thing. Only treat the
  // trailing pair as a state when doing so actually finds something — otherwise a real
  // name that happens to end in two letters ("Lake Ki", "Del Rio") would be truncated
  // into nonsense.
  const qualified = /^(.*[a-z0-9])\s+([a-z]{2})$/.exec(needle);
  if (qualified) {
    const state = qualified[2].toUpperCase();
    const narrowed = searchNames(index, qualified[1], state, limit);
    if (narrowed.length) return narrowed;
  }

  return searchNames(index, needle, null, limit);
}
