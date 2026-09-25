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

let discovery = JSON.parse(await runPython(["--discover-only"]));
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
function nothingToPublish(discovery) {
  const sameCycle = previous?.cycle === discovery.cycle;
  const sameScope = JSON.stringify(previous?.scope) === JSON.stringify(requestedScope);
  const isSurfaceUpgrade = previous?.surface === "rap" && discovery.surface === "rtma";
  return sameCycle && sameScope && !isSurfaceUpgrade;
}

/**
 * Wait for the hour's RAP analysis rather than surrendering the run.
 *
 * GitHub delivers a fraction of a high-frequency cron. Measured 2026-08-13 against a
 * `7,22,37,52` schedule -- four runs an hour requested -- the gaps between delivered runs
 * were 64, 61, 62, 62, 79, 38, 52, 57, 59, 57 and 55 minutes: about one run an hour, and
 * on that night a two-hour hole. So a run that finds nothing is not cheaply repeated in
 * fifteen minutes the way the schedule implies; the next attempt is an hour away.
 *
 * That turned a near miss into stale data. Run 19 started 23:51:39Z and published the 23Z
 * cycle. Run 20 started 00:46:20Z, exited in 52 seconds on "RAP cycle unchanged" because
 * RAP f00 for 00Z had not landed yet, and nothing ran again for two hours -- so the site
 * sat on the 23Z (7 PM Eastern) analysis while 00Z and 01Z were published upstream.
 *
 * A run costs about a minute of a twenty-minute job, so waiting a few minutes for a cycle
 * that is nearly due is far cheaper than losing the hour. Only wait past
 * MESO_WAIT_AFTER_MINUTE, when the current hour's f00 is imminent -- earlier in the hour
 * the next cycle is too far off to be worth holding a runner for.
 */
const waitAfterMinute = Number(process.env.MESO_WAIT_AFTER_MINUTE ?? 40);
const waitBudgetMs = Number(process.env.MESO_WAIT_BUDGET_MS ?? 11 * 60_000);
const waitIntervalMs = Number(process.env.MESO_WAIT_INTERVAL_MS ?? 75_000);
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

if (
  !outputOnly
  && !forcePublish
  && nothingToPublish(discovery)
  && new Date().getUTCMinutes() >= waitAfterMinute
  && waitBudgetMs > 0
) {
  const deadline = Date.now() + waitBudgetMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    await sleep(Math.min(waitIntervalMs, deadline - Date.now()));
    attempts += 1;
    // A discovery failure here is not fatal: keep the cycle already in hand and let the
    // normal gate below report it, exactly as if no wait had happened.
    try {
      discovery = JSON.parse(await runPython(["--discover-only"]));
    } catch (error) {
      console.log(JSON.stringify({ waiting: false, reason: "discovery failed while waiting", detail: String(error) }));
      break;
    }
    if (!nothingToPublish(discovery)) {
      console.log(JSON.stringify({ waiting: false, reason: "newer RAP cycle landed", attempts, cycle: discovery.cycle }));
      break;
    }
  }
}

if (!outputOnly && !forcePublish && nothingToPublish(discovery)) {
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
