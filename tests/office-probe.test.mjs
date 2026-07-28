import assert from "node:assert/strict";
import test from "node:test";

import {
  anchorFor,
  gridpointUrl,
  officeIsStale,
  probeAnchor,
  staleOfficesFrom,
} from "../lib/office-probe.mjs";
import { pooled } from "../lib/pooled.mjs";

const CITY = { name: "Albany", wfo: "ALY", x: 70, y: 63 };

test("the anchor is the first city, and a labelless office has none", () => {
  assert.deepEqual(anchorFor([CITY, { name: "Troy", wfo: "ALY", x: 71, y: 64 }]), CITY);
  assert.equal(anchorFor([]), null);
  assert.equal(anchorFor(undefined), null);
});

test("the probe URL addresses the gridpoint domain, not the office", () => {
  // AFC's cities are forecast from AER/ALU; `wfo` is the domain and is what the
  // gridpoint API accepts. Using the office id here 404s for every Alaskan city.
  assert.equal(
    gridpointUrl({ wfo: "AER", x: 100, y: 120 }),
    "https://api.weather.gov/gridpoints/AER/100,120",
  );
});

test("a probe returns last-modified and never throws", async () => {
  const ok = async () => ({ ok: true, headers: new Headers({ "last-modified": "Mon, 27 Jul 2026 12:37:13 GMT" }) });
  assert.equal(await probeAnchor(CITY, ok), "Mon, 27 Jul 2026 12:37:13 GMT");

  const notFound = async () => ({ ok: false, headers: new Headers() });
  assert.equal(await probeAnchor(CITY, notFound), null);

  const boom = async () => { throw new Error("network down"); };
  assert.equal(await probeAnchor(CITY, boom), null);

  assert.equal(await probeAnchor(null, ok), null);
});

test("unknown on either side counts as stale", () => {
  // Refetching costs time; skipping a genuinely updated office serves a stale forecast
  // until the next run, so uncertainty always resolves towards refreshing.
  assert.equal(officeIsStale("A", "B"), true);
  assert.equal(officeIsStale("A", "A"), false);
  assert.equal(officeIsStale(undefined, "A"), true);
  assert.equal(officeIsStale(null, "A"), true);
  assert.equal(officeIsStale("A", null), true);
  assert.equal(officeIsStale(null, null), true);
});

test("forcePublish makes every office stale regardless of probes", () => {
  const offices = ["ALY", "OKX"];
  const probes = { ALY: "A", OKX: "B" };
  const index = { ALY: { probe: "A" }, OKX: { probe: "B" } };
  assert.deepEqual(staleOfficesFrom(offices, probes, index, false), []);
  assert.deepEqual(staleOfficesFrom(offices, probes, index, true), ["ALY", "OKX"]);
});

test("only the offices whose probe moved are stale", () => {
  const offices = ["ALY", "OKX", "PHI"];
  const probes = { ALY: "A2", OKX: "B", PHI: "C" };
  const index = { ALY: { probe: "A1" }, OKX: { probe: "B" } };
  // PHI has no index entry at all — never published, so it must be picked up.
  assert.deepEqual(staleOfficesFrom(offices, probes, index, false), ["ALY", "PHI"]);
});

test("pooled runs every item and never exceeds the limit", async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  const seen = [];
  let inFlight = 0;
  let peak = 0;
  await pooled(items, 4, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((done) => setTimeout(done, 1));
    seen.push(item);
    inFlight -= 1;
  });
  assert.equal(seen.length, 20);
  assert.deepEqual([...seen].sort((a, b) => a - b), items);
  assert.ok(peak <= 4, `peak concurrency was ${peak}`);
});

test("pooled tolerates a limit larger than the item count", async () => {
  const seen = [];
  await pooled(["a"], 12, async (item) => { seen.push(item); });
  assert.deepEqual(seen, ["a"]);
});
