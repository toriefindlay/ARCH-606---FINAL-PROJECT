// Reads the geometric language of the placed mass, so carved spaces can echo it at a smaller scale.
// Everything the carving does comes from what is measured here:
//   axes       the two dominant wall directions. Usually a right angle; a skewed massing (say 60°) gives a skewed lattice
//   block      the typical horizontal edge length along each axis, so cells keep the mass's proportions (long stays long)
//   walls      positions of its wall lines; the cell count is chosen so cell boundaries land on them as closely as possible
//   storey     the step between its tier heights, so tunnel ceilings step in the same increments
//   profile    "stepped" if the mass has several tiers, "prismatic" if it is one block, "round" if it is organic
// It also samples the mass's top height on the lattice, which says where there is mass to carve.
import * as THREE from "three";

const DEG = Math.PI / 180;
// Height-map samples are one ray each, so the sample count (cells × samples per cell) is kept to under ~10 000 rays.
// Organic masses use coarse cells with 2 × 2 samples each; orthogonal and skewed masses use fine cells with one sample.
const WINDOW = 6; // degrees either side of a direction that still count as that direction
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const median = (list) => Float64Array.from(list).sort()[list.length >> 1];
const apart180 = (a, b) => { const d = Math.abs(a - b) % 180; return Math.min(d, 180 - d); }; // angle between two directions

// Number of cells along one axis (from `lo`, `length` long) whose boundaries best fall on `lines` [{at, w}].
function fitCells(lo, length, target, lines, maxCells) {
  const n0 = clamp(Math.round(length / target), 1, maxCells);
  if (!lines.length) return n0;
  const total = lines.reduce((sum, l) => sum + l.w, 0);
  let best = n0, bestCost = Infinity;
  for (let n = Math.max(1, Math.floor(n0 * 0.6)); n <= Math.min(maxCells, Math.ceil(n0 * 1.6)); n++) {
    const cell = length / n;
    let miss = 0;
    for (const l of lines) {
      const f = (((l.at - lo) / cell) % 1 + 1) % 1;
      miss += l.w * Math.min(f, 1 - f) * cell;
    }
    const cost = miss / total + 0.25 * target * Math.abs(Math.log(n / n0)); // fit well, but stay near the target size
    if (cost < bestCost) { bestCost = cost; best = n; }
  }
  return best;
}

// Wall lines from a list of [position, area]: positions pooled in 0.25 m bins, strongest few kept.
function wallLines(samples, totalArea) {
  const bins = new Map();
  for (const [at, w] of samples) {
    const key = Math.round(at * 4);
    bins.set(key, (bins.get(key) ?? 0) + w);
  }
  return [...bins].map(([key, w]) => ({ at: key / 4, w })).filter((l) => l.w >= totalArea * 0.01).sort((a, b) => b.w - a.w).slice(0, 40);
}

