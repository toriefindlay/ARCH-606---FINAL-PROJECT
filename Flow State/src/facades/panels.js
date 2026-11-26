// MODEL (facades): the triangular and organic panels, as triangles. No scene code. (The other three are in plainPanels.js.)
//
// Each is designed on a wall (walls.js) in (u along it, y up, d out from it), in metres, and `size` makes it all bigger or
// smaller. Each tunnel opening takes a shape from the facade's own pattern (openings.js): the panels leave it free and so
// frame it themselves.
import { STOREY } from "../erosion/exterior/tunnels.js";
import { triangleGrid, ringOf, web } from "./openings.js";
import { hash } from "./noise.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (t) => { const u = clamp(t, 0, 1); return u * u * (3 - 2 * u); };
const hex = (h) => { // sRGB to the linear colours three.js lights with
  const c = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return [c((h >> 16) & 255), c((h >> 8) & 255), c(h & 255)];
};
const shade = (colour, k) => colour.map((v) => v * k);

// Collects triangles.
export function createMeshData() {
  const position = [], color = [];
  const tri = (a, b, c, colour) => { position.push(...a, ...b, ...c); color.push(...colour, ...colour, ...colour); };
  return { position, color, tri, quad: (a, b, c, d, colour) => { tri(a, b, c, colour); tri(a, c, d, colour); } };
}

// A straight bar from p to q ([u, y, d]), `width` across the wall's plane and `thick` out from it.
function bar(out, place, p, q, width, thick, colour) {
  const du = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(du, dy) || 1;
  const su = (-dy / len) * (width / 2), sy = (du / len) * (width / 2);
  const ring = ([u, y, d]) => [place(u + su, y + sy, d), place(u - su, y - sy, d), place(u - su, y - sy, d - thick), place(u + su, y + sy, d - thick)];
  const a = ring(p), b = ring(q);
  out.quad(a[0], b[0], b[1], a[1], colour);
  out.quad(a[1], b[1], b[2], a[2], shade(colour, 0.82));
  out.quad(a[3], a[0], b[0], b[3], shade(colour, 0.82));
}

const BLEND = 2; // m: over this much of a wall, beside a corner, the panels are drawn across to meet the next wall's

/* ---------- triangular: folded shades on a triangle grid ---------- */

// Every triangle of the grid is a shade: three sails, each hinged on one of its sides and folded up towards its middle, with a
// pale frame round it. Folded right in, they close into a pyramid. The shades are all one size and cover the whole of every
// wall without a gap; only how far open they are changes. Those over a tunnel opening are wide open, their sails drawn back
// to the sides and raised, so that you see in; going away from the openings they close, little by little. (With no tunnels
// they open and close in a slow wave across the wall instead.)
const CLOSING = 1.35; // rows of shades (and CLOSING_LEAST metres at the least) over which they close, going away from an opening
const CLOSING_LEAST = 4.5;
const PIECE = 1.2; // m: sails and frames are drawn in pieces no longer than this, so that they follow the wall

// The wall as the shades lie on it: place(u, y, d). It reaches every point of the wall, carried across the openings; beyond
// an edge a point is held at the edge, and beside a corner it is drawn over to meet the next wall's (as the organic web is).
function lay(wall) {
  const H = wall.nominal;
  return (u, y, d) => {
    const yy = clamp(y, wall.y0, wall.y1), end = u >= 0 ? 1 : -1;
    const near = clamp(1 - (H - end * u) / BLEND, 0, 1), corner = near > 0 ? wall.corner(yy, end) : null;
    if (!corner) {
      const held = clamp(u, wall.u0, wall.u1);
      return wall.point(held, yy, wall.carried(held, yy), d);
    }
    const v = end > 0 ? Math.min(u, H) : Math.max(u, -H), t = smooth(near);
    const along = v + end * (corner.U - H) * near, own = wall.carried(along, yy);
    return wall.point(along + end * t * d, yy, own + (corner.D - own) * t, d); // (the d added along is a mitre: both walls reach the same points)
  };
}

const between = (p, q, t) => p.map((v, i) => v + (q[i] - v) * t);

