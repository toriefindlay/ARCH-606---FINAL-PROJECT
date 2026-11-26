// MODEL (structure): concrete floor plates and a generic steel frame for the massings. Pure logic, no scene or DOM code.
//
// The wind tunnels and the circulation come first: this only READS them, and gives way to them.
//   plates   one under every floor (its top at the floor's level), kept just inside the outside walls, with openings where a
//            tunnel passes through it and where a stair or lift rises through it. Hallways are walked on top of them.
//   columns  on a square-ish grid along the tunnels' axes. Each is one straight upright line from the ground to the roof
//            above it, and may be moved from its place on the grid to where it meets the fewest tunnels, hallways and stairs.
//   beams    between neighbouring columns just under every plate and under the roof, with lighter beams between them. They
//            sit above the horizontal tunnels and the hallways' headroom, and are cut off where a steep tunnel or a stair
//            comes through.
// It is a concept of a frame, not a structural design: nothing is sized or checked for loads.
import { distance3d } from "../erosion/exterior/distance.js";
import { exactHeights } from "../erosion/exterior/exactMass.js";

export const SLAB = 0.2; // m: a floor plate's thickness
const CELL = 0.25; // m: the grid the plates are cut on (coarser on a very large site)
const MAX_CELLS = 700000;
const EDGE = 0.2; // m: the plates stop this far inside the outside walls
const FLOOR_NEEDS = 2.5; // m: the mass must rise this far above a level for there to be a floor there
const TUBE_GAP = 0.08; // m: kept between a plate's opening and the tunnel through it
export const COLUMN = { depth: 0.3, width: 0.3 };
export const BEAM = { depth: 0.45, width: 0.2 };
export const JOIST = { depth: 0.3, width: 0.14 };
const COLUMN_HALF = 0.2; // m: the room a column needs round its middle
const INSET = 0.55; // m: the outermost columns stand this far inside the walls
const SHIFT = 3.2, SHIFT_STEP = 0.25; // m: how far a column may be moved off the grid (each way along the axes), and in what steps
const TUNNEL_WEIGHT = 3; // a storey where a column would pass through a tunnel counts this much, against 1 for a hallway or a stair
const JOIST_SPACING = 2.8; // m: between the lighter beams, at the most

const runAll = (generator) => {
  let r = generator.next();
  while (!r.done) r = generator.next();
  return r.value;
};

