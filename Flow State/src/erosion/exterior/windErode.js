// MODEL (exterior erosion): the wind rounds the form's convex edges (see form.js).
// No scene or DOM code. The wind never cuts into the mass: it only smooths its outermost layer.
//
// The rounded mass is a morphological opening of the original: every point that a ball of radius r can reach from inside the
// mass is kept, so flat faces stay as they are and only convex edges and corners (vertical corners and the roof edge) are
// shaved off, more the larger r is. The openings for a ladder of radii are worked out once per mass (the ground counts as
// solid, so the foot of a wall is never rounded). The mass is treated as a height map, like the rest of the exterior erosion.
//
// Over time the wind wears the surface cells that face it: every cell with a lower neighbour (a wall or a roof edge) gathers
// wear from the wind rose, most where that neighbour lies upwind, some on the flanks, little in the lee. How worn a cell is
// sets the radius of rounding around it, so windward edges round first and furthest. Wear only grows.
import * as THREE from "three";
import { createCut } from "../contract.js";
import { downwind } from "../../site/wind.js";

const LEVELS = 8; // openings between "none" and the largest radius
const FULL_TIME = 300; // simulated seconds of full-strength wind (one rose unit) for the rounding to reach its largest radius
const REF_SPEED = 5; // m/s: the speed at which the wind counts as one rose unit
const MIN_DROP = 0.3; // metres: a neighbour this much lower makes a cell part of the surface the wind touches
const INF = 1e20;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const tick = () => new Promise((r) => setTimeout(r, 0)); // lets the page breathe between the heavy steps

// 8 neighbours: [di, dj] on the grid, and the same step as a unit vector in world (x east, z south).
const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]].map(([di, dj]) => {
  const n = Math.hypot(di, dj);
  return { di, dj, x: di / n, z: dj / n };
});

/* ---------- distance transform ---------- */

