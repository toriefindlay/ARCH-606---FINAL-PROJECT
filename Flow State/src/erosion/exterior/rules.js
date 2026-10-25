// MODEL (exterior erosion): decides what to remove from the outside of the mass.
// Pure logic, with no THREE scene or DOM code, so it can be tested on its own.
//
// ctx = { mass, site, features, wind }: see erosion/combine.js.
// Return an array of cuts built with createCut() and the primitives in erosion/sdf.js.
//
// Ideas the site data supports: open the form toward entrances and pedestrian paths, notch it
// away from neighbouring buildings, step it back for sun (see site/sun.js), channel or shelter
// from the prevailing wind (ctx.wind.from).
//
// Built so far: flow erosion. People and cars passing through the mass wear tunnels into it,
// shaped by the mass's own geometry (see erosion.js and language.js).
import { activeErosionCuts } from "./erosion.js";

export function provideCuts(ctx) {
  return activeErosionCuts();
}
