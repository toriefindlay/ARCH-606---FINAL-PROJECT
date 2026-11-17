// MODEL (exterior erosion): the softened skin of the mass, once the wind tunnels are finished. No scene or DOM code; tunnelMesh.js draws what it makes.
//
// The whole outside of the mass is ONE smooth implicit surface (a signed distance field on a fine grid: negative inside the stone), meshed with
// marching cubes and shaded smoothly, which replaces the mass's own surface while it is shown. It is made from the mass as placed (and never changes
// it, or the tunnels, or the cooling: those are all worked out on the mass as placed):
//  1. the mass's signed distance, smoothed (a Gaussian blur of a distance field leaves flat walls where they are and rounds every convex corner and
//     edge, more the more it is blurred): the rounding of the corners and the roof edge;
//  2. pushed in or out along the walls by a shift that depends on the distance from the nearest opening: the face sinks into a soft dish at an opening
//     and swells out in between (DISH at the opening, BULGE far from one, smoothly between), not at the roof or the foot. Some openings have a broad,
//     flat, softly receding pad (a featured one, or a middle one), and a slow large wave runs over the walls so that nothing is the same everywhere;
//  3. the tunnels taken out with a soft subtraction (a smooth max of the skin and the inside of the tunnels), which rounds the edge of every opening
//     into the face like the reveal round a window.
// The part of the mesh that lies on the tunnels is returned apart from the rest, so that the x-ray mode can show the tunnels solid.
//
// Everything is done a slice at a time (generators, see marching.js) so that no frame is held up by it.
import { distance3d } from "./windErode.js";
import { march, fresh, due } from "./marching.js";

const INF = 1e20;
const BULGE = 1.4; // metres: how far the walls swell out, far from an opening, at full strength
const DISH = 1.5; // metres: how far they sink in at an opening
const NEAR = 2.0, FAR = 8.0; // metres from the nearest opening: the dish is full up to NEAR, the swelling is full from FAR on
// Some openings (FEATURE_SHARE of them, chosen at random but at least FEATURE_GAP metres apart so that their pads do not run into each other) are
// given a broad, flat, softly receding pad: the dish stays full over NEAR_F metres and rises over the next metres to FAR_F, instead of NEAR to FAR.
const FEATURE_SHARE = 0.4, FEATURE_GAP = 9, NEAR_F = 4.5, FAR_F = 10;
// A second, middle size of pad for a further MEDIUM_SHARE of the openings (so that there are small dimples, middle pads and large ones, not two kinds).
const MEDIUM_SHARE = 0.35, MEDIUM_GAP = 6, NEAR_M = 3, FAR_M = 7.5;
// A slow, large wave over the walls, independent of the openings (a few sines of wavelength WAVES[i][3] metres), so that the swelling between
// openings is not the same everywhere: NOISE_AMP metres at full strength, and less near an opening, where the dish rules.
const NOISE_AMP = 1.0;
const WAVES = [[0.8, 0.3, 0.5, 17, 0.7], [-0.5, 0.2, 0.84, 26, 2.1], [0.2, -0.4, 0.9, 38, 4.0], [0.9, 0.1, -0.4, 12, 5.3]].map(([x, y, z, wl, ph]) => {
  const l = Math.hypot(x, y, z);
  return { x: (x / l) * ((2 * Math.PI) / wl), y: (y / l) * ((2 * Math.PI) / wl), z: (z / l) * ((2 * Math.PI) / wl), ph };
});
const ROUND_SIGMA = 3.2; // metres: the blur of the mass's distance field at full strength (the corners and the roof edge round to about twice this)
const FILLET = 1.5; // metres: how softly the tunnels are subtracted (the rounding of the edge of an opening)
const DELTA_SIGMA = 1.8; // metres: the blur of the distance from the openings (a distance has a crease half way between two openings, which showed as a ridge)
const SMOOTH_SIGMA = 1.0; // metres: the blur of the skin once pushed in and out, at full strength (evens out what is left of the small lumps)
const MAX_CELLS = 1.5e6; // cells of the grid at most (the skin is smooth: a grid of about half a metre is enough, and quick)
const PAD = 3, BELOW = 3; // metres of grid beyond the mass, and below the ground (where the mass counts as solid, so that its foot is not rounded)
const LIMIT = 8; // metres: distances are kept within this

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
function* blur(a, tmp, g, sigma) {
  const { nx, nz, ny, fc } = g, s = sigma / fc, w = Math.round((Math.sqrt(4 * s * s + 1) - 1) / 2);
  if (w < 1) return;
  for (let pass = 0; pass < 3; pass++) {
    boxAxis(a, tmp, nx, 1, nz * ny, (l) => l * nx, w);
    if (due()) { yield; fresh(); }
    boxAxis(tmp, a, nz, nx, nx * ny, (l) => Math.floor(l / nx) * nz * nx + (l % nx), w);
    if (due()) { yield; fresh(); }
    boxAxis(a, tmp, ny, nx * nz, nx * nz, (l) => l, w);
    a.set(tmp);
    if (due()) { yield; fresh(); }
  }
}

