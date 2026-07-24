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

  // Anchored to the exact key shape the publisher writes:
  // releases/{releaseId}/{OFFICE}/day-{n}/{product}[-preview].png
  const ASSET_KEY = /^releases\/\d{8}T\d{6}Z\/[A-Z]{3}\/day-[1-3]\/[a-z][a-z-]*\.png$/;

  const { path } = await context.params;
  const assetKey = path.join("/");
  if (!ASSET_KEY.test(assetKey) || assetKey.includes("..")) {
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
        "Content-Type": response.headers.get("Content-Type") ?? "image/png",
        "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Published forecast image is unavailable" },
      { status: 502 },
    );
  }
}
