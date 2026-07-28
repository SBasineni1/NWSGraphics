# Forecast Freshness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut reissue-to-visible latency from ~60 minutes to ~15, and put the forecast's
issuance time on the page so a frozen publisher is visible in minutes instead of hours.

**Architecture:** Three independent changes sharing one extracted probe module. The
publisher gains an exit *before* its fetch phase so an idle run is cheap; the workflow
runs a dependency-free probe before `npm ci` so an idle run skips the build entirely,
which is what makes a denser cron affordable; and a new one-subrequest edge route reports
NWS's latest revision time so the client can display what it is looking at and how old it
is.

**Tech Stack:** Node 22 ESM, Next.js 16 App Router (edge runtime for the new route),
React 19, `node:test`, GitHub Actions, Cloudflare R2 over the S3 client.

**Spec:** `docs/superpowers/specs/2026-07-27-forecast-freshness-design.md`

## Global Constraints

- **Never `Number(process.env.X ?? default)`.** GitHub renders an unset `vars.*` as the
  empty string, so `??` does not fire and `Number("")` is `0`. Use
  `const s = process.env.X?.trim(); const v = s ? Number(s) : default;`. A regression test
  in `tests/rendered-html.test.mjs` enforces this across every variable the workflow
  passes through.
- **An unknown probe means changed, never unchanged.** Refetching costs time; skipping a
  genuinely updated office serves a stale forecast until the next run.
- **The `sourceRevision` clause in the short-circuit is load-bearing.** A new deploy must
  re-render even when NWS has not moved — that is how a newly added product reaches
  already-published offices.
- **The indicator states facts, not a verdict.** "Issued 12:37 · NWS revised 13:10", not
  a binary STALE badge. See the spec's *Why not a STALE badge*.
- **`WARN_AFTER_MS = 90 * 60 * 1000` is an unmeasured placeholder.** Ship it, then set it
  from real revision-interval data once the freshness route has been live a while.
- **Shared logic lives in `lib/*.mjs`**, plain ESM so `node --test` imports it directly.
  It is type-checked through the `lib/**/*.mjs` entry in `tsconfig.json`. App code imports
  it by relative path, as `ForecastGraphic.tsx:6` already does.
- **`npm test` builds first.** For fast iteration on pure-logic tests run
  `node --test tests/<file>.test.mjs` directly; run the full `npm test` before the final
  commit of each task.

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `lib/pooled.mjs` | Bounded-concurrency helper, shared by the publisher and the probe script |
| `lib/office-probe.mjs` | Anchor selection, gridpoint probe URL, `HEAD` probe, staleness comparison |
| `lib/forecast-freshness.mjs` | Issued-vs-revised comparison and the warning threshold |
| `scripts/probe-offices.mjs` | Dependency-free pre-build gate; writes `changed` to `$GITHUB_OUTPUT` |
| `app/api/forecast-freshness/route.ts` | One `HEAD` per request; returns NWS's latest revision time |
| `tests/office-probe.test.mjs` | Probe and staleness rules |
| `tests/forecast-freshness.test.mjs` | Comparison and threshold rules |

**Modified:**

| Path | Change |
|---|---|
| `scripts/publish-forecast-plots.mjs` | Import the shared modules; add the probe-level short-circuit above the fetch phase |
| `.github/workflows/publish-forecast-plots.yml` | Pre-build probe gate; denser cron |
| `app/components/ForecastGraphic.tsx` | Fetch freshness; render issuance and revision times |
| `app/globals.css` | `.freshness` styles in the sidebar footer |
| `tests/rendered-html.test.mjs` | Pin short-circuit ordering; realign the cron assertion |
| `package.json` | Add the two new test files to the `test` script |

---

### Task 1: Shared probe module

