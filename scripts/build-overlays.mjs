import { writeFile, readFile } from "node:fs/promises";

// State outlines are kept for a generous surrounding region; interstates are
// clipped tighter to the render frame. Anything past the canvas is clipped at
// draw time, so these boxes only need to be roughly right.
const REGION = { west: -80.5, east: -71.5, south: 37.0, north: 43.2 };
// Union of the four office render frames, rounded outward.
const FRAME = { west: -80.0, east: -71.6, south: 37.1, north: 42.2 };

const STATES_URL = "https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/10m/cultural/ne_10m_admin_1_states_provinces.json";
const ROADS_URL = "https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/10m/cultural/ne_10m_roads.json";
// Natural Earth road classes that read as the interstate / limited-access network.
const FREEWAY_TYPES = new Set(["Major Highway", "Beltway", "Bypass"]);

function touches(coordinates, box) {
  const stack = [coordinates];
  while (stack.length) {
    const node = stack.pop();
    if (typeof node[0] === "number") {
      const [lon, lat] = node;
      if (lon >= box.west && lon <= box.east && lat >= box.south && lat <= box.north) return true;
    } else {
      for (const child of node) stack.push(child);
    }
  }
  return false;
}

function round(node, factor) {
  if (typeof node[0] === "number") return [Math.round(node[0] * factor) / factor, Math.round(node[1] * factor) / factor];
  return node.map((child) => round(child, factor));
}

// State boundaries — high-resolution Natural Earth admin-1 (US only), light rounding to keep crisp coastlines
const statesRaw = process.env.NE_STATES_FILE
  ? await readFile(process.env.NE_STATES_FILE, "utf8")
  : await (async () => {
      const response = await fetch(STATES_URL);
      if (!response.ok) throw new Error(`states source ${response.status}`);
      return response.text();
    })();
const statesData = JSON.parse(statesRaw);
const states = statesData.features
  .filter((feature) => feature.properties?.admin === "United States of America" && touches(feature.geometry.coordinates, REGION))
  .map((feature) => ({
    type: "Feature",
    properties: { name: feature.properties.name },
    geometry: { type: feature.geometry.type, coordinates: round(feature.geometry.coordinates, 1e4) },
  }));
await writeFile(new URL("../public/states.geojson", import.meta.url), JSON.stringify({ type: "FeatureCollection", features: states }));
console.log(`states.geojson: ${states.length} features`);

// Interstate / major highway network (set NE_ROADS_FILE to reuse a local copy of the 67 MB source)
const roadsRaw = process.env.NE_ROADS_FILE
  ? await readFile(process.env.NE_ROADS_FILE, "utf8")
  : await (async () => {
      const response = await fetch(ROADS_URL);
      if (!response.ok) throw new Error(`roads source ${response.status}`);
      return response.text();
    })();
const roadsData = JSON.parse(roadsRaw);
const interstates = roadsData.features
  .filter((feature) => FREEWAY_TYPES.has(feature.properties?.type) && touches(feature.geometry.coordinates, FRAME))
  .map((feature) => ({
    type: "Feature",
    properties: { label: feature.properties.label ?? null },
    geometry: { type: feature.geometry.type, coordinates: round(feature.geometry.coordinates, 1e3) },
  }));
await writeFile(new URL("../public/interstates.geojson", import.meta.url), JSON.stringify({ type: "FeatureCollection", features: interstates }));
console.log(`interstates.geojson: ${interstates.length} features`);
