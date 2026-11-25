"use client";

// The once-per-session intro: an invented surface-pressure map under the site's name. Each
// visit draws a random scenario — one of a few scripted openings, then lows forming at random
// — from lib/intro-field.mjs. This file draws it, times it, and gets out of the way.
//
// Design: docs/superpowers/specs/2026-11-24-weather-intro-design.md

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  activeSystems,
  contourLines,
  createScenario,
  isobarLevels,
  pressureAt,
  sampleField,
  type Scenario,
} from "../../lib/intro-field.mjs";
import { PLOT_FONT_FAMILY } from "../fonts";
import { INTRO_SEEN_KEY } from "../intro-session";

/** Keep in step with the `.weather-intro[data-state="leaving"]` transition in globals.css. */
export const INTRO_FADE_MS = 400;

const CELL_PX = 10;
const MAX_PIXEL_RATIO = 2;
// A frame that stalls (a long GC, a slow device) advances the story by at most this much,
// so a hitch can't skip a system entirely.
const MAX_FRAME_SECONDS = 0.1;
const GROUND = "#EAE7E0";
const INK = "#171717";
const LINE_ALPHA = 0.7;
// Labels follow their own isobar from frame to frame and fade rather than pop. A new label
// needs generous room; an existing one is only dropped when crowded much harder, so labels
// do not flicker on and off at the threshold.
const NEW_LABEL_SPACING_PX = 120;
const KEPT_LABEL_SPACING_PX = 70;
const LABEL_SNAP_PX = 36;
const LABEL_FADE_SECONDS = 0.45;
const LABEL_TURN_RATE = 8; // per second: how quickly a label's angle follows its line
// Same hysteresis at the edges and around the headline and markers: a label is placed only
// well clear of them, but kept until it actually reaches them.
const NEW_LABEL_MARGIN_PX = 24;
const KEPT_LABEL_MARGIN_PX = 6;
const NEW_LABEL_CLEARANCE_PX = 10;
const MIN_LABELLED_LINE_PX = 80;
// A ring smaller than this is the innermost wisp at the very centre of a system; drawn, it is
// a speck beside the letter rather than an isobar.
const MIN_RING_PX = 44;
const HEADLINE_PADDING_PX = 16;
// A system's letter appears once it is strong enough to own closed rings, and fades in with it.
const MARKER_SHOW_DEPTH = 4;
const MARKER_FULL_DEPTH = 10;

type IntroState = "playing" | "leaving" | "gone";
type Box = { left: number; top: number; right: number; bottom: number };
type Point = [number, number];
type Isobar = { level: number; points: Point[]; length: number };
type Label = { level: number; x: number; y: number; angle: number; alpha: number; alive: boolean };

