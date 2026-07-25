"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PLOT_FONT_FAMILY } from "../fonts";
import { DEFAULT_OFFICE, findOffice, REGIONS, type Office, type OfficeId } from "../offices";
import { MAP_HEIGHT, PLOT_WIDTH, frameBounds, inverseWorld, plotExtent, project } from "../../lib/map-frame.mjs";

type ProductId = "apparentTemperature" | "temperature" | "minTemperature" | "dewpoint" | "windGust" | "windSpeed" | "skyCover" | "probabilityOfPrecipitation" | "quantitativePrecipitation";
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
// Published assets are keyed by whatever product ids exist, including non-field ones.
type PublishedProductId = ProductId | "convectiveOutlook";
type PublishedForecastDay = {
  date: string;
  label: string;
  shortLabel: string;
  products: Partial<Record<PublishedProductId, PublishedForecastAsset>>;
};
type PublishedForecastManifestBase = {
  releaseId: string;
  updatedAt: string;
  generatedAt: string;
  sourceRevision: string;
};
// v1 predates multi-office support and only ever described PHI. It is still accepted so
// that deploying a client ahead of the next publish run doesn't black out the published
// images and drop every visitor onto the live-canvas path.
type PublishedForecastManifestV1 = PublishedForecastManifestBase & {
  schemaVersion: 1;
  days: PublishedForecastDay[];
};
type PublishedForecastManifestV2 = PublishedForecastManifestBase & {
  schemaVersion: 2;
  offices: Partial<Record<OfficeId, { days: PublishedForecastDay[] }>>;
};
type PublishedForecastManifest = PublishedForecastManifestV1 | PublishedForecastManifestV2;

function publishedDaysFor(manifest: PublishedForecastManifest | null, office: OfficeId) {
  if (!manifest) return undefined;
  if (manifest.schemaVersion === 2) return manifest.offices?.[office]?.days;
  return office === "PHI" ? manifest.days : undefined;
}
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
type ProductGroupId = "temperature" | "wind" | "sky" | "precipitation" | "severe";

// Two kinds of product share the catalogue, the day switcher and the publisher, but not
// the renderer: a field is an interpolated raster off the NWS gridpoints, an outlook is a
// set of categorical polygons straight from SPC.
type ProductCommon = {
  title: string;
  nav: string;
  group: ProductGroupId;
  legend: string;
  file: string;
};
type FieldProductSpec = ProductCommon & {
  kind: "field";
  id: ProductId;
  unit: string;
  decimals: number;
  stops: ColorStop[];
  verticalLegend?: boolean;
  fillAlpha?: number;
};
type OutlookProductSpec = ProductCommon & {
  kind: "outlook";
  id: "convectiveOutlook";
};
type ProductSpec = FieldProductSpec | OutlookProductSpec;

type OutlookGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };
type OutlookArea = {
  dn: number;
  label: string;
  description: string;
  fill: string;
  stroke: string;
  geometry: OutlookGeometry;
};
type OutlookDay = {
  day: number;
  valid: string | null;
  expires: string | null;
  issued: string | null;
  forecaster: string | null;
  features: OutlookArea[];
};
type OutlookPayload = { generatedAt: string; days: OutlookDay[]; failures: number };

