import test from "node:test";
import assert from "node:assert/strict";

import {
  compassPoint,
  firstUsableObservation,
  formatAge,
  isUsableObservation,
  normalizeObservation,
} from "../lib/observations.mjs";

/**
 * The shape /stations/{id}/observations/latest actually returns, trimmed to the fields
 * the strip uses. Values are the SI units NWS ships — the conversion to display units is
 * what these tests are about.
 */
function rawObservation(overrides = {}) {
  return {
    station: "https://api.weather.gov/stations/KPHL",
    timestamp: "2026-08-24T20:35:00+00:00",
    textDescription: "Partly Cloudy",
    temperature: { value: 27, unitCode: "wmoUnit:degC" },
    dewpoint: { value: 13, unitCode: "wmoUnit:degC" },
    relativeHumidity: { value: 42.005936969817, unitCode: "wmoUnit:percent" },
    windSpeed: { value: 14.816, unitCode: "wmoUnit:km_h-1" },
    windGust: { value: null, unitCode: "wmoUnit:km_h-1" },
    windDirection: { value: 290, unitCode: "wmoUnit:degree_(angle)" },
    visibility: { value: 16093.44, unitCode: "wmoUnit:m" },
    barometricPressure: { value: 101388.48, unitCode: "wmoUnit:Pa" },
    heatIndex: { value: null, unitCode: "wmoUnit:degC" },
    windChill: { value: null, unitCode: "wmoUnit:degC" },
    ...overrides,
  };
}

test("converts an observation into the units the rest of the site displays", () => {
  const ob = normalizeObservation(rawObservation());
  // The nine forecast products are all °F / mph / inches, so the strip has to match or
  // the alerts page would be the one place on the site reading in metric.
  assert.equal(ob.temperature, 81);
  assert.equal(ob.dewpoint, 55);
  assert.equal(ob.relativeHumidity, 42);
  assert.equal(ob.windSpeed, 9);
  assert.equal(ob.visibility, 10);
  assert.equal(ob.pressure, 29.94);
  assert.equal(ob.text, "Partly Cloudy");
  assert.equal(ob.station, "KPHL");
});

test("keeps an unreported field null rather than turning it into zero", () => {
  // Measured at KPHL on 2026-08-24: windSpeed, windGust and seaLevelPressure were all
  // null while temperature was fine. Small airports report sparsely, so this is the
  // normal case, not a fault. Coercing null to 0 would draw a calm wind that nobody
  // observed — the same class of bug as /api/forecast's "confident 0°F map".
  const ob = normalizeObservation(rawObservation({ windSpeed: { value: null, unitCode: "wmoUnit:km_h-1" } }));
  assert.equal(ob.windSpeed, null);
  assert.equal(ob.windGust, null);
  assert.equal(ob.heatIndex, null);
  assert.equal(ob.temperature, 81, "one missing field must not discard the rest");
});

test("treats a missing property the same as an explicitly null one", () => {
  const raw = rawObservation();
  delete raw.visibility;
  assert.equal(normalizeObservation(raw).visibility, null);
});

test("an observation with no temperature is not usable", () => {
  // Temperature is what the strip leads with. A station reporting only pressure gives a
  // readout with a blank headline, so it is worth walking on to the next station.
  const usable = normalizeObservation(rawObservation());
  const useless = normalizeObservation(rawObservation({ temperature: { value: null, unitCode: "wmoUnit:degC" } }));
  assert.equal(isUsableObservation(usable), true);
  assert.equal(isUsableObservation(useless), false);
});

test("walks past stations that report nothing usable", async () => {
  // The stations endpoint is ordered by distance, not by whether the site is actually
  // reporting. The nearest one is frequently a small airport that is dark.
  const attempted = [];
  const fetchLatest = async (station) => {
    attempted.push(station);
    if (station === "KPNE") return null; // upstream 404 / no ob at all
    if (station === "KLOM") return rawObservation({ temperature: { value: null, unitCode: "wmoUnit:degC" } });
    return rawObservation();
  };

  const result = await firstUsableObservation(["KPNE", "KLOM", "KPHL", "KVAY"], fetchLatest);

  assert.equal(result.station, "KPHL");
  assert.equal(result.temperature, 81);
  assert.deepEqual(attempted, ["KPNE", "KLOM", "KPHL"], "must stop as soon as one is usable");
});

test("gives up after a bounded number of stations", async () => {
  // The whole reason this route is affordable where /api/forecast is not is that its
  // upstream cost has a ceiling. An office can carry 72 stations; walking all of them on
  // a quiet night would be the fan-out this site already learned not to do.
  const attempted = [];
  const fetchLatest = async (station) => {
    attempted.push(station);
    return null;
  };

  const result = await firstUsableObservation(["A", "B", "C", "D", "E", "F"], fetchLatest, 4);

  assert.equal(result, null);
  assert.equal(attempted.length, 4);
});

test("a station that throws does not sink the whole lookup", async () => {
  const fetchLatest = async (station) => {
    if (station === "KPNE") throw new Error("upstream 503");
    return rawObservation();
  };
  const result = await firstUsableObservation(["KPNE", "KPHL"], fetchLatest);
  assert.equal(result.station, "KPHL");
});

test("describes how stale an observation is in words", () => {
  // METARs land about every 20 minutes, so "20 min ago" is the normal reading and the
  // strip should not make it look alarming. An hours-old ob is worth noticing.
  assert.equal(formatAge(0), "just now");
  assert.equal(formatAge(1), "1 min ago");
  assert.equal(formatAge(20), "20 min ago");
  assert.equal(formatAge(59), "59 min ago");
  assert.equal(formatAge(60), "1 hr ago");
  assert.equal(formatAge(185), "3 hr ago");
});

test("turns a wind bearing into a compass point", () => {
  // A bearing reads as noise next to a plain-English conditions line; "NW" does not.
  assert.equal(compassPoint(0), "N");
  assert.equal(compassPoint(90), "E");
  assert.equal(compassPoint(180), "S");
  assert.equal(compassPoint(270), "W");
  assert.equal(compassPoint(290), "WNW");
  // Wraps rather than falling off the end of the table.
  assert.equal(compassPoint(359), "N");
  assert.equal(compassPoint(360), "N");
  assert.equal(compassPoint(null), null);
});
