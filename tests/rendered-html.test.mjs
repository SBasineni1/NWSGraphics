import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the default office's apparent-temperature product", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  // PHI is the default office, so the server-rendered shell always shows it.
  assert.match(html, /PHI/);
  assert.match(html, /Philadelphia \/ Mount Holly/);
  assert.match(html, /Forecast Graphics/);
  assert.match(html, /Day (?:<!-- -->)?1(?:<!-- -->)? Forecast Graphics/);
  assert.match(html, /Day (?:<!-- -->)?2/);
  assert.match(html, /Day (?:<!-- -->)?3/);
  assert.match(html, /Forecast catalogue/);
  assert.match(html, /Temperature &amp; heat/);
  assert.match(html, /NWS data source/);
  assert.match(html, />Menu</);
  // Product count is derived, not hardcoded, so adding a product can't leave it stale.
  // React splits the interpolation into its own text node, hence the comment markers.
  // Day 1 carries all fourteen: nine fields, the WPC rainfall outlook, and SPC's
  // categorical plus tornado/hail/wind probabilities.
  assert.match(html, /\[(?:<!-- -->)?14(?:<!-- -->)?\]/);
  assert.match(html, /Data status/);
  assert.doesNotMatch(html, /FORECAST AREA|VALID PERIOD|NWS ISSUED|All charts/);
  assert.doesNotMatch(html, /STATIC FORECAST|900 × 760 PNG|publication-ready/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("uses official NWS apparent-temperature grid data", async () => {
  const [route, component, publishedRoute] = await Promise.all([
    readFile(new URL("../app/api/forecast/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/published-forecast/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /api\.weather\.gov\/gridpoints\/\$\{location\.wfo\}/);
  assert.match(route, /apparentTemperature/);
  assert.match(route, /temperature/);
  // Overnight lows come from NWS's published minTemperature via a "min" aggregation, not
  // from a calendar-day minimum of the hourly series (which straddles two nights).
  assert.match(route, /minTemperature: dailyValues\(data\.properties\.minTemperature[\s\S]*?"min"\)/);
  assert.match(route, /mode: "max" \| "min" \| "sum" \| "mean"/);
  // Sky cover is averaged, not peaked — one cloudy hour must not brand a sunny day.
  assert.match(route, /skyCover: dailyValues\(data\.properties\.skyCover[\s\S]*?"mean"\)/);
  assert.match(route, /dewpoint: dailyValues\(data\.properties\.dewpoint[\s\S]*?"max"\)/);
  assert.match(route, /windSpeed: dailyValues\(data\.properties\.windSpeed[\s\S]*?"max"\)/);
  assert.match(route, /windGust/);
  assert.match(route, /probabilityOfPrecipitation/);
  assert.match(route, /quantitativePrecipitation/);
  // Read as static assets, not imported: bundling every office's points into the Worker
  // would spend ~1.5 MB of the 3 MB budget on data all but one office's slice never uses.
  assert.match(route, /\/cities\/\$\{office\}\.json/);
  assert.match(route, /\/gridpoints\/\$\{office\}\.json/);
  assert.doesNotMatch(route, /^import .*(grid-points|city-points)\.json/m);
  assert.match(route, /index \+= 24/);
  assert.match(route, /label: false/);
  assert.match(route, /Cache-Control/);
  assert.match(route, /Array\.from\(\{ length: 3 \}/);
  assert.match(component, /15 \* 60 \* 1000/);
  assert.match(component, /const FORECAST_DAYS = \[0, 1, 2\]/);
  assert.match(component, /const \[dayIndex, setDayIndex\] = useState\(0\)/);
  assert.match(component, /NEXT_PUBLIC_FORECAST_ASSET_BASE_URL/);
  assert.match(component, /\/api\/published-forecast/);
  assert.match(component, /\/api\/forecast-assets\//);
  assert.match(publishedRoute, /latest\.json/);
  assert.match(component, /PublishedForecastPlot/);
  assert.match(component, /data-render-state=/);
  assert.match(component, /data-product-file=/);
  assert.match(component, /Maximum Temperature/);
  assert.match(component, /Minimum Temperature/);
  assert.match(component, /id: "minTemperature"[^\n]*verticalLegend: true/);
  assert.match(component, /Maximum Wind Gust/);
  assert.match(component, /Maximum Sustained Wind/);
  assert.match(component, /Average Sky Cover/);
  assert.match(component, /Maximum Dewpoint/);
  assert.match(component, /Maximum POP %/);
  assert.match(component, /Total Precipitation Forecast/);
  // The graphic must name the issuing office, not just "NWS".
  assert.match(component, /NWS \$\{office\} ISSUED/);
  assert.match(component, /12:00 AM–11:59 PM/);
  assert.match(component, /weather-mark-white\.png/);
  assert.match(component, /drawImage\(headerMark/);
  assert.doesNotMatch(component, /FORECAST GRAPHICS  \/  DAY|PHI FORECAST AREA/);
  assert.match(component, /Download PNG/);
  assert.match(component, /PRODUCT_GROUPS/);
  assert.doesNotMatch(component, /forecast-context|forecast-tabs|section-heading/);
  assert.doesNotMatch(component, /STATIC FORECAST/);
  assert.doesNotMatch(component, /product-meta/);
  assert.match(component, /const RENDER_SCALE = 2/);
  assert.match(component, /canvas\.width = PLOT_WIDTH \* RENDER_SCALE/);
  assert.match(component, /raster\.width = PLOT_WIDTH/);
  assert.match(component, /value: -50/);
  assert.match(component, /value: 120/);
  assert.match(component, /verticalLegend: true/);
  assert.match(component, /id: "windGust"[^\n]*verticalLegend: true/);
  assert.match(component, /id: "probabilityOfPrecipitation"[^\n]*verticalLegend: true/);
  assert.match(component, /id: "quantitativePrecipitation"[^\n]*verticalLegend: true/);
  assert.match(component, /outlinedText/);
  assert.match(component, /traceAreas/);
  // The field now fills the whole frame; the CWA is marked by its outline alone.
  assert.doesNotMatch(component, /context\.clip\("evenodd"\)/);
  assert.match(component, /const NEIGHBOR_COUNT = 8/);
  assert.match(component, /points\.filter\(\(point\) => !point\.label\)/);
  assert.doesNotMatch(component, /coverageFalloff|maskFar/);
  assert.match(component, /rastertiles\/voyager/);
  assert.match(component, /offices\/\$\{office\.id\}\.json/);
  assert.match(component, /item\.label/);
});

test("missing forecast data reads as missing, not as a forecast of zero", async () => {
  const [route, component] = await Promise.all([
    readFile(new URL("../app/api/forecast/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
  ]);
  // The route used to answer 200 with `points: []` when every gridpoint fetch failed. The
  // renderer then interpolated over an empty set, every cell fell back to 0, and the page
  // drew a confident uniform map — 0°F is a real colour on the ramp, so it looked like a
  // forecast rather than a failure. Both ends now refuse that.
  assert.match(route, /if \(!successful\.length\)/);
  assert.match(route, /status: 503/);
  assert.match(component, /if \(!fieldPoints\.length\)/);
  assert.match(component, /FORECAST DATA UNAVAILABLE/);
  // Failure state has to be *clearable*. A single boolean could not be: whichever loader
  // succeeded last wiped the other's failure, and the bundle loader never cleared it at
  // all, so one transient miss pinned "temporarily unavailable" until a hard reload.
  assert.match(component, /const \[bundleError, setBundleError\]/);
  assert.match(component, /const \[forecastError, setForecastError\]/);
  assert.match(component, /const error = bundleError \|\| forecastError/);
  assert.match(component, /setBundleError\(false\)/);
  assert.match(component, /setForecastError\(false\)/);
  // And retried: the bundle effect only re-runs when the office changes, so without a
  // retry a transient miss strands that office entirely.
  assert.match(component, /for \(let attempt = 0; active; attempt \+= 1\)/);
  // The canvas must still be finished, or data-render-state never reaches "ready" and the
  // publisher waits on it until it times out.
  const guard = component.slice(component.indexOf("if (!fieldPoints.length)"));
  assert.match(guard.slice(0, 900), /commitPlot\(/);
});

test("fills the whole frame without re-solving the field per pixel", async () => {
  const component = await readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8");
  assert.match(component, /const FIELD_STRIDE = 4/);
  assert.match(component, /const COLOR_LUT_SIZE = 1024/);
  // The +1 keeps a lattice sample at or past each far edge; without it the last stride
  // of pixels has no upper neighbour and the raster ends in a seam.
  assert.match(component, /Math\.ceil\(\(raster\.width - 1\) \/ FIELD_STRIDE\) \+ 1/);
  assert.match(component, /Math\.ceil\(\(raster\.height - 1\) \/ FIELD_STRIDE\) \+ 1/);
  // Which points are nearest a lattice cell depends only on geometry, not on the product
  // or the day, so an office solves it once and all forty of its plots reuse the result.
  // This was the largest single cost in a render before it was cached.
  assert.match(component, /function solveFieldWeights/);
  assert.match(component, /function fieldSolveFor/);
  // Keyed by the contributing points: a product where some gridpoints report null is a
  // different set with different neighbours, and sharing a solve would move values.
  assert.match(component, /points\.map\(\(point\) => point\.id\)\.join\("\|"\)/);
  // …and dropped when the frame changes, so a solve can't outlive its lattice.
  assert.match(component, /if \(fieldSolveFrame !== frame\)/);
  // float64, or the reused sum can land a pixel in the neighbouring colour band.
  assert.match(component, /new Float64Array\(cells \* NEIGHBOR_COUNT\)/);
  assert.match(component, /function colorRamp/);
  assert.match(component, /new Uint8ClampedArray\(COLOR_LUT_SIZE \* 3\)/);
  // Entries must come from colorFor itself — the stops are not evenly spaced.
  assert.match(component, /colorFor\(min \+ span \* \(index \/ \(COLOR_LUT_SIZE - 1\)\), stops\)/);
});

test("selects the forecast office by region", async () => {
  const [offices, component, route] = await Promise.all([
    readFile(new URL("../app/offices.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/forecast/route.ts", import.meta.url), "utf8"),
  ]);
  for (const office of ["PHI", "OKX", "CTP", "LWX"]) {
    assert.match(offices, new RegExp(`id: "${office}"`), `expected ${office} in the registry`);
  }
  assert.match(offices, /Eastern Region/);
  assert.match(offices, /DEFAULT_OFFICE: OfficeId = "PHI"/);
  // Unknown ids must degrade to the default rather than throwing.
  assert.match(offices, /export function findOffice/);
  assert.match(component, /function OfficePicker/);
  assert.match(component, /role="listbox"/);
  assert.match(component, /role="option"/);
  // `expanded` excludes the exit animation, so the trigger doesn't advertise an open
  // listbox while the menu is on its way out.
  assert.match(component, /const expanded = open && !closing/);
  assert.match(component, /aria-expanded=\{expanded\}/);
  assert.match(component, /event\.key === "Escape"/);
  assert.match(component, /window\.history\.replaceState/);
  // Precomputed forecasts come first; the route is the local/dev fallback. The Worker
  // cannot serve a live office at all — ~250 gridpoint subrequests against a 50 limit.
  assert.match(component, /function loadForecast/);
  assert.match(component, /\/api\/forecast-assets\/forecast\/\$\{office\}\.json/);
  assert.match(component, /\/api\/forecast\?office=\$\{office\}/);
  // Geometry is per-office now, so changing office refetches the bundle rather than
  // re-slicing four national files that every visitor had already downloaded.
  assert.match(component, /offices\/\$\{office\.id\}\.json/);
  assert.match(component, /\}, \[office\.id\]\);/);
  // A bundle for the office we have already navigated away from must not be drawn.
  assert.match(component, /bundle\?\.office === office\.id \? bundle : null/);
  assert.match(component, /data-office=/);
  assert.match(route, /searchParams\.get\("office"\)/);
  assert.match(route, /function locationsFor/);
  // The lattice is stored per office, so scoping is the file it reads rather than a
  // filter over one national array every request had to carry.
  assert.match(route, /read<GridPoint>\(`\/gridpoints\/\$\{office\}\.json`\)/);
});

test("animates the office menu open with a staggered cascade", async () => {
  const [component, css] = await Promise.all([
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  // The menu must survive its own exit animation rather than unmounting instantly.
  assert.match(component, /const MENU_EXIT_MS = (\d+)/);
  assert.match(component, /setClosing\(true\)/);
  assert.match(component, /is-closing/);
  // One running index per level, heading included, keeps each cascade a single sweep.
  assert.match(component, /"--row": index \+ 1/);
  assert.match(component, /"--row": index \+ 2/);
  // Changing level replaces the list, so it has to re-mount or the incoming rows appear
  // already settled instead of cascading in. The key lives on the group rather than the
  // menu because the search box is a sibling of the group — keying the menu would
  // re-mount the input on every level change and drop the caret mid-typing.
  assert.match(component, /key="search"/);
  assert.match(component, /key=\{region\.id\}/);
  assert.match(component, /key="regions"/);
  const menuTag = /<div className=\{`office-menu\$\{[^}]*\}`\}[^>]*>/.exec(component);
  assert.ok(menuTag, "could not find the .office-menu element");
  assert.doesNotMatch(menuTag[0], /key=/, "the menu itself must not re-mount — the search input lives in it");

  assert.match(css, /@keyframes office-row-in/);
  assert.match(css, /@keyframes office-row-out/);
  assert.match(css, /animation-delay: calc\(40ms \+ var\(--row, 0\) \* 42ms\)/);
  // `backwards`, not `both` — `both` would pin transform and kill the :active press.
  assert.match(css, /animation: office-row-in [^;]*backwards/);
  assert.doesNotMatch(css, /animation: office-row-in [^;]*\bboth\b/);
  // Motion must be optional.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);

  // The pills are free-standing: the menu is a transparent stack, not a panel. A
  // background or border here would put the box back.
  const menuBlock = /\.office-menu\s*\{([^}]*)\}/.exec(css);
  assert.ok(menuBlock, "could not find the .office-menu rule");
  assert.doesNotMatch(menuBlock[1], /background|border(?!-)|box-shadow/);
  assert.match(css, /\.office-group button\s*\{[^}]*border-radius: 999px/);

  // The CSS exit duration and the unmount timer have to agree, or the pills either
  // disappear mid-animation or linger after it finishes.
  const exitMs = Number(/const MENU_EXIT_MS = (\d+)/.exec(component)[1]);
  const cssExit = /animation:\s*office-row-out\s+\.(\d+)s/.exec(css);
  assert.ok(cssExit, "could not read the office-row-out duration from globals.css");
  assert.equal(Number(cssExit[1]) * 10, exitMs, "MENU_EXIT_MS must match the office-row-out duration");
});

test("browses offices by NWS region, with the national map staked out", async () => {
  const [offices, component] = await Promise.all([
    readFile(new URL("../app/offices.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
  ]);
  // All six NWS regions, and every office in the country — the picker shows the real
  // map rather than pretending the country is four offices wide.
  for (const region of ["eastern", "central", "southern", "western", "alaska", "pacific"]) {
    assert.match(offices, new RegExp(`id: "${region}"`), `expected the ${region} region`);
  }
  const officeCount = [...offices.matchAll(/\{ id: "[A-Z]{3}", city:/g)].length;
  assert.equal(officeCount, 125, "expected every NWS forecast office in the registry");
  // Region membership comes from the service's own `region` field, not hand-assignment.
  assert.match(offices, /Generated by scripts\/build-offices\.mjs/);
  // An office is only selectable once its boundary, lattice and cities exist. Without
  // this a deep link to an unbuilt office draws a different office's map.
  assert.match(offices, /ready\?: boolean/);
  assert.match(offices, /if \(office\?\.ready\) return office/);
  assert.match(component, /disabled=\{!entry\.ready\}/);
  const ready = [...offices.matchAll(/\{ id: "([A-Z]{3})",[^}]*ready: true/g)].map((m) => m[1]);
  // Readiness is derived from the assets on disk, so this pins the shape rather than a
  // hand-kept list. The four that stay out are the Pacific domains: GUM and PPG have no
  // Census place coverage to label, PQW and PQE are open ocean with no gridded forecast.
  assert.ok(ready.length >= 120, `expected nearly every office drawable, got ${ready.length}`);
  for (const office of ["PHI", "OKX", "CTP", "LWX", "AFC", "HFO", "SJU", "LOX", "LOT"]) {
    assert.ok(ready.includes(office), `expected ${office} to be drawable`);
  }
  for (const office of ["GUM", "PPG", "PQE", "PQW"]) {
    assert.ok(!ready.includes(office), `${office} has no forecast data and must stay unselectable`);
  }
  assert.match(offices, /short: "ER"/);
  assert.match(offices, /export function findRegion/);
  assert.match(offices, /export function regionOf/);
  // Region first, offices second — a flat list of every CWA would not survive 122.
  assert.match(component, /const \[openRegion, setOpenRegion\] = useState<string \| null>\(null\)/);
  assert.match(component, /data-region=\{entry\.id\}/);
  // A region is selectable when it has something drawable, not merely something listed —
  // every region has offices now, but most have no assets yet.
  assert.match(component, /const ready = entry\.offices\.filter\(\(item\) => item\.ready\)\.length/);
  assert.match(component, /disabled=\{!ready\}/);
  assert.match(component, /office-national/);
  assert.match(component, /data-region="national"/);
  assert.match(component, /National map/);
  assert.match(component, /office-back/);
  // Escape unwinds a level before it closes the whole menu.
  assert.match(component, /if \(expanded && openRegion\) \{\s*\n\s*setOpenRegion\(null\);/);
  // Both level changes have to place focus. Changing level unmounts the focused row, so
  // focus falls to <body> — and the key handler is on the picker, which means Escape and
  // the arrows silently stop working from there on.
  assert.match(component, /\? "button\[data-office\]"/);
  assert.match(component, /`button\[data-region="\$\{lastRegion\.current \?\? REGIONS\[0\]\.id\}"\]`/);
  // The ref is written from handlers, never from the effect — the React Compiler rejects
  // mutating a value it has already seen passed to a hook.
  assert.match(component, /const enterRegion = useCallback/);
  // Disabled regions are skipped rather than trapping the keyboard on a dead row.
  assert.match(component, /querySelectorAll<HTMLButtonElement>\("button:not\(\[disabled\]\)"\)/);
});

test("finds an office by town or ZIP without scrolling 125 of them", async () => {
  const [component, search, builder] = await Promise.all([
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/place-search.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/build-places.mjs", import.meta.url), "utf8"),
  ]);

  // Search is a third level of the picker, not a filter over whichever level is showing.
  assert.match(component, /const \[query, setQuery\] = useState\(""\)/);
  assert.match(component, /const searching = query\.trim\(\)\.length > 0/);
  assert.match(component, /aria-label="Find a forecast office by town or ZIP code"/);
  assert.match(component, /role="combobox"/);

  // ~280 KB of towns is fetched on intent to search, not with the page and not with the
  // menu — most visits never search at all.
  assert.match(component, /function usePlaceIndex/);
  assert.match(component, /fetch\("\/place-index\.json"\)/);
  assert.match(component, /onFocus=\{places\.load\}/);
  assert.doesNotMatch(component, /useEffect\(\(\) => \{\s*\n\s*void fetch\("\/place-index\.json"\)/);
  // A failed load must not kill search for the rest of the session.
  assert.match(search, /export function searchPlaces/);
  assert.match(search, /export function parsePlaceIndex/);

  // An office that search finds but the site can't draw is named and disabled, not
  // dropped — "your town is forecast by GYX, which isn't built yet" is a real answer,
  // and falling back to PHI would silently show the wrong forecast.
  assert.match(component, /disabled=\{!found\.ready\}/);
  assert.match(component, /const OFFICE_BY_ID = new Map/);
  assert.doesNotMatch(component, /searchPlaces\([^)]*\)[^;]*findOffice/);

  // ZIP runs are ordered where they're consumed, not trusted from the generator.
  assert.match(search, /zips\.sort\(\(a, b\) => a\.start - b\.start\)/);
  // A numeric query is a ZIP query; letting digits reach the name ranking would sort
  // towns by population for a query that is not a name.
  assert.match(search, /if \(digits\) return searchZips/);

  // The index is generated offline against the same CWA polygons the renderer draws, so
  // search answers instantly and still answers when api.weather.gov is down.
  assert.match(builder, /public\/place-index\.json/);
  assert.match(builder, /scripts\/data\/office-population\.json/);
  assert.match(builder, /nws_reference_map/);
});

test("scrolls the catalogue without scrolling the sidebar's data status away", async () => {
  const [component, css] = await Promise.all([
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  // Only the catalogue scrolls: the office picker and the data-status footer sit outside
  // it, so "auto-updating" vs "published" is readable at any product count. Fourteen
  // products already overflow a laptop viewport, which pushed the footer off the bottom.
  assert.match(component, /<div className="catalog-scroll">/);
  assert.match(component, /<\/div>\s*\n\s*<footer className="catalog-footer">/);
  assert.match(css, /\.catalog-scroll \{[^}]*overflow-y: auto/);
  assert.match(css, /\.catalog-scroll \{[^}]*min-height: 0/);
  // The bar is hidden in both dialects. Chromium ignores ::-webkit-scrollbar once
  // scrollbar-width is set, and Firefox has no pseudo-element — so neither alone hides
  // it everywhere.
  assert.match(css, /\.catalog-scroll \{[^}]*scrollbar-width: none/);
  assert.match(css, /\.catalog-scroll::-webkit-scrollbar \{ width: 0/);
  assert.match(css, /\.office-menu \{[^}]*scrollbar-width: none/);
  assert.match(css, /\.office-menu::-webkit-scrollbar \{ width: 0/);
});

test("publishes changed forecast canvases on the issuance-aware schedule", async () => {
  const [publisher, workflow] = await Promise.all([
    readFile(new URL("../scripts/publish-forecast-plots.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/publish-forecast-plots.yml", import.meta.url), "utf8"),
  ]);
  assert.match(publisher, /previous\?\.updatedAt === forecast\.updatedAt/);
  assert.match(publisher, /previous\?\.sourceRevision === sourceRevision/);
  assert.match(publisher, /dataset\.renderState === "ready"/);
  assert.match(publisher, /preview\.width = 900/);
  assert.match(publisher, /preview\.height = Math\.round/);
  assert.match(publisher, /width: images\.width/);
  assert.match(publisher, /releases\/\$\{id\}\/\$\{office\}\/day-/);
  assert.match(publisher, /publishObject\("latest\.json"/);
  // A release is ~320 objects. One at a time, the phase is round-trip latency rather
  // than bandwidth, so uploads run through a pool — per day, so it holds one day's PNGs
  // rather than a whole release's.
  assert.match(publisher, /const UPLOAD_CONCURRENCY = 8/);
  assert.match(publisher, /async function pooled/);
  assert.match(publisher, /await pooled\(uploads, UPLOAD_CONCURRENCY/);
  // Each office's forecast fans out to hundreds of gridpoints; fetched together the
  // phase costs the slowest office rather than the sum of all four.
  assert.match(publisher, /await Promise\.all\(OFFICES\.map\(async \(office\)/);
  assert.match(workflow, /cron: "27 \* \* \* \*"/);
  assert.match(workflow, /cron: "5,25,45 3,15 \* \* \*"/);
  assert.match(workflow, /timezone: "America\/New_York"/);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /R2_PUBLIC_BASE_URL/);
  assert.match(workflow, /cancel-in-progress: false/);
  // The measured pipeline is minutes, so the ceiling is there to kill a stalled run
  // rather than to accommodate a slow one.
  assert.match(workflow, /timeout-minutes: 45/);
  // The publisher drives the production build, not the Vite dev server: dev renders
  // through unminified modules and a development React, at less than half the speed.
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /npm run start -- --port 3000/);
  assert.doesNotMatch(workflow, /npm run dev/);
});

test("publishes every office and prunes aged-out releases", async () => {
  const [publisher, component, assetRoute] = await Promise.all([
    readFile(new URL("../scripts/publish-forecast-plots.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/forecast-assets/[...path]/route.ts", import.meta.url), "utf8"),
  ]);
  // Two tiers, both derived from the generated registry rather than a list in the script.
  // Every drawable office gets forecast data — that object is *how* it renders — while
  // only the most populous get pre-rendered PNGs, because a release is ~110 MB per office.
  assert.match(publisher, /data\/offices\.json/);
  assert.match(publisher, /data\/office-population\.json/);
  assert.match(publisher, /const DATA_OFFICES = registry/);
  assert.match(publisher, /const RENDER_OFFICES = populationRank/);
  assert.match(publisher, /RENDER_OFFICE_COUNT/);
  assert.doesNotMatch(publisher, /const OFFICES = \[\s*"[A-Z]{3}"/);
  // The default office must always have imagery, wherever it lands in the ranking.
  assert.match(publisher, /RENDER_OFFICES\.includes\("PHI"\)/);
  // A HEAD probe carries `last-modified` with a zero-byte body, so an unchanged office
  // costs one request instead of ~290. Refreshing all 121 blindly is ~35,000 requests.
  assert.match(publisher, /method: "HEAD"/);
  assert.match(publisher, /last-modified/);
  assert.match(publisher, /forecast\/index\.json/);
  // Forecast data publishes before the imagery decision: an office with no PNGs still
  // needs its forecast refreshed, so an unchanged-imagery run must not exit first.
  assert.ok(
    publisher.indexOf("publishObject(`forecast/${office}.json`") < publisher.indexOf("const renderUnchanged"),
    "forecast data must publish before the render change-check",
  );
  assert.match(publisher, /schemaVersion: 2/);
  assert.match(publisher, /manifest\.offices\[office\] = \{ days: await captureOffice\(office\) \}/);
  assert.match(publisher, /\?office=\$\{office\}/);
  // Each office navigates afresh so the readiness wait can't latch onto stale canvases.
  assert.match(publisher, /canvas\.dataset\.office === selectedOffice/);
  assert.match(publisher, /ListObjectsV2Command/);
  assert.match(publisher, /DeleteObjectsCommand/);
  assert.match(publisher, /function pruneOldReleases/);
  // Retention is a count, not an age: publishes-per-day is set by NWS issuance
  // frequency, so an age window doesn't bound storage. N releases does.
  assert.match(publisher, /RELEASE_RETENTION_COUNT/);
  assert.doesNotMatch(publisher, /RELEASE_RETENTION_DAYS/);
  assert.match(publisher, /const keep = new Set\(\[id, \.\.\.ordered\.slice\(0, retentionCount\)\]\)/);
  // Anything not shaped like a release id must never be a delete candidate.
  assert.match(publisher, /if \(!release \|\| !releaseDate\(release\)\) continue/);
  // Keeping only the newest release leaves no grace window for a stale manifest, so a
  // failed image must trigger a throttled manifest refetch instead of staying broken
  // until the next scheduled refresh.
  assert.match(publisher, /retentionSetting \? Number\(retentionSetting\) : 1/);
  assert.match(component, /onError=\{onAssetMissing\}/);
  assert.match(component, /function recoverFromMissingAsset|const recoverFromMissingAsset/);
  assert.match(component, /lastManifestRecovery\.current < 30_000/);
  assert.match(component, /\}, \[manifestNonce\]\)/);
  // A v1 manifest must keep serving PHI rather than dropping every visitor onto the
  // live-canvas path while waiting for the first v2 publish. Deploying the client ahead
  // of the publisher is the normal order, so this is the normal case, not an edge case.
  assert.match(component, /function publishedDaysFor/);
  assert.match(component, /manifest\.schemaVersion === 2/);
  assert.match(component, /office === "PHI" \? manifest\.days : undefined/);
  assert.match(component, /schemaVersion !== 1 && manifest\.schemaVersion !== 2/);
  // The asset path guard admits both key shapes and nothing else.
  assert.match(assetRoute, /\(\?:\[A-Z\]\{3\}\\\/\)\?day-\[1-3\]/);
});

test("publisher discovers products from the page, so adding one needs no job change", async () => {
  const [publisher, component] = await Promise.all([
    readFile(new URL("../scripts/publish-forecast-plots.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
  ]);
  // Products are read off the DOM, never enumerated here. Hardcoding a list would mean
  // every new product silently stopped being published.
  assert.match(publisher, /querySelectorAll\("canvas\[data-product-id\]"\)/);
  assert.match(publisher, /getAttribute\("data-product-id"\)/);
  assert.match(publisher, /getAttribute\("data-product-file"\)/);
  // Anchored on `kind:` so this scrapes PRODUCTS entries and not PRODUCT_GROUPS, whose
  // entries are also `{ id, title }`.
  const productIds = [...component.matchAll(/kind: "\w+", id: "(\w+)", title:/g)].map((match) => match[1]);
  assert.ok(productIds.length >= 10, `expected the product list to be discovered, got ${productIds.length}`);
  for (const id of productIds) {
    // Whole-word, or a short id like "wind" would match "window" in a comment.
    assert.doesNotMatch(publisher, new RegExp(`\\b${id}\\b`), `publisher must not name product "${id}" — it should discover products`);
  }
  // Every product's file slug has to satisfy the asset-path guard, or its PNG 404s.
  const slugs = [...component.matchAll(/file: "([a-z-]+)"/g)].map((match) => match[1]);
  assert.equal(slugs.length, productIds.length);
  for (const slug of slugs) {
    for (const key of [`${slug}.png`, `${slug}-preview.png`]) {
      assert.match(key, /^[a-z][a-z-]*\.png$/, `asset key ${key} would be rejected by the path guard`);
    }
  }
});

test("renders SPC outlooks alongside the gridpoint fields", async () => {
  const [route, component] = await Promise.all([
    readFile(new URL("../app/api/spc-outlook/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
  ]);
  // Coverage is uneven upstream and the SOURCES table is the single source of truth for
  // it: categorical runs all three days, split tornado/hail/wind stop after Day 2, and
  // Day 3 carries only the combined severe probability.
  assert.match(route, /\{ product: "categorical", file: "cat", days: \[1, 2, 3\] \}/);
  assert.match(route, /\{ product: "tornado", file: "torn", days: \[1, 2\] \}/);
  assert.match(route, /\{ product: "hail", file: "hail", days: \[1, 2\] \}/);
  assert.match(route, /\{ product: "wind", file: "wind", days: \[1, 2\] \}/);
  assert.match(route, /\{ product: "severeProbability", file: "prob", days: \[3\] \}/);
  assert.match(route, /day\$\{day\}otlk_\$\{source\.file\}\.nolyr\.geojson/);
  // DN encodes severity within one product; painting in that order keeps higher risk on
  // top. It is *not* comparable across products, which is why CIG is split out first.
  assert.match(route, /areas\.sort\(\(a, b\) => a\.rank - b\.rank\)/);
  // One failed product or day must not fail the whole request.
  assert.match(route, /Promise\.allSettled/);

  // Two product kinds share the catalogue but not the renderer.
  assert.match(component, /kind: "field"/);
  assert.match(component, /kind: "outlook"/);
  assert.match(component, /function renderOutlookPlot/);
  assert.match(component, /spec\.kind === "outlook"/);
  // Neither centre's outlook day is the site's Eastern calendar day, so the graphic
  // labels itself from the outlook's own validity window.
  assert.match(component, /function outlookHeaderLines/);
  assert.match(component, /\$\{spec\.issuer\} ISSUED/);
  // A national outlook usually misses any single CWA; that must read as a real state,
  // and it has to name the hazard rather than always saying "severe weather".
  assert.match(component, /NO SEVERE WEATHER RISK AREA/);
  assert.match(component, /NO EXCESSIVE RAINFALL RISK AREA/);
  assert.match(component, /emptyNotice/);
  assert.match(component, /function outlookTouchesFrame/);
  // A vertex test alone is not enough: the excessive rainfall and TSTM areas are
  // routinely large enough to swallow a whole CWA frame without putting a vertex in it,
  // and that painted the map *and* stamped "no risk area" over it. The crossing count
  // is the even-odd rule the fill itself uses, so the two can't disagree.
  assert.match(component, /let crossings = 0/);
  assert.match(component, /return crossings % 2 === 1/);
  // Each legend shows its product's whole scale, not just today's tiers.
  assert.match(component, /spec\.categories\.forEach/);
  for (const label of ["TSTM", "MRGL", "SLGT", "ENH", "MDT", "HIGH"]) {
    assert.match(component, new RegExp(`label: "${label}"`), `expected ${label} in the categorical legend`);
  }
  // Tornado runs on its own scale and its own colours — 15% tornado is red where 15%
  // wind is yellow — so the two lists must stay separate.
  assert.match(component, /SPC_TORNADO_PROBABILITIES/);
  assert.match(component, /SPC_WIND_PROBABILITIES/);
  assert.match(component, /label: "2%", name: "2% Tornado", fill: "#79ba7a"/);
  assert.match(component, /label: "15%", name: "15% Tornado", fill: "#ff8080"/);
  assert.match(component, /label: "15%", name: "15%", fill: "#ffeb7f"/);
});

test("splits conditional intensity out of the probability areas", async () => {
  const [route, component] = await Promise.all([
    readFile(new URL("../app/api/spc-outlook/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
  ]);
  // CIG rides inside the probability file on the same DN scale but means something
  // else — day-1 wind DN 2 is CIG1, day-2 tornado DN 2 is 2% probability — so it must
  // come out before anything sorts or legends on DN.
  assert.match(route, /const CIG_LABEL = \/\^CIG\(\\d\)\$\//);
  assert.match(route, /hatches\.push/);
  // SPC stopped reissuing the standalone significant-severe files in March 2026, so
  // fetching them would paint a months-old area onto today's map. The only thing that
  // turns into a request is the SOURCES table, so that is what must stay clean.
  const sources = /const SOURCES = \[([\s\S]*?)\] as const;/.exec(route);
  assert.ok(sources, "could not find the SOURCES table");
  assert.doesNotMatch(sources[1], /sig/);
  // …but a SIGN feature appearing in a file still has to be drawn, not dropped.
  assert.match(route, /label === "SIGN"/);
  // A no-risk day ships one empty GeometryCollection, which has no rings to trace.
  assert.match(route, /geometry\?\.type === "Polygon" \|\| geometry\?\.type === "MultiPolygon"/);

  assert.match(component, /function hatchPattern/);
  assert.match(component, /HATCH_GROUPS/);
  for (const style of ["backward", "forward", "cross"]) {
    assert.match(component, new RegExp(`style: "${style}"`), `expected the ${style} hatch`);
  }
  // Hatching qualifies the probability underneath it rather than ranking against it, so
  // it is painted over the fills, never blended into them.
  assert.match(component, /for \(const hatch of outlook\.hatches\)/);
  assert.match(component, /CONDITIONAL INTENSITY/);
  // Patterns are laid out in the context's transform, which is already 2×.
  assert.match(component, /setTransform\(new DOMMatrix\(\[1 \/ RENDER_SCALE/);
});

test("renders the WPC excessive rainfall outlook", async () => {
  const [route, component, publisher] = await Promise.all([
    readFile(new URL("../app/api/wpc-outlook/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/publish-forecast-plots.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(route, /wpc_precip_hazards\/MapServer/);
  assert.match(route, /OUTLOOK_DAYS = \[1, 2, 3\]/);
  // Days 1-3 are layers 0-2 of the one service.
  assert.match(route, /\$\{SERVICE\}\/\$\{day - 1\}\/query/);
  // The ERO GeoJSON carries no fill/stroke of its own, unlike SPC's, so the palette has
  // to live in the route — these are WPC's own renderer colours.
  assert.match(route, /ERO_CATEGORIES/);
  assert.match(route, /fill: "#38a800", stroke: "#00734c"/);
  assert.match(route, /fill: "#ff69c5", stroke: "#ff00ff"/);
  // The service reports UTC without a zone marker; reading it as local would slide the
  // valid window by hours.
  assert.match(route, /replace\(" ", "T"\)\}Z/);
  assert.match(route, /Promise\.allSettled/);

  assert.match(component, /id: "excessiveRainfallOutlook"/);
  assert.match(component, /source: "wpc"/);
  assert.match(component, /WPC_ERO_CATEGORIES/);
  assert.match(component, /\/api\/wpc-outlook/);
  // The publisher must snapshot WPC the same way it snapshots SPC, or every office
  // would re-query the upstream mid-run.
  assert.match(publisher, /api\/wpc-outlook/);
});

test("offers each outlook only on the days its centre issues it", async () => {
  const component = await readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8");
  // SPC genuinely stops issuing split tornado/hail/wind after Day 2 and only has the
  // combined probability on Day 3. The nav follows that rather than offering a product
  // that would render an empty map.
  assert.match(component, /days: \[1, 2\],\n\s*file: "spc-tornado-probability"/);
  assert.match(component, /days: \[1, 2\],\n\s*file: "spc-hail-probability"/);
  assert.match(component, /days: \[1, 2\],\n\s*file: "spc-wind-probability"/);
  assert.match(component, /days: \[3\],\n\s*file: "spc-severe-probability"/);
  assert.match(component, /function productDays/);
  assert.match(component, /PRODUCTS\.filter\(\(spec\) => productDays\(spec\)\.includes\(dayIndex \+ 1\)\)/);
  // A day-filtered catalogue can empty a whole group, and the group nav used to index
  // into it unguarded.
  assert.match(component, /const availableGroups/);
  assert.match(component, /availableGroups\.map/);
  // The spec's own day list, not the payload, decides whether a product is offered —
  // an absent record means "unavailable", which is a different graphic.
  assert.match(component, /function findOutlook/);
});

test("no render path can hang on an external request", async () => {
  const [component, publisher] = await Promise.all([
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/publish-forecast-plots.mjs", import.meta.url), "utf8"),
  ]);
  // A fetch without a timeout inside the render path is the failure mode that stalls the
  // publisher: the promise never settles, data-render-state stays "rendering", and the
  // readiness wait times out. Basemap tiles hit a third party, so they must be bounded.
  assert.match(component, /const TILE_TIMEOUT_MS = 15_000/);
  assert.match(component, /fetch\(url, \{ signal: AbortSignal\.timeout\(TILE_TIMEOUT_MS\) \}\)/);
  // A failed tile must be evicted: the promise is shared by every canvas at this extent,
  // so caching a rejected or hung one would poison the whole page.
  assert.match(component, /request\.catch\(\(\) => tileCache\.delete\(url\)\)/);
  assert.match(component, /fetch\("\/weather-mark-white\.png", \{ signal: AbortSignal\.timeout/);
  assert.match(component, /fetch\(path, \{ cache: "no-store", signal: AbortSignal\.timeout\(30_000\) \}\)/);
  assert.match(component, /fetchOutlook\("\/api\/spc-outlook"\)/);
  assert.match(component, /fetchOutlook\("\/api\/wpc-outlook"\)/);

  // Products mount together, so without a queue all ten render at once and each holds
  // three canvases — ~286 MB, past what a renderer allocates on a CI runner. Serialized
  // it is ~118 MB, and costs nothing: the work is CPU-bound either way.
  assert.match(component, /function enqueueRender/);
  assert.match(component, /enqueueRender\(\(\) => renderPlot\(/);
  assert.match(component, /enqueueRender\(\(\) => renderOutlookPlot\(/);
  // Scratch canvases hand memory back rather than waiting for GC under pressure.
  assert.match(component, /function releaseCanvas/);
  assert.match(component, /releaseCanvas\(mapCanvas\)/);
  assert.match(component, /releaseCanvas\(raster\)/);

  // An unreachable centre must still produce a finished canvas.
  assert.match(component, /\$\{spec\.issuer\} OUTLOOK UNAVAILABLE/);
  assert.match(component, /if \(outlookPending\) return;/);
  assert.match(component, /setOutlookPending\(false\)/);

  // The publisher renders from fixed outlook snapshots, as it already does for the
  // forecast, and one centre being down must not cost the other's products.
  assert.match(publisher, /\["spc", "\*\*\/api\/spc-outlook"\], \["wpc", "\*\*\/api\/wpc-outlook"\]/);
  assert.match(publisher, /outlookSnapshots/);
  assert.match(publisher, /status: 503/);
});

test("a crashed or slow office does not cost the whole release", async () => {
  const publisher = await readFile(new URL("../scripts/publish-forecast-plots.mjs", import.meta.url), "utf8");
  // Ten canvases at 1800×1712 is >100 MB of backing store per page; Chromium's default
  // shared-memory segment is too small for that on a CI runner and the tab dies with
  // "Target page, context or browser has been closed".
  assert.match(publisher, /--disable-dev-shm-usage/);
  // A page per office, closed after, so memory can't accumulate across offices.
  assert.match(publisher, /async function openPage/);
  assert.match(publisher, /async function captureOffice/);
  assert.match(publisher, /page\.close\(\)\.catch/);
  // One retry, then carry on without that office rather than losing the other three.
  assert.match(publisher, /attempt <= 2/);
  assert.match(publisher, /failedOffices/);
  // A render that never settles used to cost 18 minutes an attempt, doubled by the
  // retry and repeated per office — a two-hour worst case for a three-minute job, which
  // is what turned slow runs into cancelled ones. The waits are bounded, and a budget
  // bounds the phase as a whole so a stall can't starve the offices behind it.
  assert.match(publisher, /const PAGE_LOAD_TIMEOUT_MS = 60_000/);
  assert.match(publisher, /const RENDER_READY_TIMEOUT_MS = 120_000/);
  assert.match(publisher, /const CAPTURE_BUDGET_MS/);
  assert.match(publisher, /if \(captureDeadline\(\)\) \{/);
  assert.match(publisher, /if \(attempt === 2 \|\| captureDeadline\(\)\)/);
  assert.doesNotMatch(publisher, /timeout: 300_000/);
  // But an empty manifest would strand every viewer on the live-canvas path.
  assert.match(publisher, /No office rendered successfully/);
});

test("resolves both published key shapes and rejects anything else", async () => {
  const source = await readFile(new URL("../app/api/forecast-assets/[...path]/route.ts", import.meta.url), "utf8");
  const pattern = new RegExp(/^releases\/\d{8}T\d{6}Z\/(?:[A-Z]{3}\/)?day-[1-3]\/[a-z][a-z-]*\.png$/);
  // Guard against the literal in the route drifting from what this test asserts.
  assert.ok(source.includes(pattern.source), "route regex no longer matches the tested pattern");
  for (const key of [
    "releases/20260724T205317Z/PHI/day-1/max-apparent-temperature.png",
    "releases/20260724T205317Z/OKX/day-3/total-precipitation-preview.png",
    "releases/20260724T205317Z/day-1/max-apparent-temperature.png",
  ]) {
    assert.ok(pattern.test(key), `expected ${key} to be served`);
  }
  for (const key of [
    "releases/../../etc/passwd.png",
    "releases/20260724T205317Z/phi/day-1/max-temperature.png",
    "releases/20260724T205317Z/PHI/day-9/max-temperature.png",
    "releases/20260724T205317Z/PHI/day-1/../../secret.png",
    "latest.json",
  ]) {
    assert.ok(!pattern.test(key), `expected ${key} to be rejected`);
  }
});

test("ships one self-contained map bundle per forecast office", async () => {
  const dir = new URL("../public/offices/", import.meta.url);
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  assert.equal(names.length, 125, "expected a bundle for every NWS forecast office");

  for (const office of ["PHI", "OKX", "CTP", "LWX"]) {
    const bundle = JSON.parse(await readFile(new URL(`${office}.json`, dir), "utf8"));
    assert.equal(bundle.office, office);
    // The NWS source mixes Polygon and MultiPolygon, so consumers must handle both.
    assert.match(bundle.cwa.type, /^(Polygon|MultiPolygon)$/);
    assert.ok(bundle.counties.length > 20, `${office} should carry its counties`);
    assert.ok(bundle.states.length > 0, `${office} should carry its state lines`);
    assert.ok(bundle.interstates.length > 0, `${office} should carry its interstates`);
    // A single tile level cannot serve 125 offices, so the zoom travels with the frame.
    assert.ok(Number.isInteger(bundle.zoom) && bundle.zoom >= 1 && bundle.zoom <= 12);
  }
});

test("only a genuine dateline crosser gets shifted longitudes", async () => {
  const dir = new URL("../public/offices/", import.meta.url);
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  const shifted = [];
  for (const name of names) {
    const bundle = JSON.parse(await readFile(new URL(name, dir), "utf8"));
    if (bundle.bounds.east > 180) shifted.push(bundle.office);
  }
  // Comparing longitude spans alone let float noise shift western-hemisphere offices into
  // 283..286, which put every city label off the canvas. Alaska really does cross 180.
  assert.deepEqual(shifted, ["AFC"]);
});

test("bundles a per-office lattice dense enough to interpolate", async () => {
  const dir = new URL("../public/gridpoints/", import.meta.url);
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  assert.ok(names.length > 120, `expected a lattice for nearly every office, got ${names.length}`);

  for (const office of ["PHI", "OKX", "AFC", "HFO", "LOX"]) {
    const points = JSON.parse(await readFile(new URL(`${office}.json`, dir), "utf8"));
    assert.ok(points.length >= 40, `${office} lattice too thin to interpolate: ${points.length}`);
    for (const point of points.slice(0, 5)) {
      assert.match(point.wfo, /^[A-Z]{3}$/);
      for (const key of ["x", "y", "lat", "lon"]) assert.equal(typeof point[key], "number");
    }
  }
  // The frame reaches past the CWA, so neighbouring offices supply the outer band — that
  // is what stops the field smearing one office's value into the corner of the canvas.
  const phi = JSON.parse(await readFile(new URL("PHI.json", dir), "utf8"));
  assert.ok(new Set(phi.map((point) => point.wfo)).size > 1, "expected neighbours in the buffer band");
});

test("labels cities against the office that forecasts them", async () => {
  const dir = new URL("../public/cities/", import.meta.url);
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  let total = 0;
  for (const name of names) {
    const cities = JSON.parse(await readFile(new URL(name, dir), "utf8"));
    const office = name.replace(".json", "");
    total += cities.length;
    for (const city of cities) {
      // Every city is filed under the office api.weather.gov says forecasts it.
      assert.equal(city.office, office, `${city.name} is in ${office}.json`);
      assert.match(city.wfo, /^[A-Z]{3}$/);
      for (const key of ["x", "y", "lat", "lon"]) assert.equal(typeof city[key], "number");
    }
    const ids = cities.map((city) => city.id);
    assert.equal(new Set(ids).size, ids.length, `${office} has duplicate city ids`);
  }
  assert.ok(total > 1500, `expected labels across the country, got ${total}`);

  // NWS splits Alaska's CWA into the AER and ALU gridpoint domains, so the domain a
  // city's forecast is fetched from is not always its office. Comparing the two rejected
  // every city in Anchorage's area and left AFC with no labels at all.
  const afc = JSON.parse(await readFile(new URL("AFC.json", dir), "utf8"));
  assert.ok(afc.length > 0, "AFC must have labels");
  assert.ok(afc.some((city) => city.wfo !== city.office), "expected AFC to use a separate gridpoint domain");
});
