// MODEL (exterior erosion): wears tunnels into the mass where people and cars pass through it.
// No scene or DOM code. It works on the lattice from language.js: a grid of cells laid along the
// mass's own axis, each a fraction of its block size.
//
// Every visit adds "heat" to the cell under a particle (a car counts for several people). Heat becomes
// a number of storeys to carve:  1 storey from a little use, 2 and 3 from a lot. A carved cell also pulls
// its neighbours down by one storey per cell of distance, so busy routes get a stepped, terraced section
// like the tiers of the mass (square steps for orthogonal masses, rounder ones for organic masses).
import * as THREE from "three";
import { createCut } from "../contract.js";

const THRESHOLDS = [30, 120, 480]; // people-seconds of presence for 1, 2, 3 storeys
const CAR_WEIGHT = 4; // one car-second counts as this many people-seconds
const CAR_CLEARANCE = 4.5; // metres a cell must open up once cars use it
const ROOF = 1.5; // metres of mass always left above a tunnel

export function createErosion(scan) {
  const { nU, nV, cu, cv, u0, v0, cos, sin, storey, organic, ok, topMin } = scan;
  const size = nU * nV;
  const er = { scan, heatPeople: new Float32Array(size), heatCars: new Float32Array(size), H: new Float32Array(size), version: 0 };
  const stepsMax = Float32Array.from(topMin, (t) => Math.max(0, Math.floor((t - ROOF) / storey)));
  const carStoreys = Math.ceil(CAR_CLEARANCE / storey);

  // x, y: site metres (east, north). seconds: simulated time spent, already scaled by the erosion speed.
  er.visit = (isCar, x, y, seconds) => {
    const wx = x, wz = -y;
    const u = wx * cos + wz * sin - u0, v = -wx * sin + wz * cos - v0;
    const i = Math.floor(u / cu), j = Math.floor(v / cv);
    if (i < 0 || j < 0 || i >= nU || j >= nV) return;
    const k = j * nU + i;
    if (ok[k]) (isCar ? er.heatCars : er.heatPeople)[k] += seconds;
  };

  // Turns heat into carved heights. Returns true if any height changed.
  er.recompute = () => {
    const level = new Uint8Array(size);
    for (let k = 0; k < size; k++) {
      if (!ok[k]) continue;
      const heat = er.heatPeople[k] + CAR_WEIGHT * er.heatCars[k];
      let n = heat >= THRESHOLDS[2] ? 3 : heat >= THRESHOLDS[1] ? 2 : heat >= THRESHOLDS[0] ? 1 : 0;
      if (er.heatCars[k] >= THRESHOLDS[0] / CAR_WEIGHT) n = Math.max(n, carStoreys);
      level[k] = n;
    }
    const steps = new Float32Array(size);
    for (let j = 0; j < nV; j++) {
      for (let i = 0; i < nU; i++) {
        const n = level[j * nU + i];
        if (!n) continue;
        for (let dj = 1 - n; dj < n; dj++) {
          for (let di = 1 - n; di < n; di++) {
            const ti = i + di, tj = j + dj;
            if (ti < 0 || tj < 0 || ti >= nU || tj >= nV) continue;
            const distance = organic ? Math.hypot(di, dj) : Math.max(Math.abs(di), Math.abs(dj));
            const value = organic ? Math.floor(n - distance + 1e-6) : n - distance;
            const t = tj * nU + ti;
            if (value >= 1 && ok[t] && value > steps[t]) steps[t] = value;
          }
        }
      }
    }
    let changed = false;
    for (let k = 0; k < size; k++) {
      const h = Math.min(steps[k], stepsMax[k]) * storey;
      if (Math.abs(h - er.H[k]) > 1e-3) { er.H[k] = h; changed = true; }
    }
    if (changed) er.version++;
    return changed;
  };

  er.clear = () => {
    er.heatPeople.fill(0);
    er.heatCars.fill(0);
    return er.recompute();
  };
  return er;
}

/* ---------- the cut handed to the shared erosion pipeline ---------- */

let active = null;
let cached = { version: -1, cuts: [] };

export function setActiveErosion(er) {
  active = er;
  cached = { version: -1, cuts: [] };
}

// Signed-distance cut (negative inside the carved volume) for the shared pipeline: union of the carved cell boxes.
export function activeErosionCuts() {
  if (!active) return [];
  if (cached.version === active.version) return cached.cuts;
  const { nU, nV, cu, cv, u0, v0, cos, sin } = active.scan;
  const H = Float32Array.from(active.H);

  const bounds = new THREE.Box3();
  for (let j = 0; j < nV; j++) {
    for (let i = 0; i < nU; i++) {
      const h = H[j * nU + i];
      if (!h) continue;
      for (const [a, b] of [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]]) {
        const u = u0 + a * cu, v = v0 + b * cv, x = u * cos - v * sin, z = u * sin + v * cos;
        bounds.expandByPoint(new THREE.Vector3(x, 0, z));
        bounds.expandByPoint(new THREE.Vector3(x, h, z));
      }
    }
  }
  if (bounds.isEmpty()) {
    cached = { version: active.version, cuts: [] };
    return cached.cuts;
  }

  const sdf = (x, y, z) => {
    const u = x * cos + z * sin - u0, v = -x * sin + z * cos - v0;
    const i0 = Math.floor(u / cu), j0 = Math.floor(v / cv);
    let best = 1e3;
    for (let j = j0 - 1; j <= j0 + 1; j++) {
      for (let i = i0 - 1; i <= i0 + 1; i++) {
        if (i < 0 || j < 0 || i >= nU || j >= nV) continue;
        const h = H[j * nU + i];
        if (!h) continue;
        const qx = Math.abs(u - (i + 0.5) * cu) - cu / 2, qz = Math.abs(v - (j + 0.5) * cv) - cv / 2, qy = Math.abs(y - h / 2) - h / 2;
        const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
        if (d < best) best = d;
      }
    }
    return best;
  };
  cached = {
    version: active.version,
    cuts: [createCut({ id: "ext-flow-erosion", source: "exterior", label: "Flow erosion (people and cars)", bounds, sdf })],
  };
  return cached.cuts;
}