// Squared distance to the nearest zero, along one line (Felzenszwalb & Huttenlocher).
function line1d(f, d, n, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// In place: `grid` holds 0 at the sites and a huge number elsewhere; afterwards the squared distance (in cells) to the nearest site.
export function distance3d(grid, nx, nz, ny) {
  const m = Math.max(nx, nz, ny);
  const f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  const pass = (n, stride, count, start) => {
    for (let c = 0; c < count; c++) {
      const base = start(c);
      for (let q = 0; q < n; q++) f[q] = grid[base + q * stride];
      line1d(f, d, n, v, z);
      for (let q = 0; q < n; q++) grid[base + q * stride] = d[q];
    }
  };
  pass(nx, 1, nz * ny, (c) => c * nx);
  pass(nz, nx, nx * ny, (c) => (Math.floor(c / nx) * nz) * nx + (c % nx));
  pass(ny, nx * nz, nx * nz, (c) => c);
}

/* ---------- the model ---------- */

// form: the shared form (form.js). The wind rounds the shape it has now, whatever the sun or the traffic made of it.
export async function createWindErosion(form) {
  const { nx, nz, cx: cu, cz: cv } = form;
  const h0 = Float32Array.from(form.heights); // the shape this wind starts from
  const cy = (cu + cv) / 2; // isotropic cells for the openings
  const top = form.top = Math.max(form.top, h0.reduce((m, h) => Math.max(m, h), 0));
  if (top <= 0) return null;
  const rMax = clamp(0.25 * Math.min(nx * cu, nz * cv), 2, 15); // metres: the largest rounding radius
  const rVox = rMax / cy;
  const pad = Math.ceil(rVox) + 2;
  const nxp = nx + 2 * pad, nzp = nz + 2 * pad, below = pad, nyp = below + Math.ceil(top / cy) + pad;
  const voxel = (i, j, l) => (l * nzp + j) * nxp + i;
  const cells = nx * nz;

  // The mass as voxels (the ground, below layer `below`, is solid too), then the distance from every voxel to the air.
  const air = new Float32Array(nxp * nzp * nyp).fill(INF);
  const solid = new Uint8Array(air.length);
  for (let l = 0; l < nyp; l++) {
    const y = (l - below + 0.5) * cy;
    for (let j = 0; j < nzp; j++) {
      for (let i = 0; i < nxp; i++) {
        const gi = i - pad, gj = j - pad;
        const h = gi >= 0 && gj >= 0 && gi < nx && gj < nz ? h0[gj * nx + gi] : 0;
        const k = voxel(i, j, l);
        if (l < below || y <= h) solid[k] = 1;
        else air[k] = 0;
      }
    }
  }
  await tick();
  const clearance = air; // becomes the squared distance to the air
  distance3d(clearance, nxp, nzp, nyp);
  await tick();

  // Height of the opened mass in every column, for each radius.
  const topLayer0 = new Int32Array(cells); // the voxel layer a column's original top falls in
  for (let k = 0; k < cells; k++) topLayer0[k] = h0[k] > 0.5 * cy ? Math.floor(h0[k] / cy - 0.5) + below : below - 1;
  const levels = [h0];
  const sites = new Float32Array(clearance.length);
  for (let n = 1; n <= LEVELS; n++) {
    const r = (n * rVox) / LEVELS;
    for (let k = 0; k < sites.length; k++) sites[k] = solid[k] && Math.sqrt(clearance[k]) - 0.5 >= r ? 0 : INF; // where a ball of radius r fits
    distance3d(sites, nxp, nzp, nyp);
    const heights = new Float32Array(cells);
    const reach = (r + 1e-3) * (r + 1e-3);
    for (let gj = 0; gj < nz; gj++) {
      for (let gi = 0; gi < nx; gi++) {
        const col = gj * nx + gi;
        if (h0[col] <= 0) continue;
        let l = nyp - 1;
        while (l >= 0 && sites[voxel(gi + pad, gj + pad, l)] > reach) l--;
        heights[col] = l >= topLayer0[col] ? h0[col] : Math.min(h0[col], Math.max(0, (l + 1 - below) * cy));
      }
    }
    levels.push(heights);
    await tick();
  }

  // The surface the wind touches: cells with a lower neighbour, and which of the 8 directions they have one in.
  const edge = [], edgeDirs = [];
  for (let gj = 0; gj < nz; gj++) {
    for (let gi = 0; gi < nx; gi++) {
      const col = gj * nx + gi;
      if (h0[col] <= 0.5) continue;
      const lower = [];
      DIRS.forEach((d, n) => {
        const i = gi + d.di, j = gj + d.dj;
        const h = i < 0 || j < 0 || i >= nx || j >= nz ? 0 : h0[j * nx + i];
        if (h < h0[col] - MIN_DROP) lower.push(n);
      });
      if (lower.length) { edge.push(col); edgeDirs.push(lower); }
    }
  }

  const er = { rMax };
  const wearEdge = new Float32Array(cells); // 0..1: how worn each surface cell is
  let dirty = false;
  let changedCells = 0;

  // How hard the wind rose pushes on a face looking in each of the 8 directions (a neighbour upwind = a windward face).
  const pressure = (rose) => {
    const p = new Float32Array(DIRS.length);
    rose.bins.forEach((b, i) => {
      if (!b.freq) return;
      const [ux, uz] = downwind(i * 22.5);
      const strength = b.freq * (b.mean / REF_SPEED) ** 2;
      DIRS.forEach((d, n) => (p[n] += strength * (0.15 + 0.85 * Math.sqrt((1 - (d.x * ux + d.z * uz)) / 2))));
    });
    return p;
  };

  // The wind (a getWind() rose) blows for `seconds` of simulated time at `rate` times the usual strength.
  er.expose = (rose, seconds, rate) => {
    const p = pressure(rose), step = (seconds * rate) / FULL_TIME;
    for (let e = 0; e < edge.length; e++) {
      let best = 0;
      for (const n of edgeDirs[e]) best = Math.max(best, p[n]);
      const col = edge[e], worn = Math.min(1, wearEdge[col] + best * step);
      if (worn !== wearEdge[col]) { wearEdge[col] = worn; dirty = true; }
    }
  };

  // Max filter then two box blurs along one axis of the plan grid: spreads wear to the columns the rounding reaches.
  const spread = (src, radius, horizontal, mode) => {
    const dst = new Float32Array(cells), n = horizontal ? nx : nz, lines = horizontal ? nz : nx, r = horizontal ? radius[0] : radius[1];
    for (let line = 0; line < lines; line++) {
      for (let q = 0; q < n; q++) {
        let acc = 0;
        const a = Math.max(0, q - r), b = Math.min(n - 1, q + r);
        for (let t = a; t <= b; t++) {
          const v = src[horizontal ? line * nx + t : t * nx + line];
          acc = mode === "max" ? Math.max(acc, v) : acc + v;
        }
        dst[horizontal ? line * nx + q : q * nx + line] = mode === "max" ? acc : acc / (b - a + 1);
      }
    }
    return dst;
  };

  // Call every so often: re-rounds the mass where the wear has grown. Says whether the shape changed.
  er.recompute = () => {
    if (!dirty) return false;
    dirty = false;
    const reachCells = [Math.max(1, Math.round(rMax / cu)), Math.max(1, Math.round(rMax / cv))];
    const soft = [Math.max(1, reachCells[0] >> 2), Math.max(1, reachCells[1] >> 2)];
    let field = spread(spread(wearEdge, reachCells, true, "max"), reachCells, false, "max");
    for (let pass = 0; pass < 2; pass++) field = spread(spread(field, soft, true, "mean"), soft, false, "mean");
    changedCells = 0;
    let widest = 0;
    for (let col = 0; col < cells; col++) {
      if (h0[col] <= 0) continue;
      widest = Math.max(widest, field[col]);
      const at = clamp(field[col], 0, 1) * LEVELS, n = Math.min(LEVELS - 1, Math.floor(at)), t = at - n;
      const h = levels[n][col] + (levels[n + 1][col] - levels[n][col]) * t;
      form.heights[col] = Math.min(form.heights[col], h); // wear only grows
      form.wear[col] = Math.max(form.wear[col], field[col]);
      if (form.heights[col] < h0[col] - 0.02) changedCells++;
    }
    er.radius = clamp(widest, 0, 1) * rMax; // metres: the widest rounding so far
    form.version++;
    return true;
  };

  er.radius = 0;
  er.changed = () => changedCells > 0;
  return er;
}

/* ---------- the cut handed to the shared erosion pipeline ---------- */

let active = null;
let cached = { version: -1, cuts: [] };

export function setActiveForm(form) {
  active = form;
  cached = { version: -1, cuts: [] };
}

// Signed-distance cut (negative inside the removed volume): everything above the form, over the columns that are lower than the
// mass was placed. (What the sun added is not a cut: cuts only remove.)
export function activeFormCuts() {
  if (!active) return [];
  if (cached.version === active.version) return cached.cuts;
  const { nx, nz, h0, heights, cx, cz, x0, z0 } = active;
  const bounds = new THREE.Box3();
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (heights[k] >= h0[k] - 0.02) continue;
      bounds.expandByPoint(new THREE.Vector3(x0 + i * cx, 0, z0 + j * cz));
      bounds.expandByPoint(new THREE.Vector3(x0 + (i + 1) * cx, h0[k], z0 + (j + 1) * cz));
    }
  }
  let cut = null;
  if (!bounds.isEmpty()) {
    // Only the lowered columns remove anything; elsewhere the mass is left as it was.
    const sdf = (x, y, z) => {
      const i = Math.floor((x - x0) / cx), j = Math.floor((z - z0) / cz);
      if (i < 0 || j < 0 || i >= nx || j >= nz) return 1;
      const k = j * nx + i;
      return heights[k] >= h0[k] - 0.02 ? 1 : heights[k] - y;
    };
    cut = createCut({ id: "ext-form-rounding", source: "exterior", label: "Wind rounding of edges", bounds, sdf });
  }
  cached = { version: active.version, cuts: cut ? [cut] : [] };
  return cached.cuts;
}
