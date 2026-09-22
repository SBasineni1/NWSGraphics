// The sampling lattice for a wide view's mesoanalysis — the national map and the seven
// areas — written to public/meso-lattice/{VIEW}.json by scripts/build-meso-lattice.mjs.
//
// **Why the mesoanalysis gets a lattice of its own when an office does not.** Offices
// reuse the forecast lattice in public/gridpoints/, and so did the wide views until this
// existed. That lattice is sized by what a *forecast* point costs: one api.weather.gov
// gridpoint request per point on every publish, which is why US has ~780 of them and
// samples every ~135 km. A mesoanalysis point costs a nearest-neighbour lookup into a RAP
// grid already in memory. The wide views were borrowing a lattice sized for a constraint
// they do not have, and read visibly softer than the SPC panel beside them for it.
//
// **40 km, because that is SPC's grid.** SPC draws its mesoanalysis from the 40 km RAP, and
// the page exists to sit beside that panel. Coarser reads as blurrier than SPC; finer
// would draw detail SPC's panel cannot show, and next to it that disagreement reads as an
// error rather than as extra resolution. Offices are already finer than this (~15 km) and
// keep their own lattice.
//
// The grid is regular in **Web Mercator pixels**, the space the canvas is drawn in, so the
// spacing is uniform on the map. The step is 40 km at the frame's middle latitude; Mercator
// stretches it to ~33 km at the northern border and ~45 km at the Gulf, which is the same
// distortion every other layer on the map carries.

import { MAP_HEIGHT, PLOT_WIDTH, inverseWorld, plotExtent } from "./map-frame.mjs";
import { inPolygons, polygonsOf } from "./point-in-polygon.mjs";

export const MESO_STEP_KM = 40;

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

/**
 * @typedef {{ id: string, lat: number, lon: number }} LatticePoint
 * @typedef {{ office: string, bounds: import("./map-frame.mjs").Bounds, zoom: number, states: Array<{ type: string, coordinates: any }> }} ViewBundle
 */

/**
 * World pixels per `stepKm` at the middle of the view's frame.
 * @param {import("./map-frame.mjs").MapExtent} extent
 * @param {number} stepKm
 */
function stepInWorldPixels(extent, stepKm) {
  const middle = inverseWorld((extent.left + extent.right) / 2, (extent.top + extent.bottom) / 2, extent.zoom);
  const metresPerPixel = EARTH_CIRCUMFERENCE_M * Math.cos(middle.lat * Math.PI / 180) / (256 * 2 ** extent.zoom);
  return stepKm * 1000 / metresPerPixel;
}

/**
 * Lattice a wide view's frame at `stepKm`, keeping only the points on or next to land.
 *
 * **Land only, with a one-step buffer.** The renderer clips a wide view's raster to the
 * bundle's state polygons, so a point over the Atlantic or Mexico would be computed,
 * shipped and never drawn — at 40 km that is over a third of the national frame. The
 * buffer keeps the first offshore row, because the interpolation needs something on the
 * far side of a coastline or it smears the last inland value up to the clip edge.
 *
 * The grid also runs one step past every canvas edge, so the cells along the border have
 * neighbours on both sides.
 *
 * @param {ViewBundle} bundle
 * @param {number} [stepKm]
 * @returns {{ points: LatticePoint[], step: number, columns: number, rows: number }}
 */
export function buildMesoLattice(bundle, stepKm = MESO_STEP_KM) {
  const extent = plotExtent(bundle.bounds, PLOT_WIDTH, MAP_HEIGHT, bundle.zoom);
  const step = stepInWorldPixels(extent, stepKm);
  // Node 0 sits one step outside the left/top edge; the last one step past the right/bottom.
  const columns = Math.ceil((extent.right - extent.left) / step) + 3;
  const rows = Math.ceil((extent.bottom - extent.top) / step) + 3;

  const polygons = bundle.states.flatMap((geometry) => polygonsOf(geometry)).map((polygon) => {
    let west = Infinity; let east = -Infinity; let south = Infinity; let north = -Infinity;
    for (const [lon, lat] of polygon[0]) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
    return { polygon, west, east, south, north };
  });
  const onLand = (lon, lat) => polygons.some((entry) => lon >= entry.west && lon <= entry.east
    && lat >= entry.south && lat <= entry.north && inPolygons(lon, lat, [entry.polygon]));

  // One extra node on every side of the kept grid, so the buffer test below can look at a
  // neighbour of an edge node without a special case.
  const position = (column, row) => inverseWorld(extent.left + (column - 1) * step, extent.top + (row - 1) * step, extent.zoom);
  const land = new Uint8Array((columns + 2) * (rows + 2));
  for (let row = -1; row <= rows; row += 1) {
    for (let column = -1; column <= columns; column += 1) {
      const { lon, lat } = position(column, row);
      land[(row + 1) * (columns + 2) + (column + 1)] = onLand(lon, lat) ? 1 : 0;
    }
  }

  const points = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy += 1) {
        for (let dx = -1; dx <= 1 && !near; dx += 1) {
          near = land[(row + 1 + dy) * (columns + 2) + (column + 1 + dx)] === 1;
        }
      }
      if (!near) continue;
      const { lon, lat } = position(column, row);
      points.push({ id: `meso-${bundle.office}-${column}-${row}`, lat: +lat.toFixed(4), lon: +lon.toFixed(4) });
    }
  }
  return { points, step, columns, rows };
}
