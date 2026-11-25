// MODEL (exterior erosion): the skin of the mass, once the wind tunnels are finished. No scene or DOM code; tunnelMesh.js draws what it makes.
//
// The whole outside of the mass is ONE surface (a signed distance field on a fine grid: negative inside the stone), meshed with marching cubes, which
// replaces the mass's own surface while it is shown: a flat facade with sharp corners and crisp openings. It is made from the mass as placed (and never
// changes it, or the tunnels, or the cooling: those are all worked out on the mass as placed):
//  1. the mass's signed distance;
//  2. the tunnels taken out, each with a flared, angled reveal where it meets the face (or a shape of the facade's, see SHAPED OPENINGS);
//  3. the circulation's hallways cut out where they reach the face.
// The part of the mesh that lies on the tunnels is returned apart from the rest, so that the x-ray mode can show the tunnels solid.
//
// Everything is done a slice at a time (generators, see marching.js) so that no frame is held up by it.
import { distance3d } from "./distance.js";
import { march, fresh, due } from "./marching.js";

const INF = 1e20;
const MAX_CELLS = 1.5e6; // cells of the grid at most (a grid of about half a metre is enough, and quick)
const PAD = 3, BELOW = 3; // metres of grid beyond the mass, and below the ground (the mass carries on down there, so that its walls have no foot of their own)
const LIMIT = 8; // metres: distances are kept within this
const TUBE_REACH = 2.5; // metres: how far out from a tube's surface its distance is worked out (beyond the tube's own radius)
// THE ROUND OPENINGS: crisp circles, each with a flared, angled reveal (a bell mouth, wider at the face than at the throat, like the openings of a
// perforated concrete wall).
const FLARE_ANGLE = (30 * Math.PI) / 180; // the reveal's angle to the axis of the opening (it is a straight cone): the smaller, the deeper it goes for its width
const FLARE_GROW = [0.95, 0.55]; // the mouth's radius is the tube's radius plus (FLARE_GROW[0] x the radius + FLARE_GROW[1] metres) at full flare...
const FLARE_MAX = 2.8; // ...but at most this (metres): openings are only 6 m apart, and two mouths must not run into one another
// The radius of an opening's mouth at the face, for a tube of radius r.
const mouthRadius = (r) => Math.min(r + (FLARE_GROW[0] * r + FLARE_GROW[1]), Math.max(r + 0.3, FLARE_MAX));
const FLARE_EXP = 1; // how the reveal curves: 1 is a straight cone, more is a trumpet that meets the tube tangentially
// What an opening's cut is made of: the radius r at its throat, the radius rOut at the face, and the depth D from the throat to the face (a cone).
function revealOf(o) {
  const r = o.r, rOut = mouthRadius(r);
  return { r, rOut, D: (rOut - r) / Math.tan(FLARE_ANGLE) };
}
// SHAPED OPENINGS: something else (the facades, see facades/openings.js) may give the openings shapes of its own. Each is then
// cut as a niche of its shape, with straight sides, SHAPE_DEPTH metres into the wall, in place of the round
// flared reveal; the round tube runs on from the niche's flat back. A shape: { tx, tz (the direction along the wall that its u grows in), opening: { u, y, r, bound
// (how far the shape reaches from there), sdf(u, y) (below 0 inside it) } }, one for every opening, in tunnels.openings()'s order.
const SHAPE_DEPTH = 1.0;
const SHAPE_BAND = 0.035; // metres: the part of the skin within this of a shaped niche (or its tube) counts as the tunnel's
const SHAPE_BEHIND = 0.12; // metres: so does anything beside an opening that lies this far behind where the face was before it was cut