export function createSkinShell() {
  let cache = null; // what does not depend on the amount: the grid, the mass's distance field, the distances to the openings, the tunnels' field

  function* prepare(tunnels) {
    const key = `${tunnels.id}|${tunnels.version}`;
    if (cache?.key === key) return cache;
    cache = null;
    const openings = tunnels.openings();
    if (!openings.length) return null;
    const { massBox } = tunnels, { edges } = tunnels.network();
    const segs = edges.map((e) => [e.a.x, e.a.y, e.a.z, e.b.x, e.b.y, e.b.z, e.r]);
    const ox = massBox.x0 - PAD, oz = massBox.z0 - PAD, oy = -BELOW;
    const W = massBox.x1 - massBox.x0 + 2 * PAD, D = massBox.z1 - massBox.z0 + 2 * PAD, H = massBox.top + PAD + BELOW;
    const fc = Math.max(0.3, Math.min(1, Math.cbrt((W * D * H) / MAX_CELLS)));
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
      if (due()) { yield; fresh(); }
    }
    for (let k = 0; k < N; k++) grid[k] = solid[k] ? 0 : INF;
    distance3d(grid, nx, nz, ny);
    for (let k = 0; k < N; k++) if (!solid[k]) phi[k] = Math.min(LIMIT, (Math.sqrt(grid[k]) - 0.5) * fc);
    yield; fresh();
    for (let k = 0; k < N; k++) grid[k] = solid[k] ? INF : 0;
    distance3d(grid, nx, nz, ny);
    for (let k = 0; k < N; k++) if (solid[k]) phi[k] = -Math.min(LIMIT, (Math.sqrt(grid[k]) - 0.5) * fc);
    yield; fresh();

    // the distance from the nearest opening, and from the nearest featured and middle ones (see FEATURE_SHARE and MEDIUM_SHARE)
    const tmp = new Float32Array(N);
    const distanceTo = function* (list) {
      const out = new Float32Array(N).fill(30);
      if (!list.length) return out;
      grid.fill(INF);
      for (const o of list) {
        const a = Math.floor((o.x - ox) / fc), m = Math.floor((o.y - oy) / fc), b = Math.floor((o.z - oz) / fc);
        if (a >= 0 && b >= 0 && m >= 0 && a < nx && b < nz && m < ny) grid[at(a, m, b)] = 0;
      }
      distance3d(grid, nx, nz, ny);
      for (let k = 0; k < N; k++) out[k] = Math.min(30, Math.sqrt(grid[k]) * fc);
      yield; fresh();
      yield* blur(out, tmp, g, DELTA_SIGMA);
      return out;
    };
    const delta = yield* distanceTo(openings);
    const rank = (o) => { const s = Math.sin(o.x * 12.9898 + o.y * 78.233 + o.z * 37.719) * 43758.5453; return s - Math.floor(s); }; // (a fixed pseudo-random number 0..1 for the opening)
    const featured = [];
    for (const o of [...openings].sort((p, q) => rank(p) - rank(q))) {
      if (rank(o) > FEATURE_SHARE) break;
      if (featured.every((f) => Math.hypot(f.x - o.x, f.y - o.y, f.z - o.z) >= FEATURE_GAP)) featured.push(o);
    }
    const deltaF = yield* distanceTo(featured);
    const rank2 = (o) => { const s = Math.sin(o.x * 39.346 + o.y * 11.135 + o.z * 83.155) * 24634.6345; return s - Math.floor(s); };
    const medium = [];
    for (const o of [...openings].sort((p, q) => rank2(p) - rank2(q))) {
      if (rank2(o) > MEDIUM_SHARE) break;
      if (featured.includes(o)) continue;
      if ([...featured, ...medium].every((f) => Math.hypot(f.x - o.x, f.y - o.y, f.z - o.z) >= MEDIUM_GAP)) medium.push(o);
    }
    const deltaM = yield* distanceTo(medium);

    // the tunnels: the distance to the nearest tube's surface (negative inside), near them only
    const tun = new Float32Array(N).fill(99);
    for (const [ax, ay, az, bx, by, bz, r] of segs) {
      const reach = r + FILLET + 1, sx = bx - ax, sy = by - ay, sz = bz - az, len2 = sx * sx + sy * sy + sz * sz || 1;
      const a0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - ox) / fc)), a1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) + reach - ox) / fc));
      const b0 = Math.max(0, Math.floor((Math.min(az, bz) - reach - oz) / fc)), b1 = Math.min(nz - 1, Math.floor((Math.max(az, bz) + reach - oz) / fc));
      const m0 = Math.max(0, Math.floor((Math.min(ay, by) - reach - oy) / fc)), m1 = Math.min(ny - 1, Math.floor((Math.max(ay, by) + reach - oy) / fc));
      for (let m = m0; m <= m1; m++) {
        const y = oy + (m + 0.5) * fc;
        for (let b = b0; b <= b1; b++) {
          const z = oz + (b + 0.5) * fc;
          for (let a = a0; a <= a1; a++) {
            const x = ox + (a + 0.5) * fc;
            const u = Math.max(0, Math.min(1, ((x - ax) * sx + (y - ay) * sy + (z - az) * sz) / len2));
            const d = Math.hypot(x - (ax + sx * u), y - (ay + sy * u), z - (az + sz * u)) - r, k = at(a, m, b);
            if (d < tun[k]) tun[k] = d;
          }
        }
      }
      if (due()) { yield; fresh(); }
    }
    cache = { key, g, phi, delta, deltaF, deltaM, tun, env: new Float32Array(N), tmp, sh: new Float32Array(N) };
    return cache;
  }

  return {
    clear() { cache = null; },

    // The skin for `amount` (0 to 1) of full strength, a slice at a time (a generator): at the end { skin, wall }, each { position, normal } (flat arrays of
    // triangles), the part on the tunnels being `wall`. Null if there is nothing to make it from.
    *build(tunnels, amount) {
      const c = yield* prepare(tunnels);
      if (!c || amount <= 0) return null;
      const { g, phi, delta, deltaF, deltaM, tun, env, tmp, sh } = c, { ox, oy, oz, fc, nx, nz, ny } = g;
      const at = (a, m, b) => (m * nz + b) * nx + a;

      // 1. the rounding: the mass's distance field blurred
      env.set(phi);
      yield* blur(env, tmp, g, ROUND_SIGMA * amount);

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
              const s = Math.min(smooth((delta[k] - NEAR) / (FAR - NEAR)), smooth((deltaF[k] - NEAR_F) / (FAR_F - NEAR_F)), smooth((deltaM[k] - NEAR_M) / (FAR_M - NEAR_M))); // (the larger pads are the wider)
              const x = ox + (a + 0.5) * fc, z = oz + (b + 0.5) * fc;
              let n = 0;
              for (const wv of WAVES) n += 0.25 * Math.sin(wv.x * x + wv.y * y + wv.z * z + wv.ph);
              v = p - amount * (BULGE * s - DISH * (1 - s) + NOISE_AMP * n * (0.3 + 0.7 * s)) * wall * fade;
            }
            sh[k] = v;
          }
        }
        if (due()) { yield; fresh(); }
      }
      yield* blur(sh, tmp, g, SMOOTH_SIGMA * amount);
      // 3. the tunnels taken out softly: the soft maximum of the skin and the inside of the tunnels
      for (let k0 = 0; k0 < g.N; k0 += 100000) {
        const k1 = Math.min(g.N, k0 + 100000);
        for (let k = k0; k < k1; k++) {
          const v = sh[k], t = -tun[k], h = Math.max(FILLET - Math.abs(v - t), 0) / FILLET;
          sh[k] = Math.max(v, t) + h * h * FILLET * 0.25;
        }
        if (due()) { yield; fresh(); }
      }

      // marching cubes on the result (inside the stone is below zero)
      const out = { skin: { position: [], normal: [] }, wall: { position: [], normal: [] } };
      yield* march(sh, g, 0, LIMIT, (ca, cm, cb) => {
        if (oy + (cm + 0.5) * fc < 0.12) return null; // nothing below the ground
        const ia = Math.max(0, Math.min(nx - 1, Math.round(ca))), im = Math.max(0, Math.min(ny - 1, Math.round(cm))), ib = Math.max(0, Math.min(nz - 1, Math.round(cb)));
        return tun[at(ia, im, ib)] < 0.7 ? out.wall : out.skin; // (on or beside a tunnel's surface, or on the skin)
      });
      return out;
    },
  };
}