// A flat triangle in (u, y, d), drawn in small pieces laid on the wall.
function sheet(out, place, a, b, c, colour) {
  const longest = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - a[0], c[1] - a[1]), Math.hypot(c[0] - b[0], c[1] - b[1]));
  const n = Math.max(1, Math.ceil(longest / PIECE));
  const at = (i, j) => place(...between(between(a, b, i / n), between(a, c, i / n), i ? j / i : 0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      out.tri(at(i, j), at(i + 1, j), at(i + 1, j + 1), colour);
      if (j < i) out.tri(at(i, j), at(i + 1, j + 1), at(i, j + 1), colour);
    }
  }
}

function triangular(out, wall, size) {
  const grid = triangleGrid(size), { h, a } = grid;
  const sail = hex(0xd8c39a), frame = hex(0xe9e5da);
  const over = new Set(wall.openings.flatMap((o) => o.cells)); // the shades over an opening
  // how open the shade with its middle at (u, y) is: 0 closed to 1 wide open
  const openness = (key, u, y) => {
    if (over.has(key)) return 1;
    if (!wall.tunnelled) return 0.15 + 0.6 * (0.5 + 0.5 * Math.sin(u * 0.21 + y * 0.33 + 1.7 * Math.sin(u * 0.09 - y * 0.12)));
    const away = wall.openings.reduce((best, o) => Math.min(best, Math.hypot(u - o.u, y - o.y) - o.r - 0.35 * h), Infinity);
    return 0.72 * (1 - smooth(away / Math.max(CLOSING_LEAST, CLOSING * h))); // (never as far open as those over an opening)
  };
  const place = lay(wall);
  const strut = (p, q, width, thick) => { // a frame from p to q, in pieces
    const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / PIECE));
    for (let i = 0; i < n; i++) bar(out, place, between(p, q, i / n), between(p, q, (i + 1) / n), width, thick, frame);
  };
  // the side of the footprint, or of the wall's surface where that goes further
  const left = Math.min(wall.u0, -wall.nominal), right = Math.max(wall.u1, wall.nominal);
  for (let row = 0; row * h < wall.y1 - 0.05; row++) {
    const shift = (row % 2) * (a / 2);
    for (let k = Math.floor((left - shift) / a) - 1; shift + k * a < right; k++) {
      for (const { key, corners } of grid.cells(row, k)) {
        // every shade with any part of it on the wall is drawn, and cut off at the wall's edges
        const us = corners.map((p) => p[0]);
        if (Math.max(...us) <= wall.u0 + 0.05 || Math.min(...us) >= wall.u1 - 0.05) continue;
        const ys = corners.map((p) => p[1]);
        if (Math.max(...ys) <= wall.y0 + 0.05 || Math.min(...ys) >= wall.y1 - 0.05) continue;
        const cu = (corners[0][0] + corners[1][0] + corners[2][0]) / 3, cy = (corners[0][1] + corners[1][1] + corners[2][1]) / 3;
        // (on a rounded massing: only the shades on this view's own part of it, and only where the surface carries on under all of one)
        if (wall.curved && (!wall.owns(cu, cy) || !wall.whole(cu, cy, corners))) continue;
        const open = openness(key, cu, cy);
        const fold = 0.97 - 0.79 * open; // how far each sail's tip is from its side towards the middle
        const reach = (0.42 + 0.48 * open) * size, base = 0.14; // how far the tips stand out
        for (let side = 0; side < 3; side++) {
          const p = corners[side], q = corners[(side + 1) % 3];
          const mu = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
          const tip = [mu + (cu - mu) * fold, my + (cy - my) * fold, base + reach];
          const P = [p[0], p[1], base], Q = [q[0], q[1], base];
          sheet(out, place, P, Q, tip, shade(sail, 0.9 + 0.2 * hash(cu + side, cy)));
          strut(P, tip, 0.1 * size, 0.09);
          strut(Q, tip, 0.1 * size, 0.09);
          strut(P, Q, 0.09 * size, 0.1);
        }
      }
    }
  }
}
/* ---------- organic: a flowing web ---------- */

