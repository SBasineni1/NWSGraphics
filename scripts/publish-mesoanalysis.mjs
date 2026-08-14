import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { pooled } from "../lib/pooled.mjs";

const publicBaseUrl = (process.env.R2_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
const outputOnly = process.env.MESO_OUTPUT_ONLY === "true";
const forcePublish = process.env.FORCE_PUBLISH === "true";
const python = process.env.MESO_PYTHON ?? "python3";
const root = fileURLToPath(new URL("..", import.meta.url));

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function runPython(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(python, ["scripts/mesoanalysis_pipeline.py", ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      if (code === 0) resolveRun(stdout);
      else rejectRun(new Error(`mesoanalysis pipeline exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function currentManifest() {
  if (!publicBaseUrl) return null;
  try {
    const response = await fetch(`${publicBaseUrl}/mesoanalysis/latest.json?ts=${Date.now()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

const discovery = JSON.parse(await runPython(["--discover-only"]));
const previous = await currentManifest();
const only = process.env.MESO_OFFICES?.trim();
const requestedScope = only
  ? [...new Set(only.split(",").map((office) => office.trim().toUpperCase()).filter(Boolean))].sort()
  : "all";
// RTMA lands after RAP for the same hour often enough that this matters: an hour first
// published on the raw RAP surface must be republished once RTMA appears for that same
// cycle, or the adjusted surface is never used. A manifest predating the `surface` field
// carries no evidence of an upgrade, so it is treated as not upgradable -- exactly the
// old cycle-and-scope behaviour.
const sameCycle = previous?.cycle === discovery.cycle;
const sameScope = JSON.stringify(previous?.scope) === JSON.stringify(requestedScope);
const isSurfaceUpgrade = previous?.surface === "rap" && discovery.surface === "rtma";
if (!outputOnly && !forcePublish && sameCycle && sameScope && !isSurfaceUpgrade) {
  console.log(JSON.stringify({
    published: false,
    reason: previous.surface === undefined
      ? "RAP cycle unchanged; manifest predates surface provenance"
      : `RAP cycle unchanged on the ${previous.surface} surface`,
    cycle: discovery.cycle,
    surface: discovery.surface,
    previousSurface: previous.surface ?? null,
  }));
  process.exit(0);
}

const temporary = !process.env.MESO_OUTPUT_DIR;
const outputDirectory = temporary
  ? await mkdtemp(join(tmpdir(), "nwsgraphics-mesoanalysis-"))
  : resolve(process.env.MESO_OUTPUT_DIR);

try {
  const args = ["--output-dir", outputDirectory, "--cycle", discovery.cycleId];
  if (only) args.push("--only", only);
  const manifest = JSON.parse(await runPython(args));
  const files = new Set((await readdir(outputDirectory)).filter((file) => file.endsWith(".json")));
  const officeFiles = manifest.offices.map((office) => `${office}.json`).filter((file) => files.has(file));
  if (!officeFiles.length || officeFiles.length !== manifest.offices.length) {
    throw new Error(`Pipeline wrote ${officeFiles.length}/${manifest.offices.length} declared office payloads`);
  }

  if (outputOnly) {
    console.log(JSON.stringify({
      published: false,
      reason: "output only",
      cycle: manifest.cycle,
      offices: manifest.offices.length,
      outputDirectory,
    }));
    process.exit(0);
  }

  const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT ?? `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: required("R2_ACCESS_KEY_ID"),
      secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    },
  });
  const bucket = required("R2_BUCKET");
  let bytes = 0;
  await pooled(officeFiles, 8, async (file) => {
    const body = await readFile(join(outputDirectory, file));
    bytes += body.length;
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `mesoanalysis/${file}`,
      Body: body,
      ContentType: "application/json",
      CacheControl: "public, max-age=300, s-maxage=300",
    }));
  });

  // Publish the manifest last. Anyone observing the new cycle can then assume every
  // office object for that cycle has already landed.
  const manifestBody = await readFile(join(outputDirectory, "latest.json"));
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: "mesoanalysis/latest.json",
    Body: manifestBody,
    ContentType: "application/json",
    CacheControl: "no-store, max-age=0",
  }));
  console.log(JSON.stringify({
    published: true,
    cycle: manifest.cycle,
    offices: officeFiles.length,
    kilobytes: Math.round((bytes + manifestBody.length) / 1024),
  }));
} finally {
  if (temporary) await rm(outputDirectory, { recursive: true, force: true });
}
