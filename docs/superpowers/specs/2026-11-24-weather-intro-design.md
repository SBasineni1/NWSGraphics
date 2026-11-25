# Weather intro screen — design

**Status:** approved 2026-11-24 · **Size:** small feature (one component, one pure module, CSS)

## Intent

A short full-screen intro that greets a visitor before the forecast page: an animated
surface-pressure map in the editorial style of the "Shifting Topography" reference
recording — cream ground, thin black isolines, small rotated contour labels, a huge
condensed all-caps headline. Instead of terrain, the lines are isobars: a smooth, calm
flow; a low drifts in, deepens into tight closed rings with an **L**, passes, and fills
so the isobars relax back to smooth. Then it holds until the visitor clicks it away.

Why: a memorable, on-brand first impression for a weather-graphics site, and a cover for
the first-load wait (forecast JSON + basemap tiles) rather than an extra delay on top.

## Goals

- Plays a ~7 s "low passes through" story, then keeps drifting gently and holds.
- Click anywhere (or Enter / Escape / Space) dismisses it at any moment, mid-animation
  included, with a short fade (~400 ms).
- Instant: no data download, no new font, no new dependency.
- Crisp at any size and pixel density; looks deliberate on phones and ultrawides.

## Non-goals

- Real model data (a replay of an actual storm was considered and rejected below).
- Sound, settings, or a "don't show again" control.
- Any change to `ForecastGraphic.tsx` or the map rendering.

## Anti-goals (would be a failure even if it technically works)

- Getting in the way of repeat use — someone checking the site several times a day must
  not sit through it each page load.
- Flashing the site and then the intro (or the intro and then the site) on load.
- Measurable CPU drain: it must stop rendering entirely once dismissed and pause while
  the tab is hidden.
- Reading as a generic template rather than a weather chart.

## Approaches considered

1. **Invented pressure field drawn live on a canvas — chosen.** The field is a formula,
   so it costs nothing to load, is sharp at every resolution, and the storyline can be
   timed exactly.
2. Replay of a real storm from RAP pressure frames — authentic, but needs a bake step and
   ~100–300 KB, and real lows are messy and hard to time. Rejected.
3. Pre-rendered video loop — heavy, soft on large/retina screens, can't adapt to aspect
   ratio. Rejected.

## Decided

