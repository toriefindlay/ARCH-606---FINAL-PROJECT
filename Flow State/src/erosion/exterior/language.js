// Reads the geometric language of the placed mass, so carved spaces can echo it at a smaller scale:
//   axis       the dominant direction of its walls (a lattice is laid along it)
//   module     the typical length of its horizontal edges (a block's width), so cells are a fraction of it
//   storey     the step between its tier heights, so tunnel ceilings step in the same increments
//   organic    true when few walls follow one axis pair; the carving then uses finer, rounder cells
// It also samples the mass's top height on a grid in that lattice, which says where there is mass to carve.
import * as THREE from "three";

const DEG = Math.PI / 180;
const MAX_CELLS = 40; // per axis, keeps the height sampling to a few thousand rays
const SUB = 2; // height samples per cell, per axis
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const median = (list) => Float64Array.from(list).sort()[list.length >> 1];
const dist90 = (a, b) => { const d = Math.abs(a - b) % 90; return Math.min(d, 90 - d); }; // angle apart, with 0° = 90°

// info: getMassInfo() from mass/model3dm.js. Returns null if the mass has no mesh geometry.
export function scanMass(info) {
  const root = info.object;
  root.updateMatrixWorld(true);
  const meshes = [];
  root.traverse((o) => o.isMesh && o.geometry?.attributes.position && meshes.push(o));

  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  const wallAngles = new Float64Array(180); // wall area by direction, in 1° bins
  let wallArea = 0;
  const edgeLengths = [], edgeAngles = [];
  const xz = [];

  for (const mesh of meshes) {
    const pos = mesh.geometry.attributes.position, index = mesh.geometry.index, m = mesh.matrixWorld;
    const at = (k, out) => out.fromBufferAttribute(pos, index ? index.getX(k) : k).applyMatrix4(m);
    const count = index ? index.count : pos.count;
    for (let k = 0; k + 2 < count; k += 3) {
      at(k, A); at(k + 1, B); at(k + 2, C);
      n.crossVectors(e1.subVectors(B, A), e2.subVectors(C, A));
      const area2 = n.length();
      if (area2 < 1e-9) continue;
      n.divideScalar(area2);
      if (Math.abs(n.y) < 0.35) {
        // A wall: its direction is perpendicular to its normal.
        const angle = ((((Math.atan2(n.z, n.x) / DEG) + 90) % 180) + 180) % 180;
        wallAngles[Math.floor(angle) % 180] += area2 / 2;
        wallArea += area2 / 2;
      }
      for (const [P, Q] of [[A, B], [B, C], [C, A]]) {
        const dx = Q.x - P.x, dz = Q.z - P.z, horizontal = Math.hypot(dx, dz);
        if (horizontal > 2 && Math.abs(Q.y - P.y) < 0.02 * horizontal) {
          edgeLengths.push(horizontal);
          edgeAngles.push((((Math.atan2(dz, dx) / DEG) % 180) + 180) % 180);
        }
      }
    }
    for (let i = 0; i < pos.count; i++) {
      A.fromBufferAttribute(pos, i).applyMatrix4(m);
      xz.push(A.x, A.z);
    }
  }
  if (!xz.length) return null;

  // Dominant axis: peak of the wall-direction histogram folded to 90° (so a rectangular plan has one peak).
  let theta = 0, orthogonality = 0.5;
  if (wallArea > 1e-6) {
    const fold = new Float64Array(90);
    for (let a = 0; a < 180; a++) fold[a % 90] += wallAngles[a];
    let best = 0, bestSum = -1;
    for (let a = 0; a < 90; a++) {
      let sum = 0;
      for (let d = -3; d <= 3; d++) sum += fold[(a + d + 90) % 90];
      if (sum > bestSum) { bestSum = sum; best = a; }
    }
    theta = best + 0.5;
    let near = 0;
    for (let a = 0; a < 90; a++) if (dist90(a + 0.5, theta) <= 6) near += fold[a];
    orthogonality = near / wallArea;
  }
  const organic = orthogonality < 0.55;
  const cos = Math.cos(theta * DEG), sin = Math.sin(theta * DEG);

  // Extent of the mass in the lattice frame: u along the axis, v across it.
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (let i = 0; i < xz.length; i += 2) {
    const u = xz[i] * cos + xz[i + 1] * sin, v = -xz[i] * sin + xz[i + 1] * cos;
    umin = Math.min(umin, u); umax = Math.max(umax, u); vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
  }
  const Lu = Math.max(umax - umin, 1), Lv = Math.max(vmax - vmin, 1);

  const lengths = edgeLengths.filter((_, i) => organic || dist90(edgeAngles[i], theta) <= 6);
  const module = clamp(lengths.length ? median(lengths) : Math.max(Lu, Lv) / 4, 6, 60);
  const target = organic ? clamp(module / 8, 1.5, 4) : clamp(module / 4, 2.5, 8);
  const nU = clamp(Math.round(Lu / target), 1, MAX_CELLS), nV = clamp(Math.round(Lv / target), 1, MAX_CELLS);
  const cu = Lu / nU, cv = Lv / nV; // cells snap to the mass's own extent, so edge cells meet its outer walls

  // Top height of the mass at SUB × SUB samples per cell, by casting rays straight down.
  const hw = nU * SUB, hh = nV * SUB, hf = new Float32Array(hw * hh);
  const ray = new THREE.Raycaster();
  ray.ray.direction.set(0, -1, 0);
  ray.near = 0;
  ray.far = 1e5;
  const startY = info.bounds.max.y + 10;
  for (let j = 0; j < hh; j++) {
    for (let i = 0; i < hw; i++) {
      const u = umin + ((i + 0.5) * cu) / SUB, v = vmin + ((j + 0.5) * cv) / SUB;
      ray.ray.origin.set(u * cos - v * sin, startY, u * sin + v * cos);
      const hit = ray.intersectObjects(meshes, false)[0];
      hf[j * hw + i] = hit ? hit.point.y : 0;
    }
  }

  // A cell can be carved when at least half of it has mass; its roof limit is the lowest top over that mass.
  const ok = new Uint8Array(nU * nV), topMin = new Float32Array(nU * nV);
  for (let j = 0; j < nV; j++) {
    for (let i = 0; i < nU; i++) {
      let covered = 0, low = Infinity;
      for (let dj = 0; dj < SUB; dj++) {
        for (let di = 0; di < SUB; di++) {
          const t = hf[(j * SUB + dj) * hw + i * SUB + di];
          if (t > 0.5) { covered++; low = Math.min(low, t); }
        }
      }
      if (covered * 2 >= SUB * SUB) { ok[j * nU + i] = 1; topMin[j * nU + i] = low; }
    }
  }

  // Storey: the usual step between the mass's tier heights.
  const tiers = [...new Set(Array.from(hf, (t) => (t > 0.5 ? Math.round(t * 4) / 4 : -1)).filter((t) => t > 0))].sort((a, b) => a - b);
  const steps = tiers.slice(1).map((t, i) => t - tiers[i]).filter((d) => d > 1.2);
  const storey = steps.length ? clamp(median(steps), 2.7, 4.5) : 3.2;

  return { theta, cos, sin, orthogonality, organic, module, storey, nU, nV, cu, cv, u0: umin, v0: vmin, hf, hw, hh, ok, topMin, tiers };
}
