// VIEW (exterior erosion): the wind tunnels as the wind would wear them out of a block of stone. No solver code.
//
// Every tunnel is a tube with an elliptical cross-section along the wind, in the ceiling void at the top of a storey (tunnels.js
// `layout`). Its drawn shape is not voxels but the shape's own numbers, so it is smooth at any size. It is bored from the windward
// face: at the start it is a small round dimple in the wall, which deepens and widens as the bore goes in, with a rounded tip, and
// breaks out of the leeward face as a small hole that opens up. `prog` (0 to 1) says how far the erosion has got; the tunnels do not
// all start together (each has its own delay).
//
// Two things are made from the same numbers, so that they always agree: the walls of the tubes (a mesh, drawn inside the mass), and a
// map for the shader (see view.js) which discards the mass's own surface where a tube meets it, so that the opening is exactly the
// tube's cross-section. The mass's own surface is the original model; nothing about it changes.
import * as THREE from "three";
import { tunnelWidth, STOREY, ZONE } from "./tunnels.js";

const RING = 28; // points round a tube's cross-section
const STEP = 0.7; // metres between the stations of a tube (they bunch up at the two ends, see spread)
const LIP = 0.4; // metres: how much wider and deeper than the tube its opening in the wall is at the wall, rounded off into the tube
const LIP_LEN = 1; // metres: how far in from the wall the rounding goes
const NOSE = 4; // metres: how long the rounded tip of the bore is at most
const DELAY = 0.4; // the part of the erosion over which the tunnels start one after another
const SEGMENT = 6; // metres: a tube is drawn into the map in pieces this long
const MIN_INTERVAL = 90; // ms between rebuilds while the erosion goes on
const ease = (x) => x * x * (3 - 2 * x);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
// The stations of a tube are spread so that they are close together at the ends, where the surface curves.
const spread = (x) => x - (0.8 * Math.sin(2 * Math.PI * x)) / (2 * Math.PI);
// How much the opening is widened d metres in from the wall: a quarter circle, tangent to the wall at d = 0 and to the tube at LIP_LEN.
const lip = (d, size) => (d >= LIP_LEN ? 0 : size * (1 - Math.sqrt(1 - (1 - Math.max(0, d) / LIP_LEN) ** 2)));

// How far each tunnel has got, from the erosion's progress `prog` (0 to 1): its own delay, then an eased run.
const own = (prog, delay) => ease(clamp01((prog * (1 + DELAY) - delay) / 1));
const delayOf = (b, i) => { const x = Math.sin(i * 12.9898 + b * 78.233) * 43758.5453; return (x - Math.floor(x)) * DELAY; };

// The shape of one tunnel at progress f (0..1): { along(t) -> { w, h } } the half width and the fraction of the void's depth at t.
function bore(tube, shape, f) {
  const { ta, tb, half } = tube, L = tb - ta, nose = Math.min(NOSE, L / 2), bored = f * (L + nose);
  return (t) => {
    const r = bored - (t - ta); // how far behind the tip of the bore this point is (negative: not reached yet)
    if (r <= 0) return { w: 0, h: 0, s: 0 };
    const x = Math.min(1, r / nose), scale = Math.sqrt(x * (2 - x)); // a round tip
    const w = (tunnelWidth(shape, clamp01((t - ta) / L)) / 2) * scale;
    return { w, h: Math.min(1, w / half), s: scale }; // as deep as it is wide until it is as deep as the void
  };
}

