// MODEL (facades): the walls of massings that are more than a simple box. No scene code.
//
// walls.js takes a massing to have four walls, the sides of its footprint. A massing of several blocks (steps, wings, towers,
// notches) has many more, set back at different places, and treating it as four walls would stretch panels across the open
// space between them and leave the set-back walls bare. So every upright, flat face that can be seen is found on the
// massing's own mesh, and cut into rectangles that it covers completely. Each rectangle is a wall of its own, which panels
// are cut off at: nothing can stand where there is no wall.
//
// Along a face the patterns are measured the same way as on the four walls (u along the massing's own side), so they carry on
// across a face's rectangles and meet the openings as shaped for the skin.

const CELL = 0.25; // m: the grid a face is read on
const UPRIGHT = 0.25; // a face leaning more than this (the y part of its normal) is a roof or a slope, not a wall
const SAME_PLANE = 0.3; // m: faces this close, turned the same way, are one
const LEAST_SIDE = 0.7, LEAST_AREA = 1; // m, m2: smaller pieces are left bare
const AIR_AT = 0.6; // m: how far in front of a face the air is looked for
const MITRE_OVER = 0.45; // m: over this much beside an outward corner, panels reach out to meet the next face's
const BOX_COVER = 0.93; // a massing is a simple box if each of its four sides is one face covering this much of it

