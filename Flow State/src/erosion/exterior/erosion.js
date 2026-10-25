// MODEL (exterior erosion): wears tunnels into the mass where people and cars pass through it.
// No scene or DOM code. It works on the lattice from language.js: a grid of cells laid along the
// mass's own axes. Every visit adds "heat" to the cell under a particle (a car counts for several people).
// Heat becomes a use level: 1 storey-equivalent from a little use, 2 and 3 from a lot. How that is carved
// follows the mass's own profile (scan.profile, read in language.js):
//   stepped    a terraced mass: busy cells open neighbours down one storey per cell, like its tiers
//   prismatic  a single block: neighbours open to the same height, giving a plain wider room
//   round      an organic mass: overlapping domed hollows (spheres) along the routes, swelling where use is heavy
import * as THREE from "three";
import { createCut } from "../contract.js";

const THRESHOLDS = [30, 120, 480]; // people-seconds of presence for use levels 1, 2, 3 (for 4 m cells)
const CAR_WEIGHT = 8; // one car-second counts as this many people-seconds (a car is gone from a cell far sooner)
const CAR_CLEARANCE = 4.5; // metres a space must open up once cars use it
const ROOF = 1.5; // metres of mass always left above a stepped or prismatic tunnel
const CAR_HOLLOW = 2.6; // metres high a round hollow is once cars pass through it

export const MAX_SPHERES = 768;
export const SPHERE_SQUASH = 1.6; // round hollows are this much higher than they are wide: thin passages, standing height