// The value at a point between the cells of a field (in cells), for telling which part of the mesh a triangle is.
function between(f, g, a, m, b) {
  const ia = Math.max(0, Math.min(g.nx - 2, Math.floor(a))), im = Math.max(0, Math.min(g.ny - 2, Math.floor(m))), ib = Math.max(0, Math.min(g.nz - 2, Math.floor(b)));
  const ta = a - ia, tm = m - im, tb = b - ib;
  let sum = 0;
  for (let c = 0; c < 8; c++) {
    const da = c & 1, dm = (c >> 1) & 1, db = c >> 2;
    sum += f[((im + dm) * g.nz + ib + db) * g.nx + ia + da] * (da ? ta : 1 - ta) * (dm ? tm : 1 - tm) * (db ? tb : 1 - tb);
  }
  return sum;
}

// Like snapRims, for shaped openings: the vertices on the face within a cell of a shape's outline are moved onto it.
function snapShapes(parts, openings, shapes, fc) {
  const boxes = openings.map((o, i) => ({ o, ...shapes[i] }));
  for (const { position: p } of parts) {
    for (let i = 0; i < p.length; i += 3) {
      for (const { o, tx, tz, opening } of boxes) {
        const dx = p[i] - o.x, dy = p[i + 1] - o.y, dz = p[i + 2] - o.z;
        if (Math.abs(dy) > opening.bound + 1 || Math.abs(dx) > opening.bound + 2 || Math.abs(dz) > opening.bound + 2) continue;
        const along = dx * o.nx + dz * o.nz, t = dx * tx + dz * tz;
        if (Math.abs(along) > 0.35 || Math.abs(t) > opening.bound + 1) continue;
        const u = opening.u + t, y = o.y + dy, v = opening.sdf(u, y);
        if (Math.abs(v) >= 0.8 * fc) continue;
        const gu = (opening.sdf(u + 0.02, y) - opening.sdf(u - 0.02, y)) / 0.04, gy = (opening.sdf(u, y + 0.02) - opening.sdf(u, y - 0.02)) / 0.04, g2 = gu * gu + gy * gy;
        if (g2 < 0.2) continue; // (at a corner, where no one way is out)
        const mt = (-v * gu) / g2;
        p[i] += mt * tx; p[i + 1] += (-v * gy) / g2; p[i + 2] += mt * tz;
        break;
      }
    }
  }
}

// Where a vertex's smooth normal is further than this many degrees from its triangle's, the triangle's is used: a sharp edge stays sharp. The facade (the "skin"
// part) is flat, so any tilt of its normals near an opening is an artefact of the smoothing and the limit is tight there. The tubes and the reveals are curved.
const CREASE_SKIN = 8, CREASE_WALL = 22;
const REVEAL_BAND = 0.15; // metres: the part of the skin within this of a reveal counts as the tunnel's (for the x-ray mode), not the facade

// The radius of an opening's reveal at the distance s along its way out from where the opening was put (negative inside the wall): the tube's radius r at the
// throat (s = -D), widening to rOut at the face (s = 0), and on widening as a cone beyond it (see FLARE_EXP).
function coneRadius(s, r, rOut, D) {
  const mouth = ((rOut - r) * FLARE_EXP) / D;
  return s > 0 ? rOut + s * mouth : r + (rOut - r) * Math.pow(Math.max(0, 1 + s / D), FLARE_EXP);
}

