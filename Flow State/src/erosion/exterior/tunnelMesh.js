// VIEW (exterior erosion): the wind tunnels as they have been worn into the stone (tunnels.js). No solver code.
//
// The tubes of the vein network (tunnels.js) are drawn into a smooth field on a fine grid (a 3D map, 1 inside a tunnel, falling to 0 over a few
// decimetres), and the tunnels' walls are the level ISO of that field, built with marching cubes and shaded smoothly: tubes of any radius, joined
// where they meet, come out as smooth, rounded passages. The same field goes to the shader (see view.js), which discards the mass's own surface
// where the field is above ISO, so that where a tunnel reaches a wall it leaves a smooth opening. The walls are drawn as the tunnels grow.
import * as THREE from "three";
import { edgeTable, triTable } from "three/addons/objects/MarchingCubes.js";
import { createSkinShell } from "./skinShell.js";

// THE SKIN: once the tunnels are finished (and `skin.amount` is above 0) the outside of the mass is drawn as one smooth softened surface instead (see
// skinShell.js), which replaces the mass's own surface and takes the tunnels as part of itself. Nothing here changes the tunnels or the cooling.
const ISO = 0.5; // the level of the field the surface lies on (the same as uTunnelIso in view.js)
const MIN_INTERVAL = 300; // ms between rebuilds while the tunnels grow
const MC_CORNERS = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const MC_EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

