"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
type Bounds = { west: number; south: number; east: number; north: number };
type MapExtent = { left: number; top: number; right: number; bottom: number; zoom: number };
type ColorStop = { value: number; color: string };
type ProductSpec = {
  id: ProductId;
  title: string;
  legend: string;
  unit: string;
  file: string;
  decimals: number;
  stops: ColorStop[];
  verticalLegend?: boolean;
};

const DAY = 0;
const PRODUCTS: ProductSpec[] = [
  {
    id: "apparentTemperature", title: "Maximum Apparent Temperature", legend: "APPARENT TEMPERATURE (°F)", unit: "°", file: "max-apparent-temperature", decimals: 0, verticalLegend: true,
    stops: [{ value: -50, color: "#d31258" }, { value: -40, color: "#e12b8a" }, { value: -30, color: "#febee4" }, { value: -20, color: "#d4d5eb" }, { value: -10, color: "#9d9bc9" }, { value: 0, color: "#472c91" }, { value: 10, color: "#036eca" }, { value: 20, color: "#4fc7fd" }, { value: 30, color: "#9efefd" }, { value: 40, color: "#0a918b" }, { value: 50, color: "#0d7f34" }, { value: 60, color: "#84cb82" }, { value: 70, color: "#e4feb7" }, { value: 80, color: "#ffe49a" }, { value: 90, color: "#ffa435" }, { value: 100, color: "#fa442c" }, { value: 110, color: "#990428" }, { value: 120, color: "#641251" }],
  },
  {
    id: "temperature", title: "Maximum Temperature", legend: "TEMPERATURE (°F)", unit: "°", file: "max-temperature", decimals: 0, verticalLegend: true,
    stops: [{ value: -50, color: "#d31258" }, { value: -40, color: "#e12b8a" }, { value: -30, color: "#febee4" }, { value: -20, color: "#d4d5eb" }, { value: -10, color: "#9d9bc9" }, { value: 0, color: "#472c91" }, { value: 10, color: "#036eca" }, { value: 20, color: "#4fc7fd" }, { value: 30, color: "#9efefd" }, { value: 40, color: "#0a918b" }, { value: 50, color: "#0d7f34" }, { value: 60, color: "#84cb82" }, { value: 70, color: "#e4feb7" }, { value: 80, color: "#ffe49a" }, { value: 90, color: "#ffa435" }, { value: 100, color: "#fa442c" }, { value: 110, color: "#990428" }, { value: 120, color: "#641251" }],
  },
  {
    id: "windGust", title: "Maximum Wind Gust", legend: "WIND GUST (MPH)", unit: " mph", file: "max-wind-gust", decimals: 0,
    stops: [{ value: 0, color: "#f7fbff" }, { value: 10, color: "#c6dbef" }, { value: 20, color: "#6baed6" }, { value: 30, color: "#31a354" }, { value: 40, color: "#fed976" }, { value: 50, color: "#fd8d3c" }, { value: 60, color: "#e31a1c" }, { value: 70, color: "#800026" }],
  },
  {
    id: "probabilityOfPrecipitation", title: "Maximum Probability of Precipitation", legend: "PROBABILITY OF PRECIPITATION (%)", unit: "%", file: "max-pop", decimals: 0,
    stops: [{ value: 0, color: "#ffffff" }, { value: 10, color: "#e5f5e0" }, { value: 20, color: "#a1d99b" }, { value: 40, color: "#41ab5d" }, { value: 60, color: "#2b8cbe" }, { value: 80, color: "#756bb1" }, { value: 100, color: "#54278f" }],
  },
  {
    id: "quantitativePrecipitation", title: "Total Precipitation Forecast", legend: "LIQUID PRECIPITATION (INCHES)", unit: " in", file: "total-precipitation", decimals: 2,
    stops: [{ value: 0, color: "#ffffff" }, { value: 0.01, color: "#e5f5e0" }, { value: 0.1, color: "#a1d99b" }, { value: 0.25, color: "#41ab5d" }, { value: 0.5, color: "#ffffb2" }, { value: 1, color: "#fe9929" }, { value: 2, color: "#de2d26" }, { value: 3, color: "#756bb1" }],
  },
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
  let spanX = (bottomRight.x - topLeft.x) * 1.1;
  let spanY = (bottomRight.y - topLeft.y) * 1.08;
  if (spanX / spanY < width / height) spanX = spanY * width / height;
  else spanY = spanX * height / width;
  return { left: centerX - spanX / 2, right: centerX + spanX / 2, top: centerY - spanY / 2, bottom: centerY + spanY / 2, zoom };
}

