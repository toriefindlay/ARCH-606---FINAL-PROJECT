// MODEL (facades): the five kinds of protruding panel, as triangles. No scene code.
//
// Each is designed on a wall (walls.js) in (u along it, y up, d out from it), in metres, and `size` makes it all bigger or
// smaller. Panels stop at the tunnel openings.
import { STOREY } from "../erosion/exterior/tunnels.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (t) => { const u = clamp(t, 0, 1); return u * u * (3 - 2 * u); };
const hash = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
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

// A panel's own view of the wall: `place(u, y, d)` gives the world point, following the surface. Null if the panel does not
// belong here: no wall at its middle, a tunnel opening, or the surface jumps by more than `jump` under it.
function seat(wall, cu, cy, corners, { clear = 0.3, jump = 1.4 } = {}) {
  const mu = clamp(cu, wall.u0 + 0.05, wall.u1 - 0.05), my = clamp(cy, wall.y0 + 0.05, wall.y1 - 0.05);
  if (Math.abs(mu - cu) > 0.8 || Math.abs(my - cy) > 0.8) return null; // (mostly off the wall)
  const middle = wall.depth(mu, my);
  if (middle === null || wall.blocked(cu, cy, clear)) return null;
  for (const [u, y] of corners) {
    const at = wall.depth(u, y);
    if ((at !== null && Math.abs(at - middle) > jump) || wall.blocked(u, y, 0.1)) return null;
  }
  // (a corner past the edge of the wall is drawn back to it)
  return (u, y, d) => {
    const cuu = clamp(u, wall.u0, wall.u1), cyy = clamp(y, wall.y0, wall.y1);
    return wall.point(cuu, cyy, wall.depth(cuu, cyy) ?? middle, d);
  };
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

/* ---------- triangular: folded shades on a triangle grid ---------- */

// Every triangle of the grid has three sails, each hinged on one of its sides and folded out towards its middle, with a pale
// frame round it. They open and close in a slow wave across the wall, showing more or less of the glass behind.
function triangular(out, wall, size) {
  const rows = Math.max(1, Math.round(STOREY / (2.15 * size))), h = STOREY / rows, a = h / 0.866;
  const sail = hex(0xd8c39a), frame = hex(0xe9e5da);
  for (let row = 0; row * h < wall.y1 - 0.3; row++) {
    const y0 = row * h, y1 = y0 + h, shift = (row % 2) * (a / 2);
    for (let k = Math.floor((wall.u0 - shift) / a) - 1; shift + k * a < wall.u1 + a; k++) {
      const u = shift + k * a;
      const cells = [
        [[u, y0], [u + a, y0], [u + a / 2, y1]], // pointing up
        [[u + a / 2, y1], [u + 1.5 * a, y1], [u + a, y0]], // pointing down
      ];
      for (const corners of cells) {
        const cu = (corners[0][0] + corners[1][0] + corners[2][0]) / 3, cy = (corners[0][1] + corners[1][1] + corners[2][1]) / 3;
        const place = seat(wall, cu, cy, corners);
        if (!place) continue;
        const wave = 0.5 + 0.5 * Math.sin(cu * 0.21 + cy * 0.33 + 1.7 * Math.sin(cu * 0.09 - cy * 0.12));
        const reach = (0.45 + 0.65 * wave) * size, fold = 0.5 + 0.42 * (1 - wave); // how far out, and how much of the way to the middle
        const base = 0.14;
        for (let side = 0; side < 3; side++) {
          const p = corners[side], q = corners[(side + 1) % 3];
          const mu = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
          const tip = [mu + (cu - mu) * fold, my + (cy - my) * fold, base + reach];
          const P = [p[0], p[1], base], Q = [q[0], q[1], base];
          out.tri(place(...P), place(...Q), place(...tip), shade(sail, 0.9 + 0.2 * hash(cu + side, cy)));
          bar(out, place, P, tip, 0.1 * size, 0.09, frame);
          bar(out, place, Q, tip, 0.1 * size, 0.09, frame);
          bar(out, place, P, Q, 0.09 * size, 0.1, frame);
        }
      }
    }
  }
}

/* ---------- cubic: stepped blockwork ---------- */

// A box from (ua, ya) to (ub, yb) standing `far` out of the wall; its top is the palest, its underside the darkest.
function block(out, place, ua, ub, ya, yb, far, colour) {
  const f = [place(ua, ya, far), place(ub, ya, far), place(ub, yb, far), place(ua, yb, far)];
  const b = [place(ua, ya, 0.02), place(ub, ya, 0.02), place(ub, yb, 0.02), place(ua, yb, 0.02)];
  out.quad(f[0], f[1], f[2], f[3], colour);
  out.quad(f[3], f[2], b[2], b[3], shade(colour, 1.14));
  out.quad(f[0], b[0], b[1], f[1], shade(colour, 0.5));
  out.quad(f[0], f[3], b[3], b[0], shade(colour, 0.86));
  out.quad(f[1], b[1], b[2], f[2], shade(colour, 0.86));
}

// Courses of long blocks, set out a little, with deep square blocks between them; each course steps along from the one below,
// so the deep blocks run in diagonals.
function cubic(out, wall, size) {
  const courses = Math.max(3, Math.round(STOREY / (0.78 * size))), h = STOREY / courses;
  const cube = 0.95 * h, long = 1.75 * h, gap = 0.07 * h, period = cube + long + 2 * gap;
  const stone = hex(0xded3b8);
  for (let row = 0; row * h < wall.y1 - 0.5 * h; row++) {
    const ya = row * h + gap / 2, yb = Math.min((row + 1) * h - gap / 2, wall.y1), shift = (row * period) / 3;
    for (let k = Math.floor((wall.u0 - shift) / period) - 1; shift + k * period < wall.u1; k++) {
      const u = shift + k * period;
      for (const [from, width, far] of [[u, cube, 0.95 * size], [u + cube + gap, long, 0.24 * size]]) {
        const ua = Math.max(wall.u0, from), ub = Math.min(wall.u1, from + width);
        if (ub - ua < 0.4 * width) continue;
        const place = seat(wall, (ua + ub) / 2, (ya + yb) / 2, [[ua, ya], [ub, ya], [ub, yb], [ua, yb]], { clear: 0.35 });
        if (place) block(out, place, ua, ub, ya, yb, far, shade(stone, 0.9 + 0.18 * hash(k, row)));
      }
    }
  }
}

/* ---------- organic: a flowing web ---------- */

// A web of thick, curving white ribs: the borders between irregular cells, bent by a slow warp, swelling out from the wall in
// places, with a rim round every tunnel opening. Drawn on a fine grid, with smooth outlines and sides.
function organic(out, wall, size) {
  const cw = 4.4 * size, ch = 3.9 * size, seed = wall.id * 17.3;
  const seeds = new Map();
  const seedAt = (i, j) => {
    const key = `${i},${j}`;
    let s = seeds.get(key);
    if (!s) seeds.set(key, (s = [(i + 0.5 * (j & 1) + 0.12 + 0.76 * hash(i + seed, j)) * cw, (j + 0.12 + 0.76 * hash(j + 31, i + seed)) * ch]));
    return s;
  };
  // below 0 inside a rib; how far below says how deep inside it
  const field = (u, y) => {
    const wu = u + size * 1.5 * Math.sin(y / (2.7 * size) + 1.3 * Math.sin(u / (5.1 * size)) + seed);
    const wy = y + size * 1.1 * Math.sin(u / (3.9 * size) + seed * 0.7);
    const j0 = Math.floor(wy / ch), i0 = Math.floor(wu / cw);
    let first = Infinity, second = Infinity;
    for (let j = j0 - 2; j <= j0 + 2; j++) {
      for (let i = i0 - 2; i <= i0 + 2; i++) {
        const s = seedAt(i, j), d = Math.hypot(wu - s[0], (wy - s[1]) * 1.08);
        if (d < first) { second = first; first = d; } else if (d < second) second = d;
      }
    }
    const thick = size * (0.27 + 0.2 * (0.5 + 0.5 * Math.sin(u * 0.19 + y * 0.27 + seed)));
    let g = (second - first) / 2 - thick;
    g = Math.min(g, Math.min(u - wall.u0, wall.u1 - u, wall.y1 - y) - 0.28 * size); // (a rib along the wall's edges)
    for (const o of wall.openings) {
      const away = Math.hypot(u - o.u, y - o.y) - o.r;
      g = Math.min(g, Math.abs(away - 0.55) - 0.32);
      g = Math.max(g, 0.23 - away);
    }
    return g;
  };
  const step = clamp(0.26 * size, 0.2, 0.42);
  const nu = Math.max(2, Math.ceil((wall.u1 - wall.u0) / step)), ny = Math.max(2, Math.ceil((wall.y1 - wall.y0) / step));
  const du = (wall.u1 - wall.u0) / nu, dy = (wall.y1 - wall.y0) / ny;
  const points = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nu; i++) {
      const u = wall.u0 + i * du, y = wall.y0 + j * dy;
      points.push({ u, y, g: field(u, y), at: wall.depth(u, y) });
    }
  }
  const white = hex(0xeceae6), side = hex(0xc9c6c0);
  // the rib's front: rounded off towards its edges, and swelling out in broad patches
  const front = (p) => {
    const swell = 0.5 + 0.5 * Math.sin(p.u * 0.23 + 1.6 * Math.sin(p.y * 0.31 + seed));
    return size * (0.4 + 0.65 * swell) * (0.72 + 0.28 * smooth(-p.g / (0.24 * size)));
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nu; i++) {
      const k = j * (nu + 1) + i, quad = [points[k], points[k + 1], points[k + nu + 2], points[k + nu + 1]];
      if (quad.some((p) => p.at === null)) continue;
      const depths = quad.map((p) => p.at);
      if (Math.max(...depths) - Math.min(...depths) > 1) continue;
      // the part of this square inside a rib: its inside corners and the points where the outline crosses its sides
      const inside = [], cuts = [];
      for (let n = 0; n < 4; n++) {
        const p = quad[n], q = quad[(n + 1) % 4];
        if (p.g < 0) inside.push(p);
        if (p.g < 0 !== q.g < 0) {
          const t = p.g / (p.g - q.g), mix = (a, b) => a + (b - a) * t;
          const cut = { u: mix(p.u, q.u), y: mix(p.y, q.y), g: 0, at: mix(p.at, q.at), leaving: p.g < 0 };
          inside.push(cut);
          cuts.push(cut);
        }
      }
      if (inside.length < 3) continue;
      const tops = inside.map((p) => wall.point(p.u, p.y, p.at, front(p)));
      for (let n = 1; n + 1 < tops.length; n++) out.tri(tops[0], tops[n], tops[n + 1], white);
      for (let n = 0; n < inside.length; n++) { // the rib's sides, along the outline
        const m = (n + 1) % inside.length, p = inside[n], q = inside[m];
        if (cuts.includes(p) && cuts.includes(q) && p.leaving) out.quad(tops[n], tops[m], wall.point(q.u, q.y, q.at, 0.03), wall.point(p.u, p.y, p.at, 0.03), side);
      }
    }
  }
}