// info: getMassInfo() from mass/model3dm.js. Returns null if the mass has no mesh geometry.
export function scanMass(info) {
  const root = info.object;
  root.updateMatrixWorld(true);
  const meshes = [];
  root.traverse((o) => o.isMesh && o.geometry?.attributes.position && meshes.push(o));

  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  const hist = new Float64Array(180); // wall area by direction, in 1° bins
  const walls = []; // [x, z, direction, area] of every wall triangle
  let wallArea = 0, surfaceArea = 0, slantedArea = 0; // slanted = neither vertical nor flat: curved or pitched surface
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
      surfaceArea += area2 / 2;
      if (Math.abs(n.y) > 0.05 && Math.abs(n.y) < 0.95) slantedArea += area2 / 2;
      if (Math.abs(n.y) < 0.35) {
        // A wall: its direction is perpendicular to its normal.
        const angle = ((((Math.atan2(n.z, n.x) / DEG) + 90) % 180) + 180) % 180;
        hist[Math.floor(angle) % 180] += area2 / 2;
        wallArea += area2 / 2;
        walls.push([(A.x + B.x + C.x) / 3, (A.z + B.z + C.z) / 3, angle, area2 / 2]);
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

  // Dominant wall directions. Window sums of the histogram find the strongest direction, then the strongest one
  // clearly apart from it. A right-angled pair means an orthogonal massing; another angle means a skewed one;
  // if the two together hold too little of the wall area, the form is organic.
  const win = (a) => {
    let sum = 0;
    for (let d = -WINDOW; d <= WINDOW; d++) sum += hist[(((Math.round(a) + d) % 180) + 180) % 180];
    return sum;
  };
  let p1 = 0, w1 = -1, p2 = 0, w2 = -1;
  for (let a = 0; a < 180; a++) { const w = win(a); if (w > w1) { w1 = w; p1 = a; } }
  for (let a = 0; a < 180; a++) { if (apart180(a, p1) < 20) continue; const w = win(a); if (w > w2) { w2 = w; p2 = a; } }
  const total = Math.max(wallArea, 1e-9);
  const orthoShare = wallArea > 1e-6 ? (w1 + win(p1 + 90)) / total : 0.5;
  const skewShare = wallArea > 1e-6 ? (w1 + w2) / total : 0;
  const axis1 = p1 + 0.5;
  let axis2 = axis1 + 90, organic = false, skewed = false;
  if (wallArea > 1e-6 && orthoShare < 0.55) {
    if (skewShare >= 0.55 && Math.abs(apart180(p1, p2) - 90) > 8) { axis2 = p2 + 0.5; skewed = true; }
    else organic = true;
  }
  // Mostly curved or sloping surface (domes, blobs) is organic whatever the wall directions say.
  if (surfaceArea > 0 && slantedArea / surfaceArea >= 0.5) { organic = true; skewed = false; axis2 = axis1 + 90; }
  const orthogonality = Math.max(orthoShare, skewed ? skewShare : 0);
  const SUB = organic ? 2 : 1; // height samples per cell, per axis
  const MAX_CELLS = organic ? 40 : 96; // per axis

  // Lattice: cells span axis1 (u) and axis2 (v). (u, v) are distances along those axes from the lattice origin.
  const phi = (((axis2 - axis1) % 180) + 180) % 180;
  const c1 = Math.cos(axis1 * DEG), s1 = Math.sin(axis1 * DEG);
  const c2 = Math.cos((axis1 + phi) * DEG), s2 = Math.sin((axis1 + phi) * DEG);
  const det = c1 * s2 - s1 * c2;
  const inv = [s2 / det, -c2 / det, -s1 / det, c1 / det]; // (x, z) -> (u, v):  u = inv0·x + inv1·z,  v = inv2·x + inv3·z

  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (let i = 0; i < xz.length; i += 2) {
    const u = inv[0] * xz[i] + inv[1] * xz[i + 1], v = inv[2] * xz[i] + inv[3] * xz[i + 1];
    umin = Math.min(umin, u); umax = Math.max(umax, u); vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
  }
  const Lu = Math.max(umax - umin, 1), Lv = Math.max(vmax - vmin, 1);
  const toUV = (x, z) => [inv[0] * x + inv[1] * z - umin, inv[2] * x + inv[3] * z - vmin];
  const toXZ = (u, v) => [(u + umin) * c1 + (v + vmin) * c2, (u + umin) * s1 + (v + vmin) * s2];

  // Block size along each axis, from edges that run along it. Organic masses use one size for both.
  const along = (axis) => edgeLengths.filter((_, i) => organic || apart180(edgeAngles[i], axis) <= WINDOW);
  const blockU = clamp(median(along(axis1).concat([Lu / 4])), 6, 60);
  const blockV = clamp(median(along(axis1 + phi).concat([Lv / 4])), 6, 60);
  // Organic masses use cells only to read the mass and keep a lattice; the carving itself is round hollows.
  // Otherwise a cell is the width of one thin passage, an eighth of the block size along each axis.
  const fine = Math.max(2.5, Math.max(Lu, Lv) / MAX_CELLS);
  const [targetU, targetV] = organic ? [fine, fine] : [clamp(blockU / 8, 1.2, 2.2), clamp(blockV / 8, 1.2, 2.2)];

  // Wall lines: walls running along axis1 sit at fixed v, walls along axis2 at fixed u. Cells snap to them.
  const linesU = [], linesV = [];
  if (!organic) {
    for (const [x, z, direction, area] of walls) {
      const [u, v] = [inv[0] * x + inv[1] * z, inv[2] * x + inv[3] * z];
      if (apart180(direction, axis1) <= WINDOW) linesV.push([v, area]);
      else if (apart180(direction, axis1 + phi) <= WINDOW) linesU.push([u, area]);
    }
  }
  const nU = fitCells(umin, Lu, targetU, wallLines(linesU, wallArea), MAX_CELLS);
  const nV = fitCells(vmin, Lv, targetV, wallLines(linesV, wallArea), MAX_CELLS);
  const cu = Lu / nU, cv = Lv / nV; // cells span the mass's own extent, so edge cells meet its outer walls

  // Top height of the mass at SUB × SUB samples per cell, by casting rays straight down.
  const hw = nU * SUB, hh = nV * SUB, hf = new Float32Array(hw * hh);
  const ray = new THREE.Raycaster();
  ray.ray.direction.set(0, -1, 0);
  ray.near = 0;
  ray.far = 1e5;
  const startY = info.bounds.max.y + 10;
  for (let j = 0; j < hh; j++) {
    for (let i = 0; i < hw; i++) {
      const [x, z] = toXZ(((i + 0.5) * cu) / SUB, ((j + 0.5) * cv) / SUB);
      ray.ray.origin.set(x, startY, z);
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

  // Organic: how big are its lobes? Count the high points of the height map; the footprint split between
  // them gives a lobe radius, and tunnels are a fraction of that, so a lumpy mass gets small hollows.
  let lobeRadius = 0, tunnelRadius = 0;
  if (organic) {
    let covered = 0, lobes = 0;
    const reach = 4; // samples
    for (let j = 0; j < hh; j++) {
      for (let i = 0; i < hw; i++) {
        const t = hf[j * hw + i];
        if (t <= 0.5) continue;
        covered++;
        let high = true;
        for (let dj = -reach; dj <= reach && high; dj++) {
          for (let di = -reach; di <= reach; di++) {
            const ni = i + di, nj = j + dj;
            if (ni >= 0 && nj >= 0 && ni < hw && nj < hh && hf[nj * hw + ni] > t) { high = false; break; }
          }
        }
        if (high) lobes++;
      }
    }
    lobeRadius = Math.sqrt((covered * (cu / SUB) * (cv / SUB)) / (Math.PI * Math.max(1, lobes)));
    tunnelRadius = clamp(lobeRadius * 0.06, 1, 1.8); // thin: a person-wide passage, scaled a little with the lobes
  }

  // Storey: the usual step between the mass's tier heights. Several tiers make the carving stepped too.
  const tiers = [...new Set(Array.from(hf, (t) => (t > 0.5 ? Math.round(t * 4) / 4 : -1)).filter((t) => t > 0))].sort((a, b) => a - b);
  const steps = tiers.slice(1).map((t, i) => t - tiers[i]).filter((d) => d > 1.2);
  const storey = steps.length ? clamp(median(steps), 2.7, 4.5) : 3.2;
  const profile = organic ? "round" : steps.length ? "stepped" : "prismatic";

  return {
    axis1, axis2: axis1 + phi, skewed, organic, orthogonality, profile,
    blockU, blockV, storey, lobeRadius, tunnelRadius, sinPhi: Math.sin(phi * DEG), sub: SUB,
    nU, nV, cu, cv, u0: umin, v0: vmin, inv, toUV, toXZ, hf, hw, hh, ok, topMin, tiers,
  };
}