export function createBoreView(uniforms, empty) {
  let group = null, mesh = null, texture = null, data = null, dims = "";
  let layouts = new Map(), layoutOwner = null, lastKey = "", lastTime = 0, wall = null, matched = false;

  const clear = () => {
    uniforms.uBoreTex.value = empty;
    mesh?.geometry.dispose();
    group?.parent?.remove(group);
    texture?.dispose();
    group = mesh = texture = data = null;
    dims = "";
    lastKey = "";
  };

  // The tubes of a band's shape: laid out once (it needs the form's height map: where the mass starts and ends) and kept.
  const layoutOf = (tunnels, b, dir, shape) => {
    if (layoutOwner !== tunnels) { layouts = new Map(); layoutOwner = tunnels; }
    const key = `${b}|${dir[0]},${dir[1]}|${JSON.stringify(shape)}`;
    let tubes = layouts.get(key);
    if (!tubes) {
      tubes = tunnels.layout(b, dir, shape).map((run, i) => {
        const wide = Math.max(shape.mouth, shape.exit, 1) * shape.throat / 2;
        const lines = Array.from({ length: RING }, (_, k) => { // where the mass starts and ends along each line of the tube's wall
          const cos = Math.cos((2 * Math.PI * k) / RING);
          const a = run.edges(cos * (tunnelWidth(shape, 0) / 2 + LIP)), z = run.edges(cos * (tunnelWidth(shape, 1) / 2 + LIP));
          return [a ? a[0] : run.ta, z ? z[1] : run.tb];
        });
        // A tube with a stretch of wall outside the mass (near a side or a corner of it) would jut out of it: it is left out.
        const L = run.tb - run.ta;
        const gap = lines.some(([a, z], k) => {
          const cos = Math.cos((2 * Math.PI * k) / RING);
          for (let t = a + 0.3; t < z - 0.3; t += 0.75) if (!run.inside(t, cos * (tunnelWidth(shape, clamp01((t - run.ta) / L)) / 2) * 1.02)) return true;
          return false;
        });
        return gap ? null : { ...run, lines, wide, delay: delayOf(b, i), shape };
      }).filter(Boolean);
      layouts.set(key, tubes);
    }
    return tubes;
  };

  // The tubes' walls.
  const buildMesh = (items) => {
    let stations = 0;
    for (const { tube } of items) stations += Math.ceil((tube.tb - tube.ta) / STEP) + 1;
    const position = new Float32Array(stations * RING * 3), shade = new Float32Array(stations * RING * 3), alive = new Uint8Array(stations * RING), index = [];
    let v = 0;
    for (const { tube, f } of items) {
      const { dir, o, y, half, lines, shape } = tube, [d0, d1] = dir, p0 = -d1, p1 = d0;
      const along = bore(tube, shape, f), N = Math.ceil((tube.tb - tube.ta) / STEP) + 1, base = v;
      for (let i = 0; i < N; i++) {
        for (let k = 0; k < RING; k++, v++) {
          const [t0, t1] = lines[k], t = t0 + (t1 - t0) * spread(i / (N - 1)), a = (2 * Math.PI * k) / RING;
          const { w, h, s } = along(t), depth = Math.min(t - t0, t1 - t), fl = lip(depth, LIP * s); // the opening is rounded off into the wall
          const q = o + (w + fl) * Math.cos(a);
          alive[v] = w > 0 ? 1 : 0;
          position[v * 3] = d0 * t + p0 * q;
          position[v * 3 + 1] = y + (h * half + fl) * Math.sin(a);
          position[v * 3 + 2] = d1 * t + p1 * q;
          const dark = 1 - 0.6 * ease(Math.min(1, depth / 3)); // the colour of the wall at the opening, darker the deeper in
          shade[v * 3] = shade[v * 3 + 1] = shade[v * 3 + 2] = dark;
        }
      }
      for (let i = 0; i < N - 1; i++) {
        for (let k = 0; k < RING; k++) {
          const a = base + i * RING + k, b = base + (i + 1) * RING + k, c = base + (i + 1) * RING + ((k + 1) % RING), d = base + i * RING + ((k + 1) % RING);
          if (!alive[a] && !alive[b] && !alive[c] && !alive[d]) continue; // a piece in front of the tip of the bore has nothing to draw
          index.push(a, b, c, a, c, d);
        }
      }
    }
    return { position: position.subarray(0, v * 3), shade: shade.subarray(0, v * 3), index };
  };

  // The map for the shader: for every storey a plan, with in every texel the tube there (see view.js).
  const buildMap = (tunnels, items) => {
    const { vox } = tunnels, count = tunnels.storeys;
    const W = vox.nx * vox.c, D = vox.nz * vox.c;
    const cell = Math.max(0.4, Math.sqrt((W * D * count) / 8e6));
    const tw = Math.ceil(W / cell), td = Math.ceil(D / cell);
    const size = `${tw}x${td}x${count}`;
    if (size !== dims) {
      texture?.dispose();
      data = new Uint8Array(tw * td * count * 2);
      texture = new THREE.Data3DTexture(data, tw, td, count);
      texture.format = THREE.RGFormat;
      texture.type = THREE.UnsignedByteType;
      texture.minFilter = texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.unpackAlignment = 1;
      dims = size;
    }
    for (let i = 0; i < data.length; i += 2) { data[i] = 255; data[i + 1] = 0; }
    for (const { tube, f } of items) {
      const [d0, d1] = tube.dir, p0 = -d1, p1 = d0, along = bore(tube, tube.shape, f);
      const storey = Math.floor(tube.mid / vox.perStorey);
      for (let t0 = tube.ta - 2; t0 < tube.tb + 2; t0 += SEGMENT) {
        const t1 = t0 + SEGMENT, reach = tube.wide + LIP + cell;
        // the box (in the plan's texels) round this piece of the tube
        const xs = [], zs = [];
        for (const t of [t0, t1]) for (const q of [tube.o - reach, tube.o + reach]) { xs.push(d0 * t + p0 * q); zs.push(d1 * t + p1 * q); }
        const i0 = Math.max(0, Math.floor((Math.min(...xs) - vox.x0) / cell)), i1 = Math.min(tw - 1, Math.floor((Math.max(...xs) - vox.x0) / cell));
        const j0 = Math.max(0, Math.floor((Math.min(...zs) - vox.z0) / cell)), j1 = Math.min(td - 1, Math.floor((Math.max(...zs) - vox.z0) / cell));
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const x = vox.x0 + (i + 0.5) * cell, z = vox.z0 + (j + 0.5) * cell;
            const t = x * d0 + z * d1;
            if (t < t0 || t >= t1) continue;
            const { w, h, s } = along(t);
            if (w <= 0) continue;
            const we = w + LIP * s, q = x * p0 + z * p1 - tube.o, n = Math.abs(q) / we; // the opening in the wall is the tube widened by its rounded lip
            if (n >= 1) continue;
            const at = ((storey * td + j) * tw + i) * 2, value = Math.round(n * 255), deep = Math.min(2, (h * tube.half + LIP * s) / tube.half);
            if (value < data[at]) { data[at] = value; data[at + 1] = Math.max(1, Math.round((deep / 2) * 255)); } // the height is stored as half of its fraction of the void
          }
        }
      }
    }
    texture.needsUpdate = true;
    uniforms.uBoreTex.value = texture;
    uniforms.uBoreBox.value.set(vox.x0, vox.z0, tw * cell, td * cell);
    uniforms.uBoreStorey.value.set(STOREY, ZONE, count);
  };

  return {
    clear,
    // Shows the tunnels under `parent`. `bores`: for each pair of floors that has tunnels on show, { b, dir, shape, prog } (prog: how far
    // the erosion has got, 0 to 1). Cheap to call every frame: it only rebuilds when something has changed, and at most every MIN_INTERVAL ms.
    update(parent, tunnels, bores) {
      const shown = (bores ?? []).filter((x) => x.prog > 0);
      if (!parent || !tunnels || !shown.length) return clear();
      const key = `${tunnels.id}|${parent.id}|` + shown.map((x) => `${x.b}:${x.dir}:${JSON.stringify(x.shape)}:${x.prog.toFixed(3)}`).join("|");
      if (key === lastKey && group?.parent === parent) return;
      const now = performance.now();
      if (group?.parent === parent && now - lastTime < MIN_INTERVAL && shown.every((x) => x.prog < 1)) return;
      lastKey = key; lastTime = now;
      const items = [];
      for (const { b, dir, shape, prog } of shown) for (const tube of layoutOf(tunnels, b, dir, shape)) items.push({ tube, f: own(prog, tube.delay) });
      const active = items.filter((x) => x.f > 0);
      if (!wall) wall = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, vertexColors: true });
      // The tubes are the colour of the mass, as if worn out of the same stone.
      if (!matched) parent.traverse((o) => { if (!matched && o.isMesh && o.material?.color && o !== mesh) { wall.color.copy(o.material.color); matched = true; } });
      if (!group || group.parent !== parent) {
        group?.parent?.remove(group);
        group = new THREE.Group();
        group.userData.solid = true; // the x-ray mode (view.js) leaves the tunnels as they are
        parent.add(group);
      }
      buildMap(tunnels, active);
      const { position, shade, index } = buildMesh(active);
      if (mesh) { group.remove(mesh); mesh.geometry.dispose(); mesh = null; }
      if (index.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
        geo.setAttribute("color", new THREE.BufferAttribute(shade, 3));
        geo.setIndex(index);
        geo.computeVertexNormals();
        mesh = new THREE.Mesh(geo, wall);
        group.add(mesh);
      }
    },
  };
}

