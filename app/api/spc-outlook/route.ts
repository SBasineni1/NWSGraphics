import { NextResponse } from "next/server";

export const runtime = "edge";

// SPC convective outlooks. Proxied rather than fetched from the browser because
// spc.noaa.gov sends no CORS headers, and proxying lets the response ride Cloudflare's
// edge cache instead of hitting SPC once per visitor.
//
// Coverage is uneven by design and this table is the source of truth for it: the
// categorical outlook runs all three days, the split tornado/hail/wind probabilities
// stop after Day 2, and Day 3 carries only a combined "any severe" probability. A
// product is simply absent on a day SPC doesn't issue it for; the client hides it there
// rather than drawing an empty map.
const SOURCES = [
  { product: "categorical", file: "cat", days: [1, 2, 3] },
  { product: "tornado", file: "torn", days: [1, 2] },
  { product: "hail", file: "hail", days: [1, 2] },
  { product: "wind", file: "wind", days: [1, 2] },
  { product: "severeProbability", file: "prob", days: [3] },
] as const;

const REQUESTS = SOURCES.flatMap((source) =>
  source.days.map((day) => ({
    product: source.product,
    day,
    url: `https://www.spc.noaa.gov/products/outlook/day${day}otlk_${source.file}.nolyr.geojson`,
  })),
);

// Conditional Intensity Groups ride inside the probability files rather than shipping as
// their own product: same file, same DN space, unrelated meaning (day-1 wind `DN: 2` is
// CIG1, day-2 tornado `DN: 2` is 2% probability). They must be split out before anything
// sorts on DN, and they are drawn as hatching over the probabilities, never as a tier of
// them. CIG replaced the old significant-severe hatch — `day{1,2}otlk_sig*` and
// `day3otlk_sigprob` have not been reissued since 2026-03-03, so they are not fetched.
// `SIGN` is still recognised here so an older or re-enabled file wouldn't be dropped.
const CIG_LABEL = /^CIG(\d)$/;

type OutlookGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

type OutlookFeature = {
  type: "Feature";
  geometry: OutlookGeometry | { type: string };
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

/** A day with no risk area ships one empty `GeometryCollection`, which has no rings. */
function isDrawable(geometry: OutlookFeature["geometry"]): geometry is OutlookGeometry {
  return geometry?.type === "Polygon" || geometry?.type === "MultiPolygon";
}

async function fetchOutlook(request: (typeof REQUESTS)[number]) {
  const response = await fetch(request.url, {
    headers: { Accept: "application/geo+json", "User-Agent": "NWS Forecast Graphics (weather.gov)" },
    signal: AbortSignal.timeout(15000),
    cf: { cacheTtl: 600, cacheEverything: true },
  } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
  if (!response.ok) throw new Error(`SPC ${response.status}`);
  const data = (await response.json()) as { features?: OutlookFeature[] };
  const features = (data.features ?? []).filter((feature) => feature.geometry && feature.properties);

  const areas: Array<{ rank: number; label: string; description: string; fill: string; stroke: string; geometry: OutlookGeometry }> = [];
  const hatches: Array<{ group: number; label: string; description: string; geometry: OutlookGeometry }> = [];
  for (const feature of features) {
    const { geometry, properties } = feature;
    if (!isDrawable(geometry)) continue;
    const label = properties.LABEL ?? "";
    const cig = CIG_LABEL.exec(label);
    if (cig || label === "SIGN") {
      hatches.push({
        // SIGN predates the groups and has no tier of its own; it reads as the densest.
        group: cig ? Number(cig[1]) : 3,
        label: cig ? label : "SIGN",
        description: properties.LABEL2 ?? "",
        geometry,
      });
      continue;
    }
    areas.push({
      rank: properties.DN ?? 0,
      label,
      description: properties.LABEL2 ?? "",
      fill: properties.fill || "#cccccc",
      stroke: properties.stroke || "#666666",
      geometry,
    });
  }
  // DN encodes severity within a single product (2 TSTM → 8 HIGH for categorical, the
  // probability itself for the others). Sorting here means the renderer can paint in
  // order and let higher risk land on top of the area it sits inside.
  areas.sort((a, b) => a.rank - b.rank);
  hatches.sort((a, b) => a.group - b.group);

  // Stamps come off the raw features, not the drawable ones: an empty day still carries
  // a valid window, and that window is what the graphic labels itself with.
  const first = features[0]?.properties;
  return {
    product: request.product,
    day: request.day,
    // SPC's convective day runs 12Z–12Z and does not line up with the site's Eastern
    // calendar day, so the real validity window travels with the data.
    valid: first?.VALID_ISO ?? null,
    expires: first?.EXPIRE_ISO ?? null,
    issued: first?.ISSUE_ISO ?? null,
    forecaster: first?.FORECASTER ?? null,
    areas,
    hatches,
  };
}

export async function GET() {
  const results = await Promise.allSettled(REQUESTS.map(fetchOutlook));
  // A failed product/day is omitted rather than failing the whole request; the renderer
  // already has to handle a product SPC hasn't issued, which looks the same.
  const outlooks = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    outlooks,
    failures: results.filter((result) => result.status === "rejected").length,
  }, { headers: { "Cache-Control": "public, max-age=300, s-maxage=600, stale-while-revalidate=3600" } });
}
