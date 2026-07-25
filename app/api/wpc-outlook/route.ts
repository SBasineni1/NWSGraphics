import { NextResponse } from "next/server";

export const runtime = "edge";

// WPC Excessive Rainfall Outlook — the probability that rainfall exceeds flash flood
// guidance within 25 miles of a point. Proxied for the same reasons as the SPC outlook:
// no CORS on the upstream, and one edge-cached response instead of one fetch per visitor.
//
// WPC publishes Days 1–5; only the first three line up with this site's day tabs, and
// they are layers 0–2 of the same MapServer.
const SERVICE = "https://mapservices.weather.noaa.gov/vector/rest/services/hazards/wpc_precip_hazards/MapServer";
const OUTLOOK_DAYS = [1, 2, 3] as const;

// The ERO GeoJSON carries no `fill`/`stroke` of its own — unlike SPC, which ships its
// own styling — so the palette has to live here. These are WPC's own renderer colours,
// read off the MapServer's `drawingInfo`, keyed by the `dn` severity ordinal.
const ERO_CATEGORIES: Record<number, { label: string; name: string; fill: string; stroke: string }> = {
  1: { label: "MRGL", name: "Marginal", fill: "#38a800", stroke: "#00734c" },
  2: { label: "SLGT", name: "Slight", fill: "#fffe00", stroke: "#e69800" },
  3: { label: "MDT", name: "Moderate", fill: "#f50000", stroke: "#8a0000" },
  4: { label: "HIGH", name: "High", fill: "#ff69c5", stroke: "#ff00ff" },
};

type EroGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

type EroFeature = {
  type: "Feature";
  geometry: EroGeometry | { type: string } | null;
  properties: {
    dn?: number;
    outlook?: string;
    valid_time?: string;
    issue_time?: string;
    start_time?: string;
    end_time?: string;
  };
};

function isDrawable(geometry: EroFeature["geometry"]): geometry is EroGeometry {
  return geometry?.type === "Polygon" || geometry?.type === "MultiPolygon";
}

/** The service reports UTC as `YYYY-MM-DD HH:MM:SS` with no zone marker. */
function isoStamp(value: string | undefined) {
  if (!value) return null;
  const stamp = Date.parse(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(stamp) ? null : new Date(stamp).toISOString();
}

async function fetchOutlook(day: number) {
  // Only the fields the graphic reads, and four decimal places of geometry (~11 m) —
  // the full-precision national polygons are several times larger for no visible gain
  // at this scale.
  const query = new URLSearchParams({
    where: "1=1",
    outFields: "dn,outlook,valid_time,issue_time,start_time,end_time",
    outSR: "4326",
    geometryPrecision: "4",
    f: "geojson",
  });
  const response = await fetch(`${SERVICE}/${day - 1}/query?${query}`, {
    headers: { Accept: "application/geo+json", "User-Agent": "NWS Forecast Graphics (weather.gov)" },
    signal: AbortSignal.timeout(20000),
    cf: { cacheTtl: 600, cacheEverything: true },
  } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
  if (!response.ok) throw new Error(`WPC ${response.status}`);
  const data = (await response.json()) as { features?: EroFeature[] };
  const features = (data.features ?? []).filter((feature) => feature.properties);

  const areas = features.flatMap((feature) => {
    if (!isDrawable(feature.geometry)) return [];
    const rank = feature.properties.dn ?? 0;
    const category = ERO_CATEGORIES[rank];
    if (!category) return [];
    return [{
      rank,
      label: category.label,
      description: feature.properties.outlook ?? category.name,
      fill: category.fill,
      stroke: category.stroke,
      geometry: feature.geometry,
    }];
  });
  // Ascending severity, so the higher category paints over the lower one enclosing it.
  areas.sort((a, b) => a.rank - b.rank);

  const first = features[0]?.properties;
  return {
    day,
    // WPC's Day 1 starts at the issuance hour and every period ends at 12Z, so like the
    // SPC outlook this never matches an Eastern calendar day — the window travels with
    // the data and the graphic labels itself from it.
    valid: isoStamp(first?.start_time),
    expires: isoStamp(first?.end_time),
    issued: isoStamp(first?.issue_time),
    forecaster: null,
    areas,
    hatches: [] as Array<{ group: number; label: string; description: string; geometry: EroGeometry }>,
  };
}

export async function GET() {
  const results = await Promise.allSettled(OUTLOOK_DAYS.map(fetchOutlook));
  const outlooks = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    outlooks,
    failures: results.filter((result) => result.status === "rejected").length,
  }, { headers: { "Cache-Control": "public, max-age=300, s-maxage=600, stale-while-revalidate=3600" } });
}
