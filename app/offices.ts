// Single source of truth for which NWS forecast offices the site covers. Adding an
// office means adding an entry here and re-running scripts/build-cwa.mjs,
// build-grid-points.mjs, and build-city-points.mjs.

export type OfficeId = "PHI" | "OKX" | "CTP" | "LWX";

export type Office = {
  id: OfficeId;
  /** The office's own location, as NWS states it. */
  city: string;
  state: string;
  /** How the office is named to readers. */
  label: string;
};

export type Region = {
  id: string;
  /** NWS's own shorthand for the region, e.g. ER. */
  short: string;
  name: string;
  /** Where NWS headquarters the region, as it labels it. */
  hq: string;
  offices: Office[];
};

// All six NWS regions are listed so the picker is the real map from the start; only the
// ones with offices below are selectable. Filling a region in means adding its offices
// here and re-running the build scripts — nothing in the picker needs touching.
export const REGIONS: Region[] = [
  {
    id: "eastern",
    short: "ER",
    name: "Eastern Region",
    hq: "Bohemia, NY",
    offices: [
      { id: "PHI", city: "Mount Holly", state: "NJ", label: "Philadelphia / Mount Holly" },
      { id: "OKX", city: "Upton", state: "NY", label: "New York City" },
      { id: "CTP", city: "State College", state: "PA", label: "Central Pennsylvania" },
      { id: "LWX", city: "Sterling", state: "VA", label: "Baltimore / Washington" },
    ],
  },
  { id: "central", short: "CR", name: "Central Region", hq: "Kansas City, MO", offices: [] },
  { id: "southern", short: "SR", name: "Southern Region", hq: "Fort Worth, TX", offices: [] },
  { id: "western", short: "WR", name: "Western Region", hq: "Salt Lake City, UT", offices: [] },
  { id: "alaska", short: "AR", name: "Alaska Region", hq: "Anchorage, AK", offices: [] },
  { id: "pacific", short: "PR", name: "Pacific Region", hq: "Honolulu, HI", offices: [] },
];

export function findRegion(id: string | null | undefined) {
  return REGIONS.find((region) => region.id === id) ?? null;
}

/** The region that forecasts a given office, for opening the picker where you are. */
export function regionOf(office: OfficeId) {
  return REGIONS.find((region) => region.offices.some((entry) => entry.id === office)) ?? REGIONS[0];
}

export const OFFICES: Office[] = REGIONS.flatMap((region) => region.offices);
export const OFFICE_IDS: OfficeId[] = OFFICES.map((office) => office.id);
export const DEFAULT_OFFICE: OfficeId = "PHI";

export function isOfficeId(value: string | null | undefined): value is OfficeId {
  return typeof value === "string" && (OFFICE_IDS as string[]).includes(value);
}

/** Unknown or missing ids fall back to the default office rather than erroring. */
export function findOffice(value: string | null | undefined): Office {
  const id = isOfficeId(value) ? value : DEFAULT_OFFICE;
  return OFFICES.find((office) => office.id === id)!;
}
