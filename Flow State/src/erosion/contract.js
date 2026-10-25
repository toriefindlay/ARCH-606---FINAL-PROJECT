import * as THREE from "three";

// THE CONTRACT between exterior and interior erosion.
//
// Neither side edits the mass. Each side returns a list of CUTS: volumes to remove, described
// as signed-distance functions. combine.js gathers every cut and the mass is carved by their union.
// Change this file only by agreement: both sides depend on it.
//
// A Cut:
//   id      string      unique and stable between runs, e.g. "ext-wind-notch-1"
//   source  string      "exterior" | "interior"
//   label   string      shown in the UI
//   bounds  THREE.Box3  world-space box that fully contains the removed volume
//   sdf     (x, y, z) => number
//                       signed distance in metres: negative inside the removed volume,
//                       zero on its surface, positive outside.
//
// World coordinates: metres, x = east, y = up, z = -north, site pin at the origin, mass base on y = 0.

export const SOURCES = ["exterior", "interior"];

export function createCut({ id, source, label = id, bounds, sdf }) {
  if (!id) throw new Error("A cut needs an id.");
  if (!SOURCES.includes(source)) throw new Error(`Cut "${id}": source must be one of ${SOURCES.join(", ")}.`);
  if (typeof sdf !== "function") throw new Error(`Cut "${id}": sdf must be a function (x, y, z) => distance.`);
  if (!(bounds instanceof THREE.Box3)) throw new Error(`Cut "${id}": bounds must be a THREE.Box3.`);
  return Object.freeze({ id, source, label, bounds, sdf });
}