function project(lon: number, lat: number, extent: MapExtent, x: number, y: number, width: number, height: number): [number, number] {
  const point = worldPoint(lon, lat, extent.zoom);
  return [x + (point.x - extent.left) / (extent.right - extent.left) * width, y + (point.y - extent.top) / (extent.bottom - extent.top) * height];
}

function traceBoundary(context: CanvasRenderingContext2D, boundary: Boundary, projectPoint: (lon: number, lat: number) => [number, number]) {
  context.beginPath();
  for (const polygon of boundary.features[0].geometry.coordinates) {
    for (const ring of polygon) {
      ring.forEach((position, index) => {
        const [x, y] = projectPoint(position[0], position[1]);
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      });
      context.closePath();
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

function interpolate(points: ForecastPoint[], product: ProductId, lon: number, lat: number) {
  let weighted = 0;
  let weights = 0;
  for (const point of points) {
    const value = point.metrics[product][DAY];
    if (value === null) continue;
    const dx = (lon - point.lon) * Math.cos(lat * Math.PI / 180);
    const dy = lat - point.lat;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared < 0.00001) return value;
    const weight = 1 / Math.pow(distanceSquared + 0.003, 1.15);
    weighted += value * weight;
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
        const url = `https://a.basemaps.cartocdn.com/light_all/${extent.zoom}/${tileX}/${tileY}.png`;
        const bitmap = await loadTile(url);
        context.drawImage(bitmap, x + (tileX * 256 - extent.left) * scale, y + (tileY * 256 - extent.top) * scale, 256 * scale, 256 * scale);
      } catch {
        // The forecast remains usable over the neutral fallback background.
      }
    }),
  ));
}

function formatTime(value: string) {
  if (!value) return "Awaiting NWS update";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: "America/New_York" }).format(new Date(value));
}

function displayValue(value: number, spec: ProductSpec) {
  return `${value.toFixed(spec.decimals)}${spec.unit}`;
}

