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

const FALLBACK: ForecastPayload = {
  generatedAt: "",
  updatedAt: "",
  failures: 0,
  days: [
    { date: "", label: "Today", shortLabel: "Today" },
    { date: "", label: "Tomorrow", shortLabel: "Tomorrow" },
    { date: "", label: "Day 3", shortLabel: "Day 3" },
    { date: "", label: "Day 4", shortLabel: "Day 4" },
  ],
  points: [],
};

const COLOR_STOPS = [
  { value: 70, color: "#38a9ef" },
  { value: 80, color: "#57d6d0" },
  { value: 90, color: "#f7da4d" },
  { value: 100, color: "#ff932e" },
  { value: 110, color: "#f04438" },
  { value: 120, color: "#a81956" },
];

function colorFor(value: number) {
  const stop = COLOR_STOPS.find((item) => value <= item.value);
  return stop?.color ?? COLOR_STOPS.at(-1)!.color;
}

function formatIssued(value: string) {
  if (!value) return "Awaiting latest NWS forecast";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

export function ForecastGraphic() {
  const mapElement = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<import("leaflet").Map | null>(null);
  const layers = useRef<import("leaflet").Layer[]>([]);
  const [forecast, setForecast] = useState<ForecastPayload>(FALLBACK);
  const [day, setDay] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [mapReady, setMapReady] = useState(false);

  const loadForecast = useCallback(async () => {
    try {
      setError(false);
      const response = await fetch("/api/forecast", { cache: "no-store" });
      if (!response.ok) throw new Error("Forecast request failed");
      const payload = (await response.json()) as ForecastPayload;
      setForecast(payload);
      if (!payload.points.length) setError(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadForecast();
    const refresh = window.setInterval(loadForecast, 15 * 60 * 1000);
    return () => window.clearInterval(refresh);
  }, [loadForecast]);

  useEffect(() => {
    if (!mapElement.current || mapInstance.current) return;
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled || !mapElement.current) return;
      const map = L.map(mapElement.current, {
        center: [39.82, -74.85],
        zoom: 7,
        minZoom: 6,
        maxZoom: 9,
        zoomControl: false,
        attributionControl: false,
      });
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        subdomains: "abcd",
        maxZoom: 20,
      }).addTo(map);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.control.attribution({ position: "bottomleft", prefix: false })
        .addAttribution("Map © OpenStreetMap, © CARTO")
        .addTo(map);
      map.fitBounds([
        [38.35, -76.35],
        [41.35, -73.68],
      ], { padding: [8, 8] });
      mapInstance.current = map;
      setMapReady(true);
    });
    return () => {
      cancelled = true;
      mapInstance.current?.remove();
      mapInstance.current = null;
      setMapReady(false);
    };
  }, []);

  const selectedPoints = useMemo(
    () => forecast.points.filter((point) => point.values[day] !== null),
    [forecast.points, day],
  );

  useEffect(() => {
    const map = mapInstance.current;
    if (!map || !selectedPoints.length) return;
    void import("leaflet").then((L) => {
      layers.current.forEach((layer) => layer.remove());
      layers.current = [];

      selectedPoints.forEach((point) => {
        const value = point.values[day] as number;
        const heat = L.circle([point.lat, point.lon], {
          radius: 68000,
          stroke: false,
          fillColor: colorFor(value),
          fillOpacity: 0.34,
          className: "temperature-field",
        }).addTo(map);
        const label = L.marker([point.lat, point.lon], {
          interactive: false,
          icon: L.divIcon({
            className: "city-marker-shell",
            html: `<div class="city-marker"><span class="temperature">${Math.round(value)}°</span><span class="city-dot"></span><span class="city-name">${point.name}</span></div>`,
            iconSize: [104, 58],
            iconAnchor: [52, 26],
          }),
        }).addTo(map);
        layers.current.push(heat, label);
      });
    });
  }, [selectedPoints, day, mapReady]);

  const activeDay = forecast.days[day] ?? FALLBACK.days[day];
  const maxValue = selectedPoints.length
    ? Math.max(...selectedPoints.map((point) => point.values[day] as number))
    : null;

  return (
    <main className="app-shell">
      <header className="app-header">
        <a className="brand" href="https://www.weather.gov/phi/" target="_blank" rel="noreferrer">
          <span className="brand-mark" aria-hidden="true">NWS</span>
          <span><strong>Forecast Graphics</strong><small>Philadelphia / Mount Holly</small></span>
        </a>
        <div className="live-status"><span /> Live NWS data · refreshes every 15 min</div>
      </header>

      <section className="workspace" aria-label="Maximum apparent temperature forecast graphic">
        <div className="graphic-card">
          <div className="graphic-heading">
            <div>
              <p className="eyebrow">PHI AREA FORECAST · HEAT</p>
              <h1>Maximum Apparent Temperature</h1>
              <p className="valid-line">{activeDay.label || "Loading forecast period"}</p>
            </div>
            <div className="office-lockup">
              <span className="office-badge">NOAA</span>
              <span>National Weather Service<br /><strong>Mount Holly, NJ</strong></span>
            </div>
          </div>

          <div className="map-wrap">
            <div ref={mapElement} className="forecast-map" aria-label="Map of forecast apparent temperatures" />
            {loading && <div className="map-state"><span className="loader" />Loading the latest PHI forecast…</div>}
            {!loading && error && <div className="map-state error-state">Live NWS data is temporarily unavailable.<button onClick={loadForecast}>Try again</button></div>}
            <div className="legend" aria-label="Apparent temperature legend">
              <span className="legend-title">APPARENT<br />TEMP °F</span>
              <div className="legend-bar" />
              <div className="legend-labels">{COLOR_STOPS.map((stop) => <span key={stop.value}>{stop.value}°</span>)}</div>
            </div>
            {maxValue !== null && <div className="peak-callout"><small>REGIONAL PEAK</small><strong>{Math.round(maxValue)}°F</strong></div>}
          </div>

          <footer className="graphic-footer">
            <span>Forecast source: National Weather Service API · apparentTemperature</span>
            <span>Issued {formatIssued(forecast.updatedAt || forecast.generatedAt)}</span>
          </footer>
        </div>

        <nav className="day-switcher" aria-label="Forecast day">
          {forecast.days.map((item, index) => (
            <button key={`${item.date}-${index}`} className={index === day ? "active" : ""} onClick={() => setDay(index)}>
              <span>DAY {index + 1}</span><strong>{item.shortLabel}</strong>
            </button>
          ))}
        </nav>

        <div className="product-note">
          <div><span className="product-icon">HI</span><p><strong>Maximum heat index / apparent temperature</strong><br />Daily maximum from the NWS hourly gridded forecast.</p></div>
          <p>{forecast.failures ? `${forecast.failures} location${forecast.failures === 1 ? "" : "s"} unavailable in the latest refresh.` : "All reporting locations updated."}</p>
        </div>
      </section>
    </main>
  );
}
