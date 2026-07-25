import { NextResponse } from "next/server";

export const runtime = "edge";

// SPC convective outlooks, categorical risk. Proxied rather than fetched from the
// browser because spc.noaa.gov sends no CORS headers, and proxying lets the response
// ride Cloudflare's edge cache instead of hitting SPC once per visitor.
//
// Only the categorical product runs all three days — tornado/wind/hail stop after Day 2
// and `prob` doesn't exist for Day 1 — so this route is deliberately categorical-only.
const OUTLOOK_DAYS = [1, 2, 3] as const;
const SOURCE = (day: number) => `https://www.spc.noaa.gov/products/outlook/day${day}otlk_cat.nolyr.geojson`;

type OutlookFeature = {
  type: "Feature";
  geometry:
    | { type: "Polygon"; coordinates: number[][][] }
    | { type: "MultiPolygon"; coordinates: number[][][][] };
  properties: {
    DN?: number;
    LABEL?: string;
    LABEL2?: string;
    stroke?: string;
    fill?: string;
    VALID_ISO?: string;
    EXPIRE_ISO?: string;
    ISSUE_ISO?: string;
    FORECASTER?: string;
  };
};

async function fetchOutlook(day: number) {
  const response = await fetch(SOURCE(day), {
    headers: { Accept: "application/geo+json", "User-Agent": "PHI Forecast Graphics (weather.gov/phi)" },
    signal: AbortSignal.timeout(15000),
    cf: { cacheTtl: 600, cacheEverything: true },
  } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
  if (!response.ok) throw new Error(`SPC ${response.status}`);
  const data = (await response.json()) as { features?: OutlookFeature[] };
  const features = (data.features ?? []).filter((feature) => feature.geometry && feature.properties);
  // DN encodes severity (2 TSTM → 8 HIGH). Sorting here means the renderer can paint in
  // order and let higher risk land on top of the areas it sits inside.
  features.sort((a, b) => (a.properties.DN ?? 0) - (b.properties.DN ?? 0));
  const first = features[0]?.properties;
  return {
    day,
    // SPC's convective day runs 12Z–12Z and does not line up with the site's Eastern
    // calendar day, so the real validity window travels with the data and the graphic
    // labels itself from these rather than from the day tab.
    valid: first?.VALID_ISO ?? null,
    expires: first?.EXPIRE_ISO ?? null,
    issued: first?.ISSUE_ISO ?? null,
    forecaster: first?.FORECASTER ?? null,
    features: features.map((feature) => ({
      dn: feature.properties.DN ?? 0,
      label: feature.properties.LABEL ?? "",
      description: feature.properties.LABEL2 ?? "",
      fill: feature.properties.fill ?? "#cccccc",
      stroke: feature.properties.stroke ?? "#666666",
      geometry: feature.geometry,
    })),
  };
}

export async function GET() {
  const results = await Promise.allSettled(OUTLOOK_DAYS.map(fetchOutlook));
  const days = results.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      // A failed day yields an empty outlook rather than failing the whole request; the
      // renderer already has to handle "no risk area", which looks the same.
      : { day: OUTLOOK_DAYS[index], valid: null, expires: null, issued: null, forecaster: null, features: [] });
  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    days,
    failures: results.filter((result) => result.status === "rejected").length,
  }, { headers: { "Cache-Control": "public, max-age=300, s-maxage=600, stale-while-revalidate=3600" } });
}
