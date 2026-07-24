import { writeFile } from "node:fs/promises";

// Resolve the labeled cities on each office's map to their owning NWS gridpoints.
// Authoring gridpoint x/y by hand is error-prone, and so is deciding which office owns a
// city near a CWA border — so the office each city is filed under is *verified* against
// what api.weather.gov actually reports, and a mismatch fails the build.
const USER_AGENT = "PHI Forecast Graphics (weather.gov/phi)";
const BATCH_SIZE = 8;

const CITIES = [
  // PHI — Philadelphia / Mount Holly NJ
  { office: "PHI", id: "phl", name: "Philadelphia", state: "PA", lat: 39.9526, lon: -75.1652 },
  { office: "PHI", id: "abe", name: "Allentown", state: "PA", lat: 40.6023, lon: -75.4714 },
  { office: "PHI", id: "rdg", name: "Reading", state: "PA", lat: 40.3356, lon: -75.9269 },
  { office: "PHI", id: "mpo", name: "Mt Pocono", state: "PA", lat: 41.122, lon: -75.3646 },
  { office: "PHI", id: "sus", name: "Sussex", state: "NJ", lat: 41.2098, lon: -74.6077 },
  { office: "PHI", id: "mmu", name: "Morristown", state: "NJ", lat: 40.7968, lon: -74.4815 },
  { office: "PHI", id: "smq", name: "Somerville", state: "NJ", lat: 40.5743, lon: -74.6099 },
  { office: "PHI", id: "ttn", name: "Trenton", state: "NJ", lat: 40.2171, lon: -74.7429 },
  { office: "PHI", id: "lgb", name: "Long Branch", state: "NJ", lat: 40.3043, lon: -73.9924 },
  { office: "PHI", id: "tom", name: "Toms River", state: "NJ", lat: 39.9537, lon: -74.1979 },
  { office: "PHI", id: "ilg", name: "Wilmington", state: "DE", lat: 39.7447, lon: -75.5484 },
  { office: "PHI", id: "vin", name: "Vineland", state: "NJ", lat: 39.4862, lon: -75.0257 },
  { office: "PHI", id: "dov", name: "Dover", state: "DE", lat: 39.1582, lon: -75.5244 },
  { office: "PHI", id: "acy", name: "Atlantic City", state: "NJ", lat: 39.3643, lon: -74.4229 },
  { office: "PHI", id: "cap", name: "Cape May", state: "NJ", lat: 38.9351, lon: -74.906 },
  { office: "PHI", id: "bet", name: "Bethany Beach", state: "DE", lat: 38.5396, lon: -75.0552 },
  { office: "PHI", id: "eas", name: "Easton", state: "MD", lat: 38.7743, lon: -76.0763 },

  // OKX — New York City / Upton NY
  { office: "OKX", id: "nyc", name: "New York", state: "NY", lat: 40.7831, lon: -73.9712 },
  { office: "OKX", id: "ewr", name: "Newark", state: "NJ", lat: 40.7357, lon: -74.1724 },
  { office: "OKX", id: "jrc", name: "Jersey City", state: "NJ", lat: 40.7178, lon: -74.0431 },
  { office: "OKX", id: "ptn", name: "Paterson", state: "NJ", lat: 40.9168, lon: -74.1718 },
  { office: "OKX", id: "hpn", name: "White Plains", state: "NY", lat: 41.034, lon: -73.7629 },
  { office: "OKX", id: "hem", name: "Hempstead", state: "NY", lat: 40.7062, lon: -73.6187 },
  { office: "OKX", id: "isp", name: "Islip", state: "NY", lat: 40.7298, lon: -73.2107 },
  { office: "OKX", id: "rvh", name: "Riverhead", state: "NY", lat: 40.917, lon: -72.662 },
  { office: "OKX", id: "mtk", name: "Montauk", state: "NY", lat: 41.0359, lon: -71.9545 },
  { office: "OKX", id: "bdr", name: "Bridgeport", state: "CT", lat: 41.1865, lon: -73.1952 },
  { office: "OKX", id: "hvn", name: "New Haven", state: "CT", lat: 41.3083, lon: -72.9279 },
  { office: "OKX", id: "dxr", name: "Danbury", state: "CT", lat: 41.3948, lon: -73.454 },
  { office: "OKX", id: "gon", name: "New London", state: "CT", lat: 41.3557, lon: -72.0995 },

  // CTP — Central Pennsylvania / State College PA
  { office: "CTP", id: "mdt", name: "Harrisburg", state: "PA", lat: 40.2732, lon: -76.8867 },
  { office: "CTP", id: "unv", name: "State College", state: "PA", lat: 40.7934, lon: -77.86 },
  { office: "CTP", id: "ipt", name: "Williamsport", state: "PA", lat: 41.2412, lon: -77.0011 },
  { office: "CTP", id: "aoo", name: "Altoona", state: "PA", lat: 40.5187, lon: -78.3947 },
  { office: "CTP", id: "jst", name: "Johnstown", state: "PA", lat: 40.3267, lon: -78.922 },
  { office: "CTP", id: "lns", name: "Lancaster", state: "PA", lat: 40.0379, lon: -76.3055 },
  { office: "CTP", id: "thv", name: "York", state: "PA", lat: 39.9626, lon: -76.7277 },
  { office: "CTP", id: "dub", name: "DuBois", state: "PA", lat: 41.1195, lon: -78.7603 },
  { office: "CTP", id: "bfd", name: "Bradford", state: "PA", lat: 41.9581, lon: -78.6389 },
  { office: "CTP", id: "wel", name: "Wellsboro", state: "PA", lat: 41.7487, lon: -77.305 },
  { office: "CTP", id: "cbg", name: "Chambersburg", state: "PA", lat: 39.9376, lon: -77.6611 },
  { office: "CTP", id: "som", name: "Somerset", state: "PA", lat: 40.0084, lon: -79.0781 },
  { office: "CTP", id: "lew", name: "Lewistown", state: "PA", lat: 40.5992, lon: -77.5714 },
  { office: "CTP", id: "sel", name: "Selinsgrove", state: "PA", lat: 40.7987, lon: -76.8622 },

  // LWX — Baltimore MD / Washington DC, from Sterling VA
  { office: "LWX", id: "dca", name: "Washington", state: "DC", lat: 38.9072, lon: -77.0369 },
  { office: "LWX", id: "bwi", name: "Baltimore", state: "MD", lat: 39.2904, lon: -76.6122 },
  { office: "LWX", id: "fdk", name: "Frederick", state: "MD", lat: 39.4143, lon: -77.4105 },
  { office: "LWX", id: "hgr", name: "Hagerstown", state: "MD", lat: 39.6418, lon: -77.72 },
  { office: "LWX", id: "cbe", name: "Cumberland", state: "MD", lat: 39.6529, lon: -78.7625 },
  { office: "LWX", id: "anp", name: "Annapolis", state: "MD", lat: 38.9784, lon: -76.4922 },
  { office: "LWX", id: "okv", name: "Winchester", state: "VA", lat: 39.1857, lon: -78.1633 },
  { office: "LWX", id: "cho", name: "Charlottesville", state: "VA", lat: 38.0293, lon: -78.4767 },
  { office: "LWX", id: "ezf", name: "Fredericksburg", state: "VA", lat: 38.3032, lon: -77.4605 },
  { office: "LWX", id: "hef", name: "Manassas", state: "VA", lat: 38.7509, lon: -77.4753 },
  { office: "LWX", id: "cjr", name: "Culpeper", state: "VA", lat: 38.4735, lon: -77.9961 },
  { office: "LWX", id: "mrb", name: "Martinsburg", state: "WV", lat: 39.4562, lon: -77.9639 },
  { office: "LWX", id: "lwt", name: "Leonardtown", state: "MD", lat: 38.2915, lon: -76.6358 },
  { office: "LWX", id: "luu", name: "Luray", state: "VA", lat: 38.6654, lon: -78.4594 },
];

