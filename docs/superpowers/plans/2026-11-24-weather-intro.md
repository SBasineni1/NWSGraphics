# Weather Intro Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A once-per-session full-screen intro: an invented surface-pressure field drawn live on a canvas, in which a low passes through and the isobars relax, dismissed by a click.

**Architecture:** The field and contouring are pure functions in `lib/intro-field.mjs`, tested under Node. `app/components/WeatherIntro.tsx` draws them on a canvas each animation frame, over the forecast page, which keeps loading underneath. An inline script in `app/layout.tsx` hides the server-rendered overlay before first paint when the session has already seen it.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Canvas 2D, `node:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-24-weather-intro-design.md`

## Global Constraints

- No new dependency, no new font, no data download. The headline font is Barlow Semi Condensed 700 via the existing `--font-plot` variable (`app/fonts.ts`).
- Ground `#EAE7E0`, ink `#171717`, isolines ~1 CSS px at ~70% ink.
- Isobars every **4 hPa**; the low's depth ramps 0 → ~−20 hPa → 0.
- Timeline (seconds): 0–1 calm; 1–4 the low arrives and deepens; 4–6 it passes to the right of the headline at peak; 6–8 it exits and fills; after that the background keeps drifting slowly until dismissed.
- Copy, verbatim: eyebrow `DAY 1–3`; headline stacked `NWS` / `FORECAST` / `GRAPHICS`; prompt `CLICK ANYWHERE TO ENTER` fading in at ~2 s, bottom right; accessible button label `Enter site`.
- Dismiss on a click anywhere, or Enter / Escape / Space, at any moment; ~400 ms fade.
- Once per browser session (`sessionStorage`); `prefers-reduced-motion: reduce` gets one still frame of the mature low.
- Contour cell ~12 CSS px; device pixel ratio capped at 2; the loop stops on dismissal and pauses while the tab is hidden.
- `ForecastGraphic.tsx` is not modified.
- The user commits their own work: the "Commit" steps below stage files and propose a message; do not run `git commit` unless the user says to.

## Review Focus

1. **JavaScript disabled or failed to hydrate:** the overlay is in the server HTML, so without JS it would cover the site forever. A visitor without JS must see the site. → `<noscript>` style in Task 3, pinned by the SSR test.
2. **`sessionStorage` throws** (storage disabled, some private modes): the intro must still show and still dismiss, and the inline head script must not throw. → try/catch in both places, Task 3 test asserts the script is wrapped.
3. **Extreme aspect ratios** (portrait phone ~0.45, ultrawide ~3.2): the low must still cross the visible frame and form closed rings. → Task 1 test runs the peak-ring assertion at aspects 0.45, 1.6 and 3.2.
4. **Tab hidden mid-animation:** on return the story resumes where it left off, rather than jumping to the end. → the animation clock advances only while visible (Task 2), checked in the Task 2 browser verification.
5. **Dismiss spam** (double click, held key, a click during the fade): dismissal is idempotent and nothing runs after unmount (no rAF, listeners or timers left). → Task 2 browser verification checks the console stays clean.

---

### Task 1: Pressure field and contouring (`lib/intro-field.mjs`)

**Files:**
- Create: `lib/intro-field.mjs`
- Test: `tests/intro-field.test.mjs`
- Modify: `package.json` (`test` script: add `tests/intro-field.test.mjs` to the `node --test` list)

**Interfaces:**
- Produces (JSDoc-typed, like `lib/field-neighbors.mjs`; coordinates are normalised, `x` 0→1 west→east across the width, `y` 0→1 north→south down the height; `aspect` = width / height):
  - `INTRO_TIMELINE = { calmEnd: 1, peak: 4.5, exit: 8 }` (seconds)
  - `ISOBAR_STEP = 4`
  - `lowAt(t: number): { x: number, y: number, depth: number, radius: number }`. `depth` in hPa (≤ 0), `radius` in units of frame height.
  - `pressureAt(x: number, y: number, t: number, aspect: number): number` in hPa
  - `sampleField(nx: number, ny: number, t: number, aspect: number): Float64Array`, row-major, index `j * nx + i` at `(i / (nx - 1), j / (ny - 1))`
  - `isobarLevels(min: number, max: number, step?: number): number[]`, multiples of `step` strictly inside `[min, max]`, ascending
  - `contourLines(values: Float64Array, nx: number, ny: number, level: number): Array<Array<[number, number]>>`. Polylines in grid units (`0..nx-1`, `0..ny-1`). A closed ring repeats its first point last.

