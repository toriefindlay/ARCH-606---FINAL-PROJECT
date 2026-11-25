// MODEL (facades): the outside walls of the massings, as places to put panels on. No scene code.
//
// Each massing has four sides along its own directions. For every side, the surfaces facing it (the massing as placed, or the
// skin) are drawn into a grid seen from straight in front, which remembers how far out the outermost surface is at
// every point. A panel is designed flat, in (u along the wall, y up, d out from the wall), and each of its corners is then set
// on the surface found there, so panels sit on flat, stepped and curved walls alike.

import { shapeOpenings, shapeWeb } from "./openings.js";

const CELL = 0.3; // m: the grid on each side
const MAX_CELLS = 120000; // per side (made coarser above that)
const STEEP = 0.6; // surfaces leaning more than this (the y part of their normal) are roofs and ledges, not walls

// How a massing sees the world: local(x, z) is a point in its own directions, from its middle.
function sideOf(f) {
  const cos = Math.cos(f.turn), sin = Math.sin(f.turn);
  return { f, cos, sin, local: (x, z) => { const dx = x - f.x, dz = z - f.z; return [dx * cos - dz * sin, dx * sin + dz * cos]; } };
}

// the massing whose footprint a point is in or nearest to
function nearestSide(sides, x, z) {
  let best = null, bd = Infinity;
  for (const s of sides) {
    const [lx, lz] = s.local(x, z), qx = Math.abs(lx) - s.f.halfX, qz = Math.abs(lz) - s.f.halfZ;
    const away = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
    if (away < bd) { bd = away; best = s; }
  }
  return best;
}

// Puts the tunnels' openings (tunnels.js openings()) on their walls and gives each the shape of the facade `style`
// (openings.js). This needs only where the massings stand, not their surfaces, so the skin can be cut in these shapes
// before it exists. Returns { byWall: Map of a wall's id to its openings, webs: Map of a massing's number to its web
// (organic only), each: for every tunnel opening in the order given,
// { opening (the shaped one it belongs to), tx, tz (the world direction along its wall, the way u grows) } }.
export function placeOpenings(frames, list, style, size) {
  const sides = frames.map(sideOf), byWall = new Map();
  const each = list.map((o) => {
    const s = nearestSide(sides, o.x, o.z);
    const lnx = o.nx * s.cos - o.nz * s.sin, lnz = o.nx * s.sin + o.nz * s.cos, endWall = Math.abs(lnx) > Math.abs(lnz);
    const sign = (endWall ? lnx : lnz) >= 0 ? 1 : -1, id = sides.indexOf(s) * 4 + (endWall ? 0 : 2) + (sign > 0 ? 0 : 1);
    const [lx, lz] = s.local(o.x, o.z), u = endWall ? lz : lx;
    if (!byWall.has(id)) byWall.set(id, []);
    // (two tubes can end at all but the same place: they share one opening)
    let opening = byWall.get(id).find((q) => Math.hypot(q.u - u, q.y - o.y) < 0.6);
    if (opening) opening.r = Math.max(opening.r, o.r);
    else byWall.get(id).push((opening = { u, y: o.y, r: o.r }));
    return { opening, tx: endWall ? s.sin : s.cos, tz: endWall ? s.cos : -s.sin };
  });
  const webs = new Map();
  if (style === "organic") {
    frames.forEach((f, which) => {
      const own = [0, 1, 2, 3].map((k) => ({ k, openings: byWall.get(which * 4 + k) ?? [] }));
      if (own.some((w) => w.openings.length)) webs.set(which, shapeWeb(size, which, f, own));
    });
  } else {
    for (const openings of byWall.values()) shapeOpenings(size, openings);
  }
  return { byWall, webs, each };
}

