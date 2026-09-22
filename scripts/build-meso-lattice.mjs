import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isWideView } from "../lib/areas.mjs";
import { MESO_STEP_KM, buildMesoLattice } from "../lib/meso-lattice.mjs";

// Writes public/meso-lattice/{VIEW}.json for the national view and the seven areas: the
// points scripts/mesoanalysis_pipeline.py samples RAP at for those views, in place of the
// forecast lattice in public/gridpoints/. Why they differ is in lib/meso-lattice.mjs.
//
//   node scripts/build-meso-lattice.mjs [--only US,MA]
//
// Offline and seconds: it reads only the bundles in public/offices/, so run it after
// build-office-bundles whenever lib/areas.mjs changes a view's frame.
//
// **A view whose forecast lattice is already denser keeps it.** The North East is small
// enough that its forecast lattice beats 40 km over land, and replacing it would make that
// map coarser than it is today. No file is written for such a view (and a stale one is
// removed), so the pipeline falls back to public/gridpoints/ exactly as an office does.

const args = process.argv.slice(2);
const onlyArg = args.indexOf("--only");
const only = onlyArg === -1 ? null : new Set(args[onlyArg + 1].split(","));

const bundleDir = new URL("../public/offices/", import.meta.url);
const outputDir = new URL("../public/meso-lattice/", import.meta.url);
await mkdir(outputDir, { recursive: true });

const views = (await readdir(bundleDir))
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(/\.json$/, ""))
  .filter((id) => isWideView(id) && (!only || only.has(id)))
  .sort();
if (!views.length) throw new Error("no wide-view bundles — run scripts/build-office-bundles.mjs first");

for (const view of views) {
  const bundle = JSON.parse(await readFile(new URL(`${view}.json`, bundleDir), "utf8"));
  const { points, columns, rows } = buildMesoLattice(bundle);
  const forecast = JSON.parse(await readFile(new URL(`../public/gridpoints/${view}.json`, import.meta.url), "utf8").catch(() => "[]"));
  const summary = `${points.length} points (${columns}×${rows} grid at ${MESO_STEP_KM} km, ${Math.round(100 * points.length / (columns * rows))}% on or near land)`;
  if (points.length <= forecast.length) {
    await rm(new URL(`${view}.json`, outputDir), { force: true });
    console.log(`${view}: ${summary} — not denser than its ${forecast.length}-point forecast lattice, keeping that`);
    continue;
  }
  await writeFile(new URL(`${view}.json`, outputDir), `${JSON.stringify(points)}\n`);
  console.log(`${view}: ${summary}, up from ${forecast.length}`);
}
