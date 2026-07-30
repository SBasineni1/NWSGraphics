import { NextResponse } from "next/server";

export const runtime = "edge";

// Active NWS watches, warnings and advisories for one office's zones.
//
// Proxied rather than fetched from the browser so the response rides Cloudflare's edge
// cache instead of hitting api.weather.gov once per visitor, and so the User-Agent NWS
// asks for is attached server-side.
//
// **This route is affordable where /api/forecast is not.** It makes exactly one upstream
// request no matter how many zones are asked for, because the alerts endpoint takes the
// whole zone list as repeated `zone` parameters. That is the difference between this and
// the ~250-subrequest fan-out that keeps /api/forecast off the production path.
//
// The cache window is deliberately short. A tornado warning has a lifetime measured in
// tens of minutes, so the 5–15 minute windows used for forecast and outlook data would be
// actively misleading here.
const UPSTREAM = "https://api.weather.gov/alerts/active";
const CACHE_SECONDS = 60;

// A UGC zone code: two-letter state or marine prefix, C (county) or Z (forecast/marine),
// three digits. Validated rather than passed through because the values land in an
// outbound URL — anything not matching this shape is dropped, so a crafted `zones`
// parameter cannot reshape the upstream request or reach a different endpoint.
const ZONE_CODE = /^[A-Z]{2}[CZ]\d{3}$/;
// An office carries every zone reaching its render frame, not just the ones it issues for,
// so the list is far longer than its own CWA: LWX is the largest at 367, which builds a
// 2,573-character query the upstream answers with a 200. The cap is set well clear of that
// and exists to bound the outbound URL, which the upstream rejects past ~8 KB.
const MAX_ZONES = 1000;

type AlertGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

export type AlertRecord = {
  id: string;
  event: string;
  severity: string | null;
  urgency: string | null;
  certainty: string | null;
  headline: string | null;
  areaDesc: string | null;
  description: string | null;
  instruction: string | null;
  senderName: string | null;
  sent: string | null;
  onset: string | null;
  ends: string | null;
  expires: string | null;
  /**
   * UGC codes, not the URLs the upstream ships. The client joins these against the
   * geometry in public/zones/{OFFICE}.json — most alerts carry no geometry of their own.
   */
  zones: string[];
  /**
   * Present only for the minority of alerts issued with a polygon (storm-based warnings
   * mostly). When it is there it is more precise than the zones and should be drawn
   * instead of them.
   */
  geometry: AlertGeometry | null;
};

function isDrawable(geometry: unknown): geometry is AlertGeometry {
  if (!geometry || typeof geometry !== "object") return false;
  const { type, coordinates } = geometry as { type?: string; coordinates?: unknown };
  return (type === "Polygon" || type === "MultiPolygon") && Array.isArray(coordinates) && coordinates.length > 0;
}

export async function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  // A wide view — the nation or one of the multi-state areas — asks for everything in
  // force and narrows it itself, because it *cannot* ask by zone: the national frame
  // reaches 7,451 of them, and even the comma form runs the outbound URL past the ~8 KB
  // the upstream accepts long before that. Unfiltered is one request and ~250 alerts,
  // and the same response then serves the national view and all seven areas — each
  // keeps the alerts naming a zone it actually carries. Cheaper than asking per view.
  const nationwide = parameters.get("scope") === "all";
  const requested = (parameters.get("zones") ?? "")
    .split(",")
    .map((zone) => zone.trim().toUpperCase())
    .filter((zone) => ZONE_CODE.test(zone));
  const zones = [...new Set(requested)].slice(0, MAX_ZONES);

  // No valid zone means nothing to ask about. Answering with an empty list rather than an
  // error keeps the panel's "no active alerts" state and a bad request on the same path.
  if (!zones.length && !nationwide) {
    return NextResponse.json(
      { generatedAt: new Date().toISOString(), alerts: [], zones: 0 },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // **One comma-joined `zone` value, never repeated `zone=` parameters.** Repeating them
  // does not union the zones — the upstream returns fewer results as you add more, and at
  // 66 zones it returns nothing at all, which reads exactly like a quiet weather day. The
  // comma form is monotonic: 1 zone → 5 alerts, 5 → 8, 20 → 11, 66 → 16, matching what
  // the office actually has in force.
  const query = new URLSearchParams(nationwide ? {} : { zone: zones.join(",") });

  let response: Response;
  try {
    response = await fetch(`${UPSTREAM}?${query}`, {
      headers: {
        // NWS asks every client to identify itself and rate-limits those that don't.
        "User-Agent": "(nws-forecast-graphics, github.com/suchit)",
        Accept: "application/geo+json",
      },
      signal: AbortSignal.timeout(15_000),
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
  } catch {
    return NextResponse.json(
      { error: "Alerts unavailable", alerts: [], zones: zones.length },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!response.ok) {
    return NextResponse.json(
      { error: "Alerts unavailable", alerts: [], zones: zones.length },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const payload = await response.json() as { features?: Array<{ id?: string; geometry?: unknown; properties?: Record<string, unknown> }> };
  const alerts: AlertRecord[] = (payload.features ?? []).map((feature) => {
    const p = feature.properties ?? {};
    return {
      id: String(p.id ?? feature.id ?? ""),
      event: String(p.event ?? "Weather Alert"),
      severity: (p.severity as string) ?? null,
      urgency: (p.urgency as string) ?? null,
      certainty: (p.certainty as string) ?? null,
      headline: (p.headline as string) ?? null,
      areaDesc: (p.areaDesc as string) ?? null,
      description: (p.description as string) ?? null,
      instruction: (p.instruction as string) ?? null,
      senderName: (p.senderName as string) ?? null,
      sent: (p.sent as string) ?? null,
      onset: (p.onset as string) ?? null,
      ends: (p.ends as string) ?? null,
      expires: (p.expires as string) ?? null,
      // `affectedZones` ships full URLs; only the trailing UGC code is useful to the join.
      zones: ((p.affectedZones as string[]) ?? []).map((url) => url.split("/").pop() ?? "").filter(Boolean),
      geometry: isDrawable(feature.geometry) ? feature.geometry : null,
    };
  });

  return NextResponse.json(
    { generatedAt: new Date().toISOString(), alerts, zones: zones.length },
    { headers: { "Cache-Control": `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=300` } },
  );
}
