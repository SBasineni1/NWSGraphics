import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { chromium } from "playwright";

const siteUrl = (process.env.PLOT_SITE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const publicBaseUrl = (process.env.R2_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
const outputOnly = process.env.PLOT_OUTPUT_ONLY === "true";
const forcePublish = process.env.FORCE_PUBLISH === "true";
const outputDirectory = resolve(process.env.PLOT_OUTPUT_DIR ?? "outputs/forecast-publish");
const sourceRevision = process.env.GITHUB_SHA ?? "local";

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

const forecast = await fetchJson(`${siteUrl}/api/forecast`, { cache: "no-store" });
if (!forecast.updatedAt || !Array.isArray(forecast.days) || forecast.days.length < 3) {
  throw new Error("Forecast endpoint did not return a complete three-day payload");
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
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });
page.on("pageerror", (error) => console.error(`Page error: ${error.message}`));
await page.route("**/api/forecast", async (route) => {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(forecast) });
});
await page.goto(siteUrl, { waitUntil: "domcontentloaded", timeout: 180_000 });

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
  schemaVersion: 1,
  releaseId: id,
  updatedAt: forecast.updatedAt,
  generatedAt: new Date().toISOString(),
  sourceRevision,
  days: [],
};

try {
  for (let dayIndex = 0; dayIndex < 3; dayIndex += 1) {
    await page.locator(`button[data-day-index="${dayIndex}"]`).click();
    await page.waitForFunction((selectedDay) => {
      const canvases = [...document.querySelectorAll("canvas[data-product-id]")];
      return canvases.length > 0 && canvases.every((canvas) =>
        canvas.dataset.dayIndex === String(selectedDay) && canvas.dataset.renderState === "ready");
    }, dayIndex, { timeout: 300_000 });

    const day = {
      date: forecast.days[dayIndex].date,
      label: forecast.days[dayIndex].label,
      shortLabel: forecast.days[dayIndex].shortLabel,
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
      const prefix = `releases/${id}/day-${dayIndex + 1}/${productFile}`;
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
    manifest.days.push(day);
  }
} finally {
  await browser.close();
}

const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
await publishObject(`releases/${id}/manifest.json`, manifestBody, "application/json", "public, max-age=31536000, immutable");
await publishObject("latest.json", manifestBody, "application/json", "no-store, max-age=0");
console.log(JSON.stringify({
  published: true,
  releaseId: id,
  updatedAt: forecast.updatedAt,
  products: Object.keys(manifest.days[0]?.products ?? {}).length,
  days: manifest.days.length,
  destination: outputOnly ? outputDirectory : publicBaseUrl,
}));
