"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PLOT_FONT_FAMILY } from "../fonts";

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
  generatedAt: string;
  updatedAt: string;
  days: Array<{ date: string; label: string; shortLabel: string }>;
  points: ForecastPoint[];
  failures: number;
};
type Boundary = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "MultiPolygon"; coordinates: number[][][][] };
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
const PLOT_WIDTH = 900;
const PLOT_HEIGHT = 760;
const FORECAST_DAYS = [0, 1, 2];
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
    id: "probabilityOfPrecipitation", title: "Maximum Probability of Precipitation", nav: "Rain Chance", group: "precipitation", legend: "PROBABILITY OF PRECIPITATION (%)", unit: "%", file: "max-pop", decimals: 0, fillAlpha: 235, verticalLegend: true,
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

function boundaryBounds(boundary: Boundary): Bounds {
  const positions = boundary.features[0].geometry.coordinates.flat(2);
  const lons = positions.map((position) => position[0]);
  const lats = positions.map((position) => position[1]);
  return { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
}

function worldPoint(lon: number, lat: number, zoom: number) {
  const scale = 256 * 2 ** zoom;
  const sin = Math.sin(lat * Math.PI / 180);
  return { x: ((lon + 180) / 360) * scale, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale };
}

function inverseWorld(x: number, y: number, zoom: number) {
  const scale = 256 * 2 ** zoom;
  const lon = x / scale * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y / scale;
  return { lon, lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) };
}

