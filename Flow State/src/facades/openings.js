// MODEL (facades): the shape each tunnel opening takes under a facade, taken from the facade's own pattern so that the panels
// themselves frame it. No scene code. Both the skin (which is cut in this shape, see erosion/exterior/skinShell.js) and the
// panels (panels.js, which leave the shape free) use it, so the two always meet.
//
//   triangular:  small triangles of the facade's grid round the tunnel; the shades over it open wide
//   organic:     one cell of the web, larger than the rest, with the ribs flowing round it
// (The cubic, fins and hexagonal facades leave the openings their own shape.)
//
// A shape is worked out on its wall, in (u along it, y up) as in walls.js. Every one holds at least the tunnel itself.
import { STOREY } from "../erosion/exterior/tunnels.js";
import { hash } from "./noise.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const CLEAR = 0.3; // m: kept between a tunnel and the edge of its opening, at the least
const OVERLAP = 0.07; // m: neighbouring panels of an opening are taken to overlap this much, so that no sliver is left between them

/* ---------- the grids of the three panel facades ---------- */

// Each grid: the panels near (u, y) within `reach`, as { key, corners: [[u, y]...] (anticlockwise or not), extra }.
// The same functions lay out the panels themselves, so an opening is made of exactly whole panels.
// A grid of equal triangles with rows h high.
function triangles(h) {
  const a = h / 0.866;
  return {
    h, a,
    // the two triangles (pointing up, pointing down) of place k in a row
    cells(row, k) {
      const y0 = row * h, y1 = y0 + h, u = (((row % 2) + 2) % 2) * (a / 2) + k * a;
      return [
        { key: `${row},${k},0`, corners: [[u, y0], [u + a, y0], [u + a / 2, y1]] },
        { key: `${row},${k},1`, corners: [[u + a / 2, y1], [u + 1.5 * a, y1], [u + a, y0]] },
      ];
    },
    near(u, y, reach) {
      const out = [];
      for (let row = Math.floor((y - reach) / h); row <= Math.floor((y + reach) / h); row++) {
        for (let k = Math.floor((u - reach) / a) - 2; k <= Math.floor((u + reach) / a) + 1; k++) out.push(...this.cells(row, k));
      }
      return out;
    },
  };
}

// The triangular facade's grid. A row's height: at the smallest size (60%) three rows to a storey, two at 100%, and from there
// growing with the size.
export const triangleGrid = (size) => triangles(size >= 1 ? (STOREY / 2) * size : STOREY / 3 + ((size - 0.6) / 0.4) * (STOREY / 6));
// The signed distance to a convex polygon (negative inside).
function polygonDistance(corners) {
  const n = corners.length;
  let area = 0;
  for (let i = 0; i < n; i++) area += corners[i][0] * corners[(i + 1) % n][1] - corners[(i + 1) % n][0] * corners[i][1];
  const turn = area > 0 ? 1 : -1;
  const edges = corners.map((p, i) => {
    const q = corners[(i + 1) % n], ex = q[0] - p[0], ey = q[1] - p[1], len = Math.hypot(ex, ey) || 1;
    return { p, ex, ey, len2: len * len, nx: (turn * ey) / len, ny: (-turn * ex) / len };
  });
  return (u, y) => {
    let inside = -Infinity, away = Infinity;
    for (const e of edges) {
      const du = u - e.p[0], dy = y - e.p[1];
      inside = Math.max(inside, du * e.nx + dy * e.ny);
      const t = clamp((du * e.ex + dy * e.ey) / e.len2, 0, 1);
      away = Math.min(away, Math.hypot(du - t * e.ex, dy - t * e.ey));
    }
    return inside <= 0 ? inside : away;
  };
}

const RECESS_ROW = STOREY / 2; // m: about how high the small triangles are that a recess is made of

// The openings under the triangular facade, whose shades all stay in place and are all one size; those over an opening open
// wide. The recess in the wall behind keeps close to the tunnel however large the shades are: it is made of whole triangles of
// a finer grid that divides each shade's triangle evenly (the shades' own size, when they are small).
function triangleOpenings(size, openings) {
  const shades = triangleGrid(size), fine = triangles(shades.h / Math.max(1, Math.round(shades.h / RECESS_ROW)));
  for (const o of openings) {
    const need = Math.max(o.r + CLEAR, 1.1);
    const under = (grid) => grid.near(o.u, o.y, need + 2 * grid.a).map((c) => ({ ...c, d: polygonDistance(c.corners) })).filter((c) => c.d(o.u, o.y) < need);
    const recess = under(fine);
    Object.assign(o, {
      cells: under(shades).map((c) => c.key), // the shades over the opening
      bound: Math.max(need, ...recess.flatMap((c) => c.corners.map(([u, y]) => Math.hypot(u - o.u, y - o.y)))),
      sdf: (u, y) => recess.reduce((best, c) => Math.min(best, c.d(u, y) - OVERLAP), Infinity),
    });
  }
}
/* ---------- the organic web ---------- */

// The way round a massing's four walls: how far along it a point u of side k is (sides +x, -x, +z, -z, as in walls.js, and
// half the footprint each way, as laid out by its frame). Two walls that meet give the same place at their shared corner,
// or places a whole way round apart.
export function ringOf({ halfX, halfZ }) {
  const start = [halfZ, 3 * halfZ + 2 * halfX, 2 * halfZ + halfX, 4 * halfZ + 3 * halfX], way = [1, -1, -1, 1];
  return { length: 4 * (halfX + halfZ), along: (k, u) => start[k] + way[k] * u };
}

