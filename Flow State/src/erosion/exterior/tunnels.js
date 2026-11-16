// MODEL (exterior erosion): the wind tunnels' state. No scene or DOM code.
//
// The voxel mass (voxelFlow.js) is built once from the form and then kept: tunnels are voxels of the mass switched to air, and
// the airflow is solved on them (potential flow: it shows where the air is squeezed and speeds up, not turbulence or friction).
//
// Floors: the mass is cut into storeys of STOREY metres (14 ft), and the storeys are grouped in pairs, the BANDS (floors 1-2,
// floors 3-4, ...). The tunnels of a band never leave it, so they span two storeys at most. One layer of voxels at the bottom of
// every storey is a few layers of voxels (the last, thin one ZONE metres deep, is the ceiling void). Where tunnels may form is decided in one
// place, `placement` below: for now anywhere in the mass except the roof (the top layer of every column) and, in the drawn tunnels, within
// CLEAR of its corners and sides. The top layer of every column is left as
// the roof. A pair of floors with less than a whole storey of mass in it is skipped (`usable`).
//
// Every band has its own wind: its tunnels face the direction it is given (index.js gives each band a different part of the
// warm season, so that one pair of floors or another is always being cooled), and its airflow is solved for that direction, with
// the other bands' tunnels in place as they are. Everything below that takes a band `b` works on that band only.
//
// The shape of the tunnels: in each storey of a band the tunnels run along the wind, side by side across the mass. Each is a
// smooth tube with an elliptical cross-section: wide at the windward face (the mouth), narrowing to a throat, widening again to
// the exit. The throat is where the air speeds up (the same flow squeezed through less room). The shape is described by a few
// numbers (SHAPES): the spacing between tunnels, the throat width, how much wider the mouth and the exit are, and where along the
// tunnel the throat lies. The tunnels in the upper storey sit half a spacing to the side of the ones below.
//
// The solver picks the numbers (searchStep): it tries a shape (voxelises it, solves the airflow, scores the cooling), then varies
// one number at a time, keeps what scores better, and repeats until nothing improves. A shape that carves away more than the
// volume limit scores as no good, so the tunnels cannot simply be made as big as possible: wider ones cool more of the floor but
// there is only so much to carve, so the solver has to choose between a few wide tunnels and many narrow ones.
//
// cooling(b) reads how much of each storey's floor plate lies near moving air; that is the score.
import { createVoxelMass, solveFlow, AIR, MASS } from "./voxelFlow.js";

export const STOREY = 14 * 0.3048; // metres: one storey, 14 ft
export const BAND_STOREYS = 2; // storeys a tunnel may span at most
export const ZONE = 0.9; // metres: the depth of the thin layer at the top of every storey (it only shapes the voxel layers; tunnels are not tied to it)

// WHERE tunnels may form. Change this to change it; nothing else decides it.
//   level(perStorey): the voxel layer of a storey (0 = its lowest) that the tunnels of that storey are cut in. Now the middle of the storey.
//   allowed(layer, column, roofLayer): may the voxel at this layer and column (index into one layer of the grid) be carved? Now anywhere
//   below the roof, but never the ground layer.
// (The drawn tunnels are placed from level() too; a rule that moves tunnels up or down per storey also needs the shader in view.js, which
// takes one height for every storey, to be told.)
export const placement = {
  level: (perStorey) => Math.floor((perStorey - 1) / 2),
  allowed: (layer, column, roofLayer) => layer > 0 && layer < roofLayer,
};
export const REACH = 3; // metres: how far from a tunnel its moving air is taken to cool the floor
export const NEAR = 0.3; // cooling (see cooling()) at which a floor voxel counts as near moving air: about 2 m from air at the open wind's speed
const MIN_RUN = 4; // metres: a tunnel shorter than this (a corner of the mass) is not made

// The numbers the solver chooses from.
export const SHAPES = {
  spacing: [6, 8, 10, 12, 14], // metres between tunnels in one storey
  throat: [1.4, 2.1, 2.8, 3.6, 4.5, 6, 8], // metres: the width at the narrowest point (rounded up to a whole voxel at least)
  mouth: [1, 1.5, 2, 2.5], // x the throat: the width at the windward face
  exit: [1, 1.4, 1.8], // x the throat: the width at the leeward face
  pos: [0.35, 0.5, 0.65], // how far along the tunnel the throat is
};
const MAX_PASSES = 3; // rounds of varying the numbers one at a time (in the fine search)
const COARSE_SOLVE = { maxIter: 60, tol: 3e-3 }; // the loose airflow solve of the coarse search
// The shapes of the coarse search: a small grid of spacings and throat widths, the rest at a sensible middle.
const coarseShapes = () => {
  const out = [];
  for (const spacing of [6, 8, 10, 14]) for (const throat of [1.4, 2.8, 4.5]) out.push({ spacing, throat, mouth: 2, exit: 1.4, pos: 0.5 });
  return out;
};

// The width of a tunnel at u (0 at the windward face, 1 at the leeward face) for the shape p: eased between the mouth, throat and exit.
const ease = (x) => (1 - Math.cos(Math.PI * x)) / 2;
export const GAP = 3 * 0.3048; // metres: the least clear space between two tunnels (3 ft), measured between their openings
export const LIP = 0.6; // metres: how much wider and deeper than the tube its opening in the wall is at the wall (see tunnelBore.js)
// `step` is the distance between the tunnels (the spacing, or what it came to on this mass). However wide the numbers say it is, a tunnel is
// scaled down to fit: its widest part, with the rounded lip of its opening, always leaves GAP metres to the next tunnel.
export function tunnelWidth(p, u, step = p.spacing) {
  const raw = p.throat * (u < p.pos ? 1 + (p.mouth - 1) * ease(1 - u / p.pos) : 1 + (p.exit - 1) * ease((u - p.pos) / (1 - p.pos)));
  const widest = p.throat * Math.max(1, p.mouth, p.exit);
  return raw * Math.min(1, Math.max(0.5, step - GAP - 2 * LIP) / widest);
}