- [ ] **Step 1: Write the failing tests** in `tests/intro-field.test.mjs`:

```js
test("isobarLevels returns the 4 hPa multiples inside the range", () => {
  assert.deepEqual(isobarLevels(997.3, 1021.1), [1000, 1004, 1008, 1012, 1016, 1020]);
});

test("the low is absent while calm and after it exits, and ~20 hPa deep at peak", () => {
  assert.equal(lowAt(0).depth, 0);
  assert.equal(lowAt(INTRO_TIMELINE.exit).depth, 0);
  assert.equal(lowAt(20).depth, 0);
  assert.ok(Math.abs(lowAt(INTRO_TIMELINE.peak).depth + 20) < 1);
  assert.ok(lowAt(INTRO_TIMELINE.peak).radius < lowAt(2).radius, "rings tighten as it deepens");
});

test("the low tracks west-south-west to east-north-east and peaks right of the headline", () => {
  const a = lowAt(2), b = lowAt(INTRO_TIMELINE.peak), c = lowAt(7);
  assert.ok(a.x < b.x && b.x < c.x);
  assert.ok(a.y > b.y && b.y > c.y);
  assert.ok(b.x > 0.5 && b.x < 0.75 && b.y > 0.2 && b.y < 0.8);
});

// Local, not global: the background gradient can legitimately put a frame corner lower
// than the low. What the L needs is to sit at the bottom of its own rings.
test("the low's centre is the minimum of its own neighbourhood at peak", () => {
  const t = INTRO_TIMELINE.peak, aspect = 1.6, { x, y, radius } = lowAt(t);
  const centre = pressureAt(x, y, t, aspect);
  let lowest = Infinity;
  for (let j = 0; j <= 100; j++) for (let i = 0; i <= 160; i++) {
    const px = i / 160, py = j / 100;
    if (Math.hypot((px - x) * aspect, py - y) <= 2 * radius) lowest = Math.min(lowest, pressureAt(px, py, t, aspect));
  }
  assert.ok(centre <= lowest + 1);
});

test("the calm field has no closed isobars; the peak has at least three around the low", () => {
  for (const aspect of [0.45, 1.6, 3.2]) {
    const nx = Math.round(60 * Math.max(1, aspect)), ny = Math.round(60 / Math.min(1, aspect));
    const rings = (t) => {
      const v = sampleField(nx, ny, t, aspect);
      let lo = Infinity, hi = -Infinity;
      for (const p of v) { lo = Math.min(lo, p); hi = Math.max(hi, p); }
      return isobarLevels(lo, hi).flatMap((level) => contourLines(v, nx, ny, level))
        .filter((line) => line.length > 3 && line[0][0] === line.at(-1)[0] && line[0][1] === line.at(-1)[1]);
    };
    assert.equal(rings(0).length, 0, `calm, aspect ${aspect}`);
    assert.ok(rings(INTRO_TIMELINE.peak).length >= 3, `peak, aspect ${aspect}`);
  }
});

test("contourLines traces a radial bowl as one closed ring at the right radius", () => {
  const n = 41, v = new Float64Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) v[j * n + i] = (i - 20) ** 2 + (j - 20) ** 2;
  const lines = contourLines(v, n, n, 100);         // radius 10 grid units
  assert.equal(lines.length, 1);
  const ring = lines[0];
  assert.deepEqual(ring[0], ring.at(-1));
  for (const [x, y] of ring) assert.ok(Math.abs(Math.hypot(x - 20, y - 20) - 10) < 0.15);
  for (let k = 1; k < ring.length; k++)
    assert.ok(Math.hypot(ring[k][0] - ring[k - 1][0], ring[k][1] - ring[k - 1][1]) <= Math.SQRT2 + 1e-9, "no gaps");
});

test("contourLines handles saddles and edge-touching lines without throwing", () => {
  const v = new Float64Array([0, 1, 1, 0]);         // 2x2 saddle
  const lines = contourLines(v, 2, 2, 0.5);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.equal(line.length, 2);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/intro-field.test.mjs`
Expected: FAIL: cannot find module `../lib/intro-field.mjs`.