// A web of broad, curving white ribs: the borders between irregular cells, bent by a slow warp, lying flush on the wall: a
// thin, even layer, so that the wall, the roof's edge and the corners line up with it. A tunnel opening is one of its cells,
// made larger, so the ribs flow round it. One web wraps right round each massing. Drawn on a fine grid, with smooth
// outlines and sides.
const FLUSH = 0.1; // m: how far the ribs' faces stand from the wall (at every panel size)
const BEDDED = 0.03; // m: how far their sides run back into the wall, so that no gap shows behind them where it is not quite flat
function organic(out, wall, size) {
  const ring = ringOf(wall.side.f), ribs = wall.web ?? web(size, wall.massing, ring.length, []);
  const H = wall.nominal, height = wall.side.f.height, top = Math.abs(wall.y1 - height) < 0.6 ? Math.min(wall.y1, height) : wall.y1;
  const step = clamp(0.26 * size, 0.2, 0.42);
  const below = (y) => (wall.curved ? Infinity : top - y - 0.28 * size); // (a rib along the top, where there is a flat roof)
  // The grid is laid out by the footprint, from corner to corner (v along it, -H to H), with the same rows on every wall, so
  // that the two walls at a corner have the same points there.
  // (on one face of a stepped massing: just that face's rectangle)
  const from = wall.flat ? wall.u0 : -H, to = wall.flat ? wall.u1 : H, floor = wall.flat ? wall.y0 : 0;
  const nv = Math.max(2, Math.ceil((to - from) / step)), ny = Math.max(2, Math.ceil((top - floor) / step));
  const sample = (v, y) => {
    const s = ring.along(wall.k, v);
    if (wall.flat) return { s, y, g: Math.min(ribs.rib(s, y), wall.edge(v, y) - 0.28 * size), u: v, at: wall.face(v, y), lean: 0 };
    const g = Math.min(ribs.rib(s, y), below(y));
    // beside a corner, the point is drawn over to where the walls really meet; `lean` is how much of the mitre it takes
    const end = v >= 0 ? 1 : -1, near = clamp(1 - (H - end * v) / BLEND, 0, 1);
    const corner = near > 0 ? wall.corner(y, end) : null;
    if (!corner) return { s, y, g, u: v, at: wall.face(v, y), lean: 0 };
    const t = smooth(near), u = v + end * (corner.U - H) * near, own = wall.face(u, y);
    // (where an opening cuts into the corner, the web stays out on the line of the face and so crosses it unbroken)
    const at = own === null || Math.abs(own - corner.D) > 0.8 ? corner.D : own + (corner.D - own) * t;
    return { s, y, g, u, at, lean: end * t };
  };
  const points = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nv; i++) {
      const p = sample(i === nv ? to : from + (i * (to - from)) / nv, Math.min(top, floor + (j * (top - floor)) / ny));
      if (wall.curved && p.at !== null && wall.blocked(p.u, p.y, 0.1)) p.at = null; // (the ribs stop at the tunnels' openings)
      points.push(p);
    }
  }
  const white = hex(0xeceae6), side = hex(0xc9c6c0);
  // `d` out from the wall; at a corner the point also moves along the wall by as much (a mitre), so that both walls reach it
  const put = (p, d) => wall.point(p.u + p.lean * d, p.y, p.at, d);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nv; i++) {
      const k = j * (nv + 1) + i, quad = [points[k], points[k + 1], points[k + nv + 2], points[k + nv + 1]];
      if (quad.some((p) => p.at === null)) continue;
      const depths = quad.map((p) => p.at);
      if (Math.max(...depths) - Math.min(...depths) > (wall.curved ? 2.5 : 1)) continue;
      // the part of this square inside a rib: its inside corners and the points where the outline crosses its sides
      const inside = [], cuts = [];
      for (let n = 0; n < 4; n++) {
        const p = quad[n], q = quad[(n + 1) % 4];
        if (p.g < 0) inside.push(p);
        if (p.g < 0 !== q.g < 0) {
          const t = p.g / (p.g - q.g), mix = (a, b) => a + (b - a) * t;
          const cut = { s: mix(p.s, q.s), u: mix(p.u, q.u), y: mix(p.y, q.y), g: 0, at: mix(p.at, q.at), lean: mix(p.lean, q.lean), leaving: p.g < 0 };
          inside.push(cut);
          cuts.push(cut);
        }
      }
      if (inside.length < 3) continue;
      const tops = inside.map((p) => put(p, FLUSH));
      for (let n = 1; n + 1 < tops.length; n++) out.tri(tops[0], tops[n], tops[n + 1], white);
      for (let n = 0; n < inside.length; n++) { // the rib's sides, along the outline
        const m = (n + 1) % inside.length, p = inside[n], q = inside[m];
        if (cuts.includes(p) && cuts.includes(q) && p.leaving) out.quad(tops[n], tops[m], put(q, -BEDDED), put(p, -BEDDED), side);
      }
    }
  }
}
export const PANELS = { triangle: triangular, organic };