export function createErosion(scan) {
  const { nU, nV, cu, cv, storey, profile, ok, topMin } = scan;
  const size = nU * nV;
  const er = {
    scan, heatPeople: new Float32Array(size), heatCars: new Float32Array(size),
    H: new Float32Array(size), // carved height per cell (stepped and prismatic)
    spheres: [], // { x, z, r } domed hollows centred on the ground (round)
    version: 0,
  };
  const stepsMax = Float32Array.from(topMin, (t) => Math.max(0, Math.floor((t - ROOF) / storey)));
  const carStoreys = Math.ceil(CAR_CLEARANCE / storey);
  // Smaller cells see less of each passer-by, so need less heat to count as used.
  const heatScale = Math.min(2, Math.max(0.4, Math.min(cu, cv) / 4));
  const T = THRESHOLDS.map((t) => t * heatScale);

  // Round erosion records contact on a much finer grid than the lattice, so each route wears as a thin line.
  let fine = null;
  if (profile === "round") {
    const g = Math.max(0.6, Math.max(nU * cu, nV * cv) / 220); // metres per fine cell
    const fU = Math.ceil((nU * cu) / g), fV = Math.ceil((nV * cv) / g);
    fine = { g, nU: fU, nV: fV, heatPeople: new Float32Array(fU * fV), heatCars: new Float32Array(fU * fV), T: THRESHOLDS.map((t) => (t * g) / 4) };
  }

  // x, y: site metres (east, north). seconds: simulated time spent, already scaled by the erosion speed.
  // Only counts where the figure touches the mass: the mass's height map must have mass under the figure.
  er.visit = (isCar, x, y, seconds) => {
    const [u, v] = scan.toUV(x, -y); // site (east, north) -> world (x, z = -north) -> lattice
    if (u < 0 || v < 0) return;
    const si = Math.floor(u / (cu / scan.sub)), sj = Math.floor(v / (cv / scan.sub));
    if (si >= scan.hw || sj >= scan.hh || scan.hf[sj * scan.hw + si] <= 0.5) return;
    if (fine) {
      const fi = Math.floor(u / fine.g), fj = Math.floor(v / fine.g);
      if (fi < fine.nU && fj < fine.nV) (isCar ? fine.heatCars : fine.heatPeople)[fj * fine.nU + fi] += seconds;
      return;
    }
    const i = Math.floor(u / cu), j = Math.floor(v / cv);
    if (i >= nU || j >= nV) return;
    const k = j * nU + i;
    if (ok[k]) (isCar ? er.heatCars : er.heatPeople)[k] += seconds;
  };

  const useLevels = () => {
    const level = new Uint8Array(size);
    for (let k = 0; k < size; k++) {
      if (!ok[k]) continue;
      const heat = er.heatPeople[k] + CAR_WEIGHT * er.heatCars[k];
      level[k] = heat >= T[2] ? 3 : heat >= T[1] ? 2 : heat >= T[0] ? 1 : 0;
    }
    return level;
  };
  const carsUse = (k) => er.heatCars[k] >= T[0] / CAR_WEIGHT;

  // Stepped and prismatic: carved height per lattice cell.
  const recomputeCells = () => {
    const level = useLevels();
    for (let k = 0; k < size; k++) if (carsUse(k) && ok[k]) level[k] = Math.max(level[k], carStoreys);
    const steps = new Float32Array(size);
    for (let j = 0; j < nV; j++) {
      for (let i = 0; i < nU; i++) {
        const n = level[j * nU + i];
        if (!n) continue;
        const reach = profile === "prismatic" ? n >> 1 : n - 1; // cells the carving spreads from a busy cell
        for (let dj = -reach; dj <= reach; dj++) {
          for (let di = -reach; di <= reach; di++) {
            const ti = i + di, tj = j + dj;
            if (ti < 0 || tj < 0 || ti >= nU || tj >= nV) continue;
            const value = profile === "prismatic" ? n : n - Math.max(Math.abs(di), Math.abs(dj));
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
    return changed;
  };

  // Round: one small domed hollow per worn fine cell, a little wider where use is heavier. Along a route they overlap
  // into a thin passage. The most-worn cells are kept first if there are more than MAX_SPHERES.
  // A hollow may break through the roof near the mass's rim, which is how it opens to the outside.
  const recomputeSpheres = () => {
    const { g, nU: fU, T: fT, heatPeople, heatCars } = fine;
    const r0 = scan.tunnelRadius;
    const candidates = [];
    for (let k = 0; k < heatPeople.length; k++) {
      const heat = heatPeople[k] + CAR_WEIGHT * heatCars[k];
      const cars = heatCars[k] >= fT[0] / CAR_WEIGHT;
      let n = heat >= fT[2] ? 3 : heat >= fT[1] ? 2 : heat >= fT[0] ? 1 : 0;
      if (cars) n = Math.max(n, 1);
      if (!n) continue;
      let r = r0 * (1 + 0.25 * (n - 1));
      if (cars) r = Math.max(r, CAR_HOLLOW / SPHERE_SQUASH);
      const [x, z] = scan.toXZ(((k % fU) + 0.5) * g, (Math.floor(k / fU) + 0.5) * g);
      candidates.push({ x, z, r, heat });
    }
    candidates.sort((a, b) => b.heat - a.heat);
    const spheres = [];
    for (const c of candidates) {
      if (spheres.length >= MAX_SPHERES) break;
      if (spheres.every((s) => Math.hypot(s.x - c.x, s.z - c.z) >= 0.7 * Math.min(s.r, c.r))) spheres.push({ x: c.x, z: c.z, r: c.r });
    }
    const same = spheres.length === er.spheres.length &&
      spheres.every((s, i) => Math.abs(s.x - er.spheres[i].x) + Math.abs(s.z - er.spheres[i].z) + Math.abs(s.r - er.spheres[i].r) < 1e-3);
    if (!same) er.spheres = spheres;
    return !same;
  };

  // Turns heat into the carved shape. Returns true if anything changed.
  er.recompute = () => {
    const changed = profile === "round" ? recomputeSpheres() : recomputeCells();
    if (changed) er.version++;
    return changed;
  };

  er.clear = () => {
    er.heatPeople.fill(0);
    er.heatCars.fill(0);
    fine?.heatPeople.fill(0);
    fine?.heatCars.fill(0);
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

// Signed-distance cut (negative inside the carved volume) for the shared pipeline.
export function activeErosionCuts() {
  if (!active) return [];
  if (cached.version === active.version) return cached.cuts;
  const make = active.scan.profile === "round" ? roundCut(active) : cellCut(active);
  cached = { version: active.version, cuts: make ? [make] : [] };
  return cached.cuts;
}

const makeCut = (bounds, sdf) =>
  createCut({ id: "ext-flow-erosion", source: "exterior", label: "Flow erosion (people and cars)", bounds, sdf });

// Union of domed hollows. Distances are measured with the height squashed, so they are lower bounds.
function roundCut(er) {
  const spheres = er.spheres.map((s) => ({ ...s }));
  if (!spheres.length) return null;
  const bounds = new THREE.Box3();
  for (const s of spheres) {
    bounds.expandByPoint(new THREE.Vector3(s.x - s.r, 0, s.z - s.r));
    bounds.expandByPoint(new THREE.Vector3(s.x + s.r, s.r * SPHERE_SQUASH, s.z + s.r));
  }
  const sdf = (x, y, z) => {
    let best = 1e3;
    for (const s of spheres) {
      const d = Math.hypot(x - s.x, y / SPHERE_SQUASH, z - s.z) - s.r;
      if (d < best) best = d;
    }
    return best * Math.min(1, SPHERE_SQUASH);
  };
  return makeCut(bounds, sdf);
}

// Union of the carved cell boxes.
function cellCut(er) {
  const { scan } = er;
  const { nU, nV, cu, cv, sinPhi } = scan;
  const H = Float32Array.from(er.H);

  const bounds = new THREE.Box3();
  for (let j = 0; j < nV; j++) {
    for (let i = 0; i < nU; i++) {
      const h = H[j * nU + i];
      if (!h) continue;
      for (const [a, b] of [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]]) {
        const [x, z] = scan.toXZ(a * cu, b * cv);
        bounds.expandByPoint(new THREE.Vector3(x, 0, z));
        bounds.expandByPoint(new THREE.Vector3(x, h, z));
      }
    }
  }
  if (bounds.isEmpty()) return null;

  const sdf = (x, y, z) => {
    const [u, v] = scan.toUV(x, z);
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
    // Distances measured along skewed axes overstate the true distance by up to 1 / sin(angle between the axes).
    return best * Math.min(1, sinPhi);
  };
  return makeCut(bounds, sdf);
}
