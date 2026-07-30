// Decides whether a publish run has anything to do, using only Node built-ins so the
// workflow can run it before `npm ci`.
//
// The publisher has its own short-circuit, but it lives behind `npm ci`, a Chromium
// download and a production build — about two minutes of setup to discover there is
// nothing to do. This gate ends an idle run in about twenty seconds, which is what makes
// a fifteen-minute schedule affordable.
//
// A changed run therefore probes twice. That is deliberate: the duplicate costs ~122
// zero-byte HEADs on a run that is about to do minutes of real work, and passing probe
// state between steps would couple two things that are better left independent.
import { appendFile, readFile } from "node:fs/promises";

import { anchorFor, probeAnchor, staleOfficesFrom } from "../lib/office-probe.mjs";
import { pooled } from "../lib/pooled.mjs";

const publicBaseUrl = (process.env.R2_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
const sourceRevision = process.env.GITHUB_SHA ?? "local";
const forcePublish = process.env.FORCE_PUBLISH === "true";
// Mirrors the publisher's own gate, and has to: this step decides whether that one even
// gets installed. Same reading of the setting, so the two can never disagree about which
// tiers a run has.
const renderCountSetting = process.env.RENDER_OFFICE_COUNT?.trim();
const renderEnabled = (renderCountSetting ? Number(renderCountSetting) : 24) > 0;
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
    // Bounded, like the anchor probe. This gate's whole value is ending an idle run in
    // ~20s; an unresponsive R2 endpoint must resolve towards `changed = true` quickly
    // rather than stranding the step it was meant to make cheap.
    const response = await fetch(`${publicBaseUrl}/${path}?ts=${Date.now()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// The manifest is only consulted when imagery is on. With the render tier off nothing
// rewrites latest.json, so its `sourceRevision` freezes at the last commit that rendered
// and reading it would report a deploy on every run forever — turning this gate, whose
// whole job is ending an idle run in ~20s, into a guaranteed two minutes of setup before
// the publisher exits anyway.
const [previousIndex, manifest] = await Promise.all([
  readPublished("forecast/index.json"),
  renderEnabled ? readPublished("latest.json") : Promise.resolve(null),
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
// A missing index means we cannot prove anything is current. When imagery is on, a missing
// manifest means the same, and a changed revision means a deploy that must re-render even
// if NWS has not moved. With imagery off there is no imagery to re-render, so an office
// that moved is the only thing that can make a run worth its setup.
const deployNeedsRender = renderEnabled && (!manifest || manifest.sourceRevision !== sourceRevision);
let changed = true;
if (!forcePublish && previousIndex && !stale.length && !deployNeedsRender) {
  changed = false;
}

console.log(JSON.stringify({ changed, probed: offices.length, stale: stale.length }));
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}
