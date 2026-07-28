// Geometry preparation shared by the build scripts that slice national sources into
// per-office files: simplification, longitude shifting and coordinate rounding.
//
// This lives beside map-frame.mjs and for the same reason. Every consumer has to agree
// *exactly* — build-office-bundles lays down the counties a frame draws and
// build-office-zones lays down the alert zones painted over them, so a tolerance or shift
// that drifted between the two would show up as a warning polygon that doesn't sit on the
// county it covers. Copying these into each script is what makes that drift possible.

function perpendicularDistance([x, y], [x1, y1], [x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
  return Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / Math.hypot(dx, dy);
}

/** Iterative Douglas-Peucker — recursion blows the stack on a 60k-vertex ring. */
export function simplify(points, tolerance, closed) {
  if (points.length < (closed ? 5 : 3)) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let furthest = -1;
    let maxDistance = tolerance;
    for (let index = first + 1; index < last; index += 1) {
      const distance = perpendicularDistance(points[index], points[first], points[last]);
      if (distance > maxDistance) {
        maxDistance = distance;
        furthest = index;
      }
    }
    if (furthest === -1) continue;
    keep[furthest] = 1;
    stack.push([first, furthest], [furthest, last]);
  }
  const out = points.filter((_, index) => keep[index]);
  if (!closed) return out.length >= 2 ? out : points;
  if (out.length < 4) return points;
  const [fx, fy] = out[0];
  const [lx, ly] = out.at(-1);
  if (fx !== lx || fy !== ly) out.push([fx, fy]);
  return out;
}

export const round = (node, factor) =>
  typeof node[0] === "number"
    ? [Math.round(node[0] * factor) / factor, Math.round(node[1] * factor) / factor]
    : node.map((child) => round(child, factor));

/**
 * A frame that crosses the antimeridian is expressed with `east` past 180 (see
 * coordinateBounds), so a feature sitting at -175° has to be read as 185° to land in it.
 *
 * The offset is decided **once per feature, from that feature's own position**, and then
 * applied to every one of its coordinates. Shifting each coordinate independently — "any
 * negative longitude gains 360" — tears apart anything that straddles the *prime*
 * meridian: a road crossing 0° became points at 359.5 and 0.5, a bounding box spanning the
 * entire globe, which then "overlapped" every frame and drew as a line straight across
 * Alaska. Six European roads were being painted over the Aleutians that way.
 *
 * @returns the number of degrees to add to every longitude of this feature, or null when
 *   the feature belongs to a different part of the world entirely.
 */
export function offsetFor(frame, plainBox) {
  if (frame.east <= 180) return 0;
  // Anything west of the frame by more than half the globe is really east of it, reached
  // the short way round; everything else is already in the frame's own space.
  const centre = (plainBox.west + plainBox.east) / 2;
  return centre < frame.west - 180 ? 360 : 0;
}

export function bboxOf(coordinates, shift = (lon) => lon) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const walk = (node) => {
    if (typeof node[0] === "number") {
      const lon = shift(node[0]);
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (node[1] < south) south = node[1];
      if (node[1] > north) north = node[1];
    } else {
      for (const child of node) walk(child);
    }
  };
  walk(coordinates);
  return { west, south, east, north };
}

/**
 * Overlays are kept a little past the frame so a feature entering at the very edge still
 * has the vertices to be drawn into it, rather than stopping short.
 */
export const MARGIN = 0.25;

export const overlaps = (box, frame) =>
  box.east >= frame.west - MARGIN &&
  box.west <= frame.east + MARGIN &&
  box.north >= frame.south - MARGIN &&
  box.south <= frame.north + MARGIN;

/** Rings/lines carried into a bundle, shifted, simplified and rounded for that frame. */
export function prepare(coordinates, shift, tolerance, closed, factor) {
  const walk = (node) => {
    if (typeof node[0][0] === "number") {
      const shifted = node.map(([lon, lat]) => [shift(lon), lat]);
      return round(simplify(shifted, tolerance, closed), factor);
    }
    return node.map(walk);
  };
  return walk(coordinates);
}

/**
 * One device pixel in degrees at the office's own zoom, which is what "sub-pixel" means
 * here. A fixed tolerance would over-simplify a zoom-9 office and leave a zoom-4 one
 * carrying tens of thousands of vertices nobody can see.
 */
export const toleranceFor = (zoom) => 360 / (256 * 2 ** zoom * 2) / 2;
