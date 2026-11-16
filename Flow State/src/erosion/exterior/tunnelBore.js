// VIEW (exterior erosion): the wind tunnels as the wind would wear them out of a block of stone. No solver code.
//
// Every tunnel is a tube with an elliptical cross-section along the wind, in the layer of a storey that tunnels.js `placement` gives (tunnels.js
// `layout`). Its drawn shape is not voxels but the shape's own numbers, so it is smooth at any size. It is bored from the windward
// face: at the start it is a small round dimple in the wall, which deepens and widens as the bore goes in, with a rounded tip, and
// breaks out of the leeward face as a small hole that opens up. `prog` (0 to 1) says how far the erosion has got; the tunnels do not
// all start together (each has its own delay).
//
// Two things are made from the same numbers, so that they always agree: the walls of the tubes (a mesh, drawn inside the mass), and a
// map for the shader (see view.js) which discards the mass's own surface where a tube meets it, so that the opening is exactly the
// tube's cross-section. The mass's own surface is the original model; nothing about it changes.
import * as THREE from "three";
import { tunnelWidth, STOREY, GAP, LIP } from "./tunnels.js";

const RING = 28; // points round a tube's cross-section
const STEP = 0.7; // metres between the stations of a tube (they bunch up at the two ends, see spread)
const LIP_LEN = 1.4; // metres: how far in from the wall the rounding goes
const CLEAR = 1; // metres a tunnel keeps from the corners and sides of the mass
const NARROW = [1, 0.8, 0.6, 0.45]; // how much narrower than its shape a tunnel is made, in turn, to keep that clearance
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

