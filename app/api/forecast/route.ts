import { NextResponse } from "next/server";

export const runtime = "edge";

const LABEL_LOCATIONS = [
  { id: "phl", name: "Philadelphia", state: "PA", lat: 39.9526, lon: -75.1652, x: 50, y: 79, label: true },
  { id: "abe", name: "Allentown", state: "PA", lat: 40.6023, lon: -75.4714, x: 35, y: 106, label: true },
  { id: "rdg", name: "Reading", state: "PA", lat: 40.3356, lon: -75.9269, x: 21, y: 92, label: true },
  { id: "mpo", name: "Mt Pocono", state: "PA", lat: 41.122, lon: -75.3646, x: 35, y: 130, label: true },
  { id: "sus", name: "Sussex", state: "NJ", lat: 41.2098, lon: -74.6077, x: 60, y: 138, label: true },
  { id: "mmu", name: "Morristown", state: "NJ", lat: 40.7968, lon: -74.4815, x: 67, y: 120, label: true },
  { id: "smq", name: "Somerville", state: "NJ", lat: 40.5743, lon: -74.6099, x: 65, y: 110, label: true },
  { id: "ttn", name: "Trenton", state: "NJ", lat: 40.2171, lon: -74.7429, x: 62, y: 93, label: true },
  { id: "lgb", name: "Long Branch", state: "NJ", lat: 40.3043, lon: -73.9924, x: 88, y: 101, label: true },
  { id: "tom", name: "Toms River", state: "NJ", lat: 39.9537, lon: -74.1979, x: 83, y: 84, label: true },
  { id: "ilg", name: "Wilmington", state: "DE", lat: 39.7447, lon: -75.5484, x: 38, y: 67, label: true },
  { id: "vin", name: "Vineland", state: "NJ", lat: 39.4862, lon: -75.0257, x: 58, y: 59, label: true },
  { id: "dov", name: "Dover", state: "DE", lat: 39.1582, lon: -75.5244, x: 42, y: 41, label: true },
  { id: "acy", name: "Atlantic City", state: "NJ", lat: 39.3643, lon: -74.4229, x: 79, y: 56, label: true },
  { id: "cap", name: "Cape May", state: "NJ", lat: 38.9351, lon: -74.906, x: 65, y: 35, label: true },
  { id: "bet", name: "Bethany Beach", state: "DE", lat: 38.5396, lon: -75.0552, x: 63, y: 16, label: true },
  { id: "eas", name: "Easton", state: "MD", lat: 38.7743, lon: -76.0763, x: 26, y: 21, label: true },
] as const;

const GRID_X = [16, 28, 40, 52, 64, 76, 88, 100] as const;
const GRID_Y = [18, 42, 66, 90, 114, 138] as const;
const OUTSIDE_PHI_GRID = new Set([
  "grid-16-66", "grid-16-114", "grid-88-114", "grid-100-114",
  "grid-16-138", "grid-28-138", "grid-76-138", "grid-88-138", "grid-100-138",
]);
const GRID_LOCATIONS = GRID_Y.flatMap((y) => GRID_X.map((x) => ({
  id: `grid-${x}-${y}`,
  name: "",
  state: "",
  x,
  y,
  label: false,
}))).filter((location) => !OUTSIDE_PHI_GRID.has(location.id));
const LOCATIONS = [...LABEL_LOCATIONS, ...GRID_LOCATIONS];

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

async function fetchLocation(location: (typeof LOCATIONS)[number], dates: string[]) {
  const response = await fetch(`https://api.weather.gov/gridpoints/PHI/${location.x},${location.y}`, {
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

export async function GET() {
  const now = new Date();
  const today = easternDate(now);
  const [year, month, day] = today.split("-").map(Number);
  const dates = Array.from({ length: 4 }, (_, index) => easternDate(new Date(Date.UTC(year, month - 1, day + index, 16))));
  const results: PromiseSettledResult<Awaited<ReturnType<typeof fetchLocation>>>[] = [];
  // Keep pressure on api.weather.gov modest; small batches are more reliable
  // than opening every PHI grid-cell request at once.
  for (let index = 0; index < LOCATIONS.length; index += 12) {
    const batch = LOCATIONS.slice(index, index + 12);
    results.push(...await Promise.allSettled(batch.map((location) => fetchLocation(location, dates))));
  }
  const successful = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchLocation>>> => result.status === "fulfilled");
  const updatedAt = successful.map((result) => result.value.updatedAt).filter(Boolean).sort().at(-1) ?? now.toISOString();
  return NextResponse.json({
    generatedAt: now.toISOString(),
    updatedAt,
    days: dates.map(dayInfo),
    points: successful.map((result) => result.value.point),
    failures: results.length - successful.length,
  }, { headers: { "Cache-Control": "public, max-age=300, s-maxage=900, stale-while-revalidate=3600" } });
}
