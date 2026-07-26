import { NextResponse } from "next/server";
import { findOffice, type OfficeId } from "../../offices";

export const runtime = "edge";

type GridPoint = { id: string; wfo: string; x: number; y: number; lat: number; lon: number };
type CityPoint = { id: string; name: string; state: string; office: string; wfo?: string; lat: number; lon: number; x: number; y: number };

type Location = {
  id: string;
  name: string;
  state: string;
  wfo: string;
  x: number;
  y: number;
  lat?: number;
  lon?: number;
  label: boolean;
};

/**
 * The lattice and labelled cities for one office, read from the static assets rather than
 * imported.
 *
 * Importing them bundles every office's points into the Worker: at 125 offices that is
 * ~1.5 MB of the 3 MB budget for data where all but one office's slice is dead weight on
 * any given request. Two asset reads cost two subrequests against a 50 limit — the
 * gridpoint fan-out below is what actually breaks that ceiling, which is why production
 * serves precomputed forecasts from R2 and this route is the local/dev path.
 */
async function locationsFor(office: OfficeId, request: Request): Promise<Location[]> {
  const read = async <T>(path: string): Promise<T[]> => {
    const response = await fetch(new URL(path, request.url), { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return (await response.json()) as T[];
  };
  const [cities, grid] = await Promise.all([
    read<CityPoint>(`/cities/${office}.json`).catch(() => []),
    read<GridPoint>(`/gridpoints/${office}.json`).catch(() => []),
  ]);
  return [
    // Labelled cities carry their own coordinates so a label never lands on the centroid
    // of its gridpoint, and stay separate from the lattice so they can't distort the field.
    ...cities.map((city) => ({
      id: city.id,
      name: city.name,
      state: city.state,
      // The gridpoint domain, which is not always the office: NWS splits Alaska's AFC
      // into the AER and ALU domains, so fetching from `office` would 404 for Anchorage.
      wfo: city.wfo ?? city.office,
      lat: city.lat,
      lon: city.lon,
      x: city.x,
      y: city.y,
      label: true,
    })),
    ...grid.map((point) => ({
      id: point.id,
      name: "",
      state: "",
      wfo: point.wfo,
      x: point.x,
      y: point.y,
      label: false,
    })),
  ];
}

type ProductId = "apparentTemperature" | "temperature" | "minTemperature" | "dewpoint" | "windGust" | "windSpeed" | "skyCover" | "probabilityOfPrecipitation" | "quantitativePrecipitation";
type GridValue = { validTime: string; value: number | null };
type GridSeries = { uom?: string; values?: GridValue[] };
type GridResponse = {
  geometry?: { type: "Polygon"; coordinates: number[][][] };
  properties: {
    updateTime?: string;
    generatedAt?: string;
    apparentTemperature?: GridSeries;
    temperature?: GridSeries;
    minTemperature?: GridSeries;
    dewpoint?: GridSeries;
    windGust?: GridSeries;
    windSpeed?: GridSeries;
    skyCover?: GridSeries;
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
  mode: "max" | "min" | "sum" | "mean",
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
    const total = () => values.reduce((sum, value) => sum + value, 0);
    const result = mode === "sum" ? total()
      : mode === "mean" ? total() / values.length
      : mode === "min" ? Math.min(...values)
      : Math.max(...values);
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
  // A labelled city carries its own coordinates; a lattice point falls back to the centre
  // of the gridpoint polygon the API returned.
  const lat = location.lat ?? gridLat;
  const lon = location.lon ?? gridLon;
  const metrics: Record<ProductId, Array<number | null>> = {
    apparentTemperature: dailyValues(data.properties.apparentTemperature, dates, (value) => value * 9 / 5 + 32, "max"),
    temperature: dailyValues(data.properties.temperature, dates, (value) => value * 9 / 5 + 32, "max"),
    // NWS's own published low, not a calendar-day minimum of the hourly series. A
    // midnight-to-midnight minimum lands near dawn and so mixes two different nights;
    // `minTemperature` is the overnight low the forecast actually advertises, and its
    // period starts on the evening it belongs to, which matches the date grouping above.
    minTemperature: dailyValues(data.properties.minTemperature, dates, (value) => value * 9 / 5 + 32, "min"),
    dewpoint: dailyValues(data.properties.dewpoint, dates, (value) => value * 9 / 5 + 32, "max"),
    windGust: dailyValues(data.properties.windGust, dates, (value) => value * 0.621371, "max"),
    windSpeed: dailyValues(data.properties.windSpeed, dates, (value) => value * 0.621371, "max"),
    // Averaged, not peaked: a single cloudy hour would otherwise brand an
    // otherwise-sunny day as overcast (Jul 24 at PHI peaks at 71% but averages 32%).
    skyCover: dailyValues(data.properties.skyCover, dates, (value) => value, "mean"),
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
  const locations = await locationsFor(office, request);
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
  // A payload with no points is worse than an error: the renderer interpolates over an
  // empty set, every cell falls back to 0, and the page draws a confident-looking map of
  // 0°F across the whole area rather than showing anything is wrong. A partial result is
  // fine — the field degrades gracefully — but nothing at all is a failure, so say so.
  if (!successful.length) {
    return NextResponse.json(
      { error: `No gridpoint data available for ${office}`, failures: results.length },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
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
