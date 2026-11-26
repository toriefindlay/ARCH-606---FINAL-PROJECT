// MODEL (facades): the cubic, fins and hexagonal panels, as triangles. No scene code. Each is designed on a wall
// (plainWalls.js) in (u along it, y up, d out from it), in metres, and `size` makes it all bigger or smaller. They stop short
// of the round tunnel openings.
import { STOREY } from "../erosion/exterior/tunnels.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
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
  if (wall.curved && (!wall.owns(mu, my) || !wall.whole(mu, my, corners))) return null;
  for (const [u, y] of corners) {
    const at = wall.depth(u, y);
    if ((at !== null && !wall.curved && Math.abs(at - middle) > jump) || wall.blocked(u, y, 0.1)) return null; // (a curved surface falls away as it turns)
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
  const stone = hex(0xffffff); // white blocks
  for (let row = 0; row * h < wall.y1 - 0.5 * h; row++) {
    const ya = row * h + gap / 2, yb = Math.min((row + 1) * h - gap / 2, wall.y1), shift = (row * period) / 3;
    for (let k = Math.floor((wall.u0 - shift) / period) - 1; shift + k * period < wall.u1; k++) {
      const u = shift + k * period;
      for (const [from, width, far] of [[u, cube, 0.95 * size], [u + cube + gap, long, 0.24 * size]]) {
        const ua = Math.max(wall.u0, from), ub = Math.min(wall.u1, from + width);
        if (ub - ua < 0.4 * width) continue;
        const place = seat(wall, (ua + ub) / 2, (ya + yb) / 2, [[ua, ya], [ub, ya], [ub, yb], [ua, yb]], { clear: 0.35 });
        if (place) block(out, place, ua, ub, ya, yb, far, shade(stone, 0.94 + 0.08 * hash(k, row)));
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
      // (on a rounded massing a blade is only on the view's own part, and ends where the surface does not carry on)
      const absent = at === null || wall.blocked(u, y, 0.35) || (wall.curved && (!wall.owns(u, y) || !wall.whole(u, y, [[ua, y], [ub, y]])));
      if (absent || (run && (wall.curved ? !wall.whole(u, run.y, [[u, y]]) : Math.abs(at - run.at) > 0.8))) {
        if (run) end(run);
        run = null;
        if (absent) continue;
      }
      const d = reach(y);
      const now = { at, y, wallA: wall.point(ua, y, at, 0.02), wallB: wall.point(ub, y, at, 0.02), tipA: wall.point(ua, y, at, d), tipB: wall.point(ub, y, at, d) };
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

export const PLAIN_PANELS = { cubic, fins, hex: hexagonal };
