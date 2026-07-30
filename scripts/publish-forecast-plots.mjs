import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { chromium } from "playwright";

import { anchorFor, probeAnchor, staleOfficesFrom } from "../lib/office-probe.mjs";
import { pooled } from "../lib/pooled.mjs";

const siteUrl = (process.env.PLOT_SITE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const publicBaseUrl = (process.env.R2_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
const outputOnly = process.env.PLOT_OUTPUT_ONLY === "true";
const forcePublish = process.env.FORCE_PUBLISH === "true";
const outputDirectory = resolve(process.env.PLOT_OUTPUT_DIR ?? "outputs/forecast-publish");
const sourceRevision = process.env.GITHUB_SHA ?? "local";
// Two tiers, both derived from the generated registry rather than listed here.
//
// **Data tier** — every drawable office gets `forecast/{OFFICE}.json`. That is what lets
// an office render at all: `/api/forecast` fans out ~290 gridpoint subrequests against
// Cloudflare's 50-subrequest limit and a 10 ms CPU budget, so the fan-out happens here,
// in Node, once per publish.
//
// **Render tier** — only the most populous offices get pre-rendered PNGs, because a
// release is ~115 MB per office against R2's 10 GB free tier, and rendering is ~11.6 s
// per office against a 15-minute capture budget. Storage allows ~86 and the budget ~77
// *on a fast local box*; a GitHub runner is slower and that has not been measured yet,
// so the default is deliberately well under both. Raise RENDER_OFFICE_COUNT once a real
// run has been timed.
const registry = JSON.parse(await readFile(new URL("./data/offices.json", import.meta.url), "utf8"));
const populationRank = JSON.parse(await readFile(new URL("./data/office-population.json", import.meta.url), "utf8"))
  .map((entry) => entry.id);
// PLOT_OFFICES narrows both tiers to a named set. Meant for testing and for re-running a
// single office after a failure — a full cold run with no index refreshes all 121, which
// is ~35,000 upstream requests.
const officeOverride = process.env.PLOT_OFFICES?.trim();
const overrideList = officeOverride ? officeOverride.split(",").map((id) => id.trim()).filter(Boolean) : null;
const DATA_OFFICES = registry
  .filter((office) => office.ready)
  .map((office) => office.id)
  .filter((id) => !overrideList || overrideList.includes(id));
const renderCountSetting = process.env.RENDER_OFFICE_COUNT?.trim();
const renderCount = renderCountSetting ? Number(renderCountSetting) : 24;
/**
 * Whether this run renders imagery at all. Zero offices means none — and that has to hold
 * at every later branch or it holds at none of them: the pins below put PHI and US back
 * *after* the slice, and an empty render tier threw two lines further on, so the setting
 * could not express "no imagery" no matter what it was set to.
 *
 * It is off in the workflow, because the client does not serve the PNGs: they are gated on
 * NEXT_PUBLIC_PUBLISHED_PLOTS, which is unset in Vercel, so `PublishedForecastPlot` never
 * mounts and nothing ever requests a release object. Rendering them anyway cost ~1,120 R2
 * writes per run — about 94% of the account's Class A operations — and ~15 minutes of a
 * ~28-minute run, which is what pushed runs past the 15-minute cron and left the *data*
 * tier hours behind. The whole render path below is intact and unchanged; this only gates
 * it, so setting RENDER_OFFICE_COUNT back to a positive number restores imagery.
 */
const RENDER_ENABLED = renderCount > 0;
const RENDER_OFFICES = RENDER_ENABLED
  ? populationRank
    .filter((id) => DATA_OFFICES.includes(id))
    .slice(0, renderCount)
  : [];
if (!DATA_OFFICES.length) throw new Error("registry lists no drawable office — run the asset chain first");
// Two offices are pinned into the render tier regardless of the population ranking: PHI
// because it is the site's default, and US because the national view is not in that
// ranking at all (it is scored per CWA) yet is the single most-viewed map there is.
if (RENDER_ENABLED) {
  for (const pinned of ["PHI", "US"]) {
    if (!RENDER_OFFICES.includes(pinned) && DATA_OFFICES.includes(pinned)) RENDER_OFFICES.push(pinned);
  }
}
// Releases are immutable and only the newest is ever referenced, so old ones are dead
// weight — without pruning the bucket grows by ~174 MB per publish, forever.
//
// Retention is a *count*, not an age, because age doesn't bound storage: the number of
// publishes per day is driven by how often NWS revises the forecast, so a busy day can
// multiply usage with the same age setting. Keeping N releases is a hard ceiling of
// N × ~174 MB regardless of issuance frequency, which is what staying under a fixed
// storage quota needs. An unset or blank variable means the default; 0 disables pruning.
//
// The default keeps only the release just published (~174 MB). That leaves no grace
// window for a client still holding the previous manifest, so the page recovers by
// re-fetching the manifest when a published image fails to load — see
// ForecastGraphic.tsx. Raise this to 2+ if you would rather have the window than rely
// on that recovery.
const retentionSetting = process.env.RELEASE_RETENTION_COUNT?.trim();
const retentionCount = retentionSetting ? Number(retentionSetting) : 1;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function releaseId(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`Invalid NWS updateTime: ${value}`);
  return parsed.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Inverse of releaseId, for deciding which releases have aged out. */
function releaseDate(id) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(id);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
}

function pngBuffer(dataUrl) {
  const separator = dataUrl.indexOf(",");
  if (separator === -1) throw new Error("Canvas did not return a PNG data URL");
  return Buffer.from(dataUrl.slice(separator + 1), "base64");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function currentManifest() {
  if (!publicBaseUrl) return null;
  try {
    return await fetchJson(`${publicBaseUrl}/latest.json?ts=${Date.now()}`, { cache: "no-store" });
  } catch {
    return null;
  }
}

async function canvasPngs(locator) {
  const dataUrls = await locator.evaluate(async (source) => {
    const dataUrlFor = (canvas) => new Promise((resolveDataUrl, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Unable to encode canvas"));
          return;
        }
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error("Unable to read PNG"));
        reader.onload = () => resolveDataUrl(reader.result);
        reader.readAsDataURL(blob);
      }, "image/png");
    });
    const preview = document.createElement("canvas");
    preview.width = 900;
    preview.height = Math.round(source.height / source.width * preview.width);
    const context = preview.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, preview.width, preview.height);
    return {
      download: await dataUrlFor(source),
      preview: await dataUrlFor(preview),
      width: source.width,
      height: source.height,
    };
  });
  return {
    download: pngBuffer(dataUrls.download),
    preview: pngBuffer(dataUrls.preview),
    width: dataUrls.width,
    height: dataUrls.height,
  };
}