// `site`: { triangles (the massings' own, a flat array of world positions), bounds: { min, max }, storey, axes: { A, B }
// (unit vectors in x, z), tubes: [{ a: {x, y, z}, b, r }] (may be empty), plan (circulation/structures.js's, or null),
// spacing (m, between columns at the most), solid (core/solid.js: what is really inside the massings; without it, everything
// under their surfaces is taken to be) }.
export function planStructure({ triangles, bounds, storey, axes, tubes = [], plan = null, spacing = 7.5, solid: massing = null }) {
  const ox = bounds.min.x - 1, oz = bounds.min.z - 1, W = bounds.max.x - ox + 1, D = bounds.max.z - oz + 1;
  const fc = Math.max(CELL, Math.sqrt((W * D) / MAX_CELLS)), nx = Math.ceil(W / fc) + 1, nz = Math.ceil(D / fc) + 1;
  // (the grid's points are the middles of exactHeights' columns)
  const heights = runAll(exactHeights(triangles, { ox: ox - fc / 2, oz: oz - fc / 2, fc, nx, nz }));
  const px = (i) => ox + i * fc, pz = (j) => oz + j * fc;
  const heightAt = (x, z) => {
    const i = Math.round((x - ox) / fc), j = Math.round((z - oz) / fc);
    return i < 0 || j < 0 || i >= nx || j >= nz ? 0 : heights[j * nx + i];
  };
  let top = 0;
  for (const h of heights) if (h > top) top = h;
  // Under the curved-in side of a rounded form, or an overhang, the height map says "solid" where there is only air: these
  // ask the massings themselves, so that no plate, column or beam stands out there.
  const found = new Map(); // grid point -> the massings' crossings above it
  const filled = (k, y) => {
    if (!massing) return true;
    let c = found.get(k);
    if (!c) found.set(k, (c = massing.crossings(px(k % nx), pz(Math.floor(k / nx)))));
    return massing.insideAt(c, y);
  };
  const inside = (x, y, z) => !massing || massing.inside(x, Math.max(0.05, y), z);
  const levels = [];
  for (let f = 0; f * storey + FLOOR_NEEDS <= top; f++) levels.push(f);

  // The circulation's stairs and lifts, in the grids of their own structures: { A, B, a0, a1, b0, b1, s0, s1 }.
  const parts = plan ? plan.parts ?? [plan] : [];
  const cores = parts.flatMap((part) => part.cores.map((c) => ({ A: part.grid.A, B: part.grid.B, a0: c.a0, a1: c.a1, b0: c.b0, b1: c.b1, s0: c.s0, s1: c.s1 })));
  // how far (x, z) is inside a core's rectangle (negative outside)
  const inCore = (c, x, z) => {
    const a = x * c.A[0] + z * c.A[1], b = x * c.B[0] + z * c.B[1];
    return Math.min(a - c.a0, c.a1 - a, b - c.b0, c.b1 - b);
  };
  // the distance from a point to a tube's surface (negative inside it)
  const tubeDistance = (t, x, y, z) => {
    const sx = t.b.x - t.a.x, sy = t.b.y - t.a.y, sz = t.b.z - t.a.z, l2 = sx * sx + sy * sy + sz * sz || 1;
    const u = Math.max(0, Math.min(1, ((x - t.a.x) * sx + (y - t.a.y) * sy + (z - t.a.z) * sz) / l2));
    return Math.hypot(x - t.a.x - sx * u, y - t.a.y - sy * u, z - t.a.z - sz * u) - t.r;
  };
  const within = (lo, hi) => tubes.filter((t) => Math.max(t.a.y, t.b.y) + t.r > lo && Math.min(t.a.y, t.b.y) - t.r < hi);
  // calls visit(k, x, z) for the grid's points in the box round a tube, `pad` wider than it
  const around = (t, pad, visit) => {
    const reach = t.r + pad;
    const i0 = Math.max(0, Math.floor((Math.min(t.a.x, t.b.x) - reach - ox) / fc)), i1 = Math.min(nx - 1, Math.ceil((Math.max(t.a.x, t.b.x) + reach - ox) / fc));
    const j0 = Math.max(0, Math.floor((Math.min(t.a.z, t.b.z) - reach - oz) / fc)), j1 = Math.min(nz - 1, Math.ceil((Math.max(t.a.z, t.b.z) + reach - oz) / fc));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) visit(j * nx + i, px(i), pz(j));
  };

  /* ---------- the plates ---------- */

  const position = [];
  let area = 0, openings = 0;
  for (const f of levels) {
    const upper = f === 0 ? 0.015 : f * storey, lower = upper - SLAB; // (the ground floor's top is just above the ground)
    // the floor's footprint, and how far every point is inside (or outside) its edge
    const solid = new Uint8Array(nx * nz);
    for (let k = 0; k < solid.length; k++) {
      solid[k] = heights[k] >= f * storey + FLOOR_NEEDS && filled(k, upper + 0.05) && filled(k, Math.max(0.02, lower + 0.02)) ? 1 : 0;
    }
    const far = (inside) => {
      const d = new Float32Array(nx * nz);
      for (let k = 0; k < d.length; k++) d[k] = solid[k] === inside ? 1e20 : 0;
      distance3d(d, nx, nz, 1);
      return d;
    };
    const toOutside = far(1), toInside = far(0);
    // the plate's shape as a field, below zero where there is concrete
    const field = new Float32Array(nx * nz);
    for (let k = 0; k < field.length; k++) field[k] = EDGE - (solid[k] ? (Math.sqrt(toOutside[k]) - 0.5) * fc : -(Math.sqrt(toInside[k]) - 0.5) * fc);
    let cut = false;
    for (const t of within(lower, upper)) {
      around(t, TUBE_GAP + 2 * fc, (k, x, z) => {
        const d = Math.min(tubeDistance(t, x, lower, z), tubeDistance(t, x, (lower + upper) / 2, z), tubeDistance(t, x, upper, z));
        const open = TUBE_GAP - d;
        if (open > field[k]) { if (open > 0 && field[k] <= 0) cut = true; field[k] = open; }
      });
    }
    // (a stair or lift that comes up to this floor from below rises through its plate)
    for (const c of cores) {
      if (f <= c.s0 || f > c.s1) continue;
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i, open = inCore(c, px(i), pz(j));
          if (open > field[k]) { if (open > 0 && field[k] <= 0) cut = true; field[k] = open; }
        }
      }
    }
    if (cut) openings++;
    area += slab(position, field, nx, nz, ox, oz, fc, lower, upper);
  }

  /* ---------- the columns ---------- */

  const { A, B } = axes;
  const toWorld = (a, b) => [a * A[0] + b * B[0], a * A[1] + b * B[1]];
  // the footprint's extent along the two axes
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (let k = 0; k < heights.length; k++) {
    if (heights[k] < FLOOR_NEEDS) continue;
    const x = px(k % nx), z = pz(Math.floor(k / nx)), a = x * A[0] + z * A[1], b = x * B[0] + z * B[1];
    a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
  }
  const lines = (from, to) => {
    const lo = from + INSET, hi = to - INSET;
    if (hi <= lo) return [(from + to) / 2];
    const bays = Math.max(1, Math.ceil((hi - lo) / spacing - 0.05));
    return Array.from({ length: bays + 1 }, (_, i) => lo + ((hi - lo) * i) / bays);
  };
  const alongA = a1 > a0 ? lines(a0, a1) : [], alongB = b1 > b0 ? lines(b0, b1) : [];

  // what stands in a column's way on every storey: tunnels (`ducted`), and hallways (`walked`); stairs and lifts are `cores`
  const walked = levels.map(() => new Uint8Array(nx * nz));
  const ducted = levels.map((f) => {
    const mask = new Uint8Array(nx * nz), lo = f * storey, hi = lo + storey - SLAB;
    for (const t of within(lo, hi)) {
      const sx = t.b.x - t.a.x, sy = t.b.y - t.a.y, sz = t.b.z - t.a.z;
      const n = Math.max(1, Math.ceil(Math.hypot(sx, sy, sz) / 0.25));
      for (let s = 0; s <= n; s++) {
        const x = t.a.x + (sx * s) / n, y = t.a.y + (sy * s) / n, z = t.a.z + (sz * s) / n;
        if (y + t.r < lo || y - t.r > hi) continue;
        stamp(mask, x, z, t.r + COLUMN_HALF);
      }
    }
    for (const part of parts) {
      const floor = part.floors[f];
      if (!floor) continue;
      const { a0: ga, b0: gb, g, na, nb, A: u, B: v } = part.grid;
      for (let j = 0; j < nb; j++) {
        for (let i = 0; i < na; i++) {
          if (!floor.mask?.[j * na + i] && !floor.detached?.[j * na + i]) continue;
          // (a column may stand in a hallway's edge, in the line of its wall: only the inside of the hallway is kept clear)
          const at = (p, q) => p >= 0 && q >= 0 && p < na && q < nb && (floor.mask?.[q * na + p] || floor.detached?.[q * na + p]);
          if (!at(i - 1, j) || !at(i + 1, j) || !at(i, j - 1) || !at(i, j + 1)) continue;
          const a = ga + (i + 0.5) * g, b = gb + (j + 0.5) * g;
          stamp(walked[f], a * u[0] + b * v[0], a * u[1] + b * v[1], g * 0.75);
        }
      }
    }
    return mask;
  });
  function stamp(mask, x, z, r) {
    const i0 = Math.max(0, Math.ceil((x - r - ox) / fc)), i1 = Math.min(nx - 1, Math.floor((x + r - ox) / fc));
    const j0 = Math.max(0, Math.ceil((z - r - oz) / fc)), j1 = Math.min(nz - 1, Math.floor((z + r - oz) / fc));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if ((px(i) - x) ** 2 + (pz(j) - z) ** 2 <= r * r) mask[j * nx + i] = 1;
  }

  // the storeys a column at (x, z) of height `high` passes through something on: { tunnels, other (hallways, stairs, lifts) }
  const clashes = (x, z, high) => {
    const i = Math.round((x - ox) / fc), j = Math.round((z - oz) / fc), k = j * nx + i;
    let tunnelled = 0, other = 0;
    for (let f = 0; f < levels.length && f * storey < high - 1; f++) {
      if (ducted[f][k]) tunnelled++;
      else if (walked[f][k] || cores.some((c) => f >= c.s0 && f <= c.s1 && inCore(c, x, z) > 0)) other++;
    }
    return { tunnels: tunnelled, other };
  };
  // is there room for a column here, just inside the walls? (its height is the lowest roof round it)
  const roofOver = (x, z) => Math.min(heightAt(x, z), ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([u, v]) => heightAt(x + u * 0.35, z + v * 0.35)));
  // is a column from the ground to `high` at (x, z) inside the building all the way, with a little room round it?
  const upright = (x, z, high) => {
    if (!massing) return true;
    return [[0, 0], [0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]].every(([u, v]) => {
      const c = massing.crossings(x + u, z + v);
      for (let y = 0.1; y < high - 0.4; y += 0.45) if (!massing.insideAt(c, y)) return false;
      return massing.insideAt(c, Math.max(0.1, high - 0.4));
    });
  };
  const shifts = [];
  for (let u = -SHIFT; u <= SHIFT + 1e-6; u += SHIFT_STEP) for (let v = -SHIFT; v <= SHIFT + 1e-6; v += SHIFT_STEP) shifts.push([u, v, Math.hypot(u, v)]);
  shifts.sort((p, q) => p[2] - q[2]); // (the nearest to its place on the grid first)

  const grid = alongA.map(() => alongB.map(() => null)), columns = [];
  alongA.forEach((a, i) => {
    alongB.forEach((b, j) => {
      const nominal = roofOver(...toWorld(a, b));
      let best = null;
      for (const [u, v, moved] of shifts) {
        const [x, z] = toWorld(a + u, b + v), high = roofOver(x, z);
        // (a column is not moved off a taller part of the building onto a lower one, which would leave the taller part without it)
        if (high < FLOOR_NEEDS || (nominal >= FLOOR_NEEDS && high < nominal - 0.5)) continue;
        if (columns.some((c) => Math.hypot(c.x - x, c.z - z) < 2.5) || !upright(x, z, high)) continue;
        const { tunnels: ducts, other } = clashes(x, z, high), met = ducts + other, score = TUNNEL_WEIGHT * ducts + other + moved * 0.04;
        if (!best || score < best.score) best = { x, z, high, met, ducts, score };
        if (met === 0) break;
      }
      if (best) columns.push((grid[i][j] = best));
    });
  });

  /* ---------- the beams ---------- */

  const members = columns.map((c) => ({ kind: "column", from: [c.x, 0, c.z], to: [c.x, c.high - 0.12, c.z], ...COLUMN }));
  // A beam from p to q at height y (its middle), cut off wherever it would leave the building or meet a stair or a tunnel.
  const beam = (p, q, y, size, level) => {
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (length < 0.4) return;
    const near = within(y - size.depth / 2, y + size.depth / 2);
    const n = Math.max(1, Math.ceil(length / 0.2));
    const at = (s) => [p[0] + ((q[0] - p[0]) * s) / n, p[1] + ((q[1] - p[1]) * s) / n];
    let start = -1;
    for (let s = 0; s <= n + 1; s++) {
      let clear = s <= n;
      if (clear) {
        const [x, z] = at(s);
        clear = heightAt(x, z) >= y + size.depth / 2 &&
          [[0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2]].every(([u, v]) => inside(x + u, y - size.depth / 2, z + v) && inside(x + u, y + size.depth / 2 - 0.05, z + v)) &&
          !(level !== null && cores.some((c) => level > c.s0 && level <= c.s1 && inCore(c, x, z) > 0.02)) &&
          !near.some((t) => tubeDistance(t, x, y, z) < size.width / 2 + 0.05);
      }
      if (clear && start < 0) start = s;
      if (!clear && start >= 0) {
        const from = at(start), to = at(s - 1);
        if (Math.hypot(to[0] - from[0], to[1] - from[1]) > 0.35) members.push({ kind: size === JOIST ? "joist" : "beam", from: [from[0], y, from[1]], to: [to[0], y, to[1]], ...size });
        start = -1;
      }
    }
  };
  // every level a pair or a bay of columns reaches: under each plate, and under the roof over them
  const decks = (high) => {
    const out = levels.filter((f) => f > 0 && f * storey <= high - 1.5).map((f) => ({ under: f * storey - SLAB, level: f }));
    if (!out.length || high - 0.15 - out[out.length - 1].under > 1.2) out.push({ under: high - 0.15, level: null });
    return out;
  };
  const xz = (c) => [c.x, c.z];
  alongA.forEach((_, i) => {
    alongB.forEach((_, j) => {
      const c = grid[i][j];
      if (!c) return;
      for (const next of [grid[i + 1]?.[j], grid[i][j + 1]]) {
        if (!next) continue;
        for (const { under, level } of decks(Math.min(c.high, next.high))) beam(xz(c), xz(next), under - BEAM.depth / 2, BEAM, level);
      }
      // the bay: lighter beams across it, spanning along the A axis between the beams on its two sides
      const d = grid[i + 1]?.[j], e = grid[i][j + 1], far = grid[i + 1]?.[j + 1];
      if (!d || !e || !far) return;
      const across = Math.max(Math.hypot(e.x - c.x, e.z - c.z), Math.hypot(far.x - d.x, far.z - d.z));
      const count = Math.ceil(across / JOIST_SPACING) - 1;
      for (let k = 1; k <= count; k++) {
        const t = k / (count + 1), mix = (p, q) => [p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t];
        for (const { under, level } of decks(Math.min(c.high, d.high, e.high, far.high))) beam(mix(c, e), mix(d, far), under - JOIST.depth / 2, JOIST, level);
      }
    });
  });

  return {
    plates: position, // a flat array of triangles
    members, // [{ kind: "column" | "beam" | "joist", from: [x, y, z], to, depth, width }]
    stats: {
      floors: levels.length, area, openedFloors: openings,
      columns: columns.length, clearColumns: columns.filter((c) => c.met === 0).length,
      columnClashes: columns.reduce((s, c) => s + c.met, 0),
      clearOfTunnels: columns.filter((c) => c.ducts === 0).length,
      tunnelClashes: columns.reduce((s, c) => s + c.ducts, 0),
      beams: members.filter((m) => m.kind !== "column").length,
    },
  };
}