/* ---------- protruding fins ---------- */

// Upright blades standing out from the wall. How far each reaches changes smoothly up its height and from one blade to the
// next, so together they ripple.
function fins(out, wall, size) {
  const pitch = 1.05 * size, thick = 0.13 * size, step = 0.5;
  const face = hex(0xd9a66f), edge = hex(0xf0d7b4);
  for (let k = Math.ceil((wall.u0 + thick) / pitch); k * pitch < wall.u1 - thick; k++) {
    const u = k * pitch, ua = u - thick / 2, ub = u + thick / 2;
    const reach = (y) => size * (0.3 + 1.15 * (0.5 + 0.5 * Math.sin(u * 0.34 + y * 0.36 + 1.4 * Math.sin(u * 0.11 - y * 0.08))) ** 1.4);
    let run = null; // the blade's last cross-section, while it carries on
    const end = (r) => out.quad(r.wallA, r.wallB, r.tipB, r.tipA, edge); // closes an end of the blade
    const count = Math.ceil((wall.y1 - wall.y0) / step);
    for (let n = 0; n <= count; n++) {
      const y = Math.min(wall.y1, wall.y0 + n * step), at = wall.depth(u, y);
      if (at === null || wall.blocked(u, y, 0.35) || (run && Math.abs(at - run.at) > 0.8)) {
        if (run) end(run);
        run = null;
        if (at === null || wall.blocked(u, y, 0.35)) continue;
      }
      const d = reach(y);
      const now = { at, wallA: wall.point(ua, y, at, 0.02), wallB: wall.point(ub, y, at, 0.02), tipA: wall.point(ua, y, at, d), tipB: wall.point(ub, y, at, d) };
      if (!run) end(now);
      else {
        out.quad(run.wallA, run.tipA, now.tipA, now.wallA, face);
        out.quad(run.wallB, now.wallB, now.tipB, run.tipB, face);
        out.quad(run.tipA, run.tipB, now.tipB, now.tipA, edge);
      }
      run = now;
    }
    if (run) end(run);
  }
}

