// MODEL (exterior erosion): the wind tunnels' state. No scene or DOM code.
//
// The voxel mass (voxelFlow.js) is built once from the form and then kept: tunnels are voxels of the mass switched to air, and
// they stay switched while the airflow is solved again after every change. Each solve starts from the last one's potential, so
// re-solving after a small change (a few voxels opened) takes far fewer passes than the first.
//
// Floors: the mass is cut into storeys of STOREY metres (14 ft), and the storeys are grouped in pairs, the BANDS (floors 1-2,
// floors 3-4, ...). The tunnels work on one band at a time and never leave it, so they span two storeys at most. One layer of
// voxels at the bottom of every storey is left as its floor slab, and the top layer of the mass is left as the roof.
//
// How the tunnels grow: air cannot flow into a dead end, so the first openings are pilot channels, one voxel wide, straight
// through the mass along the wind (seedBand). There are several in each storey, spread evenly across the mass (about SPACING
// metres apart, the ones in the upper storey half a step to the side of the ones below) so that the whole floor plate has moving
// air near it. Then, round after round, the air that blows through a tunnel wears its walls: every mass voxel next to a tunnel
// gathers wear from the speed of the air beside it (only air faster than MIN_SPEED times the open wind counts) and is opened once
// it is worn through. Each pilot has a lane around it, a little under a quarter of the spacing to each side, and wear only counts
// inside the lanes, so the tunnels stay small and do not run into each other. After each round the airflow is solved again.
//
// cooling() reads how much of each storey's floor plate lies near moving air.
//
// Planned on top of this (not built yet):
//  - several bands at once, each facing the wind of a different part of the year (the Floors setting picks one band for now);
//  - the solver picking the lane spacing and width from the cooling it gives.
import { createVoxelMass, solveFlow, AIR, MASS } from "./voxelFlow.js";

export const STOREY = 14 * 0.3048; // metres: one storey, 14 ft
export const BAND_STOREYS = 2; // storeys a tunnel may span at most
export const MIN_SPEED = 0.9; // x the open wind: air slower than this does not wear the walls
export const REACH = 3; // metres: how far from a tunnel its moving air is taken to cool the floor
const WEAR_RATE = 0.5; // wear per round at one unit of (speed^2 - MIN_SPEED^2) and erosion speed 1
const MAX_PER_ROUND = 60; // voxels opened in one round at most, so that the airflow is solved again before the tunnel runs on
const SPACING = 8; // metres between pilot channels in one storey
const LANE = 0.22; // the lane's half width as a part of the spacing
const MIN_PILOT = 4; // metres: a pilot channel shorter than this (a corner of the mass) is not opened