// Adds a plate's triangles to `out`: the part of the grid where `field` is below zero, from height `lower` to `upper`, its
// outline running smoothly between the grid's points. Returns its area (m2).
function slab(out, field, nx, nz, ox, oz, fc, lower, upper) {
  let area = 0;
  const tri = (a, b, c) => out.push(...a, ...b, ...c);
  // a flat piece (corners in order) as the plate's top and underside
  const faces = (pts) => {
    for (let n = 1; n + 1 < pts.length; n++) {
      tri([pts[0][0], upper, pts[0][1]], [pts[n + 1][0], upper, pts[n + 1][1]], [pts[n][0], upper, pts[n][1]]);
      tri([pts[0][0], lower, pts[0][1]], [pts[n][0], lower, pts[n][1]], [pts[n + 1][0], lower, pts[n + 1][1]]);
    }
    let twice = 0;
    pts.forEach((p, n) => { const q = pts[(n + 1) % pts.length]; twice += p[0] * q[1] - q[0] * p[1]; });
    area += Math.abs(twice) / 2;
  };
  const rect = (i0, i1, j) => faces([[ox + i0 * fc, oz + j * fc], [ox + i1 * fc, oz + j * fc], [ox + i1 * fc, oz + (j + 1) * fc], [ox + i0 * fc, oz + (j + 1) * fc]]);
  for (let j = 0; j + 1 < nz; j++) {
    let run = -1; // the first of a run of whole squares, drawn as one piece
    for (let i = 0; i + 1 < nx; i++) {
      const corners = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]].map(([a, b]) => ({ x: ox + a * fc, z: oz + b * fc, v: field[b * nx + a] }));
      const inside = corners.filter((c) => c.v < 0).length;
      if (inside === 4) { if (run < 0) run = i; continue; }
      if (run >= 0) { rect(run, i, j); run = -1; }
      if (!inside) continue;
      const pts = [], cuts = [];
      for (let n = 0; n < 4; n++) {
        const p = corners[n], q = corners[(n + 1) % 4];
        if (p.v < 0) pts.push([p.x, p.z]);
        if (p.v < 0 !== q.v < 0) {
          const t = p.v / (p.v - q.v), at = [p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t];
          pts.push(at);
          cuts.push({ at, leaving: p.v < 0 });
        }
      }
      if (pts.length < 3) continue;
      faces(pts);
      // the plate's edge, along each stretch of the outline
      for (let n = 0; n < cuts.length; n++) {
        if (!cuts[n].leaving) continue;
        const p = cuts[n].at, q = cuts[(n + 1) % cuts.length].at;
        tri([p[0], upper, p[1]], [q[0], upper, q[1]], [q[0], lower, q[1]]);
        tri([p[0], upper, p[1]], [q[0], lower, q[1]], [p[0], lower, p[1]]);
      }
    }
    if (run >= 0) rect(run, nx - 1, j);
  }
  return area;
}
