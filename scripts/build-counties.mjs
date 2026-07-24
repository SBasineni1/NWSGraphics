import { writeFile } from "node:fs/promises";

const SOURCE = "https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json";
// State FIPS prefixes that intersect the render frames of every covered office:
// NJ, PA, DE, MD, NY, VA plus WV, CT, RI, MA and DC for the CTP/LWX/OKX frames.
const STATES = new Set(["34", "42", "10", "24", "36", "51", "54", "09", "44", "25", "11"]);
// Union of the four office render frames, rounded outward.
const BBOX = { west: -80.0, east: -71.6, south: 37.1, north: 42.2 };

function touchesBbox(coordinates) {
  const stack = [coordinates];
  while (stack.length) {
    const node = stack.pop();
    if (typeof node[0] === "number") {
      const [lon, lat] = node;
      if (lon >= BBOX.west && lon <= BBOX.east && lat >= BBOX.south && lat <= BBOX.north) return true;
    } else {
      for (const child of node) stack.push(child);
    }
  }
  return false;
}

function round(node) {
  if (typeof node[0] === "number") return [Math.round(node[0] * 1e4) / 1e4, Math.round(node[1] * 1e4) / 1e4];
  return node.map(round);
}

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`county source ${response.status}`);
const data = await response.json();

const features = data.features
  .filter((feature) => STATES.has(String(feature.id).slice(0, 2)) && touchesBbox(feature.geometry.coordinates))
  .map((feature) => ({
    type: "Feature",
    id: String(feature.id),
    properties: { fips: String(feature.id) },
    geometry: { type: feature.geometry.type, coordinates: round(feature.geometry.coordinates) },
  }));

await writeFile(new URL("../public/counties.geojson", import.meta.url), JSON.stringify({ type: "FeatureCollection", features }));
console.log(`counties.geojson: ${features.length} features`);
