import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { chromium } from "playwright";

const siteUrl = (process.env.PLOT_SITE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const publicBaseUrl = (process.env.R2_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
const outputOnly = process.env.PLOT_OUTPUT_ONLY === "true";
const forcePublish = process.env.FORCE_PUBLISH === "true";
const outputDirectory = resolve(process.env.PLOT_OUTPUT_DIR ?? "outputs/forecast-publish");
const sourceRevision = process.env.GITHUB_SHA ?? "local";
// Every covered office is baked each run. Change-detection keys off the first one.
const OFFICES = ["PHI", "OKX", "CTP", "LWX"];
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

const forecasts = {};
for (const office of OFFICES) {
  const payload = await fetchJson(`${siteUrl}/api/forecast?office=${office}`, { cache: "no-store" });
  if (!payload.updatedAt || !Array.isArray(payload.days) || payload.days.length < 3) {
    throw new Error(`Forecast endpoint did not return a complete three-day payload for ${office}`);
  }
  forecasts[office] = payload;
  console.error(`fetched ${office}: ${payload.points.length} points, ${payload.failures} failures`);
}
// All offices publish together, so one office's issuance time gates the whole release.
const forecast = forecasts[OFFICES[0]];

// Snapshot the SPC outlook once and serve it to every office, so all twelve outlook
// canvases come from the same issuance — and so a slow SPC can't stall the render.
let outlookSnapshot = null;
try {
  outlookSnapshot = await fetchJson(`${siteUrl}/api/spc-outlook`, { cache: "no-store" });
} catch (error) {
  console.error(`SPC outlook unavailable, publishing without it: ${error.message}`);
}

const previous = await currentManifest();
if (!forcePublish && previous?.updatedAt === forecast.updatedAt && previous?.sourceRevision === sourceRevision) {
  console.log(JSON.stringify({ published: false, reason: "unchanged", updatedAt: forecast.updatedAt }));
  process.exit(0);
}

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
    const office = new URL(route.request().url()).searchParams.get("office") ?? OFFICES[0];
    const payload = forecasts[office];
    if (!payload) {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Unknown office" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.route("**/api/spc-outlook", async (route) => {
    if (!outlookSnapshot) {
      // Fail fast rather than letting the page hang on SPC — the canvas renders an
      // "unavailable" card and the run still produces every other product.
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "SPC unavailable" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(outlookSnapshot) });
  });
  return page;
}

const s3 = outputOnly ? null : new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT ?? `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
  },
});
const bucket = outputOnly ? "" : required("R2_BUCKET");

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

const startedAt = Date.now();
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
    await page.goto(`${siteUrl}/?office=${office}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
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
      }, { selectedDay: dayIndex, selectedOffice: office }, { timeout: 300_000 });

      const day = {
        date: officeForecast.days[dayIndex].date,
        label: officeForecast.days[dayIndex].label,
        shortLabel: officeForecast.days[dayIndex].shortLabel,
        products: {},
      };
      const canvases = page.locator("canvas[data-product-id]");
      const canvasCount = await canvases.count();
      for (let index = 0; index < canvasCount; index += 1) {
        const canvas = canvases.nth(index);
        const productId = await canvas.getAttribute("data-product-id");
        const productFile = await canvas.getAttribute("data-product-file");
        if (!productId || !productFile) throw new Error("Forecast canvas is missing publication metadata");
        const images = await canvasPngs(canvas);
        const prefix = `releases/${id}/${office}/day-${dayIndex + 1}/${productFile}`;
        const previewKey = `${prefix}-preview.png`;
        const downloadKey = `${prefix}.png`;
        await publishObject(previewKey, images.preview, "image/png", "public, max-age=31536000, immutable");
        await publishObject(downloadKey, images.download, "image/png", "public, max-age=31536000, immutable");
        day.products[productId] = {
          preview: previewKey,
          download: downloadKey,
          width: images.width,
          height: images.height,
        };
      }
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
  for (const office of OFFICES) {
    // One retry on a fresh page. A crashed tab or a single slow render shouldn't cost
    // the whole release, and it shouldn't cost the other three offices either.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        manifest.offices[office] = { days: await captureOffice(office) };
        break;
      } catch (error) {
        console.error(`${office} attempt ${attempt}/2 failed: ${error.message}`);
        if (attempt === 2) failedOffices.push(office);
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