// frames: model3dm.js getMassFrames(). triangles: a function (visit) that calls visit(ax, ay, az, bx, by, bz, cx, cy, cz) for
// every triangle of the outside surfaces, in world metres. placed: placeOpenings(), if there are tunnels. Returns the walls.
export function readWalls(frames, triangles, { byWall = new Map(), webs = new Map() } = {}) {
  // (found: triangles as [u, y, w] x 3, for the sides +x, -x, +z, -z)
  const sides = frames.map((f) => ({ ...sideOf(f), found: [[], [], [], []] }));

  triangles((ax, ay, az, bx, by, bz, cx, cy, cz) => {
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, len = Math.hypot(nx, ny, nz);
    if (len < 1e-9 || Math.abs(ny) > STEEP * len) return;
    const s = nearestSide(sides, (ax + bx + cx) / 3, (az + bz + cz) / 3);
    const p = [s.local(ax, az), s.local(bx, bz), s.local(cx, cz)], ys = [ay, by, cy];
    const lnx = nx * s.cos - nz * s.sin, lnz = nx * s.sin + nz * s.cos, endWall = Math.abs(lnx) > Math.abs(lnz);
    const axis = endWall ? 0 : 1, mid = (p[0][axis] + p[1][axis] + p[2][axis]) / 3, sign = mid >= 0 ? 1 : -1;
    s.found[axis * 2 + (sign > 0 ? 0 : 1)].push(p.flatMap((q, i) => [q[1 - axis], ys[i], sign * q[axis]]));
  });

  const walls = [];
  sides.forEach((s, which) => {
    s.found.forEach((list, k) => {
      if (!list.length) return;
      const wall = makeWall(s, k < 2, k % 2 ? -1 : 1, list);
      if (wall) { Object.assign(wall, { id: which * 4 + k, massing: which, k, web: webs.get(which) ?? null }); walls.push(wall); }
    });
  });

  for (const wall of walls) {
    wall.openings = byWall.get(wall.id) ?? [];
    wall.tunnelled = byWall.size > 0; // (are there tunnel openings anywhere?)
    wall.taken = new Set(wall.openings.flatMap((o) => o.cells)); // the panels the openings take the place of
    for (const o of wall.openings) o.faceRound = faceRound(wall, o);
  }
  joinCorners(walls);
  for (const wall of walls) bridge(wall);
  return walls;
}

// Gives a wall carried(u, y): how far out its face is at any point of it, never missing. Where there is an opening, no surface,
// or one far behind the face, it is bridged across from the face all round, however many openings lie together. (Worked
// out when first asked for.)
const BRIDGE_CELL = 0.5; // m
function bridge(wall) {
  let grid = null;
  const make = () => {
    const nu = Math.max(2, Math.ceil((wall.u1 - wall.u0) / BRIDGE_CELL) + 1), ny = Math.max(2, Math.ceil(wall.y1 / BRIDGE_CELL) + 1);
    const du = (wall.u1 - wall.u0) / (nu - 1), dy = wall.y1 / (ny - 1), value = new Float32Array(nu * ny).fill(NaN);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nu; i++) {
        const u = wall.u0 + i * du, y = j * dy;
        const open = wall.openings.some((o) => Math.abs(u - o.u) < o.bound + 0.6 && Math.abs(y - o.y) < o.bound + 0.6 && o.sdf(u, y) < 0.45);
        const at = open ? null : wall.depth(u, y);
        if (at !== null) value[j * nu + i] = at;
      }
    }
    const read = Array.from(value).filter((v) => !Number.isNaN(v)).sort((p, q) => p - q);
    const usual = read.length ? read[read.length >> 1] : wall.endWall ? wall.side.f.halfX : wall.side.f.halfZ;
    for (let k = 0; k < value.length; k++) if (value[k] < usual - 3) value[k] = NaN; // (a surface seen far behind the face)
    const gaps = [];
    for (let k = 0; k < value.length; k++) if (Number.isNaN(value[k])) gaps.push(k);
    const around = (k) => {
      const i = k % nu, j = (k - i) / nu;
      return [i > 0 && k - 1, i < nu - 1 && k + 1, j > 0 && k - nu, j < ny - 1 && k + nu].filter((q) => q !== false);
    };
    // the gaps are filled inwards from their edges, then smoothed
    for (let left = gaps.slice(); left.length;) {
      const filled = [];
      for (const k of left) {
        const known = around(k).filter((q) => !Number.isNaN(value[q]));
        if (known.length) filled.push([k, known.reduce((sum, q) => sum + value[q], 0) / known.length]);
      }
      if (!filled.length) { for (const k of left) value[k] = usual; break; }
      for (const [k, v] of filled) value[k] = v;
      left = left.filter((k) => Number.isNaN(value[k]));
    }
    for (let pass = 0; pass < 30; pass++) for (const k of gaps) { const n = around(k); value[k] = n.reduce((sum, q) => sum + value[q], 0) / n.length; }
    return { nu, ny, du, dy, value };
  };
  wall.carried = (u, y) => {
    grid ??= make();
    const { nu, ny, du, dy, value } = grid;
    const fu = Math.min(nu - 1, Math.max(0, (u - wall.u0) / du)), fv = Math.min(ny - 1, Math.max(0, y / dy));
    const i = Math.min(nu - 2, Math.floor(fu)), j = Math.min(ny - 2, Math.floor(fv)), tu = fu - i, tv = fv - j, k = j * nu + i;
    return (value[k] * (1 - tu) + value[k + 1] * tu) * (1 - tv) + (value[k + nu] * (1 - tu) + value[k + nu + 1] * tu) * tv;
  };
}