async function renderPlot(canvas: HTMLCanvasElement, forecast: ForecastPayload, boundary: Boundary, spec: ProductSpec) {
  const width = 1200;
  const height = 800;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#111827";
  context.font = "700 29px Arial, sans-serif";
  context.fillText(spec.title, 30, 37);
  context.textAlign = "right";
  context.font = "700 16px Arial, sans-serif";
  context.fillText(forecast.days[DAY]?.label ?? "Day 1", 1170, 29);
  context.font = "12px Arial, sans-serif";
  context.fillStyle = "#4b5563";
  context.fillText(`NWS issued ${formatTime(forecast.updatedAt || forecast.generatedAt)}`, 1170, 49);
  context.textAlign = "left";

  const plot = { x: 30, y: 65, width: 1140, height: 670 };
  context.fillStyle = "#e6f1f5";
  context.fillRect(plot.x, plot.y, plot.width, plot.height);
  const bounds = boundaryBounds(boundary);
  const extent = plotExtent(bounds, plot.width, plot.height);
  await drawTiles(context, extent, plot.x, plot.y, plot.width, plot.height);

  context.save();
  context.beginPath();
  context.rect(plot.x, plot.y, plot.width, plot.height);
  context.clip();
  context.strokeStyle = "#64748b";
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

  const points = forecast.points.filter((point) => point.metrics[spec.id][DAY] !== null);
  const raster = document.createElement("canvas");
  raster.width = 760;
  raster.height = 450;
  const rasterContext = raster.getContext("2d")!;
  const image = rasterContext.createImageData(raster.width, raster.height);
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const worldX = extent.left + x / (raster.width - 1) * (extent.right - extent.left);
      const worldY = extent.top + y / (raster.height - 1) * (extent.bottom - extent.top);
      const coordinate = inverseWorld(worldX, worldY, extent.zoom);
      const [red, green, blue] = colorFor(interpolate(points, spec.id, coordinate.lon, coordinate.lat), spec.stops);
      const offset = (y * raster.width + x) * 4;
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = 210;
    }
  }
  rasterContext.putImageData(image, 0, 0);
  rasterContext.globalCompositeOperation = "destination-in";
  traceBoundary(rasterContext, boundary, (lon, lat) => {
    const point = worldPoint(lon, lat, extent.zoom);
    return [(point.x - extent.left) / (extent.right - extent.left) * raster.width, (point.y - extent.top) / (extent.bottom - extent.top) * raster.height];
  });
  rasterContext.fillStyle = "#fff";
  rasterContext.fill("evenodd");
  context.drawImage(raster, plot.x, plot.y, plot.width, plot.height);

  traceBoundary(context, boundary, (lon, lat) => project(lon, lat, extent, plot.x, plot.y, plot.width, plot.height));
  context.strokeStyle = "#102a43";
  context.lineWidth = 3;
  context.stroke();
  context.restore();

  context.textAlign = "center";
  for (const point of points.filter((item) => item.label)) {
    const value = point.metrics[spec.id][DAY];
    if (value === null) continue;
    const [x, y] = project(point.lon, point.lat, extent, plot.x, plot.y, plot.width, plot.height);
    const formatted = displayValue(value, spec);
    context.font = "700 15px Arial, sans-serif";
    context.fillStyle = "#ffffff";
    context.strokeStyle = "#111827";
    context.lineWidth = 4;
    context.strokeText(formatted, x, y - 10);
    context.fillText(formatted, x, y - 10);
    context.beginPath(); context.arc(x, y, 3.5, 0, Math.PI * 2); context.fillStyle = "#dc2626"; context.fill(); context.strokeStyle = "#fff"; context.lineWidth = 1.5; context.stroke();
    context.font = "700 9px Arial, sans-serif";
    context.fillStyle = "#fff"; context.strokeStyle = "#111827"; context.lineWidth = 3;
    context.strokeText(point.name, x, y + 13); context.fillText(point.name, x, y + 13);
  }
  context.textAlign = "left";

  if (spec.verticalLegend) {
    const panelX = 43;
    const panelY = 91;
    const panelWidth = 110;
    const panelHeight = 612;
    const barX = 72;
    const barY = 112;
    const barWidth = 22;
    const arrow = 10;
    const colorHeight = 566;
    const bandHeight = colorHeight / spec.stops.length;
    context.fillStyle = "#ffffffe8";
    context.fillRect(panelX, panelY, panelWidth, panelHeight);
    context.save();
    context.translate(57, panelY + panelHeight / 2);
    context.rotate(-Math.PI / 2);
    context.textAlign = "center";
    context.fillStyle = "#111827";
    context.font = "700 10px Arial, sans-serif";
    context.fillText(spec.legend, 0, 0);
    context.restore();
    const reversed = [...spec.stops].reverse();
    reversed.forEach((stop, index) => {
      context.fillStyle = stop.color;
      context.fillRect(barX, barY + arrow + index * bandHeight, barWidth, bandHeight + 0.5);
    });
    context.fillStyle = reversed[0].color;
    context.beginPath(); context.moveTo(barX, barY + arrow); context.lineTo(barX + barWidth / 2, barY); context.lineTo(barX + barWidth, barY + arrow); context.closePath(); context.fill();
    context.fillStyle = reversed.at(-1)!.color;
    const bottomY = barY + arrow + colorHeight;
    context.beginPath(); context.moveTo(barX, bottomY); context.lineTo(barX + barWidth / 2, bottomY + arrow); context.lineTo(barX + barWidth, bottomY); context.closePath(); context.fill();
    context.textAlign = "left";
    context.font = "700 9px Arial, sans-serif";
    context.fillStyle = "#111827";
    reversed.forEach((stop, index) => context.fillText(`${stop.value}°`, barX + barWidth + 7, barY + arrow + (index + 0.64) * bandHeight));
  } else {
    const legendX = 52;
    const legendY = 675;
    const legendWidth = 315;
    context.fillStyle = "#ffffffdf";
    context.fillRect(42, 627, 340, 88);
    context.fillStyle = "#111827";
    context.font = "700 10px Arial, sans-serif";
    context.fillText(spec.legend, legendX, 650);
    const gradient = context.createLinearGradient(legendX, 0, legendX + legendWidth, 0);
    spec.stops.forEach((stop, index) => gradient.addColorStop(index / (spec.stops.length - 1), stop.color));
    context.fillStyle = gradient;
    context.fillRect(legendX, legendY, legendWidth, 12);
    context.font = "9px Arial, sans-serif";
    context.fillStyle = "#111827";
    spec.stops.forEach((stop, index) => context.fillText(String(stop.value), legendX + index / (spec.stops.length - 1) * legendWidth - 4, 700));
  }
  context.strokeStyle = "#111827";
  context.lineWidth = 1.5;
  context.strokeRect(plot.x, plot.y, plot.width, plot.height);

  context.fillStyle = "#4b5563";
  context.font = "10px Arial, sans-serif";
  context.fillText(`Forecast: NOAA / National Weather Service · ${points.length} PHI grid samples · Boundary: NWS CWA · Basemap: OpenStreetMap / CARTO`, 30, 763);
  context.textAlign = "right";
  context.font = "700 10px Arial, sans-serif";
  context.fillText("PHI FORECAST GRAPHICS", 1170, 763);
}