// The shape of one piece of a tunnel at progress f (0..1): along(t) gives { w, h, s }: the half width, the fraction of the layer's depth, and
// how far the bore has grown there (0 to 1) at t along the wind. The whole way through a tunnel (`pathLen`, round the occupied spaces too) is
// bored from its windward end at an even pace, and a piece starts `s0` along it. An end of a piece that is not at a face of the mass
// (where it meets the strands round a space) is closed with a rounded cap.
const CAP = 1.5; // metres: how long a closed end is
const capShape = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : Math.sqrt(x * (2 - x)));
function bore(tube, shape, f) {
  const { half } = tube, pathLen = tube.pathLen, nose = Math.min(NOSE, pathLen / 2), bored = f * (pathLen + nose);
  return (t) => {
    const r = bored - (tube.s0 + (t - tube.tStart)); // how far behind the tip of the bore this point is (negative: not reached yet)
    if (r <= 0) return { w: 0, h: 0, s: 0 };
    const x = Math.min(1, r / nose);
    let scale = Math.sqrt(x * (2 - x)); // a round tip
    if (tube.capStart) scale *= capShape((t - tube.tStart) / CAP);
    if (tube.capEnd) scale *= capShape((tube.tEnd - t) / CAP);
    const w = ((tunnelWidth(shape, clamp01((t - tube.uTa) / tube.uL), tube.step) * tube.narrow) / 2) * scale;
    return { w, h: Math.min(1, w / half), s: scale }; // as deep as it is wide until it is as deep as the layer
  };
}
// Does the tunnel (an item of tunnels.layout) made `narrow` times as wide keep CLEAR metres from the corners and sides of the mass? Beside it
// (its opening included) there must be mass all along; and at each of the two faces the wall must carry on straight for CLEAR metres
// beyond the opening on both sides (a face may be at an angle to the wind, so it is compared with the line through the opening's own two edges).
const clears = (item, shape, narrow) => {
  const L = item.uL, w = (u) => (tunnelWidth(shape, u, item.step) * narrow) / 2 + LIP;
  // How slanted the two faces are to the wind (along the wind per metre across it), from the lines along the opening's two edges. (An end
  // that is closed, beside a space, has no face to check.)
  const e0 = [item.edges(w(0)), item.edges(-w(0))], e1 = [item.edges(w(1)), item.edges(-w(1))];
  if (!item.capStart && e0.includes(null) || !item.capEnd && e1.includes(null)) return false;
  const slant0 = item.capStart ? 0 : Math.abs(e0[0][0] - e0[1][0]) / (2 * w(0)), slant1 = item.capEnd ? 0 : Math.abs(e1[0][1] - e1[1][1]) / (2 * w(1));
  for (let t = item.ta + 3; t <= item.tb - 3; t += 1) {
    const q = w(clamp01((t - item.uTa) / L)) + CLEAR;
    if (t - item.ta < slant0 * q + 1 || item.tb - t < slant1 * q + 1) continue; // near a face the beside-points may lie past it (checked below)
    if (!item.inside(t, q) || !item.inside(t, -q)) return false;
  }
  for (const [u, i, capped] of [[0, 0, item.capStart], [1, 1, item.capEnd]]) {
    if (capped) continue;
    const wq = w(u), q = wq + CLEAR, a = item.edges(wq), b = item.edges(-wq), c1 = item.edges(q), c2 = item.edges(-q);
    if (!a || !b || !c1 || !c2) return false;
    for (const [e, at] of [[c1, q], [c2, -q]]) if (Math.abs(e[i] - (b[i] + ((a[i] - b[i]) * (at + wq)) / (2 * wq))) > 1.2) return false; // (the height map's faces are not exact: a corner shows as much more than this)
  }
  return true;
};
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
    const key = `${b}|${dir[0]},${dir[1]}|${JSON.stringify(shape)}|${tunnels.obstaclesKey}`; // (a tunnel bends round the occupied spaces)
    let tubes = layouts.get(key);
    if (!tubes) {
      const items = tunnels.layout(b, dir, shape);
      const made = items.map((first) => {
        if (first.type === "strand") return { ...first, delay: delayOf(b, first.laneId), shape }; // a strand round an occupied space
        // A tunnel keeps CLEAR metres from the corners and sides of the mass: where it does not, it is moved over, then made narrower
        // (and left out if there is no way).
        let pick = null;
        for (const narrow of NARROW) {
          // Moving a tunnel over must not close the gap to its neighbours (they may move towards it too): its widest part, the lips and twice the move
          // have to fit in the spacing with GAP to spare.
          const widest = Math.max(tunnelWidth(shape, 0, first.step), tunnelWidth(shape, shape.pos, first.step), tunnelWidth(shape, 1, first.step)) * narrow + 2 * LIP;
          for (const dq of [0, 0.75, -0.75, 1.5, -1.5, 2.25, -2.25]) {
            if (Math.abs(dq) > 0.35 * shape.spacing || widest + 2 * Math.abs(dq) > first.step - GAP + 1e-6) continue;
            const item = dq ? first.shift(dq) : first;
            if (item && clears(item, shape, narrow)) { pick = { run: item, narrow }; break; }
          }
          if (pick) break;
        }
        if (!pick) return null;
        const { run, narrow } = pick, half = (u) => (tunnelWidth(shape, u, run.step) * narrow) / 2;
        const wide = Math.max(tunnelWidth(shape, 0, run.step), tunnelWidth(shape, shape.pos, run.step), tunnelWidth(shape, 1, run.step)) * narrow / 2;
        const lines = Array.from({ length: RING }, (_, k) => { // where the tube starts and ends along each line of its wall: the mass's faces, or its own closed ends
          const cos = Math.cos((2 * Math.PI * k) / RING);
          const a = run.capStart ? null : run.edges(cos * (half(0) + LIP)), z = run.capEnd ? null : run.edges(cos * (half(1) + LIP));
          return [run.capStart ? run.tStart : a ? a[0] : run.ta, run.capEnd ? run.tEnd : z ? z[1] : run.tb];
        });
        // A tube with a stretch of wall outside the mass would jut out of it: it is left out.
        const gap = lines.some(([a, z], k) => {
          const cos = Math.cos((2 * Math.PI * k) / RING);
          // Near a face the lines of the wall may lie outside the mass (a face at a shallow angle to the wind, and the lip drawing them in): only the stretch
          // between is checked, which is where a side or a corner of the mass would show.
          for (let t = a + (run.capStart ? 0.5 : LIP_LEN + 2.5); t < z - (run.capEnd ? 0.5 : LIP_LEN + 2.5); t += 0.75) if (!run.inside(t, cos * half(clamp01((t - run.uTa) / run.uL)) * 1.02)) return true;
          return false;
        });
        return gap ? null : { ...run, lines, wide, narrow, delay: delayOf(b, run.laneId), shape };
      });
      // A tunnel that has to be left out (a corner, a side of the mass) takes the whole of it with it: every opening goes with its exit, and a tunnel
      // that joined a neighbour goes when the neighbour does, so that none is left with no way out.
      const removed = new Set(), joins = new Map();
      made.forEach((t, i) => { if (!t) removed.add(items[i].laneId); });
      for (const it of items) joins.set(it.laneId, it.joinTo);
      for (let changed = true; changed;) {
        changed = false;
        for (const [lane, to] of joins) if (to >= 0 && removed.has(to) && !removed.has(lane)) { removed.add(lane); changed = true; }
      }
      tubes = made.filter((t, i) => t && !removed.has(items[i].laneId));
      layouts.set(key, tubes);
    }
    return tubes;
  };

  // The tubes' walls: the pieces of lane (elliptical tubes along the wind) and the strands round the occupied spaces (round tubes along a curve).
  const RING_S = 14; // points round a strand
  const buildMesh = (items) => {
    let total = 0;
    for (const { tube } of items) total += tube.type === "strand" ? (tube.pts.length / 3) * RING_S : (Math.ceil((tube.tb - tube.ta) / STEP) + 1) * RING;
    const position = new Float32Array(total * 3), shade = new Float32Array(total * 3), alive = new Uint8Array(total), index = [];
    let v = 0;
    for (const { tube, f } of items) {
      if (tube.type === "strand") {
        // The strand: round rings along its points, turned with the curve (parallel transport), as wide as the strand, grown from its start.
        const pts = tube.pts, np = pts.length / 3, base = v, pathLen = tube.pathLen, nose = Math.min(NOSE, pathLen / 2), bored = f * (pathLen + nose);
        let N = null, acc = 0;
        for (let i = 0; i < np; i++) {
          const i0 = Math.max(0, i - 1), i1 = Math.min(np - 1, i + 1);
          let T = [pts[i1 * 3] - pts[i0 * 3], pts[i1 * 3 + 1] - pts[i0 * 3 + 1], pts[i1 * 3 + 2] - pts[i0 * 3 + 2]];
          const tl = Math.hypot(T[0], T[1], T[2]) || 1;
          T = T.map((x) => x / tl);
          if (!N) {
            const ref = Math.abs(T[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
            N = [T[1] * ref[2] - T[2] * ref[1], T[2] * ref[0] - T[0] * ref[2], T[0] * ref[1] - T[1] * ref[0]];
          } else {
            const dot = N[0] * T[0] + N[1] * T[1] + N[2] * T[2];
            N = [N[0] - T[0] * dot, N[1] - T[1] * dot, N[2] - T[2] * dot];
          }
          const nl = Math.hypot(N[0], N[1], N[2]) || 1;
          N = N.map((x) => x / nl);
          const B = [T[1] * N[2] - T[2] * N[1], T[2] * N[0] - T[0] * N[2], T[0] * N[1] - T[1] * N[0]];
          if (i) acc += Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2], pts[i * 3 + 2] - pts[i * 3 - 1]);
          const r = bored - (tube.s0 + acc), x = Math.min(1, Math.max(0, r) / nose), grown = r > 0 ? Math.sqrt(x * (2 - x)) : 0;
          const e = Math.max(0, Math.min(1, Math.min(acc, tube.len - acc) / 1.5)), taper = 0.45 + 0.55 * Math.sqrt(e * (2 - e)); // slimmer where it joins the tunnel
          const rad = tube.rad * grown * taper;
          for (let k = 0; k < RING_S; k++, v++) {
            const a = (2 * Math.PI * k) / RING_S, ca = Math.cos(a) * rad, sa = Math.sin(a) * rad;
            alive[v] = rad > 0 ? 1 : 0;
            position[v * 3] = pts[i * 3] + N[0] * ca + B[0] * sa;
            position[v * 3 + 1] = pts[i * 3 + 1] + N[1] * ca + B[1] * sa;
            position[v * 3 + 2] = pts[i * 3 + 2] + N[2] * ca + B[2] * sa;
            shade[v * 3] = shade[v * 3 + 1] = shade[v * 3 + 2] = 0.5;
          }
        }
        for (let i = 0; i < np - 1; i++) {
          for (let k = 0; k < RING_S; k++) {
            const a = base + i * RING_S + k, b = base + (i + 1) * RING_S + k, c = base + (i + 1) * RING_S + ((k + 1) % RING_S), d = base + i * RING_S + ((k + 1) % RING_S);
            if (!alive[a] && !alive[b] && !alive[c] && !alive[d]) continue;
            index.push(a, b, c, a, c, d);
          }
        }
        continue;
      }
      const { dir, o, y, half, lines, shape } = tube, [d0, d1] = dir, p0 = -d1, p1 = d0;
      const along = bore(tube, shape, f), N = Math.ceil((tube.tb - tube.ta) / STEP) + 1, base = v;
      for (let i = 0; i < N; i++) {
        for (let k = 0; k < RING; k++, v++) {
          const [t0, t1] = lines[k], t = t0 + (t1 - t0) * spread(i / (N - 1)), a = (2 * Math.PI * k) / RING;
          const { w, h, s } = along(t), depth = Math.min(t - t0, t1 - t);
          const fl = lip(Math.min(tube.capStart ? 1e9 : t - t0, tube.capEnd ? 1e9 : t1 - t), LIP * s); // the opening is rounded off into the wall (not at a closed end)
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
      if (tube.type === "strand") continue; // (strands are inside the mass: the shader has nothing to cut for them)
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
            const at = ((storey * td + j) * tw + i) * 2, value = Math.round(n * 255), deep = Math.min(3, (h * tube.half + LIP * s) / tube.half);
            if (value < data[at]) { data[at] = value; data[at + 1] = Math.max(1, Math.round((deep / 3) * 255)); } // the height is stored as a third of its fraction of the void
          }
        }
      }
    }
    texture.needsUpdate = true;
    uniforms.uBoreTex.value = texture;
    uniforms.uBoreBox.value.set(vox.x0, vox.z0, tw * cell, td * cell);
    uniforms.uBoreStorey.value.set(STOREY, tunnels.level.offset, tunnels.level.half, count);
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



