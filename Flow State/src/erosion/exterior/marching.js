// MODEL/VIEW helper (exterior erosion): marching cubes that can be done a little at a time. No scene or DOM code.
//
// The heavy work of drawing the tunnels and the skin (stamping a field, blurring it, meshing it) is written as generators that give the page back every
// few milliseconds, so that a redraw never freezes a frame: the caller advances one generator once a frame (see tunnelMesh.js). `fresh()` marks the start of a
// slice (the caller does it before each step), and `due()` says whether the slice has used up its time; a long loop does
//   if (due()) { yield; fresh(); }
// every so often.
import { edgeTable, triTable } from "three/addons/objects/MarchingCubes.js";

const BUDGET = 8; // ms of work in a slice
let sliceStart = 0;
export const fresh = () => { sliceStart = performance.now(); };
export const due = () => performance.now() - sliceStart > BUDGET;

// the corners of a cell as (a, m, b) steps (a: x, m: height, b: z), and the corners at the ends of its 12 edges
const CORNER = new Int8Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
const EDGE = new Int8Array([0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7]);

// The surface of the field `f` (index (m * nz + b) * nx + a) at the level `iso`, where a corner counts as inside when its value is below it; beyond the
// grid the value is `outside`. g = { nx, nz, ny, ox, oy, oz, fc }: the grid's size, the world position of its corner, and the size of a cell (a cell's centre is
// its index plus a half). For every triangle `pick(a, m, b)` (its centre, in cells) says where it goes: an object { position: [], normal: [] } the triangle
// is added to (normals from the gradient of the field, pointing to higher values), or null to leave it out.
export function* march(f, g, iso, outside, pick) {
  const { nx, nz, ny, ox, oy, oz, fc } = g, nxz = nx * nz;
  const val = (a, m, b) => (a < 0 || b < 0 || m < 0 || a >= nx || b >= nz || m >= ny ? outside : f[(m * nz + b) * nx + a]);
  const v8 = new Float32Array(8), pt = new Float32Array(36), nr = new Float32Array(36);
  const emit = (out, e) => {
    out.position.push(ox + (pt[3 * e] + 0.5) * fc, oy + (pt[3 * e + 1] + 0.5) * fc, oz + (pt[3 * e + 2] + 0.5) * fc);
    const x = nr[3 * e], y = nr[3 * e + 1], z = nr[3 * e + 2], len = Math.hypot(x, y, z) || 1;
    out.normal.push(x / len, y / len, z / len);
  };
  for (let m = 0; m < ny - 1; m++) {
    for (let b = 0; b < nz - 1; b++) {
      const row = (m * nz + b) * nx;
      for (let a = 0; a < nx - 1; a++) {
        const k = row + a;
        v8[0] = f[k]; v8[1] = f[k + 1]; v8[2] = f[k + 1 + nxz]; v8[3] = f[k + nxz];
        v8[4] = f[k + nx]; v8[5] = f[k + 1 + nx]; v8[6] = f[k + 1 + nxz + nx]; v8[7] = f[k + nxz + nx];
        let index = 0;
        for (let q = 0; q < 8; q++) if (v8[q] < iso) index |= 1 << q;
        if (index === 0 || index === 255) continue;
        const bits = edgeTable[index];
        for (let e = 0; e < 12; e++) {
          if (!(bits & (1 << e))) continue;
          const p0 = EDGE[2 * e], p1 = EDGE[2 * e + 1], v0 = v8[p0], v1 = v8[p1], t = v1 === v0 ? 0.5 : (iso - v0) / (v1 - v0);
          const a0 = a + CORNER[3 * p0], m0 = m + CORNER[3 * p0 + 1], b0 = b + CORNER[3 * p0 + 2];
          const a1 = a + CORNER[3 * p1], m1 = m + CORNER[3 * p1 + 1], b1 = b + CORNER[3 * p1 + 2];
          pt[3 * e] = a0 + t * (a1 - a0); pt[3 * e + 1] = m0 + t * (m1 - m0); pt[3 * e + 2] = b0 + t * (b1 - b0);
          const gx0 = val(a0 + 1, m0, b0) - val(a0 - 1, m0, b0), gy0 = val(a0, m0 + 1, b0) - val(a0, m0 - 1, b0), gz0 = val(a0, m0, b0 + 1) - val(a0, m0, b0 - 1);
          const gx1 = val(a1 + 1, m1, b1) - val(a1 - 1, m1, b1), gy1 = val(a1, m1 + 1, b1) - val(a1, m1 - 1, b1), gz1 = val(a1, m1, b1 + 1) - val(a1, m1, b1 - 1);
          nr[3 * e] = gx0 + t * (gx1 - gx0); nr[3 * e + 1] = gy0 + t * (gy1 - gy0); nr[3 * e + 2] = gz0 + t * (gz1 - gz0);
        }
        for (let t = index << 4; triTable[t] !== -1; t += 3) {
          const e0 = triTable[t], e1 = triTable[t + 1], e2 = triTable[t + 2];
          const out = pick(
            (pt[3 * e0] + pt[3 * e1] + pt[3 * e2]) / 3,
            (pt[3 * e0 + 1] + pt[3 * e1 + 1] + pt[3 * e2 + 1]) / 3,
            (pt[3 * e0 + 2] + pt[3 * e1 + 2] + pt[3 * e2 + 2]) / 3
          );
          if (!out) continue;
          emit(out, e0); emit(out, e1); emit(out, e2);
        }
      }
      if (due()) { yield; fresh(); }
    }
  }
}
