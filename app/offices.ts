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
  name: string;
  offices: Office[];
};

export const REGIONS: Region[] = [
  {
    id: "eastern",
    name: "Eastern Region",
    offices: [
      { id: "PHI", city: "Mount Holly", state: "NJ", label: "Philadelphia / Mount Holly" },
      { id: "OKX", city: "Upton", state: "NY", label: "New York City" },
      { id: "CTP", city: "State College", state: "PA", label: "Central Pennsylvania" },
      { id: "LWX", city: "Sterling", state: "VA", label: "Baltimore / Washington" },
    ],
  },
];

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
