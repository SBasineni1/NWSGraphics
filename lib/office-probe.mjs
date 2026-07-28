// When NWS last revised an office's grids, for the cost of a request that downloads
// nothing.
//
// A GET on a gridpoint is ~285 KB; HEAD returns the same `last-modified` with a zero-byte
// body. That is what makes probing 122 offices affordable: refreshing them all blindly
// would be ~35,000 upstream requests every run.
//
// Plain .mjs beside map-frame.mjs and place-search.mjs so node --test imports it
// directly, and so the publisher, the pre-build probe gate and the edge route all share
// one implementation instead of three that can drift.

export const PROBE_USER_AGENT = "NWS Forecast Graphics (github.com/suchitbasineni/NWSGraphics)";

/**
 * The city a probe speaks for. The list is already ordered by the ranking
 * build-office-cities.mjs applied, so the first entry is the office's most significant
 * place and a fine stand-in for the office as a whole.
 *
 * @param {{ wfo: string, x: number, y: number }[] | undefined} cities
 */
export function anchorFor(cities) {
  if (!Array.isArray(cities) || !cities.length) return null;
  return cities[0];
}

/**
 * `wfo` is the *gridpoint domain*, which is not the office id outside CONUS: NWS splits
 * AFC into AER and ALU. The gridpoint API only accepts the domain.
 */
export function gridpointUrl(anchor) {
  return `https://api.weather.gov/gridpoints/${anchor.wfo}/${anchor.x},${anchor.y}`;
}

/** `last-modified` for one anchor, or null if it cannot be established. */
export async function probeAnchor(anchor, fetchImpl) {
  if (!anchor) return null;
  try {
    const response = await fetchImpl(gridpointUrl(anchor), {
      method: "HEAD",
      headers: { "User-Agent": PROBE_USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    return response.headers.get("last-modified");
  } catch {
    return null;
  }
}

/** Unknown on either side means we cannot prove it is unchanged, so refresh it. */
export function officeIsStale(previousProbe, currentProbe) {
  if (!previousProbe || !currentProbe) return true;
  return previousProbe !== currentProbe;
}

/** The offices a run must refetch. */
export function staleOfficesFrom(offices, probes, previousIndex, forcePublish) {
  return offices.filter((office) => {
    if (forcePublish) return true;
    return officeIsStale(previousIndex[office]?.probe, probes[office] ?? null);
  });
}
