"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type ForecastPoint = {
  id: string;
  name: string;
  state: string;
  lat: number;
  lon: number;
  values: Array<number | null>;
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

const DAY = 0;
const COLOR_STOPS = [
  { value: 70, color: "#313695" },
  { value: 75, color: "#4575b4" },
  { value: 80, color: "#74add1" },
  { value: 85, color: "#abd9e9" },
  { value: 90, color: "#fee090" },
  { value: 95, color: "#fdae61" },
  { value: 100, color: "#f46d43" },
  { value: 105, color: "#d73027" },
  { value: 110, color: "#a50026" },
];

function hexToRgb(hex: string) {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

function colorFor(value: number) {
  if (value <= COLOR_STOPS[0].value) return hexToRgb(COLOR_STOPS[0].color);
  if (value >= COLOR_STOPS.at(-1)!.value) return hexToRgb(COLOR_STOPS.at(-1)!.color);
  const upperIndex = COLOR_STOPS.findIndex((stop) => value <= stop.value);
  const lower = COLOR_STOPS[upperIndex - 1];
  const upper = COLOR_STOPS[upperIndex];
  const amount = (value - lower.value) / (upper.value - lower.value);
  const a = hexToRgb(lower.color);
  const b = hexToRgb(upper.color);
  return a.map((channel, index) => Math.round(channel + (b[index] - channel) * amount));
}

function boundaryBounds(boundary: Boundary): Bounds {
  const positions = boundary.features[0].geometry.coordinates.flat(2);
  const lons = positions.map((position) => position[0]);
  const lats = positions.map((position) => position[1]);
  return { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
}

function traceBoundary(
  context: CanvasRenderingContext2D,
  boundary: Boundary,
  project: (lon: number, lat: number) => [number, number],
) {
  context.beginPath();
  for (const polygon of boundary.features[0].geometry.coordinates) {
    for (const ring of polygon) {
      ring.forEach((position, index) => {
        const [x, y] = project(position[0], position[1]);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.closePath();
    }
  }
}

function interpolate(points: ForecastPoint[], lon: number, lat: number) {
  let weighted = 0;
  let weights = 0;
  for (const point of points) {
    const value = point.values[DAY];
    if (value === null) continue;
    const dx = (lon - point.lon) * Math.cos(lat * Math.PI / 180);
    const dy = lat - point.lat;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared < 0.00001) return value;
    const weight = 1 / Math.pow(distanceSquared + 0.003, 1.15);
    weighted += value * weight;
    weights += weight;
  }
  return weighted / weights;
}

function makeLinearHeatCanvas(boundary: Boundary, points: ForecastPoint[], bounds: Bounds) {
  const canvas = document.createElement("canvas");
  canvas.width = 540;
  canvas.height = 720;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(canvas.width, canvas.height);
  const zoom = 7;
  const topLeft = worldPoint(bounds.west, bounds.north, zoom);
  const bottomRight = worldPoint(bounds.east, bounds.south, zoom);
  for (let y = 0; y < canvas.height; y += 1) {
    const worldY = topLeft.y + (y / (canvas.height - 1)) * (bottomRight.y - topLeft.y);
    for (let x = 0; x < canvas.width; x += 1) {
      const worldX = topLeft.x + (x / (canvas.width - 1)) * (bottomRight.x - topLeft.x);
      const coordinate = inverseWorld(worldX, worldY, zoom);
      const value = interpolate(points, coordinate.lon, coordinate.lat);
      const [red, green, blue] = colorFor(value);
      const offset = (y * canvas.width + x) * 4;
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = 218;
    }
  }
  context.putImageData(image, 0, 0);
  context.globalCompositeOperation = "destination-in";
  traceBoundary(context, boundary, (lon, lat) => {
    const point = worldPoint(lon, lat, zoom);
    return [
      ((point.x - topLeft.x) / (bottomRight.x - topLeft.x)) * canvas.width,
      ((point.y - topLeft.y) / (bottomRight.y - topLeft.y)) * canvas.height,
    ];
  });
  context.fillStyle = "#fff";
  context.fill("evenodd");
  return canvas;
}

function worldPoint(lon: number, lat: number, zoom: number) {
  const scale = 256 * 2 ** zoom;
  const sin = Math.sin(lat * Math.PI / 180);
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

function exportExtent(bounds: Bounds, width: number, height: number, zoom = 7): MapExtent {
  const topLeft = worldPoint(bounds.west, bounds.north, zoom);
  const bottomRight = worldPoint(bounds.east, bounds.south, zoom);
  const centerX = (topLeft.x + bottomRight.x) / 2;
  const centerY = (topLeft.y + bottomRight.y) / 2;
  let spanX = (bottomRight.x - topLeft.x) * 1.12;
  let spanY = (bottomRight.y - topLeft.y) * 1.08;
  if (spanX / spanY < width / height) spanX = spanY * width / height;
  else spanY = spanX * height / width;
  return { left: centerX - spanX / 2, right: centerX + spanX / 2, top: centerY - spanY / 2, bottom: centerY + spanY / 2, zoom };
}

function projectToPlot(lon: number, lat: number, extent: MapExtent, x: number, y: number, width: number, height: number): [number, number] {
  const point = worldPoint(lon, lat, extent.zoom);
  return [x + ((point.x - extent.left) / (extent.right - extent.left)) * width, y + ((point.y - extent.top) / (extent.bottom - extent.top)) * height];
}

function inverseWorld(x: number, y: number, zoom: number) {
  const scale = 256 * 2 ** zoom;
  const lon = x / scale * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y / scale;
  return { lon, lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) };
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
        const response = await fetch(`https://a.basemaps.cartocdn.com/light_all/${extent.zoom}/${tileX}/${tileY}.png`);
        const bitmap = await createImageBitmap(await response.blob());
        context.drawImage(bitmap, x + (tileX * 256 - extent.left) * scale, y + (tileY * 256 - extent.top) * scale, 256 * scale, 256 * scale);
      } catch {
        // The plot remains usable with the neutral fallback basemap.
      }
    }),
  ));
}

