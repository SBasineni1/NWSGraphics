// Nearest-neighbour search for the field interpolation in ForecastGraphic.tsx.
//
// The renderer used to scan every point for every lattice cell. That was affordable at an
// office's ~290 points, but the wide-view mesoanalysis lattice runs to several thousand, and
// a solve is ~43k cells: a full scan there is hundreds of millions of distance tests on the
// main thread. This buckets the points once and searches outward from each cell instead.
//
// **The answer must be exactly what the full scan gave**, not merely close: the renderer's
// Float64 weights are computed from these distances, and CLAUDE.md pins the per-plot sum as
// bit-identical to a per-pixel solve. So the distance expression below is the scan's own,
// term for term, and ties are broken by point index the way the scan's strict `<` insert
// broke them. `tests/field-neighbors.test.mjs` checks both against a brute-force reference.
//
// Plain `.mjs` like map-frame.mjs, so Node can test it directly.

/** A cell closer than this (in scaled degrees, squared) takes the point's value outright. */
export const EXACT_DISTANCE_SQUARED = 0.000001;

// Floating-point slack on the stopping bound. The bound is a strict inequality in exact
// arithmetic; this keeps a rounding error in the last bit from ending a search one ring
// early and dropping a point that ties the eighth-nearest.
const BOUND_SLACK = 1 - 1e-9;

/**
 * @typedef {{ lon: number, lat: number }} LatLon
 * @typedef {{ exact: number, count: number, indices: Int32Array, distances: Float64Array }} NeighborResult
 */

/**
 * Bucket `points` for repeated k-nearest queries.
 *
 * Distance is the renderer's: longitude difference scaled by the cosine of the *query's*
 * latitude, latitude difference unscaled. Because that scale depends on the query, buckets
 * are square in raw degrees and the stopping bound carries the scale instead.
 *
 * @param {LatLon[]} points
 * @param {number} [pointsPerBucket] target occupancy; a handful keeps rings cheap to walk
 */
export function createNeighborIndex(points, pointsPerBucket = 2) {
  const count = points.length;
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const point of points) {
    if (point.lon < west) west = point.lon;
    if (point.lon > east) east = point.lon;
    if (point.lat < south) south = point.lat;
    if (point.lat > north) north = point.lat;
  }
  if (!count) {
    west = east = south = north = 0;
  }
  const area = Math.max((east - west) * (north - south), 1e-9);
  // Floored so a lattice that collapses to a line or a single point still gets a bucket
  // size that the exact-hit radius (0.001°) cannot exceed.
  const size = Math.max(Math.sqrt(area * pointsPerBucket / Math.max(count, 1)), 0.01);
  const columns = Math.max(1, Math.floor((east - west) / size) + 1);
  const rows = Math.max(1, Math.floor((north - south) / size) + 1);

  // Compressed bucket lists: `start[b]..start[b + 1]` indexes into `members`, which holds
  // point indices in ascending order within each bucket.
  const start = new Int32Array(columns * rows + 1);
  const bucketOf = new Int32Array(count);
  for (let index = 0; index < count; index += 1) {
    const column = Math.min(columns - 1, Math.floor((points[index].lon - west) / size));
    const row = Math.min(rows - 1, Math.floor((points[index].lat - south) / size));
    bucketOf[index] = row * columns + column;
    start[bucketOf[index] + 1] += 1;
  }
  for (let bucket = 0; bucket < columns * rows; bucket += 1) start[bucket + 1] += start[bucket];
  const members = new Int32Array(count);
  const fill = start.slice(0, columns * rows);
  for (let index = 0; index < count; index += 1) members[fill[bucketOf[index]]++] = index;

  /**
   * The `k` nearest points to (lon, lat), nearest first, ties by ascending index — or an
   * exact hit, which is the lowest-indexed point within `EXACT_DISTANCE_SQUARED`.
   *
   * @param {number} lon
   * @param {number} lat
   * @param {number} k
   * @returns {NeighborResult}
   */
  function nearest(lon, lat, k) {
    const indices = new Int32Array(k).fill(-1);
    const distances = new Float64Array(k).fill(Infinity);
    let found = 0;
    let exact = -1;
    const scale = Math.cos(lat * Math.PI / 180);
    // Unclamped, so the stopping bound stays correct for a query outside the points' box.
    const homeColumn = Math.floor((lon - west) / size);
    const homeRow = Math.floor((lat - south) / size);

    const consider = (index) => {
      const point = points[index];
      // Must match the renderer's full scan exactly — see the header.
      const dx = (lon - point.lon) * scale;
      const dy = lat - point.lat;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared < EXACT_DISTANCE_SQUARED) {
        if (exact === -1 || index < exact) exact = index;
        return;
      }
      if (found === k && !(distanceSquared < distances[k - 1] || (distanceSquared === distances[k - 1] && index < indices[k - 1]))) return;
      let slot = found < k ? found : k - 1;
      while (slot > 0 && (distanceSquared < distances[slot - 1] || (distanceSquared === distances[slot - 1] && index < indices[slot - 1]))) {
        distances[slot] = distances[slot - 1];
        indices[slot] = indices[slot - 1];
        slot -= 1;
      }
      distances[slot] = distanceSquared;
      indices[slot] = index;
      if (found < k) found += 1;
    };

    if (!count) return { exact, count: found, indices, distances };

    const visit = (column, row) => {
      const bucket = row * columns + column;
      for (let member = start[bucket]; member < start[bucket + 1]; member += 1) consider(members[member]);
    };

    // A query outside the grid starts at the first ring that reaches it; the rings inside
    // that are empty and would only cost time. Each ring's perimeter is clamped to the grid
    // for the same reason, and the stopping bound below uses the unclamped ring either way.
    const firstRing = Math.max(0, -homeColumn, homeColumn - (columns - 1), -homeRow, homeRow - (rows - 1));
    for (let ring = firstRing; ; ring += 1) {
      if (ring === 0) {
        visit(homeColumn, homeRow);
      } else {
        const fromColumn = Math.max(0, homeColumn - ring);
        const toColumn = Math.min(columns - 1, homeColumn + ring);
        for (const row of [homeRow - ring, homeRow + ring]) {
          if (row < 0 || row >= rows) continue;
          for (let column = fromColumn; column <= toColumn; column += 1) visit(column, row);
        }
        const fromRow = Math.max(0, homeRow - ring + 1);
        const toRow = Math.min(rows - 1, homeRow + ring - 1);
        for (const column of [homeColumn - ring, homeColumn + ring]) {
          if (column < 0 || column >= columns) continue;
          for (let row = fromRow; row <= toRow; row += 1) visit(column, row);
        }
      }
      // Every bucket has been seen once the ring encloses the whole grid.
      const covered = homeColumn - ring <= 0 && homeColumn + ring >= columns - 1
        && homeRow - ring <= 0 && homeRow + ring >= rows - 1;
      if (covered) break;
      // Anything outside rings 0..ring is more than `ring` buckets away on some axis, so at
      // least `ring * size` degrees off in longitude or latitude. Longitude is the axis the
      // scale shrinks, so it sets the bound.
      const reach = ring * size * Math.min(scale, 1);
      const bound = reach * reach * BOUND_SLACK;
      if (bound <= EXACT_DISTANCE_SQUARED) continue;
      if (exact !== -1) break;
      if (found === k && distances[k - 1] < bound) break;
    }
    return { exact, count: found, indices, distances };
  }

  return { nearest, bucketSize: size };
}
