import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const ASSET_BASE_URL = (process.env.NEXT_PUBLIC_FORECAST_ASSET_BASE_URL ?? "").replace(/\/+$/, "");

export async function GET() {
  if (!ASSET_BASE_URL) {
    return NextResponse.json(
      { error: "Published forecast assets are not configured" },
      { status: 503 },
    );
  }

  try {
    const response = await fetch(`${ASSET_BASE_URL}/latest.json`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `Published forecast manifest returned ${response.status}` },
        { status: 502 },
      );
    }

    return new NextResponse(await response.text(), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Published forecast manifest is unavailable" },
      { status: 502 },
    );
  }
}
