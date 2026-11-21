// MODEL (circulation): the hallways and the vertical cores people walk through, planned in the spaces the finished wind tunnels leave. Pure logic:
// no scene or DOM code, and it only READS the tunnels (a plain snapshot, see site below), so it cannot change them.
//
// What it works from (`site`, all in world metres, x = east, y = up, z = south):
//   storey, storeys   the storey height and how many there are
//   frame             { A, B }: the axes the tunnels' ducts are drawn in (unit vectors in x, z). The hallways run along the same two axes.
//   heightAt(x, z)    how high the mass is at a point (0 where there is none)
//   tubes             [{ ax, ay, az, bx, by, bz, r }]: the tunnels' tubes (a capsule each)
//   spaces            [{ x, y, z, r }]: the occupied spaces (spheres)
//   box               { x0, x1, z0, z1, top }: where the mass is
//   streets           [[x0, z0, x1, z1]]: the roads and paths round the site (where the entrance faces)
//
// How it works:
//  1. Every storey is a grid of small cells laid along the axes. A cell is BLOCKED if it is outside the mass (or too near its wall), or if a tunnel
//     or an occupied space is in the way of a person. The tunnels sit at mid-storey, so they take the headroom: a hallway can only run in the plan
//     gaps between them, never over or under one. (The ducts run wall to wall, so a floor falls into strips, joined only by stairs.)
//  2. A hallway is a strip of width (2K+1) cells. Its centreline may only pass through cells whose Chebyshev distance to a blocked cell is more than K,
//     so the whole strip is clear. Centrelines live on a lattice (every second cell), and are routed rectilinearly, with a cost for every turn.
//  3. An entrance is on the ground floor, on a wall (nearest a street), reached by a straight run from the hallways.
//  4. Vertical circulation is made of LINKS: a long, narrow rectangle (a stair, and a lift if asked for) that is clear of tunnels through the whole
//     storey below and in the headroom of the storey above, so it joins two neighbouring floors. It fits in the strips between the trunks, either
//     way round. Links are picked one at a time by how much more floor they bring within reach, starting from an entrance; links at the same place on
//     floors above one another stack into one full-height core. Where the tunnels leave several separate groups, further entrances are added; and
//     where a group has no way down to the ground at all, its hallways and stairs are still planned, and shown apart (grey) and reported.
//  5. On every floor the hallways grow from the links' doors (and the entrances): the floor cell farthest from any hallway (walking) is joined to the
//     network by the cheapest rectilinear route, until all of the floor is within `serve` metres of a hallway. A few straight shortcuts make loops.
//  6. What is reachable from an entrance (through the links) is counted, and what is not is reported.
import { rerouteGraph } from "./reroute.js";

const SQRT2 = Math.SQRT2;

export const DEFAULTS = {
  mode: "scattered", // "scattered": stairs wherever the gaps between the tunnels allow; "main": two stair cores and a lift core, each one continuous line from the
  //                    ground to the top, that move the tunnels a little to go round them (see reroute.js), with a few supplemental stairs where needed
  width: 2.0, // m: the hallways' width (rounded to a whole odd number of cells)
  serve: 10, // m: every floor cell should be within this walk of a hallway
  cores: 0, // stairs-and-lifts at the most between two floors: 0 = as many as help (up to MAX_CORES)
  loops: 3, // shortcuts (loops) the most that are made on a floor
  coreLong: 5.2, // m: the long side of a stair (two flights, back to back, with a landing at each end)
  coreShort: 2.8, // m: the short side (two flights side by side)
  lift: false, // a lift at one end of the stair (makes the link 2.4 m longer, so it fits in fewer places)
  extraCores: 0, // "main" mode: more full-height stair cores (which move the tunnels like the first ones), each where the most cut-off hallway is; kept only if it helps
  fill: true, // hallways in every part of the floors that has room for them: more stairs where they can join a part to the rest, and hallways of their own
  //             (drawn grey) in the parts no stair can reach; the walk to a hallway is then at most FILL_REACH
  head: 2.4, // m: the headroom a hallway needs
  cell: 0.4, // m: the grid
};
const TUBE_MARGIN = 0.2; // m: kept between a hallway and a tunnel's wall
const WALL = 0.5; // m: kept between a hallway and the mass's outside wall
const ROOF_GAP = 0.3; // m: a floor needs this much over its headroom
const TURN = 5; // the cost of a turn, in lattice steps
const MAX_CELLS = 160000; // cells in a floor's grid at the most (the grid is made coarser above that)
const MAX_CORES = 4; // the most the panel lets you ask for between two floors
const AUTO_CORES = 6; // ...and the most that "auto" may make (it stops sooner when more stairs bring little)
const MIN_FLOOR = 40; // m2: a floor with less mass than this gets no hallways
const MIN_GAIN = 0.04; // a link must bring at least this part of the smaller of its two floors within reach
const GROW_REACH = 2.5; // the walk is followed this many times as far as the reach asked for, while the hallways grow
const DOOR_ZONE = 5; // m: how near the wall a door may squeeze through a gap narrower than a hallway
const FILL_REACH = 4; // m: with `fill`, the walk to a hallway is at most this (or the reach asked for, if less)
const FILL_PIECE = 3; // a piece of a floor needs at least this many lattice nodes of room (a run of 2.4 m or more) to get hallways of its own
const MIN_GAIN_FILL = 0.004; // with `fill`, a stair need only bring this part of the smaller of its two floors within reach
const FILL_STAIRS = 6; // ...and at most this many (at least) between two floors
const MAX_ROOTS = 8; // entrances, and starts of pieces with no way down, at the most
const MIN_ROOT = 0.02; // another root must bring at least this part of all the floor within reach
const MAIN_STAIR = [6.0, 3.2]; // m: a main stair core (long side along one axis, short along the other)
const MAIN_LIFT = 3.2; // m: the side of the lift core
const NARROW_STAIR = [7.2, 1.6]; // m: a straight single-flight stair (long side, short side), used with `fill` where the two-flight stair does not fit
const AUTO_SUPP = 2; // supplemental stairs between two floors at the most, in "main" mode with "auto"
const MIN_GAIN_SUPP = 0.08; // ...and each must bring at least this part of the smaller of its two floors within reach
const STACK_BONUS = 1.6; // a link above or below another at the same place is worth this much more (they make one core)

class Heap { // a binary min-heap of numbers with priorities
  constructor() { this.p = []; this.v = []; this.top = 0; }
  get size() { return this.v.length; }
  push(pri, val) {
    const { p, v } = this;
    let i = v.length;
    p.push(pri); v.push(val);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (p[up] <= pri) break;
      p[i] = p[up]; v[i] = v[up]; i = up;
    }
    p[i] = pri; v[i] = val;
  }
  pop() { // returns the value; this.top is its priority
    const { p, v } = this;
    const val = v[0];
    this.top = p[0];
    const lp = p.pop(), lv = v.pop(), n = v.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && p[c + 1] < p[c]) c++;
        if (p[c] >= lp) break;
        p[i] = p[c]; v[i] = v[c]; i = c;
      }
      p[i] = lp; v[i] = lv;
    }
    return val;
  }
}

