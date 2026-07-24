"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PLOT_FONT_FAMILY } from "../fonts";
import { DEFAULT_OFFICE, findOffice, REGIONS, type Office, type OfficeId } from "../offices";
import { MAP_HEIGHT, PLOT_WIDTH, inverseWorld, plotExtent, project } from "../../lib/map-frame.mjs";

type ProductId = "apparentTemperature" | "temperature" | "windGust" | "probabilityOfPrecipitation" | "quantitativePrecipitation";
type ForecastPoint = {
  id: string;
  name: string;
  state: string;
  lat: number;
  lon: number;
  label: boolean;
  metrics: Record<ProductId, Array<number | null>>;
};
type ForecastPayload = {
  office: OfficeId;
  generatedAt: string;
  updatedAt: string;
  days: Array<{ date: string; label: string; shortLabel: string }>;
  points: ForecastPoint[];
  failures: number;
};
type PublishedForecastAsset = {
  preview: string;
  download: string;
  width: number;
  height: number;
};
type PublishedForecastDay = {
  date: string;
  label: string;
  shortLabel: string;
  products: Partial<Record<ProductId, PublishedForecastAsset>>;
};
type PublishedForecastManifest = {
  schemaVersion: 2;
  releaseId: string;
  updatedAt: string;
  generatedAt: string;
  sourceRevision: string;
  offices: Partial<Record<OfficeId, { days: PublishedForecastDay[] }>>;
};
type Boundary = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry:
      | { type: "Polygon"; coordinates: number[][][] }
      | { type: "MultiPolygon"; coordinates: number[][][][] };
    properties: { wfo: string; cwa: string; citystate: string };
  }>;
};
type CountyBoundaries = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    id?: string;
    geometry: { type: "Polygon"; coordinates: number[][][] } | { type: "MultiPolygon"; coordinates: number[][][][] };
    properties: Record<string, unknown>;
  }>;
};
type LineFeatures = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "LineString"; coordinates: number[][] } | { type: "MultiLineString"; coordinates: number[][][] };
    properties: Record<string, unknown>;
  }>;
};
type Bounds = { west: number; south: number; east: number; north: number };
type MapExtent = { left: number; top: number; right: number; bottom: number; zoom: number };
type ColorStop = { value: number; color: string };
type ProductGroupId = "temperature" | "wind" | "precipitation";
type ProductSpec = {
  id: ProductId;
  title: string;
  nav: string;
  group: ProductGroupId;
  legend: string;
  unit: string;
  file: string;
  decimals: number;
  stops: ColorStop[];
  verticalLegend?: boolean;
  fillAlpha?: number;
};

const RENDER_SCALE = 2;
const HEADER_HEIGHT = 96;
const PLOT_HEIGHT = HEADER_HEIGHT + MAP_HEIGHT;
const FORECAST_DAYS = [0, 1, 2];
// The interpolated field is smooth enough that evaluating it every fourth pixel and
// interpolating between samples is visually identical to a per-pixel solve, for a
// sixteenth of the work. Without this the regional point count makes rendering crawl.
const FIELD_STRIDE = 4;
const COLOR_LUT_SIZE = 1024;
const PUBLISHED_ASSET_BASE_URL = (process.env.NEXT_PUBLIC_FORECAST_ASSET_BASE_URL ?? "").replace(/\/+$/, "");
const PRODUCTS: ProductSpec[] = [
  {
    id: "apparentTemperature", title: "Maximum Apparent Temperature", nav: "Feels Like", group: "temperature", legend: "APPARENT TEMPERATURE (°F)", unit: "°", file: "max-apparent-temperature", decimals: 0, verticalLegend: true,
    stops: [{ value: -50, color: "#d31258" }, { value: -40, color: "#e12b8a" }, { value: -30, color: "#febee4" }, { value: -20, color: "#d4d5eb" }, { value: -10, color: "#9d9bc9" }, { value: 0, color: "#472c91" }, { value: 10, color: "#036eca" }, { value: 20, color: "#4fc7fd" }, { value: 30, color: "#9efefd" }, { value: 40, color: "#0a918b" }, { value: 50, color: "#0d7f34" }, { value: 60, color: "#84cb82" }, { value: 70, color: "#e4feb7" }, { value: 80, color: "#ffe49a" }, { value: 90, color: "#ffa435" }, { value: 100, color: "#fa442c" }, { value: 110, color: "#990428" }, { value: 120, color: "#641251" }],
  },
  {
    id: "temperature", title: "Maximum Temperature", nav: "Temperature", group: "temperature", legend: "TEMPERATURE (°F)", unit: "°", file: "max-temperature", decimals: 0, verticalLegend: true,
    stops: [{ value: -50, color: "#d31258" }, { value: -40, color: "#e12b8a" }, { value: -30, color: "#febee4" }, { value: -20, color: "#d4d5eb" }, { value: -10, color: "#9d9bc9" }, { value: 0, color: "#472c91" }, { value: 10, color: "#036eca" }, { value: 20, color: "#4fc7fd" }, { value: 30, color: "#9efefd" }, { value: 40, color: "#0a918b" }, { value: 50, color: "#0d7f34" }, { value: 60, color: "#84cb82" }, { value: 70, color: "#e4feb7" }, { value: 80, color: "#ffe49a" }, { value: 90, color: "#ffa435" }, { value: 100, color: "#fa442c" }, { value: 110, color: "#990428" }, { value: 120, color: "#641251" }],
  },
  {
    id: "windGust", title: "Maximum Wind Gust", nav: "Wind Gust", group: "wind", legend: "WIND GUST (MPH)", unit: " mph", file: "max-wind-gust", decimals: 0, verticalLegend: true,
    stops: [{ value: 0, color: "#f7fbff" }, { value: 10, color: "#c6dbef" }, { value: 20, color: "#6baed6" }, { value: 30, color: "#31a354" }, { value: 40, color: "#fed976" }, { value: 50, color: "#fd8d3c" }, { value: 60, color: "#e31a1c" }, { value: 70, color: "#800026" }],
  },
  {
    id: "probabilityOfPrecipitation", title: "Maximum POP %", nav: "Rain Chance", group: "precipitation", legend: "PROBABILITY OF PRECIPITATION (%)", unit: "%", file: "max-pop", decimals: 0, fillAlpha: 235, verticalLegend: true,
    stops: [{ value: 0, color: "#ffffff" }, { value: 10, color: "#e5f5e0" }, { value: 20, color: "#a1d99b" }, { value: 40, color: "#41ab5d" }, { value: 60, color: "#2b8cbe" }, { value: 80, color: "#756bb1" }, { value: 100, color: "#54278f" }],
  },
  {
    id: "quantitativePrecipitation", title: "Total Precipitation Forecast", nav: "Rainfall", group: "precipitation", legend: "LIQUID PRECIPITATION (INCHES)", unit: " in", file: "total-precipitation", decimals: 2, fillAlpha: 235, verticalLegend: true,
    stops: [{ value: 0, color: "#ffffff" }, { value: 0.01, color: "#e5f5e0" }, { value: 0.1, color: "#a1d99b" }, { value: 0.25, color: "#41ab5d" }, { value: 0.5, color: "#ffffb2" }, { value: 1, color: "#fe9929" }, { value: 2, color: "#de2d26" }, { value: 3, color: "#756bb1" }],
  },
];