export function createMeshView(uniforms, empty) {
  let group = null, mesh = null, texture = null, data = null, dims = "";
  let skinMesh = null; // the softened outside of the mass (see skinShell.js), while it is shown: it replaces the mass's own surface
  let wall = null, skinMaterial = null, matched = false, lastKey = "", lastTime = 0;
  const shell = createSkinShell();

  const dropSkin = () => {
    if (skinMesh) { skinMesh.parent?.remove(skinMesh); skinMesh.geometry.dispose(); skinMesh = null; }
    uniforms.uHideMass.value = 0;
  };
  const clear = () => {
    uniforms.uTunnelTex.value = empty;
    dropSkin();
    shell.clear();
    mesh?.geometry.dispose();
    group?.parent?.remove(group);
    texture?.dispose();
    group = mesh = texture = data = null;
    dims = "";
    lastKey = "";
  };
  const geometryOf = (g) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(g.position, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(g.normal, 3));
    return geo;
  };
  // The materials (the colour of the mass's own), and the group the tunnels' walls go in (which the x-ray mode leaves solid).
  const place = (parent) => {
    if (!wall) wall = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
    if (!skinMaterial) skinMaterial = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
    if (!matched) parent.traverse((o) => { if (!matched && o.isMesh && o.material?.color && o !== mesh && o !== skinMesh) { wall.color.copy(o.material.color); skinMaterial.color.copy(o.material.color); matched = true; } });
    if (!group || group.parent !== parent) {
      group?.parent?.remove(group);
      group = new THREE.Group();
      group.userData.solid = true; // the x-ray mode (view.js) leaves the tunnels as they are
      parent.add(group);
    }
    if (mesh) { group.remove(mesh); mesh.geometry.dispose(); mesh = null; }
  };

  // The softened skin (amount above 0): its surface, with the tunnels in it, replaces the mass's own; the tunnels' map is not needed.
  const rebuildSkin = (parent, built) => {
    dropSkin();
    place(parent);
    uniforms.uTunnelTex.value = empty;
    if (built.wall.position.length) { mesh = new THREE.Mesh(geometryOf(built.wall), wall); group.add(mesh); }
    if (built.skin.position.length) { skinMesh = new THREE.Mesh(geometryOf(built.skin), skinMaterial); parent.add(skinMesh); } // (faint in x-ray, like the mass)
    uniforms.uHideMass.value = 1;
  };

  const rebuild = (parent, tunnels, skin) => {
    const amount = skin?.amount ?? 0;
    const built = amount > 0 ? shell.build(tunnels, amount) : null;
    if (built) return rebuildSkin(parent, built);
    dropSkin();
    const { massBox } = tunnels, { nodes, edges } = tunnels.network();
    // the finer grid: one cell of fc metres every way, over the mass and a little beyond
    const ox = massBox.x0 - 3, oz = massBox.z0 - 3, W = massBox.x1 - massBox.x0 + 6, D = massBox.z1 - massBox.z0 + 6, H = massBox.top + 1;
    const fc = Math.max(0.35, Math.min(1, Math.cbrt((W * D * H) / 4e6)));
    const fnx = Math.ceil(W / fc), fnz = Math.ceil(D / fc), fny = Math.ceil(H / fc);
    // The field: every tube is a smooth step from 1 inside it to 0 outside, over MARGIN either side of its surface (0.5 on the surface), and the
    // tubes are joined like probabilities (1 - the product of what is left), so that where tubes meet they blend into one another.
    const field = new Float32Array(fnx * fnz * fny), MARGIN = 0.3;
    for (const e of edges) {
      const a = e.a, b = e.b, reach = e.r + MARGIN;
      const a0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - ox) / fc)), a1 = Math.min(fnx - 1, Math.floor((Math.max(a.x, b.x) + reach - ox) / fc));
      const b0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach - oz) / fc)), b1 = Math.min(fnz - 1, Math.floor((Math.max(a.z, b.z) + reach - oz) / fc));
      const m0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - reach) / fc)), m1 = Math.min(fny - 1, Math.floor((Math.max(a.y, b.y) + reach) / fc));
      const sx = b.x - a.x, sy = b.y - a.y, sz = b.z - a.z, len2 = sx * sx + sy * sy + sz * sz || 1;
      for (let m = m0; m <= m1; m++) {
        const y = (m + 0.5) * fc;
        for (let bz = b0; bz <= b1; bz++) {
          const z = oz + (bz + 0.5) * fc;
          for (let ax = a0; ax <= a1; ax++) {
            const x = ox + (ax + 0.5) * fc;
            const u = Math.max(0, Math.min(1, ((x - a.x) * sx + (y - a.y) * sy + (z - a.z) * sz) / len2));
            const d = Math.hypot(x - (a.x + sx * u), y - (a.y + sy * u), z - (a.z + sz * u));
            if (d >= reach) continue;
            const t = Math.min(1, (reach - d) / (2 * MARGIN)), f = t * t * (3 - 2 * t), k = (m * fnz + bz) * fnx + ax;
            field[k] = 1 - (1 - field[k]) * (1 - f);
          }
        }
      }
    }
    // the map for the shader
    const size = `${fnx}x${fnz}x${fny}`;
    if (size !== dims) {
      texture?.dispose();
      data = new Uint8Array(field.length);
      texture = new THREE.Data3DTexture(data, fnx, fnz, fny);
      texture.format = THREE.RedFormat;
      texture.type = THREE.UnsignedByteType;
      texture.minFilter = texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.unpackAlignment = 1;
      dims = size;
    }
    for (let k = 0; k < field.length; k++) data[k] = Math.min(255, Math.round(field[k] * 255));
    texture.needsUpdate = true;
    uniforms.uTunnelTex.value = texture;
    uniforms.uTunnelOrigin.value.set(ox, 0, oz);
    uniforms.uTunnelSize.value.set(fnx * fc, fny * fc, fnz * fc);
    // the walls: marching cubes on the finer field
    const f = (a, m, b) => (a < 0 || b < 0 || m < 0 || a >= fnx || b >= fnz || m >= fny ? 0 : field[(m * fnz + b) * fnx + a]);
    const gradient = (a, m, b) => [f(a + 1, m, b) - f(a - 1, m, b), f(a, m + 1, b) - f(a, m - 1, b), f(a, m, b + 1) - f(a, m, b - 1)];
    const position = [], normal = [];
    const corner = new Array(8), pt = new Array(12), nrm = new Array(12);
    for (let m = 0; m < fny - 1; m++) {
      for (let b = 0; b < fnz - 1; b++) {
        for (let a = 0; a < fnx - 1; a++) {
          let index = 0;
          for (let q = 0; q < 8; q++) {
            const [da, dm, db] = MC_CORNERS[q];
            corner[q] = f(a + da, m + dm, b + db);
            if (corner[q] < ISO) index |= 1 << q;
          }
          const bits = edgeTable[index];
          if (!bits) continue;
          for (let e = 0; e < 12; e++) {
            if (!(bits & (1 << e))) continue;
            const [p0, p1] = MC_EDGES[e], v0 = corner[p0], v1 = corner[p1], t = v1 === v0 ? 0.5 : (ISO - v0) / (v1 - v0);
            const A = MC_CORNERS[p0], B = MC_CORNERS[p1];
            pt[e] = [a + A[0] + t * (B[0] - A[0]), m + A[1] + t * (B[1] - A[1]), b + A[2] + t * (B[2] - A[2])];
            const ga = gradient(a + A[0], m + A[1], b + A[2]), gb = gradient(a + B[0], m + B[1], b + B[2]);
            nrm[e] = [ga[0] + t * (gb[0] - ga[0]), ga[1] + t * (gb[1] - ga[1]), ga[2] + t * (gb[2] - ga[2])];
          }
          for (let t = index << 4; triTable[t] !== -1; t += 3) {
            const tri = [triTable[t], triTable[t + 1], triTable[t + 2]];
            // only what lies inside the mass: the ends of the tunnels that reach out of a wall are left open
            const cx = ox + ((pt[tri[0]][0] + pt[tri[1]][0] + pt[tri[2]][0]) / 3 + 0.5) * fc, cy = ((pt[tri[0]][1] + pt[tri[1]][1] + pt[tri[2]][1]) / 3 + 0.5) * fc, cz = oz + ((pt[tri[0]][2] + pt[tri[1]][2] + pt[tri[2]][2]) / 3 + 0.5) * fc;
            if (tunnels.heightAt(cx, cz) < cy - 0.1 || cy < 0.2) continue; // (and nothing below the ground)
            for (const e of tri) {
              position.push(ox + (pt[e][0] + 0.5) * fc, (pt[e][1] + 0.5) * fc, oz + (pt[e][2] + 0.5) * fc);
              const len = Math.hypot(nrm[e][0], nrm[e][1], nrm[e][2]) || 1;
              normal.push(nrm[e][0] / len, nrm[e][1] / len, nrm[e][2] / len);
            }
          }
        }
      }
    }
    place(parent);
    if (position.length) {
      mesh = new THREE.Mesh(geometryOf({ position, normal }), wall);
      group.add(mesh);
    }
  };

  return {
    clear,
    // Shows the tunnels of `tunnels` (tunnels.js) under `parent`. Cheap to call every frame: it only rebuilds when they have changed, and at most
    // every MIN_INTERVAL ms.
    // `skin` ({ amount: 0 to 1 }, optional) softens the outside of the mass once the tunnels are done (see skinShell.js).
    update(parent, tunnels, skin = null) {
      if (!parent || !tunnels || !tunnels.carved) return clear();
      const key = `${tunnels.id}|${parent.id}|${tunnels.version}|${tunnels.done ? skin?.amount ?? 0 : 0}`;
      if (key === lastKey && group?.parent === parent) return;
      const now = performance.now();
      if (group?.parent === parent && now - lastTime < MIN_INTERVAL) return;
      lastKey = key;
      lastTime = now;
      rebuild(parent, tunnels, tunnels.done ? skin : null);
    },
  };
}
