// MODEL (exterior erosion): wears thin passages into the mass where people and cars touch it.
// No scene or DOM code. The erosion is uniform: it does not depend on the mass's shape, only on where figures
// have been and how often. Contact with the mass is recorded on a fine grid; every worn spot becomes a small
// domed hollow, and hollows along a route overlap into a passage. Each pass widens its hollow a little and
// darkens it, so heavily used routes grow into the widest, darkest channels.
import * as THREE from "three";
import { createCut } from "../contract.js";

const FIRST_WEAR = 30; // people-seconds in a 4 m cell before it first wears (scaled to the fine cells)
const CAR_WEIGHT = 8; // one car-second counts as this many people-seconds (a car is gone from a spot far sooner)
const HOLLOW_RADIUS = 1.2; // metres: a hollow before it has been passed many times
const CAR_HOLLOW = 2.6; // metres high a hollow is once cars pass through it
const WIDEN = 0.45; // a hollow gains this fraction of its base radius each time its wear doubles
const MAX_WIDEN = 3; // ... up to this many times its base radius
const DARKEST = 64; // wear this many times the first wear is as dark as it gets

export const MAX_SPHERES = 768;
export const SPHERE_SQUASH = 1.6; // hollows are this much higher than they are wide: standing height

export function createErosion(scan) {
  const { nU, nV, cu, cv } = scan;
  const g = Math.max(0.6, Math.max(nU * cu, nV * cv) / 220); // metres per fine cell
  const fU = Math.ceil((nU * cu) / g), fV = Math.ceil((nV * cv) / g);
  const T0 = (FIRST_WEAR * g) / 4;
  const er = { scan, heatPeople: new Float32Array(fU * fV), heatCars: new Float32Array(fU * fV), spheres: [], version: 0 };
  // Wear so far: 1 at the first wear, 2 once it has doubled, and so on.
  const wearOf = (k) => (er.heatPeople[k] + CAR_WEIGHT * er.heatCars[k]) / T0;

  // x, y: site metres (east, north). seconds: simulated time spent, already scaled by the erosion speed.
  // Only counts where the figure touches the mass: the mass's height map must have mass under the figure.
  er.visit = (isCar, x, y, seconds) => {
    const [u, v] = scan.toUV(x, -y); // site (east, north) -> world (x, z = -north) -> lattice
    if (u < 0 || v < 0) return;
    const si = Math.floor(u / (cu / scan.sub)), sj = Math.floor(v / (cv / scan.sub));
    if (si >= scan.hw || sj >= scan.hh || scan.hf[sj * scan.hw + si] <= 0.5) return;
    const fi = Math.floor(u / g), fj = Math.floor(v / g);
    if (fi < fU && fj < fV) (isCar ? er.heatCars : er.heatPeople)[fj * fU + fi] += seconds;
  };

  // How worn the ground is at a point, 0 (untouched) to 1 (very worn). People inside the mass are drawn to worn ground,
  // which is what makes separate trails merge into larger channels.
  er.wearAt = (x, y) => {
    const [u, v] = scan.toUV(x, -y);
    const fi = Math.floor(u / g), fj = Math.floor(v / g);
    if (u < 0 || v < 0 || fi >= fU || fj >= fV) return 0;
    return Math.min(1, Math.log2(1 + wearOf(fj * fU + fi)) / 6);
  };

  // Turns wear into hollows: one per worn fine cell, wider and darker the more it has been passed, thinned so that
  // neighbours don't pile up. The most-worn cells are kept first if there are more than MAX_SPHERES.
  // A hollow may break through the roof near the mass's rim, which is how it opens to the outside.
  er.recompute = () => {
    const candidates = [];
    for (let k = 0; k < er.heatPeople.length; k++) {
      const wear = wearOf(k);
      const cars = er.heatCars[k] >= T0 / CAR_WEIGHT;
      if (wear < 1 && !cars) continue;
      let r = HOLLOW_RADIUS * Math.min(MAX_WIDEN, 1 + WIDEN * Math.log2(Math.max(1, wear)));
      if (cars) r = Math.max(r, CAR_HOLLOW / SPHERE_SQUASH);
      const [x, z] = scan.toXZ(((k % fU) + 0.5) * g, (Math.floor(k / fU) + 0.5) * g);
      candidates.push({ x, z, r, wear: Math.min(1, Math.log2(Math.max(1, wear)) / Math.log2(DARKEST)), heat: wear });
    }
    candidates.sort((a, b) => b.heat - a.heat);
    const spheres = [];
    for (const c of candidates) {
      if (spheres.length >= MAX_SPHERES) break;
      if (spheres.every((s) => Math.hypot(s.x - c.x, s.z - c.z) >= 0.7 * Math.min(s.r, c.r))) spheres.push({ x: c.x, z: c.z, r: c.r, wear: c.wear });
    }
    const same = spheres.length === er.spheres.length &&
      spheres.every((s, i) => Math.abs(s.x - er.spheres[i].x) + Math.abs(s.z - er.spheres[i].z) + Math.abs(s.r - er.spheres[i].r) + Math.abs(s.wear - er.spheres[i].wear) < 1e-3);
    if (!same) {
      er.spheres = spheres;
      er.version++;
    }
    return !same;
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

// Signed-distance cut (negative inside the carved volume) for the shared pipeline: the union of the hollows.
// Distances are measured with the height squashed, so they are lower bounds.
export function activeErosionCuts() {
  if (!active) return [];
  if (cached.version === active.version) return cached.cuts;
  const spheres = active.spheres.map((s) => ({ ...s }));
  let cut = null;
  if (spheres.length) {
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
    cut = createCut({ id: "ext-flow-erosion", source: "exterior", label: "Flow erosion (people and cars)", bounds, sdf });
  }
  cached = { version: active.version, cuts: cut ? [cut] : [] };
  return cached.cuts;
}
