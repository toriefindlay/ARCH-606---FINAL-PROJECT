// MODEL (exterior erosion): the skin's picture of the mass as placed, taken from the massings' own triangles, so that the
// skin's walls and roofs lie exactly on theirs. No scene or DOM code.
//
// The tunnels are worked out on a coarse height map of the mass (form.js). A surface made from that can stand half a metre
// or more in or out from the real faces, so the walls seem to sink back as soon as the skin replaces them. The skin uses
// these two instead.
import { fresh, due } from "./marching.js";

// How high the massings are over the middle of every column of a grid ({ ox, oz, fc, nx, nz }): Float32Array, 0 where
// there are none. `tris` is a flat array of world positions, 9 numbers a triangle.
export function* exactHeights(tris, { ox, oz, fc, nx, nz }) {
  const heights = new Float32Array(nx * nz);
  for (let t = 0; t + 8 < tris.length; t += 9) {
    const ax = (tris[t] - ox) / fc - 0.5, az = (tris[t + 2] - oz) / fc - 0.5;
    const bx = (tris[t + 3] - ox) / fc - 0.5, bz = (tris[t + 5] - oz) / fc - 0.5;
    const cx = (tris[t + 6] - ox) / fc - 0.5, cz = (tris[t + 8] - oz) / fc - 0.5;
    const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
    if (Math.abs(det) < 1e-9) continue; // (upright: it has no area seen from above)
    const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx))), i1 = Math.min(nx - 1, Math.floor(Math.max(ax, bx, cx)));
    const j0 = Math.max(0, Math.ceil(Math.min(az, bz, cz))), j1 = Math.min(nz - 1, Math.floor(Math.max(az, bz, cz)));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const q = ((i - ax) * (cz - az) - (cx - ax) * (j - az)) / det, r = ((bx - ax) * (j - az) - (i - ax) * (bz - az)) / det;
        if (q < -1e-6 || r < -1e-6 || q + r > 1 + 1e-6) continue;
        const y = tris[t + 1] + q * (tris[t + 4] - tris[t + 1]) + r * (tris[t + 7] - tris[t + 1]);
        if (y > heights[j * nx + i]) heights[j * nx + i] = y;
      }
    }
    if (due()) { yield; fresh(); }
  }
  return heights;
}

// The squared distance from (px, py, pz) to the triangle at tris[t] (Ericson's closest point).
function distance2(tris, t, px, py, pz) {
  const ax = tris[t], ay = tris[t + 1], az = tris[t + 2];
  const abx = tris[t + 3] - ax, aby = tris[t + 4] - ay, abz = tris[t + 5] - az, acx = tris[t + 6] - ax, acy = tris[t + 7] - ay, acz = tris[t + 8] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let v = 0, w = 0;
  if (d1 > 0 || d2 > 0) {
    const bpx = apx - abx, bpy = apy - aby, bpz = apz - abz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = apx - acx, cpy = apy - acy, cpz = apz - acz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) v = 1;
    else if (d6 >= 0 && d5 <= d6) w = 1;
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) v = d1 / (d1 - d3);
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) w = d2 / (d2 - d6);
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { w = (d4 - d3) / (d4 - d3 + (d5 - d6)); v = 1 - w; }
    else { const sum = va + vb + vc; v = vb / sum; w = vc / sum; }
  }
  const dx = apx - abx * v - acx * w, dy = apy - aby * v - acy * w, dz = apz - abz * v - acz * w;
  return dx * dx + dy * dy + dz * dz;
}

const NEAR = 2.2; // cells: how near the surface the exact distance is worked out
const AGREE = 1.5; // cells: how far it may differ from the grid's own estimate

// Puts the exact distance to the massings' faces into `phi` (a signed distance on the grid g, cells at (a, m, b) stored at
// (m * nz + b) * nx + a, negative inside) wherever it is near the surface; the signs stay as they are. A face is only
// believed where it agrees roughly with the grid's estimate: that leaves out faces buried inside the mass, where blocks
// stand on or against one another. Below ground the walls are carried straight on down.
export function* exactDistance(tris, phi, g) {
  const { ox, oy, oz, fc, nx, nz, ny } = g;
  const reach = NEAR * fc, exact = new Float32Array(phi.length).fill(Infinity);
  for (let t = 0; t + 8 < tris.length; t += 9) {
    const x0 = Math.min(tris[t], tris[t + 3], tris[t + 6]), x1 = Math.max(tris[t], tris[t + 3], tris[t + 6]);
    const y0 = Math.min(tris[t + 1], tris[t + 4], tris[t + 7]), y1 = Math.max(tris[t + 1], tris[t + 4], tris[t + 7]);
    const z0 = Math.min(tris[t + 2], tris[t + 5], tris[t + 8]), z1 = Math.max(tris[t + 2], tris[t + 5], tris[t + 8]);
    if (y1 < 0.05) continue; // (the underside, on the ground)
    const ux = tris[t + 3] - tris[t], uy = tris[t + 4] - tris[t + 1], uz = tris[t + 5] - tris[t + 2];
    const vx = tris[t + 6] - tris[t], vy = tris[t + 7] - tris[t + 1], vz = tris[t + 8] - tris[t + 2];
    let px = uy * vz - uz * vy, py = uz * vx - ux * vz, pz = ux * vy - uy * vx;
    const length = Math.hypot(px, py, pz);
    if (length < 1e-9) continue;
    px /= length; py /= length; pz /= length;
    const a0 = Math.max(0, Math.floor((x0 - reach - ox) / fc)), a1 = Math.min(nx - 1, Math.floor((x1 + reach - ox) / fc));
    const b0 = Math.max(0, Math.floor((z0 - reach - oz) / fc)), b1 = Math.min(nz - 1, Math.floor((z1 + reach - oz) / fc));
    // (a face that comes down to the ground serves every layer below it too)
    const m0 = y0 < 0.05 ? 0 : Math.max(0, Math.floor((y0 - reach - oy) / fc)), m1 = Math.min(ny - 1, Math.floor((y1 + reach - oy) / fc));
    for (let m = m0; m <= m1; m++) {
      const y = Math.max(0.01, oy + (m + 0.5) * fc);
      for (let b = b0; b <= b1; b++) {
        const z = oz + (b + 0.5) * fc;
        for (let a = a0; a <= a1; a++) {
          const k = (m * nz + b) * nx + a, estimate = Math.abs(phi[k]);
          if (estimate > reach) continue;
          const x = ox + (a + 0.5) * fc;
          if (Math.abs((x - tris[t]) * px + (y - tris[t + 1]) * py + (z - tris[t + 2]) * pz) > reach) continue; // (far from its plane)
          const d = Math.sqrt(distance2(tris, t, x, y, z));
          if (d < exact[k] && Math.abs(d - estimate) <= AGREE * fc) exact[k] = d;
        }
      }
    }
    if (due()) { yield; fresh(); }
  }
  for (let k = 0; k < phi.length; k++) if (exact[k] !== Infinity) phi[k] = phi[k] < 0 ? -Math.max(1e-4, exact[k]) : Math.max(1e-4, exact[k]);
}