// How far out a wall's face is beside its edge at `u` (`end`: which way the edge faces). Right on the edge the surface can be
// bevelled or rounded off, which would set the corner too far in, so it is looked for a little way along the wall too, and
// the outermost reading taken (which also passes over an opening cut there).
function faceBy(wall, u, end, y) {
  let out = null;
  for (const back of [0, 0.6, 1.2, 1.8]) {
    const at = wall.depth(u - end * back, y);
    if (at !== null && (out === null || at > out)) out = at;
  }
  return out;
}

// Gives every wall corner(y, end): where its edge at that end (+1: greatest u, -1: least) meets the wall round the corner at
// height y, as { U (how far along this wall, out from its middle), D (how far out this wall's surface is there) }, or null if
// the walls do not meet at the footprint's corner. Both walls of a corner share the one line.
const CORNER_REACH = 2.5; // m: how far from the footprint's corner the walls may meet
const CORNER_ODD = 0.8; // m: a reading this far from the usual one is not the corner (an opening has cut it away there)
const CORNER_STEP = 0.5; // m: the heights the line is read at
function joinCorners(walls) {
  const byId = new Map(walls.map((w) => [w.id, w]));
  const lines = new Map(); // "wall id, end" -> (y) => { U, D }
  for (const wall of walls) {
    const { halfX, halfZ } = wall.side.f;
    wall.nominal = wall.endWall ? halfZ : halfX; // half the length of this side, by the footprint
    wall.corner = (y, end) => lines.get(`${wall.id},${end}`)?.(y) ?? null;
  }
  for (const wall of walls) {
    if (!wall.endWall) continue; // (every corner has one wall of each kind: it is read once, from this one)
    const { halfX, halfZ } = wall.side.f;
    for (const end of [1, -1]) {
      // the wall round this corner: across the other way, facing the way this edge points; it meets us at its end on our side
      const next = byId.get(wall.massing * 4 + 2 + (end > 0 ? 0 : 1));
      if (!next) continue;
      const rows = Math.max(1, Math.ceil(Math.max(wall.y1, next.y1) / CORNER_STEP)), read = [];
      let reach = 0; // the heights at which both walls' edges come to the footprint's corner
      for (let j = 0; j <= rows; j++) {
        const y = Math.max(0.15, j * CORNER_STEP), mine = wall.span(y), theirs = next.span(y);
        let at = null;
        if (mine && theirs) {
          const a = mine[end > 0 ? 1 : 0], b = theirs[wall.sign > 0 ? 1 : 0];
          const atA = faceBy(wall, a, end, y), atB = faceBy(next, b, wall.sign, y);
          if (Math.abs(end * a - halfZ) < CORNER_REACH && Math.abs(wall.sign * b - halfX) < CORNER_REACH) reach++;
          if (atA !== null && atB !== null) {
            const U = atB, D = atA; // (the corner lies where the two faces, carried on, would cross)
            if (Math.abs(U - halfZ) < CORNER_REACH && Math.abs(D - halfX) < CORNER_REACH) at = { U, D };
          }
        }
        read.push(at);
      }
      let found = read.filter(Boolean);
      if (found.length < 0.15 * read.length) {
        if (reach < 0.5 * read.length) continue; // (the walls do not meet here, as on an L-shaped massing)
        found = []; // (openings have cut away nearly all of this edge: the footprint says where it is)
      }
      const usual = (key, footprint) => (found.length ? found.map((c) => c[key]).sort((p, q) => p - q)[found.length >> 1] : footprint);
      const U = usual("U", halfZ), D = usual("D", halfX);
      const good = read.map((c) => (found.length && c && Math.abs(c.U - U) < CORNER_ODD && Math.abs(c.D - D) < CORNER_ODD ? c : null));
      // where it was cut away, the line is carried across from the good readings above and below
      const line = good.map((c, j) => {
        if (c) return c;
        let lo = j - 1, hi = j + 1;
        while (lo >= 0 && !good[lo]) lo--;
        while (hi < good.length && !good[hi]) hi++;
        const p = good[lo], q = good[hi];
        if (!p || !q) return p ?? q ?? { U, D };
        const t = (j - lo) / (hi - lo);
        return { U: p.U + (q.U - p.U) * t, D: p.D + (q.D - p.D) * t };
      });
      const at = (y) => {
        const t = Math.min(line.length - 1, Math.max(0, y / CORNER_STEP)), j = Math.min(line.length - 2, Math.floor(t)), f = t - j;
        return { U: line[j].U + (line[j + 1].U - line[j].U) * f, D: line[j].D + (line[j + 1].D - line[j].D) * f };
      };
      lines.set(`${wall.id},${end}`, at);
      lines.set(`${next.id},${wall.sign}`, (y) => { const c = at(y); return { U: c.D, D: c.U }; }); // (seen from the other wall)
    }
  }
}
// How far out the face is round an opening, by angle from its middle: read just outside its edge, and evened out.
function faceRound(wall, o) {
  const STEPS = 32, raw = [];
  for (let i = 0; i < STEPS; i++) {
    const cos = Math.cos((i / STEPS) * Math.PI * 2), sin = Math.sin((i / STEPS) * Math.PI * 2);
    let t = 0.4;
    while (t < o.bound + 0.4 && o.sdf(o.u + cos * t, o.y + sin * t) < 0.45) t += 0.2;
    raw.push(wall.depth(o.u + cos * t, Math.min(wall.y1 - 0.05, Math.max(0.15, o.y + sin * t))));
  }
  const found = raw.filter((d) => d !== null).sort((p, q) => p - q);
  if (!found.length) return () => null;
  const middle = found[found.length >> 1];
  // (a reading far from the rest is another surface seen past an edge: the middle one stands in for it)
  const level = raw.map((d) => (d === null || Math.abs(d - middle) > 1.5 ? middle : d));
  const even = level.map((_, i) => (level[(i + STEPS - 1) % STEPS] + 2 * level[i] + level[(i + 1) % STEPS]) / 4);
  return (angle) => {
    const t = ((((angle / (Math.PI * 2)) % 1) + 1) % 1) * STEPS, i = Math.floor(t) % STEPS;
    return even[i] + (even[(i + 1) % STEPS] - even[i]) * (t - Math.floor(t));
  };
}
function makeWall(side, endWall, sign, list) {
  let u0 = Infinity, u1 = -Infinity, y1 = -Infinity;
  for (const t of list) for (let i = 0; i < 9; i += 3) { u0 = Math.min(u0, t[i]); u1 = Math.max(u1, t[i]); y1 = Math.max(y1, t[i + 1]); }
  const y0 = 0;
  if (u1 - u0 < 1.5 || y1 - y0 < 1.5) return null;
  const g = Math.max(CELL, Math.sqrt(((u1 - u0) * (y1 - y0)) / MAX_CELLS));
  const nu = Math.ceil((u1 - u0) / g) + 1, ny = Math.ceil((y1 - y0) / g) + 1;
  let grid = new Float32Array(nu * ny).fill(-Infinity);
  const put = (i, j, w) => { if (i >= 0 && j >= 0 && i < nu && j < ny && w > grid[j * nu + i]) grid[j * nu + i] = w; };
  // the least and greatest u of the surface along every row of the grid, measured on the triangles themselves
  const lows = new Float32Array(ny).fill(Infinity), highs = new Float32Array(ny).fill(-Infinity);
  for (const t of list) {
    const least = Math.min(t[1], t[4], t[7]), most = Math.max(t[1], t[4], t[7]);
    for (let j = Math.max(0, Math.ceil((least - y0) / g - 1e-4)); j <= Math.min(ny - 1, Math.floor((most - y0) / g + 1e-4)); j++) {
      const y = y0 + j * g;
      for (let a = 0; a < 9; a += 3) {
        const b = (a + 3) % 9, rise = t[b + 1] - t[a + 1];
        const ends = Math.abs(rise) < 1e-6 ? (Math.abs(y - t[a + 1]) < 1e-3 ? [t[a], t[b]] : []) : [(y - t[a + 1]) / rise].filter((q) => q >= -1e-3 && q <= 1.001).map((q) => t[a] + q * (t[b] - t[a]));
        for (const u of ends) { lows[j] = Math.min(lows[j], u); highs[j] = Math.max(highs[j], u); }
      }
    }
  }

  // the grid's points are at u0 + i * g, y0 + j * g: every point a triangle covers takes its distance out, the outermost winning
  for (const t of list) {
    const au = (t[0] - u0) / g, av = (t[1] - y0) / g, bu = (t[3] - u0) / g, bv = (t[4] - y0) / g, cu = (t[6] - u0) / g, cv = (t[7] - y0) / g;
    put(Math.round(au), Math.round(av), t[2]); put(Math.round(bu), Math.round(bv), t[5]); put(Math.round(cu), Math.round(cv), t[8]);
    const det = (bu - au) * (cv - av) - (cu - au) * (bv - av);
    if (Math.abs(det) < 1e-9) continue;
    for (let j = Math.ceil(Math.min(av, bv, cv)); j <= Math.floor(Math.max(av, bv, cv)); j++) {
      for (let i = Math.ceil(Math.min(au, bu, cu)); i <= Math.floor(Math.max(au, bu, cu)); i++) {
        const q = ((i - au) * (cv - av) - (cu - au) * (j - av)) / det, r = ((bu - au) * (j - av) - (i - au) * (bv - av)) / det;
        if (q >= -0.01 && r >= -0.01 && q + r <= 1.01) put(i, j, t[2] + q * (t[5] - t[2]) + r * (t[8] - t[2]));
      }
    }
  }
  // pin-holes between small triangles are filled from their neighbours
  const filled = Float32Array.from(grid);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nu; i++) {
      if (grid[j * nu + i] > -Infinity) continue;
      let sum = 0, n = 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di, b = j + dj;
        if (a >= 0 && b >= 0 && a < nu && b < ny && grid[b * nu + a] > -Infinity) { sum += grid[b * nu + a]; n++; }
      }
      if (n >= 2) filled[j * nu + i] = sum / n;
    }
  }
  grid = filled;

  const { f, cos, sin } = side;
  const wall = {
    side, endWall, sign, u0, u1, y0, y1, openings: [], taken: new Set(),
    out: endWall ? [sign * cos, -sign * sin] : [sign * sin, sign * cos], // the way out (world x, z)
    // how far out (from the massing's middle) the surface is at (u, y), or null where there is none
    depth(u, y) {
      const fu = (Math.min(u1, Math.max(u0, u)) - u0) / g, fv = (Math.min(y1, Math.max(y0, y)) - y0) / g;
      const i = Math.floor(fu), j = Math.floor(fv), tu = fu - i, tv = fv - j;
      let sum = 0, weight = 0;
      for (const [di, dj, w] of [[0, 0, (1 - tu) * (1 - tv)], [1, 0, tu * (1 - tv)], [0, 1, (1 - tu) * tv], [1, 1, tu * tv]]) {
        const a = Math.min(nu - 1, i + di), b = Math.min(ny - 1, j + dj), v = grid[b * nu + a];
        if (v > -Infinity) { sum += v * (w + 1e-6); weight += w + 1e-6; }
      }
      return weight > 0.2 ? sum / weight : null;
    },
    // the least and greatest u of the surface at height y, or null where there is none
    span(y) {
      const j = Math.min(ny - 1, Math.max(0, Math.round((y - y0) / g)));
      return highs[j] > lows[j] ? [lows[j], highs[j]] : null;
    },
    // the world point `d` out from a surface at distance `at`
    point(u, y, at, d) {
      const w = sign * (at + d), lx = endWall ? w : u, lz = endWall ? u : w;
      return [f.x + lx * cos + lz * sin, y, f.z - lx * sin + lz * cos];
    },
    // the face as panels see it: as depth(), but carried across the openings and their edges, so that the panels round an
    // opening stay out on the face instead of dipping into it
    face(u, y) {
      for (const o of wall.openings) {
        if (Math.abs(u - o.u) < o.bound + 0.6 && Math.abs(y - o.y) < o.bound + 0.6 && o.sdf(u, y) < 0.45) return o.faceRound(Math.atan2(y - o.y, u - o.u));
      }
      return wall.depth(u, y);
    },
  };
  return wall;
}