/**
 * When NWS last revised an office's grids, for the cost of a single request that
 * downloads **nothing**.
 *
 * A GET on a gridpoint is ~285 KB; HEAD returns the same `last-modified` with a zero-byte
 * body. That is the whole reason 121 offices is affordable: refreshing them all blindly
 * would be ~35,000 upstream requests every run, where probing first costs 121 and then
 * fans out only for the handful that actually reissued. NWS revises a given office's
 * package a few times a day, so most runs refresh almost nothing.
 */
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

/** Per-office `last-modified` from the previous run, so a probe has something to compare. */
async function forecastIndex() {
  if (!publicBaseUrl) return {};
  try {
    return await fetchJson(`${publicBaseUrl}/forecast/index.json?ts=${Date.now()}`, { cache: "no-store" });
  } catch {
    return {};
  }
}

const previousIndex = await forecastIndex();
const probeStarted = Date.now();
const probes = {};
await pooled(DATA_OFFICES, 12, async (office) => {
  probes[office] = await probeOffice(office);
});
const staleOffices = staleOfficesFrom(DATA_OFFICES, probes, previousIndex, forcePublish);
console.error(`probed ${DATA_OFFICES.length} offices in ${((Date.now() - probeStarted) / 1000).toFixed(1)}s: ${staleOffices.length} changed`);

