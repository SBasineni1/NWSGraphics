import { NextResponse } from "next/server";
import gridPoints from "./grid-points.json";
import cityPoints from "./city-points.json";
import { findOffice, type OfficeId } from "../../offices";

export const runtime = "edge";

type GridPoint = { id: string; wfo: string; x: number; y: number; lat: number; lon: number; offices: string[] };
type CityPoint = { id: string; name: string; state: string; office: string; lat: number; lon: number; x: number; y: number };

// Labeled cities carry their own coordinates so a label never lands on the centroid of
// its gridpoint, and stay separate from the lattice so they can't distort the field.
const LABEL_LOCATIONS = (cityPoints as CityPoint[]).map((city) => ({
  id: city.id,
  name: city.name,
  state: city.state,
  office: city.office,
  wfo: city.office,
  lat: city.lat,
  lon: city.lon,
  x: city.x,
  y: city.y,
  label: true,
}));

// Background lattice across every covered office's render frame (see
// build-grid-points.mjs). `offices` lists the maps each point is needed for.
const GRID_LOCATIONS = (gridPoints as GridPoint[]).map((point) => ({
  id: point.id,
  name: "",
  state: "",
  offices: point.offices,
  wfo: point.wfo,
  x: point.x,
  y: point.y,
  label: false,
}));

type Location = (typeof LABEL_LOCATIONS)[number] | (typeof GRID_LOCATIONS)[number];

// Each map only needs the points inside its own frame; fetching the whole region on
// every request would multiply the subrequest count for data that is never drawn.
function locationsFor(office: OfficeId): Location[] {
  return [
    ...LABEL_LOCATIONS.filter((location) => location.office === office),
    ...GRID_LOCATIONS.filter((location) => location.offices.includes(office)),
  ];
}

type ProductId = "apparentTemperature" | "temperature" | "windGust" | "probabilityOfPrecipitation" | "quantitativePrecipitation";
type GridValue = { validTime: string; value: number | null };
type GridSeries = { uom?: string; values?: GridValue[] };
type GridResponse = {
  geometry?: { type: "Polygon"; coordinates: number[][][] };
  properties: {
    updateTime?: string;
    generatedAt?: string;
    apparentTemperature?: GridSeries;
    temperature?: GridSeries;
    windGust?: GridSeries;
    probabilityOfPrecipitation?: GridSeries;
    quantitativePrecipitation?: GridSeries;
  };
};

function easternDate(value: string | Date) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "America/New_York",
  }).format(new Date(value));
}

function dayInfo(date: string, index: number) {
  const localNoon = new Date(`${date}T12:00:00-04:00`);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "America/New_York" }).format(localNoon);
  const shortWeekday = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" }).format(localNoon);
  return { date, label: index === 0 ? `Today · ${weekday}` : `${weekday} · ${shortWeekday.split(", ").at(-1)}`, shortLabel: index === 0 ? "Today" : weekday };
}

function dailyValues(
  series: GridSeries | undefined,
  dates: string[],
  convert: (value: number) => number,
  mode: "max" | "sum",
  precision = 0,
) {
  const grouped = new Map<string, number[]>();
  for (const item of series?.values ?? []) {
    if (item.value === null) continue;
    const date = easternDate(item.validTime.split("/")[0]);
    grouped.set(date, [...(grouped.get(date) ?? []), convert(item.value)]);
  }
  const factor = 10 ** precision;
  return dates.map((date) => {
    const values = grouped.get(date);
    if (!values?.length) return null;
    const result = mode === "sum" ? values.reduce((total, value) => total + value, 0) : Math.max(...values);
    return Math.round(result * factor) / factor;
  });
}

async function fetchLocation(location: Location, dates: string[]) {
  const response = await fetch(`https://api.weather.gov/gridpoints/${location.wfo}/${location.x},${location.y}`, {
    headers: { Accept: "application/geo+json", "User-Agent": "PHI Forecast Graphics (weather.gov/phi)" },
    signal: AbortSignal.timeout(12000),
    cf: { cacheTtl: 900, cacheEverything: true },
  } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
  if (!response.ok) throw new Error(`NWS ${response.status}`);
  const data = (await response.json()) as GridResponse;
  const ring = data.geometry?.coordinates[0] ?? [];
  const uniqueRing = ring.length > 1 ? ring.slice(0, -1) : ring;
  const gridLon = uniqueRing.length ? uniqueRing.reduce((sum, position) => sum + position[0], 0) / uniqueRing.length : 0;
  const gridLat = uniqueRing.length ? uniqueRing.reduce((sum, position) => sum + position[1], 0) / uniqueRing.length : 0;
  const lat = "lat" in location ? location.lat : gridLat;
  const lon = "lon" in location ? location.lon : gridLon;
  const metrics: Record<ProductId, Array<number | null>> = {
    apparentTemperature: dailyValues(data.properties.apparentTemperature, dates, (value) => value * 9 / 5 + 32, "max"),
    temperature: dailyValues(data.properties.temperature, dates, (value) => value * 9 / 5 + 32, "max"),
    windGust: dailyValues(data.properties.windGust, dates, (value) => value * 0.621371, "max"),
    probabilityOfPrecipitation: dailyValues(data.properties.probabilityOfPrecipitation, dates, (value) => value, "max"),
    quantitativePrecipitation: dailyValues(data.properties.quantitativePrecipitation, dates, (value) => value / 25.4, "sum", 2),
  };
  return {
    point: { id: location.id, name: location.name, state: location.state, lat, lon, label: location.label, metrics },
    updatedAt: data.properties.updateTime ?? data.properties.generatedAt ?? "",
  };
}

export async function GET(request: Request) {
  const office = findOffice(new URL(request.url).searchParams.get("office")).id;
  const locations = locationsFor(office);
  const now = new Date();
  const today = easternDate(now);
  const [year, month, day] = today.split("-").map(Number);
  const dates = Array.from({ length: 3 }, (_, index) => easternDate(new Date(Date.UTC(year, month - 1, day + index, 16))));
  const results: PromiseSettledResult<Awaited<ReturnType<typeof fetchLocation>>>[] = [];
  // Keep pressure on api.weather.gov modest; batching is more reliable than opening
  // every grid-cell request at once, but the per-office point count needs a wider
  // batch than the single-office original to keep the response time reasonable.
  for (let index = 0; index < locations.length; index += 24) {
    const batch = locations.slice(index, index + 24);
    results.push(...await Promise.allSettled(batch.map((location) => fetchLocation(location, dates))));
  }
  const successful = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchLocation>>> => result.status === "fulfilled");
  const updatedAt = successful.map((result) => result.value.updatedAt).filter(Boolean).sort().at(-1) ?? now.toISOString();
  return NextResponse.json({
    office,
    generatedAt: now.toISOString(),
    updatedAt,
    days: dates.map(dayInfo),
    points: successful.map((result) => result.value.point),
    failures: results.length - successful.length,
  }, { headers: { "Cache-Control": "public, max-age=300, s-maxage=900, stale-while-revalidate=3600" } });
}
