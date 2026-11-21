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
// THE RIGID END (the amount of softening 0): a flat, smooth facade with crisp round openings, each with a flared, angled reveal (a bell mouth, wider at the face
// than at the throat, like the openings of a perforated concrete wall). Everything that is soft (the dish, the swelling, the waves, the rounding, the fillet)
// goes down to nothing as the amount goes down to 0, and the flare comes up in its place: it is full at 0 and gone at 1.
const RIGID_ROUND = 0; // metres: the blur of the mass's distance field at amount 0 (none: the corners and the roof edge are sharp)
const RIGID_FILLET = 0; // metres: how softly the tunnels are subtracted at amount 0 (none: the rim of an opening is a sharp circle)
const FLARE_ANGLE = (30 * Math.PI) / 180; // the reveal's angle to the axis of the opening (it is a straight cone): the smaller, the deeper it goes for its width
const FLARE_GROW = [0.95, 0.55]; // the mouth's radius is the tube's radius plus (FLARE_GROW[0] x the radius + FLARE_GROW[1] metres) at full flare...
const FLARE_MAX = 2.8; // ...but at most this (metres): openings are only 6 m apart, and two mouths must not run into one another
// The radius of an opening's mouth at the face, for a tube of radius r, at rigidity `rigid` (0 to 1).
const mouthRadius = (r, rigid) => Math.min(r + rigid * (FLARE_GROW[0] * r + FLARE_GROW[1]), Math.max(r + 0.3, FLARE_MAX));
const FLARE_EXP = 1; // how the reveal curves: 1 is a straight cone, more is a trumpet that meets the tube tangentially
// What an opening's cut is made of: the radius r at its throat, the radius rOut at the face, and the depth D from the throat to the face (a cone).
function revealOf(o, rigid) {
  const r = o.r, rOut = mouthRadius(r, rigid);
  return { r, rOut, D: (rOut - r) / Math.tan(FLARE_ANGLE) };
}
// Where a vertex's smooth normal is further than this many degrees from its triangle's, the triangle's is used: a sharp edge stays sharp. The facade (the "skin"
// part) is flat at the rigid end, so any tilt of its normals near an opening is an artefact of the smoothing and the limit is tight there (8 degrees at full
// rigidity, 30 as it gets soft: a softer facade is gently wavy, and flat shading would show it in facets). The tubes and the reveals are curved (22 and 30).
const CREASE_SKIN = [30, 8], CREASE_WALL = [30, 22]; // [at no rigidity, at full rigidity]
const SNAP_FROM = 0.85; // the rims of the openings are snapped to exact circles (see snapRims) when the skin is this rigid (0 to 1) or more
const REVEAL_BAND = 0.15; // metres: the part of the skin within this of a reveal counts as the tunnel's (for the x-ray mode), not the facade

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

// The radius of an opening's reveal at the distance s along its way out from where the opening was put (negative inside the wall): the tube's radius r at the
// throat (s = -D), widening to rOut at the face (s = 0), and on widening as a cone beyond it (see FLARE_EXP).
function coneRadius(s, r, rOut, D) {
  const mouth = ((rOut - r) * FLARE_EXP) / D;
  return s > 0 ? rOut + s * mouth : r + (rOut - r) * Math.pow(Math.max(0, 1 + s / D), FLARE_EXP);
}

