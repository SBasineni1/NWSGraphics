import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "edge";

const SPC_ROOT = "https://www.spc.noaa.gov/exper/mesoanalysis";
const SECTORS = new Set(["11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22"]);
const PRODUCTS = new Set(["sbcp", "mlcp", "mucp", "lllr", "laps", "lclh", "pwtr", "srh1", "srh3", "shr6"]);
const REQUEST_HEADERS = {
  Accept: "image/gif,image/*;q=0.9,*/*;q=0.8",
  // SPC's legacy image host is noticeably more reliable when the caller is identified.
  "User-Agent": "NWSGraphics/0.1 (+https://github.com/SBasineni1/NWSGraphics)",
};

function retryDelay() {
  return new Promise((resolve) => setTimeout(resolve, 250));
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const sector = query.get("sector") ?? "";
  const product = query.get("product") ?? "";
  const stamp = query.get("stamp") ?? "";
  if (!SECTORS.has(sector) || !PRODUCTS.has(product) || !/^\d{8}$/.test(stamp)) {
    return NextResponse.json({ error: "Invalid SPC mesoanalysis archive key" }, { status: 400 });
  }

  const source = `${SPC_ROOT}/s${sector}/${product}/${product}_${stamp}.gif`;
  let failure = "SPC archive is unavailable";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(source, {
        headers: REQUEST_HEADERS,
        signal: AbortSignal.timeout(30_000),
        // The timestamp is part of the archive key, so a successful GIF is immutable.
        // Cloudflare Workers does not implement RequestInit.cache="force-cache"; using
        // that browser cache mode made the relay throw before contacting SPC in local
        // development. Ask Cloudflare's edge cache directly instead.
        cf: { cacheTtl: 31_536_000, cacheEverything: true },
      } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
      const contentType = response.headers.get("Content-Type") ?? "";
      if (response.ok && response.body && contentType.toLowerCase().startsWith("image/gif")) {
        return new NextResponse(response.body, {
          status: 200,
          headers: {
            "Content-Type": "image/gif",
            // The timestamp is part of the key. Once SPC writes an archive GIF it is an
            // immutable comparison artifact and may be cached at the browser and edge.
            "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
          },
        });
      }
      failure = `SPC archive returned ${response.status}`;
      // A missing archive hour is definitive. Retrying only helps upstream/server faults.
      if (response.status >= 400 && response.status < 500) break;
    } catch {
      failure = "SPC archive request failed";
    }
    if (attempt === 0) await retryDelay();
  }
  return NextResponse.json({ error: failure }, { status: 502, headers: { "Cache-Control": "no-store" } });
}
