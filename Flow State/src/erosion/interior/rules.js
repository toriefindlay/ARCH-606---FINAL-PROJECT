// MODEL (interior erosion): decides what to remove from inside the mass.
// Pure logic, with no THREE scene or DOM code, so it can be tested on its own.
//
// ctx = { mass, site, features, wind }: see erosion/combine.js.
// Return an array of cuts built with createCut() and the primitives in erosion/sdf.js
// (capsule() is the natural shape for a pathway between entrances and destinations).

export function provideCuts(ctx) {
  return [];
}
