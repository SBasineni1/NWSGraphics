import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { AREAS, isWideView } from "../lib/areas.mjs";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  // vinext 1.x exports the fetch handler itself; 0.0.50 exported `{ fetch }`. Accept
  // either, so this doesn't break again on the next major.
  const handler = typeof worker === "function" ? worker : worker.fetch;
  return handler(
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
  // The national view aggregates every office, so it is "NWS ISSUED" with no code; every
  // real office still names itself.
  assert.match(component, /office === "US" \? "NWS" : `NWS \$\{office\}`/);
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
  // The blanket coverage mask really was removed — a CWA lattice covers its whole frame,
  // so masking there only ate real data. What replaced it is *support*: a cell fades only
  // when the nearest contributing point is several lattice spacings away, which never
  // happens on a CWA frame and is exactly what the national frame needs, since it reaches
  // far into ocean where NWS publishes no gridded forecast at all.
  assert.doesNotMatch(component, /coverageFalloff|maskFar/);
  assert.match(component, /const SUPPORT_FULL/);
  assert.match(component, /const SUPPORT_NONE/);
  assert.match(component, /support\[cell\] = near\.length/);
  // Shepard smoothing scales with the lattice, rather than the constant it used to be.
  // That constant was (0.1 x 0.219 deg)^2 — PHI's spacing — so at national scale, where
  // spacing is ~1.5 deg, inverse-distance weighting went near-singular at every point and
  // painted one bullseye per gridpoint.
  assert.match(component, /const SHEPARD_SMOOTHING/);
  assert.match(component, /\(SHEPARD_SMOOTHING \* spacing\) \*\* 2/);
  assert.doesNotMatch(component, /distanceSquared \+ 0\.0005/);
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
  // The ramp is uniform in value but QPF's stops are not — it runs to 12" while crowding
  // five stops below 0.5". 1024 entries left the 0.01–0.1 band, most of a typical map,
  // with 8 steps for a 68-unit RGB traverse; don't drop it back.
  assert.match(component, /const COLOR_LUT_SIZE = 4096/);
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
  // Field products blend; the categorical ones don't, and they are a separate code path.
  // Banding the field was tried and reverted — the temperature stops are 10° apart, so a
  // real 78–90°F day collapsed to two flat blocks and lost every readable gradient. The
  // legend's flat swatches key the scale; they don't claim the field is quantised.
  const colorFor = /function colorFor[\s\S]*?\n\}/.exec(component);
  assert.ok(colorFor, "could not find colorFor");
  assert.match(colorFor[0], /const amount = \(value - lower\.value\) \/ \(upper\.value - lower\.value\);/);
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
  // Case-insensitive: this pins that the row exists, not how the label is capitalised.
  assert.match(component, /National Map/i);
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