/* ---------- hexagonal: a hooded honeycomb ---------- */

// Honeycomb cells, each a deep six-sided frame round a recessed pane. The frames reach further out at the top than at the
// bottom, like hoods, and by different amounts in a slow wave.
function hexagonal(out, wall, size) {
  const rows = Math.max(1, Math.round(STOREY / (2.2 * size))), h = STOREY / rows; // a cell's height: a whole number to a storey
  const R = h / Math.sqrt(3), across = 1.5 * R; // flat-topped cells: this far apart along the wall
  const outer = hex(0xe6e8e9), lip = hex(0xffffff), inner = hex(0xa9b2b8);
  for (let col = Math.floor(wall.u0 / across) - 1; col * across < wall.u1 + R; col++) {
    for (let row = -1; row * h < wall.y1; row++) {
      const cu = col * across, cy = (row + 0.5 + 0.5 * (col & 1)) * h;
      if (cy < wall.y0 + 0.3 * h || cy > wall.y1 - 0.2 * h) continue;
      const corner = (n, r) => { const a = (n * Math.PI) / 3; return [cu + r * Math.cos(a), cy + r * Math.sin(a)]; };
      const place = seat(wall, cu, cy, [0, 1, 2, 3, 4, 5].map((n) => corner(n, R)), { clear: R * 0.45 });
      if (!place) continue;
      const wave = 0.5 + 0.5 * Math.sin(cu * 0.27 + cy * 0.4 + 1.5 * Math.sin(cu * 0.1 - cy * 0.15));
      const reach = (0.3 + 0.65 * wave) * size;
      const at = (n, r, d) => { const [u, y] = corner(n, r); return place(u, y, d); };
      const hood = (n) => reach * (1 + 0.55 * Math.sin((n * Math.PI) / 3)); // further out at the top, less at the bottom
      for (let n = 0; n < 6; n++) {
        const m = n + 1;
        out.quad(at(n, R * 0.99, 0.03), at(m, R * 0.99, 0.03), at(m, R * 0.9, hood(m)), at(n, R * 0.9, hood(n)), outer);
        out.quad(at(n, R * 0.9, hood(n)), at(m, R * 0.9, hood(m)), at(m, R * 0.76, hood(m)), at(n, R * 0.76, hood(n)), lip);
        out.quad(at(n, R * 0.76, hood(n)), at(m, R * 0.76, hood(m)), at(m, R * 0.66, 0.08), at(n, R * 0.66, 0.08), inner);
      }
    }
  }
}

export const PANELS = { triangle: triangular, cubic, organic, fins, hex: hexagonal };
