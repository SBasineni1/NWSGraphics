// Web Mercator geometry shared by the browser renderer and the Node build scripts.
// Both sides must agree exactly: build-grid-points.mjs lattices each office's render
// frame, and ForecastGraphic.tsx draws that same frame. Any drift here shows up as
// missing forecast data along a canvas edge.

export const PLOT_WIDTH = 900;
export const MAP_HEIGHT = 760;
export const PLOT_ZOOM = 7;

/** @typedef {{ west: number, south: number, east: number, north: number }} Bounds */
/** @typedef {{ left: number, top: number, right: number, bottom: number, zoom: number }} MapExtent */

/**
 * @param {number} lon
 * @param {number} lat
 * @param {number} zoom
 */
export function worldPoint(lon, lat, zoom) {
  const scale = 256 * 2 ** zoom;
  const sin = Math.sin(lat * Math.PI / 180);
  return { x: ((lon + 180) / 360) * scale, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale };
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} zoom
 */
export function inverseWorld(x, y, zoom) {
  const scale = 256 * 2 ** zoom;
  const lon = x / scale * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y / scale;
  return { lon, lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) };
}

/**
 * Fit a bounding box to the plot aspect ratio, with a little breathing room.
 * @param {Bounds} bounds
 * @param {number} [width]
 * @param {number} [height]
 * @param {number} [zoom]
 * @returns {MapExtent}
 */
export function plotExtent(bounds, width = PLOT_WIDTH, height = MAP_HEIGHT, zoom = PLOT_ZOOM) {
  const topLeft = worldPoint(bounds.west, bounds.north, zoom);
  const bottomRight = worldPoint(bounds.east, bounds.south, zoom);
  const centerX = (topLeft.x + bottomRight.x) / 2;
  const centerY = (topLeft.y + bottomRight.y) / 2;
  let spanX = (bottomRight.x - topLeft.x) * 1.02;
  let spanY = (bottomRight.y - topLeft.y) * 1.03;
  if (spanX / spanY < width / height) spanX = spanY * width / height;
  else spanY = spanX * height / width;
  return { left: centerX - spanX / 2, right: centerX + spanX / 2, top: centerY - spanY / 2, bottom: centerY + spanY / 2, zoom };
}

/**
 * @param {number} lon
 * @param {number} lat
 * @param {MapExtent} extent
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @returns {[number, number]}
 */
export function project(lon, lat, extent, x, y, width, height) {
  const point = worldPoint(lon, lat, extent.zoom);
  return [
    x + (point.x - extent.left) / (extent.right - extent.left) * width,
    y + (point.y - extent.top) / (extent.bottom - extent.top) * height,
  ];
}

/**
 * The lat/lon box actually visible on the canvas for a given CWA. Build scripts use
 * this to decide which gridpoints a given office's map needs.
 * @param {Bounds} bounds
 * @returns {Bounds}
 */
export function frameBounds(bounds) {
  const extent = plotExtent(bounds);
  const topLeft = inverseWorld(extent.left, extent.top, extent.zoom);
  const bottomRight = inverseWorld(extent.right, extent.bottom, extent.zoom);
  return { west: topLeft.lon, north: topLeft.lat, east: bottomRight.lon, south: bottomRight.lat };
}

/**
 * Bounding box of any nested GeoJSON coordinate array.
 * @param {unknown} coordinates
 * @returns {Bounds}
 */
export function coordinateBounds(coordinates) {
  // Accumulated rather than collected-then-spread: `Math.min(...lons)` throws
  // RangeError once the array passes the engine's argument limit (~65k), and an
  // unsimplified CWA ring runs to 60k+ vertices on its own. Only ever fed simplified
  // geometry today, which is why it has held up so far.
  //
  // Two readings of longitude are accumulated at once. The direct one is right for
  // everything inside a hemisphere; the shifted one — negative longitudes moved past
  // 180 — is right for an area crossing the antimeridian. Alaska's CWA reaches from the
  // mainland into the Aleutians, and read directly it measures 359° wide instead of ~20°,
  // which at a fixed zoom asked the basemap for 14,541 tiles for a single map.
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let shiftedWest = Infinity;
  let shiftedEast = -Infinity;
  const walk = (node) => {
    if (typeof node[0] === "number") {
      const lon = node[0];
      const lat = node[1];
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      const shifted = lon < 0 ? lon + 360 : lon;
      if (shifted < shiftedWest) shiftedWest = shifted;
      if (shifted > shiftedEast) shiftedEast = shifted;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    } else {
      for (const child of node) walk(child);
    }
  };
  walk(coordinates);
  // Only an area that reads as more than half the globe wide is a candidate for having
  // wrapped — nothing NWS forecasts is genuinely that big. Testing "is the shifted span
  // smaller" alone is not safe: adding 360 to a longitude near -76 costs low-order
  // precision, so the shifted span can come out a few ulps *under* the direct one and win
  // for an office sitting entirely in the western hemisphere. That put every CONUS frame
  // at risk of being silently shifted into 283..286 instead of -76..-74.
  //
  // The zero test still guards the degenerate all-±180 case, where shifting collapses
  // every longitude onto one meridian and would produce a frame with no width at all.
  const directSpan = east - west;
  const shiftedSpan = shiftedEast - shiftedWest;
  if (directSpan > 180 && shiftedSpan > 0 && shiftedSpan < directSpan) {
    return { west: shiftedWest, south, east: shiftedEast, north };
  }
  return { west, south, east, north };
}

/**
 * The tile zoom at which a bounding box is about one canvas across.
 *
 * `plotExtent` stretches whatever extent it is given to fill the canvas, so zoom does not
 * change *what* is drawn — it only decides which basemap tiles are fetched. A single fixed
 * zoom cannot serve 125 offices: across the real CWAs the right level ranges from 2 to 9,
 * and holding it at 7 both upscales a lone tile across the 78 smallest offices and pulls
 * dozens of tiles it then throws away on the largest.
 *
 * @param {Bounds} bounds
 * @param {number} [width]
 * @param {number} [height]
 * @returns {number} an integer tile level
 */
export function fitZoom(bounds, width = PLOT_WIDTH, height = MAP_HEIGHT) {
  const extent = plotExtent(bounds, width, height, PLOT_ZOOM);
  const ratio = width / (extent.right - extent.left);
  // Rounded down, so the frame is never asked for more detail than a tile level provides;
  // clamped to the levels the basemap actually serves.
  const zoom = PLOT_ZOOM + Math.floor(Math.log2(ratio));
  return Math.max(1, Math.min(12, zoom));
}

/**
 * @param {Bounds} bounds
 * @param {number} lon
 * @param {number} lat
 */
export function withinBounds(bounds, lon, lat) {
  return lon >= bounds.west && lon <= bounds.east && lat >= bounds.south && lat <= bounds.north;
}