// The legend lists every SPC category, not just the ones on today's map, so the scale
// doesn't silently change meaning from one day to the next. Colours are SPC's own.
const OUTLOOK_CATEGORIES: Array<{ dn: number; label: string; name: string; fill: string; stroke: string }> = [
  { dn: 2, label: "TSTM", name: "Thunderstorms", fill: "#c1e9c1", stroke: "#55bb55" },
  { dn: 3, label: "MRGL", name: "Marginal", fill: "#66a366", stroke: "#005500" },
  { dn: 4, label: "SLGT", name: "Slight", fill: "#ffe066", stroke: "#ddaa00" },
  { dn: 5, label: "ENH", name: "Enhanced", fill: "#ffa366", stroke: "#ff6600" },
  { dn: 6, label: "MDT", name: "Moderate", fill: "#e06666", stroke: "#cc0000" },
  { dn: 8, label: "HIGH", name: "High", fill: "#ee99ee", stroke: "#cc00cc" },
];

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
    kind: "field", id: "apparentTemperature", title: "Maximum Apparent Temperature", nav: "Feels Like", group: "temperature", legend: "APPARENT TEMPERATURE (°F)", unit: "°", file: "max-apparent-temperature", decimals: 0, verticalLegend: true,
    stops: [{ value: -50, color: "#d31258" }, { value: -40, color: "#e12b8a" }, { value: -30, color: "#febee4" }, { value: -20, color: "#d4d5eb" }, { value: -10, color: "#9d9bc9" }, { value: 0, color: "#472c91" }, { value: 10, color: "#036eca" }, { value: 20, color: "#4fc7fd" }, { value: 30, color: "#9efefd" }, { value: 40, color: "#0a918b" }, { value: 50, color: "#0d7f34" }, { value: 60, color: "#84cb82" }, { value: 70, color: "#e4feb7" }, { value: 80, color: "#ffe49a" }, { value: 90, color: "#ffa435" }, { value: 100, color: "#fa442c" }, { value: 110, color: "#990428" }, { value: 120, color: "#641251" }],
  },
  {
    kind: "field", id: "temperature", title: "Maximum Temperature", nav: "Temperature", group: "temperature", legend: "TEMPERATURE (°F)", unit: "°", file: "max-temperature", decimals: 0, verticalLegend: true,
    stops: [{ value: -50, color: "#d31258" }, { value: -40, color: "#e12b8a" }, { value: -30, color: "#febee4" }, { value: -20, color: "#d4d5eb" }, { value: -10, color: "#9d9bc9" }, { value: 0, color: "#472c91" }, { value: 10, color: "#036eca" }, { value: 20, color: "#4fc7fd" }, { value: 30, color: "#9efefd" }, { value: 40, color: "#0a918b" }, { value: 50, color: "#0d7f34" }, { value: 60, color: "#84cb82" }, { value: 70, color: "#e4feb7" }, { value: 80, color: "#ffe49a" }, { value: 90, color: "#ffa435" }, { value: 100, color: "#fa442c" }, { value: 110, color: "#990428" }, { value: 120, color: "#641251" }],
  },
  {
    // Same ramp as the maximum, deliberately — a shared scale is what lets you read a
    // high and a low against each other instead of re-learning the colours.
    kind: "field", id: "minTemperature", title: "Minimum Temperature", nav: "Low Temp", group: "temperature", legend: "MINIMUM TEMPERATURE (°F)", unit: "°", file: "min-temperature", decimals: 0, verticalLegend: true,
    stops: [{ value: -50, color: "#d31258" }, { value: -40, color: "#e12b8a" }, { value: -30, color: "#febee4" }, { value: -20, color: "#d4d5eb" }, { value: -10, color: "#9d9bc9" }, { value: 0, color: "#472c91" }, { value: 10, color: "#036eca" }, { value: 20, color: "#4fc7fd" }, { value: 30, color: "#9efefd" }, { value: 40, color: "#0a918b" }, { value: 50, color: "#0d7f34" }, { value: 60, color: "#84cb82" }, { value: 70, color: "#e4feb7" }, { value: 80, color: "#ffe49a" }, { value: 90, color: "#ffa435" }, { value: 100, color: "#fa442c" }, { value: 110, color: "#990428" }, { value: 120, color: "#641251" }],
  },
  {
    kind: "field", id: "windGust", title: "Maximum Wind Gust", nav: "Wind Gust", group: "wind", legend: "WIND GUST (MPH)", unit: " mph", file: "max-wind-gust", decimals: 0, verticalLegend: true,
    stops: [{ value: 0, color: "#f7fbff" }, { value: 10, color: "#c6dbef" }, { value: 20, color: "#6baed6" }, { value: 30, color: "#31a354" }, { value: 40, color: "#fed976" }, { value: 50, color: "#fd8d3c" }, { value: 60, color: "#e31a1c" }, { value: 70, color: "#800026" }],
  },
  {
    // Shares the gust ramp on purpose — same scale is what lets you see where gusts run
    // well above the sustained wind rather than re-reading two different legends.
    kind: "field", id: "windSpeed", title: "Maximum Sustained Wind", nav: "Wind Speed", group: "wind", legend: "SUSTAINED WIND (MPH)", unit: " mph", file: "max-wind-speed", decimals: 0, verticalLegend: true,
    stops: [{ value: 0, color: "#f7fbff" }, { value: 10, color: "#c6dbef" }, { value: 20, color: "#6baed6" }, { value: 30, color: "#31a354" }, { value: 40, color: "#fed976" }, { value: 50, color: "#fd8d3c" }, { value: 60, color: "#e31a1c" }, { value: 70, color: "#800026" }],
  },
  {
    // Blue reads as clear sky, grey as overcast — the ramp matches what you'd see up.
    kind: "field", id: "skyCover", title: "Average Sky Cover", nav: "Sky Cover", group: "sky", legend: "SKY COVER (%)", unit: "%", file: "sky-cover", decimals: 0, fillAlpha: 205, verticalLegend: true,
    stops: [{ value: 0, color: "#2f7fbf" }, { value: 20, color: "#7cb8dd" }, { value: 40, color: "#bcd7e6" }, { value: 60, color: "#dcdcdc" }, { value: 80, color: "#a8a8a8" }, { value: 100, color: "#6e6e6e" }],
  },
  {
    // Dewpoint has well-known comfort bands: below ~55 dry, 60s sticky, 70+ oppressive.
    // Tan through green to deep teal tracks those rather than reusing the air-temp ramp.
    kind: "field", id: "dewpoint", title: "Maximum Dewpoint", nav: "Dewpoint", group: "sky", legend: "DEWPOINT (°F)", unit: "°", file: "max-dewpoint", decimals: 0, verticalLegend: true,
    stops: [{ value: 20, color: "#6b4a2f" }, { value: 30, color: "#a5793f" }, { value: 40, color: "#d4b483" }, { value: 50, color: "#e8e6c8" }, { value: 55, color: "#b5dd8f" }, { value: 60, color: "#66bb5c" }, { value: 65, color: "#2e9e48" }, { value: 70, color: "#15803d" }, { value: 75, color: "#0e6b6b" }, { value: 80, color: "#0b4f7a" }],
  },
  {
    kind: "field", id: "probabilityOfPrecipitation", title: "Maximum POP %", nav: "Rain Chance", group: "precipitation", legend: "PROBABILITY OF PRECIPITATION (%)", unit: "%", file: "max-pop", decimals: 0, fillAlpha: 235, verticalLegend: true,
    stops: [{ value: 0, color: "#ffffff" }, { value: 10, color: "#e5f5e0" }, { value: 20, color: "#a1d99b" }, { value: 40, color: "#41ab5d" }, { value: 60, color: "#2b8cbe" }, { value: 80, color: "#756bb1" }, { value: 100, color: "#54278f" }],
  },
  {
    kind: "field", id: "quantitativePrecipitation", title: "Total Precipitation Forecast", nav: "Rainfall", group: "precipitation", legend: "LIQUID PRECIPITATION (INCHES)", unit: " in", file: "total-precipitation", decimals: 2, fillAlpha: 235, verticalLegend: true,
    stops: [{ value: 0, color: "#ffffff" }, { value: 0.01, color: "#e5f5e0" }, { value: 0.1, color: "#a1d99b" }, { value: 0.25, color: "#41ab5d" }, { value: 0.5, color: "#ffffb2" }, { value: 1, color: "#fe9929" }, { value: 2, color: "#de2d26" }, { value: 3, color: "#756bb1" }],
  },
  {
    kind: "outlook", id: "convectiveOutlook", title: "SPC Convective Outlook", nav: "Severe Risk", group: "severe", legend: "CATEGORICAL RISK", file: "spc-convective-outlook",
  },
];

