// MODEL (facades): the walls as the cubic, fins and hexagonal facades use them. Their tunnel openings keep their own round
// shape, and the panels simply stop short of them. (The triangular and organic facades shape the openings: see walls.js.)

const CELL = 0.3; // m: the grid on each side
const MAX_CELLS = 120000; // per side (made coarser above that)
const STEEP = 0.6; // surfaces leaning more than this (the y part of their normal) are roofs and ledges, not walls

// frames: model3dm.js getMassFrames(). triangles: a function (visit) that calls visit(ax, ay, az, bx, by, bz, cx, cy, cz) for
// every triangle of the outside surfaces, in world metres. openings: tunnels.js openings(), or []. Returns the walls.
export function readWalls(frames, triangles, openings = []) {
  const sides = frames.map((f) => {
    const cos = Math.cos(f.turn), sin = Math.sin(f.turn);
    return {
      f, cos, sin,
      local: (x, z) => { const dx = x - f.x, dz = z - f.z; return [dx * cos - dz * sin, dx * sin + dz * cos]; },
      found: [[], [], [], []], // triangles as [u, y, w] x 3, for the sides +x, -x, +z, -z
    };
  });
  const nearest = (x, z) => {
    let best = null, bd = Infinity;
    for (const s of sides) {
      const [lx, lz] = s.local(x, z), qx = Math.abs(lx) - s.f.halfX, qz = Math.abs(lz) - s.f.halfZ;
      const away = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
      if (away < bd) { bd = away; best = s; }
    }
    return best;
  };

  triangles((ax, ay, az, bx, by, bz, cx, cy, cz) => {
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, len = Math.hypot(nx, ny, nz);
    if (len < 1e-9 || Math.abs(ny) > STEEP * len) return;
    const s = nearest((ax + bx + cx) / 3, (az + bz + cz) / 3);
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
      if (wall) { wall.id = which * 4 + k; walls.push(wall); }
    });
  });

  // each tunnel opening belongs to the wall it faces, nearest to it
  for (const o of openings) {
    let best = null, bd = Infinity;
    for (const w of walls) {
      const facing = w.out[0] * o.nx + w.out[1] * o.nz;
      if (facing < 0.5) continue;
      const [lx, lz] = w.side.local(o.x, o.z), u = w.endWall ? lz : lx, depth = w.sign * (w.endWall ? lx : lz);
      const at = w.depth(u, o.y);
      const off = Math.abs(depth - (at ?? depth)) + Math.max(0, w.u0 - u, u - w.u1);
      if (off < bd) { bd = off; best = { w, u, y: o.y, r: o.r }; }
    }
    if (best && bd < 6) best.w.openings.push({ u: best.u, y: best.y, r: best.r });
  }
  return walls;
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
    side, endWall, sign, u0, u1, y0, y1, openings: [],
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
    // the world point `d` out from a surface at distance `at`
    point(u, y, at, d) {
      const w = sign * (at + d), lx = endWall ? w : u, lz = endWall ? u : w;
      return [f.x + lx * cos + lz * sin, y, f.z - lx * sin + lz * cos];
    },
    // is (u, y) within `pad` metres of a tunnel opening?
    blocked(u, y, pad = 0) {
      return wall.openings.some((o) => (u - o.u) ** 2 + (y - o.y) ** 2 < (o.r + pad) ** 2);
    },
  };
  return wall;
}
