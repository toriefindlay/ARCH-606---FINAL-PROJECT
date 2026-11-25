// MODEL (exterior erosion): decides what to remove from the outside of the mass.
// Pure logic, with no THREE scene or DOM code, so it can be tested on its own.
//
// ctx = { mass, site, features, wind }: see erosion/combine.js.
// Return an array of cuts built with createCut() and the primitives in erosion/sdf.js.
//
// Built so far:
// Airflow test: voxelFlow.js solves the air speed round and through the mass (the base for the wind tunnels).
// Wind tunnels: the wind carves channels through the mass (see tunnels.js, tunnelCut.js).
import { activeTunnelCuts } from "./tunnelCut.js";

export function provideCuts(ctx) {
  return activeTunnelCuts();
}
