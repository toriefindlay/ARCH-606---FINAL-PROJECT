// MODEL (facades): the surfaces of rounded massings, as places to put panels on. No scene code.
//
// A rounded massing (a dome, a shell, a blob) has no four walls. It is looked at from five directions instead: its four sides
// and from above. Each view takes the part of the surface that faces it more than any other view, and lays the pattern out
// flat across that view. A panel is designed in (u across the view, y up it, d out from the surface), as on a flat wall
// (walls.js); each of its points is then set on the surface found there and stands out along the surface's own normal, so the
// panels follow the curves. The views give walls that the panel designs can use like any other.

const CELL = 0.35; // m: the grid of each view
const MAX_CELLS = 160000; // per view (made coarser above that)
const FACING = 0.3; // a surface turned further than this from a view (the cosine) is not read by it
const SEAM = 2; // cells a view reaches past the part it faces most, so that neighbouring views meet without a gap

// frames and triangles: as readWalls (walls.js). tunnels: the finished tunnels (tunnels.js), or null.
export function readCurvedWalls(frames, triangles, tunnels = null) {
  const massings = frames.map((f, index) => {
    const cos = Math.cos(f.turn), sin = Math.sin(f.turn);
    return { f, index, cos, sin, local: (x, z) => { const dx = x - f.x, dz = z - f.z; return [dx * cos - dz * sin, dx * sin + dz * cos]; }, found: [[], [], [], [], []] };
  });
  const nearest = (x, z) => {
    let best = null, bd = Infinity;
    for (const m of massings) {
      const [lx, lz] = m.local(x, z), qx = Math.abs(lx) - m.f.halfX, qz = Math.abs(lz) - m.f.halfZ;
      const away = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
      if (away < bd) { bd = away; best = m; }
    }
    return best;
  };

  // every triangle goes to each view it is turned towards, as [u, y, how far towards the viewer] for its corners
  triangles((ax, ay, az, bx, by, bz, cx, cy, cz) => {
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    nx /= len; ny /= len; nz /= len;
    const m = nearest((ax + bx + cx) / 3, (az + bz + cz) / 3);
    const p = [m.local(ax, az), m.local(bx, bz), m.local(cx, cz)], ys = [ay, by, cy];
    let lnx = nx * m.cos - nz * m.sin, lnz = nx * m.sin + nz * m.cos;
    // The normal is turned to point out of the massing: upwards where it leans at all, away from the middle where it is
    // upright (a mesh's own winding cannot be relied on).
    const mx = (p[0][0] + p[1][0] + p[2][0]) / 3, mz = (p[0][1] + p[1][1] + p[2][1]) / 3;
    if (Math.abs(ny) > 0.08 ? ny < 0 : lnx * mx + lnz * mz < 0) { ny = -ny; lnx = -lnx; lnz = -lnz; }
    const towards = [lnx, -lnx, lnz, -lnz, ny]; // the views: from +x, -x, +z, -z, and above
    const most = Math.max(...towards);
    for (let view = 0; view < 5; view++) {
      if (towards[view] < FACING) continue;
      const corners = p.map(([lx, lz], i) => (view === 4 ? [lx, lz + m.f.halfZ + 1, ys[i]] : [view < 2 ? lz : lx, ys[i], (view % 2 ? -1 : 1) * (view < 2 ? lx : lz)]));
      m.found[view].push({ corners, most: towards[view] >= most - 1e-6, normal: [lnx, ny, lnz] });
    }
  });

  const edges = tunnels ? tunnels.network().edges : [];
  const openings = tunnels ? tunnels.openings() : [];
  const walls = [];
  for (const m of massings) {
    m.found.forEach((list, view) => {
      const wall = list.length ? makeView(m, view, list, edges) : null;
      if (!wall) return;
      wall.openings = openingsSeen(wall, openings);
      wall.tunnelled = openings.length > 0;
      walls.push(wall);
    });
  }
  return walls;
}