const PRODUCT_GROUPS: Array<{ id: ProductGroupId; title: string }> = [
  { id: "temperature", title: "Temperature & heat" },
  { id: "wind", title: "Wind" },
  { id: "precipitation", title: "Precipitation" },
];

const tileCache = new Map<string, Promise<ImageBitmap>>();
let headerMarkPromise: Promise<ImageBitmap | null> | null = null;

function loadHeaderMark() {
  if (!headerMarkPromise) {
    headerMarkPromise = fetch("/weather-mark-white.png")
      .then(async (response) => response.ok ? createImageBitmap(await response.blob()) : null)
      .catch(() => null);
  }
  return headerMarkPromise;
}

/** Every map is framed on its own office's County Warning Area. */
function officeFeature(boundary: Boundary, office: OfficeId) {
  return boundary.features.find((feature) => feature.properties.cwa === office) ?? boundary.features[0];
}

function boundaryBounds(boundary: Boundary, office: OfficeId): Bounds {
  const geometry = officeFeature(boundary, office).geometry;
  const positions = (geometry.type === "Polygon" ? geometry.coordinates.flat(1) : geometry.coordinates.flat(2)) as number[][];
  const lons = positions.map((position) => position[0]);
  const lats = positions.map((position) => position[1]);
  return { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
}

function traceCounties(context: CanvasRenderingContext2D, counties: CountyBoundaries, projectPoint: (lon: number, lat: number) => [number, number]) {
  context.beginPath();
  for (const feature of counties.features) {
    const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const polygon of polygons) {
      for (const ring of polygon) {
        ring.forEach((position, index) => {
          const [x, y] = projectPoint(position[0], position[1]);
          if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
        });
        context.closePath();
      }
    }
  }
}

// The NWS source ships some CWAs as Polygon and others as MultiPolygon, so normalize.
function traceBoundary(context: CanvasRenderingContext2D, boundary: Boundary, office: OfficeId, projectPoint: (lon: number, lat: number) => [number, number]) {
  const geometry = officeFeature(boundary, office).geometry;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  context.beginPath();
  for (const polygon of polygons) {
    for (const ring of polygon) {
      ring.forEach((position, index) => {
        const [x, y] = projectPoint(position[0], position[1]);
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      });
      context.closePath();
    }
  }
}

function traceLines(context: CanvasRenderingContext2D, lines: LineFeatures, projectPoint: (lon: number, lat: number) => [number, number]) {
  context.beginPath();
  for (const feature of lines.features) {
    const parts = feature.geometry.type === "LineString" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const part of parts) {
      part.forEach((position, index) => {
        const [x, y] = projectPoint(position[0], position[1]);
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      });
    }
  }
}

