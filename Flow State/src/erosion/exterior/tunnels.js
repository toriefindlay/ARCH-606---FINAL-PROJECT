// MODEL (exterior erosion): the wind tunnels' state. No scene or DOM code.
//
// The voxel mass (voxelFlow.js) is built once from the form and then kept: tunnels are voxels of the mass switched to air, and
// they stay switched while the airflow is solved again after every change. Each solve starts from the last one's potential, so
// re-solving after a small change (a few voxels opened) takes far fewer passes than the first.
//
// How a tunnel grows: air cannot flow into a dead end, so the first opening is a pilot channel, one voxel wide, straight through
// the mass along the wind (seedPilot). Then, round after round, the air that blows through the tunnel wears the walls: every
// mass voxel next to the tunnel gathers wear from the speed of the air beside it (only air faster than MIN_SPEED times the open
// wind counts) and is opened once it is worn through. After each round the airflow is solved again, so the tunnel widens where
// the air is fastest. One layer of mass is always left as a floor and as a roof.
//
// Planned on top of this (not built yet):
//  - where the pilot goes: the solver picks it, as the place that would give the most cooling in the warmest part of the year
//    (seedPilot takes a fixed height for now), so it needs the wind rose of the warm season (site/wind.js has the hourly data);
//  - the cooling it gives, read from the same flow field.
import { createVoxelMass, solveFlow, AIR, MASS } from "./voxelFlow.js";

export const MIN_SPEED = 0.9; // x the open wind: air slower than this does not wear the walls
const WEAR_RATE = 0.5; // wear per round at one unit of (speed^2 - MIN_SPEED^2) and erosion speed 1
const MAX_PER_ROUND = 60; // voxels opened in one round at most, so that the airflow is solved again before the tunnel runs on
const PILOT_HEIGHT = 0.3; // fraction of the mass's height: where the pilot channel runs (until the solver picks the place)

// form: the shared form (form.js), as it is now. cityHeight: (x, z) => metres, the site's buildings (windFlow.js cityHeights).
// Returns null if the form has no mass.
export function createTunnels(form, { cityHeight = null } = {}) {
  const vox = createVoxelMass(form, { cityHeight });
  if (!vox) return null;
  const { nx, nz, ny, c, cells } = vox;
  const nxz = nx * nz;
  const placed = Uint8Array.from(cells); // the mass as it was placed, to put it back
  const wear = new Float32Array(cells.length); // 0..1: how worn each mass voxel next to a tunnel is
  const massVoxels = placed.reduce((n, v) => n + (v === MASS ? 1 : 0), 0);
  let carved = 0;
  let rounds = 0;
  let gaining = 0;
  let seeded = false;
  let flow = null; // the last solution
  let flowVersion = -1; // the voxel version it was solved for
  let flowDir = null;

  const isTunnel = (k) => placed[k] === MASS && cells[k] === AIR; // air that the mass once held

  const tunnels = {
    vox,
    builtOn: form.version, // the form version the voxels were built from: if the form changes, the tunnels are built afresh
    get flow() { return flow; },
    get carved() { return carved; }, // voxels of the mass that are air now
    get share() { return massVoxels ? carved / massVoxels : 0; }, // the part of the mass that is carved away (0..1)
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
      vox.version++;
      carved = rounds = gaining = 0;
      seeded = false;
      flow = null;
      flowVersion = -1;
    },

    // Opens the pilot channel: one voxel wide, along the wind dir = [ux, uz], through the middle of the mass at `height` (a
    // fraction of the mass's height). Says how many voxels it opened.
    seedPilot(dir, height = PILOT_HEIGHT) {
      const l = Math.max(1, Math.min(ny - 3, Math.round((height * vox.top) / c - 0.5)));
      const y = (l + 0.5) * c;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          if (cells[(l * nz + j) * nx + i] !== MASS) continue;
          const [x, , z] = vox.centre(i, j, l);
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
        }
      }
      if (x1 < x0) return 0; // no mass at that height
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, reach = Math.hypot(x1 - x0, z1 - z0) / 2 + c;
      // Walk along the line voxel by voxel. Where it passes a voxel corner it would jump diagonally, which leaves a gap the air
      // cannot cross (voxels connect through their faces), so a step in both x and z is made as two steps.
      let opened = 0, pi = -1, pj = -1;
      for (let t = -reach; t <= reach; t += c / 2) {
        const i = Math.floor((mx + dir[0] * t - vox.x0) / c), j = Math.floor((mz + dir[1] * t - vox.z0) / c);
        if (i < 0 || j < 0 || i >= nx || j >= nz || (i === pi && j === pj)) continue;
        if (pi >= 0 && i !== pi && j !== pj && tunnels.carve(vox.index(i, pj, l))) opened++; // the x step first, then the z step
        if (tunnels.carve(vox.index(i, j, l))) opened++;
        pi = i;
        pj = j;
      }
      seeded = opened > 0;
      return opened;
    },

    // One round of wearing: the air in the last solution (`flow`, which must be for the voxels as they are) wears the mass voxels
    // next to the tunnels. `rate` scales the wear (the erosion speed setting). Says how many voxels it opened.
    // The wear does not stop by itself (a wider channel carries air as fast as a narrow one), so it is capped: at most
    // `maxFraction` of the mass's voxels are carved away in all.
    erode(rate = 1, maxFraction = 0.1) {
      const room = Math.floor(maxFraction * massVoxels) - carved;
      gaining = 0;
      if (!flow || room <= 0) return 0;
      const worn = [];
      const faces = [1, -1, nx, -nx, nxz, -nxz];
      for (let k = nxz; k < cells.length; k++) { // the bottom layer stays as the floor
        if (cells[k] !== MASS || cells[k + nxz] !== MASS) continue; // a roof layer stays too
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
