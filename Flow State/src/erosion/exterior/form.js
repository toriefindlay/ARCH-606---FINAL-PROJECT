// MODEL (exterior erosion): the shape of the mass that the wind tunnels are carved from.
// No scene or DOM code. It is a height map of the placed mass (see massScan.js). voxelFlow.js builds the 3D version of it.
import { scanMass } from "./massScan.js";

const MAX_CELLS = 90; // per side
const MIN_CELL = 0.5; // metres
const MAX_HEIGHT_CELLS = 70; // the grid is at most this many cells tall, so a tall mass gets coarser cells

// info: getMassInfo(). Returns null if the mass has no geometry.
export function createForm(info) {
  const scan = scanMass(info, { maxCells: MAX_CELLS, minCell: Math.max(MIN_CELL, info.bounds.max.y / MAX_HEIGHT_CELLS), sub: 1 });
  if (!scan) return null;
  const top = scan.hf.reduce((m, h) => Math.max(m, h), 0);
  if (top <= 0) return null;
  const { cu, cv } = scan;
  // The grid reaches a margin past the mass.
  const room = Math.min(10, Math.max(2, 0.2 * Math.min(scan.nU * cu, scan.nV * cv))) + 1; // metres
  const px = Math.ceil(room / cu), pz = Math.ceil(room / cv);
  const nx = scan.nU + 2 * px, nz = scan.nV + 2 * pz;
  const u0 = scan.u0 - px * cu, v0 = scan.v0 - pz * cv;
  const hf = new Float32Array(nx * nz);
  for (let j = 0; j < scan.nV; j++) hf.set(scan.hf.subarray(j * scan.nU, (j + 1) * scan.nU), (j + pz) * nx + px);
  const form = {
    nx, nz, cx: cu, cz: cv, x0: u0, z0: v0, // cell (i, j) spans x0 + i * cx .. and z0 + j * cz ..
    top,
    h0: hf, // the mass as placed
    heights: Float32Array.from(hf), // the mass now
    version: 0, // changes whenever the shape does
  };

  // The height of the form at a world (x, z) (nearest column), 0 off it.
  form.heightAt = (x, z) => {
    const i = Math.floor((x - u0) / cu), j = Math.floor((z - v0) / cv);
    return i < 0 || j < 0 || i >= nx || j >= nz ? 0 : form.heights[j * nx + i];
  };

  return form;
}
