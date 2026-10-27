// Reads the placed mass for the erosion: where it stands. The mass's own geometry does not shape the erosion.
// A grid of cells (aligned to the world axes, covering the mass's extent) holds a height map of the mass, found by
// casting rays straight down. That tells the erosion whether a figure is touching the mass, and clips the carved
// surfaces to it.
import * as THREE from "three";

const MAX_CELLS = 40; // per axis, keeps the height map to a few thousand rays
const DEFAULT_SUB = 2; // height samples per cell, per axis
const MIN_CELL = 2.5; // metres

// info: getMassInfo() from mass/model3dm.js. Returns null if the mass has no mesh geometry.
// `maxCells`, `minCell` and `sub` override the resolution above (the wind erosion scans finer).
export function scanMass(info, { maxCells = MAX_CELLS, minCell = MIN_CELL, sub: SUB = DEFAULT_SUB } = {}) {
  const root = info.object;
  root.updateMatrixWorld(true);
  const meshes = [];
  root.traverse((o) => o.isMesh && o.geometry?.attributes.position && meshes.push(o));

  const v = new THREE.Vector3();
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const mesh of meshes) {
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
    }
  }
  if (!meshes.length || !isFinite(minX)) return null;

  const Lu = Math.max(maxX - minX, 1), Lv = Math.max(maxZ - minZ, 1);
  const cell = Math.max(minCell, Math.max(Lu, Lv) / maxCells);
  const nU = Math.max(1, Math.round(Lu / cell)), nV = Math.max(1, Math.round(Lv / cell));
  const cu = Lu / nU, cv = Lv / nV;
  // Lattice coordinates (u, v) are metres east and south of the mass's north-west corner: x = minX + u, z = minZ + v.
  const toUV = (x, z) => [x - minX, z - minZ];
  const toXZ = (u, w) => [u + minX, w + minZ];

  // Top height of the mass at SUB × SUB samples per cell.
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

  return { nU, nV, cu, cv, u0: minX, v0: minZ, inv: [1, 0, 0, 1], toUV, toXZ, hf, hw, hh, sub: SUB };
}