function hexToRgb(hex: string) {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

function colorFor(value: number, stops: ColorStop[]) {
  if (value <= stops[0].value) return hexToRgb(stops[0].color);
  if (value >= stops.at(-1)!.value) return hexToRgb(stops.at(-1)!.color);
  const upperIndex = stops.findIndex((stop) => value <= stop.value);
  const lower = stops[upperIndex - 1];
  const upper = stops[upperIndex];
  const amount = (value - lower.value) / (upper.value - lower.value);
  const a = hexToRgb(lower.color);
  const b = hexToRgb(upper.color);
  return a.map((channel, index) => Math.round(channel + (b[index] - channel) * amount));
}

// `colorFor` re-parses hex strings on every call, which is far too slow to run once per
// pixel. Bake it into a ramp instead. The stops are not evenly spaced (QPF runs 0, 0.01,
// 0.1, 0.25, 0.5, 1, 2, 3), so each entry has to come from `colorFor` itself rather than
// from walking between stops at uniform intervals.
const colorRamps = new WeakMap<ColorStop[], { table: Uint8ClampedArray; min: number; span: number }>();

function colorRamp(stops: ColorStop[]) {
  const cached = colorRamps.get(stops);
  if (cached) return cached;
  const min = stops[0].value;
  const span = stops.at(-1)!.value - min;
  const table = new Uint8ClampedArray(COLOR_LUT_SIZE * 3);
  for (let index = 0; index < COLOR_LUT_SIZE; index += 1) {
    const [red, green, blue] = colorFor(min + span * (index / (COLOR_LUT_SIZE - 1)), stops);
    table[index * 3] = red;
    table[index * 3 + 1] = green;
    table[index * 3 + 2] = blue;
  }
  const ramp = { table, min, span };
  colorRamps.set(stops, ramp);
  return ramp;
}

function sampleField(points: ForecastPoint[], product: ProductId, dayIndex: number, lon: number, lat: number) {
  const neighborCount = 8;
  const neighbors: Array<{ distanceSquared: number; value: number }> = [];
  for (const point of points) {
    const value = point.metrics[product][dayIndex];
    if (value === null) continue;
    const dx = (lon - point.lon) * Math.cos(lat * Math.PI / 180);
    const dy = lat - point.lat;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared < 0.000001) return value;
    const insertAt = neighbors.findIndex((neighbor) => distanceSquared < neighbor.distanceSquared);
    if (insertAt === -1) {
      if (neighbors.length < neighborCount) neighbors.push({ distanceSquared, value });
    } else {
      neighbors.splice(insertAt, 0, { distanceSquared, value });
      if (neighbors.length > neighborCount) neighbors.pop();
    }
  }
  let weighted = 0;
  let weights = 0;
  for (const neighbor of neighbors) {
    const weight = 1 / Math.pow(neighbor.distanceSquared + 0.0005, 1.35);
    weighted += neighbor.value * weight;
    weights += weight;
  }
  return weights ? weighted / weights : 0;
}

function loadTile(url: string) {
  if (!tileCache.has(url)) {
    tileCache.set(url, fetch(url).then(async (response) => {
      if (!response.ok) throw new Error("Basemap unavailable");
      return createImageBitmap(await response.blob());
    }));
  }
  return tileCache.get(url)!;
}

async function drawTiles(context: CanvasRenderingContext2D, extent: MapExtent, x: number, y: number, width: number) {
  const firstX = Math.floor(extent.left / 256);
  const lastX = Math.floor(extent.right / 256);
  const firstY = Math.floor(extent.top / 256);
  const lastY = Math.floor(extent.bottom / 256);
  const scale = width / (extent.right - extent.left);
  await Promise.all(Array.from({ length: lastX - firstX + 1 }, (_, xi) => firstX + xi).flatMap((tileX) =>
    Array.from({ length: lastY - firstY + 1 }, (_, yi) => firstY + yi).map(async (tileY) => {
      try {
        const url = `https://a.basemaps.cartocdn.com/rastertiles/voyager_nolabels/${extent.zoom}/${tileX}/${tileY}@2x.png`;
        const bitmap = await loadTile(url);
        context.drawImage(bitmap, x + (tileX * 256 - extent.left) * scale, y + (tileY * 256 - extent.top) * scale, 256 * scale, 256 * scale);
      } catch {
        // The forecast remains usable over the neutral fallback background.
      }
    }),
  ));
}

function displayValue(value: number, spec: ProductSpec) {
  return `${value.toFixed(spec.decimals)}${spec.unit}`;
}

function legendValue(value: number, spec: ProductSpec) {
  if (spec.id === "apparentTemperature" || spec.id === "temperature") return `${value}°`;
  if (spec.id === "quantitativePrecipitation") return value < 0.1 && value > 0 ? value.toFixed(2) : String(value);
  return String(value);
}

function outlinedText(context: CanvasRenderingContext2D, value: string, x: number, y: number, lineWidth = 3) {
  context.strokeStyle = "rgba(15, 23, 42, 0.92)";
  context.lineWidth = lineWidth;
  context.strokeText(value, x, y);
  context.fillStyle = "#ffffff";
  context.fillText(value, x, y);
}

function forecastDate(value: string) {
  return new Date(`${value}T16:00:00Z`);
}

function timeZoneName(value: Date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).formatToParts(value).find((part) => part.type === "timeZoneName")?.value ?? "ET";
}

