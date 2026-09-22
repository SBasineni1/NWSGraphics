// Even-odd point-in-polygon for GeoJSON rings, shared by the build scripts that decide
// which samples fall inside a CWA or on land. Plain `.mjs` like map-frame.mjs, so Node
// can import it directly.

/**
 * @param {number} lon
 * @param {number} lat
 * @param {number[][]} ring
 */
export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Inside any of `polygons` (each an outer ring followed by holes), and not in a hole.
 * @param {number} lon
 * @param {number} lat
 * @param {number[][][][]} polygons
 */
export function inPolygons(lon, lat, polygons) {
  for (const polygon of polygons) {
    if (!pointInRing(lon, lat, polygon[0])) continue;
    if (polygon.slice(1).some((hole) => pointInRing(lon, lat, hole))) continue;
    return true;
  }
  return false;
}

/**
 * A Polygon or MultiPolygon geometry as a list of polygons. The CWA source ships both.
 * @param {{ type: string, coordinates: any }} geometry
 * @returns {number[][][][]}
 */
export function polygonsOf(geometry) {
  return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
}
