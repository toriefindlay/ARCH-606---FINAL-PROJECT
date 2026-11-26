// VIEW (exterior erosion): the wind tunnels as they have been worn into the stone (tunnels.js). No solver code.
//
// The tubes of the vein network (tunnels.js) are drawn into a smooth field on a fine grid (a 3D map, 1 inside a tunnel, falling to 0 over a few
// decimetres), and the tunnels' walls are the level ISO of that field, built with marching cubes and shaded smoothly: tubes of any radius, joined
// where they meet, come out as smooth, rounded passages. The same field goes to the shader (see view.js), which discards the mass's own surface
// where the field is above ISO, so that where a tunnel reaches a wall it leaves a smooth opening. The walls are drawn as the tunnels grow.
//
// THE SKIN: once the tunnels are finished the outside of the mass is drawn as one surface instead (see
// skinShell.js), which replaces the mass's own surface and takes the tunnels as part of itself. Nothing here changes the tunnels or the cooling.
//
// The work of a redraw is a generator that gives the page back every few milliseconds (see marching.js), one slice a frame, so that no frame is held up by
// it: a redraw takes a few frames, and the network it draws is a copy taken when it began.
import * as THREE from "three";
import { createSkinShell } from "./skinShell.js";
import { march, fresh, due } from "./marching.js";

const ISO = 0.5; // the level of the field the surface lies on (the same as uTunnelIso in view.js)
const MIN_INTERVAL = 150; // ms between one redraw and the start of the next while the tunnels grow

export function createMeshView(uniforms, empty, dressSkin = () => {}) { // dressSkin: gives the skin's material the facade (view.js)
  let group = null, mesh = null, texture = null;
  let skinMesh = null; // the outside of the mass (see skinShell.js), while it is shown: it replaces the mass's own surface
  let wall = null, skinMaterial = null, matched = false, lastKey = "", lastTime = 0;
  let plain = null; // the tunnels' own colour, kept while they are lined for a facade
  let job = null; // the redraw in progress: { key, parent, gen }
  let visible = true; // are the tunnels' walls shown? (the mass's own surface and the skin are not affected)
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
    if (!skinMaterial) { skinMaterial = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }); dressSkin(skinMaterial); }
    if (!matched) parent.traverse((o) => { if (!matched && o.isMesh && o.material?.color && o !== mesh && o !== skinMesh) { wall.color.copy(o.material.color); skinMaterial.color.copy(o.material.color); matched = true; } });
    if (!group || group.parent !== parent) {
      group?.parent?.remove(group);
      group = new THREE.Group();
      group.userData.solid = true; // the x-ray mode (view.js) leaves the tunnels as they are
      group.visible = visible;
      parent.add(group);
    }
    if (mesh) { group.remove(mesh); mesh.geometry.dispose(); mesh = null; }
  };

  // What a redraw makes, a slice at a time: { kind: "skin", built } for the skin, or { kind: "tunnels", ... } for the tunnels alone.
  // `within` (optional): { solid() } for rounded massings, whose tunnel walls are trimmed to what is really inside them: under a
  // curved-in side the height map takes the air for stone, and the tunnels would stand out there as stubs.
  function* compute(tunnels, skin, within = null) {
    fresh();
    if (skin) { // (once the tunnels are done)
      const built = yield* shell.build(tunnels, skin.cuts ?? null, skin.shapes?.shape ?? null, !!skin.shapes, skin.surface ?? null);
      if (built) return { kind: "skin", built, shapes: skin.shapes ?? null };
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
    const solid = within?.solid() ?? null, columns = new Map();
    const crossings = (x, z) => {
      const key = `${Math.round(x * 20)},${Math.round(z * 20)}`;
      let found = columns.get(key);
      if (!found) columns.set(key, (found = solid.crossings(x, z)));
      return found;
    };
    const trim = 0.3 * fc; // (the walls stop just short of the surface, so that no ragged end shows beyond it)
    yield* march(field, g, ISO, 0, (ca, cm, cb) => {
      const cx = ox + (ca + 0.5) * fc, cy = (cm + 0.5) * fc, cz = oz + (cb + 0.5) * fc;
      if (cy < 0.2) return null; // (nothing below the ground)
      if (!solid) return tunnels.heightAt(cx, cz) < cy - 0.1 ? null : geo;
      for (const [u, v] of [[0, 0], [trim, 0], [-trim, 0], [0, trim], [0, -trim]]) if (!solid.insideAt(crossings(cx + u, cz + v), cy)) return null;
      return solid.insideAt(crossings(cx, cz), cy + trim) && solid.insideAt(crossings(cx, cz), Math.max(0.05, cy - trim)) ? geo : null;
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
      // (openings shaped for a facade are lined in a colour that goes with it; otherwise the tunnels are the mass's own colour)
      plain ??= wall.color.clone();
      if (r.shapes) wall.color.set(r.shapes.lining);
      else wall.color.copy(plain);
      if (r.built.wall.position.length) { mesh = new THREE.Mesh(geometryOf(r.built.wall), wall); group.add(mesh); }
      if (r.built.skin.position.length) { skinMesh = new THREE.Mesh(geometryOf(r.built.skin), skinMaterial); skinMesh.userData.skin = true; skinMesh.userData.shapesKey = r.shapes?.key ?? ""; parent.add(skinMesh); } // (faint in x-ray, like the mass)
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
    // What is drawn now, for exporting: the skin (or null), the tunnels' walls (or null), and whether a redraw is under way.
    meshes: () => ({ skin: skinMesh, walls: mesh, busy: !!job }),
    // Shows or hides the tunnels' walls (cheap to call every frame). Hidden, they are still worked out, so showing them again is instant.
    setVisible(on) {
      visible = !!on;
      if (group) group.visible = visible;
    },
    // Shows the tunnels of `tunnels` (tunnels.js) under `parent`. Cheap to call every frame: a redraw is started when they have changed (not sooner than
    // MIN_INTERVAL after the last), and one slice of it is done at every call.
    // (skin.shapes, optional: { key (says when they have changed), lining (a colour for the openings), shape (see skinShell.js) })
    // `skin` ({ cuts: the circulation's hallways as boxes, cutsKey: says when they have changed }, optional) gives the outside of the mass its skin once the
    // tunnels are done (see skinShell.js): a flat facade with crisp openings and angled reveals. Without it the mass's own surface is kept, with the raw openings.
    // `lining` (a colour, or null) is for the openings and tunnels where there is no skin to carry it.
    update(parent, tunnels, skin = null, lining = null, within = null) {
      if (!parent || !tunnels || !tunnels.carved) return clear();
      if (job && job.parent !== parent) job = null;
      if (!skin && wall) { // (without a skin the tunnels' walls take their colour at once: it needs no redraw)
        plain ??= wall.color.clone();
        if (lining !== null) wall.color.set(lining);
        else wall.color.copy(plain);
      }
      if (!job) {
        const key = `${tunnels.id}|${parent.id}|${tunnels.version}|${tunnels.done && skin ? `skin|${skin.cutsKey ?? ""}|${skin.shapes?.key ?? ""}` : `raw|${within ? "trimmed" : ""}`}`;
        if (key === lastKey && group?.parent === parent) return;
        if (group?.parent === parent && performance.now() - lastTime < MIN_INTERVAL) return;
        job = { key, parent, gen: compute(tunnels, tunnels.done ? skin : null, within) };
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