const PRODUCT_GROUPS: Array<{ id: ProductGroupId; title: string }> = [
  { id: "temperature", title: "Temperature & heat" },
  { id: "wind", title: "Wind" },
  { id: "sky", title: "Sky & moisture" },
  { id: "precipitation", title: "Precipitation" },
  { id: "severe", title: "Severe weather" },
];

const tileCache = new Map<string, Promise<ImageBitmap>>();
let headerMarkPromise: Promise<ImageBitmap | null> | null = null;

function loadHeaderMark() {
  if (!headerMarkPromise) {
    // Awaited by every commit, so it gets the same hang guard as the basemap tiles.
    headerMarkPromise = fetch("/weather-mark-white.png", { signal: AbortSignal.timeout(15_000) })
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

// Every canvas at a given extent shares these promises, so a basemap request that hangs
// would stall the whole page rather than one tile: `drawTiles` awaits them all, the
// render never resolves, and the publisher's readiness wait times out. Two guards —
// a hard timeout, and eviction on failure so a hung request is never cached and reused.
const TILE_TIMEOUT_MS = 15_000;

function loadTile(url: string) {
  const cached = tileCache.get(url);
  if (cached) return cached;
  const request = fetch(url, { signal: AbortSignal.timeout(TILE_TIMEOUT_MS) })
    .then(async (response) => {
      if (!response.ok) throw new Error("Basemap unavailable");
      return createImageBitmap(await response.blob());
    });
  request.catch(() => tileCache.delete(url));
  tileCache.set(url, request);
  return request;
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

function displayValue(value: number, spec: FieldProductSpec) {
  return `${value.toFixed(spec.decimals)}${spec.unit}`;
}

function legendValue(value: number, spec: FieldProductSpec) {
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

function stampLabel(value: string | number | Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(new Date(value)).toUpperCase();
}

function forecastHeaderLines(forecast: ForecastPayload, dayIndex: number, office: OfficeId) {
  const validDate = forecastDate(forecast.days[dayIndex].date);
  const validLabel = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  }).format(validDate).toUpperCase();
  return {
    valid: `VALID  ${validLabel} · 12:00 AM–11:59 PM ${timeZoneName(validDate)}`,
    issued: `NWS ${office} ISSUED  ${stampLabel(forecast.updatedAt)}`,
  };
}

/**
 * SPC's convective day runs 12Z–12Z and does not match the site's Eastern calendar day,
 * so an outlook is labelled from its own validity window rather than the day tab.
 */
function outlookHeaderLines(outlook: OutlookDay) {
  const valid = outlook.valid && outlook.expires
    ? `VALID  ${stampLabel(outlook.valid)} – ${stampLabel(outlook.expires)}`
    : `SPC DAY ${outlook.day} CONVECTIVE OUTLOOK`;
  const issued = outlook.issued
    ? `SPC ISSUED  ${stampLabel(outlook.issued)}${outlook.forecaster ? ` · ${outlook.forecaster.toUpperCase()}` : ""}`
    : "SPC OUTLOOK";
  return { valid, issued };
}

function drawForecastHeader(
  context: CanvasRenderingContext2D,
  title: string,
  lines: { valid: string; issued: string },
  headerMark: ImageBitmap | null,
) {
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
  context.fillText(title, 24, 39);

  if (headerMark) {
    // Keep the mark in the unused top-right corner, clear of the issued line.
    context.drawImage(headerMark, PLOT_WIDTH - 84, -2, 72, 72);
  }

  context.fillStyle = "#ffffff";
  context.font = `600 14px ${PLOT_FONT_FAMILY}`;
  context.fillText(lines.valid, 24, 74);
  context.textAlign = "right";
  context.fillText(lines.issued, PLOT_WIDTH - 24, 74);
  context.textAlign = "left";
}

/**
 * Everything both product kinds share: an offscreen 2× canvas, basemap tiles, and the
 * graticule, clipped to the plot. Returns the pieces each renderer needs to draw on top.
 */
async function beginMapCanvas(boundary: Boundary, office: OfficeId) {
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

  return { mapCanvas, context, plot, bounds, extent, projectPoint, width, height };
}

/** Reference layers drawn over whatever the product painted. */
function drawReferenceLayers(
  context: CanvasRenderingContext2D,
  counties: CountyBoundaries,
  states: CountyBoundaries,
  interstates: LineFeatures,
  boundary: Boundary,
  office: OfficeId,
  projectPoint: (lon: number, lat: number) => [number, number],
) {
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
}

/** The X handle in the bottom-right corner, identical on every product. */
function drawSignature(context: CanvasRenderingContext2D, width: number, height: number) {
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
}

/** Commit a finished map plus its header into the visible canvas. */
function commitPlot(canvas: HTMLCanvasElement, mapCanvas: HTMLCanvasElement, title: string, lines: { valid: string; issued: string }, headerMark: ImageBitmap | null) {
  canvas.width = PLOT_WIDTH * RENDER_SCALE;
  canvas.height = PLOT_HEIGHT * RENDER_SCALE;
  const output = canvas.getContext("2d")!;
  output.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
  output.imageSmoothingEnabled = true;
  output.imageSmoothingQuality = "high";
  drawForecastHeader(output, title, lines, headerMark);
  output.drawImage(mapCanvas, 0, HEADER_HEIGHT, PLOT_WIDTH, MAP_HEIGHT);
}

async function renderPlot(canvas: HTMLCanvasElement, forecast: ForecastPayload, boundary: Boundary, counties: CountyBoundaries, states: CountyBoundaries, interstates: LineFeatures, spec: FieldProductSpec, dayIndex: number, office: OfficeId) {
  const { mapCanvas, context, plot, extent, projectPoint, width, height } = await beginMapCanvas(boundary, office);

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

  drawReferenceLayers(context, counties, states, interstates, boundary, office, projectPoint);
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

  drawSignature(context, width, height);

  // Commit the completed map and header together. Rendering offscreen avoids
  // concurrent development-mode effects sharing one canvas drawing state.
  commitPlot(canvas, mapCanvas, spec.title, forecastHeaderLines(forecast, dayIndex, office), await loadHeaderMark());
}

function traceOutlookArea(context: CanvasRenderingContext2D, geometry: OutlookGeometry, projectPoint: (lon: number, lat: number) => [number, number]) {
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

/** Cheap bbox test — enough to decide whether any risk area reaches this office's map. */
function outlookTouchesFrame(area: OutlookArea, frame: Bounds) {
  const polygons = area.geometry.type === "Polygon" ? [area.geometry.coordinates] : area.geometry.coordinates;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const [lon, lat] of ring) {
        if (lon >= frame.west && lon <= frame.east && lat >= frame.south && lat <= frame.north) return true;
      }
    }
  }
  return false;
}