// form: the shared form (form.js), as it is now. cityHeight: (x, z) => metres, the site's buildings (windFlow.js cityHeights).
// Returns null if the form has no mass.
let serial = 0;
export function createTunnels(form, { cityHeight = null } = {}) {
  const vox = createVoxelMass(form, { cityHeight, maxCells: 400000, storey: STOREY, zone: ZONE });
  if (!vox) return null;
  const { nx, nz, ny, c, cells, dz, yc } = vox;
  const nxz = nx * nz;
  const perStorey = vox.perStorey; // voxel layers in one storey
  const level = placement.level(perStorey); // the layer of a storey its tunnels are cut in
  const perBand = perStorey * BAND_STOREYS;
  const placed = Uint8Array.from(cells); // the mass as it was placed, to put it back
  const roof = new Int16Array(nxz).fill(-1); // the layer of the top mass voxel in every column (-1 where there is none)
  for (let k = 0; k < placed.length; k++) if (placed[k] === MASS) roof[k % nxz] = Math.floor(k / nxz);
  const bandCount = Math.max(1, Math.ceil(vox.top / (STOREY * BAND_STOREYS)));
  const layers = (b) => [b * perBand, Math.min(ny, (b + 1) * perBand)]; // the voxel layers of a band: from, up to (not including)
  const bandOf = (k) => Math.min(bandCount - 1, Math.floor(Math.floor(k / nxz) / perBand));

  // What each band has: its mass voxels, how many are carved, its own airflow and the search for its shape.
  const fresh = { carved: 0, doneKey: "", flow: null, flowVersion: -1, flowDir: null, search: null, chosen: null, rough: false, mapKey: '', map: null };
  const bands = Array.from({ length: bandCount }, (_, b) => {
    let mass = 0;
    const [lo, hi] = layers(b);
    for (let k = lo * nxz; k < hi * nxz; k++) if (placed[k] === MASS) mass += dz[Math.floor(k / nxz)]; // mass and carving are counted in volume (a layer's height), the layers not being alike
    return { mass, ...fresh };
  });
  let top = -1; // the highest mass layer
  for (let col = 0; col < nxz; col++) top = Math.max(top, roof[col]);
  const usable = bands.map((_, b) => b).filter((b) => top >= layers(b)[0] + perStorey);
  let active = usable.slice(); // the bands being worked on
  let merged = null, mergedKey = ""; // the airflow of all the bands in one (see `flow`)

  const isTunnel = (k) => placed[k] === MASS && cells[k] === AIR; // air that the mass once held
  const sum = (key, list = active) => list.reduce((s, b) => s + bands[b][key], 0);

  // The occupied spaces (the interior erosion's spheres { x, y, z, r }, world metres) that tunnels keep out of: a tunnel bends round them
  // (see planRuns), and no voxel whose centre lies in one is ever carved.
  let obstacles = [], obstaclesKey = "";
  const inSpace = (x, y, z) => {
    for (const s of obstacles) {
      const ax = x - s.x, ay = y - s.y, az = z - s.z;
      if (ax * ax + ay * ay + az * az < s.r * s.r) return true;
    }
    return false;
  };

  // Opens a voxel of the mass. Says whether it changed (context buildings and air cannot be carved).
  const carve = (k) => {
    if (placed[k] !== MASS || cells[k] !== MASS) return false;
    const layer = Math.floor(k / nxz);
    if (!placement.allowed(layer, k % nxz, roof[k % nxz])) return false;
    if (obstacles.length) {
      const col = k - layer * nxz, [x, y, z] = vox.centre(col % nx, Math.floor(col / nx), layer);
      if (inSpace(x, y, z)) return false;
    }
    vox.set(k, AIR);
    bands[bandOf(k)].carved += dz[layer];
    return true;
  };

  // Puts band b back as placed.
  const clearBand = (b) => {
    const [lo, hi] = layers(b);
    cells.set(placed.subarray(lo * nxz, hi * nxz), lo * nxz);
    bands[b].carved = 0;
    vox.version++;
  };

  // The tunnels of shape p in band b along the wind dir = [ux, uz], as runs through the mass: { mid, s, o, t0, t1 } with mid the layer of the
  // level they lie in, s the storey of the band, o how far across the wind and t0..t1 from the windward face to the leeward one
  // (along the wind). Positions are world metres in the frame of dir: x = d0 t - d1 q, z = d1 t + d0 q. Found on the voxels, so the ends
  // are only as exact as a voxel; see `layout` for the drawn ones.
  const runsOf = (b, dir, p) => {
    const [d0, d1] = dir, p0 = -d1, p1 = d0; // along the wind, and across it
    const [lo, hi] = layers(b);
    let amin = Infinity, amax = -Infinity, qmin = Infinity, qmax = -Infinity;
    for (let l = lo; l < hi; l++) {
      for (let col = 0; col < nxz; col++) {
        if (placed[l * nxz + col] !== MASS) continue;
        const [x, , z] = vox.centre(col % nx, Math.floor(col / nx), l);
        const a = x * d0 + z * d1, q = x * p0 + z * p1;
        amin = Math.min(amin, a); amax = Math.max(amax, a); qmin = Math.min(qmin, q); qmax = Math.max(qmax, q);
      }
    }
    const out = [];
    if (amax < amin) return out;
    const n = Math.max(1, Math.round((qmax - qmin + c) / p.spacing)), step = (qmax - qmin + c) / n;
    const at = (t, q) => [Math.floor((d0 * t + p0 * q - vox.x0) / c), Math.floor((d1 * t + p1 * q - vox.z0) / c)];
    for (let s = 0; s < BAND_STOREYS; s++) {
      const mid = lo + s * perStorey + level; // the layer the storey's tunnels are cut in, and where the runs through the mass are found
      if (mid >= hi) break;
      for (let m = 0; m < n; m++) {
        const o = qmin - c / 2 + (m + (s % 2 ? 0.75 : 0.25)) * step; // across the wind; the upper storey is half a step over
        // The runs of mass along this line: each is one tunnel, from the windward face to the leeward one.
        let start = null;
        const runs = [];
        for (let t = amin - c; t <= amax + c + c / 4; t += c / 2) {
          const [i, j] = at(t, o);
          const inside = i >= 0 && j >= 0 && i < nx && j < nz && placed[vox.index(i, j, mid)] === MASS;
          if (inside && start === null) start = t;
          if (!inside && start !== null) { runs.push([start, t - c / 2]); start = null; }
        }
        for (const [t0, t1] of runs) if (t1 - t0 >= MIN_RUN) out.push({ mid, s, o, t0, t1, dir, step });
      }
    }
    return obstacles.length ? planRoots(b, out, p) : out;
  };

  // Roots. A tunnel (a lane along the wind) that meets an occupied space does not go through it: it stops short of the space and splits into
  // strands that run round the space like roots round a rock, in every direction (up, down and to the sides), hugging its surface, and join
  // up again on the far side, where the lane carries on. A lane's `pieces` are its parts in the order the air goes through them:
  //   { type: "lane", t0, t1, capStart, capEnd, s0 }   a stretch of the straight lane (t along the wind); the ends that are not at a face of
  //                                                    the mass are capped; s0 is how far along the whole way it starts
  //   { type: "strand", pts: Float32Array (x, y, z ...), rad, len, s0 }   one strand round a space
  // and `pathLen` is the length of the whole way. A lane that can not get through is left out.
  const DEV_MARGIN = 0.3; // metres a tunnel keeps clear of a space
  const ROOT_STEP = 0.25, ROOT_JOIN = 2.5, ROOT_TINY = 0.5, END_GAP = 0.5, ROOT_RAMP = 3, STRAND_STEP = 0.4;
  const nearest = (x, y, z) => { // the nearest space: { d: the distance to its surface (negative inside), nx, ny, nz: the way out of it }
    let best = null;
    for (const s of obstacles) {
      const ax = x - s.x, ay = y - s.y, az = z - s.z, len = Math.hypot(ax, ay, az), d = len - s.r;
      if (!best || d < best.d) best = { d, nx: len > 1e-6 ? ax / len : 1, ny: len > 1e-6 ? ay / len : 0, nz: len > 1e-6 ? az / len : 0 };
    }
    return best ?? { d: Infinity, nx: 1, ny: 0, nz: 0 };
  };

  // Plans the lanes of one band. Every lane that is opened at its windward face must come out at its leeward face: it either gets through (the
  // strands round a space join it up again) or, where it can not, it joins a neighbouring lane that does (a link, see joinLane), and its own
  // way on is left out. A lane whose mouth would be inside a space is not opened at all.
  const planRoots = (b, runs, p) => {
    const planned = runs.map((run) => ({ run, res: rootPieces(b, run, p) }));
    const open = planned.filter((x) => x.res && !x.res.partial); // lanes with a way through of their own
    const pending = planned.filter((x) => x.res?.partial);
    for (let pass = 0; pass < 4 && pending.length; pass++) { // a lane may join one that has itself joined another
      let progress = false;
      for (const item of pending.slice()) {
        const link = joinLane(b, item, open.concat(planned.filter((x) => x.link)), p);
        if (!link) continue;
        item.res = { pieces: [...item.res.pieces, link.piece], pathLen: item.res.s + link.piece.len };
        item.link = true;
        item.joinTo = link.target;
        pending.splice(pending.indexOf(item), 1);
        progress = true;
      }
      if (!progress) break;
    }
    const kept = planned.filter((x) => x.res && !x.res.partial);
    return kept.map((x) => ({ ...x.run, pieces: x.res.pieces, pathLen: x.res.pathLen, joinTo: x.joinTo ? kept.indexOf(x.joinTo) : -1 }));
  };

  const rootPieces = (b, run, p) => {
    const { t0, t1, o, step, dir, mid } = run, [d0, d1] = dir, y = yc[mid], L = t1 - t0;
    const wAt = (t) => tunnelWidth(p, (t - t0) / L, step) / 2;
    const n = Math.max(2, Math.ceil(L / ROOT_STEP)), ts = (i) => t0 + (i * L) / n, at = (t) => [d0 * t - d1 * o, y, d1 * t + d0 * o];
    const blocked = new Uint8Array(n + 1);
    for (let i = 0; i <= n; i++) { const t = ts(i), q = at(t); blocked[i] = nearest(q[0], y, q[2]).d < wAt(t) + DEV_MARGIN + END_GAP ? 1 : 0; }
    if (blocked[0]) return null; // a space across the mouth of the tunnel: it is not opened
    const spans = []; // the blocked stretches [i0, i1] (ones close together are one)
    for (let i = 0; i <= n; i++) {
      if (!blocked[i]) continue;
      let j = i;
      while (j < n && blocked[j + 1]) j++;
      const last = spans[spans.length - 1];
      if (last && ts(i) - ts(last[1]) < ROOT_JOIN) last[1] = j; else spans.push([i, j]);
      i = j;
    }
    const pieces = [];
    let s = 0, cursor = 0, fed = false;
    for (const [i0, i1] of spans) {
      const a = ts(cursor), z = ts(i0);
      if (z - a < ROOT_TINY) return null; // a space right at the mouth
      pieces.push({ type: "lane", t0: a, t1: z, capStart: fed, capEnd: true, s0: s });
      s += z - a;
      const fail = { partial: true, pieces, s, join: { t: z, w: wAt(z) } }; // the lane stops here and has to join a neighbour
      if (i1 >= n - 2) return fail; // the space reaches the far face
      const strands = makeStrands(b, at(z), at(ts(i1)), wAt(z), dir);
      if (!strands.length) return fail; // no way round
      const mean = strands.reduce((sum, st) => sum + st.len, 0) / strands.length;
      for (const st of strands) pieces.push({ type: "strand", pts: st.pts, rad: st.rad, len: st.len, s0: s });
      s += mean;
      cursor = i1;
      fed = true;
    }
    const a = ts(cursor);
    if (t1 - a >= ROOT_TINY) { pieces.push({ type: "lane", t0: a, t1, capStart: fed, capEnd: false, s0: s }); s += t1 - a; }
    else if (fed) return { partial: true, pieces, s, join: { t: ts(cursor), w: wAt(ts(cursor)) }, atEnd: true };
    return { pieces, pathLen: s };
  };

  // A link from a lane that has to stop (item) to a neighbouring lane that gets through: a smooth curve in the level of the tunnels, leaving
  // the lane along the wind and joining the neighbour's, clear of the spaces and inside the mass. `lanes` are the candidates (lanes that
  // have a way through). Returns { piece, target } or null.
  const joinLane = (b, item, lanes, p) => {
    const { run, res } = item, { t: tj0, w } = res.join, [d0, d1] = run.dir, y = yc[run.mid], [lo, hi] = layers(b);
    const rad = Math.max(0.5, Math.min(1.6, 0.8 * w)), yMin = vox.ye[lo], yMax = vox.ye[hi];
    const world = (t, q) => [d0 * t - d1 * q, y, d1 * t + d0 * q];
    const candidates = lanes.filter((x) => x !== item && x.run.mid === run.mid && Math.abs(x.run.o - run.o) <= 1.7 * run.step && x.run.t1 > tj0)
      .sort((a, c) => Math.abs(a.run.o - run.o) - Math.abs(c.run.o - run.o));
    for (const target of candidates) {
      const dq = target.run.o - run.o;
      for (const mult of [2.2, 3.4, 5, 7]) {
        const tj = tj0 + Math.max(4, mult * Math.abs(dq));
        const piece = target.res.pieces.find((pc) => pc.type === "lane" && tj >= pc.t0 + 1 && tj <= pc.t1 - 1);
        if (!piece) continue;
        // a smooth curve (cubic Hermite, along the wind at both ends)
        const chord = tj - tj0, pts = [], m = Math.max(4, Math.ceil(Math.hypot(chord, dq) / STRAND_STEP));
        let ok = true, len = 0, prev = null;
        for (let i = 0; i <= m && ok; i++) {
          const u = i / m, h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
          const t = h00 * tj0 + h10 * chord + h01 * tj + h11 * chord, q = h00 * run.o + h01 * target.run.o;
          const pt = world(t, q);
          if (nearest(pt[0], pt[1], pt[2]).d < rad + DEV_MARGIN - 0.1) ok = false;
          const top = y + rad + 0.4, k = rad + 1;
          if (ok) ok = y - rad >= yMin && y + rad <= yMax && form.heightAt(pt[0], pt[2]) >= top && form.heightAt(pt[0] + k, pt[2]) >= top && form.heightAt(pt[0] - k, pt[2]) >= top && form.heightAt(pt[0], pt[2] + k) >= top && form.heightAt(pt[0], pt[2] - k) >= top;
          if (prev) len += Math.hypot(pt[0] - prev[0], pt[2] - prev[2]);
          prev = pt;
          pts.push(pt);
        }
        if (ok) return { piece: { type: "strand", pts: Float32Array.from(pts.flat()), rad, len, s0: res.s, link: true }, target };
      }
    }
    return null;
  };
  // The strands that carry a tunnel round the spaces in its way, from E (where the lane stops) to X (where it carries on): 2 to 4 of them,
  // as many as fit round, each heading out in a different direction round the way through and pressed onto a skin round the spaces as wide as
  // the strand. Any strand that would leave the mass, or the two floors of this pair, or come nearer than a corner clearance to its sides,
  // is left out.
  const makeStrands = (b, E, X, wMain, dir) => {
    const [lo, hi] = layers(b), yMin = vox.ye[lo], yMax = vox.ye[hi];
    const mid = [(E[0] + X[0]) / 2, (E[1] + X[1]) / 2, (E[2] + X[2]) / 2], reach = Math.hypot(X[0] - E[0], X[1] - E[1], X[2] - E[2]) / 2 + 4;
    const touched = obstacles.filter((s) => Math.hypot(s.x - mid[0], s.y - mid[1], s.z - mid[2]) - s.r < reach);
    if (!touched.length) return [];
    const C = [0, 0, 0];
    for (const s of touched) { C[0] += s.x; C[1] += s.y; C[2] += s.z; }
    for (let k = 0; k < 3; k++) C[k] /= touched.length;
    let Rb = 0;
    for (const s of touched) Rb = Math.max(Rb, Math.hypot(s.x - C[0], s.y - C[1], s.z - C[2]) + s.r);
    const wb = Math.max(0.5, Math.min(1.6, 0.62 * wMain)), dOff = wb + DEV_MARGIN;
    let a = [X[0] - E[0], X[1] - E[1], X[2] - E[2]];
    const al = Math.hypot(a[0], a[1], a[2]);
    a = al > 0.5 ? a.map((v) => v / al) : [dir[0], 0, dir[1]];
    let u = [a[2], 0, -a[0]];
    const ul = Math.hypot(u[0], u[2]) || 1;
    u = [u[0] / ul, 0, u[2] / ul];
    const v = [a[1] * u[2], a[2] * u[0] - a[0] * u[2], -a[1] * u[0]];
    const K = Math.max(2, Math.min(4, Math.round((2 * Math.PI * (Rb + dOff)) / (2 * wb + 2))));
    const okPoint = (x, yy) => {
      if (yy - wb < yMin || yy + wb > yMax) return false;
      const top = yy + wb + 0.4, q = wb + 1;
      return form.heightAt(x[0], x[2]) >= top && form.heightAt(x[0] + q, x[2]) >= top && form.heightAt(x[0] - q, x[2]) >= top && form.heightAt(x[0], x[2] + q) >= top && form.heightAt(x[0], x[2] - q) >= top;
    };
    const strands = [];
    for (let k = 0; k < K; k++) {
      const phi = 0.35 + (2 * Math.PI * k) / K, w = [0, 1, 2].map((i) => u[i] * Math.cos(phi) + v[i] * Math.sin(phi));
      const P = [0, 1, 2].map((i) => C[i] + w[i] * (Rb + dOff + 0.8));
      const pts = [E];
      for (const [from, to] of [[E, P], [P, X]]) {
        const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]), m = Math.max(1, Math.ceil(len / STRAND_STEP));
        for (let i = 1; i <= m; i++) pts.push([0, 1, 2].map((q) => from[q] + ((to[q] - from[q]) * i) / m));
      }
      const acc = [0];
      for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
      const total = acc[acc.length - 1];
      // press the points onto the skin round the spaces, gently near the two ends so that the strand leaves the lane smoothly
      for (let i = 1; i < pts.length - 1; i++) {
        const e = Math.min(1, Math.min(acc[i], total - acc[i]) / ROOT_RAMP), ramp = e * e * (3 - 2 * e);
        const q = pts[i].slice();
        for (let it = 0; it < 4; it++) { const nr = nearest(q[0], q[1], q[2]), push = dOff - nr.d; q[0] += nr.nx * push; q[1] += nr.ny * push; q[2] += nr.nz * push; }
        pts[i] = [0, 1, 2].map((c) => pts[i][c] + (q[c] - pts[i][c]) * ramp);
      }
      for (let pass = 0; pass < 3; pass++) {
        const next = pts.map((q) => q.slice());
        for (let i = 1; i < pts.length - 1; i++) for (let c = 0; c < 3; c++) next[i][c] = (pts[i - 1][c] + 2 * pts[i][c] + pts[i + 1][c]) / 4;
        for (let i = 0; i < pts.length; i++) pts[i] = next[i];
      }
      let ok = true, len = 0;
      for (let i = 0; i < pts.length && ok; i++) {
        const q = pts[i];
        ok = nearest(q[0], q[1], q[2]).d >= dOff - 0.25 && okPoint(q, q[1]);
        if (i) len += Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1], q[2] - pts[i - 1][2]);
      }
      if (ok) strands.push({ pts: Float32Array.from(pts.flat()), rad: wb, len });
    }
    return strands;
  };
  // Opens the voxels within r of a point, in the layers lo up to hi (not including). Says how many it opened.
  const carveBall = (x, y, z, r, lo, hi) => {
    let opened = 0;
    const i0 = Math.max(0, Math.floor((x - r - vox.x0) / c)), i1 = Math.min(nx - 1, Math.floor((x + r - vox.x0) / c));
    const j0 = Math.max(0, Math.floor((z - r - vox.z0) / c)), j1 = Math.min(nz - 1, Math.floor((z + r - vox.z0) / c));
    const l0 = Math.max(lo, vox.layerAt(Math.max(0, y - r))), l1 = Math.min(hi - 1, vox.layerAt(y + r));
    if (l0 < 0 || l1 < 0) return 0;
    for (let l = l0; l <= l1; l++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const cc = vox.centre(i, j, l);
          if ((cc[0] - x) ** 2 + (cc[1] - y) ** 2 + (cc[2] - z) ** 2 <= r * r && carve(vox.index(i, j, l))) opened++;
        }
      }
    }
    return opened;
  };

  // Cuts the tunnels of shape p in band b (after clearing it), along the wind dir = [ux, uz]: the lanes, and where a lane meets an occupied
  // space the strands that go round it (see planRoots). Says how many voxels it opened.
  const shapeBand = (b, dir, p) => {
    clearBand(b);
    const [d0, d1] = dir, p0 = -d1, p1 = d0, [lo, hi] = layers(b);
    let opened = 0;
    for (const run of runsOf(b, dir, p)) {
      const { mid, o, t0, t1, step } = run;
      for (const pc of run.pieces ?? [{ type: "lane", t0, t1 }]) {
        if (pc.type === "strand") { // a ball at every half voxel along the strand
          const pts = pc.pts, r = Math.max(pc.rad, 0.6 * c);
          for (let i = 0; i + 3 < pts.length; i += 3) {
            const dx = pts[i + 3] - pts[i], dy = pts[i + 4] - pts[i + 1], dzz = pts[i + 5] - pts[i + 2], m = Math.max(1, Math.ceil(Math.hypot(dx, dy, dzz) / (c / 2)));
            for (let k = 0; k < m; k++) opened += carveBall(pts[i] + (dx * k) / m, pts[i + 1] + (dy * k) / m, pts[i + 2] + (dzz * k) / m, r, lo, hi);
          }
          continue;
        }
        for (let t = pc.t0; t <= pc.t1; t += c / 2) {
          const w = Math.max(tunnelWidth(p, (t - t0) / (t1 - t0), step), c) / 2; // the half width here; never under a voxel
          for (let q = -w; q <= w + 1e-6; q += c / 2) {
            const i = Math.floor((d0 * t + p0 * (o + q) - vox.x0) / c), j = Math.floor((d1 * t + p1 * (o + q) - vox.z0) / c);
            if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
            if (carve(vox.index(i, j, mid))) opened++;
          }
        }
      }
    }
    return opened;
  };
  // Is there mass at (x, z) in layer mid, with a roof still above it? (From the form's height map, which is finer than the voxels.)
  const massAt = (mid, x, z) => form.heightAt(x, z) >= vox.ye[mid + 1] + 0.3;
  // Where the mass starts and ends along the line (t, q) of a run, found to a few centimetres: [in, out] along the wind, or null.
  const edges = (run, q) => {
    const [d0, d1] = run.dir, p0 = -d1, p1 = d0;
    const inside = (t) => massAt(run.mid, d0 * t + p0 * (run.o + q), d1 * t + p1 * (run.o + q));
    const reach = 2 * c + 3 * Math.abs(q), from = run.t0 - reach, to = run.t1 + reach, step = 0.15; // (a face at a shallow angle to the wind meets a line beside the axis far from where it meets the axis)
    let a = null, z = null;
    for (let t = from; t <= to; t += step) if (inside(t)) { a = t; break; }
    if (a === null) return null;
    for (let t = to; t >= a; t -= step) if (inside(t)) { z = t; break; }
    const bisect = (out, inn) => { for (let i = 0; i < 8; i++) { const m = (out + inn) / 2; if (inside(m)) inn = m; else out = m; } return inn; };
    return [a > from ? bisect(a - step, a) : a, z < to ? bisect(z + step, z) : z];
  };

  // The cooling at every voxel of band b from its last solution: every voxel gets the strongest cooling of any tunnel air within REACH
  // metres, that air's speed (x the open wind) fading to nothing at REACH. Index (layer - lo) * nxz + column.
  const coolField = (b) => {
    const flow = bands[b].flow, [lo, hi] = layers(b), r = Math.ceil(REACH / c);
    const cool = new Float32Array((hi - lo) * nxz);
    for (let l = lo; l < hi; l++) {
      // The layers of the band within REACH of this one, and how far (in metres) their centres are.
      const reach = [];
      for (let ll = lo; ll < hi; ll++) if (Math.abs(yc[ll] - yc[l]) < REACH) reach.push([ll, yc[ll] - yc[l]]);
      for (let col = 0; col < nxz; col++) {
        const k = l * nxz + col;
        if (!flow.open[k] || !isTunnel(k)) continue;
        const i = col % nx, j = Math.floor(col / nx), v0 = flow.speed[k];
        for (const [ll, dy] of reach) {
          for (let dj = -r; dj <= r; dj++) {
            const jj = j + dj;
            if (jj < 0 || jj >= nz) continue;
            for (let di = -r; di <= r; di++) {
              const ii = i + di;
              if (ii < 0 || ii >= nx) continue;
              const v = v0 * (1 - Math.hypot(di * c, dj * c, dy) / REACH);
              const q = (ll - lo) * nxz + jj * nx + ii;
              if (v > cool[q]) cool[q] = v;
            }
          }
        }
      }
    }
    return cool;
  };

  const tunnels = {
    id: ++serial, // tells one set of tunnels from another (voxel versions restart with each)
    vox,
    builtOn: form.version, // the form version the voxels were built from: if the form changes, the tunnels are built afresh
    bandCount, // how many pairs of floors the mass has
    storeys: bandCount * BAND_STOREYS, // how many storeys that is
    level: { offset: yc[level], half: dz[level] / 2 }, // where the tunnels of a storey are: the height of their axis above the storey's floor, and half their depth
    usable, // the bands that get tunnels: the ones with a whole storey of mass in them
    get active() { return active; },
    get carved() { return sum("carved", bands.map((_, b) => b)); }, // voxels of the mass that are air now
    get share() { return sum("mass") ? sum("carved") / sum("mass") : 0; }, // the part of the active bands' mass that is carved away
    bandShare: (b) => (bands[b].mass ? bands[b].carved / bands[b].mass : 0),
    // Has band b finished (its shape chosen) for what `key` stands for (the volume limit it was worked with)? Set by markDone().
    isDone: (b, key) => bands[b].doneKey === key,
    markDone(b, key) { bands[b].doneKey = key; },

    // The airflow of every band in one result { open, speed } (each band's voxels from its own solution, the rest from the first
    // that there is), or null if nothing is solved. A new object whenever any of them has changed.
    get flow() {
      const have = bands.filter((s) => s.flow);
      if (!have.length) return null;
      const key = bands.map((s) => s.flowVersion).join(",");
      if (merged && mergedKey === key) return merged;
      const open = Uint8Array.from(have[0].flow.open), speed = Float32Array.from(have[0].flow.speed);
      bands.forEach((s, b) => {
        if (!s.flow) return;
        const [lo, hi] = layers(b);
        open.set(s.flow.open.subarray(lo * nxz, hi * nxz), lo * nxz);
        speed.set(s.flow.speed.subarray(lo * nxz, hi * nxz), lo * nxz);
      });
      mergedKey = key;
      return (merged = { open, speed });
    },

    // The tunnels of shape p in band b for the wind dir, as they are drawn: each { dir, s, mid, o, ta, tb, y, half, edges(q) }: its axis runs from
    // ta to tb along the wind (the mass's windward and leeward faces, to a few cm), at the height y (the middle of the layer they are cut in, which
    // is 2 * half deep); edges(q) gives the same for the line q across from the axis ([in, out] or null). Independent of what is carved.
    layout(b, dir, p) {
      const out = [];
      // A piece of a lane as a tunnel to draw: `shift(dq)` is the same lane moved dq metres across the wind (null if there is none there).
      const makeLane = (run, full, pc, laneId, pathLen) => {
        const capStart = !!pc.capStart, capEnd = !!pc.capEnd;
        return { ...run, type: "lane", laneId, joinTo: run.joinTo ?? -1, pathLen, s0: pc.s0 ?? 0, capStart, capEnd,
          ta: capStart ? pc.t0 : full[0], tb: capEnd ? pc.t1 : full[1], tStart: capStart ? pc.t0 : full[0], tEnd: capEnd ? pc.t1 : full[1],
          uTa: full[0], uL: full[1] - full[0], y: yc[run.mid], half: dz[run.mid] / 2, edges: (q) => edges(run, q),
          shift: (dq) => { // (a lane round an occupied space is not moved over)
            if (obstacles.length) return null;
            const moved = { ...run, o: run.o + dq }, f = edges(moved, 0);
            return f && f[1] - f[0] >= MIN_RUN ? makeLane(moved, f, { t0: moved.t0, t1: moved.t1 }, laneId, f[1] - f[0]) : null;
          },
          inside: (t, q) => massAt(run.mid, run.dir[0] * t - run.dir[1] * (run.o + q), run.dir[1] * t + run.dir[0] * (run.o + q)) };
      };
      runsOf(b, dir, p).forEach((run, laneId) => {
        const full = edges(run, 0);
        if (!full || full[1] - full[0] < MIN_RUN) return;
        const pathLen = run.pathLen ?? full[1] - full[0];
        for (const pc of run.pieces ?? [{ type: "lane", t0: run.t0, t1: run.t1 }]) {
          if (pc.type === "strand") out.push({ type: "strand", laneId, joinTo: run.joinTo ?? -1, pts: pc.pts, rad: pc.rad, len: pc.len, s0: pc.s0, pathLen, mid: run.mid, s: run.s });
          else out.push(makeLane(run, full, pc, laneId, pathLen));
        }
      });
      return out;
    },
    // Is this voxel air that the mass once held (part of a tunnel)?
    carvedAt: isTunnel,

    // The mass as placed again.
    reset() {
      cells.set(placed);
      vox.version++;
      for (const s of bands) Object.assign(s, fresh);
      merged = null;
      mergedKey = "";
    },

    // The occupied spaces the tunnels keep out of: a list of spheres { x, y, z, r } in world metres. Call before setActive (which starts the tunnels again).
    setObstacles(list) {
      obstacles = list.map((s) => ({ x: s.x, y: s.y, z: s.z, r: s.r }));
      obstaclesKey = obstacles.map((s) => `${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)},${s.r.toFixed(2)}`).join(";");
    },
    get obstaclesKey() { return obstaclesKey; },

    // Chooses the bands to work on (a list of band numbers, 0 = floors 1 and 2) and puts the mass back as placed.
    setActive(list) {
      tunnels.reset();
      active = list.filter((b) => usable.includes(b));
    },

    // What the search for band b's shape is doing: { tried, rough, chosen, shape }: rough is true once a first, quick answer is in
    // (the shape is still being refined), chosen once it is settled.
    // `token` is a new object whenever the search starts again, so that a shape found by an earlier search can be told from this one's.
    shapeInfo: (b) => ({ tried: bands[b].search?.tried ?? 0, rough: bands[b].rough, chosen: bands[b].chosen !== null, shape: bands[b].chosen ?? bands[b].search?.best ?? null, token: bands[b].search }),
    // Has band b a first, quick answer (the end of the coarse search)?
    isRough: (b) => bands[b].rough,

    // One step of the search for band b's shape, for the wind dir = [ux, uz]: voxelises the next shape to try, solves the airflow
    // and scores the cooling. `limit` is the most of the band's mass the tunnels may carve away (0..1).
    // The search is in two parts. First a coarse one: a small grid of shapes (COARSE_GRID), each solved quickly and loosely (COARSE_SOLVE),
    // which gives a rough answer fast; when it is done the best of them is solved properly and the step says 'rough'. Then the
    // fine one, from that shape: the numbers are varied one at a time (SHAPES), each shape solved properly, until nothing improves;
    // the step then says 'settled'. Every other step says null. A shape that carves more than the limit is not solved at all.
    async searchStep(b, dir, limit) {
      const s = bands[b];
      const q = (s.search ??= { phase: "coarse", queue: coarseShapes(), seen: new Set(), best: null, bestScore: -Infinity, tried: 0, pass: 0, improved: false });
      const key = (p) => JSON.stringify(p);
      const rate = (share) => { // the score of the shape as it is cut now (its airflow solved)
        if (share > limit) return -share; // over the volume limit it is no good, and the less over the better
        const cool = tunnels.cooling(b);
        return cool.mean * (0.5 + 0.5 * cool.evenness);
      };
      const p = q.queue.shift();
      q.seen.add(key(p));
      shapeBand(b, dir, p);
      const share = tunnels.bandShare(b);
      if (share <= limit) await tunnels.solve(b, dir, q.phase === "coarse" ? COARSE_SOLVE : {});
      const score = rate(share);
      q.tried++;
      if (score > q.bestScore + 1e-6) { q.best = p; q.bestScore = score; q.improved = true; }
      if (q.queue.length) return null;
      const neighbours = () => {
        const out = [];
        for (const name of Object.keys(SHAPES)) {
          for (const v of SHAPES[name]) {
            const next = { ...q.best, [name]: v };
            if (!q.seen.has(key(next))) out.push(next);
          }
        }
        return out;
      };
      if (q.phase === "coarse") { // the quick answer: the best shape, solved properly, and the fine search starts from it
        shapeBand(b, dir, q.best);
        await tunnels.solve(b, dir);
        q.bestScore = rate(tunnels.bandShare(b));
        q.phase = "refine";
        q.seen = new Set([key(q.best)]); // the coarse scores were rough: the shapes round it are scored again properly
        q.pass = 1;
        q.improved = false;
        q.queue = neighbours();
        s.rough = true;
        return "rough";
      }
      if (q.improved && q.pass < MAX_PASSES) { // vary the numbers of the best shape one at a time
        q.pass++;
        q.improved = false;
        q.queue = neighbours();
        if (q.queue.length) return null;
      }
      shapeBand(b, dir, q.best); // done: the best shape, solved so that what is shown is for it
      await tunnels.solve(b, dir);
      s.chosen = q.best;
      return "settled";
    },
    // The air speed in band b's tunnels in its last solution: { max, mean } relative to the open wind (0 if there is none).
    tunnelSpeed(b) {
      const flow = bands[b].flow, [lo, hi] = layers(b);
      let max = 0, total = 0, n = 0;
      if (flow) {
        for (let k = lo * nxz; k < hi * nxz; k++) {
          if (!flow.open[k] || !isTunnel(k)) continue;
          max = Math.max(max, flow.speed[k]); total += flow.speed[k]; n++;
        }
      }
      return { max, mean: n ? total / n : 0 };
    },

    // The cooling at every voxel of band b (see coolField): { lo, hi, cool } with cool[(layer - lo) * nx * nz + column], or null if there is no
    // solution. Kept until the voxels or the solution change.
    coolingMapKey: (b) => bands[b].flowVersion + "|" + vox.version, // changes whenever coolingMap(b) does
    coolingMap(b) {
      const s = bands[b];
      if (!s.flow) return null;
      const key = s.flowVersion + "|" + vox.version;
      if (s.mapKey !== key) { s.mapKey = key; s.map = { lo: layers(b)[0], hi: layers(b)[1], cool: coolField(b) }; }
      return s.map;
    },

    // How well band b's floors are cooled, read from its last solution. Every mass voxel of the band that is still solid gets the
    // strongest cooling of any tunnel air within REACH metres: that air's speed (x the open wind), fading to nothing at REACH.
    // Returns { coverage: [per storey], mean, evenness }: coverage is the part of the storey's solid voxels where that is at
    // least NEAR (the floor is near moving air), mean is the average cooling (capped at 1.5), and evenness is the weaker
    // storey's coverage over the stronger's (1 = both floors cooled alike). All 0 if there is nothing yet.
    cooling(b) {
      const flow = bands[b].flow, out = { coverage: new Array(BAND_STOREYS).fill(0), avg: new Array(BAND_STOREYS).fill(0), mean: 0, evenness: 0 };
      if (!flow) return out;
      const [lo, hi] = layers(b), cool = coolField(b);
      const total = new Array(BAND_STOREYS).fill(0), near = new Array(BAND_STOREYS).fill(0), sum1 = new Array(BAND_STOREYS).fill(0);
      let acc = 0, count = 0;
      for (let l = lo; l < hi; l++) {
        const s = Math.min(BAND_STOREYS - 1, Math.floor((l - lo) / perStorey));
        for (let col = 0; col < nxz; col++) {
          const k = l * nxz + col;
          if (placed[k] !== MASS || cells[k] !== MASS) continue;
          const v = cool[(l - lo) * nxz + col], w = dz[l]; // a voxel counts for its height, as the layers are not all alike
          total[s] += w;
          if (v >= NEAR) near[s] += w;
          acc += Math.min(v, 1.5) * w;
          sum1[s] += Math.min(v, 1) * w;
          count += w;
        }
      }
      out.coverage = total.map((t, s) => (t ? near[s] / t : 0));
      out.avg = total.map((t, s) => (t ? sum1[s] / t : 0)); // the average cooling of the storey, 1 = as much as beside a tunnel carrying the open wind
      out.mean = count ? acc / count : 0;
      const used = out.coverage.filter((_, s) => total[s]);
      out.evenness = used.length && Math.max(...used) > 0 ? Math.min(...used) / Math.max(...used) : 0;
      return out;
    },

    // Is band b's stored solution out of date for the wind direction dir = [ux, uz]?
    stale(b, dir) {
      const s = bands[b];
      return !s.flow || s.flowVersion !== vox.version || s.flowDir[0] !== dir[0] || s.flowDir[1] !== dir[1];
    },

    // Solves the airflow for band b's wind and the voxels as they are now (a solveFlow() result), starting from its last solution.
    async solve(b, dir, options = {}) {
      const s = bands[b], version = vox.version;
      const result = await solveFlow(vox, { dir, previous: s.flow, ...options });
      s.flow = result;
      s.flowVersion = version; // if a voxel was opened while this ran, the version has moved on and the result counts as stale
      s.flowDir = dir;
      return result;
    },
  };
  return tunnels;
}





