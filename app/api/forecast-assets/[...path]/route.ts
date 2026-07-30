import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const ASSET_BASE_URL = (process.env.NEXT_PUBLIC_FORECAST_ASSET_BASE_URL ?? "").replace(/\/+$/, "");

export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  if (!ASSET_BASE_URL) {
    return NextResponse.json(
      { error: "Published forecast assets are not configured" },
      { status: 503 },
    );
  }

  // Anchored to the key shapes the publisher writes. The office segment is optional so
  // that v1 releases (which predate multi-office and have no office in the path) keep
  // resolving until they age out of the retention window.
  // v2: releases/{releaseId}/{OFFICE}/day-{n}/{product}[-preview].png
  // v1: releases/{releaseId}/day-{n}/{product}[-preview].png
  //
  // An id is **two or three** uppercase letters. Three is a CWA; two is a wide view — `US`
  // and every area id, which lib/areas.mjs keeps at two letters precisely so they can never
  // collide with an office. This is not a loosened guard: `[A-Z]{3}` 400'd `forecast/US.json`
  // before any network call, and since /api/forecast 504s in production, that left the
  // national view with no data source there at all. The areas inherited the same fault.
  const ASSET_KEY = /^releases\/\d{8}T\d{6}Z\/(?:[A-Z]{2,3}\/)?day-[1-3]\/[a-z][a-z-]*\.png$/;
  // Precomputed gridpoint forecasts, one per view. These are what let a view render live
  // at all: /api/forecast fans out to ~250 api.weather.gov gridpoints per request and 504s
  // in production, so the fan-out happens once an hour in the publisher instead and this
  // route only relays the result.
  const FORECAST_KEY = /^forecast\/[A-Z]{2,3}\.json$/;

  const { path } = await context.params;
  const assetKey = path.join("/");
  const isForecast = FORECAST_KEY.test(assetKey);
  if ((!isForecast && !ASSET_KEY.test(assetKey)) || assetKey.includes("..")) {
    return NextResponse.json({ error: "Invalid forecast asset path" }, { status: 400 });
  }

  try {
    const encodedKey = path.map(encodeURIComponent).join("/");
    const response = await fetch(`${ASSET_BASE_URL}/${encodedKey}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok || !response.body) {
      return NextResponse.json(
        { error: `Published forecast image returned ${response.status}` },
        { status: 502 },
      );
    }

    return new NextResponse(response.body, {
      status: 200,
      headers: {
        "Content-Type": response.headers.get("Content-Type") ?? (isForecast ? "application/json" : "image/png"),
        // Releases are immutable and keyed by issuance time; a forecast is rewritten in
        // place whenever NWS reissues, so it can only be cached as long as we are willing
        // to show a stale one. Five minutes keeps repeat views free without outliving the
        // ten-minute publish cadence in the issuance windows.
        "Cache-Control": isForecast
          ? "public, max-age=300, s-maxage=300"
          : "public, max-age=31536000, s-maxage=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Published forecast image is unavailable" },
      { status: 502 },
    );
  }
}