async function renderOutlookPlot(canvas: HTMLCanvasElement, outlook: OutlookDay | null, boundary: Boundary, counties: CountyBoundaries, states: CountyBoundaries, interstates: LineFeatures, spec: OutlookProductSpec, dayIndex: number, office: OfficeId) {
  const { mapCanvas, context, bounds, projectPoint, width, height } = await beginMapCanvas(boundary, office);

  // An unreachable SPC still has to produce a finished canvas. Leaving this one
  // unresolved would hold `data-render-state="rendering"` forever and stall the
  // publisher's readiness wait for every product on the page.
  if (!outlook) {
    drawReferenceLayers(context, counties, states, interstates, boundary, office, projectPoint);
    context.restore();
    context.textAlign = "center";
    context.font = `600 19px ${PLOT_FONT_FAMILY}`;
    outlinedText(context, "SPC OUTLOOK UNAVAILABLE", width / 2, height / 2 - 6, 4);
    context.textAlign = "left";
    drawSignature(context, width, height);
    commitPlot(canvas, mapCanvas, spec.title, {
      valid: `SPC DAY ${dayIndex + 1} CONVECTIVE OUTLOOK`,
      issued: "SOURCE UNAVAILABLE",
    }, await loadHeaderMark());
    return;
  }

  // Painted in DN order (the route sorts them), so a higher risk lands on top of the
  // lower-risk area that always encloses it.
  for (const area of outlook.features) {
    traceOutlookArea(context, area.geometry, projectPoint);
    context.fillStyle = area.fill;
    context.globalAlpha = 0.55;
    context.fill("evenodd");
    context.globalAlpha = 1;
    context.strokeStyle = area.stroke;
    context.lineWidth = 2.2;
    context.stroke();
  }

  drawReferenceLayers(context, counties, states, interstates, boundary, office, projectPoint);
  context.restore();

  // A national outlook usually has nothing over any one CWA. Say so, rather than
  // shipping what looks like a map that failed to load.
  const frame = frameBounds(bounds) as Bounds;
  if (!outlook.features.some((area) => outlookTouchesFrame(area, frame))) {
    context.textAlign = "center";
    context.font = `600 19px ${PLOT_FONT_FAMILY}`;
    outlinedText(context, "NO SEVERE WEATHER RISK AREA", width / 2, height / 2 - 6, 4);
    context.font = `600 13px ${PLOT_FONT_FAMILY}`;
    outlinedText(context, `for the ${office} forecast area`, width / 2, height / 2 + 15, 3);
    context.textAlign = "left";
  }

  // Discrete swatches, and always the full category list — a legend that changed with
  // the day would make two graphics look comparable when they aren't.
  const swatchX = 26;
  const swatchTop = 54;
  const rowHeight = 30;
  const swatchWidth = 34;
  const swatchHeight = 20;
  context.textAlign = "left";
  context.font = `600 12px ${PLOT_FONT_FAMILY}`;
  outlinedText(context, spec.legend, swatchX, swatchTop - 10, 3);
  OUTLOOK_CATEGORIES.forEach((category, index) => {
    const y = swatchTop + index * rowHeight;
    context.fillStyle = category.fill;
    context.globalAlpha = 0.9;
    context.fillRect(swatchX, y, swatchWidth, swatchHeight);
    context.globalAlpha = 1;
    context.strokeStyle = category.stroke;
    context.lineWidth = 1.6;
    context.strokeRect(swatchX, y, swatchWidth, swatchHeight);
    context.font = `600 12px ${PLOT_FONT_FAMILY}`;
    outlinedText(context, category.label, swatchX + swatchWidth + 8, y + 14, 3);
  });

  drawSignature(context, width, height);
  commitPlot(canvas, mapCanvas, spec.title, outlookHeaderLines(outlook), await loadHeaderMark());
}