export function WeatherIntro() {
  const [state, setState] = useState<IntroState>("playing");
  // The server always renders the overlay; on the client this reads the flag the head script
  // set before paint. A session that already dismissed it renders nothing and starts nothing.
  const seen = useSyncExternalStore(subscribeToNothing, alreadySeen, () => false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const headlineRef = useRef<HTMLHeadingElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Tell the head script's fallback dismissal (layout.tsx) to stand down: from here React owns
  // dismissal. A layout effect, so it lands in the hydration commit, before any input event.
  useLayoutEffect(() => {
    if (!seen) document.documentElement.dataset.introLive = "1";
  }, [seen]);

  const dismiss = useCallback(() => {
    setState((current) => (current === "playing" ? "leaving" : current));
  }, []);

  // Draw loop. Runs only while playing: the effect's cleanup is what stops it on dismissal,
  // so the last frame stays on the canvas through the fade but nothing more is computed.
  useEffect(() => {
    if (state !== "playing" || seen) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const scenario = createScenario(Math.floor(Math.random() * 2 ** 31));
    const renderer = createRenderer(context, scenario);
    let width = 0;
    let height = 0;
    let avoid: Box = { left: 0, top: 0, right: 0, bottom: 0 };
    let t = reducedMotion ? scenario.showcase : 0;
    let frame = 0;
    let last = 0;
    let running = false;

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const headline = headlineRef.current?.getBoundingClientRect();
      avoid = headline
        ? {
          left: headline.left - rect.left - HEADLINE_PADDING_PX,
          top: headline.top - rect.top - HEADLINE_PADDING_PX,
          right: headline.right - rect.left + HEADLINE_PADDING_PX,
          bottom: headline.bottom - rect.top + HEADLINE_PADDING_PX,
        }
        : avoid;
      // Re-sizing clears the canvas; a running loop repaints on its next frame anyway.
      if (!running) renderer.draw(width, height, t, avoid, null);
    };

    const tick = (now: number) => {
      const dt = last ? Math.min(MAX_FRAME_SECONDS, (now - last) / 1000) : 0;
      t += dt;
      last = now;
      renderer.draw(width, height, t, avoid, dt);
      frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (running || reducedMotion) return;
      running = true;
      last = 0; // the hidden interval is never added: the story resumes where it paused
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(frame);
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    resize();
    if (!document.hidden) start();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [state, seen]);

  // Keyboard dismissal, and focus on the one control so assistive tech lands on it.
  useEffect(() => {
    // Bail when already seen, or the page's own Enter and Space presses would be swallowed.
    if (state !== "playing" || seen) return;
    buttonRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== "Escape" && event.key !== " ") return;
      event.preventDefault(); // Space would otherwise scroll the page underneath
      dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, seen, dismiss]);

  // Fade, remember, then leave the DOM.
  useEffect(() => {
    if (state !== "leaving") return;
    try {
      window.sessionStorage.setItem(INTRO_SEEN_KEY, "1");
    } catch {
      // Storage can be disabled; the intro then simply shows again next load.
    }
    const timer = window.setTimeout(() => {
      setState("gone");
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }, INTRO_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  if (state === "gone" || seen) return null;

  return (
    <div className="weather-intro" data-state={state} onPointerDown={dismiss}>
      <canvas ref={canvasRef} className="weather-intro-canvas" aria-hidden="true" />
      <h2 ref={headlineRef} className="weather-intro-headline">
        <span>NWS</span>
        <span>FORECAST</span>
        <span>GRAPHICS</span>
      </h2>
      {/* The visible prompt is the control itself, so focusing it on load shows nothing new. */}
      <button ref={buttonRef} type="button" className="weather-intro-prompt" onClick={dismiss}>
        <span aria-hidden="true">CLICK ANYWHERE TO ENTER</span>
        <span className="weather-intro-sr">Enter site</span>
      </button>
    </div>
  );
}

/** Set before paint by the head script in layout.tsx when this session has seen the intro. */
function alreadySeen() {
  return document.documentElement.dataset.intro === "seen";
}

// The flag is fixed for the page's lifetime: dismissing sets sessionStorage, not the attribute.
function subscribeToNothing() {
  return () => {};
}

/**
 * Draws frames of one scenario. It keeps two things between frames: the sample buffer, so a
 * frame allocates no field, and the labels, so each one rides its own isobar smoothly instead
 * of being re-placed — and jumping — every frame.
 */
function createRenderer(context: CanvasRenderingContext2D, scenario: Scenario) {
  let buffer: Float64Array | undefined;
  let labels: Label[] = [];

  /** `dt` is the seconds since the last frame, or null for a still frame (labels appear at once). */
  function draw(width: number, height: number, t: number, headline: Box, dt: number | null) {
    context.fillStyle = GROUND;
    context.fillRect(0, 0, width, height);
    if (width < 2 || height < 2) return;

    const aspect = width / height;
    const nx = Math.ceil(width / CELL_PX) + 1;
    const ny = Math.ceil(height / CELL_PX) + 1;
    buffer = sampleField(nx, ny, t, aspect, scenario, buffer);
    let min = Infinity;
    let max = -Infinity;
    for (const value of buffer) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const sx = width / (nx - 1);
    const sy = height / (ny - 1);

    const isobars: Isobar[] = [];
    context.strokeStyle = INK;
    context.globalAlpha = LINE_ALPHA;
    context.lineWidth = 1;
    context.lineJoin = "round";
    context.lineCap = "round";
    for (const level of isobarLevels(min, max)) {
      for (const gridLine of contourLines(buffer, nx, ny, level)) {
        const points = gridLine.map(([x, y]): Point => [x * sx, y * sy]);
        if (isTinyRing(points)) continue;
        strokeSmooth(context, points);
        isobars.push({ level, points, length: pathLength(points) });
      }
    }
    context.globalAlpha = 1;

    const markers = systemMarkers(t, aspect, width, height, headline, nx, ny);
    updateLabels(isobars, width, height, [headline, ...markers.map((marker) => marker.box)], dt);
    drawLabels();
    for (const marker of markers) drawMarker(marker);
  }

  function updateLabels(isobars: Isobar[], width: number, height: number, avoid: Box[], dt: number | null) {
    const clear = (x: number, y: number, margin: number, clearance: number) =>
      x >= margin && y >= margin && x <= width - margin && y <= height - margin
      && !avoid.some((box) => x > box.left - clearance && x < box.right + clearance && y > box.top - clearance && y < box.bottom + clearance);
    const fade = dt === null ? 1 : dt / LABEL_FADE_SECONDS;
    const turn = dt === null ? 1 : Math.min(1, dt * LABEL_TURN_RATE);
    const claimed = new Set<Isobar>();
    const kept: Label[] = [];

    // Existing labels, oldest first, each re-found on its own isobar near where it was.
    for (const label of labels) {
      let alive = false;
      if (label.alive) {
        const near = nearestOn(isobars, label.level, label.x, label.y, claimed);
        if (near && near.distance <= LABEL_SNAP_PX && clear(near.point[0], near.point[1], KEPT_LABEL_MARGIN_PX, 0)
          && kept.every((other) => Math.hypot(other.x - near.point[0], other.y - near.point[1]) >= KEPT_LABEL_SPACING_PX)) {
          label.x = near.point[0];
          label.y = near.point[1];
          label.angle = upright(label.angle + halfTurnDifference(near.angle, label.angle) * turn);
          claimed.add(near.isobar);
          kept.push(label);
          alive = true;
        }
      }
      label.alive = alive;
      label.alpha = Math.min(1, Math.max(0, label.alpha + (alive ? fade : -fade)));
    }
    labels = labels.filter((label) => label.alive || label.alpha > 0);

    // New labels for isobars that have none, at the clear spot nearest the line's middle.
    for (const isobar of isobars) {
      if (claimed.has(isobar) || isobar.length < MIN_LABELLED_LINE_PX) continue;
      const spot = labelSpot(isobar.points, ([x, y]) => clear(x, y, NEW_LABEL_MARGIN_PX, NEW_LABEL_CLEARANCE_PX)
        && labels.every((other) => Math.hypot(other.x - x, other.y - y) >= NEW_LABEL_SPACING_PX));
      if (!spot) continue;
      claimed.add(isobar);
      labels.push({ level: isobar.level, x: spot.point[0], y: spot.point[1], angle: spot.angle, alpha: dt === null ? 1 : 0, alive: true });
    }
  }

  function drawLabels() {
    context.font = `600 10px ${PLOT_FONT_FAMILY}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    for (const label of labels) {
      if (label.alpha <= 0) continue;
      const text = String(label.level);
      const textWidth = context.measureText(text).width;
      context.save();
      context.globalAlpha = label.alpha;
      context.translate(label.x, label.y);
      context.rotate(label.angle);
      context.fillStyle = GROUND;
      context.fillRect(-textWidth / 2 - 3, -6, textWidth + 6, 12);
      context.fillStyle = INK;
      context.fillText(text, 0, 0.5);
      context.restore();
    }
  }

  type Marker = { letter: "L" | "H"; x: number; y: number; central: number; alpha: number; box: Box };

  /**
   * An L or H for every system strong enough to show, except where it would sit on the
   * headline. It goes on the field's actual extremum near the system, not the system's
   * nominal centre: the background gradient shifts a weak low's lowest point off-centre, and
   * an L beside its innermost ring rather than inside it reads as wrong.
   */
  function systemMarkers(t: number, aspect: number, width: number, height: number, headline: Box, nx: number, ny: number): Marker[] {
    const markers: Marker[] = [];
    const values = buffer;
    if (!values) return markers;
    for (const system of activeSystems(scenario, t)) {
      const strength = Math.abs(system.depth);
      if (strength < MARKER_SHOW_DEPTH) continue;
      const sign = system.kind === "low" ? 1 : -1;
      const reach = system.radius * Math.min(1, aspect); // in frame heights
      const ci = Math.round(system.x * (nx - 1));
      const cj = Math.round(system.y * (ny - 1));
      const di = Math.ceil(reach / aspect * (nx - 1));
      const dj = Math.ceil(reach * (ny - 1));
      let bestI = ci;
      let bestJ = cj;
      let best = Infinity;
      for (let j = Math.max(0, cj - dj); j <= Math.min(ny - 1, cj + dj); j += 1) {
        for (let i = Math.max(0, ci - di); i <= Math.min(nx - 1, ci + di); i += 1) {
          const v = sign * values[j * nx + i];
          if (v < best) { best = v; bestI = i; bestJ = j; }
        }
      }
      // Refine between lattice cells with a parabola through each axis's neighbours, so the
      // letter glides with the low instead of hopping a whole cell at a time.
      const at = (i: number, j: number) => sign * values[Math.min(ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
      const offset = (minus: number, centre: number, plus: number) => {
        const curvature = minus - 2 * centre + plus;
        return curvature > 0 ? Math.max(-0.5, Math.min(0.5, (minus - plus) / (2 * curvature))) : 0;
      };
      const fi = bestI + offset(at(bestI - 1, bestJ), best, at(bestI + 1, bestJ));
      const fj = bestJ + offset(at(bestI, bestJ - 1), best, at(bestI, bestJ + 1));
      const x = best === Infinity ? system.x * width : (fi / (nx - 1)) * width;
      const y = best === Infinity ? system.y * height : (fj / (ny - 1)) * height;
      const box = { left: x - 60, top: y - 50, right: x + 60, bottom: y + 60 };
      const overlapsHeadline = box.left < headline.right && box.right > headline.left && box.top < headline.bottom && box.bottom > headline.top;
      const onCanvas = x > 0 && x < width && y > 0 && y < height;
      if (overlapsHeadline || !onCanvas) continue;
      markers.push({
        letter: system.kind === "low" ? "L" : "H",
        x,
        y,
        central: Math.round(best === Infinity ? pressureAt(system.x, system.y, t, aspect, scenario) : sign * best),
        alpha: Math.min(1, (strength - MARKER_SHOW_DEPTH) / (MARKER_FULL_DEPTH - MARKER_SHOW_DEPTH)),
        box,
      });
    }
    return markers;
  }

  function drawMarker(marker: Marker) {
    const central = String(marker.central);
    context.save();
    context.globalAlpha = marker.alpha;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = INK;
    context.font = `700 44px ${PLOT_FONT_FAMILY}`;
    context.fillText(marker.letter, marker.x, marker.y);
    context.font = `600 12px ${PLOT_FONT_FAMILY}`;
    const textWidth = context.measureText(central).width;
    context.fillStyle = GROUND;
    context.fillRect(marker.x - textWidth / 2 - 3, marker.y + 21, textWidth + 6, 14);
    context.fillStyle = INK;
    context.fillText(central, marker.x, marker.y + 28.5);
    context.restore();
  }

  return { draw };
}

/**
 * Stroke a contour as a smooth curve: quadratic segments through the midpoints of the
 * marching-squares polyline, with its vertices as control points. That rounds off the
 * cell-sized kinks without moving the line by more than a fraction of a cell.
 */
function strokeSmooth(context: CanvasRenderingContext2D, points: Point[]) {
  const n = points.length;
  if (n < 2) return;
  const closed = n > 3 && points[0][0] === points[n - 1][0] && points[0][1] === points[n - 1][1];
  context.beginPath();
  if (closed) {
    const ring = points.slice(0, -1);
    const m = ring.length;
    context.moveTo((ring[m - 1][0] + ring[0][0]) / 2, (ring[m - 1][1] + ring[0][1]) / 2);
    for (let k = 0; k < m; k += 1) {
      const next = ring[(k + 1) % m];
      context.quadraticCurveTo(ring[k][0], ring[k][1], (ring[k][0] + next[0]) / 2, (ring[k][1] + next[1]) / 2);
    }
    context.closePath();
  } else {
    context.moveTo(points[0][0], points[0][1]);
    for (let k = 1; k < n - 1; k += 1) {
      context.quadraticCurveTo(points[k][0], points[k][1], (points[k][0] + points[k + 1][0]) / 2, (points[k][1] + points[k + 1][1]) / 2);
    }
    context.lineTo(points[n - 1][0], points[n - 1][1]);
  }
  context.stroke();
}

/** The closest point to (x, y) on any unclaimed isobar of `level`, projected onto its segments. */
function nearestOn(isobars: Isobar[], level: number, x: number, y: number, claimed: Set<Isobar>) {
  let best: { isobar: Isobar; point: Point; angle: number; distance: number } | null = null;
  for (const isobar of isobars) {
    if (isobar.level !== level || claimed.has(isobar)) continue;
    const pts = isobar.points;
    for (let k = 1; k < pts.length; k += 1) {
      const [ax, ay] = pts[k - 1];
      const [bx, by] = pts[k];
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      const s = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / lengthSquared));
      const px = ax + dx * s;
      const py = ay + dy * s;
      const distance = Math.hypot(px - x, py - y);
      if (!best || distance < best.distance) best = { isobar, point: [px, py], angle: upright(Math.atan2(dy, dx)), distance };
    }
  }
  return best;
}

/** The acceptable point nearest the line's arc-length midpoint, and the line's angle there, kept upright. */
function labelSpot(line: Point[], acceptable: (point: Point) => boolean): { point: Point; angle: number } | null {
  const cumulative = [0];
  for (let k = 1; k < line.length; k += 1) {
    cumulative.push(cumulative[k - 1] + Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1]));
  }
  const half = cumulative[cumulative.length - 1] / 2;
  let middle = 0;
  while (middle < cumulative.length - 1 && cumulative[middle] < half) middle += 1;
  for (let offset = 0; offset < line.length; offset += 1) {
    for (const k of offset === 0 ? [middle] : [middle + offset, middle - offset]) {
      if (k < 1 || k >= line.length - 1 || !acceptable(line[k])) continue;
      return { point: line[k], angle: upright(Math.atan2(line[k + 1][1] - line[k - 1][1], line[k + 1][0] - line[k - 1][0])) };
    }
  }
  return null;
}

/** Text reads the same rotated by a half turn, so keep angles within (−90°, 90°]. */
function upright(angle: number) {
  let a = angle;
  while (a > Math.PI / 2) a -= Math.PI;
  while (a <= -Math.PI / 2) a += Math.PI;
  return a;
}

/** The shortest signed turn from `from` to `to`, treating angles a half turn apart as equal. */
function halfTurnDifference(to: number, from: number) {
  let d = (to - from) % Math.PI;
  if (d > Math.PI / 2) d -= Math.PI;
  if (d < -Math.PI / 2) d += Math.PI;
  return d;
}

function isTinyRing(line: Point[]) {
  const first = line[0];
  const lastPoint = line[line.length - 1];
  if (first[0] !== lastPoint[0] || first[1] !== lastPoint[1]) return false;
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const [x, y] of line) {
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return right - left < MIN_RING_PX && bottom - top < MIN_RING_PX;
}

function pathLength(line: Point[]) {
  let total = 0;
  for (let k = 1; k < line.length; k += 1) total += Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1]);
  return total;
}