function drawForecastHeader(
  context: CanvasRenderingContext2D,
  forecast: ForecastPayload,
  spec: ProductSpec,
  dayIndex: number,
  headerMark: ImageBitmap | null,
) {
  const day = forecast.days[dayIndex];
  const validDate = forecastDate(day.date);
  const validLabel = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  }).format(validDate).toUpperCase();
  const validZone = timeZoneName(validDate);
  const issuedLabel = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(new Date(forecast.updatedAt)).toUpperCase();

  // Match the site's editorial catalogue with a quiet black surface and a
  // compact, high-contrast information hierarchy.
  context.fillStyle = "#090909";
  context.fillRect(0, 0, PLOT_WIDTH, HEADER_HEIGHT);
  context.strokeStyle = "#2c2c2c";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, HEADER_HEIGHT - 0.5);
  context.lineTo(PLOT_WIDTH, HEADER_HEIGHT - 0.5);
  context.stroke();

  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.fillStyle = "#f4f4f4";
  context.font = `600 27px ${PLOT_FONT_FAMILY}`;
  context.fillText(spec.title, 24, 39);

  if (headerMark) {
    // Keep the mark in the unused top-right corner, clear of the issued line.
    context.drawImage(headerMark, PLOT_WIDTH - 84, -2, 72, 72);
  }

  context.fillStyle = "#ffffff";
  context.font = `600 14px ${PLOT_FONT_FAMILY}`;
  context.fillText(`VALID  ${validLabel} · 12:00 AM–11:59 PM ${validZone}`, 24, 74);
  context.textAlign = "right";
  context.fillText(`NWS ISSUED  ${issuedLabel}`, PLOT_WIDTH - 24, 74);
  context.textAlign = "left";
}