async function resolve(city) {
  const response = await fetch(`https://api.weather.gov/points/${city.lat.toFixed(4)},${city.lon.toFixed(4)}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`${city.name}, ${city.state}: points lookup returned ${response.status}`);
  const properties = (await response.json()).properties;
  if (!properties?.gridId || properties.gridX == null || properties.gridY == null) {
    throw new Error(`${city.name}, ${city.state}: no gridpoint in the points response`);
  }
  return { wfo: properties.gridId, x: properties.gridX, y: properties.gridY };
}

const duplicates = CITIES.map((city) => city.id).filter((id, index, all) => all.indexOf(id) !== index);
if (duplicates.length) throw new Error(`Duplicate city ids: ${[...new Set(duplicates)].join(", ")}`);

const resolved = [];
const mismatches = [];
for (let index = 0; index < CITIES.length; index += BATCH_SIZE) {
  const batch = CITIES.slice(index, index + BATCH_SIZE);
  const results = await Promise.all(batch.map(async (city) => ({ city, grid: await resolve(city) })));
  for (const { city, grid } of results) {
    if (grid.wfo !== city.office) {
      mismatches.push(`${city.name}, ${city.state} is filed under ${city.office} but NWS assigns it to ${grid.wfo}`);
      continue;
    }
    resolved.push({
      id: city.id,
      name: city.name,
      state: city.state,
      office: city.office,
      lat: city.lat,
      lon: city.lon,
      x: grid.x,
      y: grid.y,
    });
  }
}

if (mismatches.length) {
  throw new Error(`Cities assigned to the wrong office:\n  ${mismatches.join("\n  ")}`);
}

await writeFile(new URL("../app/api/forecast/city-points.json", import.meta.url), JSON.stringify(resolved, null, 2));
const counts = resolved.reduce((totals, city) => ({ ...totals, [city.office]: (totals[city.office] ?? 0) + 1 }), {});
console.log(`city-points.json: ${resolved.length} cities (${Object.entries(counts).map(([office, count]) => `${office} ${count}`).join(", ")})`);