function ForecastPlot({ spec, forecast, boundary }: { spec: ProductSpec; forecast: ForecastPayload; boundary: Boundary }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!canvas.current) return;
    let active = true;
    setReady(false);
    void renderPlot(canvas.current, forecast, boundary, spec).then(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, [forecast, boundary, spec]);

  const download = useCallback(() => {
    if (!canvas.current || !ready) return;
    canvas.current.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `phi-${spec.file}-${forecast.days[DAY]?.date || "day-1"}.png`;
      link.click();
      URL.revokeObjectURL(link.href);
    }, "image/png");
  }, [forecast, ready, spec]);

  return (
    <article className="forecast-product">
      <div className="product-bar"><div><span>DAY 1 FORECAST</span><strong>{spec.title}</strong></div><button onClick={download} disabled={!ready}>{ready ? "Download PNG" : "Rendering…"}</button></div>
      <canvas ref={canvas} className="forecast-canvas" role="img" aria-label={`${spec.title} forecast plot for the NWS Philadelphia and Mount Holly forecast area`} />
    </article>
  );
}

export function ForecastGraphic() {
  const [forecast, setForecast] = useState<ForecastPayload | null>(null);
  const [boundary, setBoundary] = useState<Boundary | null>(null);
  const [error, setError] = useState(false);
  const loadData = useCallback(async () => {
    try {
      const [forecastResponse, boundaryResponse] = await Promise.all([fetch("/api/forecast", { cache: "no-store" }), fetch("/phi-cwa.geojson")]);
      if (!forecastResponse.ok || !boundaryResponse.ok) throw new Error("Data unavailable");
      setForecast(await forecastResponse.json() as ForecastPayload);
      setBoundary(await boundaryResponse.json() as Boundary);
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
      <nav className="site-nav">
        <a className="site-brand" href="https://www.weather.gov/phi/" target="_blank" rel="noreferrer"><span>PHI</span> FORECAST GRAPHICS</a>
        <span className="live-status"><i /> LIVE NWS DATA · REFRESHES EVERY 15 MIN</span>
      </nav>
      <header className="gallery-header">
        <div><p>PHILADELPHIA / MOUNT HOLLY</p><h1>Day 1 Forecast Graphics</h1></div>
        <div><strong>{forecast?.days[DAY]?.label ?? "Latest forecast"}</strong><span>NWS issued {formatTime(forecast?.updatedAt || forecast?.generatedAt || "")}</span></div>
      </header>
      {!forecast && !error && <div className="gallery-message">Rendering the latest NWS forecast plots…</div>}
      {error && <div className="gallery-message">Forecast data is temporarily unavailable.</div>}
      {forecast && boundary && <section className="forecast-gallery">{availableProducts.map((spec) => <ForecastPlot key={spec.id} spec={spec} forecast={forecast} boundary={boundary} />)}</section>}
    </main>
  );
}
