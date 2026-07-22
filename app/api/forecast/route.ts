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

// A regular sample lattice fills the gaps between the named cities. These are
// real PHI NDFD grid cells; they shape the field but stay visually unlabeled.
const GRID_X = [20, 35, 50, 65, 80, 95] as const;
const GRID_Y = [24, 48, 72, 96, 120] as const;
const GRID_LOCATIONS = GRID_Y.flatMap((y) => GRID_X.map((x) => ({
  id: `grid-${x}-${y}`,
  name: "",
  state: "",
  x,
  y,
  label: false,
})));

const LOCATIONS = [...LABEL_LOCATIONS, ...GRID_LOCATIONS];

type GridValue = { validTime: string; value: number | null };
type GridResponse = {
  geometry?: { type: "Polygon"; coordinates: number[][][] };
  properties: {
    updateTime?: string;
    generatedAt?: string;
    apparentTemperature?: { values?: GridValue[] };
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

async function fetchLocation(location: (typeof LOCATIONS)[number], dates: string[]) {
  const response = await fetch(`https://api.weather.gov/gridpoints/PHI/${location.x},${location.y}`, {
    headers: {
      Accept: "application/geo+json",
      "User-Agent": "PHI Forecast Graphics (weather.gov/phi)",
    },
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
  const grouped = new Map<string, number[]>();
  for (const item of data.properties.apparentTemperature?.values ?? []) {
    if (item.value === null) continue;
    const date = easternDate(item.validTime.split("/")[0]);
    const fahrenheit = item.value * 9 / 5 + 32;
    grouped.set(date, [...(grouped.get(date) ?? []), fahrenheit]);
  }
  return {
    point: {
      id: location.id,
      name: location.name,
      state: location.state,
      lat,
      lon,
      label: location.label,
      values: dates.map((date) => grouped.has(date) ? Math.round(Math.max(...grouped.get(date)!)) : null),
    },
    updatedAt: data.properties.updateTime ?? data.properties.generatedAt ?? "",
  };
}

export async function GET() {
  const now = new Date();
  const today = easternDate(now);
  const [year, month, day] = today.split("-").map(Number);
  const dates = Array.from({ length: 4 }, (_, index) => easternDate(new Date(Date.UTC(year, month - 1, day + index, 16))));
  const results = await Promise.allSettled(LOCATIONS.map((location) => fetchLocation(location, dates)));
  const successful = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchLocation>>> => result.status === "fulfilled");
  const updatedAt = successful.map((result) => result.value.updatedAt).filter(Boolean).sort().at(-1) ?? now.toISOString();

  return NextResponse.json({
    generatedAt: now.toISOString(),
    updatedAt,
    days: dates.map(dayInfo),
    points: successful.map((result) => result.value.point),
    failures: results.length - successful.length,
  }, {
    headers: { "Cache-Control": "public, max-age=300, s-maxage=900, stale-while-revalidate=3600" },
  });
}