// frames: model3dm.js getMassFrames(). triangles: calls visit() with every triangle of the massings' own meshes. Returns
// [{ index, local, f, simple, faces }] for each massing: `simple` if it is a plain box, which walls.js handles.
export function findFaces(frames, triangles) {
  const massings = frames.map((f, index) => {
    const cos = Math.cos(f.turn), sin = Math.sin(f.turn);
    return { f, index, cos, sin, local: (x, z) => { const dx = x - f.x, dz = z - f.z; return [dx * cos - dz * sin, dx * sin + dz * cos]; }, tris: [] };
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
  triangles((ax, ay, az, bx, by, bz, cx, cy, cz) => {
    const m = nearest((ax + bx + cx) / 3, (az + bz + cz) / 3);
    const [a, c0] = m.local(ax, az), [b, c1] = m.local(bx, bz), [c, c2] = m.local(cx, cz);
    m.tris.push([a, ay, c0, b, by, c1, c, cy, c2]);
  });
  for (const m of massings) readMassing(m);
  return massings;
}

function readMassing(m) {
  const { halfX, halfZ, height } = m.f;
  // how high the massing is over each point of its footprint, to tell air from what is built
  const step = Math.max(0.3, Math.max(halfX, halfZ) / 200), nx = Math.ceil((2 * halfX) / step) + 1, nz = Math.ceil((2 * halfZ) / step) + 1;
  const tops = new Float32Array(nx * nz);
  for (const t of m.tris) {
    const p = [0, 3, 6].map((i) => [(t[i] + halfX) / step - 0.5, (t[i + 2] + halfZ) / step - 0.5, t[i + 1]]);
    raster(p, nx, nz, (i, j, y) => { if (y > tops[j * nx + i]) tops[j * nx + i] = y; });
  }
  const topAt = (x, z) => {
    const i = Math.floor((x + halfX) / step), j = Math.floor((z + halfZ) / step);
    return i < 0 || j < 0 || i >= nx || j >= nz ? 0 : tops[j * nx + i];
  };
  m.air = (x, y, z) => topAt(x, z) < y - 0.05;

  // the upright triangles, each turned to face the air, gathered into planes
  const planes = [];
  for (const t of m.tris) {
    const ux = t[3] - t[0], uy = t[4] - t[1], uz = t[5] - t[2], vx = t[6] - t[0], vy = t[7] - t[1], vz = t[8] - t[2];
    let ax = uy * vz - uz * vy, ay = uz * vx - ux * vz, az = ux * vy - uy * vx;
    const len = Math.hypot(ax, ay, az);
    if (len < 1e-9 || Math.abs(ay) > UPRIGHT * len) continue;
    const flat = Math.hypot(ax, az);
    ax /= flat; az /= flat;
    // which side is the air on? (asked at the middle and towards each corner)
    let front = 0, back = 0;
    for (const w of [[1 / 3, 1 / 3, 1 / 3], [0.8, 0.1, 0.1], [0.1, 0.8, 0.1], [0.1, 0.1, 0.8]]) {
      const x = w[0] * t[0] + w[1] * t[3] + w[2] * t[6], y = w[0] * t[1] + w[1] * t[4] + w[2] * t[7], z = w[0] * t[2] + w[1] * t[5] + w[2] * t[8];
      if (m.air(x + ax * AIR_AT, y, z + az * AIR_AT)) front++;
      if (m.air(x - ax * AIR_AT, y, z - az * AIR_AT)) back++;
    }
    if (back > front) { ax = -ax; az = -az; } else if (!front && !back) continue; // (buried inside another block)
    // a face along one of the massing's own sides is taken to be exactly so
    if (Math.abs(ax) > 0.996) { ax = Math.sign(ax); az = 0; } else if (Math.abs(az) > 0.996) { az = Math.sign(az); ax = 0; }
    const offset = (ax * (t[0] + t[3] + t[6]) + az * (t[2] + t[5] + t[8])) / 3;
    let plane = planes.find((p) => p.nx * ax + p.nz * az > 0.9993 && Math.abs(p.offset - offset) < SAME_PLANE);
    if (!plane) planes.push((plane = { nx: ax, nz: az, offset, tris: [] }));
    plane.tris.push(t);
  }
  m.faces = planes.map((plane) => readFace(m, plane)).filter(Boolean);

  // a simple box: just four faces, each a whole side of the footprint
  m.simple = m.faces.length === 4 && m.faces.every((face) => {
    if (face.nx !== 0 && face.nz !== 0) return false;
    const half = face.nx ? halfX : halfZ, along = face.nx ? halfZ : halfX;
    return Math.abs(face.offset - half) < 0.4 && face.area > BOX_COVER * 2 * along * height;
  });
}

// Calls put(i, j, value) for every grid point inside a triangle given as three [i, j, value].
function raster([a, b, c], ni, nj, put) {
  const det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  if (Math.abs(det) < 1e-9) return;
  for (let j = Math.max(0, Math.ceil(Math.min(a[1], b[1], c[1]))); j <= Math.min(nj - 1, Math.floor(Math.max(a[1], b[1], c[1]))); j++) {
    for (let i = Math.max(0, Math.ceil(Math.min(a[0], b[0], c[0]))); i <= Math.min(ni - 1, Math.floor(Math.max(a[0], b[0], c[0]))); i++) {
      const q = ((i - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (j - a[1])) / det, r = ((b[0] - a[0]) * (j - a[1]) - (i - a[0]) * (b[1] - a[1])) / det;
      if (q >= -0.01 && r >= -0.01 && q + r <= 1.01) put(i, j, a[2] + q * (b[2] - a[2]) + r * (c[2] - a[2]));
    }
  }
}

// One plane's visible part: its grid of covered cells, how far each is from the face's edge, and the rectangles it is cut into.
function readFace(m, { nx, nz, offset, tris }) {
  const endWall = Math.abs(nx) >= Math.abs(nz), aligned = nx === 0 || nz === 0;
  // u runs along the massing's side, as in walls.js; on a face at an angle, along the face
  const [tx, tz] = aligned ? (endWall ? [0, 1] : [1, 0]) : [-nz, nx];
  const flat = tris.map((t) => [0, 3, 6].map((i) => [t[i] * tx + t[i + 2] * tz, t[i + 1]]));
  let u0 = Infinity, u1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const t of flat) for (const [u, y] of t) { u0 = Math.min(u0, u); u1 = Math.max(u1, u); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  y0 = Math.max(0, y0);
  if (u1 - u0 < LEAST_SIDE || y1 - y0 < LEAST_SIDE) return null;
  const g = Math.max(CELL, Math.sqrt(((u1 - u0) * (y1 - y0)) / 200000));
  const nu = Math.ceil((u1 - u0) / g), ny = Math.ceil((y1 - y0) / g), cells = new Uint8Array(nu * ny);
  const origin = [nx * offset, nz * offset], base = origin[0] * tx + origin[1] * tz; // (u of the point nx, nz * offset)
  // the point of the plane at u, `d` out from it
  const planePoint = (u, d) => [origin[0] + tx * (u - base) + nx * d, origin[1] + tz * (u - base) + nz * d];
  for (const t of flat) {
    raster(t.map(([u, y]) => [(u - u0) / g - 0.5, (y - y0) / g - 0.5, 0]), nu, ny, (i, j) => {
      const u = u0 + (i + 0.5) * g, y = y0 + (j + 0.5) * g, [x, z] = planePoint(u, AIR_AT);
      if (m.air(x, y, z)) cells[j * nu + i] = 1; // (not where another block stands against it)
    });
  }
  let area = 0;
  for (const c of cells) area += c * g * g;
  if (area < LEAST_AREA) return null;

  // how far (m) each covered cell is from the nearest uncovered one or the grid's edge
  const far = new Float32Array(nu * ny);
  for (let k = 0; k < far.length; k++) far[k] = cells[k] ? 1e9 : 0;
  const at = (i, j) => (i < 0 || j < 0 || i >= nu || j >= ny ? 0 : far[j * nu + i]);
  for (const way of [1, -1]) {
    for (let b = 0; b < ny; b++) {
      const j = way > 0 ? b : ny - 1 - b;
      for (let a = 0; a < nu; a++) {
        const i = way > 0 ? a : nu - 1 - a, k = j * nu + i;
        if (!far[k]) continue;
        far[k] = Math.min(far[k], at(i - way, j) + 1, at(i, j - way) + 1, at(i - way, j - way) + Math.SQRT2, at(i + way, j - way) + Math.SQRT2);
      }
    }
  }
  const edge = (u, y) => {
    const i = Math.min(nu - 1, Math.max(0, Math.floor((u - u0) / g))), j = Math.min(ny - 1, Math.max(0, Math.floor((y - y0) / g)));
    return Math.max(0, (far[j * nu + i] - 0.5) * g);
  };

  // Beside an upright edge that is an outward corner (there is air behind the plane just past it) panels lean out past the
  // edge, as far as they stand out, so that the two faces' panels meet. +1: towards greater u, -1: towards less.
  const covered = (i, j) => i >= 0 && j >= 0 && i < nu && j < ny && cells[j * nu + i] === 1;
  const reach = Math.ceil(MITRE_OVER / g);
  const lean = (u, y) => {
    const i = Math.min(nu - 1, Math.max(0, Math.floor((u - u0) / g))), j = Math.min(ny - 1, Math.max(0, Math.floor((y - y0) / g)));
    for (const way of [1, -1]) {
      for (let n = 0; n <= reach; n++) {
        if (covered(i + way * (n + 1), j)) continue;
        const last = u0 + (i + way * n + (way > 0 ? 1 : 0)) * g, away = Math.abs(last - u);
        const [x, z] = planePoint(last + way * AIR_AT, -AIR_AT);
        if (away < MITRE_OVER && m.air(x, y0 + (j + 0.5) * g, z)) return way * (1 - away / MITRE_OVER);
        break;
      }
    }
    return 0;
  };

  return {
    nx, nz, tx, tz, offset, endWall, aligned, area, edge, lean, planePoint,
    rectangles: () => cover(cells, nu, ny, g).map(([i0, j0, i1, j1]) => ({ u0: u0 + i0 * g, u1: Math.min(u1, u0 + i1 * g), y0: y0 + j0 * g, y1: Math.min(y1, y0 + j1 * g) })),
  };
}

// Cuts a grid's covered cells into rectangles, the largest first: [[i0, j0, i1, j1] (the ends not included)].
function cover(cells, nu, ny, g) {
  const left = Uint8Array.from(cells), out = [], least = Math.ceil(LEAST_SIDE / g);
  for (let n = 0; n < 60; n++) {
    const tall = new Int32Array(nu);
    let best = null, most = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nu; i++) tall[i] = left[j * nu + i] ? tall[i] + 1 : 0;
      const stack = [];
      for (let i = 0; i <= nu; i++) { // (the largest rectangle of covered cells ending on this row)
        const h = i < nu ? tall[i] : 0;
        let start = i;
        while (stack.length && stack[stack.length - 1][1] >= h) {
          const [s, sh] = stack.pop();
          if (sh >= least && i - s >= least && (i - s) * sh > most) { most = (i - s) * sh; best = [s, j - sh + 1, i, j + 1]; }
          start = s;
        }
        stack.push([start, h]);
      }
    }
    if (!best || most * g * g < LEAST_AREA) break;
    out.push(best);
    for (let j = best[1]; j < best[3]; j++) left.fill(0, j * nu + best[0], j * nu + best[2]);
  }
  return out;
}

// The walls of the massings that are not simple boxes. massings: findFaces(). skin: calls visit() with the skin's triangles,
// or null (the walls then stand on the mesh's own faces). tunnelOpenings: tunnels.openings(), or []. placed: placeOpenings()
// for a facade that shapes them, else null. webs of the organic facade are taken from it.
export function faceWalls(massings, skin = null, tunnelOpenings = [], placed = null) {
  const shifts = skin ? skinShifts(massings, skin) : new Map();
  const walls = [];
  for (const m of massings) {
    if (m.simple) continue;
    m.faces.forEach((face, number) => {
      const { nx, nz, tx, tz, endWall, offset } = face, out = offset + (shifts.get(face) ?? 0);
      // the openings on this face: u along it
      const here = [];
      tunnelOpenings.forEach((o, i) => {
        const [lx, lz] = m.local(o.x, o.z), onx = o.nx * m.cos - o.nz * m.sin, onz = o.nx * m.sin + o.nz * m.cos;
        if (onx * nx + onz * nz < 0.7 || Math.abs(lx * nx + lz * nz - offset) > 1.6) return;
        here.push({ o: placed ? placed.each[i].opening : { u: lx * tx + lz * tz, y: o.y, r: o.r }, u: lx * tx + lz * tz, y: o.y, r: o.r });
      });
      const k = endWall ? (nx > 0 ? 0 : 1) : nz > 0 ? 2 : 3;
      face.rectangles().forEach((r, part) => {
        const openings = [...new Set(here.filter((h) => h.u > r.u0 - h.r - 0.5 && h.u < r.u1 + h.r + 0.5 && h.y > r.y0 - h.r - 0.5 && h.y < r.y1 + h.r + 0.5).map((h) => h.o))];
        const inside = (u, y) => u >= r.u0 - 0.05 && u <= r.u1 + 0.05 && y >= r.y0 - 0.05 && y <= r.y1 + 0.05;
        const wall = {
          flat: true, id: m.index * 1000 + number * 60 + part, massing: m.index, k, endWall, nominal: 0, ...r,
          side: { f: m.f, local: m.local }, web: placed?.webs.get(m.index) ?? null,
          openings, taken: new Set(openings.flatMap((o) => o.cells ?? [])), tunnelled: tunnelOpenings.length > 0,
          corner: () => null,
          depth: (u, y) => (inside(u, y) ? out : null),
          face: (u, y) => (inside(u, y) ? out : null),
          carried: () => out,
          edge: face.edge,
          point(u, y, at, d) {
            const uu = u + face.lean(Math.min(r.u1, Math.max(r.u0, u)), y) * (d + Math.max(0, out - offset)); // (and as far as the face was brought out)
            const [lx, lz] = face.planePoint(uu, (at ?? out) - offset + d);
            return [m.f.x + lx * m.cos + lz * m.sin, y, m.f.z - lx * m.sin + lz * m.cos];
          },
          blocked: (u, y, pad = 0) => openings.some((o) => (u - o.u) ** 2 + (y - o.y) ** 2 < (o.r + pad) ** 2),
        };
        walls.push(wall);
      });
    });
  }
  return walls;
}

// How far the skin stands out from (or in behind) each face of the mesh: it is built on a grid, so it can differ by part of
// a cell (a face at an angle to the grid comes out in small steps). Nearly the outermost of what is found beside each face, so
// that no step shows through the panels.
function skinShifts(massings, skin) {
  const found = new Map();
  skin((ax, ay, az, bx, by, bz, cx, cy, cz) => {
    for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]) {
      for (const m of massings) {
        if (m.simple) continue;
        const [lx, lz] = m.local(x, z);
        for (const face of m.faces) {
          const shift = lx * face.nx + lz * face.nz - face.offset;
          // (points well inside the face: near its edges the next face's surface would be taken for its own)
          if (Math.abs(shift) > 0.8 || face.edge(lx * face.tx + lz * face.tz, y) < 1) continue;
          if (!found.has(face)) found.set(face, []);
          found.get(face).push(shift);
        }
      }
    }
  });
  return new Map([...found].map(([face, list]) => [face, list.sort((a, b) => a - b)[Math.floor(0.98 * (list.length - 1))]]));
}
