// MODEL (exterior erosion): the wind tunnels' state. No scene or DOM code.
//
// The voxel mass (voxelFlow.js) is built once from the form and then kept: tunnels are voxels of the mass switched to air, and
// the airflow is solved on them (potential flow: it shows where the air is squeezed and speeds up, not turbulence or friction).
//
// Floors: the mass is cut into storeys of STOREY metres (14 ft), and the storeys are grouped in pairs, the BANDS (floors 1-2,
// floors 3-4, ...). The tunnels of a band never leave it, so they span two storeys at most. One layer of voxels at the bottom of
// every storey is a few thick layers (the rooms) and, on top, one thin layer ZONE metres deep: the ceiling void. Tunnels are only
// cut in the ceiling voids, so the rooms and the way through them are never touched. The top layer of every column is left as
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
export const ZONE = 0.9; // metres: the depth of the ceiling void at the top of every storey, the only place a tunnel may run
export const REACH = 3; // metres: how far from a tunnel its moving air is taken to cool the floor
const NEAR = 0.3; // cooling (see cooling()) at which a floor voxel counts as near moving air: about 2 m from air at the open wind's speed
const MIN_RUN = 4; // metres: a tunnel shorter than this (a corner of the mass) is not made

// The numbers the solver chooses from.
export const SHAPES = {
  spacing: [6, 8, 10, 12, 14], // metres between tunnels in one storey
  throat: [1.4, 2.1, 2.8, 3.6, 4.5], // metres: the width at the narrowest point (rounded up to a whole voxel at least)
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
export function tunnelWidth(p, u) {
  return p.throat * (u < p.pos ? 1 + (p.mouth - 1) * ease(1 - u / p.pos) : 1 + (p.exit - 1) * ease((u - p.pos) / (1 - p.pos)));
}

// form: the shared form (form.js), as it is now. cityHeight: (x, z) => metres, the site's buildings (windFlow.js cityHeights).
// Returns null if the form has no mass.
let serial = 0;
export function createTunnels(form, { cityHeight = null } = {}) {
  const vox = createVoxelMass(form, { cityHeight, maxCells: 400000, storey: STOREY, zone: ZONE });
  if (!vox) return null;
  const { nx, nz, ny, c, cells, dz, yc } = vox;
  const nxz = nx * nz;
  const perStorey = vox.perStorey; // voxel layers in one storey; the last of them is the ceiling void (the zone)
  const perBand = perStorey * BAND_STOREYS;
  const placed = Uint8Array.from(cells); // the mass as it was placed, to put it back
  const roof = new Int16Array(nxz).fill(-1); // the layer of the top mass voxel in every column (-1 where there is none)
  for (let k = 0; k < placed.length; k++) if (placed[k] === MASS) roof[k % nxz] = Math.floor(k / nxz);
  const bandCount = Math.max(1, Math.ceil(vox.top / (STOREY * BAND_STOREYS)));
  const layers = (b) => [b * perBand, Math.min(ny, (b + 1) * perBand)]; // the voxel layers of a band: from, up to (not including)
  const bandOf = (k) => Math.min(bandCount - 1, Math.floor(Math.floor(k / nxz) / perBand));

  // What each band has: its mass voxels, how many are carved, its own airflow and the search for its shape.
  const fresh = { carved: 0, doneKey: "", flow: null, flowVersion: -1, flowDir: null, search: null, chosen: null, rough: false };
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

  // Opens a voxel of the mass. Says whether it changed (context buildings and air cannot be carved).
  const carve = (k) => {
    if (placed[k] !== MASS || cells[k] !== MASS) return false;
    const layer = Math.floor(k / nxz);
    if (layer % perStorey !== perStorey - 1 || layer >= roof[k % nxz]) return false; // only a ceiling void is opened, and never the top layer of a column (the roof)
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
  // ceiling void they lie in, s the storey of the band, o how far across the wind and t0..t1 from the windward face to the leeward one
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
      const mid = lo + s * perStorey + perStorey - 1; // the storey's ceiling void: the one layer its tunnels are cut in, and where the runs through the mass are found
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
        for (const [t0, t1] of runs) if (t1 - t0 >= MIN_RUN) out.push({ mid, s, o, t0, t1, dir });
      }
    }
    return out;
  };

  // Cuts the tunnels of shape p in band b (after clearing it), along the wind dir = [ux, uz]. Says how many voxels it opened.
  const shapeBand = (b, dir, p) => {
    clearBand(b);
    const [d0, d1] = dir, p0 = -d1, p1 = d0;
    let opened = 0;
    for (const { mid, o, t0, t1 } of runsOf(b, dir, p)) {
      for (let t = t0; t <= t1; t += c / 2) {
        const w = Math.max(tunnelWidth(p, (t - t0) / (t1 - t0)), c) / 2; // the half width here; never under a voxel
        for (let q = -w; q <= w + 1e-6; q += c / 2) {
          const i = Math.floor((d0 * t + p0 * (o + q) - vox.x0) / c), j = Math.floor((d1 * t + p1 * (o + q) - vox.z0) / c);
          if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
          if (carve(vox.index(i, j, mid))) opened++;
        }
      }
    }
    return opened;
  };

  // Is there mass at (x, z) in the ceiling void of layer mid, with a roof still above it? (From the form's height map, which is finer than the voxels.)
  const massAt = (mid, x, z) => form.heightAt(x, z) >= vox.ye[mid + 1] + 0.3;
  // Where the mass starts and ends along the line (t, q) of a run, found to a few centimetres: [in, out] along the wind, or null.
  const edges = (run, q) => {
    const [d0, d1] = run.dir, p0 = -d1, p1 = d0;
    const inside = (t) => massAt(run.mid, d0 * t + p0 * (run.o + q), d1 * t + p1 * (run.o + q));
    const from = run.t0 - 2 * c, to = run.t1 + 2 * c, step = 0.15;
    let a = null, z = null;
    for (let t = from; t <= to; t += step) if (inside(t)) { a = t; break; }
    if (a === null) return null;
    for (let t = to; t >= a; t -= step) if (inside(t)) { z = t; break; }
    const bisect = (out, inn) => { for (let i = 0; i < 8; i++) { const m = (out + inn) / 2; if (inside(m)) inn = m; else out = m; } return inn; };
    return [a > from ? bisect(a - step, a) : a, z < to ? bisect(z + step, z) : z];
  };

  const tunnels = {
    id: ++serial, // tells one set of tunnels from another (voxel versions restart with each)
    vox,
    builtOn: form.version, // the form version the voxels were built from: if the form changes, the tunnels are built afresh
    bandCount, // how many pairs of floors the mass has
    storeys: bandCount * BAND_STOREYS, // how many storeys that is
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
    // ta to tb along the wind (the mass's windward and leeward faces, to a few cm), at the height y (the middle of the ceiling void, which
    // is 2 * half deep); edges(q) gives the same for the line q across from the axis ([in, out] or null). Independent of what is carved.
    layout(b, dir, p) {
      const out = [];
      for (const run of runsOf(b, dir, p)) {
        const e = edges(run, 0);
        if (e && e[1] - e[0] >= MIN_RUN) out.push({ ...run, ta: e[0], tb: e[1], y: yc[run.mid], half: dz[run.mid] / 2, edges: (q) => edges(run, q), inside: (t, q) => massAt(run.mid, run.dir[0] * t - run.dir[1] * (run.o + q), run.dir[1] * t + run.dir[0] * (run.o + q)) });
      }
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

    // How well band b's floors are cooled, read from its last solution. Every mass voxel of the band that is still solid gets the
    // strongest cooling of any tunnel air within REACH metres: that air's speed (x the open wind), fading to nothing at REACH.
    // Returns { coverage: [per storey], mean, evenness }: coverage is the part of the storey's solid voxels where that is at
    // least NEAR (the floor is near moving air), mean is the average cooling (capped at 1.5), and evenness is the weaker
    // storey's coverage over the stronger's (1 = both floors cooled alike). All 0 if there is nothing yet.
    cooling(b) {
      const flow = bands[b].flow, out = { coverage: new Array(BAND_STOREYS).fill(0), mean: 0, evenness: 0 };
      if (!flow) return out;
      const [lo, hi] = layers(b), r = Math.ceil(REACH / c);
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
      const total = new Array(BAND_STOREYS).fill(0), near = new Array(BAND_STOREYS).fill(0);
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
          count += w;
        }
      }
      out.coverage = total.map((t, s) => (t ? near[s] / t : 0));
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





