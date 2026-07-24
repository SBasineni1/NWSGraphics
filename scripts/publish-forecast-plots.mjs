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
// weight — without pruning the bucket grows by roughly 150 MB per publish, forever.
// An unset or blank variable means "use the default"; an explicit 0 disables pruning.
const retentionSetting = process.env.RELEASE_RETENTION_DAYS?.trim();
const retentionDays = retentionSetting ? Number(retentionSetting) : 7;

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
}
// All offices publish together, so one office's issuance time gates the whole release.
const forecast = forecasts[OFFICES[0]];

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
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });
page.on("pageerror", (error) => console.error(`Page error: ${error.message}`));
// Serve each office the payload already fetched above, so the page never re-queries
// api.weather.gov and every office renders from the same snapshot.
await page.route("**/api/forecast*", async (route) => {
  const office = new URL(route.request().url()).searchParams.get("office") ?? OFFICES[0];
  const payload = forecasts[office];
  if (!payload) {
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Unknown office" }) });
    return;
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
});

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

try {
  for (const office of OFFICES) {
    // A full navigation per office resets the canvases, so the readiness wait below
    // can never latch onto the previous office's already-rendered plots.
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
      days.push(day);
    }
    manifest.offices[office] = { days };
  }
} finally {
  await browser.close();
}

const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
await publishObject(`releases/${id}/manifest.json`, manifestBody, "application/json", "public, max-age=31536000, immutable");
await publishObject("latest.json", manifestBody, "application/json", "no-store, max-age=0");

/**
 * Drop releases older than the retention window. Runs only after latest.json points at
 * the new release, and never touches it — the window is far longer than the 15-minute
 * client refresh, so no viewer can be holding a manifest that references what we delete.
 */
async function pruneOldReleases() {
  if (outputOnly || !Number.isFinite(retentionDays) || retentionDays <= 0) return { pruned: 0, releases: 0 };
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const expired = [];
  let continuationToken;
  do {
    const listing = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "releases/",
      ContinuationToken: continuationToken,
    }));
    for (const object of listing.Contents ?? []) {
      const release = object.Key?.split("/")[1];
      if (!release || release === id) continue;
      const date = releaseDate(release);
      if (date && date.valueOf() < cutoff) expired.push({ Key: object.Key });
    }
    continuationToken = listing.IsTruncated ? listing.NextContinuationToken : undefined;
  } while (continuationToken);

  const releases = new Set(expired.map((object) => object.Key.split("/")[1]));
  for (let index = 0; index < expired.length; index += 1000) {
    await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: expired.slice(index, index + 1000), Quiet: true },
    }));
  }
  return { pruned: expired.length, releases: releases.size };
}

let retention = { pruned: 0, releases: 0 };
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
  products: Object.keys(manifest.offices[OFFICES[0]]?.days[0]?.products ?? {}).length,
  days: manifest.offices[OFFICES[0]]?.days.length ?? 0,
  prunedObjects: retention.pruned,
  prunedReleases: retention.releases,
  destination: outputOnly ? outputDirectory : publicBaseUrl,
}));
