// The unofficial multi-state views that sit between one forecast office and the whole
// country. NWS does not publish these groupings — they are an editorial convenience for
// regional forecasts, which is exactly why they live here as data rather than being
// derived from anything upstream.
//
// **These are not `REGIONS`.** That name is already taken in app/offices.ts by the six
// *official* NWS regions (Eastern, Southern, Central, Western, Alaska, Pacific), which
// group offices administratively and look nothing like these. CLAUDE.md calls the concept
// above an office an "area", so that is the word used throughout.
//
// Ids are deliberately **two letters**, because every real CWA is exactly three — so an
// area id can never collide with an office id, in a URL, an asset filename or the picker.
//
// Alaska, Hawaii and the territories are absent on purpose: they have their own offices,
// and folding them into a CONUS area would shrink the mainland to a corner of the canvas
// for the same reason the national view is the lower 48.

export const AREAS = [
  { id: "NW", label: "North West", states: ["WA", "OR", "ID", "MT", "WY"] },
  { id: "WE", label: "West", states: ["CA", "NV"] },
  { id: "SW", label: "South West", states: ["UT", "CO", "AZ", "NM", "TX", "OK"] },
  { id: "MW", label: "Mid-West", states: ["ND", "SD", "NE", "KS", "MN", "IA", "MO", "WI", "IL", "IN", "MI", "OH", "KY"] },
  { id: "SE", label: "South East", states: ["AR", "LA", "MS", "AL", "TN", "GA", "FL", "SC", "NC"] },
  { id: "MA", label: "Mid-Atlantic", states: ["NY", "PA", "NJ", "DE", "MD", "DC", "VA", "WV"] },
  { id: "NE", label: "North East", states: ["ME", "NH", "VT", "MA", "RI", "CT"] },
];

export const AREA_IDS = AREAS.map((area) => area.id);
export const isAreaId = (id) => AREA_IDS.includes(id);

/** The national view. Kept beside the areas since every script treats them alike. */
export const NATIONAL_ID = "US";

/** Any synthetic view — an area or the nation — as opposed to a real forecast office. */
export const isWideView = (id) => id === NATIONAL_ID || isAreaId(id);

/**
 * Breathing room around the member states' bounding box, in degrees.
 *
 * `plotExtent` already adds slack on whichever axis the 900×760 canvas is not constrained
 * by, so this only matters for the tight axis — without it a coastline sits flush against
 * the canvas edge with its labels half off.
 */
export const AREA_PADDING = 0.35;

/**
 * How densely each kind of view is sampled and labelled.
 *
 * An area covers far more ground than one CWA but far less than the country, and both of
 * those numbers were tuned for their own scale: the office lattice at ~340 points would
 * leave a 13-state area visibly under-resolved, while the national 1,800 is more than a
 * regional frame can show.
 */
export const VIEW_TARGETS = {
  office: { points: 340, cities: 14 },
  area: { points: 900, cities: 20 },
  national: { points: 1800, cities: 26 },
};

export const targetsFor = (id) =>
  id === NATIONAL_ID ? VIEW_TARGETS.national : isAreaId(id) ? VIEW_TARGETS.area : VIEW_TARGETS.office;