// form: the shared form (form.js), as it is now. cityHeight: (x, z) => metres, the site's buildings (windFlow.js cityHeights).
// Returns null if the form has no mass.
let serial = 0;
export function createTunnels(form, { cityHeight = null } = {}) {
  const vox = createVoxelMass(form, { cityHeight, maxCells: 400000, storey: STOREY });
  if (!vox) return null;
  const { nx, nz, ny, c, cells } = vox;
  const nxz = nx * nz;
  const perStorey = Math.round(STOREY / c); // voxel layers in one storey
  const perBand = perStorey * BAND_STOREYS;
  const placed = Uint8Array.from(cells); // the mass as it was placed, to put it back
  const wear = new Float32Array(cells.length); // 0..1: how worn each mass voxel next to a tunnel is
  const lane = new Uint8Array(cells.length); // 1 where a tunnel may be worn open (the lanes round the pilot channels)
  const roof = new Int16Array(nxz).fill(-1); // the layer of the top mass voxel in every column (-1 where there is none)
  for (let k = 0; k < placed.length; k++) if (placed[k] === MASS) roof[k % nxz] = Math.floor(k / nxz);
  const bands = Math.max(1, Math.ceil(vox.top / (STOREY * BAND_STOREYS)));
  let band = -1; // the pair of floors being worked on (setBand)
  let bandMass = 0; // mass voxels inside that band
  let carved = 0;
  let rounds = 0;
  let gaining = 0;
  let seeded = false;
  let flow = null; // the last solution
  let flowVersion = -1; // the voxel version it was solved for
  let flowDir = null;

  const isTunnel = (k) => placed[k] === MASS && cells[k] === AIR; // air that the mass once held
  const layerOf = (k) => Math.floor(k / nxz);

  const tunnels = {
    id: ++serial, // tells one set of tunnels from another (voxel versions restart with each)
    vox,
    builtOn: form.version, // the form version the voxels were built from: if the form changes, the tunnels are built afresh
    bands, // how many pairs of floors the mass has
    storeys: Math.max(1, Math.ceil(vox.top / STOREY)),
    get band() { return band; },
    get flow() { return flow; },
    get carved() { return carved; }, // voxels of the mass that are air now
    get share() { return bandMass ? carved / bandMass : 0; }, // the part of the band's mass that is carved away (0..1)
    get rounds() { return rounds; }, // times the walls have been worn
    get seeded() { return seeded; },
    // Voxels that gained wear in the last round of erode(). A round that opens nothing is not the end while this is above 0: the
    // wear just has not reached the point where a voxel opens yet.
    get gaining() { return gaining; },

    // Is this voxel air that the mass once held (part of a tunnel)?
    carvedAt: isTunnel,

    // Opens a voxel of the mass. Says whether it changed (context buildings and air cannot be carved).
    carve(k) {
      if (placed[k] !== MASS || cells[k] !== MASS) return false;
      vox.set(k, AIR);
      carved++;
      return true;
    },

    // The mass as placed again.
    reset() {
      cells.set(placed);
      wear.fill(0);
      lane.fill(0);
      vox.version++;
      carved = rounds = gaining = 0;
      seeded = false;
      flow = null;
      flowVersion = -1;
    },

    // Chooses the pair of floors the tunnels work on (0 = floors 1 and 2) and puts the mass back as placed.
    setBand(b) {
      band = Math.max(0, Math.min(bands - 1, b));
      tunnels.reset();
      bandMass = 0;
      for (let l = band * perBand; l < Math.min(ny, (band + 1) * perBand); l++) {
        for (let k = l * nxz; k < (l + 1) * nxz; k++) if (placed[k] === MASS) bandMass++;
      }
    },

    // Opens the pilot channels of the current band and marks their lanes: along the wind dir = [ux, uz], several in each storey,
    // evenly spread across the mass at that height. Says how many voxels it opened.
    seedBand(dir) {
      seeded = true;
      if (band < 0) return 0;
      const [d0, d1] = dir, p0 = -d1, p1 = d0; // along the wind, and across it
      const lo = band * perBand, hi = Math.min(ny, lo + perBand);
      let amin = Infinity, amax = -Infinity, qmin = Infinity, qmax = -Infinity;
      for (let l = lo; l < hi; l++) {
        for (let k = l * nxz; k < (l + 1) * nxz; k++) {
          if (cells[k] !== MASS) continue;
          const col = k - l * nxz, i = col % nx, j = Math.floor(col / nx);
          const [x, , z] = vox.centre(i, j, l);
          const a = x * d0 + z * d1, q = x * p0 + z * p1;
          amin = Math.min(amin, a); amax = Math.max(amax, a); qmin = Math.min(qmin, q); qmax = Math.max(qmax, q);
        }
      }
      if (amax < amin) return 0;
      const n = Math.max(1, Math.round((qmax - qmin + c) / SPACING)), step = (qmax - qmin + c) / n;
      const half = LANE * step;
      let opened = 0;
      for (let s = 0; s < BAND_STOREYS; s++) {
        const first = lo + s * perStorey; // the storey's floor slab; the tunnels use the layers above it
        if (first >= hi) break;
        const top = Math.min(hi, first + perStorey);
        const pilot = Math.min(top - 1, first + Math.max(1, Math.floor(perStorey / 2)));
        for (let m = 0; m < n; m++) {
          const o = qmin - c / 2 + (m + (s % 2 ? 0.75 : 0.25)) * step; // across the wind; the upper storey is half a step over
          // The lane: mass voxels within `half` of the line, in this storey above its floor slab.
          for (let l = first + 1; l < top; l++) {
            for (let j = 0; j < nz; j++) {
              for (let i = 0; i < nx; i++) {
                const k = (l * nz + j) * nx + i;
                if (cells[k] !== MASS) continue;
                const [x, , z] = vox.centre(i, j, l);
                if (Math.abs(x * p0 + z * p1 - o) <= half + c / 2) lane[k] = 1;
              }
            }
          }
          // The pilot: walk the line voxel by voxel. Where it passes a voxel corner it would jump diagonally, which leaves a gap
          // the air cannot cross (voxels connect through their faces), so a step in both x and z is made as two steps.
          const path = [];
          let pi = -1, pj = -1;
          for (let t = amin - c; t <= amax + c; t += c / 2) {
            const i = Math.floor((d0 * t + p0 * o - vox.x0) / c), j = Math.floor((d1 * t + p1 * o - vox.z0) / c);
            if (i < 0 || j < 0 || i >= nx || j >= nz || (i === pi && j === pj)) continue;
            if (pi >= 0 && i !== pi && j !== pj) path.push(vox.index(i, pj, pilot));
            path.push(vox.index(i, j, pilot));
            pi = i;
            pj = j;
          }
          const inMass = path.filter((k) => cells[k] === MASS);
          if (inMass.length * c < MIN_PILOT) continue;
          for (const k of inMass) {
            lane[k] = 1;
            if (tunnels.carve(k)) opened++;
          }
        }
      }
      return opened;
    },

    // One round of wearing: the air in the last solution (`flow`, which must be for the voxels as they are) wears the mass voxels
    // next to the tunnels. `rate` scales the wear (the erosion speed setting). Says how many voxels it opened.
    // The wear does not stop by itself (a wider channel carries air as fast as a narrow one), so it is capped: the lanes limit
    // the width, and at most `maxFraction` of the band's mass voxels are carved away in all.
    erode(rate = 1, maxFraction = 0.1) {
      const room = Math.floor(maxFraction * bandMass) - carved;
      gaining = 0;
      if (!flow || room <= 0) return 0;
      const worn = [];
      const faces = [1, -1, nx, -nx, nxz, -nxz];
      for (let k = nxz; k < cells.length; k++) { // the bottom layer stays as the floor
        if (cells[k] !== MASS || !lane[k]) continue;
        const column = k % nxz;
        if (layerOf(k) >= roof[column]) continue; // the top layer of every column stays as the roof
        let s = 0;
        for (const f of faces) {
          const q = k + f;
          if (q >= 0 && q < cells.length && flow.open[q] && isTunnel(q) && flow.speed[q] > s) s = flow.speed[q];
        }
        if (s <= MIN_SPEED) continue;
        gaining++;
        wear[k] += WEAR_RATE * rate * (s * s - MIN_SPEED * MIN_SPEED);
        if (wear[k] >= 1) worn.push(k);
      }
      worn.sort((a, b) => wear[b] - wear[a]);
      let opened = 0;
      for (let t = 0; t < worn.length && t < Math.min(MAX_PER_ROUND, room); t++) if (tunnels.carve(worn[t])) opened++;
      rounds++;
      return opened;
    },

    // The air speed in the tunnels in the last solution: { max, mean } relative to the open wind (0 if there is none).
    tunnelSpeed() {
      let max = 0, sum = 0, n = 0;
      if (flow) {
        for (let k = 0; k < cells.length; k++) {
          if (!flow.open[k] || !isTunnel(k)) continue;
          max = Math.max(max, flow.speed[k]); sum += flow.speed[k]; n++;
        }
      }
      return { max, mean: n ? sum / n : 0 };
    },

    // How well the band's floors are cooled, read from the last solution. Every mass voxel of the band that is still solid gets
    // the strongest cooling of any tunnel air within REACH metres: that air's speed (x the open wind), fading to nothing at REACH.
    // Returns { coverage: [per storey], mean, evenness }: coverage is the part of the storey's solid voxels where that is at
    // least half the open wind (the floor is near moving air), mean is the average cooling (capped at 1.5), and evenness is the
    // weaker storey's coverage over the stronger's (1 = both floors cooled alike). All 0 if there is nothing yet.
    cooling() {
      const out = { coverage: new Array(BAND_STOREYS).fill(0), mean: 0, evenness: 0 };
      if (!flow || band < 0) return out;
      const lo = band * perBand, hi = Math.min(ny, lo + perBand), r = Math.ceil(REACH / c);
      const cool = new Float32Array((hi - lo) * nxz);
      for (let l = lo; l < hi; l++) {
        for (let col = 0; col < nxz; col++) {
          const k = l * nxz + col;
          if (!flow.open[k] || !isTunnel(k)) continue;
          const i = col % nx, j = Math.floor(col / nx), s = flow.speed[k];
          for (let dl = -r; dl <= r; dl++) {
            const ll = l + dl;
            if (ll < lo || ll >= hi) continue;
            for (let dj = -r; dj <= r; dj++) {
              const jj = j + dj;
              if (jj < 0 || jj >= nz) continue;
              for (let di = -r; di <= r; di++) {
                const ii = i + di;
                if (ii < 0 || ii >= nx) continue;
                const v = s * (1 - Math.hypot(di, dj, dl) * c / REACH);
                const q = (ll - lo) * nxz + jj * nx + ii;
                if (v > cool[q]) cool[q] = v;
              }
            }
          }
        }
      }
      const total = new Array(BAND_STOREYS).fill(0), near = new Array(BAND_STOREYS).fill(0);
      let sum = 0, count = 0;
      for (let l = lo; l < hi; l++) {
        const s = Math.min(BAND_STOREYS - 1, Math.floor((l - lo) / perStorey));
        for (let col = 0; col < nxz; col++) {
          const k = l * nxz + col;
          if (placed[k] !== MASS || cells[k] !== MASS) continue;
          const v = cool[(l - lo) * nxz + col];
          total[s]++;
          if (v >= 0.5) near[s]++;
          sum += Math.min(v, 1.5);
          count++;
        }
      }
      out.coverage = total.map((t, s) => (t ? near[s] / t : 0));
      out.mean = count ? sum / count : 0;
      const used = out.coverage.filter((_, s) => total[s]);
      out.evenness = used.length && Math.max(...used) > 0 ? Math.min(...used) / Math.max(...used) : 0;
      return out;
    },

    // Is the stored solution out of date for the wind direction dir = [ux, uz]?
    stale(dir) {
      return !flow || flowVersion !== vox.version || flowDir[0] !== dir[0] || flowDir[1] !== dir[1];
    },

    // Solves the airflow for the voxels as they are now (a solveFlow() result), starting from the last solution.
    async solve(dir, options = {}) {
      const version = vox.version;
      const result = await solveFlow(vox, { dir, previous: flow, ...options });
      flow = result;
      flowVersion = version; // if a voxel was opened while this ran, the version has moved on and the result counts as stale
      flowDir = dir;
      return result;
    },
  };
  return tunnels;
}