// The distance in cells (Chebyshev: a diagonal step counts one) from every cell to the nearest cell where `target` is 1. Capped at 255.
function chebyshev(target, na, nb) {
  const INF = 255, d = new Uint8Array(na * nb);
  for (let k = 0; k < d.length; k++) d[k] = target[k] ? 0 : INF;
  for (let j = 0; j < nb; j++) {
    for (let i = 0; i < na; i++) {
      const k = j * na + i;
      let v = d[k];
      if (v === 0) continue;
      if (i > 0 && d[k - 1] + 1 < v) v = d[k - 1] + 1;
      if (j > 0) {
        if (d[k - na] + 1 < v) v = d[k - na] + 1;
        if (i > 0 && d[k - na - 1] + 1 < v) v = d[k - na - 1] + 1;
        if (i < na - 1 && d[k - na + 1] + 1 < v) v = d[k - na + 1] + 1;
      }
      d[k] = Math.min(v, INF);
    }
  }
  for (let j = nb - 1; j >= 0; j--) {
    for (let i = na - 1; i >= 0; i--) {
      const k = j * na + i;
      let v = d[k];
      if (v === 0) continue;
      if (i < na - 1 && d[k + 1] + 1 < v) v = d[k + 1] + 1;
      if (j < nb - 1) {
        if (d[k + na] + 1 < v) v = d[k + na] + 1;
        if (i < na - 1 && d[k + na + 1] + 1 < v) v = d[k + na + 1] + 1;
        if (i > 0 && d[k + na - 1] + 1 < v) v = d[k + na - 1] + 1;
      }
      d[k] = Math.min(v, INF);
    }
  }
  return d;
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function planCirculation(site, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const t0 = performance.now(), timings = [];
  const mark = (label) => timings.push([label, Math.round(performance.now() - t0)]);
  const storey = site.storey, S = site.storeys;
  const A = site.frame?.A ?? [1, 0], B = site.frame?.B ?? [-A[1], A[0]];
  const aOf = (x, z) => x * A[0] + z * A[1], bOf = (x, z) => x * B[0] + z * B[1];
  const warnings = [...(o.carried ?? [])]; // (what an earlier pass of the main-core planning has to say)

  // ---- the grid, along the axes ----
  let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
  const bx = site.box;
  for (const [x, z] of [[bx.x0, bx.z0], [bx.x1, bx.z0], [bx.x0, bx.z1], [bx.x1, bx.z1]]) {
    amin = Math.min(amin, aOf(x, z)); amax = Math.max(amax, aOf(x, z));
    bmin = Math.min(bmin, bOf(x, z)); bmax = Math.max(bmax, bOf(x, z));
  }
  const PAD = 1, spanA = amax - amin + 2 * PAD, spanB = bmax - bmin + 2 * PAD;
  let g = o.cell;
  while ((spanA / g) * (spanB / g) > MAX_CELLS) g *= 1.1;
  const na = Math.ceil(spanA / g), nb = Math.ceil(spanB / g), n = na * nb, a0 = amin - PAD, b0 = bmin - PAD;
  const K = Math.max(1, Math.round((o.width / g - 1) / 2)), width = (2 * K + 1) * g, need = K + 1; // a strip is 2K+1 cells; a centreline needs more than K clear
  const serveCells = (o.fill ? Math.min(o.serve, FILL_REACH) : o.serve) / g;
  const ma = Math.ceil(na / 2), mb = Math.ceil(nb / 2), m = ma * mb; // the lattice: every second cell each way
  const nodeCell = (id) => { const p = id % ma; return 2 * ((id - p) / ma) * na + 2 * p; };
  const wx = new Float32Array(n), wz = new Float32Array(n);
  for (let j = 0; j < nb; j++) {
    for (let i = 0; i < na; i++) {
      const a = a0 + (i + 0.5) * g, b = b0 + (j + 0.5) * g, k = j * na + i;
      wx[k] = a * A[0] + b * B[0]; wz[k] = a * A[1] + b * B[1];
    }
  }
  const gridOut = { a0, b0, g, na, nb, A, B, K, width };

  // ---- what is in the way ----
  // the tunnels as a graph (nodes, and edges between them by index): the one given, or, from a plain list of tubes, loose tubes
  const graph = site.graph ?? (() => {
    const nodes = [], edges = [];
    for (const t of site.tubes ?? []) {
      nodes.push({ x: t.ax, y: t.ay, z: t.az, wall: false }, { x: t.bx, y: t.by, z: t.bz, wall: false });
      edges.push({ a: nodes.length - 2, b: nodes.length - 1, r: t.r });
    }
    return { nodes, edges };
  })();
  const tubes = graph.edges.filter((e) => e.r > 0).map((e) => {
    const p = graph.nodes[e.a], q = graph.nodes[e.b];
    return { pa: [aOf(p.x, p.z), bOf(p.x, p.z)], pb: [aOf(q.x, q.z), bOf(q.x, q.z)], ymin: Math.min(p.y, q.y) - e.r, ymax: Math.max(p.y, q.y) + e.r, r: e.r };
  });
  const spaces = (site.spaces ?? []).map((s) => ({ a: aOf(s.x, s.z), b: bOf(s.x, s.z), y: s.y, r: s.r }));
  const inflate = TUBE_MARGIN + g * 0.71; // (so that the blocked squares cover the true shape)
  const stampCapsule = (mask, pa, pb, rr) => {
    const i0 = Math.max(0, Math.floor((Math.min(pa[0], pb[0]) - rr - a0) / g)), i1 = Math.min(na - 1, Math.floor((Math.max(pa[0], pb[0]) + rr - a0) / g));
    const j0 = Math.max(0, Math.floor((Math.min(pa[1], pb[1]) - rr - b0) / g)), j1 = Math.min(nb - 1, Math.floor((Math.max(pa[1], pb[1]) + rr - b0) / g));
    const sx = pb[0] - pa[0], sy = pb[1] - pa[1], l2 = sx * sx + sy * sy;
    for (let j = j0; j <= j1; j++) {
      const cb = b0 + (j + 0.5) * g;
      for (let i = i0; i <= i1; i++) {
        const ca = a0 + (i + 0.5) * g;
        const u = l2 > 0 ? Math.max(0, Math.min(1, ((ca - pa[0]) * sx + (cb - pa[1]) * sy) / l2)) : 0;
        const dx = ca - (pa[0] + sx * u), dy = cb - (pa[1] + sy * u);
        if (dx * dx + dy * dy < rr * rr) mask[j * na + i] = 1;
      }
    }
  };
  // marks the cells blocked for a person (or a shaft) occupying the heights lo to hi
  const stampObstacles = (mask, lo, hi, which = "all") => { // which: "all", "tubes" or "spaces"
    if (which !== "spaces") for (const t of tubes) if (t.ymax > lo && t.ymin < hi) stampCapsule(mask, t.pa, t.pb, t.r + inflate);
    if (which !== "tubes") for (const sp of spaces) {
      const dy = sp.y < lo ? lo - sp.y : sp.y > hi ? sp.y - hi : 0;
      if (dy >= sp.r) continue;
      stampCapsule(mask, [sp.a, sp.b], [sp.a, sp.b], Math.sqrt(sp.r * sp.r - dy * dy) + inflate);
    }
  };

  // ---- one grid per storey ----
  const wallN = Math.ceil(WALL / g);
  const floors = [];
  for (let s = 0; s < S; s++) {
    const y0 = s * storey, yTop = y0 + o.head + ROOF_GAP;
    const outside = new Uint8Array(n);
    let any = 0;
    for (let k = 0; k < n; k++) { if (site.heightAt(wx[k], wz[k]) >= yTop) any++; else outside[k] = 1; }
    if (any * g * g < MIN_FLOOR) { floors.push(null); continue; }
    const dOut = chebyshev(outside, na, nb);
    const wall = new Uint8Array(n);
    for (let k = 0; k < n; k++) wall[k] = dOut[k] <= wallN ? 1 : 0; // (the outside, and the strip along it)
    const ts = new Uint8Array(n), tsFull = new Uint8Array(n);
    stampObstacles(ts, y0, y0 + o.head);
    stampObstacles(tsFull, y0, y0 + storey);
    const blocked = new Uint8Array(n), blockedFull = new Uint8Array(n), walk = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      blocked[k] = ts[k] | wall[k];
      blockedFull[k] = tsFull[k] | wall[k];
      walk[k] = outside[k] || ts[k] ? 0 : 1;
    }
    floors.push({ s, y0, outside, ts, blocked, blockedFull, walk, core: new Uint8Array(n) });
  }
  let usable = 0; // the storeys from the ground up that have a floor
  while (usable < S && floors[usable]) usable++;
  if (!floors[0]) {
    warnings.push("There is no ground floor to plan hallways on.");
    return { grid: gridOut, storey, storeys: S, head: o.head, floors: [], cores: [], entrances: [], entrance: null, diag: [], stats: { length: 0, reachableLength: 0, links: 0, cores: 0, entrances: 0, floorsServed: 0, usable: 0 }, warnings, timings };
  }
  if (usable < S) warnings.push(`Only the lowest ${usable} of ${S} storeys have room for a floor; the hallways stop there.`);
  mark("floors");

  const streets = (site.streets ?? []).filter((sg) => {
    const cx = (sg[0] + sg[2]) / 2, cz = (sg[1] + sg[3]) / 2;
    return cx > bx.x0 - 200 && cx < bx.x1 + 200 && cz > bx.z0 - 200 && cz < bx.z1 + 200;
  });
  const streetDistance = (x, z) => {
    let best = Infinity;
    for (const [x0, z0, x1, z1] of streets) {
      const sx = x1 - x0, sz = z1 - z0, l2 = sx * sx + sz * sz;
      const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - x0) * sx + (z - z0) * sz) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - (x0 + sx * u), z - (z0 + sz * u)));
    }
    return best;
  };

  // ---- the main cores (mode "main"): placed first, on the tunnels as they are, then the tunnels are moved a little to go round them, and everything is
  // planned again on the moved tunnels (the cores fixed). Two stair cores and a lift core, each one continuous line from the ground to the top. ----
  // A core whose ground-floor hallways have no way out to a wall would leave its whole stack (and every stair added from it) cut off from the outside. So
  // when the plan on the moved tunnels shows a core without an exit, that place is given up and the cores are placed again (a few times, and the plan with
  // the fewest cores without an exit is kept).
  if (o.mode === "main" && !o.fixedCores && usable >= 2) {
    const banned = [];
    let kept = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const placed = placeMainCores(banned);
      if (!placed.cores.length) { if (!kept) warnings.push(...placed.warnings); break; }
      const ringM = o.width + 0.4; // (room all round a core for a hallway to branch from)
      const boxes = placed.cores.map((c) => ({ a0: a0 + c.ci * g, a1: a0 + (c.ci + c.w) * g, b0: b0 + c.cj * g, b1: b0 + (c.cj + c.h) * g, ring: ringM }));
      const moved = rerouteGraph(graph, boxes, { A, B }, { margin: TUBE_MARGIN });
      const plan = planCirculation({ ...site, tubes: undefined, graph: moved }, { ...options, fixedCores: placed.cores, reroute: { moved: moved.moved, detoured: moved.detoured }, carried: [...warnings, ...placed.warnings] });
      const lacking = plan.mainNoExit ?? [];
      if (!kept || lacking.length < kept.lacking) kept = { plan, lacking: lacking.length, cores: placed.cores };
      if (!lacking.length) break;
      for (const i of lacking) banned.push(placed.cores[i]);
    }
    // Extra stair cores (a setting, 0 by default): the tunnels cut some of the hallways off from every exit, and no ordinary stair fits between them and the
    // rest. A core may move the tunnels, so an extra stair core goes where the most cut-off hallway is, and is kept only if it makes more hallway reachable.
    if (kept && o.extraCores > 0) {
      let cur = kept.plan, curCores = kept.cores;
      for (let e = 0; e < o.extraCores; e++) {
        const tried = [];
        let improved = false;
        for (let attempt = 0; attempt < 3 && !improved; attempt++) {
          const extra = placeMainCores(tried, { plan: cur, cores: curCores });
          if (!extra.cores.length) break;
          const cores2 = [...curCores, extra.cores[0]];
          const boxes = cores2.map((c) => ({ a0: a0 + c.ci * g, a1: a0 + (c.ci + c.w) * g, b0: b0 + c.cj * g, b1: b0 + (c.cj + c.h) * g, ring: o.width + 0.4 }));
          const moved = rerouteGraph(graph, boxes, { A, B }, { margin: TUBE_MARGIN });
          const plan2 = planCirculation({ ...site, tubes: undefined, graph: moved }, { ...options, fixedCores: cores2, reroute: { moved: moved.moved, detoured: moved.detoured }, carried: [...kept.plan.warnings.filter((w) => !/^Floor \d+: |hallways have no route|Only the lowest/.test(w))] });
          if (plan2.stats.reachableLength > cur.stats.reachableLength + 1 && !(plan2.mainNoExit ?? []).includes(cores2.length - 1)) { cur = plan2; curCores = cores2; improved = true; } else tried.push(extra.cores[0]);
        }
        if (!improved) break;
      }
      return cur;
    }
    if (kept) return kept.plan;
    warnings.push("No place was found for the main cores, so the scattered stairs are used instead.");
  }

  // Where the main cores go: the three rectangles (two stairs and a lift) that need the least tunnel moved, and are well placed. A core must be inside the
  // mass on every floor it passes (with a hallway's room all round, and clear of the facade and the occupied spaces); the tunnels need not be out of its way.
  function placeMainCores(banned = [], extra = null) { // (banned: places, as cores, that are not to be used again; extra: { plan, cores }, to place one more stair core)
    const res = { cores: [], warnings: [] };
    const isBanned = (c) => banned.some((p) => !(c.ci >= p.ci + p.w + 4 || p.ci >= c.ci + c.w + 4 || c.cj >= p.cj + p.h + 4 || p.cj >= c.cj + c.h + 4));
    const ringC = Math.ceil((o.width + 0.4) / g), extraWall = Math.ceil(2 / g);
    const oddC = (cells) => { let c = Math.max(3, Math.round(cells)); if (c % 2 === 0) c++; return c; };
    const W1 = na + 1;
    const makeSat = (arr) => {
      const t = new Int32Array(W1 * (nb + 1));
      for (let j = 0; j < nb; j++) for (let i = 0; i < na; i++) t[(j + 1) * W1 + i + 1] = arr[j * na + i] + t[j * W1 + i + 1] + t[(j + 1) * W1 + i] - t[j * W1 + i];
      return t;
    };
    const satRect = (t, i0, j0, w, h) => t[(j0 + h) * W1 + i0 + w] - t[j0 * W1 + i0 + w] - t[(j0 + h) * W1 + i0] + t[j0 * W1 + i0];
    // for the cores that reach floor k: what may not hold one (the facade, the spaces), and how much tube is in the way (the load), over the floors 0 to k - 1
    const satBad = [], satLoad = [], bad = new Uint8Array(n), load = new Int32Array(n);
    for (let s = 0; s < usable; s++) {
      const dOut = chebyshev(floors[s].outside, na, nb), lo = s * storey, hi = (s + 1) * storey, tmp = new Uint8Array(n);
      for (let k = 0; k < n; k++) if (dOut[k] <= wallN + extraWall) bad[k] = 1;
      stampObstacles(bad, lo, hi, "spaces");
      stampObstacles(tmp, lo, hi, "tubes");
      for (let k = 0; k < n; k++) load[k] += tmp[k];
      satBad[s + 1] = makeSat(bad); satLoad[s + 1] = makeSat(load);
    }
    const spanDiag = Math.hypot(spanA, spanB);
    const centreAB = (c) => { const a = a0 + (c.ci + c.w / 2) * g, b = b0 + (c.cj + c.h / 2) * g; return [a * A[0] + b * B[0], a * A[1] + b * B[1]]; };
    const candidatesFor = (k, shapes) => {
      const list = [];
      for (const [w, h] of shapes) {
        let cj0 = ringC; if ((((cj0 - K - 1) % 2) + 2) % 2) cj0++;
        let ci0 = ringC; if ((((ci0 - K - 1) % 2) + 2) % 2) ci0++;
        for (let cj = cj0; cj + h + ringC <= nb; cj += 2) {
          for (let ci = ci0; ci + w + ringC <= na; ci += 2) {
            const i0 = ci - ringC, j0 = cj - ringC, W = w + 2 * ringC, H = h + 2 * ringC;
            if (satRect(satBad[k], i0, j0, W, H) !== 0) continue;
            const c = { ci, cj, w, h, load: satRect(satLoad[k], i0, j0, W, H), top: k };
            if (isBanned(c)) continue;
            [c.x, c.z] = centreAB(c);
            list.push(c);
          }
        }
      }
      return list;
    };
    // (the tunnels' detour round a core reaches the widest tube's radius, the margin and the ring out from it, and the two cores' detours must not meet, or a
    // corner of one would land in the other: so they are at least twice that apart, in one direction or the other)
    const sepC = Math.ceil((2 * (1.4 + TUBE_MARGIN + (o.width + 0.4) + 0.2)) / g);
    const apart = (p, c) => c.ci >= p.ci + p.w + sepC || p.ci >= c.ci + c.w + sepC || c.cj >= p.cj + p.h + sepC || p.cj >= c.cj + c.h + sepC;
    const best = (list, score) => { let pick = null, bs = Infinity; for (const c of list) { const v = score(c); if (v < bs) { bs = v; pick = c; } } return pick; };
    const stairShapes = [[oddC(MAIN_STAIR[0] / g), oddC(MAIN_STAIR[1] / g)], [oddC(MAIN_STAIR[1] / g), oddC(MAIN_STAIR[0] / g)]], liftC = oddC(MAIN_LIFT / g);
    // the cores that reach floor k (the top floor of the building, if they can): [] if there is not room for a stair
    const tryPlace = (k) => {
      const stairs = candidatesFor(k, stairShapes), lifts = candidatesFor(k, [[liftC, liftC]]);
      const placed = [];
      if (!stairs.length) return placed;
      const maxLoad = Math.max(1, ...stairs.map((c) => c.load), ...lifts.map((c) => c.load));
      if (streets.length) for (const c of stairs) c.street = streetDistance(c.x, c.z);
      const maxStreet = streets.length ? Math.max(1, ...stairs.map((c) => c.street)) : 1;
      // the first stair is near a street (it is where people come in), where the least tunnel is in the way
      const a = best(stairs, (c) => c.load / maxLoad + (streets.length ? 0.7 * c.street / maxStreet : 0));
      placed.push({ kind: "stair", ...a });
      // the second is far from it (two ways out)
      const b = best(stairs.filter((c) => apart(a, c)), (c) => c.load / maxLoad + (1 - Math.min(1, Math.hypot(c.x - a.x, c.z - a.z) / (0.55 * spanDiag))));
      if (b) placed.push({ kind: "stair", ...b });
      // the lift is between the two (or by the first, with one stair), clear of both
      const t = b ? [(a.x + b.x) / 2, (a.z + b.z) / 2] : [a.x, a.z];
      const l = best(lifts.filter((c) => placed.every((p) => apart(p, c))), (c) => c.load / maxLoad + 1.2 * Math.min(1, Math.hypot(c.x - t[0], c.z - t[1]) / (0.35 * spanDiag)));
      if (l) placed.push({ kind: "lift", ...l });
      return placed;
    };
    if (extra) { // one more stair core, as high as the others, clear of them, where the most cut-off hallway (on the floors it passes) is within reach of its doors
      const k = extra.cores[0].top, pockets = new Int32Array(n);
      for (let s = 0; s < k; s++) { const m2 = extra.plan.floors[s]?.detached; if (m2) for (let c = 0; c < n; c++) pockets[c] += m2[c]; }
      const sat = makeSat(pockets), reach = ringC + Math.ceil(3 / g);
      const stairs = candidatesFor(k, stairShapes).filter((c) => extra.cores.every((p) => apart(p, c)));
      const pick = best(stairs, (c) => -satRect(sat, Math.max(0, c.ci - reach), Math.max(0, c.cj - reach), Math.min(na - Math.max(0, c.ci - reach), c.w + 2 * reach), Math.min(nb - Math.max(0, c.cj - reach), c.h + 2 * reach)) + 0.02 * c.load);
      if (pick) res.cores = [{ kind: "stair", ...pick }];
      return res;
    }
    // the full height if it can be had (with at least the two stairs, or a stair and a lift); if not, as high as there is room
    for (let k = usable; k >= 2 && !res.cores.length; k--) {
      const placed = tryPlace(k);
      if (placed.length >= 2) res.cores = placed;
    }
    const top = res.cores[0]?.top ?? 0;
    if (res.cores.length && top < usable) res.warnings.push(`The main cores only reach floor ${top} of ${usable}: there is no room for them higher up (the mass narrows, or the occupied spaces are in the way).`);
    if (res.cores.length && !res.cores.some((c) => c.kind === "lift")) res.warnings.push("There was no room for a lift core clear of the stairs.");
    if (res.cores.length && res.cores.filter((c) => c.kind === "stair").length < 2) res.warnings.push("There was room for only one stair core.");
    return res;
  }

  // ---- lattice helpers ----
  const labelLattice = (set) => { // 4-connected components of the lattice nodes in `set`
    const comp = new Int32Array(m).fill(-1), sizes = [], stack = [];
    for (let id = 0; id < m; id++) {
      if (!set[id] || comp[id] >= 0) continue;
      const c = sizes.length;
      let size = 0;
      comp[id] = c; stack.push(id);
      while (stack.length) {
        const u = stack.pop();
        size++;
        const p = u % ma, q = (u - p) / ma;
        if (p > 0 && set[u - 1] && comp[u - 1] < 0) { comp[u - 1] = c; stack.push(u - 1); }
        if (p < ma - 1 && set[u + 1] && comp[u + 1] < 0) { comp[u + 1] = c; stack.push(u + 1); }
        if (q > 0 && set[u - ma] && comp[u - ma] < 0) { comp[u - ma] = c; stack.push(u - ma); }
        if (q < mb - 1 && set[u + ma] && comp[u + ma] < 0) { comp[u + ma] = c; stack.push(u + ma); }
      }
      sizes.push(size);
    }
    return { comp, sizes };
  };
  const prepare = (F) => { // where a hallway's centreline can go on this floor, and which pieces of it are joined
    F.D = chebyshev(F.blocked, na, nb);
    F.C = new Uint8Array(m);
    for (let id = 0; id < m; id++) if (F.D[nodeCell(id)] >= need) F.C[id] = 1;
    const L = labelLattice(F.C);
    F.comp = L.comp; F.compSize = L.sizes;
  };
  for (const F of floors) if (F) prepare(F);
  mark("prepare");

  // the walk (8 neighbours, a diagonal costs 1.414) from the seeds over walkable cells; `dist` is lowered in place, and `lab` carries the seeds' labels
  const relax = (walk, dist, seeds, limit, lab = null) => {
    const h = new Heap();
    for (const k of seeds) h.push(dist[k], k);
    while (h.size) {
      const k = h.pop(), d = h.top;
      if (d > dist[k]) continue;
      const i = k % na, j = (k - i) / na;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= nb) continue;
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ii = i + di;
          if (ii < 0 || ii >= na) continue;
          const kk = jj * na + ii;
          if (!walk[kk]) continue;
          const nd = d + (di && dj ? SQRT2 : 1);
          if (nd < dist[kk] && nd <= limit) { dist[kk] = nd; if (lab) lab[kk] = lab[k]; h.push(nd, kk); }
        }
      }
    }
  };

  // ---- the entrances: on the ground floor, on the walls nearest a street ----
  const F0 = floors[0];
  const entranceByComp = new Map(); // piece of the ground floor's hallway space -> its best run out to a wall (the entrance, if that piece is used)
  {
    // A way out for every piece of the ground floor's hallway space: a walk from the piece, through every place that is clear of tunnels (and of the occupied
    // spaces) for a hallway's width, to a place that touches the outside (it may turn corners: the strips between the trunks reach a wall straight, but a
    // piece cut off by branches only by a bend). The wall's setback does not stop it: it is the door.
    const dTs = chebyshev(F0.ts, na, nb), dOut0 = chebyshev(F0.outside, na, nb);
    // Within DOOR_ZONE of the wall a door may be narrower than a hallway (squeezed between two tunnel openings, which are only 6 m apart): it needs only
    // DOOR_NEED cells clear of tubes, not the full width.
    const doorNeed = Math.max(2, need - 1), doorZone = Math.round(DOOR_ZONE / g);
    const allowed = new Uint8Array(m);
    for (let id = 0; id < m; id++) {
      const k = nodeCell(id);
      if (F0.outside[k]) continue;
      if (dTs[k] >= need || (!o.strictDoors && dOut0[k] <= doorZone && dTs[k] >= doorNeed)) allowed[id] = 1;
    }
    const outwards = (id) => { // the direction (into DIRS) in which a node touches the outside, or -1
      const p = id % ma, q = (id - p) / ma;
      for (let d = 0; d < 4; d++) {
        const ii = 2 * p + 2 * DIRS[d][0], jj = 2 * q + 2 * DIRS[d][1];
        if (ii < 0 || jj < 0 || ii >= na || jj >= nb || F0.outside[jj * na + ii]) return d;
      }
      return -1;
    };
    const MAXSTEPS = Math.round(40 / (2 * g)); // a run out of at most 40 m
    const dist = new Int16Array(m), par = new Int32Array(m), queue = new Int32Array(m);
    for (let comp = 0; comp < F0.compSize.length; comp++) {
      dist.fill(-1);
      let head = 0, tail = 0;
      for (let id = 0; id < m; id++) if (F0.C[id] && F0.comp[id] === comp) { dist[id] = 0; par[id] = -1; queue[tail++] = id; }
      let best = null;
      while (head < tail) {
        const id = queue[head++], d = outwards(id);
        if (d >= 0) {
          // the last cell inside the mass on the line out (one cell at a time), and the point on the wall just beyond it
          const dx = DIRS[d][0], dy = DIRS[d][1], k = nodeCell(id);
          let ei = k % na, ej = (k - (k % na)) / na;
          while (ei + dx >= 0 && ej + dy >= 0 && ei + dx < na && ej + dy < nb && !F0.outside[(ej + dy) * na + ei + dx]) { ei += dx; ej += dy; }
          const a = a0 + (ei + 0.5) * g + dx * (g / 2), b = b0 + (ej + 0.5) * g + dy * (g / 2);
          const fx = a * A[0] + b * B[0], fz = a * A[1] + b * B[1];
          const street = streets.length ? streetDistance(fx, fz) : null;
          const within = (street ?? 0) + 0.05 * dist[id] * 2 * g; // (the closer to a street and the shorter the run, the better)
          if (!best || within < best.within) {
            const chain = [];
            for (let u = id; u >= 0; u = par[u]) chain.push(u);
            chain.reverse(); // (from the piece to the wall)
            best = { start: chain[0], stub: chain, x: fx, z: fz, nx: dx * A[0] + dy * B[0], nz: dx * A[1] + dy * B[1], comp, street, within };
          }
        }
        if (dist[id] >= MAXSTEPS) continue;
        const p = id % ma, q = (id - p) / ma;
        for (let d2 = 0; d2 < 4; d2++) {
          const pp = p + DIRS[d2][0], qq = q + DIRS[d2][1];
          if (pp < 0 || qq < 0 || pp >= ma || qq >= mb) continue;
          const nid = qq * ma + pp;
          if (!allowed[nid] || dist[nid] >= 0) continue;
          dist[nid] = dist[id] + 1; par[nid] = id; queue[tail++] = nid;
        }
      }
      if (best) entranceByComp.set(comp, best);
    }
    if (!entranceByComp.size) warnings.push("No clear way from the ground-floor hallways to a wall was found, so there is no entrance (the tunnels leave no room).");
  }
  mark("entrance");

  // ---- how much floor a hallway serves, per piece of each floor's hallway space ----
  const walkTotal = new Array(S).fill(0), served = new Array(S).fill(null), centreNode = new Array(S).fill(null);
  for (let s = 0; s < usable; s++) {
    const F = floors[s];
    const dist = new Float32Array(n).fill(Infinity), lab = new Int32Array(n).fill(-1), seeds = [];
    const centre = new Int32Array(F.compSize.length).fill(-1);
    for (let id = 0; id < m; id++) {
      if (!F.C[id]) continue;
      const k = nodeCell(id);
      dist[k] = 0; lab[k] = F.comp[id]; seeds.push(k);
      const c = F.comp[id];
      if (centre[c] < 0 || F.D[k] > F.D[nodeCell(centre[c])]) centre[c] = id; // (the node of a piece with the most room round it: where a hallway on its own starts)
    }
    centreNode[s] = centre;
    relax(F.walk, dist, seeds, serveCells, lab);
    const area = new Float64Array(F.compSize.length);
    for (let k = 0; k < n; k++) {
      if (!F.walk[k]) continue;
      walkTotal[s]++;
      if (lab[k] >= 0 && dist[k] <= serveCells) area[lab[k]]++;
    }
    served[s] = area;
  }
  const servable = walkTotal.reduce((a, b) => a + b, 0) || 1;
  mark("served");

  // ---- the stairs and lifts: links between neighbouring floors ----
  const odd = (cells) => { let c = Math.max(3, Math.round(cells)); if (c % 2 === 0) c++; return c; }; // (odd, so that the doors fall on the lattice)
  const longC = odd((o.coreLong + (o.lift ? 2.4 : 0)) / g), shortC = odd(o.coreShort / g);
  // free for a stair between floor s and s+1: the whole storey of s is clear, and so is the headroom of s+1 (people stand there at the top)
  const pairSat = [];
  for (let s = 0; s + 1 < usable; s++) {
    const t = new Int32Array((na + 1) * (nb + 1)), b1 = floors[s].blockedFull, b2 = floors[s + 1].blocked, W = na + 1;
    for (let j = 0; j < nb; j++) for (let i = 0; i < na; i++) t[(j + 1) * W + i + 1] = (b1[j * na + i] | b2[j * na + i]) + t[j * W + i + 1] + t[(j + 1) * W + i] - t[j * W + i];
    pairSat.push(t);
  }
  const rectBlocked = (t, i0, j0, w, h) => { const W = na + 1; return t[(j0 + h) * W + i0 + w] - t[j0 * W + i0 + w] - t[(j0 + h) * W + i0] + t[j0 * W + i0]; };
  const doorsFor = (ci, cj, w, h, s) => { // the doors a link at (ci, cj) could have on floor s: one a side where a hallway can touch it
    const F = floors[s], out = [];
    for (let side = 0; side < 4; side++) {
      const alongA = side >= 2; // sides 0, 1 are the ends in a (the door runs along b); sides 2, 3 the ends in b
      const fixed = side === 0 ? ci - 1 - K : side === 1 ? ci + w + K : side === 2 ? cj - 1 - K : cj + h + K;
      if (fixed < 0 || fixed >= (alongA ? nb : na)) continue;
      const lo = (alongA ? ci : cj) + K, hi = (alongA ? ci + w : cj + h) - 1 - K, mid = (lo + hi) / 2;
      let bestId = -1, bd = Infinity;
      for (let t = lo; t <= hi; t++) {
        if (t & 1) continue;
        const i = alongA ? t : fixed, j = alongA ? fixed : t;
        if (i >= na || j >= nb) continue;
        const id = (j >> 1) * ma + (i >> 1);
        if (F.C[id] && Math.abs(t - mid) < bd) { bd = Math.abs(t - mid); bestId = id; }
      }
      if (bestId >= 0) out.push({ side, id: bestId });
    }
    return out;
  };
  const centreOf = (c) => { const a = a0 + (c.ci + c.w / 2) * g, b = b0 + (c.cj + c.h / 2) * g; return [a * A[0] + b * B[0], a * A[1] + b * B[1]]; };
  const sameRect = (k, c) => k.ci === c.ci && k.cj === c.cj && k.w === c.w && k.h === c.h;
  const rectsNear = (k, c, pad) => !(c.ci >= k.ci + k.w + pad || k.ci >= c.ci + c.w + pad || c.cj >= k.cj + k.h + pad || k.cj >= c.cj + c.h + pad);
  const KEY = 100000, keyOf = (f, comp) => f * KEY + comp; // a piece of a floor's hallway space, as a number
  const cands = [], byKey = new Map(); // byKey: piece -> the links that have a door onto it
  if (usable >= 2) {
    const shapes = (longC === shortC ? [[longC, shortC]] : [[longC, shortC], [shortC, longC]]).map(([w, h]) => ({ w, h, narrow: false }));
    // with `fill`, also a straight single-flight stair (long and only 2 m wide), which fits in gaps too narrow for the two-flight one
    if (o.fill && !o.lift) { const nl = odd(NARROW_STAIR[0] / g), ns = odd(NARROW_STAIR[1] / g); shapes.push({ w: nl, h: ns, narrow: true }, { w: ns, h: nl, narrow: true }); }
    for (let s = 0; s + 1 < usable; s++) {
      for (const { w, h, narrow } of shapes) {
        for (let cj = K + 1; cj + h + K < nb; cj += 2) {
          for (let ci = K + 1; ci + w + K < na; ci += 2) {
            if (rectBlocked(pairSat[s], ci, cj, w, h) !== 0) continue;
            const low = doorsFor(ci, cj, w, h, s);
            if (!low.length) continue;
            const up = doorsFor(ci, cj, w, h, s + 1);
            if (!up.length) continue;
            const keys = new Set();
            for (const d of low) keys.add(keyOf(s, floors[s].comp[d.id]));
            for (const d of up) keys.add(keyOf(s + 1, floors[s + 1].comp[d.id]));
            const c = { s, ci, cj, w, h, doors: [low, up], keys: [...keys], centre: null, narrow };
            c.centre = centreOf(c);
            cands.push(c);
            for (const key of c.keys) { if (!byKey.has(key)) byKey.set(key, []); byKey.get(key).push(c); }
          }
        }
      }
    }
  }
  mark(`link candidates (${cands.length})`);
  const areaOfKey = (key) => served[Math.floor(key / KEY)][key % KEY];
  const maxPer = o.cores > 0 ? Math.min(o.cores, MAX_CORES) : AUTO_CORES;
  const resSatFor = (entrances) => { // the entrances' runs out to the walls are kept free on the ground floor: a stair on one would cut it off
    const res = new Uint8Array(n);
    for (const e of entrances) {
      for (const id of e.stub) {
        const k = nodeCell(id), i = k % na, j = (k - i) / na;
        for (let jj = Math.max(0, j - need); jj <= Math.min(nb - 1, j + need); jj++) for (let ii = Math.max(0, i - need); ii <= Math.min(na - 1, i + need); ii++) res[jj * na + ii] = 1;
      }
    }
    const t = new Int32Array((na + 1) * (nb + 1)), W = na + 1;
    for (let j = 0; j < nb; j++) for (let i = 0; i < na; i++) t[(j + 1) * W + i + 1] = res[j * na + i] + t[j * W + i + 1] + t[(j + 1) * W + i] - t[j * W + i];
    return t;
  };
  // The state of the plan so far: the links chosen, the pieces of hallway space people can get to from a root (an entrance, or the start of a piece that
  // has no way down to the ground), and the links that touch those pieces (the frontier: only those can be chosen next).
  const newState = () => ({ chosen: [], byFloor: Array.from({ length: S }, () => []), seen: new Set(), frontier: new Set(), perPair: new Array(S).fill(0), entrances: [], detached: [], total: 0 });
  const cloneState = (st) => ({ chosen: st.chosen.slice(), byFloor: st.byFloor.map((l) => l.slice()), seen: new Set(st.seen), frontier: new Set(st.frontier), perPair: st.perPair.slice(), entrances: st.entrances.slice(), detached: st.detached.slice(), total: st.total });
  const addSeen = (st, key) => {
    if (st.seen.has(key)) return;
    st.seen.add(key);
    st.total += areaOfKey(key);
    for (const c of byKey.get(key) ?? []) st.frontier.add(c);
  };
  // Adds links one at a time, each touching what can already be reached and bringing the most new floor within reach (at least minGain of the smaller of
  // its two floors), at most maxPerPair between two floors. `from` ({ x, z }) is where the plan grew from, so that the first link is the nearer to it the
  // better (null: no such wish).
  const growLinks = (st, from, maxPerPair, minGain) => {
    const resSat = resSatFor(st.entrances);
    let here = from ? 0 : 1, added = 0;
    while (added < maxPerPair * (usable - 1)) {
      let best = null, bestScore = 0;
      for (const c of st.frontier) {
        if (st.perPair[c.s] >= maxPerPair) continue;
        if (c.s === 0 && rectBlocked(resSat, c.ci, c.cj, c.w, c.h) !== 0) continue;
        let blockedByOther = false, stacked = false;
        for (let f = Math.max(0, c.s - 1); f <= Math.min(S - 1, c.s + 1) && !blockedByOther; f++) {
          for (const k of st.byFloor[f]) {
            if (k.s !== c.s && k.s !== c.s - 1 && k.s !== c.s + 1) continue;
            if (sameRect(k, c)) { if (k.s === c.s) blockedByOther = true; else stacked = true; continue; }
            if (rectsNear(k, c, 2 * need)) { blockedByOther = true; break; } // (they share a floor, and would crowd one another's doors)
          }
        }
        if (blockedByOther) continue;
        let gain = 0;
        for (const key of c.keys) if (!st.seen.has(key)) gain += areaOfKey(key);
        if (gain < minGain * Math.min(walkTotal[c.s], walkTotal[c.s + 1])) continue;
        let w = 1;
        if (!here) w = 1 - 0.3 * Math.min(1, Math.hypot(c.centre[0] - from.x, c.centre[1] - from.z) / 60);
        else {
          let near = Infinity;
          for (const k of st.byFloor[c.s]) if (k.s === c.s) near = Math.min(near, Math.hypot(c.centre[0] - k.centre[0], c.centre[1] - k.centre[1]));
          if (near < Infinity) w = 0.5 + 0.5 * Math.min(1, near / 30);
        }
        if (stacked) w *= STACK_BONUS; // (a stair above a stair makes one core)
        if (c.narrow) w *= 0.85; // (the two-flight stair is the better one, where there is room for it)
        if (gain * w > bestScore) { bestScore = gain * w; best = c; }
      }
      if (!best) break;
      st.chosen.push(best);
      st.byFloor[best.s].push(best); st.byFloor[best.s + 1].push(best);
      st.perPair[best.s]++;
      st.frontier.delete(best);
      here++; added++;
      for (const key of best.keys) addSeen(st, key);
    }
  };
  // Takes a new root (opt) and then adds links to it.
  const extend = (base, opt) => {
    const st = cloneState(base);
    if (opt.entrance) st.entrances.push(opt.entrance); else st.detached.push(opt.root);
    addSeen(st, opt.key);
    growLinks(st, { x: opt.x, z: opt.z }, maxPer, MIN_GAIN);
    return st;
  };
  // "Fill": every part of a floor that has room for a hallway gets hallways. First, stairs are added wherever one can join a part that is not yet
  // reachable to the rest (down to the least gain; at most maxStairs between two floors, none if 0). What is still not reachable is given hallways of its own:
  // a part of the ground floor that has a way to a wall gets an exit; the others start where they have most room, and are drawn grey.
  const fillRest = (st, maxStairs) => {
    if (maxStairs > 0) growLinks(st, null, maxStairs, o.minGainFill ?? MIN_GAIN_FILL);
    for (let f = 0; f < usable; f++) {
      for (let comp = 0; comp < floors[f].compSize.length; comp++) {
        const key = keyOf(f, comp);
        if (st.seen.has(key) || floors[f].compSize[comp] < FILL_PIECE) continue;
        const e = f === 0 ? entranceByComp.get(comp) : null;
        if (e) st.entrances.push(e); else st.detached.push({ f, comp, id: centreNode[f][comp] });
        st.seen.add(key);
      }
    }
  };
  // Roots are added one at a time. The first is a ground-floor entrance: every piece of the ground floor that has a run out to a wall is tried, and the
  // one that gets people to the most floor wins (a closer street breaks near ties). Then, while it brings enough new floor within reach, another root
  // is added: another entrance on the ground floor, or, where the tunnels leave no way down at all, the start of a piece higher up that is not joined
  // to the ground (drawn apart, and reported).
  let state = newState(), mainNoExit = [];
  if (o.fixedCores) {
    // The main cores (placed in the first pass, the tunnels moved round them): each is a stack of links from the ground floor up, so the hallways on
    // every floor branch from its doors. The entrance is on a piece of the ground floor that a core opens onto, nearest a street. Then a few supplemental
    // stairs are added only where a piece of a floor would otherwise be cut off.
    const missing = [];
    for (const c of o.fixedCores) {
      let lacking = 0;
      for (let s = 0; s + 1 < Math.min(c.top, usable); s++) {
        const low = doorsFor(c.ci, c.cj, c.w, c.h, s), up = doorsFor(c.ci, c.cj, c.w, c.h, s + 1);
        if (!low.length || !up.length) lacking++;
        const keys = new Set();
        for (const d of low) keys.add(keyOf(s, floors[s].comp[d.id]));
        for (const d of up) keys.add(keyOf(s + 1, floors[s + 1].comp[d.id]));
        const link = { s, ci: c.ci, cj: c.cj, w: c.w, h: c.h, doors: [low, up], keys: [...keys], centre: null, kind: c.kind, main: true };
        link.centre = centreOf(link);
        state.chosen.push(link); state.byFloor[s].push(link); state.byFloor[s + 1].push(link);
        for (const key of link.keys) addSeen(state, key);
      }
      if (lacking) missing.push(`${c.kind === "lift" ? "The lift core" : "A stair core"} has no door that a hallway can reach on ${lacking} of its ${Math.min(c.top, usable) - 1} storeys`);
    }
    for (const text of missing) warnings.push(`${text}: the tunnels, even moved, leave no room beside it there.`);
    // Every piece of the ground floor that a core opens onto gets its own way out (the first, nearest a street, is the main entrance): the trunks split the
    // ground floor, so one entrance would leave the other cores without an exit. (A piece with no clear run to a wall has none, and is reported.)
    const groundPieces = new Set();
    for (const k of state.chosen) if (k.s === 0) for (const d of k.doors[0]) groundPieces.add(floors[0].comp[d.id]);
    const exits = [...groundPieces].map((comp) => entranceByComp.get(comp)).filter(Boolean).sort((p, q) => p.within - q.within);
    for (const e of exits) { state.entrances.push(e); addSeen(state, keyOf(0, e.comp)); }
    // the cores none of whose ground-floor hallways has a way to a wall (the caller places them somewhere else)
    const exitComps = new Set(exits.map((e) => e.comp));
    mainNoExit = o.fixedCores.map((c, i) => [c, i]).filter(([c]) => {
      const door = state.chosen.filter((k) => k.s === 0 && k.ci === c.ci && k.cj === c.cj && k.w === c.w && k.h === c.h && k.kind === c.kind).flatMap((k) => k.doors[0]);
      return !door.some((d) => exitComps.has(floors[0].comp[d.id]));
    }).map(([, i]) => i);
    if (groundPieces.size > exits.length) warnings.push(`${groundPieces.size - exits.length} of the ground-floor pieces a core opens onto have no clear run to a wall, so no exit of their own.`);
    if (!exits.length) { // (none at all: the best entrance anywhere, which will show apart from the cores)
      let pick = null;
      for (const e of entranceByComp.values()) if (!pick || e.within < pick.within) pick = e;
      if (pick) { state.entrances.push(pick); addSeen(state, keyOf(0, pick.comp)); }
    }
    const supp = o.cores < 0 ? 0 : o.cores > 0 ? Math.min(o.cores, MAX_CORES) : AUTO_SUPP;
    if (supp > 0) growLinks(state, null, supp, MIN_GAIN_SUPP);
    if (o.fill) fillRest(state, supp > 0 ? Math.max(supp, o.fillStairs ?? FILL_STAIRS) : 0);
  } else {
    for (let round = 0; round < MAX_ROOTS; round++) {
      const opts = [];
      for (let f = 0; f < usable; f++) {
        for (let comp = 0; comp < floors[f].compSize.length; comp++) {
          const key = keyOf(f, comp), area = served[f][comp];
          if (state.seen.has(key) || area < 0.015 * walkTotal[f]) continue;
          if (f === 0) {
            const e = entranceByComp.get(comp);
            if (e) opts.push({ key, area, entrance: e, x: e.x, z: e.z });
          } else if (round > 0 || !entranceByComp.size) {
            const id = centreNode[f][comp], k = nodeCell(id);
            opts.push({ key, area, root: { f, comp, id }, x: wx[k], z: wz[k] });
          }
        }
      }
      opts.sort((p, q) => q.area - p.area);
      let bestTrial = null, bestValue = 0;
      for (const opt of opts.slice(0, 14)) {
        const trial = extend(state, opt);
        let value = trial.total - state.total;
        if (round === 0 && opt.entrance) value *= 1 - 0.15 * Math.min(1, (opt.entrance.street ?? 0) / 60);
        if (value > bestValue) { bestValue = value; bestTrial = trial; }
      }
      if (!bestTrial || (round > 0 && bestValue < MIN_ROOT * servable)) break;
      state = bestTrial;
    }
    if (o.fill) fillRest(state, Math.max(maxPer, o.fillStairs ?? FILL_STAIRS));
  }
  const links = state.chosen, entrances = state.entrances, detachedRoots = state.detached;
  if (usable >= 2 && !links.length) warnings.push("No place is clear of tunnels on two neighbouring floors for a stair that a hallway can reach, so the floors are not joined.");
  mark(`links (${links.length}), entrances (${entrances.length}), detached roots (${detachedRoots.length})`);
  // a link is solid on the two floors it joins: no hallway or walk through it
  for (const k of links) {
    k.a0 = a0 + k.ci * g; k.a1 = a0 + (k.ci + k.w) * g; k.b0 = b0 + k.cj * g; k.b1 = b0 + (k.cj + k.h) * g;
    for (const f of [k.s, k.s + 1]) {
      const F = floors[f];
      for (let j = k.cj; j < k.cj + k.h; j++) for (let i = k.ci; i < k.ci + k.w; i++) { const c = j * na + i; F.blocked[c] = 1; F.walk[c] = 0; F.core[c] = 1; }
    }
  }
  // (the comps of a floor change when the links are cut out of it: the roots are found again below by where they are)
  for (let f = 0; f < usable; f++) if (links.some((k) => k.s === f || k.s + 1 === f)) prepare(floors[f]);

  // ---- the hallways: grown on every floor from the doors (and the entrances) ----
  const route = (F, from, isTarget) => { // the cheapest rectilinear route over the hallway lattice from `from` to a node that isTarget: [that node, ..., from], or null
    const cost = new Float32Array(4 * m).fill(Infinity), prev = new Int32Array(4 * m).fill(-1), h = new Heap();
    for (let d = 0; d < 4; d++) { cost[from * 4 + d] = 0; h.push(0, from * 4 + d); }
    const clear = need + 3;
    while (h.size) {
      const st = h.pop(), c = h.top;
      if (c > cost[st]) continue;
      const id = st >> 2, dir = st & 3;
      if (id !== from && isTarget(id)) {
        const path = [];
        for (let u = st; u >= 0; u = prev[u]) path.push(u >> 2);
        return path;
      }
      const p = id % ma, q = (id - p) / ma;
      for (let nd = 0; nd < 4; nd++) {
        const pp = p + DIRS[nd][0], qq = q + DIRS[nd][1];
        if (pp < 0 || qq < 0 || pp >= ma || qq >= mb) continue;
        const nid = qq * ma + pp;
        if (!F.C[nid]) continue;
        const dd = F.D[nodeCell(nid)];
        const cc = c + 1 + (nd !== dir ? TURN : 0) + (dd < clear ? (clear - dd) * 0.25 : 0);
        const ns = nid * 4 + nd;
        if (cc < cost[ns]) { cost[ns] = cc; prev[ns] = st; h.push(cc, ns); }
      }
    }
    return null;
  };

  const nets = new Array(S).fill(null);
  for (let s = 0; s < usable; s++) {
    const F = floors[s];
    const roots = [];
    if (s === 0) for (const e of entrances) roots.push(e.start);
    for (const d of detachedRoots) if (d.f === s && F.C[d.id]) roots.push(d.id); // (not if a stair has since taken its place)
    for (const k of links) {
      if (k.s === s) for (const d of k.doors[0]) roots.push(d.id);
      else if (k.s + 1 === s) for (const d of k.doors[1]) roots.push(d.id);
    }
    if (!roots.length) { if (s > 0) warnings.push(`Floor ${s + 1}: no stair reaches it, so it has no hallways.`); continue; }
    const net = new Uint8Array(m), parent = new Int32Array(m).fill(-1), depth = new Int32Array(m);
    for (const id of roots) net[id] = 1;
    const attach = (path) => { // path[0] is already in the net
      for (let t = 1; t < path.length; t++) { net[path[t]] = 1; parent[path[t]] = path[t - 1]; depth[path[t]] = depth[path[t - 1]] + 1; }
    };
    if (s === 0) { // the entrances' runs out to the walls
      for (const e of entrances) {
        let prevId = e.start;
        for (const id of e.stub) { if (id === e.start) continue; net[id] = 1; parent[id] = prevId; depth[id] = depth[prevId] + 1; prevId = id; }
      }
    }
    // roots in the same hallway space are joined first
    for (let guard = 0; guard < 24; guard++) {
      const L = labelLattice(net);
      let joined = false;
      for (const r1 of roots) {
        if (F.comp[r1] < 0 || joined) continue;
        for (const r2 of roots) {
          if (r2 === r1 || F.comp[r2] !== F.comp[r1] || L.comp[r2] === L.comp[r1]) continue;
          const mine = L.comp[r1], path = route(F, r1, (id) => net[id] === 1 && L.comp[id] !== mine);
          if (path) { attach(path); joined = true; }
          break;
        }
      }
      if (!joined) break;
    }
    // grown until all of the floor is within `serve` metres of a hallway (walking): the cost of the cheapest rectilinear route to the network is kept for
    // every node (and every direction of arrival, for the cost of turns) and brought up to date as a branch is added
    // (the walk is only followed as far as GROW_REACH times the reach asked for: farther floor counts as not reached, and how far it is does not matter;
    // following it all the way after every branch would flood the whole floor each time)
    const growLimit = GROW_REACH * serveCells;
    const dist = new Float32Array(n).fill(Infinity), seeds = [];
    for (let id = 0; id < m; id++) if (net[id]) { const k = nodeCell(id); dist[k] = 0; seeds.push(k); }
    relax(F.walk, dist, seeds, growLimit);
    const cost = new Float32Array(4 * m).fill(Infinity), prev = new Int32Array(4 * m).fill(-1), heap = new Heap(), clear = need + 3;
    const spread = (ids) => {
      for (const id of ids) for (let d = 0; d < 4; d++) { cost[id * 4 + d] = 0; prev[id * 4 + d] = -1; heap.push(0, id * 4 + d); }
      while (heap.size) {
        const st = heap.pop(), c = heap.top;
        if (c > cost[st]) continue;
        const id = st >> 2, dir = st & 3, p = id % ma, q = (id - p) / ma;
        for (let nd = 0; nd < 4; nd++) {
          const pp = p + DIRS[nd][0], qq = q + DIRS[nd][1];
          if (pp < 0 || qq < 0 || pp >= ma || qq >= mb) continue;
          const nid = qq * ma + pp;
          if (!F.C[nid]) continue;
          const dd = F.D[nodeCell(nid)];
          const cc = c + 1 + (nd !== dir ? TURN : 0) + (dd < clear ? (clear - dd) * 0.25 : 0);
          const ns = nid * 4 + nd;
          if (cc < cost[ns]) { cost[ns] = cc; prev[ns] = st; heap.push(cc, ns); }
        }
      }
    };
    const start = [];
    for (let id = 0; id < m; id++) if (net[id]) start.push(id);
    spread(start);
    const has = new Uint8Array(F.compSize.length), dead = new Uint8Array(m);
    for (let id = 0; id < m; id++) if (net[id] && F.comp[id] >= 0) has[F.comp[id]] = 1;
    for (let it = 0; it < 300; it++) {
      // the next branch goes to the node farthest from the hallways within the walk followed; if all that are left are farther than that, to the one cheapest to reach
      let u = -1, ud = serveCells, far = -1, farCost = Infinity;
      for (let id = 0; id < m; id++) {
        if (!F.C[id] || net[id] || dead[id] || !has[F.comp[id]]) continue;
        const d = dist[nodeCell(id)];
        if (d === Infinity) {
          const c = Math.min(cost[id * 4], cost[id * 4 + 1], cost[id * 4 + 2], cost[id * 4 + 3]);
          if (c < farCost) { farCost = c; far = id; }
        } else if (d > ud) { ud = d; u = id; }
      }
      if (u < 0) u = far;
      if (u < 0) break;
      let bs = -1, bc = Infinity;
      for (let d = 0; d < 4; d++) if (cost[u * 4 + d] < bc) { bc = cost[u * 4 + d]; bs = u * 4 + d; }
      if (bs < 0) { dead[u] = 1; continue; }
      const path = [];
      for (let st = bs; st >= 0; st = prev[st]) path.push(st >> 2);
      path.reverse(); // (from the node of the net it reached, to u)
      attach(path);
      const added = [];
      for (const id of path) { added.push(nodeCell(id)); dist[nodeCell(id)] = 0; }
      relax(F.walk, dist, added, growLimit);
      spread(path);
    }
    // loops: straight shortcuts between two hallways that are far apart by the network
    const treeDistance = (p, q) => {
      let x = p, y = q, steps = 0;
      while (x !== y) {
        if (x < 0 || y < 0) return Infinity; // (different trees)
        if (depth[x] >= depth[y]) x = parent[x]; else y = parent[y];
        if (++steps > 100000) return Infinity;
      }
      return steps;
    };
    const MAXRUN = Math.round(20 / (2 * g));
    const loopCands = [];
    for (let id = 0; id < m && o.loops > 0; id++) {
      if (!net[id]) continue;
      const p = id % ma, q = (id - p) / ma;
      for (let d = 0; d < 4; d++) {
        let pp = p, qq = q, run = 0, hit = -1;
        for (;;) {
          pp += DIRS[d][0]; qq += DIRS[d][1]; run++;
          if (pp < 0 || qq < 0 || pp >= ma || qq >= mb || run > MAXRUN) break;
          const nid = qq * ma + pp;
          if (net[nid]) { hit = nid; break; }
          if (!F.C[nid]) break;
        }
        if (hit < 0 || run < 4) continue;
        const detour = treeDistance(id, hit);
        if (detour > 3 * run + 12) loopCands.push({ id, d, run, hit, gain: Math.min(detour, 1e6) - run });
      }
    }
    loopCands.sort((a, b) => b.gain - a.gain);
    let loops = 0;
    for (const lc of loopCands) {
      if (loops >= o.loops) break;
      const p0 = lc.id % ma, q0 = (lc.id - p0) / ma, mid = [];
      let okLoop = true;
      for (let t = 1; t < lc.run && okLoop; t++) {
        const pp = p0 + DIRS[lc.d][0] * t, qq = q0 + DIRS[lc.d][1] * t, nid = qq * ma + pp;
        if (net[nid]) { okLoop = false; break; }
        for (const [dx, dy] of DIRS) { // (no other hallway beside it, or it would just widen that one)
          const ap = pp + dx, aq = qq + dy;
          if (ap < 0 || aq < 0 || ap >= ma || aq >= mb) continue;
          const isLine = dx === DIRS[lc.d][0] && dy === DIRS[lc.d][1] || dx === -DIRS[lc.d][0] && dy === -DIRS[lc.d][1];
          if (!isLine && net[aq * ma + ap]) okLoop = false;
        }
        mid.push(nid);
      }
      if (!okLoop || !mid.length) continue;
      let prevId = lc.id;
      for (const nid of mid) { net[nid] = 1; parent[nid] = prevId; depth[nid] = depth[prevId] + 1; prevId = nid; }
      loops++;
    }
    nets[s] = { net, loops };
  }
  mark("hallways");

  // ---- what can be reached from an entrance (through the links), the cores, and what the hallways cover ----
  const netComps = new Array(S).fill(null);
  for (let s = 0; s < usable; s++) if (nets[s]) netComps[s] = labelLattice(nets[s].net);
  const uf = new Map();
  const find = (x) => { if (!uf.has(x)) uf.set(x, x); let r = x; while (uf.get(r) !== r) r = uf.get(r); uf.set(x, r); return r; };
  const unite = (x, y) => { uf.set(find(x), find(y)); };
  links.forEach((k, li) => {
    for (let side = 0; side < 2; side++) {
      const f = k.s + side;
      if (!netComps[f]) continue;
      for (const d of k.doors[side]) if (nets[f].net[d.id]) unite(`link:${li}`, `${f}:${netComps[f].comp[d.id]}`);
    }
  });
  const groundRoots = new Set();
  if (netComps[0]) for (const e of entrances) groundRoots.add(find(`0:${netComps[0].comp[e.start]}`));
  const connected = (s, c) => groundRoots.has(find(`${s}:${c}`)); // is this piece of hallway joined to an entrance?
  const maskOf = (net, F, comp, wantConnected, s) => {
    const out = new Uint8Array(n);
    let any = false;
    for (let id = 0; id < m; id++) {
      if (!net[id] || connected(s, comp[id]) !== wantConnected) continue;
      const k = nodeCell(id), i = k % na, j = (k - i) / na;
      for (let jj = Math.max(0, j - K); jj <= Math.min(nb - 1, j + K); jj++) {
        for (let ii = Math.max(0, i - K); ii <= Math.min(na - 1, i + K); ii++) if (!F.outside[jj * na + ii] && !F.core[jj * na + ii]) { out[jj * na + ii] = 1; any = true; }
      }
    }
    return any ? out : null;
  };
  const floorOut = new Array(S).fill(null);
  let totalLength = 0, reachableLength = 0;
  for (let s = 0; s < usable; s++) {
    if (!nets[s]) continue;
    const F = floors[s], { net, loops } = nets[s], L = netComps[s];
    let nodesCount = 0;
    for (let id = 0; id < m; id++) if (net[id]) nodesCount++;
    const dist = new Float32Array(n).fill(Infinity), seeds = [];
    for (let id = 0; id < m; id++) if (net[id]) { const k = nodeCell(id); dist[k] = 0; seeds.push(k); }
    relax(F.walk, dist, seeds, serveCells);
    let walkable = 0, near = 0;
    for (let k = 0; k < n; k++) if (F.walk[k]) { walkable++; if (dist[k] <= serveCells) near++; }
    const mask = maskOf(net, F, L.comp, true, s), detached = maskOf(net, F, L.comp, false, s);
    let cellsCount = 0;
    for (const mk of [mask, detached]) if (mk) for (let k = 0; k < n; k++) if (mk[k]) cellsCount++;
    const length = nodesCount * 2 * g;
    totalLength += length;
    L.sizes.forEach((size, c) => { if (connected(s, c)) reachableLength += size * 2 * g; });
    floorOut[s] = { s, y0: F.y0, mask, detached, length, area: cellsCount * g * g, served: walkable ? near / walkable : 0, pieces: L.sizes.length, loops };
    if (walkable && near / walkable < 0.9) warnings.push(`Floor ${s + 1}: ${Math.round((100 * near) / walkable)}% of the floor is within ${Math.round(serveCells * g)} m of a hallway (the tunnels leave no room for more).`);
  }
  if (totalLength > 0 && reachableLength < 0.999 * totalLength) warnings.push(`${Math.round((100 * (totalLength - reachableLength)) / totalLength)}% of the hallways have no route to an entrance on the ground floor (shown grey): the tunnels leave no way down to them.`);

  // the links stacked at one place are one core, from its lowest floor to its highest
  const groups = new Map();
  for (const k of links) {
    const key = `${k.kind ?? "stair"},${k.ci},${k.cj},${k.w},${k.h}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(k);
  }
  const cores = [];
  for (const list of groups.values()) {
    list.sort((p, q) => p.s - q.s);
    let run = [list[0]];
    const flush = () => {
      const k0 = run[0], last = run[run.length - 1], doors = [];
      for (const k of run) { k.doors[0].forEach((d) => doors.push({ floor: k.s, side: d.side })); k.doors[1].forEach((d) => doors.push({ floor: k.s + 1, side: d.side })); }
      cores.push({ a0: k0.a0, a1: k0.a1, b0: k0.b0, b1: k0.b1, w: k0.w, h: k0.h, s0: k0.s, s1: last.s + 1, doors, kind: k0.kind ?? "stair", main: !!k0.main, narrow: !!k0.narrow });
    };
    for (let i = 1; i < list.length; i++) {
      if (list[i].s === run[run.length - 1].s + 1) run.push(list[i]);
      else { flush(); run = [list[i]]; }
    }
    flush();
  }
  mark("done");
  // for the report and for finding out why a floor has no room: per floor, the widest clear gap (Chebyshev distance to a blocked cell, in metres,
  // counted from the edge) and the part of the floor where a hallway's centreline could go
  const diag = floors.map((F) => {
    if (!F) return null;
    let maxD = 0, free = 0, cCount = 0, inMass = 0;
    for (let k = 0; k < n; k++) { if (F.outside[k]) continue; inMass++; if (!F.ts[k]) free++; if (F.D[k] > maxD && F.D[k] < 255) maxD = F.D[k]; }
    for (let id = 0; id < m; id++) if (F.C[id]) cCount++;
    return { clearGap: (2 * maxD - 1) * g, freeShare: inMass ? free / inMass : 0, centrelineCells: cCount, pieces: F.compSize.length, largest: Math.max(0, ...F.compSize) };
  });
  // how many of the parts of the floors that have room for a hallway got one
  let groundPieces = 0, groundWithRun = 0; // (pieces of the ground floor with room, and how many of them have a way to a wall)
  floors[0].compSize.forEach((size, c) => { if (size >= FILL_PIECE) { groundPieces++; if (entranceByComp.has(c)) groundWithRun++; } });
  let roomPieces = 0, roomWithHall = 0;
  for (let s = 0; s < usable; s++) {
    const F = floors[s], has = new Uint8Array(F.compSize.length);
    if (nets[s]) for (let id = 0; id < m; id++) if (nets[s].net[id] && F.comp[id] >= 0) has[F.comp[id]] = 1;
    F.compSize.forEach((size, c) => { if (size >= FILL_PIECE) { roomPieces++; if (has[c]) roomWithHall++; } });
  }
  const entrancesOut = entrances.map((e) => ({ x: e.x, z: e.z, nx: e.nx, nz: e.nz, street: e.street }));
  return {
    diag,
    grid: gridOut, storey, storeys: S, head: o.head, lift: !!o.lift && !o.fixedCores, mode: o.fixedCores ? "main" : "scattered",
    // the tunnels as moved round the main cores (to be applied to the real tunnels), and what was moved; null when nothing was
    graph: o.fixedCores ? site.graph : null, reroute: o.reroute ?? null,
    floors: floorOut, cores,
    entrances: entrancesOut, entrance: entrancesOut[0] ?? null, mainNoExit,
    stats: { groundPieces, groundWithRun, roomPieces, roomWithHall, length: totalLength, reachableLength, links: links.length, cores: cores.length, entrances: entrances.length, floorsServed: floorOut.filter(Boolean).length, usable },
    warnings, timings,
  };
}

