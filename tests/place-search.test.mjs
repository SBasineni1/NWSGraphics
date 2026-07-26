import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parsePlaceIndex, searchPlaces } from "../lib/place-search.mjs";

/**
 * A hand-built stand-in for public/place-index.json, in the same packed encoding
 * build-places.mjs emits. Small enough that every ranking assertion below can be read
 * against it directly, rather than depending on whatever the Census ships this year.
 */
const FIXTURE = parsePlaceIndex({
  offices: ["PHI", "OKX", "CTP", "HFO", "SGF"],
  places: [
    "New York\tNY\t1\t8478072",
    "Philadelphia\tPA\t0\t1573916",
    "Springfield\tMO\t4\t170188",
    "Allentown\tPA\t0\t127138",
    "Springfield\tPA\t0\t24211",
    "State College\tPA\t2\t41228",
    "Urban Honolulu\tHI\t3\t344967",
    "Mount Holly\tNJ\t0\t9536",
    "Phil Campbell\tAL\t4\t1000",
  ].join("\n"),
  // 19100–19199 → PHI, 10001–10010 → OKX, 16801–16803 → CTP.
  zips: "19100.100.0,10001.10.1,16801.3.2",
});

test("an empty or whitespace query matches nothing", () => {
  for (const query of ["", "   ", "\t"]) {
    assert.deepEqual(searchPlaces(FIXTURE, query), []);
  }
});

test("a full ZIP resolves to the office whose run contains it", () => {
  const [first] = searchPlaces(FIXTURE, "19104");
  assert.equal(first.kind, "zip");
  assert.equal(first.name, "19104");
  assert.equal(first.office, "PHI");
});

test("ZIP runs are half-open — the value past the end belongs to nobody", () => {
  assert.equal(searchPlaces(FIXTURE, "10010")[0]?.office, "OKX");
  assert.deepEqual(searchPlaces(FIXTURE, "10011"), []);
});

test("a leading-zero ZIP keeps its width", () => {
  const index = parsePlaceIndex({ offices: ["SJU"], places: "", zips: "00926.1.0" });
  const [first] = searchPlaces(index, "00926");
  assert.equal(first.office, "SJU");
  assert.equal(first.name, "00926");
});

test("a partial ZIP offers the runs it could still become", () => {
  const results = searchPlaces(FIXTURE, "168");
  assert.ok(results.length > 0, "expected partial ZIP suggestions");
  assert.ok(results.every((entry) => entry.kind === "zip"));
  assert.ok(results.every((entry) => entry.name.startsWith("168")));
});

test("a digit query never falls through to place names", () => {
  // "1" is a prefix of no town, and matching it against populations or ids would be
  // nonsense — a numeric query is a ZIP query.
  assert.ok(searchPlaces(FIXTURE, "1").every((entry) => entry.kind === "zip"));
});

test("an exact town name outranks a longer name that merely starts with it", () => {
  const [first] = searchPlaces(FIXTURE, "Philadelphia");
  assert.equal(first.name, "Philadelphia");
  assert.equal(first.office, "PHI");
});

test("a prefix matches and ranks the more populous town first", () => {
  const results = searchPlaces(FIXTURE, "Phil");
  assert.deepEqual(
    results.map((entry) => entry.name),
    ["Philadelphia", "Phil Campbell"],
  );
});

test("matching is case- and accent-insensitive", () => {
  assert.equal(searchPlaces(FIXTURE, "pHiLaDeLpHiA")[0]?.name, "Philadelphia");
});

test("same-name towns are ordered by population", () => {
  const results = searchPlaces(FIXTURE, "Springfield");
  assert.deepEqual(
    results.map((entry) => `${entry.name}, ${entry.state}`),
    ["Springfield, MO", "Springfield, PA"],
  );
});

test("a trailing state narrows the results, with or without a comma", () => {
  for (const query of ["Springfield, PA", "Springfield PA", "springfield,pa"]) {
    const results = searchPlaces(FIXTURE, query);
    assert.deepEqual(
      results.map((entry) => `${entry.name}, ${entry.state}`),
      ["Springfield, PA"],
      `query: ${query}`,
    );
  }
});

test("a later word in the name still matches, for Census-style names", () => {
  // The Census calls Honolulu "Urban Honolulu"; nobody searches for that.
  const [first] = searchPlaces(FIXTURE, "Honolulu");
  assert.equal(first.name, "Urban Honolulu");
  assert.equal(first.office, "HFO");
});

test("a word-start match outranks a mid-word one", () => {
  // "Holly" begins a word in "Mount Holly"; it appears mid-word in nothing else here,
  // so this pins the ordering rule rather than the match itself.
  const results = searchPlaces(FIXTURE, "Holly");
  assert.equal(results[0]?.name, "Mount Holly");
});

test("the limit is respected and defaults to something a menu can show", () => {
  assert.ok(searchPlaces(FIXTURE, "S").length <= 8);
  assert.equal(searchPlaces(FIXTURE, "S", { limit: 2 }).length, 2);
});

test("an unknown place matches nothing rather than guessing", () => {
  assert.deepEqual(searchPlaces(FIXTURE, "Zzyzx"), []);
});

test("results carry the office id, not an index into the office table", () => {
  for (const entry of searchPlaces(FIXTURE, "Springfield")) {
    assert.ok(FIXTURE.offices.includes(entry.office), `${entry.office} is not an office id`);
  }
});

test("the generated index parses and answers real queries", async (t) => {
  const raw = await readFile(new URL("../public/place-index.json", import.meta.url), "utf8").catch(() => null);
  if (!raw) return t.skip("public/place-index.json not built — run node scripts/build-places.mjs");
  const index = parsePlaceIndex(JSON.parse(raw));

  assert.equal(index.offices.length, 125, "every NWS office should appear in the index");
  for (const [query, office] of [
    ["Philadelphia", "PHI"],
    ["New York", "OKX"],
    ["State College", "CTP"],
    ["Baltimore", "LWX"],
    ["Los Angeles", "LOX"],
    ["Chicago", "LOT"],
    ["Honolulu", "HFO"],
    ["Anchorage", "AFC"],
    ["19104", "PHI"],
    ["60601", "LOT"],
    ["96813", "HFO"],
  ]) {
    assert.equal(searchPlaces(index, query)[0]?.office, office, `${query} should resolve to ${office}`);
  }
});