// Exit before the fetch phase, not after it. The fetch is ~290 gridpoint requests per
// office and every render-tier office is fetched unconditionally, so a run that reaches
// the old exit at the bottom has already spent ~7,250 upstream requests discovering it
// had nothing to do. That cost is what kept the schedule hourly.
//
// The source revision only gates a run that renders. With imagery off, latest.json stops
// being rewritten, so its `sourceRevision` freezes at whatever commit last rendered and
// every subsequent run would see a mismatch, fetch nothing, and rewrite the index for no
// reason. "No office moved" is the whole answer when data is the whole job.
const previous = await currentManifest();
const nothingToPublish = !forcePublish && !staleOffices.length
  && (!RENDER_ENABLED || previous?.sourceRevision === sourceRevision);
if (nothingToPublish) {
  console.log(JSON.stringify({
    published: false,
    reason: "nothing to publish",
    updatedAt: previous?.updatedAt ?? null,
    forecastsRefreshed: 0,
  }));
  process.exit(0);
}

// Render offices are always fetched — their imagery is rebuilt from this snapshot even if
// only one of them moved, because a release is published whole — and they go *first*, so
// a budget cut can never leave the run with nothing to render.
const toFetch = [...new Set([...RENDER_OFFICES, ...staleOffices])];

// The fetch phase gets a ceiling, like the capture phase already had. Without one a cold
// run — no index, so all 121 offices look stale — grinds through every office before
// rendering starts, and the job hits its own timeout having published nothing. Bounded,
// the same run publishes data for as many offices as fit, writes the index, and the next
// run's probe finds the remainder still stale and picks them up. Cold start becomes
// incremental instead of all-or-nothing.
//
// Blank means unset, and `??` cannot express that: the workflow passes this through as
// `${{ vars.PLOT_FETCH_BUDGET_MS }}`, which GitHub renders as the empty string when the
// variable does not exist, so the variable *is* defined and `Number("")` is 0. A zero
// budget is not "no ceiling", it is "stop after the first office" — which is exactly what
// it did, freezing every office's forecast data but the first. Same shape as the
// retention and render-count settings above, for the same reason.
const fetchBudgetSetting = process.env.PLOT_FETCH_BUDGET_MS?.trim();
const FETCH_BUDGET_MS = fetchBudgetSetting ? Number(fetchBudgetSetting) : 12 * 60 * 1000;

// Each office's forecast fans out to a couple of hundred api.weather.gov gridpoints, so a
// single request runs into the tens of seconds. Overlapping them costs the slowest office
// rather than the sum — the time is almost entirely spent waiting on upstream — but the
// pool is bounded so 121 offices don't open 35,000 sockets at once.
const forecasts = {};
const fetchStarted = Date.now();
const fetchFailures = [];
// Four at a time, not more: each office is itself ~290 gridpoint requests fanned out by
// the route, so this is already ~1,200 upstream requests in flight. At six the local
// Worker started returning 500s that were pure overload — the same office fetched alone
// succeeded immediately — so a transient failure is retried rather than written off.
let budgetSkipped = 0;
await pooled(toFetch, 4, async (office) => {
  if (Date.now() - fetchStarted > FETCH_BUDGET_MS) {
    budgetSkipped += 1;
    return;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const payload = await fetchJson(`${siteUrl}/api/forecast?office=${office}`, { cache: "no-store" });
      if (!payload.updatedAt || !Array.isArray(payload.days) || payload.days.length < 3) {
        throw new Error("incomplete three-day payload");
      }
      forecasts[office] = payload;
      return;
    } catch (error) {
      if (attempt === 2) {
        // One office failing must not cost the whole national run; a render office that
        // fails is caught below, where the release still goes out without it.
        fetchFailures.push(office);
        console.error(`forecast fetch failed for ${office}: ${error.message}`);
        return;
      }
      await new Promise((done) => setTimeout(done, 2000 * 2 ** attempt));
    }
  }
});
console.error(`fetched ${Object.keys(forecasts).length}/${toFetch.length} offices in ${((Date.now() - fetchStarted) / 1000).toFixed(1)}s`);
if (budgetSkipped) {
  console.error(`fetch budget spent — ${budgetSkipped} offices deferred to the next run (they stay absent from the index, so the next probe still sees them as stale)`);
}