// The mesh's vertices cannot lie on the sharp edge where a reveal meets the face (or the tunnel): they are on the grid's cell edges, so the edge becomes a bevel
// about a cell wide, and a small opening looks soft. The edge is known exactly (a circle of the mouth's radius, in the face), so every vertex within a cell of it is
// moved onto it. (Equal positions move together, so the surface stays closed.) `parts` are the { position, normal } sets to treat alike.
function snapRims(parts, openings, fc) {
  const tol = 1.1 * fc, CELL = 5;
  // the vertices in buckets of CELL metres (there can be hundreds of openings and a few hundred thousand vertices)
  const bucketKey = (x, y, z) => ((Math.floor(x / CELL) + 1000) * 2048 + (Math.floor(y / CELL) + 1000)) * 2048 + (Math.floor(z / CELL) + 1000);
  const buckets = new Map();
  parts.forEach((part, pi) => {
    const p = part.position;
    for (let i = 0; i < p.length; i += 3) {
      const key = bucketKey(p[i], p[i + 1], p[i + 2]);
      let list = buckets.get(key);
      if (!list) buckets.set(key, (list = []));
      list.push(pi, i);
    }
  });
  const near = (o, radius, visit) => {
    for (let kx = Math.floor((o.x - radius) / CELL); kx <= Math.floor((o.x + radius) / CELL); kx++) {
      for (let ky = Math.floor((o.y - radius) / CELL); ky <= Math.floor((o.y + radius) / CELL); ky++) {
        for (let kz = Math.floor((o.z - radius) / CELL); kz <= Math.floor((o.z + radius) / CELL); kz++) {
          const list = buckets.get(((kx + 1000) * 2048 + (ky + 1000)) * 2048 + (kz + 1000));
          if (list) for (let q = 0; q < list.length; q += 2) visit(parts[list[q]].position, list[q + 1]);
        }
      }
    }
  };
  // (a rim that runs into another opening's mouth is left as it is: snapping it would drag points of the other opening's surface onto it, and leave shards)
  const info = openings.map((o) => ({ o, ...revealOf(o) }));
  for (const { o, r, rOut, D } of info) {
    if (info.some((q) => q.o !== o && q.o.nx * o.nx + q.o.nz * o.nz > 0.5 && Math.hypot(q.o.x - o.x, q.o.y - o.y, q.o.z - o.z) < q.rOut + rOut - 0.1)) continue;
    const near2 = (rOut + 3) * (rOut + 3);
    // where the face is: from the vertices on it, beside the mouth
    const ss = [];
    near(o, rOut + 3, (p, i) => {
      const dx = p[i] - o.x, dy = p[i + 1] - o.y, dz = p[i + 2] - o.z;
      if (dx * dx + dy * dy + dz * dz > near2) return;
      const s = dx * o.nx + dz * o.nz;
      if (s < -1.5 || s > 1.5) return;
      const rho = Math.hypot(dx - s * o.nx, dy, dz - s * o.nz);
      if (rho > rOut + 0.8 && rho < rOut + 2.5) ss.push(s);
    });
    if (ss.length < 6) continue;
    ss.sort((a, b) => a - b);
    const rimS = ss[ss.length >> 1], rimR = coneRadius(rimS, r, rOut, D);
    near(o, rOut + 3, (p, i) => {
      const dx = p[i] - o.x, dy = p[i + 1] - o.y, dz = p[i + 2] - o.z;
      if (dx * dx + dy * dy + dz * dz > near2) return;
      const s = dx * o.nx + dz * o.nz, rx = dx - s * o.nx, rz = dz - s * o.nz, rho = Math.hypot(rx, dy, rz);
      if (rho < 1e-6 || Math.hypot(rho - rimR, s - rimS) >= tol) return;
      p[i] = o.x + rimS * o.nx + (rx / rho) * rimR; p[i + 1] = o.y + (dy / rho) * rimR; p[i + 2] = o.z + rimS * o.nz + (rz / rho) * rimR;
    });
  }
}

// Gives every vertex whose smooth normal is far (see CREASE) from the normal of its triangle that triangle's normal. { position, normal } are flat arrays of
// triangles (9 numbers each).
function sharpen({ position: p, normal: n }, degrees) {
  const CREASE = Math.cos((degrees * Math.PI) / 180);
  for (let t = 0; t + 8 < p.length; t += 9) {
    const ux = p[t + 3] - p[t], uy = p[t + 4] - p[t + 1], uz = p[t + 5] - p[t + 2], vx = p[t + 6] - p[t], vy = p[t + 7] - p[t + 1], vz = p[t + 8] - p[t + 2];
    let fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const fl = Math.hypot(fx, fy, fz);
    if (fl < 1e-12) continue;
    fx /= fl; fy /= fl; fz /= fl;
    // (the face normal on the side the smooth normals are on)
    const side = (n[t] + n[t + 3] + n[t + 6]) * fx + (n[t + 1] + n[t + 4] + n[t + 7]) * fy + (n[t + 2] + n[t + 5] + n[t + 8]) * fz < 0 ? -1 : 1;
    fx *= side; fy *= side; fz *= side;
    for (let v = 0; v < 9; v += 3) {
      if (n[t + v] * fx + n[t + v + 1] * fy + n[t + v + 2] * fz < CREASE) { n[t + v] = fx; n[t + v + 1] = fy; n[t + v + 2] = fz; }
    }
  }
}