async function renderPlot(canvas: HTMLCanvasElement, forecast: ForecastPayload, boundary: Boundary, counties: CountyBoundaries, states: CountyBoundaries, interstates: LineFeatures, spec: ProductSpec, dayIndex: number, office: OfficeId) {
  const width = PLOT_WIDTH;
  const height = MAP_HEIGHT;
  const mapCanvas = document.createElement("canvas");
  mapCanvas.width = width * RENDER_SCALE;
  mapCanvas.height = height * RENDER_SCALE;
  const context = mapCanvas.getContext("2d")!;
  context.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
  context.lineJoin = "round";
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  if (document.fonts?.ready) await document.fonts.ready;

  // Work in logical pixels while the backing canvas renders at 2× resolution.
  const plot = { x: 0, y: 0, width, height };
  context.fillStyle = "#dfe8ee";
  context.fillRect(plot.x, plot.y, plot.width, plot.height);
  const bounds = boundaryBounds(boundary, office);
  const extent = plotExtent(bounds, plot.width, plot.height);
  const projectPoint = (lon: number, lat: number) => project(lon, lat, extent, plot.x, plot.y, plot.width, plot.height);
  await drawTiles(context, extent, plot.x, plot.y, plot.width);

  context.save();
  context.beginPath();
  context.rect(plot.x, plot.y, plot.width, plot.height);
  context.clip();

  context.strokeStyle = "#64748b40";
  context.lineWidth = 0.8;
  context.setLineDash([2, 4]);
  for (let lon = Math.ceil(bounds.west * 2) / 2; lon <= bounds.east; lon += 0.5) {
    const a = project(lon, bounds.south - 0.5, extent, plot.x, plot.y, plot.width, plot.height);
    const b = project(lon, bounds.north + 0.5, extent, plot.x, plot.y, plot.width, plot.height);
    context.beginPath(); context.moveTo(...a); context.lineTo(...b); context.stroke();
  }
  for (let lat = Math.ceil(bounds.south * 2) / 2; lat <= bounds.north; lat += 0.5) {
    const a = project(bounds.west - 1, lat, extent, plot.x, plot.y, plot.width, plot.height);
    const b = project(bounds.east + 1, lat, extent, plot.x, plot.y, plot.width, plot.height);
    context.beginPath(); context.moveTo(...a); context.lineTo(...b); context.stroke();
  }
  context.setLineDash([]);

  const points = forecast.points.filter((point) => point.metrics[spec.id][dayIndex] !== null);
  const gridPoints = points.filter((point) => !point.label);
  const fieldPoints = gridPoints.length ? gridPoints : points;
  const fillAlpha = spec.fillAlpha ?? 185;
  const raster = document.createElement("canvas");
  raster.width = PLOT_WIDTH;
  raster.height = MAP_HEIGHT;
  const rasterContext = raster.getContext("2d")!;
  const image = rasterContext.createImageData(raster.width, raster.height);

  // Solve the field on a coarse lattice. The extra column and row matter: without a
  // sample at or past each far edge the last stride of pixels has no upper neighbour to
  // interpolate against and the raster ends in a visible seam.
  const columns = Math.ceil((raster.width - 1) / FIELD_STRIDE) + 1;
  const rows = Math.ceil((raster.height - 1) / FIELD_STRIDE) + 1;
  const field = new Float32Array(columns * rows);
  for (let row = 0; row < rows; row += 1) {
    const y = Math.min(row * FIELD_STRIDE, raster.height - 1);
    const worldY = extent.top + y / (raster.height - 1) * (extent.bottom - extent.top);
    for (let column = 0; column < columns; column += 1) {
      const x = Math.min(column * FIELD_STRIDE, raster.width - 1);
      const worldX = extent.left + x / (raster.width - 1) * (extent.right - extent.left);
      const coordinate = inverseWorld(worldX, worldY, extent.zoom);
      field[row * columns + column] = sampleField(fieldPoints, spec.id, dayIndex, coordinate.lon, coordinate.lat);
    }
  }

  // Bilinearly expand the lattice back to full resolution, colouring each pixel from the
  // interpolated *value* — interpolating colours instead would muddy the ramp bands.
  const { table, min, span } = colorRamp(spec.stops);
  const scale = span === 0 ? 0 : (COLOR_LUT_SIZE - 1) / span;
  for (let y = 0; y < raster.height; y += 1) {
    const row = Math.min(Math.floor(y / FIELD_STRIDE), rows - 2 < 0 ? 0 : rows - 2);
    const rowFraction = (y - row * FIELD_STRIDE) / FIELD_STRIDE;
    const topOffset = row * columns;
    const bottomOffset = Math.min(row + 1, rows - 1) * columns;
    for (let x = 0; x < raster.width; x += 1) {
      const column = Math.min(Math.floor(x / FIELD_STRIDE), columns - 2 < 0 ? 0 : columns - 2);
      const columnFraction = (x - column * FIELD_STRIDE) / FIELD_STRIDE;
      const right = Math.min(column + 1, columns - 1);
      const top = field[topOffset + column] + (field[topOffset + right] - field[topOffset + column]) * columnFraction;
      const bottom = field[bottomOffset + column] + (field[bottomOffset + right] - field[bottomOffset + column]) * columnFraction;
      const value = top + (bottom - top) * rowFraction;
      let index = Math.round((value - min) * scale);
      if (index < 0) index = 0;
      else if (index > COLOR_LUT_SIZE - 1) index = COLOR_LUT_SIZE - 1;
      const source = index * 3;
      const offset = (y * raster.width + x) * 4;
      image.data[offset] = table[source];
      image.data[offset + 1] = table[source + 1];
      image.data[offset + 2] = table[source + 2];
      image.data[offset + 3] = fillAlpha;
    }
  }
  rasterContext.putImageData(image, 0, 0);
  // Deliberately unclipped: the field covers the whole frame using real data from the
  // neighbouring offices, and the CWA outline below is what marks the forecast area.
  context.drawImage(raster, plot.x, plot.y, plot.width, plot.height);

  traceCounties(context, counties, projectPoint);
  context.strokeStyle = "rgba(0, 0, 0, 0.42)";
  context.lineWidth = 0.9;
  context.stroke();

  traceCounties(context, states, projectPoint);
  context.strokeStyle = "rgba(8, 13, 24, 0.9)";
  context.lineWidth = 1.7;
  context.stroke();

  traceLines(context, interstates, projectPoint);
  context.strokeStyle = "#c02b1f";
  context.lineWidth = 1.4;
  context.stroke();

  traceBoundary(context, boundary, office, projectPoint);
  context.strokeStyle = "rgba(8, 13, 24, 0.98)";
  context.lineWidth = 2.4;
  context.stroke();
  context.restore();

  context.textAlign = "center";
  for (const point of points.filter((item) => item.label)) {
    const value = point.metrics[spec.id][dayIndex];
    if (value === null) continue;
    const [x, y] = project(point.lon, point.lat, extent, plot.x, plot.y, plot.width, plot.height);
    const formatted = displayValue(value, spec);
    context.font = `600 16px ${PLOT_FONT_FAMILY}`;
    context.fillStyle = "#ffffff";
    context.strokeStyle = "#111827";
    context.lineWidth = 4;
    context.strokeText(formatted, x, y - 9);
    context.fillText(formatted, x, y - 9);
    context.beginPath(); context.arc(x, y, 3.2, 0, Math.PI * 2); context.fillStyle = "#dc2626"; context.fill(); context.strokeStyle = "#fff"; context.lineWidth = 1.5; context.stroke();
    context.font = `600 11px ${PLOT_FONT_FAMILY}`;
    context.fillStyle = "#fff"; context.strokeStyle = "#111827"; context.lineWidth = 3;
    context.strokeText(point.name, x, y + 12); context.fillText(point.name, x, y + 12);
  }
  context.textAlign = "left";

  if (spec.verticalLegend) {
    const barX = 30;
    const barTop = 54;
    const barWidth = 17;
    const arrow = 8;
    const colorHeight = 612;
    const bandHeight = colorHeight / spec.stops.length;
    const reversed = [...spec.stops].reverse();
    context.save();
    context.translate(18, barTop + colorHeight / 2);
    context.rotate(-Math.PI / 2);
    context.textAlign = "center";
    context.font = `600 12px ${PLOT_FONT_FAMILY}`;
    outlinedText(context, spec.legend, 0, 0, 3);
    context.restore();
    reversed.forEach((stop, index) => {
      context.fillStyle = stop.color;
      context.fillRect(barX, barTop + arrow + index * bandHeight, barWidth, bandHeight + 0.5);
    });
    context.fillStyle = reversed[0].color;
    context.beginPath(); context.moveTo(barX, barTop + arrow); context.lineTo(barX + barWidth / 2, barTop); context.lineTo(barX + barWidth, barTop + arrow); context.closePath(); context.fill();
    context.fillStyle = reversed.at(-1)!.color;
    const bottomY = barTop + arrow + colorHeight;
    context.beginPath(); context.moveTo(barX, bottomY); context.lineTo(barX + barWidth / 2, bottomY + arrow); context.lineTo(barX + barWidth, bottomY); context.closePath(); context.fill();
    context.strokeStyle = "rgba(0, 0, 0, 0.35)";
    context.lineWidth = 1;
    context.strokeRect(barX, barTop + arrow, barWidth, colorHeight);
    context.textAlign = "left";
    context.font = `600 11px ${PLOT_FONT_FAMILY}`;
    reversed.forEach((stop, index) => outlinedText(context, legendValue(stop.value, spec), barX + barWidth + 7, barTop + arrow + (index + 0.64) * bandHeight, 3));
  } else {
    const legendX = 26;
    const legendY = height - 78;
    const legendWidth = 300;
    context.textAlign = "left";
    context.font = `600 12px ${PLOT_FONT_FAMILY}`;
    outlinedText(context, spec.legend, legendX, legendY - 9, 3);
    const gradient = context.createLinearGradient(legendX, 0, legendX + legendWidth, 0);
    spec.stops.forEach((stop, index) => gradient.addColorStop(index / (spec.stops.length - 1), stop.color));
    context.fillStyle = gradient;
    context.fillRect(legendX, legendY, legendWidth, 12);
    context.strokeStyle = "rgba(0, 0, 0, 0.35)";
    context.lineWidth = 1;
    context.strokeRect(legendX, legendY, legendWidth, 12);
    context.font = `600 11px ${PLOT_FONT_FAMILY}`;
    spec.stops.forEach((stop, index) => outlinedText(context, legendValue(stop.value, spec), legendX + index / (spec.stops.length - 1) * legendWidth - 4, legendY + 25, 3));
  }

  // Signature tag (bottom-right) — X logo + handle, no plate.
  context.textAlign = "right";
  context.textBaseline = "alphabetic";
  context.font = `600 13px ${PLOT_FONT_FAMILY}`;
  context.fillStyle = "rgba(15, 23, 42, 0.9)";
  const tag = "suchit_wx";
  context.fillText(tag, width - 14, height - 13);
  const tagWidth = context.measureText(tag).width;
  const logoSize = 13;
  context.save();
  context.translate(width - 14 - tagWidth - 7 - logoSize, height - 13 - logoSize + 1);
  context.scale(logoSize / 24, logoSize / 24);
  context.fillStyle = "rgba(15, 23, 42, 0.9)";
  context.fill(new Path2D("M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"));
  context.restore();
  context.textAlign = "left";

  // Commit the completed map and header together. Rendering offscreen avoids
  // concurrent development-mode effects sharing one canvas drawing state.
  canvas.width = width * RENDER_SCALE;
  canvas.height = PLOT_HEIGHT * RENDER_SCALE;
  const output = canvas.getContext("2d")!;
  output.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
  output.imageSmoothingEnabled = true;
  output.imageSmoothingQuality = "high";
  drawForecastHeader(output, forecast, spec, dayIndex, await loadHeaderMark());
  output.drawImage(mapCanvas, 0, HEADER_HEIGHT, width, height);
}