const renderable = RENDER_OFFICES.filter((office) => forecasts[office]);
// An empty render tier is a failure when imagery was asked for and the expected state
// when it was not, so the throw is conditional on the ask rather than on the result.
if (RENDER_ENABLED && !renderable.length) {
  throw new Error(`no render-tier office returned a forecast (${fetchFailures.join(", ")})`);
}

// Snapshot each outlook centre once and serve it to every office, so every outlook
// canvas in the release comes from the same issuance — and so a slow upstream can't
// stall the render. The two are independent: one centre being down costs its own
// products, not the other's. Only the render path reads these, so a data-only run skips
// both requests.
const outlookSnapshots = {};
if (RENDER_ENABLED) {
  await Promise.all([["spc", "/api/spc-outlook"], ["wpc", "/api/wpc-outlook"]].map(async ([name, path]) => {
    try {
      outlookSnapshots[name] = await fetchJson(`${siteUrl}${path}`, { cache: "no-store" });
    } catch (error) {
      outlookSnapshots[name] = null;
      console.error(`${name.toUpperCase()} outlook unavailable, publishing without it: ${error.message}`);
    }
  }));
}

// A release is ~320 objects. Uploaded one at a time each pays a full round trip to R2,
// so the phase is dominated by latency rather than bandwidth — a pool turns that into
// roughly one round trip per batch. Kept modest so a slow runner doesn't open so many
// sockets that they start timing each other out.
const UPLOAD_CONCURRENCY = 8;

