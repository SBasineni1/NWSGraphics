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
  const lons = [];
  const lats = [];
  const walk = (node) => {
    if (typeof node[0] === "number") {
      lons.push(node[0]);
      lats.push(node[1]);
    } else {
      for (const child of node) walk(child);
    }
  };
  walk(coordinates);
  return { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
}

/**
 * @param {Bounds} bounds
 * @param {number} lon
 * @param {number} lat
 */
export function withinBounds(bounds, lon, lat) {
  return lon >= bounds.west && lon <= bounds.east && lat >= bounds.south && lat <= bounds.north;
}