function makeView(m, view, list, edges) {
  let u0 = Infinity, u1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const t of list) for (const [u, y] of t.corners) { u0 = Math.min(u0, u); u1 = Math.max(u1, u); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  y0 = Math.max(0, view === 4 ? y0 : 0);
  if (u1 - u0 < 1.5 || y1 - y0 < 1.5) return null;
  const g = Math.max(CELL, Math.sqrt(((u1 - u0) * (y1 - y0)) / MAX_CELLS));
  const nu = Math.ceil((u1 - u0) / g) + 1, ny = Math.ceil((y1 - y0) / g) + 1, count = nu * ny;
  const depth = new Float32Array(count).fill(-Infinity), mine = new Uint8Array(count), normals = new Float32Array(count * 3);
  const put = (i, j, w, t) => {
    if (i < 0 || j < 0 || i >= nu || j >= ny) return;
    const k = j * nu + i;
    if (w <= depth[k]) return;
    depth[k] = w;
    mine[k] = t.most ? 1 : 0;
    normals.set(t.normal, k * 3);
  };
  for (const t of list) {
    const [a, b, c] = t.corners.map(([u, y, w]) => [(u - u0) / g, (y - y0) / g, w]);
    for (const q of [a, b, c]) put(Math.round(q[0]), Math.round(q[1]), q[2], t);
    const det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(det) < 1e-9) continue;
    for (let j = Math.ceil(Math.min(a[1], b[1], c[1])); j <= Math.floor(Math.max(a[1], b[1], c[1])); j++) {
      for (let i = Math.ceil(Math.min(a[0], b[0], c[0])); i <= Math.floor(Math.max(a[0], b[0], c[0])); i++) {
        const q = ((i - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (j - a[1])) / det, r = ((b[0] - a[0]) * (j - a[1]) - (i - a[0]) * (b[1] - a[1])) / det;
        if (q >= -0.02 && r >= -0.02 && q + r <= 1.02) put(i, j, a[2] + q * (b[2] - a[2]) + r * (c[2] - a[2]), t);
      }
    }
  }
  if (!mine.some((v) => v)) return null;
  // the part this view is given: what faces it most, and a seam round that
  let given = Uint8Array.from(mine);
  for (let pass = 0; pass < SEAM; pass++) {
    const next = Uint8Array.from(given);
    for (let k = 0; k < count; k++) {
      if (given[k] || depth[k] === -Infinity) continue;
      const i = k % nu;
      if ((i > 0 && given[k - 1]) || (i < nu - 1 && given[k + 1]) || given[k - nu] || given[k + nu]) next[k] = 1;
    }
    given = next;
  }
  // beyond the surface the nearest of it is carried on, so that a panel's point there still has a place
  const from = new Int32Array(count).fill(-1), queue = [];
  for (let k = 0; k < count; k++) if (depth[k] > -Infinity) { from[k] = k; queue.push(k); }
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head], i = k % nu;
    for (const [q, ok] of [[k - 1, i > 0], [k + 1, i < nu - 1], [k - nu, k >= nu], [k + nu, k < count - nu]]) {
      if (ok && from[q] < 0) { from[q] = from[k]; queue.push(q); }
    }
  }

  // the surface at (u, y): { w: how far towards the viewer, n: its normal in the massing's own directions }
  const surface = (u, y) => {
    const fu = Math.min(nu - 1.001, Math.max(0, (u - u0) / g)), fv = Math.min(ny - 1.001, Math.max(0, (y - y0) / g));
    const i = Math.floor(fu), j = Math.floor(fv), tu = fu - i, tv = fv - j;
    let w = 0, x = 0, yy = 0, z = 0, total = 0;
    for (const [di, dj, share] of [[0, 0, (1 - tu) * (1 - tv)], [1, 0, tu * (1 - tv)], [0, 1, (1 - tu) * tv], [1, 1, tu * tv]]) {
      const k = from[(j + dj) * nu + i + di], s = share + 1e-5;
      w += depth[k] * s; x += normals[k * 3] * s; yy += normals[k * 3 + 1] * s; z += normals[k * 3 + 2] * s; total += s;
    }
    const len = Math.hypot(x, yy, z) || 1;
    return { w: w / total, n: [x / len, yy / len, z / len] };
  };
  const covers = (u, y) => {
    const i = Math.round((u - u0) / g), j = Math.round((y - y0) / g);
    return i >= 0 && j >= 0 && i < nu && j < ny && given[j * nu + i] === 1;
  };
  const { f, cos, sin } = m, sign = view % 2 ? -1 : 1, top = view === 4;
  // the point on the surface at (u, y), in the massing's own directions: [x, y, z]
  const place = (u, y, w) => (top ? [u, w, y - f.halfZ - 1] : view < 2 ? [sign * w, y, u] : [u, y, sign * w]);
  const world = (lx, y, lz) => [f.x + lx * cos + lz * sin, y, f.z - lx * sin + lz * cos];
  // does the point lie in the hole a tunnel leaves in the surface (or within `pad` metres of it)?
  const inTunnel = (x, y, z, pad) => edges.some((e) => {
    const reach = e.r + pad;
    if (Math.min(e.a.x, e.b.x) - reach > x || Math.max(e.a.x, e.b.x) + reach < x || Math.min(e.a.z, e.b.z) - reach > z || Math.max(e.a.z, e.b.z) + reach < z) return false;
    const sx = e.b.x - e.a.x, sy = e.b.y - e.a.y, sz = e.b.z - e.a.z, along = Math.max(0, Math.min(1, ((x - e.a.x) * sx + (y - e.a.y) * sy + (z - e.a.z) * sz) / (sx * sx + sy * sy + sz * sz || 1)));
    return (x - e.a.x - sx * along) ** 2 + (y - e.a.y - sy * along) ** 2 + (z - e.a.z - sz * along) ** 2 < reach * reach;
  });
  const half = Math.max(Math.abs(u0), Math.abs(u1));
  const wall = {
    curved: true, view, id: m.index * 5 + view, massing: m.index, k: view % 4, endWall: view < 2, sign,
    // (the organic web goes round a footprint: a view's own width and height stand in for it)
    side: { f: { ...f, height: y1 }, local: m.local }, nominal: half, web: null,
    u0, u1, y0, y1, openings: [], taken: new Set(),
    corner: () => null,
    covers,
    depth: (u, y) => (covers(u, y) ? surface(u, y).w : null),
    face: (u, y) => (covers(u, y) ? surface(u, y).w : null),
    carried: (u, y) => surface(u, y).w,
    // `d` out along the surface's normal from the surface at (u, y) (the depth passed in is not needed: the surface is read)
    point(u, y, at, d) {
      const s = surface(u, y), [lx, py, lz] = place(u, y, s.w);
      return world(lx + s.n[0] * d, Math.max(0.02, py + s.n[1] * d), lz + s.n[2] * d);
    },
    blocked(u, y, pad = 0) {
      if (!edges.length) return false;
      const [lx, py, lz] = place(u, y, surface(u, y).w);
      return inTunnel(...world(lx, py, lz), pad - 0.15);
    },
    surfacePoint: (u, y) => { const [lx, py, lz] = place(u, y, surface(u, y).w); return world(lx, py, lz); },
    // a world point as this view sees it: [u, y]
    seen(x, py, z) { const [lx, lz] = m.local(x, z); return top ? [lx, lz + f.halfZ + 1] : [view < 2 ? lz : lx, py]; },
  };
  return wall;
}

// The tunnels' openings that lie in a view's part of the surface, as { u, y, r, bound }.
function openingsSeen(wall, openings) {
  const out = [];
  for (const o of openings) {
    const [u, y] = wall.seen(o.x, o.y, o.z);
    if (!wall.covers(u, y)) continue;
    const [x, py, z] = wall.surfacePoint(u, y);
    if (Math.hypot(x - o.x, py - o.y, z - o.z) > o.r + 3) continue; // (another part of the surface, further on)
    out.push({ u, y, r: o.r, bound: o.r + 0.5 });
  }
  return out;
}