- **Approach 1** (the user's pick).
- **Short animation, then click to dismiss** (the user's words).
- **Eyebrow is `DAY 1–3` only**; everything else under "Proposed" accepted as written.

## Proposed — my calls, open to correction

**When it shows.** Once per browser session (`sessionStorage`). A fresh visit sees it;
switching offices, reloading, or following a deep link inside the same session does not.
`prefers-reduced-motion: reduce` shows a single still frame of the mature low instead of
the animation; it is still dismissed by a click.

**Look.**

```
┌───────────────────────────────────────────────────────────────────────┐
│  ~~~~~~~~~1016~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~  │
│  ~~~~~~~~~~~~~~~~~1012~~~~~~~~~~~~~~~╭──────╮~~~~~~~~~~~~~~~~~~~~~~~  │
│  DAY 1–3                           ╭─╯ ╭──╮ ╰─╮~~~~~~~~~~~~~1008~~~~~  │
│                                    │  │ L  │  │~~~~~~~~~~~~~~~~~~~~~~  │
│                                    ╰─╮ 996 ╭─╯~~~~~~~~~~~~~~~~~~~~~~  │
│  NWS                                 ╰─────╯~~~~~~~~~~~~~~~~~~~~~~~~  │
│  FORECAST    ~~~~~~~~~~~~~~1004~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~  │
│  GRAPHICS    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~  │
│                                                  CLICK ANYWHERE TO ENTER│
└───────────────────────────────────────────────────────────────────────┘
```

- Ground `#EAE7E0`, ink `#171717`, isolines ~1 CSS px at ~70% ink.
- Isobars every **4 hPa**, each labelled once or twice with small rotated numbers riding
  the line (`1008`, `1012` …), as on a WPC surface chart.
- The low carries a bold **L** at its centre with its central pressure beneath it in the
  label face, and both track the minimum as it moves. A faint **H** may sit in a corner
  for balance — builder's discretion.
- Headline in **Barlow Semi Condensed 700** (already loaded as `--font-plot`), stacked
  `NWS / FORECAST / GRAPHICS`, sized with `clamp()` so it is ~40% of the viewport height
  on desktop. Eyebrow line in small, widely tracked caps: `DAY 1–3` (the user cut
  "Surface analysis" and "121 forecast offices" from the proposed eyebrow).
- A small `CLICK ANYWHERE TO ENTER` prompt fades in at ~2 s, bottom right.

**The field.** `p(x, y, t)` in hPa, over normalised coordinates:

- a broad background gradient (higher to the south-west) plus a slow travelling long
  wave, so the calm state is gently curved, roughly parallel isobars rather than
  straight lines;
- one low: a Gaussian-ish depression whose centre moves west-south-west → east-north-east
  across the frame, whose depth ramps from 0 to ~−20 hPa and back to 0, and whose radius
  tightens as it deepens — so the rings crowd in, then loosen as it fills;
- timeline: 0–1 s calm → 1–4 s the low arrives and deepens → 4–6 s it passes the
  headline's right side at peak → 6–8 s it exits and fills, isobars relax → then the
  background keeps drifting very slowly until dismissed.

**Where it lives.**

- `lib/intro-field.mjs` — pure functions: the pressure field and marching-squares
  contouring into chained polylines (with linear interpolation along cell edges). Plain
  `.mjs`, like `map-frame.mjs`, so Node can test it directly.
- `tests/intro-field.test.mjs` — the low's central pressure is the field minimum at its
  peak; contours of a known field (a radial bowl) come out as closed rings at the right
  radius; polylines chain without gaps. Added to `npm test`.
- `app/components/WeatherIntro.tsx` — `"use client"`; owns the canvas, the
  `requestAnimationFrame` loop, labels, dismissal, and the session flag. Mounted beside
  `<ForecastGraphic />` in `app/page.tsx`, which keeps loading underneath it.
- Styles in `app/globals.css` next to the existing component styles.

**No flash on load.** The overlay is in the server-rendered HTML, so a first-time visitor
sees it from the very first paint. A tiny inline script in `app/layout.tsx` runs before
paint and sets `data-intro="seen"` on `<html>` when the session flag exists; CSS hides
the overlay under that attribute, so a repeat visit in the same session never shows it.
(Showing it only after hydration would flash the site first; hiding it until hydration
would flash the site on every first visit.)

**Accessibility.** The canvas is `aria-hidden`; the overlay contains a real `<button>`
("Enter site") that receives focus, so keyboard and screen-reader users can dismiss it.
Escape also dismisses. Focus returns to the page body afterwards.

**Performance.** Contour grid ~10–14 CSS px per cell (≈ 15–20k cells on a laptop
screen); device pixel ratio capped at 2. The loop stops for good on dismissal, pauses on
`visibilitychange`, and the component unmounts after the fade.

## Left to the builder

- Exact field constants, the low's track, and the easing curves — tune by eye against the
  reference recording.
- Label placement method (e.g. one label per polyline at a spot clear of the headline,
  never overlapping another label), and whether lines are smoothed beyond plain
  marching squares.
- How the layout adapts on narrow phones (headline scale, eyebrow wrapping).

## Verification

- `npm test` (includes the new pure-logic test) and `npx next build` (production builder).
- One visual check in a browser per CLAUDE.md: launch, screenshot mid-animation and
  after the hold, confirm click dismisses and a reload in the same session skips it;
  terminate the browser in the same command and confirm with `pgrep`.

## Revision — v2 (2026-11-24, same day)

Requested after the first build: lows should form randomly, there should be different
versions, labels and lines were too choppy, and the `DAY 1–3` eyebrow goes.

- **Scenarios.** Each visit draws a seeded scenario: one of four scripted openings
  (`classic` passing low, `twin` lows, a rapidly deepening `bomb`, a `highlow` pair), then
  lows keep forming at random positions anywhere across the frame, always travelling east
  (north-east to just south of east). One passing behind the headline shows its rings
  there but no **L**, each holding at full strength for a quarter of its life. At most three systems
  are alive at once; after the opening a strong low is on the map at least 60% of the time
  (both pinned by tests). Highs get an **H**. The bomb deepens to ~−28 hPa, past the original
  ~−20.
- **Smoothness.** Isobars are stroked as quadratic curves through the marching-squares
  midpoints on a 10 px lattice. Labels persist between frames, ride their own isobar, turn
  smoothly and fade in/out, with hysteresis at margins and around the headline and markers.
  L/H sit on the field's actual extremum near each system, refined between lattice cells.
- **Copy.** The eyebrow is removed; the headline stands alone.