**Files:**
- Create: `lib/pooled.mjs`
- Create: `lib/office-probe.mjs`
- Test: `tests/office-probe.test.mjs`
- Modify: `package.json` (the `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pooled(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void>`
  - `anchorFor(cities: {wfo: string, x: number, y: number}[]): {wfo, x, y} | null`
  - `gridpointUrl(anchor: {wfo, x, y}): string`
  - `probeAnchor(anchor, fetchImpl: typeof fetch): Promise<string | null>`
  - `officeIsStale(previousProbe: string | null | undefined, currentProbe: string | null): boolean`
  - `staleOfficesFrom(offices: string[], probes: Record<string, string|null>, previousIndex: Record<string, {probe?: string|null}>, forcePublish: boolean): string[]`
  - `PROBE_USER_AGENT: string`

- [ ] **Step 1: Write the failing test**

Create `tests/office-probe.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/office-probe.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/office-probe.mjs'`

- [ ] **Step 3: Create `lib/pooled.mjs`**

```js
/**
 * Run `task` over `items` with at most `limit` in flight.
 *
 * Shared by the publisher and the pre-build probe gate so both bound their pressure on
 * api.weather.gov the same way. Kept as its own module rather than exported from
 * office-probe.mjs because it knows nothing about offices.
 */
export async function pooled(items, limit, task) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await task(items[index]);
    }
  });
  await Promise.all(workers);
}
```

- [ ] **Step 4: Create `lib/office-probe.mjs`**

```js
// When NWS last revised an office's grids, for the cost of a request that downloads
// nothing.
//
// A GET on a gridpoint is ~285 KB; HEAD returns the same `last-modified` with a zero-byte
// body. That is what makes probing 122 offices affordable: refreshing them all blindly
// would be ~35,000 upstream requests every run.
//
// Plain .mjs beside map-frame.mjs and place-search.mjs so node --test imports it
// directly, and so the publisher, the pre-build probe gate and the edge route all share
// one implementation instead of three that can drift.

export const PROBE_USER_AGENT = "NWS Forecast Graphics (github.com/suchitbasineni/NWSGraphics)";

/**
 * The city a probe speaks for. The list is already ordered by the ranking
 * build-office-cities.mjs applied, so the first entry is the office's most significant
 * place and a fine stand-in for the office as a whole.
 */
export function anchorFor(cities) {
  if (!Array.isArray(cities) || !cities.length) return null;
  return cities[0];
}

/**
 * `wfo` is the *gridpoint domain*, which is not the office id outside CONUS: NWS splits
 * AFC into AER and ALU. The gridpoint API only accepts the domain.
 */
export function gridpointUrl(anchor) {
  return `https://api.weather.gov/gridpoints/${anchor.wfo}/${anchor.x},${anchor.y}`;
}

