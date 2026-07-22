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
  { value: 70, color: "#3b82f6" },
  { value: 80, color: "#22c5a2" },
  { value: 90, color: "#eabf3f" },
  { value: 100, color: "#f28b32" },
  { value: 110, color: "#ef5350" },
  { value: 120, color: "#b43e72" },
];

function colorFor(value: number) {
  return COLOR_STOPS.find((item) => value <= item.value)?.color ?? COLOR_STOPS.at(-1)!.color;
}

function formatIssued(value: string, compact = false) {
  if (!value) return "Awaiting update";
  return new Intl.DateTimeFormat("en-US", {
    month: compact ? undefined : "short",
    day: compact ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: compact ? undefined : "short",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

export function ForecastGraphic() {
  const mapElement = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<import("leaflet").Map | null>(null);
  const layers = useRef<import("leaflet").Layer[]>([]);
  const [forecast, setForecast] = useState<ForecastPayload>(FALLBACK);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const day = 0;

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
        maxZoom: 10,
        zoomControl: false,
        attributionControl: false,
      });
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        subdomains: "abcd",
        maxZoom: 20,
      }).addTo(map);
      L.control.attribution({ position: "bottomleft", prefix: false })
        .addAttribution("© OpenStreetMap · © CARTO")
        .addTo(map);
      map.fitBounds([[38.35, -76.35], [41.35, -73.68]], { padding: [8, 8] });
      mapInstance.current = map;
      setMapReady(true);
    });
    return () => {
      cancelled = true;
      mapInstance.current?.remove();
      mapInstance.current = null;
    };
  }, []);

  const selectedPoints = useMemo(
    () => forecast.points
      .filter((point) => point.values[day] !== null)
      .sort((a, b) => (b.values[day] as number) - (a.values[day] as number)),
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
          fillOpacity: 0.38,
          className: "temperature-field",
        }).addTo(map);
        const label = L.marker([point.lat, point.lon], {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: "city-marker-shell",
            html: `<div class="city-marker"><span class="temperature">${Math.round(value)}°</span><span class="city-dot"></span><span class="city-name">${point.name}</span></div>`,
            iconSize: [102, 56],
            iconAnchor: [51, 27],
          }),
        }).addTo(map);
        layers.current.push(heat, label);
      });
    });
  }, [selectedPoints, day, mapReady]);

  const values = selectedPoints.map((point) => point.values[day] as number);
  const maxValue = values.length ? Math.max(...values) : null;
  const minValue = values.length ? Math.min(...values) : null;
  const activeDay = forecast.days[day] ?? FALLBACK.days[day];

  return (
    <main className="app-shell">
      <nav className="top-nav">
        <a className="nav-brand" href="https://www.weather.gov/phi/" target="_blank" rel="noreferrer">
          <span className="brand-glyph">PHI</span>
          <span>FORECAST GRAPHICS</span>
        </a>
        <div className="plot-product">APPARENT TEMPERATURE · DAY 1</div>
        <div className="live-pill"><span /> LIVE DATA</div>
      </nav>

      <div className="forecast-workspace">
        <aside className="forecast-panel">
          <header className="panel-header">
            <p className="panel-kicker">PHILADELPHIA / MOUNT HOLLY</p>
            <h1>Maximum Apparent Temperature</h1>
            <p className="panel-summary">Daily peak feels-like temperatures from the NWS gridded forecast.</p>
            <div className="forecast-period"><span>VALID PERIOD</span><strong>{activeDay.label}</strong></div>
          </header>

          <section className="stats-row" aria-label="Forecast summary">
            <div className="stat"><strong>{maxValue === null ? "—" : `${Math.round(maxValue)}°`}</strong><span>Peak</span></div>
            <div className="stat cool"><strong>{minValue === null ? "—" : `${Math.round(minValue)}°`}</strong><span>Lowest</span></div>
            <div className="stat"><strong>{selectedPoints.length || "—"}</strong><span>Sites</span></div>
            <div className="stat"><strong>{formatIssued(forecast.updatedAt || forecast.generatedAt, true)}</strong><span>Updated</span></div>
          </section>

          <div className="location-heading"><span>LOCATION FORECASTS</span><span>{activeDay.label}</span></div>
          <section className="location-list" aria-label="Location forecasts">
            {loading && <div className="list-state"><span className="loader" />Loading latest forecast…</div>}
            {!loading && error && <div className="list-state error-state">NWS data is temporarily unavailable.</div>}
            {!loading && selectedPoints.map((point) => {
              const value = point.values[day] as number;
              return (
                <div className="location-item" key={point.id}>
                  <span className="value-bar" style={{ background: colorFor(value) }} />
                  <span className="location-copy"><strong>{point.name}</strong><small>{point.state} · NWS PHI GRID</small></span>
                  <span className="location-value" style={{ color: colorFor(value) }}>{Math.round(value)}°</span>
                </div>
              );
            })}
          </section>

          <footer className="panel-footer">
            <span>{forecast.failures ? `${forecast.failures} site unavailable` : "All sites reporting"}</span>
            <span>NWS API · APPARENTTEMPERATURE</span>
          </footer>
        </aside>

        <section className="map-panel" aria-label="Forecast map">
          <div className="map-heading">
            <div><span>VALID</span><strong>{activeDay.label}</strong></div>
            <div><span>SOURCE</span><strong>NWS apparentTemperature</strong></div>
          </div>
          <div ref={mapElement} className="forecast-map" aria-label="Map of forecast apparent temperatures" />
          <div className="legend" aria-label="Apparent temperature legend">
            <span className="legend-title">APPARENT TEMP °F</span>
            <div className="legend-scale" />
            <div className="legend-labels">{COLOR_STOPS.map((stop) => <span key={stop.value}>{stop.value}</span>)}</div>
          </div>
          <div className="map-status"><span className="status-dot" /> Updates every 15 minutes</div>
        </section>
      </div>
    </main>
  );
}
