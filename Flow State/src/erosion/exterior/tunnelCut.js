// The wind tunnels as a cut for the shared erosion pipeline (see erosion/contract.js): the volume of the tunnels, as a signed
// distance (negative inside). Like windErode.js's cut, handed to rules.js. No scene or DOM code beyond the Box3.
import * as THREE from "three";
import { createCut } from "../contract.js";
import { distance3d } from "./windErode.js";

const INF = 1e20;

let active = null; // the tunnels (tunnels.js) in use, or null
let cached = { tunnels: null, version: -1, cuts: [] };

export function setActiveTunnels(tunnels) {
  active = tunnels;
  cached = { tunnels: null, version: -1, cuts: [] };
}

// The distance from the centre of every voxel to the surface of the tunnels: negative inside them, and the surface lies half a
// voxel from the centres next to it. Two distance transforms (to the nearest tunnel voxel from outside, to the nearest voxel that
// is not a tunnel from inside). The distances count voxels as c across every way, which is not true up and down (the layers are
// thinner there), so the value is only right in its sign and roughly right sideways.
function distanceField(tunnels) {
  const { vox } = tunnels;
  const { nx, nz, ny, c, cells } = vox;
  const toTunnel = new Float32Array(cells.length), toSolid = new Float32Array(cells.length);
  for (let k = 0; k < cells.length; k++) {
    const tunnel = tunnels.carvedAt(k);
    toTunnel[k] = tunnel ? 0 : INF;
    toSolid[k] = tunnel ? INF : 0;
  }
  distance3d(toTunnel, nx, nz, ny);
  distance3d(toSolid, nx, nz, ny);
  const field = new Float32Array(cells.length);
  for (let k = 0; k < cells.length; k++) {
    field[k] = tunnels.carvedAt(k) ? -(Math.sqrt(toSolid[k]) - 0.5) * c : (Math.sqrt(toTunnel[k]) - 0.5) * c;
  }
  return field;
}

// The cut for the tunnels as they are now ([] if there is no tunnel). The distance field is only worked out when the cut's sdf is
// first asked for, and once per change.
export function activeTunnelCuts() {
  if (!active || !active.carved) return [];
  if (cached.tunnels === active && cached.version === active.vox.version) return cached.cuts;
  const { vox } = active;
  const tunnels = active;
  const bounds = new THREE.Box3();
  for (let l = 0; l < vox.ny; l++) {
    for (let j = 0; j < vox.nz; j++) {
      for (let i = 0; i < vox.nx; i++) {
        if (!tunnels.carvedAt(vox.index(i, j, l))) continue;
        bounds.expandByPoint(new THREE.Vector3(vox.x0 + i * vox.c, vox.ye[l], vox.z0 + j * vox.c));
        bounds.expandByPoint(new THREE.Vector3(vox.x0 + (i + 1) * vox.c, vox.ye[l + 1], vox.z0 + (j + 1) * vox.c));
      }
    }
  }
  let field = null;
  const sdf = (x, y, z) => {
    const k = vox.at(x, y, z);
    if (k < 0) return vox.c;
    field ??= distanceField(tunnels);
    return field[k];
  };
  const cut = createCut({ id: "ext-wind-tunnels", source: "exterior", label: "Wind tunnels", bounds, sdf });
  cached = { tunnels: active, version: vox.version, cuts: [cut] };
  return cached.cuts;
}