const s3 = outputOnly ? null : new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT ?? `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
  },
});
const bucket = outputOnly ? "" : required("R2_BUCKET");

// The data tier publishes before any rendering decision, and independently of it. An
// office with no imagery still needs its forecast refreshed — that object *is* how it
// renders — so a run where no render-tier office moved must not exit before writing it.
let forecastBytes = 0;
const publishedIndex = { ...previousIndex };
await pooled(Object.keys(forecasts), UPLOAD_CONCURRENCY, async (office) => {
  const payload = forecasts[office];
  const body = Buffer.from(JSON.stringify(payload));
  forecastBytes += body.length;
  await publishObject(`forecast/${office}.json`, body, "application/json", "public, max-age=300, s-maxage=300");
  publishedIndex[office] = { probe: probes[office] ?? null, updatedAt: payload.updatedAt };
});
await publishObject(
  "forecast/index.json",
  Buffer.from(`${JSON.stringify(publishedIndex, null, 2)}\n`),
  "application/json",
  "no-store, max-age=0",
);
console.error(`published forecast data: ${Object.keys(forecasts).length} offices, ${(forecastBytes / 1024).toFixed(0)} KB`);

// The data tier *is* the run when imagery is off. Everything past this point — the
// browser, the capture loop, the PNG uploads, the manifest and the prune — exists only to
// produce release objects, so a data-only run ends here rather than launching Chromium to
// render pixels no client will request. `latest.json` is deliberately left alone: it is
// only overwritten by a successful render, and rewriting or deleting it would break the
// published path for anyone who turns NEXT_PUBLIC_PUBLISHED_PLOTS back on before the next
// render run.
if (!RENDER_ENABLED) {
  console.log(JSON.stringify({
    published: false,
    reason: "imagery disabled",
    forecastsRefreshed: Object.keys(forecasts).length,
    forecastKilobytes: Math.round(forecastBytes / 1024),
    deferred: budgetSkipped,
    fetchFailures,
  }));
  process.exit(0);
}

// The release is keyed off the default office's issuance when it is available, so the id
// stays comparable with every release published before this became a national build.
const forecast = forecasts.PHI ?? forecasts[renderable[0]];

// Per office, not on the default office's clock. This used to compare the whole release
// against `forecast.updatedAt` — PHI's issuance, or the first renderable office's — so an
// office that reissued while PHI stood still had its data refreshed and then kept serving
// the previous release's PNGs. That is the common case, not the corner one: NWS offices
// reissue independently, and only one of the ~25 rendered offices is PHI.
//
// Compared against the manifest's own per-office record rather than the probe index, so
// an office whose render failed or was cut by the capture budget stays behind and is
// picked up next run. A manifest predating that field reports undefined and re-renders
// once, which is the safe direction.
const previousOfficeUpdatedAt = (office) => (
  previous?.schemaVersion === 2 ? previous.offices?.[office]?.updatedAt : undefined
);
const staleRenderOffices = renderable.filter(
  (office) => forecasts[office].updatedAt !== previousOfficeUpdatedAt(office),
);
const renderUnchanged = !forcePublish
  && !staleRenderOffices.length
  && previous?.sourceRevision === sourceRevision;
if (renderUnchanged) {
  console.log(JSON.stringify({
    published: false,
    reason: "imagery unchanged",
    updatedAt: forecast.updatedAt,
    forecastsRefreshed: Object.keys(forecasts).length,
  }));
  process.exit(0);
}
console.error(`rendering ${staleRenderOffices.length}/${renderable.length} render-tier offices that moved`);

if (!outputOnly) {
  required("R2_ACCOUNT_ID");
  required("R2_ACCESS_KEY_ID");
  required("R2_SECRET_ACCESS_KEY");
  required("R2_BUCKET");
  required("R2_PUBLIC_BASE_URL");
}

const id = releaseId(forecast.updatedAt);
const browser = await chromium.launch({
  headless: true,
  // Every product holds a 1800×1712 canvas and they all render at once, so a page runs
  // well over 100 MB of backing store. Chromium's default shared-memory segment is far
  // too small for that on a CI runner and the tab dies with "Target page, context or
  // browser has been closed"; this moves that allocation to /tmp instead.
  args: ["--disable-dev-shm-usage", "--disable-gpu"],
});

/** A page per attempt, so a crashed or leaky one can't poison the next office. */
async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => console.error(`Page error: ${error.message}`));
  page.on("crash", () => console.error("Page crashed"));
  // Serve the payloads already fetched above, so the page never re-queries
  // api.weather.gov or SPC and every office renders from the same snapshot.
  await page.route("**/api/forecast*", async (route) => {
    const office = new URL(route.request().url()).searchParams.get("office") ?? renderable[0];
    const payload = forecasts[office];
    if (!payload) {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Unknown office" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  // The client prefers the precomputed forecast from R2 and only falls back to the route,
  // so that path has to be served from the same snapshot too — otherwise the page would
  // render against whatever is already published instead of what this run just fetched.
  await page.route("**/api/forecast-assets/forecast/*.json", async (route) => {
    // Two or three letters: three is a CWA, two is a wide view (`US` and every area id).
    // At {3} the pinned national view missed this intercept entirely and only rendered
    // because the /api/forecast route below happens to catch the client's fallback — the
    // same off-by-one the asset route already carries a comment about.
    const office = /forecast\/([A-Z]{2,3})\.json/.exec(route.request().url())?.[1];
    const payload = office ? forecasts[office] : null;
    if (!payload) {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Unknown office" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  for (const [name, pattern] of [["spc", "**/api/spc-outlook"], ["wpc", "**/api/wpc-outlook"]]) {
    await page.route(pattern, async (route) => {
      const snapshot = outlookSnapshots[name];
      if (!snapshot) {
        // Fail fast rather than letting the page hang on the upstream — the canvas
        // renders an "unavailable" card and the run still produces every other product.
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: `${name} unavailable` }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) });
    });
  }
  return page;
}



/** Runs `task` over `items`, at most `limit` in flight, failing on the first rejection. */
async function publishObject(key, body, contentType, cacheControl) {
  if (outputOnly) {
    const destination = resolve(outputDirectory, key);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, body);
    return;
  }
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: cacheControl,
  }));
}

const manifest = {
  schemaVersion: 2,
  releaseId: id,
  updatedAt: forecast.updatedAt,
  generatedAt: new Date().toISOString(),
  sourceRevision,
  offices: {},
};

// A render that never settles used to cost 18 minutes per attempt — a 3-minute page
// load plus three 5-minute readiness waits — doubled by the retry and repeated for every
// office, for a worst case over two hours. That is how a run that normally takes three
// minutes ends up cancelled at an hour with nothing to show.
//
// Measured, a full day renders in about a second against the production build and the
// slowest (day 1, fetching basemap tiles) in about ten, so these still leave an order of
// magnitude of headroom while bounding the damage. The budget bounds the phase as a
// whole: once spent, the remaining offices are skipped and the release goes out with
// what it has, which is the same partial-publish path a crashed office already takes.
const PAGE_LOAD_TIMEOUT_MS = 60_000;
const RENDER_READY_TIMEOUT_MS = 120_000;
// Blank means unset — see FETCH_BUDGET_MS. An unset workflow variable arrives as "", and
// `Number("")` is 0, which skipped every office in the capture loop below except the
// first and published a one-office manifest.
const captureBudgetSetting = process.env.PLOT_CAPTURE_BUDGET_MS?.trim();
const CAPTURE_BUDGET_MS = captureBudgetSetting ? Number(captureBudgetSetting) : 15 * 60 * 1000;

const startedAt = Date.now();
const captureDeadline = () => Date.now() - startedAt > CAPTURE_BUDGET_MS;

/** Progress goes to stderr as it happens, so a killed run still shows how far it got. */
function progress(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0).padStart(4);
  const rss = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
  console.error(`[${elapsed}s rss=${rss}MB] ${message}`);
}

async function captureOffice(office) {
  // A page per office, closed afterwards, so canvas memory can't accumulate across
  // offices and a crashed page can't affect the next one.
  const page = await openPage();
  try {
    progress(`${office}: loading`);
    await page.goto(`${siteUrl}/?office=${office}`, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT_MS });
    const officeForecast = forecasts[office];
    const days = [];

    for (let dayIndex = 0; dayIndex < 3; dayIndex += 1) {
      await page.locator(`button[data-day-index="${dayIndex}"]`).click();
      await page.waitForFunction(({ selectedDay, selectedOffice }) => {
        const canvases = [...document.querySelectorAll("canvas[data-product-id]")];
        return canvases.length > 0 && canvases.every((canvas) =>
          canvas.dataset.dayIndex === String(selectedDay)
          && canvas.dataset.office === selectedOffice
          && canvas.dataset.renderState === "ready");
      }, { selectedDay: dayIndex, selectedOffice: office }, { timeout: RENDER_READY_TIMEOUT_MS });

      const day = {
        date: officeForecast.days[dayIndex].date,
        label: officeForecast.days[dayIndex].label,
        shortLabel: officeForecast.days[dayIndex].shortLabel,
        products: {},
      };
      // Encode first, upload after. Capturing every canvas for the day costs about a
      // second, so this holds one day's PNGs — not a whole release's — while the pool
      // works through them.
      const canvases = page.locator("canvas[data-product-id]");
      const canvasCount = await canvases.count();
      const uploads = [];
      for (let index = 0; index < canvasCount; index += 1) {
        const canvas = canvases.nth(index);
        const productId = await canvas.getAttribute("data-product-id");
        const productFile = await canvas.getAttribute("data-product-file");
        if (!productId || !productFile) throw new Error("Forecast canvas is missing publication metadata");
        const images = await canvasPngs(canvas);
        const prefix = `releases/${id}/${office}/day-${dayIndex + 1}/${productFile}`;
        const previewKey = `${prefix}-preview.png`;
        const downloadKey = `${prefix}.png`;
        uploads.push({ key: previewKey, body: images.preview }, { key: downloadKey, body: images.download });
        day.products[productId] = {
          preview: previewKey,
          download: downloadKey,
          width: images.width,
          height: images.height,
        };
      }
      await pooled(uploads, UPLOAD_CONCURRENCY, (upload) =>
        publishObject(upload.key, upload.body, "image/png", "public, max-age=31536000, immutable"));
      progress(`${office}: day ${dayIndex + 1} captured (${Object.keys(day.products).length} products)`);
      days.push(day);
    }
    return days;
  } finally {
    await page.close().catch(() => {});
  }
}

const failedOffices = [];
try {
  for (const office of renderable) {
    if (captureDeadline()) {
      console.error(`capture budget spent, skipping ${office}`);
      failedOffices.push(office);
      continue;
    }
    // One retry on a fresh page. A crashed tab or a single slow render shouldn't cost
    // the whole release, and it shouldn't cost the other offices either — which is also
    // why the retry is skipped once the budget is gone, rather than spending the rest of
    // it re-attempting one office and starving every office after it.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        // `updatedAt` per office, not just at the release level: the release-level one is
        // the representative office's issuance, so without this every published office
        // would be dated with PHI's. It is what the page shows and what the next run's
        // change-check compares against.
        manifest.offices[office] = { updatedAt: forecasts[office].updatedAt, days: await captureOffice(office) };
        break;
      } catch (error) {
        console.error(`${office} attempt ${attempt}/2 failed: ${error.message}`);
        if (attempt === 2 || captureDeadline()) {
          failedOffices.push(office);
          break;
        }
      }
    }
  }
} finally {
  await browser.close();
}

// Publishing three offices beats publishing none, but an empty manifest would strand
// every viewer on the live-canvas path, so that still fails the run.
if (!Object.keys(manifest.offices).length) {
  throw new Error(`No office rendered successfully (${failedOffices.join(", ")})`);
}
if (failedOffices.length) {
  console.error(`Publishing without: ${failedOffices.join(", ")}`);
}

const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
await publishObject(`releases/${id}/manifest.json`, manifestBody, "application/json", "public, max-age=31536000, immutable");
await publishObject("latest.json", manifestBody, "application/json", "no-store, max-age=0");

/**
 * Keep only the newest `retentionCount` releases. Runs after latest.json already points
 * at the new release, and the release just written is always kept. Retaining more than
 * one gives clients holding a stale manifest a grace window — they refresh every 15
 * minutes, so with the default of 3 a viewer would have to be several publishes behind
 * before an image 404s.
 */
async function pruneOldReleases() {
  if (outputOnly || !Number.isFinite(retentionCount) || retentionCount <= 0) return { pruned: 0, releases: 0, kept: 0 };

  const keysByRelease = new Map();
  let continuationToken;
  do {
    const listing = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "releases/",
      ContinuationToken: continuationToken,
    }));
    for (const object of listing.Contents ?? []) {
      const release = object.Key?.split("/")[1];
      // Ignore anything not shaped like a release id so a stray key is never deleted.
      if (!release || !releaseDate(release)) continue;
      if (!keysByRelease.has(release)) keysByRelease.set(release, []);
      keysByRelease.get(release).push({ Key: object.Key });
    }
    continuationToken = listing.IsTruncated ? listing.NextContinuationToken : undefined;
  } while (continuationToken);

  // Release ids are YYYYMMDDTHHMMSSZ, so a lexical sort is chronological.
  const ordered = [...keysByRelease.keys()].sort().reverse();
  const keep = new Set([id, ...ordered.slice(0, retentionCount)]);
  const dropped = ordered.filter((release) => !keep.has(release));
  const expired = dropped.flatMap((release) => keysByRelease.get(release));

  for (let index = 0; index < expired.length; index += 1000) {
    await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: expired.slice(index, index + 1000), Quiet: true },
    }));
  }
  return { pruned: expired.length, releases: dropped.length, kept: keep.size };
}

let retention = { pruned: 0, releases: 0, kept: 0 };
try {
  retention = await pruneOldReleases();
} catch (error) {
  // A failed prune costs storage, not correctness — the new release is already live.
  console.error(`Release pruning failed: ${error.message}`);
}

console.log(JSON.stringify({
  published: true,
  releaseId: id,
  updatedAt: forecast.updatedAt,
  offices: Object.keys(manifest.offices),
  failedOffices,
  products: Object.keys(Object.values(manifest.offices)[0]?.days[0]?.products ?? {}).length,
  days: Object.values(manifest.offices)[0]?.days.length ?? 0,
  prunedObjects: retention.pruned,
  prunedReleases: retention.releases,
  retainedReleases: retention.kept,
  destination: outputOnly ? outputDirectory : publicBaseUrl,
}));