function plotExtent(bounds: Bounds, width: number, height: number, zoom = 7): MapExtent {
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

function project(lon: number, lat: number, extent: MapExtent, x: number, y: number, width: number, height: number): [number, number] {
  const point = worldPoint(lon, lat, extent.zoom);
  return [x + (point.x - extent.left) / (extent.right - extent.left) * width, y + (point.y - extent.top) / (extent.bottom - extent.top) * height];
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

function traceBoundary(context: CanvasRenderingContext2D, boundary: Boundary, projectPoint: (lon: number, lat: number) => [number, number]) {
  context.beginPath();
  for (const feature of boundary.features) {
    for (const polygon of feature.geometry.coordinates) {
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

async function drawTiles(context: CanvasRenderingContext2D, extent: MapExtent, x: number, y: number, width: number, height: number) {
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

async function renderPlot(canvas: HTMLCanvasElement, forecast: ForecastPayload, boundary: Boundary, counties: CountyBoundaries, states: CountyBoundaries, interstates: LineFeatures, spec: ProductSpec, dayIndex: number) {
  const width = PLOT_WIDTH;
  const height = PLOT_HEIGHT;
  canvas.width = width * RENDER_SCALE;
  canvas.height = height * RENDER_SCALE;
  const context = canvas.getContext("2d")!;
  context.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
  context.lineJoin = "round";
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  if (document.fonts?.ready) await document.fonts.ready;

  // Work in logical pixels while the backing canvas renders at 2× resolution.
  const plot = { x: 0, y: 0, width, height };
  context.fillStyle = "#dfe8ee";
  context.fillRect(plot.x, plot.y, plot.width, plot.height);
  const bounds = boundaryBounds(boundary);
  const extent = plotExtent(bounds, plot.width, plot.height);
  const projectPoint = (lon: number, lat: number) => project(lon, lat, extent, plot.x, plot.y, plot.width, plot.height);
  await drawTiles(context, extent, plot.x, plot.y, plot.width, plot.height);

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
  raster.height = PLOT_HEIGHT;
  const rasterContext = raster.getContext("2d")!;
  const image = rasterContext.createImageData(raster.width, raster.height);
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const worldX = extent.left + x / (raster.width - 1) * (extent.right - extent.left);
      const worldY = extent.top + y / (raster.height - 1) * (extent.bottom - extent.top);
      const coordinate = inverseWorld(worldX, worldY, extent.zoom);
      const value = sampleField(fieldPoints, spec.id, dayIndex, coordinate.lon, coordinate.lat);
      const [red, green, blue] = colorFor(value, spec.stops);
      const offset = (y * raster.width + x) * 4;
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = fillAlpha;
    }
  }
  rasterContext.putImageData(image, 0, 0);
  context.save();
  traceBoundary(context, boundary, projectPoint);
  context.clip("evenodd");
  context.drawImage(raster, plot.x, plot.y, plot.width, plot.height);
  context.restore();

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

  traceBoundary(context, boundary, projectPoint);
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
}

function ForecastPlot({ spec, forecast, boundary, counties, states, interstates, dayIndex }: { spec: ProductSpec; forecast: ForecastPayload; boundary: Boundary; counties: CountyBoundaries; states: CountyBoundaries; interstates: LineFeatures; dayIndex: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!canvas.current) return;
    let active = true;
    setReady(false);
    void renderPlot(canvas.current, forecast, boundary, counties, states, interstates, spec, dayIndex).then(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, [forecast, boundary, counties, states, interstates, spec, dayIndex]);

  const download = useCallback(() => {
    if (!canvas.current || !ready) return;
    canvas.current.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `phi-${spec.file}-${forecast.days[dayIndex]?.date || `day-${dayIndex + 1}`}.png`;
      link.click();
      URL.revokeObjectURL(link.href);
    }, "image/png");
  }, [forecast, ready, spec, dayIndex]);

  return (
    <article className="forecast-product" id={`product-${spec.id}`}>
      <div className="product-bar">
        <h3>{spec.title}</h3>
        <button onClick={download} disabled={!ready}>{ready ? "Download PNG ↓" : "Rendering…"}</button>
      </div>
      <canvas ref={canvas} className="forecast-canvas" role="img" aria-label={`${spec.title}, Day ${dayIndex + 1}, for the PHI forecast area`} />
    </article>
  );
}

export function ForecastGraphic() {
  const [forecast, setForecast] = useState<ForecastPayload | null>(null);
  const [boundary, setBoundary] = useState<Boundary | null>(null);
  const [counties, setCounties] = useState<CountyBoundaries | null>(null);
  const [states, setStates] = useState<CountyBoundaries | null>(null);
  const [interstates, setInterstates] = useState<LineFeatures | null>(null);
  const [dayIndex, setDayIndex] = useState(0);
  const [error, setError] = useState(false);
  const loadData = useCallback(async () => {
    try {
      const [forecastResponse, boundaryResponse, countyResponse, stateResponse, interstateResponse] = await Promise.all([
        fetch("/api/forecast", { cache: "no-store" }),
        fetch("/phi-cwa.geojson"),
        fetch("/counties.geojson"),
        fetch("/states.geojson"),
        fetch("/interstates.geojson"),
      ]);
      if (!forecastResponse.ok || !boundaryResponse.ok || !countyResponse.ok || !stateResponse.ok || !interstateResponse.ok) throw new Error("Data unavailable");
      setForecast(await forecastResponse.json() as ForecastPayload);
      setBoundary(await boundaryResponse.json() as Boundary);
      setCounties(await countyResponse.json() as CountyBoundaries);
      setStates(await stateResponse.json() as CountyBoundaries);
      setInterstates(await interstateResponse.json() as LineFeatures);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    void loadData();
    const refresh = window.setInterval(loadData, 15 * 60 * 1000);
    return () => window.clearInterval(refresh);
  }, [loadData]);
  const availableProducts = useMemo(() => PRODUCTS, []);
  return (
    <main className="app-shell">
      <aside className="catalog-sidebar">
        <a className="catalog-brand" href="https://www.weather.gov/phi/" target="_blank" rel="noreferrer">
          <span className="brand-mark">PHI</span>
          <span><strong>Forecast Graphics</strong></span>
        </a>
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
          <span className="live-status"><i /> AUTO-UPDATING</span>
          <p>Source: National Weather Service<br />Forecast grids refresh every 15 minutes.</p>
        </footer>
      </aside>

      <section className="catalog-workspace">
        <header className="workspace-topbar">
          <div className="breadcrumbs">
            <span>Forecast catalogue</span>
            <i>/</i>
            <nav className="day-switcher" aria-label="Forecast day">
              {FORECAST_DAYS.map((index) => (
                <button key={index} type="button" className={dayIndex === index ? "is-active" : ""} aria-pressed={dayIndex === index} onClick={() => setDayIndex(index)}>
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

          {!forecast && !error && <div className="gallery-message">Rendering the latest NWS forecast plots…</div>}
          {error && <div className="gallery-message">Forecast data is temporarily unavailable.</div>}
          {forecast && boundary && counties && states && interstates && (
            <section className="forecast-gallery" aria-label={`Day ${dayIndex + 1} forecast plots`}>
              {availableProducts.map((spec) => (
                <ForecastPlot key={spec.id} spec={spec} forecast={forecast} boundary={boundary} counties={counties} states={states} interstates={interstates} dayIndex={dayIndex} />
              ))}
            </section>
          )}
        </div>
      </section>
    </main>
  );
}
