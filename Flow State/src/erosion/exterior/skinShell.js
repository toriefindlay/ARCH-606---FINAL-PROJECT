// MODEL (exterior erosion): the softened skin of the mass, once the wind tunnels are finished. No scene or DOM code; tunnelMesh.js draws what it makes.
//
// The whole outside of the mass is ONE smooth implicit surface (a signed distance field on a fine grid: negative inside the stone), meshed with
// marching cubes and shaded smoothly, which replaces the mass's own surface while it is shown. It is made from the mass as placed (and never changes
// it, or the tunnels, or the cooling: those are all worked out on the mass as placed):
//  1. the mass's signed distance, smoothed (a Gaussian blur of a distance field leaves flat walls where they are and rounds every convex corner and
//     edge, more the more it is blurred): the rounding of the corners and the roof edge;
//  2. pushed in or out along the walls by a shift that depends on the distance from the nearest opening: the face sinks into a soft dish at an opening
//     and swells out in between (DISH at the opening, BULGE far from one, smoothly between), not at the roof or the foot;
//  3. the tunnels taken out with a soft subtraction (a smooth max of the skin and the inside of the tunnels), which rounds the edge of every opening
//     into the face like the reveal round a window.
// The part of the mesh that lies on the tunnels is returned apart from the rest, so that the x-ray mode can show the tunnels solid.
import { edgeTable, triTable } from "three/addons/objects/MarchingCubes.js";
import { distance3d } from "./windErode.js";

const INF = 1e20;
const BULGE = 1.4; // metres: how far the walls swell out, far from an opening, at full strength
const DISH = 1.5; // metres: how far they sink in at an opening
const NEAR = 2.0, FAR = 8.0; // metres from the nearest opening: the dish is full up to NEAR, the swelling is full from FAR on
// Some openings (FEATURE_SHARE of them, chosen at random but at least FEATURE_GAP metres apart so that their pads do not run into each other) are
// given a broad, flat, softly receding pad: the dish stays full over NEAR_F metres and rises over the next metres to FAR_F, instead of NEAR to FAR.
const FEATURE_SHARE = 0.4, FEATURE_GAP = 9, NEAR_F = 4.5, FAR_F = 10;
const ROUND_SIGMA = 3.2; // metres: the blur of the mass's distance field at full strength (the corners and the roof edge round to about twice this)
const FILLET = 1.5; // metres: how softly the tunnels are subtracted (the rounding of the edge of an opening)
const DELTA_SIGMA = 1.8; // metres: the blur of the distance from the openings (a distance has a crease half way between two openings, which showed as a ridge)
const SMOOTH_SIGMA = 1.0; // metres: the blur of the skin once pushed in and out, at full strength (evens out what is left of the small lumps)
const MAX_CELLS = 3e6;
const PAD = 3, BELOW = 3; // metres of grid beyond the mass, and below the ground (where the mass counts as solid, so that its foot is not rounded)
const LIMIT = 8; // metres: distances are kept within this
const MC_CORNERS = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const MC_EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

const clamp01 = (t) => Math.max(0, Math.min(1, t));
const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };

// One box blur along an axis (running sum, the ends held): n samples a line, `lines` lines, `startOf(l)` the index of a line's first sample.
function boxAxis(src, dst, n, stride, lines, startOf, w) {
  const len = 2 * w + 1;
  for (let l = 0; l < lines; l++) {
    const base = startOf(l);
    let sum = 0;
    for (let q = -w; q <= w; q++) sum += src[base + Math.max(0, Math.min(n - 1, q)) * stride];
    for (let q = 0; q < n; q++) {
      dst[base + q * stride] = sum / len;
      sum += src[base + Math.min(n - 1, q + w + 1) * stride] - src[base + Math.max(0, q - w) * stride];
    }
  }
}

