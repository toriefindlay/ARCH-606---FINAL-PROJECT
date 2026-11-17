// VIEW (exterior erosion): the wind tunnels as they have been worn into the stone (tunnels.js). No solver code.
//
// The tubes of the vein network (tunnels.js) are drawn into a smooth field on a fine grid (a 3D map, 1 inside a tunnel, falling to 0 over a few
// decimetres), and the tunnels' walls are the level ISO of that field, built with marching cubes and shaded smoothly: tubes of any radius, joined
// where they meet, come out as smooth, rounded passages. The same field goes to the shader (see view.js), which discards the mass's own surface
// where the field is above ISO, so that where a tunnel reaches a wall it leaves a smooth opening. The walls are drawn as the tunnels grow.
//
// THE SKIN: once the tunnels are finished (and `skin.amount` is above 0) the outside of the mass is drawn as one smooth softened surface instead (see
// skinShell.js), which replaces the mass's own surface and takes the tunnels as part of itself. Nothing here changes the tunnels or the cooling.
//
// The work of a redraw is a generator that gives the page back every few milliseconds (see marching.js), one slice a frame, so that no frame is held up by
// it: a redraw takes a few frames, and the network it draws is a copy taken when it began.
import * as THREE from "three";
import { createSkinShell } from "./skinShell.js";
import { march, fresh, due } from "./marching.js";

const ISO = 0.5; // the level of the field the surface lies on (the same as uTunnelIso in view.js)
const MIN_INTERVAL = 150; // ms between one redraw and the start of the next while the tunnels grow