test("the areas are one row that opens a level, not seven rows inline", async () => {
  const [component, offices] = await Promise.all([
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/offices.ts", import.meta.url), "utf8"),
  ]);

  // The sentinel rides `openRegion`, so everything already hung off that level — the back
  // button, Escape, ArrowLeft, the focus restore — covers the areas without a second
  // mechanism. It is only safe because RegionId is a closed set of six full words, so
  // findRegion can never resolve it to a real region and shadow the areas branch.
  assert.match(component, /const AREAS_LEVEL = "areas"/);
  for (const region of ["eastern", "central", "southern", "western", "alaska", "pacific"]) {
    assert.notEqual(region, "areas");
  }
  assert.doesNotMatch(offices, /id: "areas"/, "the areas sentinel must not collide with a region id");

  // One row at the top level that drills in, marked like the home region when an area is
  // showing. If this ever renders the areas inline again, the top of the menu goes from
  // nine rows to sixteen and stops fitting without a scroll.
  assert.match(component, /data-region=\{AREAS_LEVEL\}/);
  assert.match(component, /onClick=\{\(\) => enterRegion\(AREAS_LEVEL\)\}/);
  assert.match(component, /className=\{`office-areas\$\{browsingArea \? " is-current" : ""\}`\}/);
  // The top-level list must not enumerate the areas — that is the whole point of the row.
  const regionList = component.slice(component.indexOf('key="regions"'), component.indexOf("</div>", component.indexOf('key="regions"')));
  // Anchor the slice, or the doesNotMatch below passes on an empty string forever.
  assert.match(regionList, /National Map/i, "expected to have found the top-level list");
  assert.doesNotMatch(regionList, /AREAS\.map/, "the top level must not list the areas inline");

  // …and the level itself mirrors a region's office list: back out, heading, then options.
  const level = component.slice(component.indexOf("browsingAreas ? ("), component.indexOf(") : region ? ("));
  assert.match(level, /className="office-back"/);
  assert.match(level, /AREAS\.map\(\(area, index\) => \(/);
  assert.match(level, /aria-selected=\{area\.id === office\.id\}/);
  assert.match(level, /data-office=\{area\.id\}/);
  // An area with no assets is listed and disabled, exactly as an unbuilt office is.
  assert.match(level, /disabled=\{!area\.ready\}/);

  // Entering the level focuses its first option, which the existing selector already does
  // because an area row carries data-office like any office row.
  assert.match(component, /\? "button\[data-office\]"/);
});

test("offers the visitor's own office without ever prompting unbidden", async () => {
  const component = await readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8");
  assert.match(component, /function useLocalOffice/);
  assert.match(component, /navigator\.geolocation\.getCurrentPosition/);
  // NWS is the authority on which office owns a coordinate. Answering it locally would
  // mean shipping all 125 boundaries to the client to save one request.
  assert.match(component, /api\.weather\.gov\/points\/\$\{latitude/);
  assert.match(component, /properties\?\.cwa/);
  // The prompt only ever comes from a click. The single silent path is a visitor who
  // already granted permission on an earlier visit — re-asking them is the rude part.
  assert.match(component, /permissions\s*\n?\s*\.query\(\{ name: "geolocation"/);
  assert.match(component, /status\.state === "granted"/);
  // And it must never override a deep link, or a shared URL retargets itself at whoever
  // opens it.
  assert.match(component, /if \(new URLSearchParams\(window\.location\.search\)\.has\("office"\)\) return/);
  // An office we cannot draw is reported, not silently swapped for the default.
  assert.match(component, /if \(!found\?\.ready\)/);
  // Denied and unsupported are distinct outcomes and say different things.
  assert.match(component, /PERMISSION_DENIED/);
  assert.match(component, /Location permission is blocked/);
});

test("the region list drops counts that said nothing", async () => {
  const component = await readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8");
  // "23 of 23" on nearly every row once the country was built out. A region with nothing
  // drawable is still marked, because that is the case a reader needs told.
  assert.doesNotMatch(component, /\$\{ready\} of \$\{entry\.offices\.length\}/);
  assert.match(component, /\{!ready && <em>Soon<\/em>\}/);
  // The national view is selectable, not a placeholder.
  assert.match(component, /data-office=\{NATIONAL\.id\}/);
  assert.match(component, /disabled=\{!NATIONAL\.ready\}/);
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
  const [publisher, workflow, poolModule] = await Promise.all([
    readFile(new URL("../scripts/publish-forecast-plots.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/publish-forecast-plots.yml", import.meta.url), "utf8"),
    readFile(new URL("../lib/pooled.mjs", import.meta.url), "utf8"),
  ]);
  // The change-check is per render-tier office now, against the manifest's own record of
  // what each office was last rendered from — not against the representative office's
  // timestamp, which held back every office that moved while PHI did not.
  assert.match(publisher, /const staleRenderOffices = renderable\.filter/);
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
  // The pool itself lives in lib/pooled.mjs, shared with the pre-build probe gate so
  // both bound their upstream pressure the same way.
  assert.match(publisher, /const UPLOAD_CONCURRENCY = 8/);
  assert.match(poolModule, /export async function pooled/);
  assert.match(publisher, /await pooled\(uploads, UPLOAD_CONCURRENCY/);
  // Each office's forecast fans out to hundreds of gridpoints; fetched together the
  // phase costs the slowest office rather than the sum of all four.
  // Fetching is pooled and budgeted now, not an unbounded Promise.all over every office:
  // a cold run looked at 121 offices and hit the job timeout having rendered nothing.
  assert.match(publisher, /await pooled\(toFetch, 4, async \(office\)/);
  assert.match(publisher, /PLOT_FETCH_BUDGET_MS/);
  // Render-tier offices are fetched first, so a budget cut can never leave nothing to render.
  assert.match(publisher, /\[\.\.\.new Set\(\[\.\.\.RENDER_OFFICES, \.\.\.orderedStale\]\)\]/);
  assert.match(workflow, /cron: "\*\/15 \* \* \* \*"/);
  assert.match(workflow, /timezone: "America\/New_York"/);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /R2_PUBLIC_BASE_URL/);
  assert.match(workflow, /cancel-in-progress: false/);
  // The measured pipeline is minutes, so the ceiling is there to kill a stalled run
  // rather than to accommodate a slow one.
  assert.match(workflow, /timeout-minutes: 60/);
  // The publisher drives the production build, not the Vite dev server: dev renders
  // through unminified modules and a development React, at less than half the speed.
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /npm run start -- --port 3000/);
  assert.doesNotMatch(workflow, /npm run dev/);
});

test("publishes forecast data without rendering imagery when the render tier is off", async () => {
  const [publisher, workflow, component] = await Promise.all([
    readFile(new URL("../scripts/publish-forecast-plots.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/publish-forecast-plots.yml", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
  ]);
  // Zero offices has to mean *no imagery* at every branch that used to assume some. It
  // did not: the pins put PHI and US back after the slice and an empty render tier threw,
  // so the count could not express "off" at any value.
  assert.match(publisher, /const RENDER_ENABLED = renderCount > 0/);
  assert.match(publisher, /if \(RENDER_ENABLED\) \{\s*\n\s*for \(const pinned of \["PHI", "US"\]\)/);
  assert.match(publisher, /if \(RENDER_ENABLED && !renderable\.length\)/);
  // The exit is *after* the data tier is written and before the browser is launched —
  // a data-only run is still a full data run, it just stops short of pixels.
  assert.match(publisher, /reason: "imagery disabled"/);
  const dataPublish = publisher.indexOf('publishObject(\n  "forecast/index.json"');
  const renderExit = publisher.indexOf('reason: "imagery disabled"');
  const browserLaunch = publisher.indexOf("await chromium.launch(");
  assert.ok(dataPublish > 0 && renderExit > dataPublish, "data tier must publish before the imagery-disabled exit");
  assert.ok(browserLaunch > renderExit, "the browser must launch only past the imagery-disabled exit");
  // Nothing serves the PNGs, which is why the tier is off: the client gates imagery on a
  // flag that is unset in production. The two must not drift apart silently — imagery on
  // in the publisher and off in the client is exactly the state this change removed.
  assert.match(workflow, /RENDER_OFFICE_COUNT: \$\{\{ vars\.RENDER_OFFICE_COUNT \|\| '0' \}\}/);
  assert.match(component, /const PUBLISHED_PLOTS_ENABLED = process\.env\.NEXT_PUBLIC_PUBLISHED_PLOTS === "true"/);
  // No browser is reachable on a data-only run, so installing one is pure run time.
  assert.match(workflow, /Install Chromium\n\s*if: .*env\.RENDER_OFFICE_COUNT != '0'/);
  // The site itself is still required — it is what serves /api/forecast to the fan-out.
  assert.match(workflow, /npm run start -- --port 3000/);
  // The data tier is never gated on the render tier: dropping imagery must not drop the
  // objects that are the only forecast source in production.
  assert.match(publisher, /await publishObject\(`forecast\/\$\{office\}\.json`/);
});

test("a budget-limited run serves the views that are furthest behind, not the alphabet", async () => {
  const publisher = await readFile(new URL("../scripts/publish-forecast-plots.mjs", import.meta.url), "utf8");
  // Registry order is a *fixed* priority, and a fetch budget that cuts the queue every run
  // turns a fixed priority into permanent starvation rather than a rotation. Measured on
  // run #121: 43 views written inside the 12-minute budget, the render tier then stale
  // offices ABR..DVN, so everything sorting later waited for a next run that made the
  // identical cut — and the seven areas, which had never been published at all, were
  // unreachable across three consecutive runs on the commit that added them.
  assert.match(publisher, /const orderedStale = \[\.\.\.staleOffices\]\.sort\(\(a, b\) => behindnessOf\(a\) - behindnessOf\(b\)\)/);
  // Zero, not -Infinity: `-Infinity - -Infinity` is NaN, and a comparator returning NaN
  // leaves tie order up to the engine. Observed doing exactly that — the areas sorted to
  // the front correctly but shuffled among themselves, so which ones a cut run reached
  // was luck. Every real key is a positive epoch, so zero already sorts ahead of them.
  assert.match(publisher, /if \(!entry\?\.updatedAt\) return 0;/);
  assert.doesNotMatch(publisher, /return Number\.NEGATIVE_INFINITY/);
  // A view with no object at all outranks a merely-old one: stale still draws a map,
  // absent draws nothing.
  assert.match(publisher, /const behindnessOf = \(office\) => \{/);
  // The queue head goes in the run log, because a count alone looks the same whether the
  // order is fair or starving something.
  assert.match(publisher, /most-behind first/);
});

test("the pre-build gate keeps short-circuiting once imagery is off", async () => {
  const probe = await readFile(new URL("../scripts/probe-offices.mjs", import.meta.url), "utf8");
  // latest.json is only rewritten by a successful render, so with imagery off its
  // sourceRevision freezes at the last commit that rendered. Comparing against it
  // unconditionally reports a deploy on *every* run forever, which costs the gate its
  // entire purpose: ~2 minutes of npm ci and a build before the publisher exits anyway.
  assert.match(probe, /const renderEnabled = \(renderCountSetting \? Number\(renderCountSetting\) : 24\) > 0/);
  assert.match(probe, /renderEnabled \? readPublished\("latest\.json"\) : Promise\.resolve\(null\)/);
  assert.match(probe, /const deployNeedsRender = renderEnabled &&/);
  // An unreadable index still resolves towards running the job, imagery or not.
  assert.match(probe, /if \(!forcePublish && previousIndex && !stale\.length && !deployNeedsRender\)/);
  assert.match(probe, /let changed = true/);
});

test("publishes every office and prunes aged-out releases", async () => {
  const [publisher, component, assetRoute, probeModule] = await Promise.all([
    readFile(new URL("../scripts/publish-forecast-plots.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/forecast-assets/[...path]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/office-probe.mjs", import.meta.url), "utf8"),
  ]);
  // Two tiers, both derived from the generated registry rather than a list in the script.
  // Every drawable office gets forecast data — that object is *how* it renders — while
  // only the most populous get pre-rendered PNGs, because a release is ~110 MB per office.
  assert.match(publisher, /data\/offices\.json/);
  assert.match(publisher, /data\/office-population\.json/);
  assert.match(publisher, /const DATA_OFFICES = registry/);
  assert.match(publisher, /const RENDER_OFFICES = RENDER_ENABLED/);
  assert.match(publisher, /populationRank/);
  assert.match(publisher, /RENDER_OFFICE_COUNT/);
  assert.doesNotMatch(publisher, /const OFFICES = \[\s*"[A-Z]{3}"/);
  // The default office must always have imagery, wherever it lands in the ranking.
  // PHI (the default) and US (the national view, absent from the per-CWA ranking) are
  // pinned into the render tier regardless of population.
  assert.match(publisher, /for \(const pinned of \["PHI", "US"\]\)/);
  // A HEAD probe carries `last-modified` with a zero-byte body, so an unchanged office
  // costs one request instead of ~290. Refreshing all 121 blindly is ~35,000 requests.
  // The mechanics live in lib/office-probe.mjs now, shared with the pre-build gate and
  // the freshness route; the publisher is asserted to use that module rather than to
  // carry its own copy of the request.
  assert.match(probeModule, /method: "HEAD"/);
  assert.match(probeModule, /last-modified/);
  assert.match(publisher, /probeAnchor\(anchorFor\(cities\), fetch\)/);
  assert.match(publisher, /forecast\/index\.json/);
  // Forecast data publishes before the imagery decision: an office with no PNGs still
  // needs its forecast refreshed, so an unchanged-imagery run must not exit first.
  assert.ok(
    publisher.indexOf("publishObject(`forecast/${office}.json`") < publisher.indexOf("const renderUnchanged"),
    "forecast data must publish before the render change-check",
  );
  assert.match(publisher, /schemaVersion: 2/);
  assert.match(publisher, /manifest\.offices\[office\] = \{ updatedAt: forecasts\[office\]\.updatedAt, days: await captureOffice\(office\) \}/);
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
  // The asset path guard admits both key shapes and nothing else. Two or three letters:
  // three is a CWA, two is a wide view (`US` and the areas), which the three-letter form
  // rejected outright — see "resolves both published key shapes" for the full matrix.
  assert.match(assetRoute, /\(\?:\[A-Z\]\{2,3\}\\\/\)\?day-\[1-3\]/);
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
  // The three tiers separate by weight and density in one direction, the way SPC's own
  // key draws them — 1 fine and tight, 2 heavier and wider, and only 3 a crosshatch.
  // Leaning 1 and 2 opposite ways (which this used to do) reads as two unrelated
  // categories rather than a scale, and matches no legend SPC publishes.
  const groups = /const HATCH_GROUPS[\s\S]*?\n\];/.exec(component);
  assert.ok(groups, "could not find HATCH_GROUPS");
  const tiers = [...groups[0].matchAll(/group: (\d), .*?lines: ([\d.]+), lineWidth: ([\d.]+), cross: (true|false)/g)]
    .map(([, group, lines, lineWidth, cross]) => ({ group: +group, lines: +lines, lineWidth: +lineWidth, cross: cross === "true" }));
  assert.equal(tiers.length, 3);
  assert.ok(tiers[0].lines > tiers[1].lines, "tier 1 must be the denser hatch");
  assert.ok(tiers[0].lineWidth < tiers[1].lineWidth, "tier 1 must be the finer stroke");
  assert.deepEqual(tiers.map((t) => t.cross), [false, false, true], "only tier 3 crosshatches");
  // Tier 1 is dashed, which is what separates it from tier 2 at a glance in SPC's key —
  // thinner-but-solid reads as the same hatch drawn lighter, not as a different tier.
  const dashes = [...groups[0].matchAll(/dash: \[([^\]]*)\]/g)].map(([, inner]) => inner.trim());
  assert.equal(dashes.length, 3);
  assert.ok(dashes[0].length > 0, "tier 1 must be dashed");
  assert.equal(dashes[1], "", "tier 2 must be solid");
  assert.equal(dashes[2], "", "tier 3 must be solid");
  assert.match(component, /tileContext\.setLineDash\(spec\.dash\);/);
  // Hail's published key has no third box; the map still draws a group above it.
  assert.match(component, /maxIntensity: 2,/);
  assert.match(component, /HATCH_GROUPS\.filter\(\(entry\) => entry\.group <= \(spec\.maxIntensity \?\? 3\)\)/);
  // Hatching qualifies the probability underneath it rather than ranking against it, so
  // it is painted over the fills, never blended into them.
  assert.match(component, /for \(const hatch of outlook\.hatches\)/);
  assert.match(component, /"INTENSITY"/);
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

test("an unset workflow variable falls back to the default, not to zero", async () => {
  const [publisher, workflow] = await Promise.all([
    readFile(new URL("../scripts/publish-forecast-plots.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/publish-forecast-plots.yml", import.meta.url), "utf8"),
  ]);
  // GitHub renders an unset `vars.X` as the empty string, so the workflow always defines
  // the variable — `?? default` never fires and `Number("")` is 0. That zeroed both phase
  // budgets, and a zero budget is not "no limit", it is "stop after the first office":
  // every run fetched one office's forecast and rendered one office's imagery, so 121
  // offices froze at whatever the last unbudgeted run had published.
  const passedThrough = [...workflow.matchAll(/^\s{6}([A-Z0-9_]+): \$\{\{ vars\./gm)].map((m) => m[1]);
  assert.ok(passedThrough.length > 0, "workflow passes no repository variables through");
  for (const name of passedThrough) {
    assert.doesNotMatch(
      publisher,
      new RegExp(`Number\\(\\s*process\\.env\\.${name}\\s*\\?\\?`),
      `${name} is blank when the variable is unset, so \`?? default\` cannot catch it`,
    );
  }
  // The blank-tolerant shape the settings already established for retention and counts.
  assert.match(publisher, /const fetchBudgetSetting = process\.env\.PLOT_FETCH_BUDGET_MS\?\.trim\(\)/);
  assert.match(publisher, /fetchBudgetSetting \? Number\(fetchBudgetSetting\) : 12 \* 60 \* 1000/);
  assert.match(publisher, /const captureBudgetSetting = process\.env\.PLOT_CAPTURE_BUDGET_MS\?\.trim\(\)/);
  assert.match(publisher, /captureBudgetSetting \? Number\(captureBudgetSetting\) : 15 \* 60 \* 1000/);
});

test("an unchanged run exits before it fetches anything", async () => {
  const publisher = await readFile(new URL("../scripts/publish-forecast-plots.mjs", import.meta.url), "utf8");
  // The probe is the cheap part (one zero-byte HEAD per office); the fetch is the
  // expensive part (~290 gridpoint requests per office, and every render-tier office is
  // fetched unconditionally). Exiting between them is the entire point of this check, so
  // pin the ordering — a refactor that moves the exit back below the fetch would leave
  // every other assertion here passing.
  const shortCircuit = publisher.indexOf("nothing to publish");
  const fetchPhase = publisher.indexOf("const forecasts = {}");
  assert.ok(shortCircuit > 0, "no probe-level short-circuit found");
  assert.ok(fetchPhase > 0, "fetch phase marker not found");
  assert.ok(shortCircuit < fetchPhase, "the short-circuit must come before the fetch phase");

  // A new deploy must re-render even when NWS has not moved — that is how a newly added
  // product reaches an already-published office. Asserted against the early exit's own
  // condition, not a bare regex: `previous?.sourceRevision === sourceRevision` also
  // appears in the late renderUnchanged check, so a plain match would pass even if the
  // early exit dropped the clause entirely.
  //
  // The clause is conditional on the render tier because it reads latest.json, which only
  // a successful render rewrites. With imagery off that file freezes at the last commit
  // that rendered, so an unconditional comparison would report "changed" on every run
  // forever and fetch nothing — a run that costs a build and publishes an unchanged index.
  assert.match(
    publisher,
    /const nothingToPublish = !forcePublish && !staleOffices\.length\n\s*&& \(!RENDER_ENABLED \|\| previous\?\.sourceRevision === sourceRevision\)/,
  );
  // One probe implementation, shared with the pre-build gate.
  assert.match(publisher, /from "\.\.\/lib\/office-probe\.mjs"/);
  assert.match(publisher, /from "\.\.\/lib\/pooled\.mjs"/);
});

test("an idle run is gated before the build, and the schedule is dense", async () => {
  const [workflow, probe] = await Promise.all([
    readFile(new URL("../.github/workflows/publish-forecast-plots.yml", import.meta.url), "utf8"),
    readFile(new URL("../scripts/probe-offices.mjs", import.meta.url), "utf8"),
  ]);
  // The gate must run before the expensive setup, or it saves nothing: the publisher's
  // own short-circuit sits behind npm ci, a Chromium download and a production build.
  const gateStep = workflow.indexOf("scripts/probe-offices.mjs");
  const install = workflow.indexOf("run: npm ci");
  const build = workflow.indexOf("run: npm run build");
  assert.ok(gateStep > 0, "no pre-build probe step");
  assert.ok(gateStep < install, "the probe gate must run before npm ci");
  assert.ok(gateStep < build, "the probe gate must run before the build");
  // Every step after the gate is conditional on it — count them rather than matching
  // once, so adding a step without gating it fails here.
  const gated = [...workflow.matchAll(/steps\.probe\.outputs\.changed != 'false'/g)].length;
  const stepCount = [...workflow.matchAll(/^ {6}- name: /gm)].length;
  assert.equal(gated, stepCount - 4, "every step after the probe gate must be conditional on it");

  // A probe that crashes must fall through to a full run, not skip the job. That needs
  // both halves: continue-on-error so the step failing doesn't fail the job, and a
  // `!= 'false'` gate so a missing output still runs. `== 'true'` would skip.
  assert.match(workflow, /continue-on-error: true/);
  assert.doesNotMatch(workflow, /steps\.probe\.outputs\.changed == 'true'/);

  // Quarter-hourly all day, filled to five-minute spacing in the issuance windows using
  // only the offsets the first cron does not already cover — GitHub queues one run per
  // matching cron, so an overlap is duplicate runs, not denser checking.
  assert.match(workflow, /cron: "\*\/15 \* \* \* \*"/);
  assert.match(workflow, /cron: "5,10,20,25,35,40,50,55 3,4,15,16 \* \* \*"/);
  const windowMinutes = /cron: "([\d,]+) 3,4,15,16 \* \* \*"/.exec(workflow)[1].split(",").map(Number);
  assert.ok(windowMinutes.every((m) => m % 15 !== 0), "window cron must not repeat quarter-hour slots");

  // The gate shares the publisher's probe rather than reimplementing it.
  assert.match(probe, /from "\.\.\/lib\/office-probe\.mjs"/);
  // An unreadable manifest or index must not be read as "nothing changed".
  assert.match(probe, /let changed = true/);
  // And it must not hang: this step's value is that an idle run ends in ~20s.
  assert.match(probe, /AbortSignal\.timeout/);
});

test("imagery is re-rendered per office, not on the default office's clock", async () => {
  const [publisher, component] = await Promise.all([
    readFile(new URL("../scripts/publish-forecast-plots.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
  ]);
  // `forecast` is PHI's payload (or the first renderable office's). Comparing the whole
  // release against that one timestamp meant an office could reissue, have its data
  // refreshed, and keep serving yesterday's PNGs because PHI happened not to move —
  // which is most of the render tier, most of the time.
  assert.doesNotMatch(publisher, /previous\?\.updatedAt === forecast\.updatedAt/);
  assert.match(publisher, /const staleRenderOffices = renderable\.filter/);
  assert.match(publisher, /!staleRenderOffices\.length/);

  // Which requires the manifest to record each office's own issuance, not just the
  // release-level one. That is also what lets the page date what it is showing.
  assert.match(publisher, /manifest\.offices\[office\] = \{ updatedAt: forecasts\[office\]\.updatedAt/);

  // The client must read that per-office field. The top-level `updatedAt` is the
  // representative office's, so using it labels every published office with PHI's time.
  assert.match(component, /function publishedUpdatedAtFor/);
  assert.doesNotMatch(component, /hasPublishedOffice \? publishedForecast\?\.updatedAt/);
});

test("resolves both published key shapes and rejects anything else", async () => {
  const source = await readFile(new URL("../app/api/forecast-assets/[...path]/route.ts", import.meta.url), "utf8");
  // An id is two *or three* uppercase letters. Three is a CWA; two is a wide view — `US`
  // and every area id, which are two letters by construction so they cannot collide with
  // an office. Pinned as a literal because `[A-Z]{3}` here used to 400 `forecast/US.json`
  // before any network call, leaving the national view with no data source in production.
  const pattern = /^releases\/\d{8}T\d{6}Z\/(?:[A-Z]{2,3}\/)?day-[1-3]\/[a-z][a-z-]*\.png$/;
  const forecastPattern = /^forecast\/[A-Z]{2,3}\.json$/;
  // Guard against the literals in the route drifting from what this test asserts.
  assert.ok(source.includes(pattern.source), "route release regex no longer matches the tested pattern");
  assert.ok(source.includes(forecastPattern.source), "route forecast regex no longer matches the tested pattern");

  for (const key of [
    "releases/20260724T205317Z/PHI/day-1/max-apparent-temperature.png",
    "releases/20260724T205317Z/OKX/day-3/total-precipitation-preview.png",
    "releases/20260724T205317Z/day-1/max-apparent-temperature.png",
    // The wide views, which are exactly the case the three-letter form dropped.
    "releases/20260724T205317Z/US/day-1/max-temperature.png",
    "releases/20260724T205317Z/MA/day-2/max-temperature.png",
  ]) {
    assert.ok(pattern.test(key), `expected ${key} to be served`);
  }
  for (const key of [
    "releases/../../etc/passwd.png",
    "releases/20260724T205317Z/phi/day-1/max-temperature.png",
    "releases/20260724T205317Z/PHI/day-9/max-temperature.png",
    "releases/20260724T205317Z/PHI/day-1/../../secret.png",
    "latest.json",
    // Still bounded on both sides — widening to {2,3} must not admit any length.
    "releases/20260724T205317Z/T/day-1/max-temperature.png",
    "releases/20260724T205317Z/TOOLONG/day-1/max-temperature.png",
  ]) {
    assert.ok(!pattern.test(key), `expected ${key} to be rejected`);
  }

  // The data tier is the half production cannot do without: /api/forecast 504s there, so a
  // key this guard rejects is a view that cannot render at all.
  for (const key of ["forecast/PHI.json", "forecast/US.json", "forecast/MA.json", "forecast/NW.json"]) {
    assert.ok(forecastPattern.test(key), `expected ${key} to be served`);
  }
  for (const key of ["forecast/phi.json", "forecast/A.json", "forecast/TOOLONG.json", "forecast/PHI.txt", "forecast/../secret.json"]) {
    assert.ok(!forecastPattern.test(key), `expected ${key} to be rejected`);
  }
});

test("a wide-frame view stops the field at the land it covers", async () => {
  const component = await readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8");
  // Only views with no CWA to outline — national, and regions built the same way. A single
  // office must stay unclipped: its lattice legitimately covers the whole frame with real
  // data from its neighbours, and clipping it would carve the field back to the CWA.
  assert.match(component, /const clipToLand = !bundle\.cwa && bundle\.states\.length > 0;/);
  // Accumulated into one path so the nonzero fill rule unions the states; a per-state
  // clip() would intersect them and leave nothing.
  assert.match(component, /for \(const area of bundle\.states\) addAreaToPath\(context, area, projectPoint\);/);
  assert.match(component, /function addAreaToPath/);
  const render = component.slice(component.indexOf("async function renderPlot"));
  const clip = render.slice(render.indexOf("const clipToLand"), render.indexOf("releaseCanvas(raster)"));
  assert.ok(clip.indexOf("context.clip()") < clip.indexOf("context.drawImage(raster"), "the clip must be set before the raster is composited");
  assert.match(clip, /if \(clipToLand\) context\.restore\(\);/);
  // The national bundle carries the states this clips to; without them it would silently
  // fall through to an unclipped raster.
  const us = JSON.parse(await readFile(new URL("../public/offices/US.json", import.meta.url), "utf8"));
  assert.equal(us.cwa, null, "the national view must have no CWA");
  assert.ok(us.states.length >= 48, `national bundle carries only ${us.states.length} states`);
});

test("turning off the published imagery does not turn off the forecast data", async () => {
  const component = await readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8");
  // Two tiers ride on R2 and they are not interchangeable. The PNGs are optional — the
  // live canvas re-renders them and is never stale. `forecast/{OFFICE}.json` is not:
  // /api/forecast blows both the 50-subrequest ceiling and the 10 ms CPU budget, so
  // production has no other source. They must stay on separate switches.
  assert.match(component, /const PUBLISHED_PLOTS_ENABLED = process\.env\.NEXT_PUBLIC_PUBLISHED_PLOTS === "true"/);
  // The imagery is gated on both flags…
  assert.match(component, /if \(!PUBLISHED_ASSET_BASE_URL \|\| !PUBLISHED_PLOTS_ENABLED\) return;/);
  // …while the data fetch is gated on the base URL alone. If this ever picks up
  // PUBLISHED_PLOTS_ENABLED, switching the PNGs off drops production onto /api/forecast.
  const loader = component.slice(component.indexOf("async function loadForecast"));
  const body = loader.slice(0, loader.indexOf("\n}"));
  assert.match(body, /if \(PUBLISHED_ASSET_BASE_URL\) \{/);
  assert.ok(!body.includes("PUBLISHED_PLOTS_ENABLED"), "the forecast data must not depend on the imagery switch");
  assert.match(body, /forecast-assets\/forecast\/\$\{office\}\.json/);
});

test("asks for alerts in the one zone-parameter form that actually unions", async () => {
  const route = await readFile(new URL("../app/api/alerts/route.ts", import.meta.url), "utf8");
  // The upstream does NOT treat repeated `zone=` parameters as a union — it returns fewer
  // alerts as you add more, and at 66 zones it returns none at all, which is
  // indistinguishable from a quiet day. Measured: repeated form 1→5, 5→1, 20→2, 66→0;
  // comma form 1→5, 5→8, 20→11, 66→16. Only the comma form is monotonic.
  assert.match(route, /new URLSearchParams\(nationwide \? \{\} : \{ zone: zones\.join\(","\) \}\)/);
  assert.ok(!/append\(\s*"zone"/.test(route), "repeated zone= parameters silently return almost nothing");
  // A wide view can't use the comma form either — the national frame reaches 7,451 zones,
  // far past the ~8 KB outbound URL the upstream accepts — so it asks unfiltered and
  // narrows client-side against the zones it carries. Still exactly one upstream request.
  assert.match(route, /const nationwide = parameters\.get\("scope"\) === "all"/);
  assert.match(route, /if \(!zones\.length && !nationwide\)/);
  // One upstream request regardless of zone count is what makes this route affordable
  // where /api/forecast is not; a per-zone fetch would be the same fan-out that keeps
  // /api/forecast off the production path.
  assert.equal((route.match(/await fetch\(/g) ?? []).length, 1);
});

test("validates zone codes before they reach an outbound URL", async () => {
  const route = await readFile(new URL("../app/api/alerts/route.ts", import.meta.url), "utf8");
  const pattern = /^[A-Z]{2}[CZ]\d{3}$/;
  assert.ok(route.includes(pattern.source), "route regex no longer matches the tested pattern");
  for (const code of ["NYC105", "NYZ072", "ANZ335", "PHZ113", "GMZ155"]) {
    assert.ok(pattern.test(code), `expected ${code} to be accepted`);
  }
  for (const code of ["../../etc/passwd", "NYZ72", "nyz072", "NY0072", "NYZ072&area=XX", ""]) {
    assert.ok(!pattern.test(code), `expected ${code} to be rejected`);
  }
});

test("draws every office's alerts from a zone bundle it actually carries", async () => {
  const registry = JSON.parse(await readFile(new URL("../scripts/data/offices.json", import.meta.url), "utf8"));
  // Wide views are excluded, not just the national one: an area is no more a CWA than the
  // nation is, so no zone declares it and there is nothing to join against. The renderer
  // makes the same test before it fetches, and says so rather than erroring.
  const drawable = registry.filter((office) => office.ready && !isWideView(office.id)).map((office) => office.id);
  const files = new Set((await readdir(new URL("../public/zones/", import.meta.url))).filter((n) => n.endsWith(".json")));
  for (const id of drawable) {
    assert.ok(files.has(`${id}.json`), `no zone bundle for ${id}`);
  }

  // Both zone families have to be present. Alerts are issued against county zones
  // (NYC105) and forecast zones (NYZ072) interchangeably — a Flash Flood Warning uses the
  // first, a Flood Watch the second — so carrying only one silently loses half of them.
  const okx = JSON.parse(await readFile(new URL("../public/zones/OKX.json", import.meta.url), "utf8"));
  const codes = Object.keys(okx.zones);
  // Zones are claimed by frame overlap, not just by the CWA that issues them, so the map
  // fills the plot instead of stopping at the office border. OKX issues for 66 zones and
  // its frame reaches well over twice that; a file back down at the owned count means the
  // build reverted to ownership-only and the map will mask to the CWA again.
  assert.ok(codes.length > 100, `OKX carries only ${codes.length} zones — expected its whole frame`);
  assert.ok(codes.some((code) => code.startsWith("CT") || code.startsWith("NJ")), "expected neighbouring states in frame");
  assert.ok(codes.some((code) => code[2] === "C"), "expected county zones");
  assert.ok(codes.some((code) => /^[A-Z]{2}Z/.test(code) && !code.startsWith("AN")), "expected forecast zones");
  // Marine, or a coastal office loses its Small Craft Advisories entirely.
  assert.ok(codes.some((code) => code.startsWith("ANZ")), "expected marine zones for a coastal office");
  for (const geometry of Object.values(okx.zones)) {
    assert.ok(geometry.type === "Polygon" || geometry.type === "MultiPolygon", "zone geometry must be drawable");
  }
});

test("a wide view draws alerts, scoped to the zones it actually carries", async () => {
  const [component, zoneBuild] = await Promise.all([
    readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/build-office-zones.mjs", import.meta.url), "utf8"),
  ]);

  // Every view gets a zone bundle, wide ones included. They were excluded on the grounds
  // that a national bundle would cost "megabytes apiece" — raw it is 5.4 MB, but gzipped,
  // which is what a browser transfers, it is ~1.1 MB against PHI's ~326 KB, for 7,451 zones
  // against 318. Affordable for a tab that is only ever opened deliberately.
  assert.doesNotMatch(zoneBuild, /if \(isWideView\(bundle\.office\)\) continue;/);
  const zoneFiles = new Set(await readdir(new URL("../public/zones/", import.meta.url)));
  for (const id of ["US", ...AREAS.map((area) => area.id)]) {
    assert.ok(zoneFiles.has(`${id}.json`), `expected a zone bundle for the ${id} view`);
  }

  // A wide view cannot ask by zone: the comma-joined form would run the outbound URL past
  // the ~8 KB the upstream accepts long before 7,451 zones. It asks for everything in
  // force instead, and one cached response then serves the nation and all seven areas.
  assert.match(component, /isWideView\(office\.id\) \? "scope=all"/);

  // Membership is decided by the zones an alert names, never by whether it is drawable.
  // `alertGeometries` returns an alert's *own* polygon without asking where that polygon
  // is, so once wide views started receiving every alert in force, a storm-based warning
  // in Texas would have counted as drawable on the Mid-Atlantic map.
  assert.match(component, /function alertInView/);
  assert.match(component, /alert\.zones\.some\(\(code\) => zones\[code\] !== undefined\)/);
  // …and the filter runs before anything counts, draws or lists it, so the header total,
  // the map and the strip cannot disagree.
  const panel = component.slice(component.indexOf("function AlertsPanel"), component.indexOf("function publishedAssetUrl"));
  assert.ok(panel.length > 0, "expected to find the AlertsPanel body");
  assert.match(panel, /\.filter\(\(alert\) => alertInView\(alert, zones\)\)/);
  assert.match(panel, /<AlertsPlot alerts=\{sorted\}/);
  // The old "pick an office" bail-out must be gone, or wide views never render at all.
  assert.doesNotMatch(panel, /Watches and warnings are issued per forecast office/);
});

test("a sub-pixel ring collapses to a quad instead of keeping every vertex", async () => {
  const { simplify, toleranceFor } = await import("../lib/geo-simplify.mjs");

  // Douglas-Peucker's closed-ring fallback returns the *original* when simplification drops
  // under four points — correct, but it means the hardest-simplified rings keep every
  // vertex. At a wide zoom that is exactly backwards: a zone smaller than a pixel is the
  // one that collapses, and it came back at full resolution. That put 88% of US.json's
  // 689,078 points into 10% of its zones, one of them 14,243 points for a pixel-sized
  // shape. Collapsing to a bounding quad cut the file from 2,971 KB gzipped to 1,163 KB.
  const tolerance = toleranceFor(4);
  // A crinkly ring far smaller than the tolerance — sub-pixel at this zoom.
  const tiny = Array.from({ length: 200 }, (_, i) => {
    const angle = (i / 200) * Math.PI * 2;
    return [Math.cos(angle) * 0.004, Math.sin(angle) * 0.004];
  });
  tiny.push(tiny[0]);
  // Default: the whole ring survives, which is the behaviour every other caller relies on.
  assert.equal(simplify(tiny, tolerance, true).length, tiny.length);
  // With collapse: a closed five-point quad.
  const collapsed = simplify(tiny, tolerance, true, true);
  assert.equal(collapsed.length, 5, "expected a closed bounding quad");
  assert.deepEqual(collapsed[0], collapsed[4], "the quad must close");
  // …and it must still cover the ring it replaced, or an alert would paint off its zone.
  const lons = tiny.map(([lon]) => lon);
  const lats = tiny.map(([, lat]) => lat);
  const quadLons = collapsed.map(([lon]) => lon);
  const quadLats = collapsed.map(([, lat]) => lat);
  assert.ok(Math.min(...quadLons) <= Math.min(...lons) + 1e-9);
  assert.ok(Math.max(...quadLons) >= Math.max(...lons) - 1e-9);
  assert.ok(Math.min(...quadLats) <= Math.min(...lats) + 1e-9);
  assert.ok(Math.max(...quadLats) >= Math.max(...lats) - 1e-9);

  // A ring with real structure at this tolerance is untouched either way — collapse must
  // not be a licence to flatten anything that merely looks simple. A rectangle reduces to
  // its four corners legitimately (Colorado and Texas counties really are rectangles).
  const rectangle = [[0, 0], [2, 0], [2, 1], [0, 1], [0, 0]];
  assert.deepEqual(simplify(rectangle, tolerance, true, true), simplify(rectangle, tolerance, true));

  // Only the zone build opts in; bundles must keep producing byte-identical output.
  const zoneBuild = await readFile(new URL("../scripts/build-office-zones.mjs", import.meta.url), "utf8");
  const bundleBuild = await readFile(new URL("../scripts/build-office-bundles.mjs", import.meta.url), "utf8");
  assert.match(zoneBuild, /1e4,\s*\n\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*true,/);
  assert.doesNotMatch(bundleBuild, /toleranceFor\([^)]*\),\s*\n?[^)]*true,\s*\n?\s*true/);
});

test("active alerts flow past, and a long location list never takes the strip over", async () => {
  const component = await readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8");

  // The budget is in *characters*, not entries, and that distinction is the whole point:
  // land alerts fail by listing a dozen counties, marine alerts fail at two, because their
  // zone names are prose ("Chesapeake Bay from Drum Point MD to Smith Point VA" is 50 on
  // its own). An entry-count rule waves the marine case straight through at 118 characters.
  assert.match(component, /const ALERT_PLACES_MAX = \d+/);
  const places = component.slice(component.indexOf("function alertPlaces"), component.indexOf("const TICKER_PX_PER_SECOND"));
  assert.ok(places.length > 0, "expected to find alertPlaces");
  assert.match(places, /whole\.length <= ALERT_PLACES_MAX/);
  assert.match(places, /clampWords\(parts\[0\], ALERT_PLACES_MAX - rest\.length\)/);

  // Re-implemented here from the same rules, so the budget is checked against real payload
  // shapes rather than merely asserted to exist in the source.
  const max = Number(/const ALERT_PLACES_MAX = (\d+)/.exec(component)[1]);
  const clampWords = (text, limit) => {
    if (text.length <= limit) return text;
    const cut = text.slice(0, limit);
    const boundary = cut.lastIndexOf(" ");
    return `${(boundary > limit * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
  };
  const alertPlaces = (areaDesc) => {
    const parts = (areaDesc ?? "").split(";").map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return "";
    const whole = parts.join(" · ");
    if (whole.length <= max) return whole;
    if (parts.length === 1) return clampWords(parts[0], max);
    const rest = ` +${parts.length - 1}`;
    return clampWords(parts[0], max - rest.length) + rest;
  };

  // Real shapes seen on api.weather.gov, longest first.
  const samples = [
    "Northern Litchfield; " + Array.from({ length: 26 }, (_, i) => `Zone ${i}`).join("; "),
    "Chesapeake Bay from Drum Point MD to Smith Point VA; Tangier Sound and the inland waters surrounding Bloodsworth Island",
    "Albany, NY; Greene, NY; Rensselaer, NY; Saratoga, NY; Schenectady, NY; Ulster, NY",
    "Coastal waters from Fenwick Island DE to Chincoteague VA out 20 nm",
  ];
  for (const sample of samples) {
    const out = alertPlaces(sample);
    assert.ok(out.length <= max + 1, `"${out}" is ${out.length} characters, over the ${max} budget`);
    assert.ok(out.length < sample.length, "a long list must actually be shortened");
  }
  // Short ones are left whole — hiding one county behind "+1" buys nothing.
  assert.equal(alertPlaces("Ulster, NY"), "Ulster, NY");
  assert.equal(alertPlaces(""), "");
  assert.equal(alertPlaces(null), "");

  // The loop is only seamless because half the track is a whole number of copies, so the
  // copy count must be even, and there must be enough copies to cover the viewport — two
  // copies of one short alert would drag a gap of empty space across the panel each cycle.
  const ticker = component.slice(component.indexOf("function AlertsTicker"), component.indexOf("function AlertsPlot"));
  assert.ok(ticker.length > 0, "expected to find AlertsTicker");
  assert.match(ticker, /needed % 2 === 0 \? needed : needed \+ 1/);
  assert.match(ticker, /Math\.max\(2, Math\.ceil\(\(host\.clientWidth \* 2\) \/ width\)\)/);
  // Duration from measured width, so the strip travels at one speed at any alert count.
  assert.match(ticker, /\(width \* \(copies \/ 2\)\) \/ TICKER_PX_PER_SECOND/);
  // Only the first copy is the list; the rest would otherwise be read out again and again.
  assert.match(ticker, /aria-hidden=\{copy > 0 \|\| undefined\}/);
  // Measured off the effect's synchronous path — a setState in an effect body cascades.
  assert.match(ticker, /queueMicrotask\(apply\)/);
  assert.match(ticker, /prefers-reduced-motion: reduce/);
});

test("the alerts map is not mistaken for a publishable product", async () => {
  const component = await readFile(new URL("../app/components/ForecastGraphic.tsx", import.meta.url), "utf8");
  const plot = component.slice(component.indexOf("function AlertsPlot"), component.indexOf("function AlertsPanel"));
  // The publisher discovers what to capture by querying canvas[data-product-id]. This is a
  // live map with no PRODUCTS entry and no day, so tagging it would put an un-renderable
  // product into every release.
  // Matched as a JSX attribute, not as a bare string: the comment above the canvas names
  // the selector the publisher uses, and it should stay there.
  assert.ok(!/data-product-id=/.test(plot), "the alerts canvas must not advertise a product id");
  assert.ok(!/data-day-index=/.test(plot), "the alerts canvas belongs to no forecast day");
  // Warnings must paint over watches, which paint over advisories — they overlap for hours
  // at a time, and CAP severity cannot express the tier (a Flood Watch and a Tornado
  // Warning are both "Severe").
  // Alerts composite on their own layer at full opacity, and the layer goes down once.
  // Painting each at 0.55 straight onto the map blended every overlap — a Severe
  // Thunderstorm Watch over a Flood Watch came out olive, a colour in neither the legend
  // nor NWS's palette, and the same hazard changed colour depending on what sat under it.
  // Alerts overlap almost everywhere, so this is the normal case, not an edge case.
  const alertPlot = component.slice(component.indexOf("async function renderAlertPlot"), component.indexOf("function AlertsPlot"));
  assert.match(alertPlot, /const layerContext = layer\.getContext\("2d"\)!;/);
  assert.match(alertPlot, /layerContext\.fill\("evenodd"\);/);
  // No per-alert alpha anywhere in the paint loop.
  const paintLoop = alertPlot.slice(alertPlot.indexOf("for (const { alert, geometries } of drawable)"), alertPlot.indexOf("drawReferenceLayers"));
  assert.doesNotMatch(paintLoop, /layerContext\.globalAlpha/, "alerts must be opaque within the layer");
  assert.match(alertPlot, /context\.globalAlpha = ALERT_LAYER_ALPHA;\s*\n\s*context\.drawImage\(layer/);
  // Ascending rank, so the highest-priority alert is painted last and wins the pixel.
  assert.match(component, /\.sort\(\(a, b\) => alertRank\(a\.alert\.event\) - alertRank\(b\.alert\.event\)\)/);
  assert.match(component, /function alertRank/);
  assert.match(component, /\.sort\(\(a, b\) => alertRank\(a\.alert\.event\) - alertRank\(b\.alert\.event\)\)/);

  // Rebuild alertRank from the source so the ordering itself is tested, not just its
  // shape. Tier is multiplied out so a hazard score can never overturn it.
  const table = /const ALERT_HAZARDS[\s\S]*?\n\];/.exec(component);
  assert.ok(table, "could not find ALERT_HAZARDS");
  const hazards = [...table[0].matchAll(/\[(\/[^\]]+?\/i), (\d+)\]/g)]
    .map(([, source, score]) => [new RegExp(source.slice(1, -2), "i"), Number(score)]);
  assert.ok(hazards.length >= 10, `only parsed ${hazards.length} hazard rules`);
  assert.match(component, /return tier \* 1000 \+ hazard;/);
  const rank = (event) => {
    const tier = /\bwarning\b/i.test(event) ? 3 : /\bwatch\b/i.test(event) ? 2 : /\badvisory\b/i.test(event) ? 1 : 0;
    return tier * 1000 + (hazards.find(([pattern]) => pattern.test(event))?.[1] ?? 10);
  };
  // Within a tier the hazard decides — this is the case tier-only ranking got wrong, and
  // CAP severity cannot fix it because both of these report "Severe".
  assert.ok(rank("Severe Thunderstorm Watch") > rank("Flood Watch"));
  assert.ok(rank("Tornado Watch") > rank("Severe Thunderstorm Watch"));
  assert.ok(rank("Flash Flood Warning") > rank("Flood Warning"), "specific hazard must outrank the general one");
  // …but tier still dominates: a Flood Warning outranks any watch.
  assert.ok(rank("Flood Warning") > rank("Tornado Watch"));
  assert.ok(rank("Flood Watch") > rank("Flood Advisory"));
  assert.ok(rank("Flood Advisory") > rank("Special Weather Statement"));
});

test("ships one self-contained map bundle per forecast office", async () => {
  const dir = new URL("../public/offices/", import.meta.url);
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  // 125 CWAs plus the synthetic wide views — the national map and the unofficial areas —
  // which ride the same pipeline as an office. Counted off AREAS rather than restated as
  // a number, so adding an area to lib/areas.mjs doesn't fail a test that has no opinion
  // about how many there are.
  assert.equal(names.length, 126 + AREAS.length, "expected a bundle per office plus every wide view");
  assert.ok(names.includes("US.json"), "expected a national bundle");
  for (const area of AREAS) {
    assert.ok(names.includes(`${area.id}.json`), `expected a bundle for the ${area.id} area`);
  }

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
