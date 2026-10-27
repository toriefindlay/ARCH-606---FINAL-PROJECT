// MODEL (exterior erosion): the one shape that the sun, the wind and the pedestrians all work on.
// No scene or DOM code. It is a height map of the placed mass (see massScan.js). The sun adds to it (sunGrow.js), the wind
// rounds it (windErode.js) and the traffic carves it (erosion.js); each starts from whatever shape the others left, so the
// mass is always one form. Only one of them works at a time (see the panel).
import { scanMass } from "./massScan.js";

const MAX_CELLS = 90; // per side
const MIN_CELL = 0.5; // metres
const MAX_HEIGHT_CELLS = 70; // the grid is at most this many cells tall, so a tall mass gets coarser cells
const SAME = 0.02; // metres

// info: getMassInfo(). Returns null if the mass has no geometry.
export function createForm(info) {
  const scan = scanMass(info, { maxCells: MAX_CELLS, minCell: Math.max(MIN_CELL, info.bounds.max.y / MAX_HEIGHT_CELLS), sub: 1 });
  if (!scan) return null;
  const top = scan.hf.reduce((m, h) => Math.max(m, h), 0);
  if (top <= 0) return null;
  const { cu, cv } = scan;
  // The grid reaches past the mass, so that the sun has room to grow it outwards (as far as sunGrow.js lets a surface grow).
  const room = Math.min(10, Math.max(2, 0.2 * Math.min(scan.nU * cu, scan.nV * cv))) + 1; // metres
  const px = Math.ceil(room / cu), pz = Math.ceil(room / cv);
  const nx = scan.nU + 2 * px, nz = scan.nV + 2 * pz;
  const u0 = scan.u0 - px * cu, v0 = scan.v0 - pz * cv;
  const hf = new Float32Array(nx * nz);
  for (let j = 0; j < scan.nV; j++) hf.set(scan.hf.subarray(j * scan.nU, (j + 1) * scan.nU), (j + pz) * nx + px);
  const cells = nx * nz;
  const form = {
    nx, nz, cx: cu, cz: cv, x0: u0, z0: v0, // cell (i, j) spans x0 + i * cx .. and z0 + j * cz ..
    top,
    h0: hf, // the mass as placed
    heights: Float32Array.from(hf), // the mass now
    heat: new Float32Array(cells), // 0..1: how much the sun has warmed each column (colours what grew)
    wear: new Float32Array(cells), // 0..1: how much the wind has worn each column (colours what was rounded)
    version: 0, // changes whenever the shape does
  };

  // Is any column higher / lower than it was placed?
  form.grown = () => form.heights.some((h, k) => h > hf[k] + SAME);
  form.lowered = () => form.heights.some((h, k) => h < hf[k] - SAME);
  form.changed = () => form.grown() || form.lowered();

  // The shape as a height map in scanMass()'s shape, for the wind streaks to flow around and the traffic to walk into.
  form.asScan = () => ({ nU: nx, nV: nz, cu, cv, u0, v0, hf: form.heights, hw: nx, hh: nz, sub: 1 });

  // The height of the form at a world (x, z) (nearest column), 0 off it.
  form.heightAt = (x, z) => {
    const i = Math.floor((x - u0) / cu), j = Math.floor((z - v0) / cv);
    return i < 0 || j < 0 || i >= nx || j >= nz ? 0 : form.heights[j * nx + i];
  };

  // Back to the mass as placed.
  form.clear = () => {
    const had = form.changed();
    form.heights.set(hf);
    form.heat.fill(0);
    form.wear.fill(0);
    if (had) form.version++;
    return had;
  };
  return form;
}