// The mesh's vertices cannot lie on the sharp edge where a reveal meets the face (or the tunnel): they are on the grid's cell edges, so the edge becomes a bevel
// about a cell wide, and a small opening looks soft. The edge is known exactly (a circle of the mouth's radius, in the face), so every vertex within a cell of it is
// moved onto it. (Equal positions move together, so the surface stays closed.) `parts` are the { position, normal } sets to treat alike.
function snapRims(parts, openings, rigid, fc) {
  const tol = 1.1 * fc, CELL = 5;
  // the vertices in buckets of CELL metres (there can be hundreds of openings and a few hundred thousand vertices)
  const bucketKey = (x, y, z) => ((Math.floor(x / CELL) + 1000) * 2048 + (Math.floor(y / CELL) + 1000)) * 2048 + (Math.floor(z / CELL) + 1000);
  const buckets = new Map();
  parts.forEach((part, pi) => {
    const p = part.position;
    for (let i = 0; i < p.length; i += 3) {
      const key = bucketKey(p[i], p[i + 1], p[i + 2]);
      let list = buckets.get(key);
      if (!list) buckets.set(key, (list = []));
      list.push(pi, i);
    }
  });
  const near = (o, radius, visit) => {
    for (let kx = Math.floor((o.x - radius) / CELL); kx <= Math.floor((o.x + radius) / CELL); kx++) {
      for (let ky = Math.floor((o.y - radius) / CELL); ky <= Math.floor((o.y + radius) / CELL); ky++) {
        for (let kz = Math.floor((o.z - radius) / CELL); kz <= Math.floor((o.z + radius) / CELL); kz++) {
          const list = buckets.get(((kx + 1000) * 2048 + (ky + 1000)) * 2048 + (kz + 1000));
          if (list) for (let q = 0; q < list.length; q += 2) visit(parts[list[q]].position, list[q + 1]);
        }
      }
    }
  };
  // (a rim that runs into another opening's mouth is left as it is: snapping it would drag points of the other opening's surface onto it, and leave shards)
  const info = openings.map((o) => ({ o, ...revealOf(o, rigid) }));
  for (const { o, r, rOut, D } of info) {
    if (info.some((q) => q.o !== o && q.o.nx * o.nx + q.o.nz * o.nz > 0.5 && Math.hypot(q.o.x - o.x, q.o.y - o.y, q.o.z - o.z) < q.rOut + rOut - 0.1)) continue;
    const near2 = (rOut + 3) * (rOut + 3);
    // where the face is: from the vertices on it, beside the mouth
    const ss = [];
    near(o, rOut + 3, (p, i) => {
      const dx = p[i] - o.x, dy = p[i + 1] - o.y, dz = p[i + 2] - o.z;
      if (dx * dx + dy * dy + dz * dz > near2) return;
      const s = dx * o.nx + dz * o.nz;
      if (s < -1.5 || s > 1.5) return;
      const rho = Math.hypot(dx - s * o.nx, dy, dz - s * o.nz);
      if (rho > rOut + 0.8 && rho < rOut + 2.5) ss.push(s);
    });
    if (ss.length < 6) continue;
    ss.sort((a, b) => a - b);
    const rimS = ss[ss.length >> 1], rimR = coneRadius(rimS, r, rOut, D);
    near(o, rOut + 3, (p, i) => {
      const dx = p[i] - o.x, dy = p[i + 1] - o.y, dz = p[i + 2] - o.z;
      if (dx * dx + dy * dy + dz * dz > near2) return;
      const s = dx * o.nx + dz * o.nz, rx = dx - s * o.nx, rz = dz - s * o.nz, rho = Math.hypot(rx, dy, rz);
      if (rho < 1e-6 || Math.hypot(rho - rimR, s - rimS) >= tol) return;
      p[i] = o.x + rimS * o.nx + (rx / rho) * rimR; p[i + 1] = o.y + (dy / rho) * rimR; p[i + 2] = o.z + rimS * o.nz + (rz / rho) * rimR;
    });
  }
}