function ForecastPlot({ spec, forecast, boundary, counties, states, interstates, dayIndex, office }: { spec: ProductSpec; forecast: ForecastPayload; boundary: Boundary; counties: CountyBoundaries; states: CountyBoundaries; interstates: LineFeatures; dayIndex: number; office: Office }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!canvas.current) return;
    let active = true;
    setReady(false);
    void renderPlot(canvas.current, forecast, boundary, counties, states, interstates, spec, dayIndex, office.id).then(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, [forecast, boundary, counties, states, interstates, spec, dayIndex, office]);

  const download = useCallback(() => {
    if (!canvas.current || !ready) return;
    canvas.current.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${office.id.toLowerCase()}-${spec.file}-${forecast.days[dayIndex]?.date || `day-${dayIndex + 1}`}.png`;
      link.click();
      URL.revokeObjectURL(link.href);
    }, "image/png");
  }, [forecast, ready, spec, dayIndex, office]);

  return (
    <article className="forecast-product" id={`product-${spec.id}`} data-product-id={spec.id} data-product-file={spec.file}>
      <div className="product-bar">
        <h3>{spec.title}</h3>
        <button onClick={download} disabled={!ready}>{ready ? "Download PNG ↓" : "Rendering…"}</button>
      </div>
      <canvas
        ref={canvas}
        className="forecast-canvas"
        role="img"
        aria-label={`${spec.title}, Day ${dayIndex + 1}, for the ${office.id} forecast area`}
        data-product-id={spec.id}
        data-product-file={spec.file}
        data-day-index={dayIndex}
        data-office={office.id}
        data-render-state={ready ? "ready" : "rendering"}
      />
    </article>
  );
}

function publishedAssetUrl(path: string) {
  return `/api/forecast-assets/${path.replace(/^\/+/, "")}`;
}

function PublishedForecastPlot({ spec, asset, dayIndex, eager, office }: { spec: ProductSpec; asset: PublishedForecastAsset; dayIndex: number; eager: boolean; office: Office }) {
  return (
    <article className="forecast-product" id={`product-${spec.id}`} data-product-id={spec.id} data-product-file={spec.file}>
      <div className="product-bar">
        <h3>{spec.title}</h3>
        <a href={publishedAssetUrl(asset.download)} download={`${office.id.toLowerCase()}-${spec.file}-day-${dayIndex + 1}.png`}>Download PNG ↓</a>
      </div>
      {/* The same-origin asset route streams the exact immutable PNG from R2. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="forecast-canvas"
        src={publishedAssetUrl(asset.preview)}
        width={asset.width / RENDER_SCALE}
        height={asset.height / RENDER_SCALE}
        loading={eager ? "eager" : "lazy"}
        fetchPriority={eager ? "high" : "auto"}
        alt={`${spec.title}, Day ${dayIndex + 1}, for the ${office.id} forecast area`}
      />
    </article>
  );
}

// The `?office=` parameter is the single source of truth for the selection, so deep
// links, the publisher's per-office navigation, and browser back/forward all agree.
// `replaceState` doesn't fire `popstate`, hence the companion event.
const OFFICE_CHANGE_EVENT = "forecast-office-change";

function subscribeToOfficeParam(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(OFFICE_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(OFFICE_CHANGE_EVENT, onChange);
  };
}

function readOfficeParam(): string {
  return new URLSearchParams(window.location.search).get("office") ?? DEFAULT_OFFICE;
}

function writeOfficeParam(id: OfficeId) {
  const url = new URL(window.location.href);
  url.searchParams.set("office", id);
  window.history.replaceState(null, "", url);
  window.dispatchEvent(new Event(OFFICE_CHANGE_EVENT));
}

function OfficePicker({ office, onSelect }: { office: Office; onSelect: (office: Office) => void }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const flattened = useMemo(() => REGIONS.flatMap((region) => region.offices), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  const move = useCallback((step: number) => {
    const index = flattened.findIndex((entry) => entry.id === office.id);
    const next = flattened[(index + step + flattened.length) % flattened.length];
    onSelect(next);
  }, [flattened, office, onSelect]);

  // Arrow keys walk the whole list, crossing region headings as if they weren't there.
  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && open) {
      event.preventDefault();
      close(true);
    }
  }, [close, move, open]);

  return (
    <div className="office-picker" ref={container} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        className="office-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Forecast office: ${office.label}. Change office`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="brand-mark">{office.id}</span>
        <span className="office-trigger-text">
          <strong>Forecast Graphics</strong>
          <em>{office.label}</em>
        </span>
        <span className="office-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="office-menu" role="listbox" aria-label="Forecast office" tabIndex={-1}>
          {REGIONS.map((region) => (
            <div className="office-group" key={region.id}>
              <p>{region.name}</p>
              {region.offices.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="option"
                  aria-selected={entry.id === office.id}
                  data-office={entry.id}
                  className={entry.id === office.id ? "is-active" : ""}
                  onClick={() => {
                    onSelect(entry);
                    close(true);
                  }}
                >
                  <b>{entry.id}</b>
                  <span>{entry.city}, {entry.state}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ForecastGraphic() {
  const [forecast, setForecast] = useState<ForecastPayload | null>(null);
  const [publishedForecast, setPublishedForecast] = useState<PublishedForecastManifest | null>(null);
  const [boundary, setBoundary] = useState<Boundary | null>(null);
  const [counties, setCounties] = useState<CountyBoundaries | null>(null);
  const [states, setStates] = useState<CountyBoundaries | null>(null);
  const [interstates, setInterstates] = useState<LineFeatures | null>(null);
  const [dayIndex, setDayIndex] = useState(0);
  const [error, setError] = useState(false);

  // The server can't see the query string, so it renders the default office; the client
  // swaps to the requested one on hydration without a markup mismatch.
  const officeId = useSyncExternalStore(subscribeToOfficeParam, readOfficeParam, () => DEFAULT_OFFICE);
  const office = useMemo(() => findOffice(officeId), [officeId]);
  const selectOffice = useCallback((next: Office) => writeOfficeParam(next.id), []);

  // Basemap overlays are the same for every office, so they load once and are reused.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [boundaryResponse, countyResponse, stateResponse, interstateResponse] = await Promise.all([
          fetch("/cwa.geojson"),
          fetch("/counties.geojson"),
          fetch("/states.geojson"),
          fetch("/interstates.geojson"),
        ]);
        if (!boundaryResponse.ok || !countyResponse.ok || !stateResponse.ok || !interstateResponse.ok) throw new Error("Overlays unavailable");
        const [boundaryData, countyData, stateData, interstateData] = await Promise.all([
          boundaryResponse.json() as Promise<Boundary>,
          countyResponse.json() as Promise<CountyBoundaries>,
          stateResponse.json() as Promise<CountyBoundaries>,
          interstateResponse.json() as Promise<LineFeatures>,
        ]);
        if (!active) return;
        setBoundary(boundaryData);
        setCounties(countyData);
        setStates(stateData);
        setInterstates(interstateData);
      } catch {
        if (active) setError(true);
      }
    })();
    return () => { active = false; };
  }, []);

  // One manifest covers every office, so it refreshes independently of the selection.
  useEffect(() => {
    if (!PUBLISHED_ASSET_BASE_URL) return;
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`/api/published-forecast?ts=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) return;
        const manifest = await response.json() as PublishedForecastManifest;
        if (!active || manifest.schemaVersion !== 2) return;
        setPublishedForecast(manifest);
      } catch {
        // The live canvas path stays available when the manifest can't be read.
      }
    };
    void load();
    const refresh = window.setInterval(load, 15 * 60 * 1000);
    return () => { active = false; window.clearInterval(refresh); };
  }, []);

  const publishedDays = publishedForecast?.offices?.[office.id]?.days;
  const hasPublishedOffice = Boolean(publishedDays && publishedDays.length >= FORECAST_DAYS.length);

  // Only fetch live gridpoint data when this office has no published imagery to show.
  useEffect(() => {
    if (hasPublishedOffice) return;
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`/api/forecast?office=${office.id}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Forecast unavailable");
        const payload = await response.json() as ForecastPayload;
        if (!active) return;
        setForecast(payload);
        setError(false);
      } catch {
        if (active) setError(true);
      }
    };
    void load();
    const refresh = window.setInterval(load, 15 * 60 * 1000);
    return () => { active = false; window.clearInterval(refresh); };
  }, [office, hasPublishedOffice]);

  const availableProducts = useMemo(() => PRODUCTS, []);
  const publishedDay = publishedDays?.[dayIndex];
  // Derived rather than cleared on switch, so a previous office's payload can never be
  // drawn against the newly selected office's boundary.
  const officeForecast = forecast?.office === office.id ? forecast : null;
  return (
    <main className="app-shell">
      <aside className="catalog-sidebar">
        <OfficePicker office={office} onSelect={selectOffice} />
        <nav className="catalog-nav" aria-label="Forecast product catalogue">
          <p>Menu</p>
          <a className="is-active" href="#overview"><span>Overview</span><b>[5]</b></a>
          {PRODUCT_GROUPS.map((group) => (
            <a key={group.id} href={`#product-${availableProducts.find((product) => product.group === group.id)!.id}`}>
              <span>{group.title}</span>
              <b>[{availableProducts.filter((product) => product.group === group.id).length}]</b>
            </a>
          ))}
        </nav>
        <div className="catalog-divider" />
        <nav className="product-index" aria-label="Individual forecast products">
          <p>Products</p>
          {availableProducts.map((spec) => <a key={spec.id} href={`#product-${spec.id}`}>{spec.nav}</a>)}
        </nav>
        <footer className="catalog-footer">
          <span className="status-label">Data status</span>
          <span className="live-status"><i /> {hasPublishedOffice ? "PUBLISHED IMAGES" : "AUTO-UPDATING"}</span>
          <p>
            Source: National Weather Service<br />
            {/* The picker's trigger is a button, so the office link lives here instead. */}
            <a href={`https://www.weather.gov/${office.id.toLowerCase()}/`} target="_blank" rel="noreferrer">
              NWS {office.label} ↗
            </a>
          </p>
        </footer>
      </aside>

      <section className="catalog-workspace">
        <header className="workspace-topbar">
          <div className="breadcrumbs">
            <span>Forecast catalogue</span>
            <i>/</i>
            <nav className="day-switcher" aria-label="Forecast day">
              {FORECAST_DAYS.map((index) => (
                <button key={index} type="button" data-day-index={index} className={dayIndex === index ? "is-active" : ""} aria-pressed={dayIndex === index} onClick={() => setDayIndex(index)}>
                  Day {index + 1}
                </button>
              ))}
            </nav>
          </div>
          <a href="https://api.weather.gov/" target="_blank" rel="noreferrer">NWS data source ↗</a>
        </header>

        <div className="workspace-content" id="overview">
          <header className="catalog-heading">
            <h1>Day {dayIndex + 1} Forecast Graphics</h1>
            <p>{office.label} · NWS {office.city}, {office.state}</p>
          </header>

          {!hasPublishedOffice && !officeForecast && !error && <div className="gallery-message">Loading the latest NWS forecast plots…</div>}
          {!hasPublishedOffice && error && <div className="gallery-message">Forecast data is temporarily unavailable.</div>}
          {publishedDay && (
            <section className="forecast-gallery" aria-label={`Day ${dayIndex + 1} published forecast plots`} data-forecast-source="published" data-office={office.id}>
              {availableProducts.map((spec, index) => {
                const asset = publishedDay.products[spec.id];
                return asset ? <PublishedForecastPlot key={spec.id} spec={spec} asset={asset} dayIndex={dayIndex} eager={index === 0} office={office} /> : null;
              })}
            </section>
          )}
          {!hasPublishedOffice && officeForecast && boundary && counties && states && interstates && (
            <section className="forecast-gallery" aria-label={`Day ${dayIndex + 1} forecast plots`} data-office={office.id}>
              {availableProducts.map((spec) => (
                <ForecastPlot key={spec.id} spec={spec} forecast={officeForecast} boundary={boundary} counties={counties} states={states} interstates={interstates} dayIndex={dayIndex} office={office} />
              ))}
            </section>
          )}
        </div>
      </section>
    </main>
  );
}
