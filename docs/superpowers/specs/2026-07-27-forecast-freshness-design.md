# Forecast Freshness — Design

**Date:** 2026-07-27
**Status:** Approved, not implemented
**Scope:** Stage A only. The on-demand refresh button is stage B, deliberately deferred —
see *Out of scope*.

## Problem

Reissue-to-visible latency is up to an hour, and nothing on the page says how old the
forecast is.

The publisher runs hourly at `:27`, with ten-minute checks only inside the 03–04 and
15–16 ET issuance windows. NWS revises outside those windows too, so an office that
reissues at 19:40 waits until 20:27 to reach a visitor. That is the latency the user
wants closed.

The second half of the problem surfaced on 2026-07-27. A blank workflow variable zeroed
both publisher phase budgets (`Number("")` is `0`), so every run fetched one office and
rendered one office. All 121 other offices froze at their 2026-07-26 data for roughly 17
hours, and the site kept serving them without a hint that anything was wrong — the maps
looked normal, they were simply a day old. The bug was found only because a human noticed
the graphics did not match reality. Nothing in the product could have told them sooner.

## Decisions (from brainstorming)

- **Stage A is "publish denser, and show freshness."** The refresh button is stage B,
  designed after this has run long enough to show what latency actually remains.
- **The freshness signal is a live probe**, not just the payload's own timestamp, because
  stage B's button needs an honest enable condition and the probe is what provides it.
- **The indicator states facts, not a verdict.** See *Why not a STALE badge*.

## Constraints

Measured or verified on 2026-07-27, not estimated:

| Fact | Value | How known |
|---|---|---|
| `api.weather.gov` CORS | `access-control-allow-origin: *` | verified by request |
| Gridpoint `HEAD` | returns `last-modified`, zero bytes | verified by request |
| Anchor `last-modified` vs manifest `updatedAt` | identical (`12:37:13`) | verified against live manifest |
| `/api/forecast` in production | **504 after 91.8s** | measured against the deployed site |
| Fan-out shape | 290 locations, batches of 24, awaited serially | `app/api/forecast/route.ts:178` |
| Render-tier fetch per run | ~25 offices × ~290 requests ≈ 7,250 | `toFetch` always includes `RENDER_OFFICES` |
| Runs per day, current schedule | ~36 | workflow cron |

Two consequences drive the design.

**An "unchanged" run is not free today.** The only `process.exit(0)` is at line 326,
*after* the fetch phase. A run where nothing moved still fetches every render-tier office
first — about 7,250 upstream requests, and roughly 260,000 per day at the current
schedule. The workflow's own comment claims such a run "exits in about two minutes
without writing anything"; it is wrong on both counts. Densifying the cron without fixing
this multiplies that cost linearly.

**The live route cannot be the freshness signal.** `/api/forecast` is `runtime = "edge"`
and 504s in production at 91.8 seconds — twelve sequential batches, each waiting on its
slowest request. A single `HEAD` is a different order of cost and is what this design
uses.

Note that the platform constraints recorded in `CLAUDE.md` and the national-coverage plan
describe Cloudflare Workers (50 subrequests, 10 ms CPU). The live site is served by
Vercel; the binding constraint on the live route is function duration, not subrequest
count. This design does not depend on resolving that discrepancy, but stage B will.

## 1. Probe-level short-circuit

Move `currentManifest()` above the fetch phase in `scripts/publish-forecast-plots.mjs`
and add a second exit immediately after `staleOffices` is computed:

```
exit(0) when  !forcePublish
           && !staleOffices.length
           && previous?.sourceRevision === sourceRevision
```

The `sourceRevision` clause is load-bearing. A new deploy must re-render even when NWS
has not moved — that is how a newly added product reaches already-published offices, and
dropping the clause would strand it until the next NWS revision.

The existing check at line 319 stays. It covers a different case: data moved, but the
render tier did not, so the data tier publishes and only rendering is skipped.

## 2. Skip the build on idle runs, then densify

The short-circuit alone does not make density cheap, because it lives inside the
publisher — which runs after `npm ci`, `playwright install --with-deps chromium`, and
`npm run build`. An idle run would still spend about two minutes of runner setup to
discover it had nothing to do.

Extract the probe into `lib/office-probe.mjs`, alongside `map-frame.mjs` and
`place-search.mjs`, so Node can import and test it directly. It needs only Node built-ins
and `public/cities/*.json` — no dependencies — so the workflow can run it as a step
immediately after `setup-node`, before `npm ci`. If nothing is stale and the revision
matches, the job ends there in about twenty seconds.

The publisher imports the same module rather than keeping its own copy. One probe
implementation, used by both.

With that in place the schedule becomes every fifteen minutes all day, keeping every five
inside the 03–04 and 15–16 ET windows. Worst-case reissue-to-visible falls from about an
hour to about fifteen minutes plus a three-to-nine-minute publish. An idle run costs one
zero-byte HEAD per drawable office — 122 today, including the new `US` entry.

## 3. Freshness route

`app/api/forecast-freshness/route.ts`, edge runtime, `?office=X`.