export function createMeshView(uniforms, empty) {
  let group = null, mesh = null, texture = null;
  let skinMesh = null; // the softened outside of the mass (see skinShell.js), while it is shown: it replaces the mass's own surface
  let wall = null, skinMaterial = null, matched = false, lastKey = "", lastTime = 0;
  let job = null; // the redraw in progress: { key, parent, gen }
  const shell = createSkinShell();

  const dropSkin = () => {
    if (skinMesh) { skinMesh.parent?.remove(skinMesh); skinMesh.geometry.dispose(); skinMesh = null; }
    uniforms.uHideMass.value = 0;
  };
  const clear = () => {
    job = null;
    uniforms.uTunnelTex.value = empty;
    dropSkin();
    shell.clear();
    mesh?.geometry.dispose();
    group?.parent?.remove(group);
    texture?.dispose();
    group = mesh = texture = null;
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

  // What a redraw makes, a slice at a time: { kind: "skin", built } for the softened skin (amount above 0), or { kind: "tunnels", ... } for the tunnels alone.
  function* compute(tunnels, skin) {
    fresh();
    const amount = skin?.amount ?? 0;
    if (amount > 0) {
      const built = yield* shell.build(tunnels, amount);
      if (built) return { kind: "skin", built };
    }
    const { massBox } = tunnels, { edges } = tunnels.network();
    const segs = edges.map((e) => [e.a.x, e.a.y, e.a.z, e.b.x, e.b.y, e.b.z, e.r]); // (a copy: the network goes on changing while this is drawn)
    // the finer grid: one cell of fc metres every way, over the mass and a little beyond (a coarser one while the tunnels grow, so that a redraw is quick)
    const ox = massBox.x0 - 3, oz = massBox.z0 - 3, W = massBox.x1 - massBox.x0 + 6, D = massBox.z1 - massBox.z0 + 6, H = massBox.top + 1;
    const fc = Math.max(0.35, Math.min(1.2, Math.cbrt((W * D * H) / (tunnels.done ? 4e6 : 1.2e6))));
    const fnx = Math.ceil(W / fc), fnz = Math.ceil(D / fc), fny = Math.ceil(H / fc);
    // The field: every tube is a smooth step from 1 inside it to 0 outside, over MARGIN either side of its surface (0.5 on the surface), and the
    // tubes are joined like probabilities (1 - the product of what is left), so that where tubes meet they blend into one another.
    const field = new Float32Array(fnx * fnz * fny), MARGIN = 0.3;
    for (const [ax, ay, az, bx, by, bz, r] of segs) {
      const reach = r + MARGIN;
      const a0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - ox) / fc)), a1 = Math.min(fnx - 1, Math.floor((Math.max(ax, bx) + reach - ox) / fc));
      const b0 = Math.max(0, Math.floor((Math.min(az, bz) - reach - oz) / fc)), b1 = Math.min(fnz - 1, Math.floor((Math.max(az, bz) + reach - oz) / fc));
      const m0 = Math.max(0, Math.floor((Math.min(ay, by) - reach) / fc)), m1 = Math.min(fny - 1, Math.floor((Math.max(ay, by) + reach) / fc));
      const sx = bx - ax, sy = by - ay, sz = bz - az, len2 = sx * sx + sy * sy + sz * sz || 1;
      for (let m = m0; m <= m1; m++) {
        const y = (m + 0.5) * fc;
        for (let b = b0; b <= b1; b++) {
          const z = oz + (b + 0.5) * fc;
          for (let a = a0; a <= a1; a++) {
            const x = ox + (a + 0.5) * fc;
            const u = Math.max(0, Math.min(1, ((x - ax) * sx + (y - ay) * sy + (z - az) * sz) / len2));
            const d = Math.hypot(x - (ax + sx * u), y - (ay + sy * u), z - (az + sz * u));
            if (d >= reach) continue;
            const t = Math.min(1, (reach - d) / (2 * MARGIN)), f = t * t * (3 - 2 * t), k = (m * fnz + b) * fnx + a;
            field[k] = 1 - (1 - field[k]) * (1 - f);
          }
        }
      }
      if (due()) { yield; fresh(); }
    }
    const bytes = new Uint8Array(field.length); // the map for the shader
    for (let k = 0; k < field.length; k++) bytes[k] = Math.min(255, Math.round(field[k] * 255));
    if (due()) { yield; fresh(); }
    // the walls: marching cubes on the finer field, only what lies inside the mass (the ends of the tunnels that reach out of a wall are left open)
    const g = { nx: fnx, nz: fnz, ny: fny, ox, oy: 0, oz, fc }, geo = { position: [], normal: [] };
    yield* march(field, g, ISO, 0, (ca, cm, cb) => {
      const cx = ox + (ca + 0.5) * fc, cy = (cm + 0.5) * fc, cz = oz + (cb + 0.5) * fc;
      return tunnels.heightAt(cx, cz) < cy - 0.1 || cy < 0.2 ? null : geo; // (and nothing below the ground)
    });
    return { kind: "tunnels", g, bytes, geo };
  }

  // Shows what a redraw made.
  const apply = (parent, r) => {
    dropSkin();
    texture?.dispose();
    texture = null;
    place(parent);
    if (r.kind === "skin") { // its surface, with the tunnels in it, replaces the mass's own; the tunnels' map is not needed
      uniforms.uTunnelTex.value = empty;
      if (r.built.wall.position.length) { mesh = new THREE.Mesh(geometryOf(r.built.wall), wall); group.add(mesh); }
      if (r.built.skin.position.length) { skinMesh = new THREE.Mesh(geometryOf(r.built.skin), skinMaterial); parent.add(skinMesh); } // (faint in x-ray, like the mass)
      uniforms.uHideMass.value = 1;
      return;
    }
    const { g, bytes, geo } = r;
    texture = new THREE.Data3DTexture(bytes, g.nx, g.nz, g.ny);
    texture.format = THREE.RedFormat;
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    uniforms.uTunnelTex.value = texture;
    uniforms.uTunnelOrigin.value.set(g.ox, 0, g.oz);
    uniforms.uTunnelSize.value.set(g.nx * g.fc, g.ny * g.fc, g.nz * g.fc);
    if (geo.position.length) { mesh = new THREE.Mesh(geometryOf(geo), wall); group.add(mesh); }
  };

  return {
    clear,
    // Shows the tunnels of `tunnels` (tunnels.js) under `parent`. Cheap to call every frame: a redraw is started when they have changed (not sooner than
    // MIN_INTERVAL after the last), and one slice of it is done at every call.
    // `skin` ({ amount: 0 to 1 }, optional) softens the outside of the mass once the tunnels are done (see skinShell.js).
    update(parent, tunnels, skin = null) {
      if (!parent || !tunnels || !tunnels.carved) return clear();
      if (job && job.parent !== parent) job = null;
      if (!job) {
        const key = `${tunnels.id}|${parent.id}|${tunnels.version}|${tunnels.done ? skin?.amount ?? 0 : 0}`;
        if (key === lastKey && group?.parent === parent) return;
        if (group?.parent === parent && performance.now() - lastTime < MIN_INTERVAL) return;
        job = { key, parent, gen: compute(tunnels, tunnels.done ? skin : null) };
      }
      fresh();
      try {
        const r = job.gen.next();
        if (r.done) {
          apply(job.parent, r.value);
          lastKey = job.key;
          lastTime = performance.now();
          job = null;
        }
      } catch (e) {
        console.error("Drawing the tunnels failed:", e);
        lastKey = job.key; // (not tried again until something changes)
        job = null;
      }
    },
  };
}
