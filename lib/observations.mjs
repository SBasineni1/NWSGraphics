// The latest surface observation for one location, normalised for display.
//
// Plain .mjs beside map-frame.mjs and place-search.mjs, for the same reason: Node can
// import it directly under `node --test`, so the unit conversions and the station walk
// are testable without a build or a network. It is type-checked via the `lib/**/*.mjs`
// entry in tsconfig.json.
//
// This is deliberately pure. Everything that touches api.weather.gov lives in
// app/api/observations/route.ts and reaches the walk below through an injected fetcher.

/** How many stations to try before giving up. See `firstUsableObservation`. */
export const STATION_ATTEMPT_LIMIT = 4;

const COMPASS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

/**
 * A CAP-style measurement is `{ value, unitCode }`, and `value` is null whenever the
 * station did not report it. A property can also be absent entirely.
 * @param {unknown} measurement
 * @returns {number | null}
 */
function rawValue(measurement) {
  if (!measurement || typeof measurement !== "object") return null;
  const { value } = /** @type {{ value?: unknown }} */ (measurement);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Convert and round, preserving null. Every field the strip shows goes through here, so
 * "not reported" stays distinguishable from a real reading all the way to the markup —
 * a null coerced to 0 would render as a calm wind or a 32°F temperature that nobody
 * observed.
 * @param {unknown} measurement
 * @param {(value: number) => number} convert
 * @param {number} [decimals]
 * @returns {number | null}
 */
function scaled(measurement, convert, decimals = 0) {
  const value = rawValue(measurement);
  if (value === null) return null;
  const factor = 10 ** decimals;
  return Math.round(convert(value) * factor) / factor;
}

/**
 * The 16-point compass bearing, or null when the wind direction was not reported. A
 * bearing in degrees reads as noise beside a plain-English conditions line.
 * @param {number | null | undefined} degrees
 * @returns {string | null}
 */
export function compassPoint(degrees) {
  if (typeof degrees !== "number" || !Number.isFinite(degrees)) return null;
  return COMPASS[Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16];
}

/**
 * How stale the observation is, in words. METARs land roughly every 20 minutes, so
 * "20 min ago" is the ordinary reading and should not look like a fault.
 * @param {number} minutes
 * @returns {string}
 */
export function formatAge(minutes) {
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${Math.floor(minutes)} min ago`;
  return `${Math.floor(minutes / 60)} hr ago`;
}

/**
 * @typedef {object} Observation
 * @property {string} station        Bare station identifier, e.g. "KPHL".
 * @property {string | null} timestamp
 * @property {string | null} text    NWS's own plain-English summary, e.g. "Partly Cloudy".
 * @property {number | null} temperature      °F
 * @property {number | null} dewpoint         °F
 * @property {number | null} relativeHumidity %
 * @property {number | null} windSpeed        mph
 * @property {number | null} windGust         mph
 * @property {number | null} windDirection    degrees
 * @property {string | null} windCompass      16-point bearing
 * @property {number | null} visibility       statute miles
 * @property {number | null} pressure         inHg
 * @property {number | null} heatIndex        °F
 * @property {number | null} windChill        °F
 */

const toFahrenheit = (celsius) => celsius * 9 / 5 + 32;
const toMilesPerHour = (kilometresPerHour) => kilometresPerHour * 0.621371;

/**
 * Reshape one `/observations/latest` payload into display units.
 * @param {Record<string, any>} raw the `properties` object from the upstream response
 * @returns {Observation}
 */
export function normalizeObservation(raw) {
  const properties = raw ?? {};
  const windDirection = rawValue(properties.windDirection);
  return {
    // `station` ships as a full URL; only the identifier is worth showing.
    station: String(properties.station ?? "").split("/").pop() || "",
    timestamp: typeof properties.timestamp === "string" ? properties.timestamp : null,
    text: typeof properties.textDescription === "string" && properties.textDescription
      ? properties.textDescription
      : null,
    temperature: scaled(properties.temperature, toFahrenheit),
    dewpoint: scaled(properties.dewpoint, toFahrenheit),
    relativeHumidity: scaled(properties.relativeHumidity, (value) => value),
    windSpeed: scaled(properties.windSpeed, toMilesPerHour),
    windGust: scaled(properties.windGust, toMilesPerHour),
    windDirection,
    windCompass: compassPoint(windDirection),
    visibility: scaled(properties.visibility, (metres) => metres / 1609.344),
    pressure: scaled(properties.barometricPressure, (pascals) => pascals / 3386.389, 2),
    heatIndex: scaled(properties.heatIndex, toFahrenheit),
    windChill: scaled(properties.windChill, toFahrenheit),
  };
}

/**
 * Temperature is what the readout leads with, so an observation without one is not worth
 * showing even if it carries pressure and visibility.
 * @param {Observation | null} observation
 * @returns {boolean}
 */
export function isUsableObservation(observation) {
  return Boolean(observation) && observation.temperature !== null;
}

/**
 * Walk a distance-ordered station list until one reports something usable.
 *
 * The stations endpoint orders by distance, not by whether the site is actually
 * reporting — the nearest is often a small airport that is dark, and even a major one
 * has holes (KPHL reported a null windSpeed when this was written). So a single lookup
 * of the closest station is not enough.
 *
 * **The walk is capped.** An office can carry 72 stations; trying all of them on a quiet
 * night would be the per-point fan-out that keeps /api/forecast off the production path.
 * The ceiling is what makes this route affordable.
 *
 * @param {string[]} stations distance-ordered station identifiers
 * @param {(station: string) => Promise<Record<string, any> | null>} fetchLatest
 * @param {number} [limit]
 * @returns {Promise<Observation | null>}
 */
export async function firstUsableObservation(stations, fetchLatest, limit = STATION_ATTEMPT_LIMIT) {
  for (const station of stations.slice(0, limit)) {
    let raw;
    try {
      raw = await fetchLatest(station);
    } catch {
      // One dark station is not a failed lookup — that is the case this walk exists for.
      continue;
    }
    if (!raw) continue;
    const observation = normalizeObservation(raw);
    if (isUsableObservation(observation)) return observation;
  }
  return null;
}