// Blurs a field in place, about a Gaussian of `sigma` metres (three passes of a box blur along each axis); `tmp` is a field of the same size to work in.
function blur(a, tmp, g, sigma) {
  const { nx, nz, ny, fc } = g, s = sigma / fc, w = Math.round((Math.sqrt(4 * s * s + 1) - 1) / 2);
  if (w < 1) return;
  for (let pass = 0; pass < 3; pass++) {
    boxAxis(a, tmp, nx, 1, nz * ny, (l) => l * nx, w);
    boxAxis(tmp, a, nz, nx, nx * ny, (l) => Math.floor(l / nx) * nz * nx + (l % nx), w);
    boxAxis(a, tmp, ny, nx * nz, nx * nz, (l) => l, w);
    a.set(tmp);
  }
}

export function createSkinShell() {
  let cache = null; // what does not depend on the amount: the grid, the mass's distance field, the distance to the openings, the tunnels' field

  const prepare = (tunnels) => {
    const key = `${tunnels.id}|${tunnels.version}`;
    if (cache?.key === key) return cache;
    cache = null;
    const openings = tunnels.openings();
    if (!openings.length) return null;
    const { massBox } = tunnels, { edges } = tunnels.network();
    const ox = massBox.x0 - PAD, oz = massBox.z0 - PAD, oy = -BELOW;
    const W = massBox.x1 - massBox.x0 + 2 * PAD, D = massBox.z1 - massBox.z0 + 2 * PAD, H = massBox.top + PAD + BELOW;
    const fc = Math.max(0.3, Math.min(0.9, Math.cbrt((W * D * H) / MAX_CELLS)));
    const nx = Math.ceil(W / fc), nz = Math.ceil(D / fc), ny = Math.ceil(H / fc), N = nx * nz * ny;
    const g = { ox, oy, oz, fc, nx, nz, ny, N };
    const at = (a, m, b) => (m * nz + b) * nx + a;

    // the mass as placed: solid below its height at every column (and everywhere below the ground), then its signed distance
    const solid = new Uint8Array(N), grid = new Float32Array(N), phi = new Float32Array(N);
    for (let b = 0; b < nz; b++) {
      for (let a = 0; a < nx; a++) {
        const h = tunnels.heightAt(ox + (a + 0.5) * fc, oz + (b + 0.5) * fc);
        for (let m = 0; m < ny; m++) {
          const y = oy + (m + 0.5) * fc;
          if (y < 0 || h > y) solid[at(a, m, b)] = 1;
        }
      }
    }
    for (let k = 0; k < N; k++) grid[k] = solid[k] ? 0 : INF;
    distance3d(grid, nx, nz, ny);
    for (let k = 0; k < N; k++) if (!solid[k]) phi[k] = Math.min(LIMIT, (Math.sqrt(grid[k]) - 0.5) * fc);
    for (let k = 0; k < N; k++) grid[k] = solid[k] ? INF : 0;
    distance3d(grid, nx, nz, ny);
    for (let k = 0; k < N; k++) if (solid[k]) phi[k] = -Math.min(LIMIT, (Math.sqrt(grid[k]) - 0.5) * fc);

    // the distance from the nearest opening, and from the nearest featured one (see FEATURE_SHARE)
    const tmp = new Float32Array(N);
    const distanceTo = (list) => {
      const out = new Float32Array(N).fill(30);
      if (!list.length) return out;
      grid.fill(INF);
      for (const o of list) {
        const a = Math.floor((o.x - ox) / fc), m = Math.floor((o.y - oy) / fc), b = Math.floor((o.z - oz) / fc);
        if (a >= 0 && b >= 0 && m >= 0 && a < nx && b < nz && m < ny) grid[at(a, m, b)] = 0;
      }
      distance3d(grid, nx, nz, ny);
      for (let k = 0; k < N; k++) out[k] = Math.min(30, Math.sqrt(grid[k]) * fc);
      blur(out, tmp, g, DELTA_SIGMA);
      return out;
    };
    const delta = distanceTo(openings);
    const rank = (o) => { const s = Math.sin(o.x * 12.9898 + o.y * 78.233 + o.z * 37.719) * 43758.5453; return s - Math.floor(s); }; // (a fixed pseudo-random number 0..1 for the opening)
    const featured = [];
    for (const o of [...openings].sort((p, q) => rank(p) - rank(q))) {
      if (rank(o) > FEATURE_SHARE) break;
      if (featured.every((f) => Math.hypot(f.x - o.x, f.y - o.y, f.z - o.z) >= FEATURE_GAP)) featured.push(o);
    }
    const deltaF = distanceTo(featured);

    // the tunnels: the distance to the nearest tube's surface (negative inside), near them only
    const tun = new Float32Array(N).fill(99);
    for (const e of edges) {
      const A = e.a, B = e.b, reach = e.r + FILLET + 1, sx = B.x - A.x, sy = B.y - A.y, sz = B.z - A.z, len2 = sx * sx + sy * sy + sz * sz || 1;
      const a0 = Math.max(0, Math.floor((Math.min(A.x, B.x) - reach - ox) / fc)), a1 = Math.min(nx - 1, Math.floor((Math.max(A.x, B.x) + reach - ox) / fc));
      const b0 = Math.max(0, Math.floor((Math.min(A.z, B.z) - reach - oz) / fc)), b1 = Math.min(nz - 1, Math.floor((Math.max(A.z, B.z) + reach - oz) / fc));
      const m0 = Math.max(0, Math.floor((Math.min(A.y, B.y) - reach - oy) / fc)), m1 = Math.min(ny - 1, Math.floor((Math.max(A.y, B.y) + reach - oy) / fc));
      for (let m = m0; m <= m1; m++) {
        const y = oy + (m + 0.5) * fc;
        for (let b = b0; b <= b1; b++) {
          const z = oz + (b + 0.5) * fc;
          for (let a = a0; a <= a1; a++) {
            const x = ox + (a + 0.5) * fc;
            const u = Math.max(0, Math.min(1, ((x - A.x) * sx + (y - A.y) * sy + (z - A.z) * sz) / len2));
            const d = Math.hypot(x - (A.x + sx * u), y - (A.y + sy * u), z - (A.z + sz * u)) - e.r, k = at(a, m, b);
            if (d < tun[k]) tun[k] = d;
          }
        }
      }
    }
    cache = { key, g, phi, delta, deltaF, tun, env: new Float32Array(N), tmp, sh: new Float32Array(N) };
    return cache;
  };

  return {
    clear() { cache = null; },

    // The skin for `amount` (0 to 1) of full strength: { skin, wall }, each { position, normal } (flat arrays of triangles), the part on the tunnels
    // being `wall`. Null if there is nothing to make it from.
    build(tunnels, amount) {
      const c = prepare(tunnels);
      if (!c || amount <= 0) return null;
      const { g, phi, delta, deltaF, tun, env, tmp, sh } = c, { ox, oy, oz, fc, nx, nz, ny } = g;
      const at = (a, m, b) => (m * nz + b) * nx + a;

      // 1. the rounding: the mass's distance field blurred (three passes of a box blur along each axis, about a Gaussian)
      env.set(phi);
      blur(env, tmp, g, ROUND_SIGMA * amount);

      // 2. the walls pushed in near the openings and out between them (then evened out a little more)
      for (let m = 0; m < ny; m++) {
        const y = oy + (m + 0.5) * fc, fade = smooth(y / 2.5); // (the foot is left alone)
        for (let b = 0; b < nz; b++) {
          for (let a = 0; a < nx; a++) {
            const k = at(a, m, b), p = env[k];
            let v = p;
            if (p > -4 && p < 4 && a > 0 && b > 0 && m > 0 && a < nx - 1 && b < nz - 1 && m < ny - 1) {
              const gx = env[k + 1] - env[k - 1], gz = env[k + nx] - env[k - nx], gy = env[k + nx * nz] - env[k - nx * nz];
              const wall = Math.hypot(gx, gz) / (Math.hypot(gx, gy, gz) || 1); // 1 on a wall, 0 on a roof
              const s = Math.min(smooth((delta[k] - NEAR) / (FAR - NEAR)), smooth((deltaF[k] - NEAR_F) / (FAR_F - NEAR_F))); // (the featured openings' pads are the wider)
              v = p - amount * (BULGE * s - DISH * (1 - s)) * wall * fade;
            }
            sh[k] = v;
          }
        }
      }
      blur(sh, tmp, g, SMOOTH_SIGMA * amount);
      // 3. the tunnels taken out softly: the soft maximum of the skin and the inside of the tunnels
      for (let k = 0; k < g.N; k++) {
        const v = sh[k], t = -tun[k], h = Math.max(FILLET - Math.abs(v - t), 0) / FILLET;
        sh[k] = Math.max(v, t) + h * h * FILLET * 0.25;
      }

      // marching cubes on the result (inside the stone is below zero)
      const value = (a, m, b) => (a < 0 || b < 0 || m < 0 || a >= nx || b >= nz || m >= ny ? LIMIT : sh[at(a, m, b)]);
      const out = { skin: { position: [], normal: [] }, wall: { position: [], normal: [] } };
      const v8 = new Float32Array(8), pt = new Array(12), nrm = new Array(12);
      const grad = (a, m, b) => [value(a + 1, m, b) - value(a - 1, m, b), value(a, m + 1, b) - value(a, m - 1, b), value(a, m, b + 1) - value(a, m, b - 1)];
      for (let m = 0; m < ny - 1; m++) {
        for (let b = 0; b < nz - 1; b++) {
          for (let a = 0; a < nx - 1; a++) {
            let index = 0;
            for (let q = 0; q < 8; q++) {
              const [da, dm, db] = MC_CORNERS[q];
              v8[q] = sh[at(a + da, m + dm, b + db)];
              if (v8[q] < 0) index |= 1 << q;
            }
            const bits = edgeTable[index];
            if (!bits) continue;
            for (let e = 0; e < 12; e++) {
              if (!(bits & (1 << e))) continue;
              const [p0, p1] = MC_EDGES[e], v0 = v8[p0], v1 = v8[p1], t = v1 === v0 ? 0.5 : -v0 / (v1 - v0), A = MC_CORNERS[p0], B = MC_CORNERS[p1];
              pt[e] = [a + A[0] + t * (B[0] - A[0]), m + A[1] + t * (B[1] - A[1]), b + A[2] + t * (B[2] - A[2])];
              const ga = grad(a + A[0], m + A[1], b + A[2]), gb = grad(a + B[0], m + B[1], b + B[2]);
              nrm[e] = [ga[0] + t * (gb[0] - ga[0]), ga[1] + t * (gb[1] - ga[1]), ga[2] + t * (gb[2] - ga[2])];
            }
            for (let t = index << 4; triTable[t] !== -1; t += 3) {
              const tri = [triTable[t], triTable[t + 1], triTable[t + 2]];
              const ca = (pt[tri[0]][0] + pt[tri[1]][0] + pt[tri[2]][0]) / 3, cm = (pt[tri[0]][1] + pt[tri[1]][1] + pt[tri[2]][1]) / 3, cb = (pt[tri[0]][2] + pt[tri[1]][2] + pt[tri[2]][2]) / 3;
              if (oy + (cm + 0.5) * fc < 0.12) continue; // nothing below the ground
              const ia = Math.max(0, Math.min(nx - 1, Math.round(ca))), im = Math.max(0, Math.min(ny - 1, Math.round(cm))), ib = Math.max(0, Math.min(nz - 1, Math.round(cb)));
              const target = tun[at(ia, im, ib)] < 0.7 ? out.wall : out.skin; // (on or beside a tunnel's surface, or on the skin)
              for (const e of tri) {
                target.position.push(ox + (pt[e][0] + 0.5) * fc, oy + (pt[e][1] + 0.5) * fc, oz + (pt[e][2] + 0.5) * fc);
                const len = Math.hypot(nrm[e][0], nrm[e][1], nrm[e][2]) || 1;
                target.normal.push(nrm[e][0] / len, nrm[e][1] / len, nrm[e][2] / len);
              }
            }
          }
        }
      }
      return out;
    },
  };
}