// Gives every vertex whose smooth normal is far (see CREASE) from the normal of its triangle that triangle's normal. { position, normal } are flat arrays of
// triangles (9 numbers each).
function sharpen({ position: p, normal: n }, degrees) {
  const CREASE = Math.cos((degrees * Math.PI) / 180);
  for (let t = 0; t + 8 < p.length; t += 9) {
    const ux = p[t + 3] - p[t], uy = p[t + 4] - p[t + 1], uz = p[t + 5] - p[t + 2], vx = p[t + 6] - p[t], vy = p[t + 7] - p[t + 1], vz = p[t + 8] - p[t + 2];
    let fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const fl = Math.hypot(fx, fy, fz);
    if (fl < 1e-12) continue;
    fx /= fl; fy /= fl; fz /= fl;
    // (the face normal on the side the smooth normals are on)
    const side = (n[t] + n[t + 3] + n[t + 6]) * fx + (n[t + 1] + n[t + 4] + n[t + 7]) * fy + (n[t + 2] + n[t + 5] + n[t + 8]) * fz < 0 ? -1 : 1;
    fx *= side; fy *= side; fz *= side;
    for (let v = 0; v < 9; v += 3) {
      if (n[t + v] * fx + n[t + v + 1] * fy + n[t + v + 2] * fz < CREASE) { n[t + v] = fx; n[t + v + 1] = fy; n[t + v + 2] = fz; }
    }
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
    cache = { key, g, phi, delta, deltaF, deltaM, tun, openings, fun: new Float32Array(N), env: new Float32Array(N), tmp, sh: new Float32Array(N) };
    return cache;
  }

  return {
    clear() { cache = null; },

    // The skin for `amount` (0 to 1) of softening, a slice at a time (a generator): 0 is the rigid end (see RIGID_ROUND), 1 the softest. At the end { skin, wall },
    // each { position, normal } (flat arrays of triangles), the part on the tunnels being `wall`. Null if there is nothing to make it from.
    // `cuts` ({ frame: { A, B }, rects: [{ y0, y1, a0, a1, b0, b1 }] }, optional) are the circulation's hallways as boxes (a, b in metres along the axes A and B, in
    // x and z): the skin is cut along the outline of every one that reaches it (see below).
    *build(tunnels, amount, cuts = null) {
      const c = yield* prepare(tunnels);
      if (!c) return null;
      amount = clamp01(amount);
      const rigid = 1 - amount;
      const { g, phi, delta, deltaF, deltaM, tun, openings, fun, env, tmp, sh } = c, { ox, oy, oz, fc, nx, nz, ny } = g;
      const at = (a, m, b) => (m * nz + b) * nx + a;

      // 1. the rounding: the mass's distance field blurred
      env.set(phi);
      yield* blur(env, tmp, g, ROUND_SIGMA * amount + RIGID_ROUND * rigid);

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
      // 2b. the flared reveal of every opening (more of it the more rigid): a bell mouth along the way out, from the tube's radius at depth D inside the wall to a
      // wider mouth at the face. `fun` is its distance field (negative inside), joined to the tunnels' below.
      fun.fill(99);
      for (const o of openings) {
        if (rigid <= 0.02) break; // (no flare at the soft end)
        const { r, rOut, D } = revealOf(o, rigid), reach = rOut + D + 1, mouth = ((rOut - r) * FLARE_EXP) / D;
        const a0 = Math.max(0, Math.floor((o.x - reach - ox) / fc)), a1 = Math.min(nx - 1, Math.floor((o.x + reach - ox) / fc));
        const b0 = Math.max(0, Math.floor((o.z - reach - oz) / fc)), b1 = Math.min(nz - 1, Math.floor((o.z + reach - oz) / fc));
        const m0 = Math.max(0, Math.floor((o.y - rOut - 1 - oy) / fc)), m1 = Math.min(ny - 1, Math.floor((o.y + rOut + 1 - oy) / fc));
        for (let m = m0; m <= m1; m++) {
          const dy = oy + (m + 0.5) * fc - o.y;
          for (let b = b0; b <= b1; b++) {
            const dz = oz + (b + 0.5) * fc - o.z;
            for (let a = a0; a <= a1; a++) {
              const dx = ox + (a + 0.5) * fc - o.x, s = dx * o.nx + dz * o.nz; // (s: how far out of the face, along the way out)
              if (s < -D - 0.5 || s > 1.5) continue;
              const rho = Math.hypot(dx - s * o.nx, dy, dz - s * o.nz), t = Math.min(1, Math.max(0, -s) / D), u = 1 - t;
              // (out beyond the face the cone goes on widening: where the skin's wall is a little out from where the opening was put, the cut then
              // still meets it as a cone, not as a step)
              const R = s > 0 ? rOut + s * mouth : r + (rOut - r) * Math.pow(u, FLARE_EXP), slope = s > 0 ? mouth : mouth * Math.pow(u, FLARE_EXP - 1);
              const val = (rho - R) / Math.sqrt(1 + slope * slope), k = at(a, m, b);
              if (val < fun[k]) fun[k] = val;
            }
          }
        }
        if (due()) { yield; fresh(); }
      }
      // 3. the tunnels (and their reveals) taken out: the soft maximum of the skin and the inside of the tunnels, softly the more it is softened, crisp at the rigid end
      const fillet = RIGID_FILLET * rigid + FILLET * amount;
      for (let k0 = 0; k0 < g.N; k0 += 100000) {
        const k1 = Math.min(g.N, k0 + 100000);
        for (let k = k0; k < k1; k++) {
          const v = sh[k], t = -Math.min(tun[k], fun[k]);
          if (fillet < 1e-4) { sh[k] = Math.max(v, t); continue; } // (no fillet: a hard cut, and a sharp edge)
          const h = Math.max(fillet - Math.abs(v - t), 0) / fillet;
          sh[k] = Math.max(v, t) + h * h * fillet * 0.25;
        }
        if (due()) { yield; fresh(); }
      }

      // 3b. the circulation's hallways where they reach the skin: a hallway (one of the boxes of `cuts`) that crosses the surface of the skin (some of its grid cells
      // are in the stone and some on or outside it) is taken out of the stone with a hard cut, so that the skin has a clean rectangular opening that follows the
      // hallway's outline exactly, with no lip: the box's own planes. A hallway that is wholly inside the stone, or wholly out, does not touch the skin and is
      // left alone.
      if (cuts && cuts.rects.length) {
        const { A, B } = cuts.frame;
        for (const rc of cuts.rects) {
          const ca = (rc.a0 + rc.a1) / 2, cb = (rc.b0 + rc.b1) / 2, cy = (rc.y0 + rc.y1) / 2, ha = (rc.a1 - rc.a0) / 2, hb = (rc.b1 - rc.b0) / 2, hy = (rc.y1 - rc.y0) / 2;
          let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
          for (const [pa, pb] of [[rc.a0, rc.b0], [rc.a1, rc.b0], [rc.a1, rc.b1], [rc.a0, rc.b1]]) {
            const x = pa * A[0] + pb * B[0], z = pa * A[1] + pb * B[1];
            x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
          }
          const ia0 = Math.max(0, Math.floor((x0 - ox) / fc) - 1), ia1 = Math.min(nx - 1, Math.floor((x1 - ox) / fc) + 1);
          const ib0 = Math.max(0, Math.floor((z0 - oz) / fc) - 1), ib1 = Math.min(nz - 1, Math.floor((z1 - oz) / fc) + 1);
          const im0 = Math.max(0, Math.floor((rc.y0 - oy) / fc) - 1), im1 = Math.min(ny - 1, Math.floor((rc.y1 - oy) / fc) + 1);
          if (ia0 > ia1 || ib0 > ib1 || im0 > im1) continue;
          // the distance from a cell's centre to the box (negative inside): the largest of its distances to the box's planes
          const dist = (a, m, b) => {
            const x = ox + (a + 0.5) * fc, z = oz + (b + 0.5) * fc, y = oy + (m + 0.5) * fc;
            return Math.max(Math.abs(x * A[0] + z * A[1] - ca) - ha, Math.abs(x * B[0] + z * B[1] - cb) - hb, Math.abs(y - cy) - hy);
          };
          let lo = Infinity, hi = -Infinity;
          for (let m = im0; m <= im1; m++) for (let b = ib0; b <= ib1; b++) for (let a = ia0; a <= ia1; a++) {
            if (dist(a, m, b) > fc * 0.5) continue; // (only the cells in the box)
            const v = sh[at(a, m, b)];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          if (!(lo < 0.05 && hi > -0.05)) continue; // (wholly in the stone, or wholly out: it does not meet the skin)
          for (let m = im0; m <= im1; m++) {
            for (let b = ib0; b <= ib1; b++) {
              for (let a = ia0; a <= ia1; a++) {
                const k = at(a, m, b), v = -dist(a, m, b);
                if (v > sh[k]) sh[k] = v;
              }
            }
          }
          if (due()) { yield; fresh(); }
        }
      }

      // marching cubes on the result (inside the stone is below zero)
      const out = { skin: { position: [], normal: [] }, wall: { position: [], normal: [] } };
      yield* march(sh, g, 0, LIMIT, (ca, cm, cb) => {
        if (oy + (cm + 0.5) * fc < 0.12) return null; // nothing below the ground
        const ia = Math.max(0, Math.min(nx - 1, Math.round(ca))), im = Math.max(0, Math.min(ny - 1, Math.round(cm))), ib = Math.max(0, Math.min(nz - 1, Math.round(cb)));
        const kk = at(ia, im, ib);
        return tun[kk] < 0.7 || fun[kk] < REVEAL_BAND ? out.wall : out.skin; // (on or beside a tunnel's surface, or on a reveal, or on the skin)
      });
      // Sharp edges: the normals come from the gradient of the field, which smooths an edge over a cell or two. Where a vertex's normal is more than 30 degrees from
      // the normal of its own triangle (a corner, the rim of an opening, the throat of a reveal), the triangle's is used instead. (Not at the soft end, which
      // is left as it was.)
      if (rigid > SNAP_FROM) snapRims([out.skin, out.wall], openings, rigid, fc); // (only where the rim really is sharp: with a softened lip it would leave shards)
      if (amount < 0.95) {
        const k = rigid * rigid;
        sharpen(out.skin, CREASE_SKIN[0] + (CREASE_SKIN[1] - CREASE_SKIN[0]) * k);
        sharpen(out.wall, CREASE_WALL[0] + (CREASE_WALL[1] - CREASE_WALL[0]) * k);
      }
      return out;
    },
  };
}

