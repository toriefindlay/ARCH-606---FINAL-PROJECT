// MODEL (exterior erosion): decides what to remove from the outside of the mass.
// Pure logic, with no THREE scene or DOM code, so it can be tested on its own.
//
// ctx = { mass, site, features, wind }: see erosion/combine.js.
// Return an array of cuts built with createCut() and the primitives in erosion/sdf.js.
//
// Built so far:
// Wind erosion: the prevailing wind slowly rounds the mass's convex edges, windward ones first (see windErode.js).
// Sun growth: the mass grows towards the sun, most where it is warmest (see sunGrow.js). Both work on the same form
// (see form.js), one at a time, each continuing from the shape the other left.
// Airflow test: voxelFlow.js solves the air speed round and through the mass (the base for the wind tunnels).
// Wind tunnels: the wind carves channels through the mass (see tunnels.js, tunnelCut.js).
import { activeFormCuts } from "./windErode.js";
import { activeTunnelCuts } from "./tunnelCut.js";

export function provideCuts(ctx) {
  return [...activeFormCuts(), ...activeTunnelCuts()];
}