export function createSkinShell() {
  let cache = null; // what is kept while the tunnels stay the same: the grid, the mass's distance field, the tunnels' field

  function* prepare(tunnels) {
    const key = `${tunnels.id}|${tunnels.version}`;
    if (cache?.key === key) return cache;
    cache = null;
    const openings = tunnels.openings();
    if (!openings.length) return null;
    const { massBox } = tunnels, { edges } = tunnels.network();
    const segs = edges.map((e) => [e.a.x, e.a.y, e.a.z, e.b.x, e.b.y, e.b.z, e.r]);
    const ox = massBox.x0 - PAD, oz = massBox.z0 - PAD, oy = -BELOW;
    const W = massBox.x1 - massBox.x0 + 2 * PAD, D = massBox.z1 - massBox.z0 + 2 * PAD, H = massBox.top + PAD + BELOW;
    const fc = Math.max(0.3, Math.min(1, Math.cbrt((W * D * H) / MAX_CELLS)));
    const nx = Math.ceil(W / fc), nz = Math.ceil(D / fc), ny = Math.ceil(H / fc), N = nx * nz * ny;
    const g = { ox, oy, oz, fc, nx, nz, ny, N };
    const at = (a, m, b) => (m * nz + b) * nx + a;

    // the mass as placed: solid below its height at every column, and on down below the ground under it (but not under the open ground beside
    // it, whose top would show as a lip round the foot of the walls), then its signed distance
    const solid = new Uint8Array(N), grid = new Float32Array(N), phi = new Float32Array(N);
    for (let b = 0; b < nz; b++) {
      for (let a = 0; a < nx; a++) {
        const h = tunnels.heightAt(ox + (a + 0.5) * fc, oz + (b + 0.5) * fc);
        for (let m = 0; m < ny; m++) {
          const y = oy + (m + 0.5) * fc;
          if (h > Math.max(0, y)) solid[at(a, m, b)] = 1;
        }
      }
      if (due()) { yield; fresh(); }
    }
    for (let k = 0; k < N; k++) grid[k] = solid[k] ? 0 : INF;
    distance3d(grid, nx, nz, ny);
    for (let k = 0; k < N; k++) if (!solid[k]) phi[k] = Math.min(LIMIT, (Math.sqrt(grid[k]) - 0.5) * fc);
    yield; fresh();
    for (let k = 0; k < N; k++) grid[k] = solid[k] ? INF : 0;
    distance3d(grid, nx, nz, ny);
    for (let k = 0; k < N; k++) if (solid[k]) phi[k] = -Math.min(LIMIT, (Math.sqrt(grid[k]) - 0.5) * fc);
    yield; fresh();

    // the tunnels: the distance to the nearest tube's surface (negative inside), near them only
    const tun = new Float32Array(N).fill(99);
    for (const [ax, ay, az, bx, by, bz, r] of segs) {
      const reach = r + TUBE_REACH, sx = bx - ax, sy = by - ay, sz = bz - az, len2 = sx * sx + sy * sy + sz * sz || 1;
      const a0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - ox) / fc)), a1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) + reach - ox) / fc));
      const b0 = Math.max(0, Math.floor((Math.min(az, bz) - reach - oz) / fc)), b1 = Math.min(nz - 1, Math.floor((Math.max(az, bz) + reach - oz) / fc));
      const m0 = Math.max(0, Math.floor((Math.min(ay, by) - reach - oy) / fc)), m1 = Math.min(ny - 1, Math.floor((Math.max(ay, by) + reach - oy) / fc));
      for (let m = m0; m <= m1; m++) {
        const y = oy + (m + 0.5) * fc;
        for (let b = b0; b <= b1; b++) {
          const z = oz + (b + 0.5) * fc;
          for (let a = a0; a <= a1; a++) {
            const x = ox + (a + 0.5) * fc;
            const u = Math.max(0, Math.min(1, ((x - ax) * sx + (y - ay) * sy + (z - az) * sz) / len2));
            const d = Math.hypot(x - (ax + sx * u), y - (ay + sy * u), z - (az + sz * u)) - r, k = at(a, m, b);
            if (d < tun[k]) tun[k] = d;
          }
        }
      }
      if (due()) { yield; fresh(); }
    }
    cache = { key, g, phi, tun, openings, fun: new Float32Array(N), tmp: new Float32Array(N), sh: new Float32Array(N) };
    return cache;
  }

  return {
    clear() { cache = null; },

    // The skin, a slice at a time (a generator). At the end { skin, wall }, each { position, normal } (flat arrays of triangles), the part on the tunnels
    // being `wall`. Null if there is nothing to make it from.
    // `cuts` ({ frame: { A, B }, rects: [{ y0, y1, a0, a1, b0, b1 }] }, optional) are the circulation's hallways as boxes (a, b in metres along the axes A and B, in
    // x and z): the skin is cut along the outline of every one that reaches it (see below).
    // `shaper` (optional) is a function of the openings that returns their shapes (see SHAPED OPENINGS), or null for the round ones.
    // `fine` tells the inside of the openings from the face as finely as for shaped ones, for openings that are given a colour of their own.
    *build(tunnels, cuts = null, shaper = null, fine = false) {
      const c = yield* prepare(tunnels);
      if (!c) return null;
      const { g, phi, tun, openings, fun, tmp, sh } = c, { ox, oy, oz, fc, nx, nz, ny } = g;
      const at = (a, m, b) => (m * nz + b) * nx + a;

      // 1. the mass as placed
      sh.set(phi);
      // 2. the flared reveal of every opening: a bell mouth along the way out, from the tube's radius at depth D inside the wall to a
      // wider mouth at the face. `fun` is its distance field (negative inside), joined to the tunnels' below.
      fun.fill(99);
      const shapes = shaper ? shaper(openings) : null;
      if (shapes) {
        for (let n = 0; n < openings.length; n++) {
          const o = openings[n], { tx, tz, opening } = shapes[n], reach = opening.bound + 1, span = reach + SHAPE_DEPTH + 1;
          const a0 = Math.max(0, Math.floor((o.x - span - ox) / fc)), a1 = Math.min(nx - 1, Math.floor((o.x + span - ox) / fc));
          const b0 = Math.max(0, Math.floor((o.z - span - oz) / fc)), b1 = Math.min(nz - 1, Math.floor((o.z + span - oz) / fc));
          const m0 = Math.max(0, Math.floor((o.y - reach - oy) / fc)), m1 = Math.min(ny - 1, Math.floor((o.y + reach - oy) / fc));
          for (let m = m0; m <= m1; m++) {
            const dy = oy + (m + 0.5) * fc - o.y;
            for (let b = b0; b <= b1; b++) {
              const dz = oz + (b + 0.5) * fc - o.z;
              for (let a = a0; a <= a1; a++) {
                const dx = ox + (a + 0.5) * fc - o.x, along = dx * o.nx + dz * o.nz, t = dx * tx + dz * tz;
                if (along < -SHAPE_DEPTH - 0.5 || along > 1.5 || Math.abs(t) > reach) continue;
                // the niche (its shape, from its back outwards) joined to the round tube
                const niche = Math.max(opening.sdf(opening.u + t, o.y + dy), -(along + SHAPE_DEPTH));
                const val = Math.min(niche, Math.hypot(t, dy) - o.r);
                const kk = at(a, m, b);
                if (val < fun[kk]) fun[kk] = val;
              }
            }
          }
          if (due()) { yield; fresh(); }
        }
      }
      for (const o of openings) {
        if (shapes) break; // (shaped openings are done above)
        const { r, rOut, D } = revealOf(o), reach = rOut + D + 1, mouth = ((rOut - r) * FLARE_EXP) / D;
        const a0 = Math.max(0, Math.floor((o.x - reach - ox) / fc)), a1 = Math.min(nx - 1, Math.floor((o.x + reach - ox) / fc));
        const b0 = Math.max(0, Math.floor((o.z - reach - oz) / fc)), b1 = Math.min(nz - 1, Math.floor((o.z + reach - oz) / fc));
        const m0 = Math.max(0, Math.floor((o.y - rOut - 1 - oy) / fc)), m1 = Math.min(ny - 1, Math.floor((o.y + rOut + 1 - oy) / fc));
        for (let m = m0; m <= m1; m++) {
          const dy = oy + (m + 0.5) * fc - o.y;
          for (let b = b0; b <= b1; b++) {
            const dz = oz + (b + 0.5) * fc - o.z;
            for (let a = a0; a <= a1; a++) {
              const dx = ox + (a + 0.5) * fc - o.x, s = dx * o.nx + dz * o.nz; // (s: how far out of the face, along the way out)
              if (s < -D - 0.5 || s > 1.5) continue;
              const rho = Math.hypot(dx - s * o.nx, dy, dz - s * o.nz), t = Math.min(1, Math.max(0, -s) / D), u = 1 - t;
              // (out beyond the face the cone goes on widening: where the skin's wall is a little out from where the opening was put, the cut then
              // still meets it as a cone, not as a step)
              const R = s > 0 ? rOut + s * mouth : r + (rOut - r) * Math.pow(u, FLARE_EXP), slope = s > 0 ? mouth : mouth * Math.pow(u, FLARE_EXP - 1);
              const val = (rho - R) / Math.sqrt(1 + slope * slope), k = at(a, m, b);
              if (val < fun[k]) fun[k] = val;
            }
          }
        }
        if (due()) { yield; fresh(); }
      }
      if (shapes || fine) tmp.set(sh); // (the skin before the openings are cut: what lies behind it afterwards is the inside of an opening)
      // 3. the tunnels (and their reveals) taken out: a hard cut, and a sharp edge
      for (let k0 = 0; k0 < g.N; k0 += 100000) {
        const k1 = Math.min(g.N, k0 + 100000);
        for (let k = k0; k < k1; k++) sh[k] = Math.max(sh[k], -Math.min(tun[k], fun[k]));
        if (due()) { yield; fresh(); }
      }

      // 3b. the circulation's hallways where they reach the skin: a hallway (one of the boxes of `cuts`) that crosses the surface of the skin (some of its grid cells
      // are in the stone and some on or outside it) is taken out of the stone with a hard cut, so that the skin has a clean rectangular opening that follows the
      // hallway's outline exactly, with no lip: the box's own planes. A hallway that is wholly inside the stone, or wholly out, does not touch the skin and is
      // left alone.
      if (cuts && cuts.rects.length) {
        const { A, B } = cuts.frame;
        for (const rc of cuts.rects) {
          const ca = (rc.a0 + rc.a1) / 2, cb = (rc.b0 + rc.b1) / 2, cy = (rc.y0 + rc.y1) / 2, ha = (rc.a1 - rc.a0) / 2, hb = (rc.b1 - rc.b0) / 2, hy = (rc.y1 - rc.y0) / 2;
          let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
          for (const [pa, pb] of [[rc.a0, rc.b0], [rc.a1, rc.b0], [rc.a1, rc.b1], [rc.a0, rc.b1]]) {
            const x = pa * A[0] + pb * B[0], z = pa * A[1] + pb * B[1];
            x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
          }
          const ia0 = Math.max(0, Math.floor((x0 - ox) / fc) - 1), ia1 = Math.min(nx - 1, Math.floor((x1 - ox) / fc) + 1);
          const ib0 = Math.max(0, Math.floor((z0 - oz) / fc) - 1), ib1 = Math.min(nz - 1, Math.floor((z1 - oz) / fc) + 1);
          const im0 = Math.max(0, Math.floor((rc.y0 - oy) / fc) - 1), im1 = Math.min(ny - 1, Math.floor((rc.y1 - oy) / fc) + 1);
          if (ia0 > ia1 || ib0 > ib1 || im0 > im1) continue;
          // the distance from a cell's centre to the box (negative inside): the largest of its distances to the box's planes
          const dist = (a, m, b) => {
            const x = ox + (a + 0.5) * fc, z = oz + (b + 0.5) * fc, y = oy + (m + 0.5) * fc;
            return Math.max(Math.abs(x * A[0] + z * A[1] - ca) - ha, Math.abs(x * B[0] + z * B[1] - cb) - hb, Math.abs(y - cy) - hy);
          };
          let lo = Infinity, hi = -Infinity;
          for (let m = im0; m <= im1; m++) for (let b = ib0; b <= ib1; b++) for (let a = ia0; a <= ia1; a++) {
            if (dist(a, m, b) > fc * 0.5) continue; // (only the cells in the box)
            const kk = at(a, m, b);
            // (the cells in or beside a tunnel's reveal are already open: a hallway that only meets the skin there would be cut into a slot that runs on behind the
            // facade, and a hallway kept back from the wall is only ever near the skin at a reveal, so it is left alone)
            if (fun[kk] < 1.2 || tun[kk] < 0.5) continue;
            const v = sh[kk];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          if (!(lo < 0.05 && hi > -0.05)) continue; // (wholly in the stone, or wholly out: it does not meet the skin)
          for (let m = im0; m <= im1; m++) {
            for (let b = ib0; b <= ib1; b++) {
              for (let a = ia0; a <= ia1; a++) {
                const k = at(a, m, b), v = -dist(a, m, b);
                if (v > sh[k]) sh[k] = v;
              }
            }
          }
          if (due()) { yield; fresh(); }
        }
      }

      // marching cubes on the result (inside the stone is below zero)
      const out = { skin: { position: [], normal: [] }, wall: { position: [], normal: [] } };
      yield* march(sh, g, 0, LIMIT, (ca, cm, cb) => {
        if (oy + (cm + 0.5) * fc < -fc) return null; // (the walls run just into the ground, so that they meet it everywhere; nothing deeper)
        const ia = Math.max(0, Math.min(nx - 1, Math.round(ca))), im = Math.max(0, Math.min(ny - 1, Math.round(cm))), ib = Math.max(0, Math.min(nz - 1, Math.round(cb)));
        const kk = at(ia, im, ib);
        // (a shaped or coloured opening is told apart finely, so that none of the face round it is taken for tunnel, nor any of its reveal for face)
        if (shapes || fine) {
          const niche = between(fun, g, ca, cm, cb), tube = between(tun, g, ca, cm, cb);
          const inside = niche < SHAPE_BAND || tube < SHAPE_BAND || ((niche < 0.8 || tube < 0.8) && between(tmp, g, ca, cm, cb) < -SHAPE_BEHIND);
          return inside ? out.wall : out.skin;
        }
        return tun[kk] < 0.7 || fun[kk] < REVEAL_BAND ? out.wall : out.skin; // (on or beside a tunnel's surface, or on a reveal, or on the skin)
      });
      // Sharp edges: the normals come from the gradient of the field, which smooths an edge over a cell or two. Where a vertex's normal is too far from
      // the normal of its own triangle (a corner, the rim of an opening, the throat of a reveal), the triangle's is used instead.
      if (shapes) snapShapes([out.skin, out.wall], openings, shapes, fc);
      else snapRims([out.skin, out.wall], openings, fc);
      sharpen(out.skin, CREASE_SKIN);
      sharpen(out.wall, CREASE_WALL);
      return out;
    },
  };
}

