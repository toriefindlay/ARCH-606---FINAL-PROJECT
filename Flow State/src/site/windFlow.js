// How the wind bends around the site's buildings and the placed mass, for the wind layer's streaks. Not a fluid solver: a
// steering field. Everything is one height map (the buildings rasterised from their footprints, the mass from massScan.js),
// grown outwards and softened, giving a "pressure hill" that is as tall as the mass
// at its walls and falls to nothing a few tens of metres away. A streak at height y is steered wherever the hill is higher
// than y: the part of its motion that points into the mass is turned sideways (it splits at the face and glides along the
// walls) and, close to the roof height, upwards (it climbs over). Behind the mass the wind is slowed (the wake).

const REACH_MIN = 8, REACH_MAX = 45; // metres: how far from the walls the wind starts to react
const WAKE = [[0.25, 0.4], [0.6, 0.3], [1, 0.2], [1.6, 0.1]]; // [distance in wake lengths, weight] sampled upwind of a streak
const SLOWEST = 0.3; // fraction of the free-stream speed kept in the heart of the wake

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (t) => {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
};

// Separable running filter along one axis of a W x H grid: op(window values) over a +-r window (clamped at the edges).
function filter(src, W, H, r, horizontal, mode) {
  const dst = new Float32Array(src.length);
  const n = horizontal ? W : H, lines = horizontal ? H : W;
  const at = (line, i) => src[horizontal ? line * W + i : i * W + line];
  for (let line = 0; line < lines; line++) {
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - r), b = Math.min(n - 1, i + r);
      let acc = 0;
      for (let k = a; k <= b; k++) acc = mode === "max" ? Math.max(acc, at(line, k)) : acc + at(line, k);
      dst[horizontal ? line * W + i : i * W + line] = mode === "max" ? acc : acc / (2 * r + 1);
    }
  }
  return dst;
}

/* ---------- the city ---------- */

const CITY_REACH = 14; // metres: how far from a building's walls the wind starts to react, street scale
const CITY_CELLS = 320; // per side at most
const CITY_MIN_CELL = 2; // metres

const cityRasters = new WeakMap(); // buildings array -> its height map (it never changes for a site)

// Even-odd point-in-polygon on Vector2 rings (x east, y north).
function inRing(ring, x, y) {
  let inside = false;
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    const p = ring[a], q = ring[b];
    if (p.y > y !== q.y > y && x < ((q.x - p.x) * (y - p.y)) / (q.y - p.y) + p.x) inside = !inside;
  }
  return inside;
}

// The site's buildings as a height map over the whole site, in the shape scanMass() returns (x east, z = -north).
function rasterBuildings(radius, buildings) {
  const half = radius * 1.1;
  const cell = Math.max(CITY_MIN_CELL, (2 * half) / CITY_CELLS);
  const n = Math.ceil((2 * half) / cell);
  const hf = new Float32Array(n * n);
  const x0 = -half, z0 = -half;
  for (const b of buildings) {
    let minX = Infinity, maxX = -Infinity, minN = Infinity, maxN = -Infinity;
    for (const p of b.outer) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minN = Math.min(minN, p.y); maxN = Math.max(maxN, p.y);
    }
    // north = -z
    const ia = Math.max(0, Math.floor((minX - x0) / cell)), ib = Math.min(n - 1, Math.floor((maxX - x0) / cell));
    const ja = Math.max(0, Math.floor((-maxN - z0) / cell)), jb = Math.min(n - 1, Math.floor((-minN - z0) / cell));
    for (let j = ja; j <= jb; j++) {
      const north = -(z0 + (j + 0.5) * cell);
      for (let i = ia; i <= ib; i++) {
        const east = x0 + (i + 0.5) * cell;
        if (hf[j * n + i] >= b.height || !inRing(b.outer, east, north)) continue;
        if (b.holes?.some((h) => inRing(h, east, north))) continue;
        hf[j * n + i] = b.height;
      }
    }
  }
  return { nU: n, nV: n, cu: cell, cv: cell, u0: x0, v0: z0, hf, hw: n, hh: n, sub: 1 };
}

// The height of the site's buildings at a world (x, z), 0 where there are none: (x, z) => metres.
export function cityHeights(radius, buildings) {
  if (!buildings?.length) return () => 0;
  let city = cityRasters.get(buildings);
  if (!city) cityRasters.set(buildings, (city = rasterBuildings(radius, buildings)));
  const { u0, v0, cu, cv, nU, nV, hf } = city;
  return (x, z) => {
    const i = Math.floor((x - u0) / cu), j = Math.floor((z - v0) / cv);
    return i < 0 || j < 0 || i >= nU || j >= nV ? 0 : hf[j * nU + i];
  };
}

// The wind around everything on the site: its buildings (features.buildings) and the placed mass.
// mass: a height map in scanMass()'s shape, or null. Returns null if there is nothing to flow around.
export function createSiteFlow({ radius, buildings, mass }) {
  if (!buildings?.length) return mass ? flowFromScan(mass) : null;
  let city = cityRasters.get(buildings);
  if (!city) cityRasters.set(buildings, (city = rasterBuildings(radius, buildings)));
  if (!mass) return flowFromScan(city, { reach: CITY_REACH });

  // Lay the mass over the city (the taller of the two wins).
  const scan = { ...city, hf: Float32Array.from(city.hf) };
  const step = [mass.cu / mass.sub, mass.cv / mass.sub];
  for (let j = 0; j < scan.nV; j++) {
    const z = scan.v0 + (j + 0.5) * scan.cv, mj = Math.floor((z - mass.v0) / step[1]);
    if (mj < 0 || mj >= mass.hh) continue;
    for (let i = 0; i < scan.nU; i++) {
      const mi = Math.floor((scan.u0 + (i + 0.5) * scan.cu - mass.u0) / step[0]);
      if (mi < 0 || mi >= mass.hw) continue;
      scan.hf[j * scan.nU + i] = Math.max(scan.hf[j * scan.nU + i], mass.hf[mj * mass.hw + mi]);
    }
  }
  return flowFromScan(scan, { reach: CITY_REACH });
}