- [ ] **Step 3: Implement `lib/intro-field.mjs`** with the Interfaces signatures, and a header comment in the style of `lib/field-neighbors.mjs` (what it is and why it's plain `.mjs`).
  - `lowAt`: envelope `e = sin²(π·(t − calmEnd) / (exit − calmEnd))` inside `[calmEnd, exit]`, else 0. `depth = −20·e`; `radius` shrinks from ~0.24 to ~0.15 as `e` rises. The centre moves linearly over `[calmEnd, exit]` from about `(−0.1, 0.66)` to `(1.1, 0.30)`, and is held off-frame outside that window.
  - `pressureAt`: background + long wave + low. The background is ~1012 hPa rising toward the south-west. The wave is a slow sinusoid in `x·aspect` whose phase advances with `t` for all time; this is the post-story drift. The low is `depth · exp(−d² / radius²)`, with `d` measured in frame-height units (`dx · aspect`, `dy`). Tune the gradient so the calm frame shows **8–12 isobars** across it and has no closed ring (the tests pin the second).
  - `contourLines`: marching squares with linear interpolation on cell edges. Key each crossing by its edge id, resolve the two saddle cases by the cell-centre average, then chain segments into polylines by walking shared edge ids. A chain that returns to its start is closed, so repeat its first point.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/intro-field.test.mjs`
Expected: all 7 tests PASS.

- [ ] **Step 5: Type-check and stage**

Run: `npx tsc --noEmit -p .`. Expected: no new errors from `lib/intro-field.mjs`.
Stage `lib/intro-field.mjs tests/intro-field.test.mjs package.json`. Proposed message: `feat: pressure field and contouring for the weather intro`.

---

### Task 2: The intro component, drawn and dismissible

**Files:**
- Create: `app/components/WeatherIntro.tsx`
- Modify: `app/page.tsx` (render `<WeatherIntro />` after `<ForecastGraphic />`)
- Modify: `app/globals.css` (append a `/* Weather intro */` block)

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces: `export function WeatherIntro(): JSX.Element | null`, a `"use client"` component. The root element is `<div class="weather-intro" data-state="playing|leaving">`, and it renders `null` once gone. Exports `INTRO_SEEN_KEY = "nws-intro-seen"` and `INTRO_FADE_MS = 400` for Task 3.

- [ ] **Step 1: Build the overlay markup and CSS.**
  - Markup: a fixed, full-viewport overlay (`z-index` above `.office-scrim`'s 15, e.g. 50) holding an `aria-hidden` `<canvas>`, an eyebrow, the three-line headline, the prompt, and a visually hidden-until-focused `<button type="button">Enter site</button>`.
  - Headline: `font-family: var(--font-plot)`, weight 700, uppercase, `line-height: .86`, sized with `clamp()` to ~40% of viewport height on desktop. It sits left, vertically centred, with ~6vw left padding.
  - Eyebrow: ~11px, `letter-spacing: .28em`.
  - Prompt: `opacity: 0`, animating to 1 after a 2 s delay. A reduced-motion media query makes it visible immediately.
  - `[data-state="leaving"]` transitions `opacity` to 0 over 400 ms.

- [ ] **Step 2: Draw the field each frame.**
  - Size the canvas from `getBoundingClientRect()` × `min(devicePixelRatio, 2)`, and re-size it on `resize`.
  - Sample with `sampleField(nx, ny, t, aspect)`, where `nx = ceil(width / 12) + 1` and likewise for `ny`.
  - Draw every level from `isobarLevels` as polylines, scaled from grid units to CSS px.
  - Labels: one per polyline, at the point nearest its arc-length midpoint that lies outside the headline's bounding box (from `getBoundingClientRect`) and ≥ 120 CSS px from labels already placed. Rotate to the local segment angle, flipped to stay upright. Draw in `600 10px var(--font-plot)` (read the resolved family from `getComputedStyle`), with a ground-coloured knockout behind the text. Skip polylines shorter than ~80 CSS px.
  - Draw a bold **L** (~44px, weight 700) at `lowAt(t)` while `depth < −4`, with `Math.round(pressureAt(centre))` beneath it in ~12px. Fade both in and out with `depth`.

- [ ] **Step 3: The clock and the loop.**
  - `t` is accumulated from `requestAnimationFrame` deltas, so it advances only while frames run. On `visibilitychange` to hidden, cancel the frame and stop. On visible, resume without adding the hidden interval.
  - Clamp each frame's delta to 100 ms, so a stall doesn't skip the story.
  - With `prefers-reduced-motion: reduce`, draw once at `t = INTRO_TIMELINE.peak` and start no loop.

- [ ] **Step 4: Dismissal.**
  - `pointerdown` on the overlay, the button's click, and a `keydown` on `window` for Enter, Escape or Space all call `dismiss()`.
  - `dismiss()` does nothing unless state is `playing`. Otherwise it sets `leaving`, cancels the frame, writes `INTRO_SEEN_KEY` (in a try/catch), and after `INTRO_FADE_MS` sets state to gone and moves focus to `document.body`.
  - The effect cleanup removes every listener and the pending timeout.
  - Focus the button on mount, with `preventScroll: true`.

- [ ] **Step 5: Verify in a browser** (one check, per CLAUDE.md):
  - Run `npm run dev`. Load `/`, take screenshots at ~1 s, ~4.5 s and ~10 s, and confirm the calm → closed rings and **L** → relaxed sequence.
  - Hide and re-show the tab at ~3 s and confirm the story resumes, not jumps.
  - Double-click, then press Escape during the fade. Confirm a single fade, the forecast page underneath, and no console errors.
  - Resize to 390×844 and 3440×1080 and confirm the low crosses visibly and the headline fits.
  - Terminate the browser in the same command and confirm with `pgrep -fl chrom` that nothing is left. Use `--disable-gpu`, never SwiftShader.

- [ ] **Step 6: Stage.** Stage the three files. Proposed message: `feat: weather intro screen with a passing low`.

---

### Task 3: Once per session, with no flash and a no-JS escape

**Files:**
- Modify: `app/layout.tsx` (`suppressHydrationWarning` on `<html>`, plus an inline `<script>` and a `<noscript>` in `<head>`)
- Modify: `app/globals.css` (two hide rules)
- Test: `tests/rendered-html.test.mjs` (one new `test(...)`)

**Interfaces:**
- Consumes: `INTRO_SEEN_KEY` from Task 2. The layout imports it from `./components/WeatherIntro` so the key is spelled in one place.

- [ ] **Step 1: Write the failing SSR test** in `tests/rendered-html.test.mjs`:

```js
test("the weather intro is server-rendered, skippable per session, and never traps a no-JS visitor", async () => {
  const html = await (await render()).text();
  assert.match(html, /class="weather-intro"/);
  assert.match(html, />NWS</);
  assert.match(html, />FORECAST</);
  assert.match(html, />GRAPHICS</);
  assert.match(html, /DAY 1–3/);
  assert.match(html, /CLICK ANYWHERE TO ENTER/);
  assert.match(html, />Enter site</);
  assert.doesNotMatch(html, /SURFACE ANALYSIS|121 FORECAST OFFICES/i);
  // Head script marks a seen session before paint, and survives storage throwing.
  assert.match(html, /<script>[^<]*try\{[^<]*sessionStorage\.getItem\("nws-intro-seen"\)[^<]*dataset\.intro="seen"[^<]*\}catch/);
  // Without JS the overlay must not cover the site.
  assert.match(html, /<noscript><style>\.weather-intro\{display:none(?:!important)?\}<\/style><\/noscript>/);
  // The forecast page is still rendered underneath.
  assert.match(html, /Philadelphia \/ Mount Holly/);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run build && node --test tests/rendered-html.test.mjs`
Expected: the new test FAILS on the `<script>` assertion. The overlay markup from Task 2 already matches.

- [ ] **Step 3: Implement.**
  - In `<head>`, render the minified inline script `try{if(sessionStorage.getItem("nws-intro-seen"))document.documentElement.dataset.intro="seen"}catch(e){}`, built from `INTRO_SEEN_KEY` via `dangerouslySetInnerHTML`.
  - Also in `<head>`, render `<noscript><style>.weather-intro{display:none}</style></noscript>`.
  - Add `suppressHydrationWarning` to `<html>`, since the script sets an attribute before React hydrates.
  - CSS: `html[data-intro="seen"] .weather-intro { display: none; }`.
  - `WeatherIntro`: on mount, if `document.documentElement.dataset.intro === "seen"`, go straight to gone without starting a loop.

- [ ] **Step 4: Run the full suite and the production build**

Run: `npm test`. Expected: all tests PASS, including the 7 from Task 1 and the new SSR test.
Run: `npx next build`. Expected: build succeeds; this is the builder Vercel uses.

- [ ] **Step 5: Verify the session behaviour in a browser** (same rules as Task 2 Step 5):
  - A first load shows the intro from first paint.
  - Dismiss and reload: there's no intro and no flash of it (check a screenshot taken at DOMContentLoaded).
  - A new tab or session shows it again.
  - With JS disabled, the site shows and the intro does not.
  - Confirm with `pgrep` that the browser is gone.

- [ ] **Step 6: Stage.** Stage the three files. Proposed message: `feat: show the weather intro once per session, never to no-JS visitors`.