/** `last-modified` for one anchor, or null if it cannot be established. */
export async function probeAnchor(anchor, fetchImpl) {
  if (!anchor) return null;
  try {
    const response = await fetchImpl(gridpointUrl(anchor), {
      method: "HEAD",
      headers: { "User-Agent": PROBE_USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    return response.headers.get("last-modified");
  } catch {
    return null;
  }
}

/** Unknown on either side means we cannot prove it is unchanged, so refresh it. */
export function officeIsStale(previousProbe, currentProbe) {
  if (!previousProbe || !currentProbe) return true;
  return previousProbe !== currentProbe;
}

/** The offices a run must refetch. */
export function staleOfficesFrom(offices, probes, previousIndex, forcePublish) {
  return offices.filter((office) => {
    if (forcePublish) return true;
    return officeIsStale(previousIndex[office]?.probe, probes[office] ?? null);
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/office-probe.test.mjs`
Expected: PASS, 8 tests

- [ ] **Step 6: Register the test file**

In `package.json`, change the `test` script to append `tests/office-probe.test.mjs`:

```json
"test": "npm run build && node --test tests/rendered-html.test.mjs tests/place-search.test.mjs tests/map-frame.test.mjs tests/office-probe.test.mjs"
```

- [ ] **Step 7: Commit**

```bash
git add lib/pooled.mjs lib/office-probe.mjs tests/office-probe.test.mjs package.json
git commit -m "Extract the office probe into a shared, tested module"
```

---

### Task 2: Probe-level short-circuit in the publisher

**Files:**
- Modify: `scripts/publish-forecast-plots.mjs` (probe section ~176–199; exit at ~315–327)
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `pooled`, `anchorFor`, `probeAnchor`, `staleOfficesFrom` from Task 1.
- Produces: no new exports. The publisher is a script, not a module.

**Why this ordering matters:** today the only `process.exit(0)` is *after* the fetch
phase, and `toFetch` always includes every render-tier office. So a run where nothing
changed still issues ~7,250 upstream requests before it is allowed to conclude there was
nothing to do. Every later task's cost model depends on fixing that.

- [ ] **Step 1: Write the failing test**

Add to `tests/rendered-html.test.mjs`, next to the other publisher assertions:

```js
test("an unchanged run exits before it fetches anything", async () => {
  const publisher = await readFile(new URL("../scripts/publish-forecast-plots.mjs", import.meta.url), "utf8");
  // The probe is the cheap part (one zero-byte HEAD per office); the fetch is the
  // expensive part (~290 gridpoint requests per office, and every render-tier office is
  // fetched unconditionally). Exiting between them is the entire point of this check, so
  // pin the ordering — a refactor that moves the exit back below the fetch would leave
  // every other assertion here passing.
  const shortCircuit = publisher.indexOf("nothing to publish");
  const fetchPhase = publisher.indexOf("const forecasts = {}");
  assert.ok(shortCircuit > 0, "no probe-level short-circuit found");
  assert.ok(fetchPhase > 0, "fetch phase marker not found");
  assert.ok(shortCircuit < fetchPhase, "the short-circuit must come before the fetch phase");

  // A new deploy must re-render even when NWS has not moved — that is how a newly added
  // product reaches an already-published office.
  assert.match(publisher, /previous\?\.sourceRevision === sourceRevision/);
  // One probe implementation, shared with the pre-build gate.
  assert.match(publisher, /from "\.\.\/lib\/office-probe\.mjs"/);
  assert.match(publisher, /from "\.\.\/lib\/pooled\.mjs"/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern="exits before it fetches" tests/rendered-html.test.mjs`
Expected: FAIL — `no probe-level short-circuit found`

- [ ] **Step 3: Import the shared modules**

At the top of `scripts/publish-forecast-plots.mjs`, after the existing imports:

```js
import { anchorFor, probeAnchor, staleOfficesFrom } from "../lib/office-probe.mjs";
import { pooled } from "../lib/pooled.mjs";
```

Then delete the local `pooled` function (around line 385) and replace the body of
`probeOffice` so it delegates, keeping the file read that only Node can do:

```js
async function probeOffice(office) {
  try {
    const cities = JSON.parse(await readFile(new URL(`../public/cities/${office}.json`, import.meta.url), "utf8"));
    return await probeAnchor(anchorFor(cities), fetch);
  } catch {
    // A probe that fails is treated as "changed": refetching costs time, skipping an
    // office that really did update would serve a stale forecast until the next run.
    return null;
  }
}
```

- [ ] **Step 4: Replace the staleness computation and add the short-circuit**

Replace the `staleOffices` block (currently `const staleOffices = DATA_OFFICES.filter(...)`
through the `console.error("probed ...")` line) with:

```js
const staleOffices = staleOfficesFrom(DATA_OFFICES, probes, previousIndex, forcePublish);
console.error(`probed ${DATA_OFFICES.length} offices in ${((Date.now() - probeStarted) / 1000).toFixed(1)}s: ${staleOffices.length} changed`);

// Exit before the fetch phase, not after it. The fetch is ~290 gridpoint requests per
// office and every render-tier office is fetched unconditionally, so a run that reaches
// the old exit at the bottom has already spent ~7,250 upstream requests discovering it
// had nothing to do. That cost is what kept the schedule hourly.
const previous = await currentManifest();
if (!forcePublish && !staleOffices.length && previous?.sourceRevision === sourceRevision) {
  console.log(JSON.stringify({
    published: false,
    reason: "nothing to publish",
    updatedAt: previous?.updatedAt ?? null,
    forecastsRefreshed: 0,
  }));
  process.exit(0);
}
```

- [ ] **Step 5: Remove the now-duplicated manifest read**

Further down, the existing `const previous = await currentManifest();` (just above
`renderUnchanged`) is now a redeclaration. Delete that single line. Leave
`renderUnchanged` and its `process.exit(0)` exactly as they are — that check covers a
different case: data moved but the render tier did not, so the data tier still publishes
and only rendering is skipped.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/rendered-html.test.mjs tests/office-probe.test.mjs`
Expected: PASS for the new test. The pre-existing `publishes changed forecast canvases on
the issuance-aware schedule` failure (a stale cron assertion) is expected here and is
fixed in Task 3.

- [ ] **Step 7: Verify the script still parses and the short-circuit fires**

Run: `PLOT_OUTPUT_ONLY=true PLOT_OFFICES=ALY node scripts/publish-forecast-plots.mjs`
Expected: it probes one office and proceeds (there is no R2 base locally, so
`currentManifest()` returns null and the short-circuit correctly does not fire). Confirm
the log line `probed 1 offices` appears and no `ReferenceError` is thrown. Interrupt it
once it starts fetching — the point is that it parses and reaches the fetch phase.

- [ ] **Step 8: Commit**

```bash
git add scripts/publish-forecast-plots.mjs tests/rendered-html.test.mjs
git commit -m "Exit an unchanged publish run before the fetch phase"
```

---

### Task 3: Pre-build probe gate and a denser schedule

**Files:**
- Create: `scripts/probe-offices.mjs`
- Modify: `.github/workflows/publish-forecast-plots.yml`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `pooled`, `anchorFor`, `probeAnchor`, `staleOfficesFrom` from Task 1.
- Produces: `changed=true|false` on `$GITHUB_OUTPUT`, and the same on stdout as JSON for
  local runs.

**Why a second probe:** Task 2's short-circuit lives inside the publisher, which runs
after `npm ci`, `playwright install --with-deps chromium` and `npm run build` — about two
minutes of setup spent to learn there was nothing to do. This script needs no
dependencies, so the workflow can run it immediately after `setup-node` and end the job
in ~20 seconds. A changed run therefore probes twice. That is deliberate: the duplicate
costs ~122 zero-byte HEADs on a run that is about to do minutes of real work, and passing
probe state between steps would couple two things that are better left independent.

- [ ] **Step 1: Write the failing test**

Add to `tests/rendered-html.test.mjs`:

```js
test("an idle run is gated before the build, and the schedule is dense", async () => {
  const [workflow, probe] = await Promise.all([
    readFile(new URL("../.github/workflows/publish-forecast-plots.yml", import.meta.url), "utf8"),
    readFile(new URL("../scripts/probe-offices.mjs", import.meta.url), "utf8"),
  ]);
  // The gate must run before the expensive setup, or it saves nothing.
  const gateStep = workflow.indexOf("scripts/probe-offices.mjs");
  const install = workflow.indexOf("run: npm ci");
  const build = workflow.indexOf("run: npm run build");
  assert.ok(gateStep > 0, "no pre-build probe step");
  assert.ok(gateStep < install, "the probe gate must run before npm ci");
  assert.ok(gateStep < build, "the probe gate must run before the build");
  // Every step after the gate is conditional on it.
  assert.match(workflow, /steps\.probe\.outputs\.changed == 'true'/);

  // Every fifteen minutes all day, and every five inside the two issuance windows.
  assert.match(workflow, /cron: "\*\/15 \* \* \* \*"/);
  assert.match(workflow, /cron: "\*\/5 3,4,15,16 \* \* \*"/);

  // The gate shares the publisher's probe rather than reimplementing it.
  assert.match(probe, /from "\.\.\/lib\/office-probe\.mjs"/);
  // An unreadable manifest or index must not be read as "nothing changed".
  assert.match(probe, /changed = true/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern="idle run is gated" tests/rendered-html.test.mjs`
Expected: FAIL — `ENOENT: no such file or directory, .../scripts/probe-offices.mjs`

- [ ] **Step 3: Create `scripts/probe-offices.mjs`**

```js
// Decides whether a publish run has anything to do, using only Node built-ins so the
// workflow can run it before `npm ci`.
//
// The publisher has its own short-circuit, but it lives behind `npm ci`, a Chromium
// download and a production build — about two minutes of setup to discover there is
// nothing to do. This gate ends an idle run in about twenty seconds, which is what makes
// a fifteen-minute schedule affordable.
import { appendFile, readFile } from "node:fs/promises";

import { anchorFor, probeAnchor, staleOfficesFrom } from "../lib/office-probe.mjs";
import { pooled } from "../lib/pooled.mjs";

const publicBaseUrl = (process.env.R2_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
const sourceRevision = process.env.GITHUB_SHA ?? "local";
const forcePublish = process.env.FORCE_PUBLISH === "true";
const officeOverride = process.env.PLOT_OFFICES?.trim();
const overrideList = officeOverride ? officeOverride.split(",").map((id) => id.trim()).filter(Boolean) : null;

const registry = JSON.parse(await readFile(new URL("./data/offices.json", import.meta.url), "utf8"));
const offices = registry
  .filter((office) => office.ready)
  .map((office) => office.id)
  .filter((id) => !overrideList || overrideList.includes(id));

/** Null on any failure, so an unreadable object resolves towards running the job. */
async function readPublished(path) {
  if (!publicBaseUrl) return null;
  try {
    const response = await fetch(`${publicBaseUrl}/${path}?ts=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

const [previousIndex, manifest] = await Promise.all([
  readPublished("forecast/index.json"),
  readPublished("latest.json"),
]);

const probes = {};
await pooled(offices, 12, async (office) => {
  try {
    const cities = JSON.parse(await readFile(new URL(`../public/cities/${office}.json`, import.meta.url), "utf8"));
    probes[office] = await probeAnchor(anchorFor(cities), fetch);
  } catch {
    probes[office] = null;
  }
});

const stale = staleOfficesFrom(offices, probes, previousIndex ?? {}, forcePublish);
// A missing index or manifest means we cannot prove anything is current, and a changed
// revision means a deploy that must re-render even if NWS has not moved.
let changed = true;
if (!forcePublish && previousIndex && manifest && !stale.length && manifest.sourceRevision === sourceRevision) {
  changed = false;
}

console.log(JSON.stringify({ changed, probed: offices.length, stale: stale.length }));
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}
```

- [ ] **Step 4: Add the gate step to the workflow**

In `.github/workflows/publish-forecast-plots.yml`, insert this step immediately after
`Set up Node` and before `Install dependencies`:

```yaml
      # No dependencies, so this runs before `npm ci` and a Chromium download. An idle
      # run ends here in ~20s instead of spending ~2 minutes on setup to learn the same
      # thing — which is what lets the schedule below be dense.
      - name: Probe for changes
        id: probe
        if: steps.publication.outputs.enabled == 'true'
        run: node scripts/probe-offices.mjs
```

Then add `&& steps.probe.outputs.changed == 'true'` to the `if:` of every step *after*
it — `Install dependencies`, `Install Chromium`, `Build forecast site`, `Start forecast
site`, and `Publish changed forecast plots`. For example:

```yaml
      - name: Install dependencies
        if: steps.publication.outputs.enabled == 'true' && steps.probe.outputs.changed == 'true'
        run: npm ci
```

- [ ] **Step 5: Replace the cron schedule**

Replace the four existing `schedule:` entries with:

```yaml
  schedule:
    # Every fifteen minutes all day. An idle run is ~122 zero-byte HEADs and ends before
    # `npm ci`, so density costs Actions time rather than R2 quota or NWS load — and this
    # repo is public, so Actions minutes are unmetered. This is what takes worst-case
    # reissue-to-visible from ~60 minutes to ~15.
    - cron: "*/15 * * * *"
      timezone: "America/New_York"
    # Every five minutes across the 03–04 and 15–16 ET issuance windows.
    - cron: "*/5 3,4,15,16 * * *"
      timezone: "America/New_York"
```

- [ ] **Step 6: Realign the stale cron assertion**

In `tests/rendered-html.test.mjs`, the test `publishes changed forecast canvases on the
issuance-aware schedule` asserts `cron: "5,25,45 3,15 * * *"`, which has been failing at
HEAD since the schedule was last changed. Replace that single assertion with:

```js
  assert.match(workflow, /cron: "\*\/5 3,4,15,16 \* \* \*"/);
```

- [ ] **Step 7: Run the probe script locally**

Run: `node scripts/probe-offices.mjs`
Expected: JSON on stdout like `{"changed":true,"probed":122,"stale":122}`. Locally
`R2_PUBLIC_BASE_URL` is unset, so both reads return null and `changed` is correctly
`true`. It takes roughly 10–20 seconds — that is 122 real HEADs against
api.weather.gov.

- [ ] **Step 8: Run the tests**

Run: `node --test tests/rendered-html.test.mjs tests/office-probe.test.mjs`
Expected: PASS, including the previously failing cron test.

- [ ] **Step 9: Commit**

```bash
git add scripts/probe-offices.mjs .github/workflows/publish-forecast-plots.yml tests/rendered-html.test.mjs
git commit -m "Gate idle publish runs before the build and tighten the schedule"
```

---

### Task 4: Freshness comparison module

**Files:**
- Create: `lib/forecast-freshness.mjs`
- Test: `tests/forecast-freshness.test.mjs`
- Modify: `package.json` (the `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `WARN_AFTER_MS: number`
  - `freshnessFor({ issuedAt, upstreamLastModified, now, warnAfterMs }): { level: "unknown"|"current"|"behind"|"warn", issuedAt: Date|null, revisedAt: Date|null, behindMs: number|null }`
  - `formatClock(date: Date | null, timeZone?: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/forecast-freshness.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { WARN_AFTER_MS, formatClock, freshnessFor } from "../lib/forecast-freshness.mjs";

const NOW = new Date("2026-07-27T14:00:00Z");

test("no upstream answer is unknown, not stale", () => {
  // The probe route degrades to a null revision rather than an error. Treating that as
  // stale would light a warning every time NWS is slow, which is the fastest way to
  // teach someone to ignore the indicator.
  const result = freshnessFor({
    issuedAt: "2026-07-27T12:37:13+00:00",
    upstreamLastModified: null,
    now: NOW,
  });
  assert.equal(result.level, "unknown");
  assert.equal(result.revisedAt, null);
  assert.equal(result.behindMs, null);
  assert.equal(result.issuedAt.toISOString(), "2026-07-27T12:37:13.000Z");
});

test("matching timestamps are current", () => {
  const result = freshnessFor({
    issuedAt: "2026-07-27T12:37:13+00:00",
    upstreamLastModified: "Mon, 27 Jul 2026 12:37:13 GMT",
    now: NOW,
  });
  assert.equal(result.level, "current");
  assert.equal(result.behindMs, 0);
});

test("an upstream revision we have not published yet reads as behind", () => {
  const result = freshnessFor({
    issuedAt: "2026-07-27T12:37:13+00:00",
    upstreamLastModified: "Mon, 27 Jul 2026 13:10:13 GMT",
    now: NOW,
  });
  assert.equal(result.level, "behind");
  assert.equal(result.behindMs, 33 * 60 * 1000);
});

test("past the threshold it escalates to a warning", () => {
  // 2026-07-26T18:47 vs a 2026-07-27T12:37 revision — the real gap from the incident
  // that motivated this indicator.
  const result = freshnessFor({
    issuedAt: "2026-07-26T18:44:17+00:00",
    upstreamLastModified: "Mon, 27 Jul 2026 12:37:13 GMT",
    now: NOW,
  });
  assert.equal(result.level, "warn");
  assert.ok(result.behindMs > WARN_AFTER_MS);
});

test("the threshold boundary is exclusive", () => {
  const issuedAt = "2026-07-27T12:00:00+00:00";
  const at = (minutes) => freshnessFor({
    issuedAt,
    upstreamLastModified: new Date(Date.parse(issuedAt) + minutes * 60_000).toUTCString(),
    now: NOW,
  }).level;
  assert.equal(at(89), "behind");
  assert.equal(at(90), "behind");
  assert.equal(at(91), "warn");
});

test("an upstream older than ours is current, never negative", () => {
  // R2 can legitimately hold a newer aggregate than the single anchor gridpoint we
  // probe, because the publisher takes the newest updateTime across ~290 points.
  const result = freshnessFor({
    issuedAt: "2026-07-27T13:00:00+00:00",
    upstreamLastModified: "Mon, 27 Jul 2026 12:37:13 GMT",
    now: NOW,
  });
  assert.equal(result.level, "current");
  assert.equal(result.behindMs, 0);
});

test("unparseable input is unknown rather than a thrown render", () => {
  assert.equal(freshnessFor({ issuedAt: "not a date", upstreamLastModified: null, now: NOW }).level, "unknown");
  assert.equal(freshnessFor({ issuedAt: null, upstreamLastModified: "Mon, 27 Jul 2026 12:37:13 GMT", now: NOW }).level, "unknown");
});

test("clock formatting is Eastern, matching the forecast days", () => {
  assert.equal(formatClock(new Date("2026-07-27T12:37:13Z")), "8:37 AM");
  assert.equal(formatClock(null), "—");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/forecast-freshness.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/forecast-freshness.mjs'`

- [ ] **Step 3: Create `lib/forecast-freshness.mjs`**

```js
// How old the forecast on screen is, and how that should read.
//
// Deliberately not a binary stale/fresh verdict. NWS revises gridpoints considerably
// more often than the forecast meaningfully changes, so a STALE badge would be lit most
// of the time and nobody would read it — failing at exactly the job it exists for. The
// indicator states facts ("Issued 8:37 AM · NWS revised 9:10 AM") and escalates only on
// a gap that is genuinely abnormal.

/**
 * Unmeasured placeholder. Well outside a normal publish cadence, well inside the ~17
 * hours the 2026-07-27 publisher freeze went unnoticed. Replace it with a measured
 * figure once the freshness route has collected real revision intervals.
 */
export const WARN_AFTER_MS = 90 * 60 * 1000;

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

export function freshnessFor({ issuedAt, upstreamLastModified, now = new Date(), warnAfterMs = WARN_AFTER_MS }) {
  const issued = parseDate(issuedAt);
  const revised = parseDate(upstreamLastModified);
  if (!issued) return { level: "unknown", issuedAt: null, revisedAt: revised, behindMs: null };
  if (!revised) return { level: "unknown", issuedAt: issued, revisedAt: null, behindMs: null };

  // Never negative: the publisher takes the newest updateTime across ~290 gridpoints, so
  // our aggregate can legitimately be newer than the single anchor we probe.
  const behindMs = Math.max(0, revised.valueOf() - issued.valueOf());
  const level = behindMs === 0 ? "current" : behindMs > warnAfterMs ? "warn" : "behind";
  return { level, issuedAt: issued, revisedAt: revised, behindMs };
}

/**
 * Eastern, matching the timezone the three forecast days are anchored to, so every time
 * on the page is in one zone.
 */
export function formatClock(date, timeZone = "America/New_York") {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(date);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/forecast-freshness.test.mjs`
Expected: PASS, 8 tests

- [ ] **Step 5: Register the test file**

In `package.json`, append `tests/forecast-freshness.test.mjs` to the `test` script:

```json
"test": "npm run build && node --test tests/rendered-html.test.mjs tests/place-search.test.mjs tests/map-frame.test.mjs tests/office-probe.test.mjs tests/forecast-freshness.test.mjs"
```

- [ ] **Step 6: Commit**

```bash
git add lib/forecast-freshness.mjs tests/forecast-freshness.test.mjs package.json
git commit -m "Add the issued-versus-revised freshness comparison"
```

---

### Task 5: Freshness route

**Files:**
- Create: `app/api/forecast-freshness/route.ts`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `anchorFor`, `probeAnchor` from Task 1; `findOffice` from `app/offices.ts`.
- Produces: `GET /api/forecast-freshness?office=ALY` →
  `{ office: string, upstreamLastModified: string | null, checkedAt: string }`, always 200.

**Why this is safe on edge and `/api/forecast` is not:** this route issues one
subrequest. `/api/forecast` fans out ~290 in batches of 24 awaited serially and 504s in
production at 91.8s. Do not add a second upstream call here.

- [ ] **Step 1: Write the failing test**

Add to `tests/rendered-html.test.mjs`:

```js
test("the freshness route costs exactly one upstream request", async () => {
  const source = await readFile(new URL("../app/api/forecast-freshness/route.ts", import.meta.url), "utf8");
  // One HEAD is what makes this viable on edge. /api/forecast fans out ~290 requests in
  // serial batches and 504s in production at 91.8s — this route must not grow towards
  // that shape.
  assert.match(source, /export const runtime = "edge"/);
  assert.match(source, /probeAnchor/);
  assert.doesNotMatch(source, /for \(let index = 0/);
  // A failed probe is a null revision, not an error status: the client degrades to
  // showing the issuance time alone and must never be blocked from rendering.
  assert.match(source, /upstreamLastModified: null/);
  assert.doesNotMatch(source, /status: 5\d\d/);
  // Shares the publisher's probe rather than a second copy of the URL shape.
  assert.match(source, /from "\.\.\/\.\.\/\.\.\/lib\/office-probe\.mjs"/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern="freshness route costs" tests/rendered-html.test.mjs`
Expected: FAIL — `ENOENT: .../app/api/forecast-freshness/route.ts`

- [ ] **Step 3: Create the route**

```ts
import { NextResponse } from "next/server";

import { findOffice } from "../../offices";
import { anchorFor, probeAnchor } from "../../../lib/office-probe.mjs";

export const runtime = "edge";

type CityPoint = { name: string; wfo: string; x: number; y: number };

/**
 * When NWS last revised the selected office's grids.
 *
 * One subrequest, deliberately. This is the cheap half of what `/api/forecast` does: that
 * route fans out ~290 gridpoint requests in serial batches and 504s in production at
 * ~92s, which is why production reads precomputed forecasts from R2 instead. A single
 * HEAD returns `last-modified` and downloads nothing, so the page can tell the viewer how
 * old what they are looking at is without paying for a forecast.
 */
export async function GET(request: Request) {
  const office = findOffice(new URL(request.url).searchParams.get("office")).id;
  const checkedAt = new Date().toISOString();

  // Never an error status. The client degrades to showing its own issuance time; a
  // freshness probe failing must not look like the forecast failing.
  const unknown = NextResponse.json(
    { office, upstreamLastModified: null, checkedAt },
    { headers: { "Cache-Control": "public, s-maxage=60" } },
  );

  try {
    const response = await fetch(new URL(`/cities/${office}.json`, request.url), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return unknown;
    const cities = (await response.json()) as CityPoint[];
    const upstreamLastModified = await probeAnchor(anchorFor(cities), fetch);
    return NextResponse.json(
      { office, upstreamLastModified, checkedAt },
      { headers: { "Cache-Control": "public, s-maxage=60" } },
    );
  } catch {
    return unknown;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern="freshness route costs" tests/rendered-html.test.mjs`
Expected: PASS

- [ ] **Step 5: Verify it against a running dev server**

Run in one terminal: `npm run dev`
Then: `curl -s "http://localhost:3000/api/forecast-freshness?office=ALY"`
Expected: `{"office":"ALY","upstreamLastModified":"Mon, 27 Jul 2026 ...","checkedAt":"..."}`
Also check the fallback: `curl -s "http://localhost:3000/api/forecast-freshness?office=ZZZ"`
Expected: 200 with `findOffice`'s default office (PHI) and a real revision — not an error.

- [ ] **Step 6: Commit**

```bash
git add app/api/forecast-freshness/route.ts tests/rendered-html.test.mjs
git commit -m "Add a one-request forecast freshness probe route"
```

---

### Task 6: Freshness indicator in the sidebar

**Files:**
- Modify: `app/components/ForecastGraphic.tsx` (imports at 6–7; effects near 1938–1956; footer at 2047–2057)
- Modify: `app/globals.css` (after `.catalog-footer p`, line ~508)
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `freshnessFor`, `formatClock` from Task 4; the route from Task 5.
- Produces: no exports. Terminal task.

**Which `updatedAt`:** live offices take it from the payload (`officeForecast.updatedAt`);
published offices go through `publishedUpdatedAtFor(publishedForecast, office.id)`, which
reads the manifest's **per-office** record. Do not use the manifest's top-level
`updatedAt` — that is the representative office's issuance and would date every published
office with PHI's time. The per-office field and its accessor were added ahead of this
task; the publisher writes it at `manifest.offices[office] = { updatedAt: ... }`.

- [ ] **Step 1: Write the failing test**

Add to `tests/rendered-html.test.mjs`:

```js
test("the sidebar states when the forecast was issued and last revised", async () => {
  const source = await readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8");
  assert.match(source, /from "\.\.\/\.\.\/lib\/forecast-freshness\.mjs"/);
  assert.match(source, /\/api\/forecast-freshness\?office=/);
  // Published offices date from the manifest, live ones from the payload.
  assert.match(source, /publishedForecast\?\.updatedAt/);
  assert.match(source, /officeForecast\?\.updatedAt/);
  // Facts, not a verdict — see lib/forecast-freshness.mjs.
  assert.doesNotMatch(source, /STALE/);
  assert.match(source, /className=\{`freshness freshness-\$\{freshness\.level\}`\}/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern="sidebar states when" tests/rendered-html.test.mjs`
Expected: FAIL — no match for the freshness import

- [ ] **Step 3: Import the module**

Add below the existing `lib` imports at the top of `ForecastGraphic.tsx`:

```tsx
import { formatClock, freshnessFor } from "../../lib/forecast-freshness.mjs";
```

- [ ] **Step 4: Add the freshness state and effect**

Place this immediately after the manifest `useEffect` (the one ending
`}, [manifestNonce]);`):

```tsx
  // NWS's latest revision for the selected office. One HEAD behind the route, refreshed
  // on the same cadence as the manifest, so an open tab notices a publisher that has
  // stopped without anyone reloading.
  const [upstreamRevision, setUpstreamRevision] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setUpstreamRevision(null);
    const load = async () => {
      try {
        const response = await fetch(`/api/forecast-freshness?office=${office.id}`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json() as { upstreamLastModified: string | null };
        if (active) setUpstreamRevision(payload.upstreamLastModified);
      } catch {
        // The indicator falls back to the issuance time alone.
      }
    };
    void load();
    const refresh = window.setInterval(load, 15 * 60 * 1000);
    return () => { active = false; window.clearInterval(refresh); };
  }, [office]);
```

- [ ] **Step 5: Derive the freshness**

Add just below `const officeForecast = ...` (line ~2021):

```tsx
  const issuedAt = hasPublishedOffice
    ? publishedUpdatedAtFor(publishedForecast, office.id)
    : officeForecast?.updatedAt;
  const freshness = freshnessFor({ issuedAt: issuedAt ?? null, upstreamLastModified: upstreamRevision });
```

- [ ] **Step 6: Render it in the footer**

In the `<footer className="catalog-footer">` block, insert between the `live-status` span
and the `<p>`:

```tsx
          {freshness.issuedAt && (
            <span className={`freshness freshness-${freshness.level}`}>
              Issued {formatClock(freshness.issuedAt)}
              {freshness.revisedAt && freshness.level !== "current" && (
                <> · NWS revised {formatClock(freshness.revisedAt)}</>
              )}
            </span>
          )}
```

- [ ] **Step 7: Style it**

Add to `app/globals.css` directly after the `.catalog-footer p` rule:

```css
.freshness {
  display: block;
  margin-top: 9px;
  color: #777;
  font: 500 10px var(--font-geist-sans), Arial, sans-serif;
  letter-spacing: -.01em;
}
.freshness-behind { color: #9a9a9a; }
/* Reserved for a gap well outside normal publish cadence — see lib/forecast-freshness.mjs. */
.freshness-warn { color: #ffa435; font-weight: 600; }
```

- [ ] **Step 8: Run the tests**

Run: `node --test --test-name-pattern="sidebar states when" tests/rendered-html.test.mjs`
Expected: PASS

- [ ] **Step 9: Verify in the browser**

Run: `npm run dev`, then open `http://localhost:3000/?office=ALY`.
Expected: the sidebar footer under "Data status" reads `AUTO-UPDATING` and, below it,
`Issued <time>` — with `· NWS revised <time>` appended whenever the anchor gridpoint is
newer than the payload. Switch offices with the picker and confirm the line updates
rather than keeping the previous office's times.

- [ ] **Step 10: Run the full suite and commit**

Run: `npm test`
Expected: all tests pass.

```bash
git add app/components/ForecastGraphic.tsx app/globals.css tests/rendered-html.test.mjs
git commit -m "Show forecast issuance and NWS revision times in the sidebar"
```

---

## Verification after deploy

Once Task 3 is on `main`, confirm the gate behaves before trusting the schedule:

1. **An idle run ends early.** Find a run whose logs show `Probe for changes` and nothing
   after it. Duration should be well under a minute — compare against the ~150s runs from
   2026-07-27.
2. **A changed run still publishes.** Trigger `workflow_dispatch` with `force: true` and
   confirm it proceeds past the gate and writes a release.
3. **Coverage recovers.** Spot-check several offices for a `generatedAt` from today:

   ```bash
   for o in PHI ALY OKX LOX FFC; do
     printf "%s " "$o"
     curl -s "https://nws-graphics.vercel.app/api/forecast-assets/forecast/$o.json?ts=$(date +%s)" \
      | head -c 160 | sed -n 's/.*"generatedAt":"\([^"]*\)".*/\1/p'
     echo
   done
   ```

   All five should show today's date. During the incident every office but OKX was a day
   behind, which is the signature this whole plan exists to make visible.
