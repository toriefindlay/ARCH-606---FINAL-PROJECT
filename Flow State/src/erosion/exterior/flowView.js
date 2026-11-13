// VIEW (exterior erosion): a horizontal slice through the airflow around the mass, for checking the solver (voxelFlow.js).
// Colour is the air speed relative to the wind far away: blue slower, grey the same, red faster (2x or more). Solid voxels
// and air the wind cannot reach are left clear so the mass shows through.
import * as THREE from "three";

const SLOW = new THREE.Color(0x2a5cc0), SAME = new THREE.Color(0xe6e6e6), FAST = new THREE.Color(0xd9331f);
const RANGE = 2; // the speed ratio at which the ramp ends
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function createFlowView() {
  let mesh = null, texture = null, data = null, shown = null, layer = -1;
  const colour = new THREE.Color();

  const clear = () => {
    mesh?.parent?.remove(mesh);
    mesh?.geometry.dispose();
    mesh?.material.dispose();
    texture?.dispose();
    mesh = texture = data = shown = null;
    layer = -1;
  };

  const ramp = (ratio) => {
    const t = clamp(ratio / RANGE, 0, 1);
    return t < 0.5 ? colour.copy(SLOW).lerp(SAME, t * 2) : colour.copy(SAME).lerp(FAST, (t - 0.5) * 2);
  };

  return {
    clear,
    // Shows the slice of `flow` (a solveFlow() result for `vox`) at `height` metres above the ground, under `parent`.
    update(parent, vox, flow, height) {
      if (!parent) return clear();
      const { nx, nz, ny, c, x0, z0 } = vox;
      if (shown !== flow || mesh.parent !== parent) {
        clear();
        data = new Uint8Array(nx * nz * 4);
        texture = new THREE.DataTexture(data, nx, nz, THREE.RGBAFormat, THREE.UnsignedByteType);
        texture.minFilter = texture.magFilter = THREE.NearestFilter;
        const geo = new THREE.PlaneGeometry(nx * c, nz * c).rotateX(-Math.PI / 2);
        mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
        mesh.position.set(x0 + (nx * c) / 2, 0, z0 + (nz * c) / 2);
        mesh.renderOrder = 5;
        parent.add(mesh);
        shown = flow;
        layer = -1;
      }
      const l = clamp(vox.layerAt(height), 0, ny - 1);
      if (l === layer) return;
      layer = l;
      mesh.position.y = vox.yc[l];
      for (let j = 0; j < nz; j++) {
        const row = nz - 1 - j; // the plane's top edge is north (-z), and a texture's first row is its bottom edge
        for (let i = 0; i < nx; i++) {
          const k = (l * nz + j) * nx + i, o = (row * nx + i) * 4;
          if (!flow.open[k]) { data[o + 3] = 0; continue; }
          const rgb = ramp(flow.speed[k]);
          data[o] = Math.round(rgb.r * 255);
          data[o + 1] = Math.round(rgb.g * 255);
          data[o + 2] = Math.round(rgb.b * 255);
          data[o + 3] = 200;
        }
      }
      texture.needsUpdate = true;
    },
  };
}