// scan: a height map in the shape scanMass() returns. `reach` (metres) is how far from the walls the wind starts to react;
// by default it follows the size of what is there.
export function flowFromScan(scan, { reach: fixedReach } = {}) {
  const { hf, hw, hh, nU, nV, cu, cv, sub, u0, v0 } = scan;
  const c = Math.max(cu, cv) / sub; // square cells for the filters
  const size = Math.max(nU * cu, nV * cv);
  const reach = fixedReach ?? clamp(size * 0.4, REACH_MIN, REACH_MAX);
  const r = Math.max(1, Math.round((reach * 0.5) / c));
  const P = 3 * r + 2; // padding so the softened edge has room
  const W = Math.ceil((nU * cu) / c) + 2 * P, H = Math.ceil((nV * cv) / c) + 2 * P;
  const x0 = u0 - P * c, z0 = v0 - P * c;

  // Sharp height map resampled onto the padded grid (0 off the mass).
  const sharp = new Float32Array(W * H);
  let top = 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const si = Math.floor(((i - P + 0.5) * c) / (cu / sub)), sj = Math.floor(((j - P + 0.5) * c) / (cv / sub));
      if (si < 0 || sj < 0 || si >= hw || sj >= hh) continue;
      const h = hf[sj * hw + si];
      sharp[j * W + i] = h;
      top = Math.max(top, h);
    }
  }
  if (top <= 0) return null;

  // The hill: grown by r cells, then softened by two box blurs of r cells.
  let hill = filter(filter(sharp, W, H, r, true, "max"), W, H, r, false, "max");
  for (let pass = 0; pass < 2; pass++) hill = filter(filter(hill, W, H, r, true, "mean"), W, H, r, false, "mean");

  const gx = new Float32Array(W * H), gz = new Float32Array(W * H);
  for (let j = 1; j < H - 1; j++) {
    for (let i = 1; i < W - 1; i++) {
      gx[j * W + i] = (hill[j * W + i + 1] - hill[j * W + i - 1]) / (2 * c);
      gz[j * W + i] = (hill[(j + 1) * W + i] - hill[(j - 1) * W + i]) / (2 * c);
    }
  }

  const bilinear = (arr, x, z) => {
    const fx = clamp((x - x0) / c - 0.5, 0, W - 1.001), fz = clamp((z - z0) / c - 0.5, 0, H - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * W + i;
    return arr[k] * (1 - tx) * (1 - tz) + arr[k + 1] * tx * (1 - tz) + arr[k + W] * (1 - tx) * tz + arr[k + W + 1] * tx * tz;
  };
  const sharpAt = (x, z) => {
    const i = Math.floor((x - x0) / c), j = Math.floor((z - z0) / c);
    return i < 0 || j < 0 || i >= W || j >= H ? 0 : sharp[j * W + i];
  };
  const wakeLength = clamp(top, 10, 60);

  return {
    top,
    // Writes the wind at (x, z, y) into `out` for a free stream of unit direction (ux, uz): the horizontal direction
    // (vx, vz), a climb rate vy and the speed factor k, all relative to the free-stream speed. `side` (+1 or -1) is
    // the way a streak that hits a wall head-on turns.
    steer(out, x, z, y, ux, uz, side) {
      out.vx = ux; out.vz = uz; out.vy = 0; out.k = 1;
      const h = bilinear(hill, x, z);
      if (h > y) {
        const dx = bilinear(gx, x, z), dz = bilinear(gz, x, z), g = Math.hypot(dx, dz);
        const un = g > 1e-4 ? (-ux * dx - uz * dz) / g : 0; // wind along the outward normal: negative = heading into the mass
        if (un < 0) {
          const nx = -dx / g, nz = -dz / g;
          const w = smooth((h - y) / (0.3 * h + 1)); // full below the roof, fading to nothing at its height
          const ut = ux * -nz + uz * nx;
          const s = Math.abs(ut) > 0.15 ? Math.sign(ut) : side;
          const along = ut * s + -un * 0.9; // sliding speed along the wall, in the turning direction
          out.vx = ux * (1 - w) + w * (-nz * s * along);
          out.vz = uz * (1 - w) + w * (nx * s * along);
          out.vy = smooth(1 - (h - y) / (0.2 * h + 2)) * -un * 0.6; // near the roof height the wind climbs over
          out.k = 1 - 0.4 * w * -un; // it slows where it meets the face
        }
      }
      let sheltered = 0;
      for (const [d, weight] of WAKE) if (sharpAt(x - ux * d * wakeLength, z - uz * d * wakeLength) > y) sheltered += weight;
      out.k *= 1 - (1 - SLOWEST) * sheltered;
    },
    // Moves a point that has ended up inside a building back out of it (along the outward normal). Says whether it got out;
    // false means it is buried deep inside (e.g. it started there) and should start again.
    resolve(p) {
      for (let n = 0; n < 8 && sharpAt(p.x, p.z) > p.y; n++) {
        const dx = bilinear(gx, p.x, p.z), dz = bilinear(gz, p.x, p.z), g = Math.hypot(dx, dz);
        if (g < 1e-4) break;
        p.x -= (dx / g) * c;
        p.z -= (dz / g) * c;
      }
      return sharpAt(p.x, p.z) <= p.y;
    },
  };
}
