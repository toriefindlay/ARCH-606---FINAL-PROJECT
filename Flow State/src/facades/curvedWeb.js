// MODEL (facades): the organic web on rounded massings. No scene code.
//
// On flat walls the web is laid out wall by wall (panels.js). A rounded form has no walls, and webs laid out from several
// directions do not meet where those join. So here there is one web in space: cells round points scattered through the
// whole volume, and the ribs are where the massings' own surface crosses between two cells. It runs on unbroken over every
// curve and from one blob to the next, lies flush on the surface, and frames each tunnel's opening with a round rib.
import { outward } from "../core/solid.js";
import { hash } from "./noise.js";

const FLUSH = 0.1, BEDDED = 0.03; // m: as on flat walls (panels.js)
const CLEAR = 0.15; // m: kept between the web and a tunnel
const MIN_FLAT = 0.3; // the least that a border between two cells is taken to cross the surface at (see rib)

const smooth01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function web3(size) {
  const cell = 3.7 * size, seeds = new Map();
  const seed = (i, j, k) => {
    const key = `${i},${j},${k}`;
    let p = seeds.get(key);
    if (!p) seeds.set(key, (p = [(i + 0.15 + 0.7 * hash(i + 17.3 * k, j)) * cell, (j + 0.15 + 0.7 * hash(j + 5.1 * i, k)) * cell, (k + 0.15 + 0.7 * hash(k + 11.7 * j, i)) * cell]));
    return p;
  };
  // below zero inside a rib: how far (x, y, z), on a surface facing (nx, ny, nz), is from the border between two cells,
  // measured along the surface, less the rib's half width
  return (x, y, z, nx, ny, nz) => {
    // (a slow warp bends the borders into curves)
    const wx = x + size * 0.8 * Math.sin(y / (2.6 * size) + z / (3.4 * size));
    const wy = y + size * 0.7 * Math.sin(z / (2.9 * size) + x / (3.8 * size));
    const wz = z + size * 0.8 * Math.sin(x / (2.7 * size) + y / (3.2 * size));
    const ci = Math.floor(wx / cell), cj = Math.floor(wy / cell), ck = Math.floor(wz / cell);
    let first = Infinity, second = Infinity, a = null, b = null;
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        for (let k = ck - 1; k <= ck + 1; k++) {
          const p = seed(i, j, k), d = (wx - p[0]) ** 2 + (wy - p[1]) ** 2 + (wz - p[2]) ** 2;
          if (d < first) { second = first; b = a; first = d; a = p; } else if (d < second) { second = d; b = p; }
        }
      }
    }
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], apart = Math.hypot(dx, dy, dz) || 1;
    const away = (second - first) / (2 * apart); // from the flat border between the two cells
    // where that border lies nearly along the surface, a rib measured straight to it would spread into a broad patch
    const along = (dx * nx + dy * ny + dz * nz) / apart, crossing = Math.max(MIN_FLAT, Math.sqrt(Math.max(0, 1 - along * along)));
    const half = size * (0.26 + 0.16 * (0.5 + 0.5 * Math.sin(0.19 * (x + z) + 0.27 * y)));
    return away / crossing - half;
  };
}

// How far (x, y, z) is from the nearest tunnel's surface (negative inside it), as far as `reach` away.
function tunnelDistance(edges) {
  return (x, y, z, reach) => {
    let best = reach;
    for (const e of edges) {
      const r = e.r + best;
      if (Math.min(e.a.x, e.b.x) - r > x || Math.max(e.a.x, e.b.x) + r < x || Math.min(e.a.z, e.b.z) - r > z || Math.max(e.a.z, e.b.z) + r < z || Math.min(e.a.y, e.b.y) - r > y || Math.max(e.a.y, e.b.y) + r < y) continue;
      const sx = e.b.x - e.a.x, sy = e.b.y - e.a.y, sz = e.b.z - e.a.z, u = smooth01(((x - e.a.x) * sx + (y - e.a.y) * sy + (z - e.a.z) * sz) / (sx * sx + sy * sy + sz * sz || 1));
      const d = Math.hypot(x - e.a.x - sx * u, y - e.a.y - sy * u, z - e.a.z - sz * u) - e.r;
      if (d < best) best = d;
    }
    return best;
  };
}

const SRGB = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255].map((v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });

// Adds the web to `out` (createMeshData). `meshes` and `solid`: see core/solid.js. `edges`: the tunnels' tubes, or [].
export function curvedWeb(out, meshes, solid, edges, size) {
  const rib = web3(size), tunnel = tunnelDistance(edges);
  const white = SRGB(0xeceae6), side = SRGB(0xc9c6c0);
  const step = Math.min(0.42, Math.max(0.24, 0.3 * size));
  for (const tris of meshes) {
    // every triangle's way out, and at every corner the average of those round it (so the web bends smoothly)
    const faces = [], corners = new Map();
    const keyOf = (t, v) => `${Math.round(tris[t + v] * 500)},${Math.round(tris[t + v + 1] * 500)},${Math.round(tris[t + v + 2] * 500)}`;
    for (let t = 0; t + 8 < tris.length; t += 9) {
      const ux = tris[t + 3] - tris[t], uy = tris[t + 4] - tris[t + 1], uz = tris[t + 5] - tris[t + 2];
      const vx = tris[t + 6] - tris[t], vy = tris[t + 7] - tris[t + 1], vz = tris[t + 8] - tris[t + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const area = Math.hypot(nx, ny, nz);
      if (area < 1e-9) continue;
      nx /= area; ny /= area; nz /= area;
      const mx = (tris[t] + tris[t + 3] + tris[t + 6]) / 3, my = (tris[t + 1] + tris[t + 4] + tris[t + 7]) / 3, mz = (tris[t + 2] + tris[t + 5] + tris[t + 8]) / 3;
      let way = outward(solid, mx, my, mz, nx, ny, nz);
      // a large triangle may be buried only in part: it is kept if any corner of it shows (its pieces are tried one by one)
      let part = false;
      if (!way) {
        for (const v of [0, 3, 6]) {
          way = way || outward(solid, mx + (tris[t + v] - mx) * 0.85, my + (tris[t + v + 1] - my) * 0.85, mz + (tris[t + v + 2] - mz) * 0.85, nx, ny, nz);
        }
        part = true;
      }
      if (!way) continue;
      nx *= way; ny *= way; nz *= way;
      if (ny < -0.95 && my < 0.1) continue; // (the underside, on the ground)
      faces.push({ t, n: [nx, ny, nz], part });
      for (const v of [0, 3, 6]) {
        const k = keyOf(t, v);
        let list = corners.get(k);
        if (!list) corners.set(k, (list = []));
        list.push([nx * area, ny * area, nz * area]);
      }
    }
    const cornerNormal = (t, v, n) => { // the average round a corner of the faces that turn less than 50 degrees from this one
      let x = 0, y = 0, z = 0;
      for (const q of corners.get(keyOf(t, v))) {
        if ((q[0] * n[0] + q[1] * n[1] + q[2] * n[2]) > 0.64 * Math.hypot(...q)) { x += q[0]; y += q[1]; z += q[2]; }
      }
      const length = Math.hypot(x, y, z) || 1;
      return [x / length, y / length, z / length];
    };
    for (const { t, n, part } of faces) {
      const P = [0, 3, 6].map((v) => [tris[t + v], tris[t + v + 1], tris[t + v + 2]]);
      const N = [0, 3, 6].map((v) => cornerNormal(t, v, n));
      const longest = Math.max(...[0, 1, 2].map((k) => Math.hypot(P[k][0] - P[(k + 1) % 3][0], P[k][1] - P[(k + 1) % 3][1], P[k][2] - P[(k + 1) % 3][2])));
      const count = Math.max(1, Math.ceil(longest / step));
      const made = new Map();
      const sample = (i, j) => {
        const key = i * 4096 + j;
        let s = made.get(key);
        if (s) return s;
        const v = i / count, w = j / count, u = 1 - v - w;
        const p = [0, 1, 2].map((c) => u * P[0][c] + v * P[1][c] + w * P[2][c]);
        const m = [0, 1, 2].map((c) => u * N[0][c] + v * N[1][c] + w * N[2][c]);
        const length = Math.hypot(...m) || 1;
        for (let c = 0; c < 3; c++) m[c] /= length;
        let g = rib(p[0], p[1], p[2], m[0], m[1], m[2]);
        if (edges.length) {
          const d = tunnel(p[0], p[1], p[2], 1.5);
          g = Math.max(Math.min(g, d - CLEAR - 0.5 * size), CLEAR - d); // (a round rib frames the opening, and none crosses it)
        }
        g = Math.max(g, 0.04 - p[1]); // (and none below the ground)
        made.set(key, (s = { p, n: m, g }));
        return s;
      };
      const piece = (a, b, c) => {
        if (a.g >= 0 && b.g >= 0 && c.g >= 0) return;
        if (part) {
          const x = (a.p[0] + b.p[0] + c.p[0]) / 3, y = (a.p[1] + b.p[1] + c.p[1]) / 3, z = (a.p[2] + b.p[2] + c.p[2]) / 3;
          if (!outward(solid, x, y, z, ...n)) return;
        }
        const ring = [a, b, c], inside = [];
        for (let k = 0; k < 3; k++) {
          const p = ring[k], q = ring[(k + 1) % 3];
          if (p.g < 0) inside.push(p);
          if (p.g < 0 !== q.g < 0) {
            const s = p.g / (p.g - q.g), mix = (x, y) => x.map((value, c2) => value + (y[c2] - value) * s);
            inside.push({ p: mix(p.p, q.p), n: mix(p.n, q.n), cut: true, leaving: p.g < 0 });
          }
        }
        const lift = (q, d) => [q.p[0] + q.n[0] * d, Math.max(0.02, q.p[1] + q.n[1] * d), q.p[2] + q.n[2] * d];
        const tops = inside.map((q) => lift(q, FLUSH));
        for (let k = 1; k + 1 < tops.length; k++) out.tri(tops[0], tops[k], tops[k + 1], white);
        for (let k = 0; k < inside.length; k++) { // the rib's side, along its outline
          const next = (k + 1) % inside.length;
          if (inside[k].cut && inside[next].cut && inside[k].leaving) out.quad(tops[k], tops[next], lift(inside[next], -BEDDED), lift(inside[k], -BEDDED), side);
        }
      };
      for (let i = 0; i < count; i++) {
        for (let j = 0; j + i < count; j++) {
          piece(sample(i, j), sample(i + 1, j), sample(i, j + 1));
          if (i + j + 1 < count) piece(sample(i + 1, j), sample(i + 1, j + 1), sample(i, j + 1));
        }
      }
    }
  }
}
