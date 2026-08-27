import { NextResponse } from "next/server";

import { STATION_ATTEMPT_LIMIT, firstUsableObservation } from "../../../lib/observations.mjs";

export const runtime = "edge";

// The latest surface observation near one location, for the Alerts view's conditions strip.
//
// Proxied rather than fetched from the browser for the same reasons as /api/alerts: the
// response rides the edge cache instead of hitting api.weather.gov once per visitor, and
// the User-Agent NWS asks for is attached server-side.
//
// **Bounded upstream cost, unlike /api/forecast.** One request for the station list plus
// at most STATION_ATTEMPT_LIMIT observation lookups — five in the worst case, regardless
// of how many stations the gridpoint carries (PHI's carries 72). The per-point fan-out
// that 504s /api/forecast in production is exactly what the cap exists to avoid.
const UPSTREAM = "https://api.weather.gov";
// Five minutes, not the alerts route's sixty seconds. METARs land roughly every twenty
// minutes, so a shorter window would re-fetch the same observation repeatedly; a longer
// one would let the strip drift away from the two-minute alerts refresh beside it.
const CACHE_SECONDS = 300;

const HEADERS = {
  // NWS asks every client to identify itself and rate-limits those that don't.
  "User-Agent": "(nws-forecast-graphics, github.com/suchit)",
  Accept: "application/geo+json",
};

// The gridpoint address of the location being reported on. Validated rather than passed
// through because these values land in an outbound URL — anything not matching is
// rejected, so a crafted parameter cannot reshape the request or reach a different
// endpoint. Same guard as the zone codes in /api/alerts.
const WFO = /^[A-Z]{3}$/;
const GRID_INDEX = /^\d{1,3}$/;

function unavailable(status = 503) {
  return NextResponse.json(
    { error: "Observations unavailable", observation: null },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

async function upstream(path: string) {
  const response = await fetch(`${UPSTREAM}${path}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(10_000),
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
  } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
  if (!response.ok) throw new Error(`NWS ${response.status}`);
  return response.json();
}

export async function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  const wfo = (parameters.get("wfo") ?? "").trim().toUpperCase();
  const x = (parameters.get("x") ?? "").trim();
  const y = (parameters.get("y") ?? "").trim();
  if (!WFO.test(wfo) || !GRID_INDEX.test(x) || !GRID_INDEX.test(y)) return unavailable(400);

  // Distance-ordered, and stable enough to cache hard — stations do not move. The
  // client's cities bundle already carries this wfo/x,y, so there is no geocoding step.
  let stations: string[];
  try {
    const payload = await upstream(`/gridpoints/${wfo}/${x},${y}/stations`) as {
      features?: Array<{ properties?: { stationIdentifier?: unknown } }>;
    };
    stations = (payload.features ?? [])
      .map((feature) => feature.properties?.stationIdentifier)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return unavailable();
  }
  if (!stations.length) return unavailable(404);

  const observation = await firstUsableObservation(
    stations,
    async (station: string) => {
      const payload = await upstream(`/stations/${encodeURIComponent(station)}/observations/latest`) as {
        properties?: Record<string, unknown>;
      };
      return payload.properties ?? null;
    },
    STATION_ATTEMPT_LIMIT,
  );

  // Every nearby station being dark is a real answer, not an error — it happens overnight
  // at sparse gridpoints. Answering 200 with a null observation keeps the strip's "no
  // current observation" state on the same path as a success, the way /api/alerts answers
  // an empty zone list rather than erroring.
  if (!observation) {
    return NextResponse.json(
      { generatedAt: new Date().toISOString(), observation: null, stations: stations.length },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { generatedAt: new Date().toISOString(), observation, stations: stations.length },
    { headers: { "Cache-Control": `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=900` } },
  );
}