// The web of one massing, wrapped right round it so that it carries on round every corner: cells round points scattered on a
// loose grid and bent by a slow warp, with one larger cell for each opening ({ s: along the ring, y, r }) in place of the
// points close to it. In (s along the ring, y up): rib(s, y) is below 0 inside a rib; hole(i, s, y) below 0 inside
// opening i; swell(s, y) is 0 to 1, how far the ribs stand out there. All repeat after one way round.
export function web(size, massing, length, openings) {
  const columns = Math.max(3, Math.round(length / (4.4 * size))), cw = length / columns, ch = 3.9 * size, seed = massing * 69.2;
  const turns = (scale) => (2 * Math.PI * Math.max(1, Math.round(length * scale / (2 * Math.PI)))) / length; // (waves that fit a whole number of times round)
  const k1 = turns(1 / (5.1 * size)), k2 = turns(1 / (3.9 * size)), kThick = turns(0.19), kSwell = turns(0.23);
  const gap = (d) => d - length * Math.round(d / length); // the shorter way round between two places
  const warp = (s, y) => [
    s + size * 1.5 * Math.sin(y / (2.7 * size) + 1.3 * Math.sin(k1 * s) + seed),
    y + size * 1.1 * Math.sin(k2 * s + seed * 0.7),
  ];
  const thick = (s, y) => size * (0.27 + 0.2 * (0.5 + 0.5 * Math.sin(kThick * s + y * 0.27 + seed)));
  // an opening's own point, and how far its cell is to reach beyond an ordinary one's
  const own = openings.map((o) => { const [s, y] = warp(o.s, o.y); return { s, y, grow: Math.max(0, o.r + CLEAR + 0.5 - 0.38 * Math.min(cw, ch)), keep: o.r + CLEAR + 0.25 * Math.min(cw, ch) }; });
  const seeds = new Map();
  const seedAt = (i, j) => {
    const key = `${i},${j}`;
    let p = seeds.get(key);
    if (p === undefined) {
      const m = ((i % columns) + columns) % columns; // (the same points again each time round)
      p = [(i + 0.5 * (j & 1) + 0.12 + 0.76 * hash(m + seed, j)) * cw, (j + 0.12 + 0.76 * hash(j + 31, m + seed)) * ch];
      if (own.some((q) => Math.hypot(gap(p[0] - q.s), p[1] - q.y) < q.keep + 0.3 * Math.min(cw, ch))) p = null; // (an opening's cell takes its place)
      seeds.set(key, p);
    }
    return p;
  };
  // the nearest two points to (s, y): [distance, which opening or -1] and the second distance
  const nearest = (s, y) => {
    const [ws, wy] = warp(s, y), j0 = Math.floor(wy / ch), i0 = Math.floor(ws / cw);
    let first = Infinity, second = Infinity, which = -1;
    const take = (d, who) => {
      if (d < first) { second = first; first = d; which = who; } else if (d < second) second = d;
    };
    for (let j = j0 - 2; j <= j0 + 2; j++) {
      for (let i = i0 - 2; i <= i0 + 2; i++) {
        const p = seedAt(i, j);
        if (p) take(Math.hypot(ws - p[0], (wy - p[1]) * 1.08), -1);
      }
    }
    own.forEach((q, n) => take(Math.hypot(gap(ws - q.s), (wy - q.y) * 1.08) - q.grow, n));
    return { first, second, which };
  };
  const clearance = (i, s, y) => Math.hypot(gap(s - openings[i].s), y - openings[i].y) - openings[i].r - CLEAR; // (never a rib across the tunnel)
  return {
    rib(s, y) {
      const { first, second } = nearest(s, y);
      let g = (second - first) / 2 - thick(s, y);
      for (let i = 0; i < openings.length; i++) g = Math.max(g, -clearance(i, s, y));
      return g;
    },
    hole(i, s, y) {
      const { first, second, which } = nearest(s, y);
      // inside the opening's cell, as far as the ribs' inner edge; outside it, how far past that edge
      const cell = which === i ? thick(s, y) - (second - first) / 2 : thick(s, y) + 0.3;
      return Math.min(cell, clearance(i, s, y));
    },
    swell: (s, y) => 0.5 + 0.5 * Math.sin(kSwell * s + 1.6 * Math.sin(y * 0.31 + seed)),
  };
}

// Gives the openings of a massing's walls ([{ k: which side, openings }]) their shapes in its web, and returns the web.
export function shapeWeb(size, massing, frame, walls) {
  const ring = ringOf(frame);
  const all = walls.flatMap(({ k, openings }) => openings.map((o) => ({ o, k, s: ring.along(k, o.u), y: o.y, r: o.r })));
  const w = web(size, massing, ring.length, all);
  all.forEach(({ o, k, s }, i) => {
    const hole = (u, y) => w.hole(i, ring.along(k, u), y);
    let bound = o.r + CLEAR;
    for (let a = 0; a < 24; a++) { // how far the cell reaches
      const cos = Math.cos((a / 24) * Math.PI * 2), sin = Math.sin((a / 24) * Math.PI * 2);
      let t = 0;
      while (t < 6 && hole(o.u + cos * (t + 0.2), o.y + sin * (t + 0.2)) < 0) t += 0.2;
      bound = Math.max(bound, t + 0.2);
    }
    Object.assign(o, { cells: [], bound, sdf: (u, y) => Math.max(hole(u, y), Math.hypot(u - o.u, y - o.y) - bound) });
  });
  return w;
}
// Gives every opening of a wall ({ u, y, r }) its shape under the triangular facade (the organic one's web goes round the
// whole massing: see shapeWeb): adds { sdf(u, y) (below 0 inside), bound (how far it reaches from (u, y)), cells (the keys
// of the shades over it) }.
export function shapeOpenings(size, openings) {
  triangleOpenings(size, openings);
}