function ForecastPlot({ spec, forecast, outlook, outlookPending, boundary, counties, states, interstates, dayIndex, office }: { spec: ProductSpec; forecast: ForecastPayload; outlook: OutlookDay | null; outlookPending: boolean; boundary: Boundary; counties: CountyBoundaries; states: CountyBoundaries; interstates: LineFeatures; dayIndex: number; office: Office }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!canvas.current) return;
    let active = true;
    setReady(false);
    const done = () => { if (active) setReady(true); };
    if (spec.kind === "outlook") {
      // Only hold the slot while SPC is genuinely still in flight. Once the fetch has
      // settled — success or failure — render something, or this canvas never reports
      // ready and the publisher waits on it until it times out.
      if (outlookPending) return;
      void renderOutlookPlot(canvas.current, outlook, boundary, counties, states, interstates, spec, dayIndex, office.id).then(done);
    } else {
      void renderPlot(canvas.current, forecast, boundary, counties, states, interstates, spec, dayIndex, office.id).then(done);
    }
    return () => { active = false; };
  }, [forecast, outlook, outlookPending, boundary, counties, states, interstates, spec, dayIndex, office]);

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

function PublishedForecastPlot({ spec, asset, dayIndex, eager, office, onAssetMissing }: { spec: ProductSpec; asset: PublishedForecastAsset; dayIndex: number; eager: boolean; office: Office; onAssetMissing: () => void }) {
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
        // Retention keeps only the newest release, so a manifest that is a publish out
        // of date points at deleted objects. Treat a failed image as "the manifest is
        // stale" and pull a fresh one rather than waiting out the refresh interval.
        onError={onAssetMissing}
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

// Exit is deliberately quicker than entry and not staggered — a cascade on the way out
// reads as lag. Must stay in step with the office-menu-out duration in globals.css.
const MENU_EXIT_MS = 130;

function OfficePicker({ office, onSelect }: { office: Office; onSelect: (office: Office) => void }) {
  const [open, setOpen] = useState(false);
  // The menu stays mounted through its exit animation, so "closing" is its own state.
  const [closing, setClosing] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const exitTimer = useRef<number | null>(null);
  const flattened = useMemo(() => REGIONS.flatMap((region) => region.offices), []);

  // One running index across every heading and option, so the open cascade sweeps the
  // list once rather than restarting at each region heading.
  const rowIndex = useMemo(() => {
    const rows = new Map<string, number>();
    let row = 0;
    for (const region of REGIONS) {
      rows.set(`region:${region.id}`, row);
      row += 1;
      for (const entry of region.offices) {
        rows.set(`office:${entry.id}`, row);
        row += 1;
      }
    }
    return rows;
  }, []);

  useEffect(() => () => { if (exitTimer.current) window.clearTimeout(exitTimer.current); }, []);

  const close = useCallback((restoreFocus: boolean) => {
    setClosing(true);
    if (exitTimer.current) window.clearTimeout(exitTimer.current);
    exitTimer.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, MENU_EXIT_MS);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  const openMenu = useCallback(() => {
    if (exitTimer.current) window.clearTimeout(exitTimer.current);
    setClosing(false);
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, close]);

  const move = useCallback((step: number) => {
    const index = flattened.findIndex((entry) => entry.id === office.id);
    const next = flattened[(index + step + flattened.length) % flattened.length];
    onSelect(next);
  }, [flattened, office, onSelect]);

  const expanded = open && !closing;

  // Arrow keys walk the whole list, crossing region headings as if they weren't there.
  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!expanded) {
        openMenu();
        return;
      }
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && expanded) {
      event.preventDefault();
      close(true);
    }
  }, [close, expanded, move, openMenu]);

  return (
    <div className={`office-picker${open ? " is-open" : ""}`} ref={container} onKeyDown={onKeyDown}>
      {/* Dims and blurs the page behind the free-standing pills. It sits inside the
          picker, so the outside-mousedown handler counts it as "inside" and won't fire —
          it closes the menu itself. Decorative and not focusable; Escape and a click on
          anything else still work. */}
      {open && (
        <div
          className={`office-scrim${closing ? " is-closing" : ""}`}
          aria-hidden="true"
          onMouseDown={() => close(false)}
        />
      )}
      <button
        ref={trigger}
        type="button"
        className="office-trigger"
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-label={`Forecast office: ${office.label}. Change office`}
        onClick={() => (expanded ? close(false) : openMenu())}
      >
        <span className="brand-mark">{office.id}</span>
        <span className="office-trigger-text">
          <strong>Forecast Graphics</strong>
          <em>{office.label}</em>
        </span>
        <span className="office-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          className={`office-menu${closing ? " is-closing" : ""}`}
          role="listbox"
          aria-label="Forecast office"
          tabIndex={-1}
        >
          {REGIONS.map((region) => (
            <div className="office-group" key={region.id}>
              <p style={{ "--row": rowIndex.get(`region:${region.id}`) } as React.CSSProperties}>{region.name}</p>
              {region.offices.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="option"
                  aria-selected={entry.id === office.id}
                  data-office={entry.id}
                  className={entry.id === office.id ? "is-active" : ""}
                  style={{ "--row": rowIndex.get(`office:${entry.id}`) } as React.CSSProperties}
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
  const [outlook, setOutlook] = useState<OutlookPayload | null>(null);
  // Distinct from "no outlook": tracks whether the SPC fetch has settled at all.
  const [outlookPending, setOutlookPending] = useState(true);
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
  // `manifestNonce` lets a failed image force an off-schedule refresh.
  const [manifestNonce, setManifestNonce] = useState(0);
  const lastManifestRecovery = useRef(0);

  // A broken published image almost always means the manifest is a publish behind and
  // the release it names has been pruned. Throttled so an asset that is genuinely gone
  // costs one refetch per 30s rather than a request per failed image.
  const recoverFromMissingAsset = useCallback(() => {
    const now = Date.now();
    if (now - lastManifestRecovery.current < 30_000) return;
    lastManifestRecovery.current = now;
    setManifestNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!PUBLISHED_ASSET_BASE_URL) return;
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`/api/published-forecast?ts=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) return;
        const manifest = await response.json() as PublishedForecastManifest;
        if (!active || (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2)) return;
        setPublishedForecast(manifest);
      } catch {
        // The live canvas path stays available when the manifest can't be read.
      }
    };
    void load();
    const refresh = window.setInterval(load, 15 * 60 * 1000);
    return () => { active = false; window.clearInterval(refresh); };
  }, [manifestNonce]);

  // SPC outlooks are national, so they load once and are shared by every office. Only
  // the live-canvas path needs them; published offices ship a baked PNG.
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/spc-outlook", { cache: "no-store", signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`SPC ${response.status}`);
        const payload = await response.json() as OutlookPayload;
        if (active) setOutlook(payload);
      } catch {
        // The severe product renders an "unavailable" card rather than never resolving.
      } finally {
        if (active) setOutlookPending(false);
      }
    };
    void load();
    const refresh = window.setInterval(load, 15 * 60 * 1000);
    return () => { active = false; window.clearInterval(refresh); };
  }, []);

  const publishedDays = publishedDaysFor(publishedForecast, office.id);
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
          <a className="is-active" href="#overview"><span>Overview</span><b>[{availableProducts.length}]</b></a>
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
          </header>

          {!hasPublishedOffice && !officeForecast && !error && <div className="gallery-message">Loading the latest NWS forecast plots…</div>}
          {!hasPublishedOffice && error && <div className="gallery-message">Forecast data is temporarily unavailable.</div>}
          {publishedDay && (
            <section className="forecast-gallery" aria-label={`Day ${dayIndex + 1} published forecast plots`} data-forecast-source="published" data-office={office.id}>
              {availableProducts.map((spec, index) => {
                const asset = publishedDay.products[spec.id];
                return asset ? <PublishedForecastPlot key={spec.id} spec={spec} asset={asset} dayIndex={dayIndex} eager={index === 0} office={office} onAssetMissing={recoverFromMissingAsset} /> : null;
              })}
            </section>
          )}
          {!hasPublishedOffice && officeForecast && boundary && counties && states && interstates && (
            <section className="forecast-gallery" aria-label={`Day ${dayIndex + 1} forecast plots`} data-office={office.id}>
              {availableProducts.map((spec) => (
                <ForecastPlot key={spec.id} spec={spec} forecast={officeForecast} outlook={outlook?.days.find((day) => day.day === dayIndex + 1) ?? null} outlookPending={outlookPending} boundary={boundary} counties={counties} states={states} interstates={interstates} dayIndex={dayIndex} office={office} />
              ))}
            </section>
          )}
        </div>
      </section>
    </main>
  );
}