Reads the same anchor city `probeOffice` uses, issues one `HEAD` to
`api.weather.gov/gridpoints/{wfo}/{x},{y}`, and returns:

```json
{ "office": "ALY", "upstreamLastModified": "...", "checkedAt": "..." }
```

with `Cache-Control: public, s-maxage=60`. One subrequest, so it is safe on edge in a way
`/api/forecast` is not.

A failed probe returns the office and a null `upstreamLastModified` rather than an error
status. The client treats "unknown" as "show the issuance time alone" — never as stale,
and never as a reason to block rendering.

## 4. Indicator

The client compares the route's `upstreamLastModified` against the `updatedAt` for what it
is displaying: the payload's for live offices, and the manifest's **per-office** record for
published ones.

That per-office record did not exist and had to be added. An earlier draft of this spec
claimed both paths already carried the field and no plumbing was needed; that was wrong.
The manifest's top-level `updatedAt` is the *representative* office's issuance —
`forecasts.PHI ?? forecasts[renderable[0]]` — so reading it would have dated New York's
maps with Philadelphia's issuance time, which is precisely the class of quietly-wrong
number this indicator exists to catch. The publisher now writes
`manifest.offices[office].updatedAt`, and `publishedUpdatedAtFor` reads it, falling back
to the release-level value for manifests published before the field existed.

**The same gap made the render change-check wrong**, and fixing it was in scope because
without it the latency improvement never reaches published offices. `renderUnchanged`
compared the whole release against that one representative timestamp, so an office that
reissued while PHI stood still had its forecast data refreshed and then kept serving the
previous release's PNGs. NWS offices reissue independently and only one of the ~25
rendered offices is PHI, so this was the common case. It now tests which render-tier
offices moved against the manifest's own per-office record — which also means an office
whose render failed or was cut by the capture budget stays behind and is retried next run,
rather than being masked by a release-level timestamp that did advance.

The sidebar footer in `ForecastGraphic.tsx` already renders a "Data status" block showing
`PUBLISHED IMAGES` or `AUTO-UPDATING`. It gains two lines: the issuance time of what is
being displayed, and NWS's latest revision time.

### Why not a STALE badge

NWS revises gridpoints considerably more often than the forecast meaningfully changes. A
binary stale/fresh badge would therefore be lit most of the time, and a warning that is
always on is one nobody reads — the indicator would fail at exactly the job it exists for.

So the indicator states facts: "Issued 12:37 · NWS revised 13:10". Warning styling is
reserved for a genuinely abnormal gap, on the order of ninety minutes, which is well
outside normal publish cadence but well inside the seventeen hours the 2026-07-27 bug
went unnoticed.

This also gives stage B its enable condition: the button is offered when upstream is
newer than what the viewer is looking at, which is a fact the probe already establishes.

## Error handling

| Failure | Behaviour |
|---|---|
| Freshness route unreachable | Show issuance time only; no upstream line; render normally |
| Anchor `HEAD` fails or is non-200 | Return null `upstreamLastModified`; same as above |
| Pre-build probe step fails | Treat as changed, run the full job |

The last row matches the policy `probeOffice` already documents: a probe that fails is
treated as changed, because refetching costs time whereas skipping a genuinely updated
office serves a stale forecast until the next run.

## Testing

Following the split already in the repo:

- **Pure logic in `lib/`, tested directly by Node** like `place-search.test.mjs`: anchor
  selection, the issued-vs-revised comparison, and the warning threshold.
- **Publisher and workflow structure** as source assertions in `rendered-html.test.mjs`,
  matching the existing convention there. One of these must pin the short-circuit
  *above* the fetch phase — that ordering is the entire point of change 1, and a
  refactor could silently undo it while every other assertion still passed.
- **A regression test already landed** for the blank-variable bug that motivated this
  work: it enumerates every `${{ vars.* }}` the workflow passes through and asserts none
  is parsed with `Number(process.env.X ?? …)`.
- **One existing assertion must be updated by change 2.** `rendered-html.test.mjs`
  currently expects `cron: "5,25,45 3,15 * * *"` while the workflow has
  `"5,15,25,35,45,55 3,15 * * *"`, so that test fails at HEAD today, before any of this
  work. Change 2 rewrites the schedule, so bringing the assertion back in line with the
  cron it guards belongs to that change.

## Out of scope

- **The refresh button itself.** Stage B.
- **Any change to `/api/forecast`'s runtime or batching.** Stage B, where the 504 and the
  batch-size-24 finding get addressed together. Worth carrying forward: `api.weather.gov`
  sends `access-control-allow-origin: *`, so the browser can fetch gridpoints directly.
  That was already Phase 3 of the national-coverage plan, and it would give stage B a
  path with no server duration limit and no abuse surface on our own infrastructure.
- **The `US` national office 400.** `app/api/forecast-assets/[...path]/route.ts:24,28`
  guard on `[A-Z]{3}`; `US` is two letters, so its published assets are unreachable.
  Real, unrelated to freshness, tracked separately.