function formatTime(value: string) {
  if (!value) return "Awaiting NWS update";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: "America/New_York" }).format(new Date(value));
}

export function ForecastGraphic() {
  const mapElement = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<import("leaflet").Map | null>(null);
  const dataLayers = useRef<import("leaflet").Layer[]>([]);
  const [forecast, setForecast] = useState<ForecastPayload | null>(null);
  const [boundary, setBoundary] = useState<Boundary | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [error, setError] = useState(false);
  const [exporting, setExporting] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [forecastResponse, boundaryResponse] = await Promise.all([
        fetch("/api/forecast", { cache: "no-store" }),
        fetch("/phi-cwa.geojson"),
      ]);
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

  useEffect(() => {
    if (!mapElement.current || mapInstance.current) return;
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled || !mapElement.current) return;
      const map = L.map(mapElement.current, { center: [39.8, -75], zoom: 7, minZoom: 6, maxZoom: 10, zoomControl: false, attributionControl: false });
      L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { subdomains: "abcd", maxZoom: 20 }).addTo(map);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.control.attribution({ position: "bottomleft", prefix: false }).addAttribution("© OpenStreetMap · © CARTO").addTo(map);
      mapInstance.current = map;
      setMapReady(true);
    });
    return () => {
      cancelled = true;
      mapInstance.current?.remove();
      mapInstance.current = null;
    };
  }, []);

  const points = useMemo(() => forecast?.points.filter((point) => point.values[DAY] !== null) ?? [], [forecast]);

  useEffect(() => {
    const map = mapInstance.current;
    if (!map || !boundary || !points.length) return;
    void import("leaflet").then((L) => {
      dataLayers.current.forEach((layer) => layer.remove());
      dataLayers.current = [];
      const bounds = boundaryBounds(boundary);
      for (let lon = Math.ceil(bounds.west * 2) / 2; lon <= bounds.east; lon += 0.5) {
        const line = L.polyline([[bounds.south, lon], [bounds.north, lon]], { color: "#5a6470", weight: 1, opacity: 0.26, dashArray: "2 4", interactive: false }).addTo(map);
        dataLayers.current.push(line);
      }
      for (let lat = Math.ceil(bounds.south * 2) / 2; lat <= bounds.north; lat += 0.5) {
        const line = L.polyline([[lat, bounds.west], [lat, bounds.east]], { color: "#5a6470", weight: 1, opacity: 0.26, dashArray: "2 4", interactive: false }).addTo(map);
        dataLayers.current.push(line);
      }
      const heat = makeLinearHeatCanvas(boundary, points, bounds);
      const overlay = L.imageOverlay(heat.toDataURL("image/png"), [[bounds.south, bounds.west], [bounds.north, bounds.east]], { opacity: 0.82, interactive: false }).addTo(map);
      const outline = L.geoJSON(boundary as never, { interactive: false, style: { color: "#172b4d", weight: 3, opacity: 1, fillOpacity: 0 } }).addTo(map);
      dataLayers.current.push(overlay, outline);
      points.forEach((point) => {
        const value = point.values[DAY] as number;
        const marker = L.marker([point.lat, point.lon], {
          interactive: false,
          icon: L.divIcon({ className: "city-marker-shell", html: `<div class="city-marker"><strong>${Math.round(value)}°</strong><i></i><span>${point.name}</span></div>`, iconSize: [108, 52], iconAnchor: [54, 25] }),
        }).addTo(map);
        dataLayers.current.push(marker);
      });
      map.fitBounds([[bounds.south, bounds.west], [bounds.north, bounds.east]], { padding: [28, 28] });
    });
  }, [boundary, points, mapReady]);

  const downloadPng = useCallback(async () => {
    if (!forecast || !boundary || !points.length) return;
    setExporting(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1800;
      canvas.height = 1200;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);

      context.fillStyle = "#111827";
      context.font = "700 40px Arial, sans-serif";
      context.fillText("Maximum Apparent Temperature", 58, 58);
      context.font = "700 24px Arial, sans-serif";
      context.textAlign = "right";
      context.fillText(forecast.days[DAY]?.label ?? "Day 1", 1742, 47);
      context.font = "18px Arial, sans-serif";
      context.fillStyle = "#4b5563";
      context.fillText(`NWS issued ${formatTime(forecast.updatedAt || forecast.generatedAt)}`, 1742, 76);
      context.textAlign = "left";

      const plot = { x: 58, y: 100, width: 1684, height: 1000 };
      context.fillStyle = "#e6f1f5";
      context.fillRect(plot.x, plot.y, plot.width, plot.height);
      const bounds = boundaryBounds(boundary);
      const extent = exportExtent(bounds, plot.width, plot.height);
      await drawTiles(context, extent, plot.x, plot.y, plot.width, plot.height);

      context.save();
      context.beginPath();
      context.rect(plot.x, plot.y, plot.width, plot.height);
      context.clip();
      context.strokeStyle = "#64748b";
      context.lineWidth = 1;
      context.setLineDash([3, 5]);
      for (let lon = Math.ceil(bounds.west * 2) / 2; lon <= bounds.east; lon += 0.5) {
        const a = projectToPlot(lon, bounds.south - 0.5, extent, plot.x, plot.y, plot.width, plot.height);
        const b = projectToPlot(lon, bounds.north + 0.5, extent, plot.x, plot.y, plot.width, plot.height);
        context.beginPath(); context.moveTo(...a); context.lineTo(...b); context.stroke();
      }
      for (let lat = Math.ceil(bounds.south * 2) / 2; lat <= bounds.north; lat += 0.5) {
        const a = projectToPlot(bounds.west - 1, lat, extent, plot.x, plot.y, plot.width, plot.height);
        const b = projectToPlot(bounds.east + 1, lat, extent, plot.x, plot.y, plot.width, plot.height);
        context.beginPath(); context.moveTo(...a); context.lineTo(...b); context.stroke();
      }
      context.setLineDash([]);

      const raster = document.createElement("canvas");
      raster.width = 900;
      raster.height = 650;
      const rasterContext = raster.getContext("2d")!;
      const image = rasterContext.createImageData(raster.width, raster.height);
      for (let y = 0; y < raster.height; y += 1) {
        for (let x = 0; x < raster.width; x += 1) {
          const worldX = extent.left + (x / raster.width) * (extent.right - extent.left);
          const worldY = extent.top + (y / raster.height) * (extent.bottom - extent.top);
          const coordinate = inverseWorld(worldX, worldY, extent.zoom);
          const [red, green, blue] = colorFor(interpolate(points, coordinate.lon, coordinate.lat));
          const offset = (y * raster.width + x) * 4;
          image.data.set([red, green, blue, 210], offset);
        }
      }
      rasterContext.putImageData(image, 0, 0);
      rasterContext.globalCompositeOperation = "destination-in";
      traceBoundary(rasterContext, boundary, (lon, lat) => {
        const point = worldPoint(lon, lat, extent.zoom);
        return [((point.x - extent.left) / (extent.right - extent.left)) * raster.width, ((point.y - extent.top) / (extent.bottom - extent.top)) * raster.height];
      });
      rasterContext.fillStyle = "#fff";
      rasterContext.fill("evenodd");
      context.drawImage(raster, plot.x, plot.y, plot.width, plot.height);

      traceBoundary(context, boundary, (lon, lat) => projectToPlot(lon, lat, extent, plot.x, plot.y, plot.width, plot.height));
      context.strokeStyle = "#102a43";
      context.lineWidth = 4;
      context.stroke();
      context.restore();

      context.textAlign = "center";
      for (const point of points) {
        const [x, y] = projectToPlot(point.lon, point.lat, extent, plot.x, plot.y, plot.width, plot.height);
        context.fillStyle = "#ffffff";
        context.strokeStyle = "#111827";
        context.lineWidth = 5;
        context.font = "700 24px Arial, sans-serif";
        const value = `${Math.round(point.values[DAY] as number)}°`;
        context.strokeText(value, x, y - 16); context.fillText(value, x, y - 16);
        context.beginPath(); context.arc(x, y - 4, 5, 0, Math.PI * 2); context.fillStyle = "#dc2626"; context.fill(); context.strokeStyle = "#fff"; context.lineWidth = 2; context.stroke();
        context.font = "700 14px Arial, sans-serif";
        context.fillStyle = "#fff"; context.strokeStyle = "#111827"; context.lineWidth = 4;
        context.strokeText(point.name, x, y + 17); context.fillText(point.name, x, y + 17);
      }
      context.textAlign = "left";

      const legendX = 92;
      const legendY = 1040;
      const legendWidth = 440;
      const gradient = context.createLinearGradient(legendX, 0, legendX + legendWidth, 0);
      COLOR_STOPS.forEach((stop, index) => gradient.addColorStop(index / (COLOR_STOPS.length - 1), stop.color));
      context.fillStyle = "#ffffffdd";
      context.fillRect(76, 990, 490, 94);
      context.fillStyle = gradient;
      context.fillRect(legendX, legendY, legendWidth, 14);
      context.fillStyle = "#111827";
      context.font = "700 14px Arial, sans-serif";
      context.fillText("APPARENT TEMPERATURE (°F)", legendX, 1024);
      context.font = "12px Arial, sans-serif";
      COLOR_STOPS.forEach((stop, index) => context.fillText(String(stop.value), legendX + index / (COLOR_STOPS.length - 1) * legendWidth - 7, 1072));

      context.strokeStyle = "#111827";
      context.lineWidth = 2;
      context.strokeRect(plot.x, plot.y, plot.width, plot.height);
      context.fillStyle = "#4b5563";
      context.font = "14px Arial, sans-serif";
      context.fillText("Forecast: NOAA / National Weather Service · Boundary: NWS County Warning Area · Basemap: OpenStreetMap / CARTO", 58, 1142);
      context.textAlign = "right";
      context.font = "700 14px Arial, sans-serif";
      context.fillText("PHI FORECAST GRAPHICS", 1742, 1142);

      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG export failed")), "image/png"));
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `phi-max-apparent-temperature-${forecast.days[DAY]?.date || "day-1"}.png`;
      link.click();
      URL.revokeObjectURL(link.href);
    } finally {
      setExporting(false);
    }
  }, [forecast, boundary, points]);

  const activeDay = forecast?.days[DAY]?.label ?? "Day 1";
  return (
    <main className="app-shell">
      <nav className="site-nav">
        <a className="site-brand" href="https://www.weather.gov/phi/" target="_blank" rel="noreferrer"><span>PHI</span> FORECAST GRAPHICS</a>
        <div className="site-actions"><span className="live-status"><i /> LIVE NWS DATA</span><button onClick={downloadPng} disabled={!forecast || !boundary || exporting}>{exporting ? "Rendering PNG…" : "Download PNG"}</button></div>
      </nav>
      <section className="plot-shell">
        <header className="plot-header">
          <div><p>PHILADELPHIA / MOUNT HOLLY</p><h1>Maximum Apparent Temperature</h1></div>
          <div className="plot-valid"><strong>{activeDay}</strong><span>NWS issued {formatTime(forecast?.updatedAt || forecast?.generatedAt || "")}</span></div>
        </header>
        <div className="map-stage">
          <div ref={mapElement} className="forecast-map" aria-label="Interactive map of maximum apparent temperature within the NWS PHI County Warning Area" />
          {!forecast && !error && <div className="map-message">Loading the latest NWS forecast…</div>}
          {error && <div className="map-message">Forecast data is temporarily unavailable.</div>}
          <div className="map-legend" aria-label="Apparent temperature legend"><strong>APPARENT TEMPERATURE (°F)</strong><div className="legend-ramp" /><div className="legend-values">{COLOR_STOPS.map((stop) => <span key={stop.value}>{stop.value}</span>)}</div></div>
          <div className="boundary-label">NWS PHI COUNTY WARNING AREA</div>
        </div>
        <footer className="plot-footer"><span>Forecast: NOAA / National Weather Service · apparentTemperature</span><span>Boundary: official NWS County Warning Area · Basemap: OpenStreetMap / CARTO</span></footer>
      </section>
    </main>
  );
}
