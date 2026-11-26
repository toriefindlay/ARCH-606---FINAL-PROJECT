// VIEW (render): the interior systems with their materials. The wind tunnels as shiny metal ducting along the tunnels'
// own paths and radii, and the people's circulation as timber framing with drywall, from the circulation plan. The framing
// is a concept picture (spacings of ordinary light framing), not a structural design.
import * as THREE from "three";

/* ---------- ducting ---------- */

const SAMPLE = 0.25; // m: how finely a tube is followed to find where it leaves the mass
const SEAM = 1.2; // m: between the joints of the duct

// `tubes`: [{ a: {x, y, z}, b, r }]; `openings`: [{ x, y, z, nx, nz, r }]; `heightAt(x, z)`: the height of the mass.
// Each tube is drawn only where it is inside the mass, with a rounded joint where tubes meet, and a rim at every opening.
export function buildDucts(tubes, openings, heightAt, materials) {
  const pieces = [], joints = new Map(), seams = [];
  const inside = (p) => p.y > 0.05 && heightAt(p.x, p.z) > p.y;
  const join = (p, r) => {
    const key = `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`;
    const j = joints.get(key);
    if (!j) joints.set(key, { p, r, count: 1 });
    else { j.r = Math.max(j.r, r); j.count++; }
  };
  for (const { a, b, r } of tubes) {
    const from = new THREE.Vector3(a.x, a.y, a.z), to = new THREE.Vector3(b.x, b.y, b.z);
    const n = Math.max(1, Math.ceil(from.distanceTo(to) / SAMPLE));
    let start = -1;
    for (let i = 0; i <= n + 1; i++) {
      const isIn = i <= n && inside(from.clone().lerp(to, i / n));
      if (isIn && start < 0) start = i;
      if (!isIn && start >= 0) {
        const p = from.clone().lerp(to, start / n), q = from.clone().lerp(to, (i - 1) / n);
        if (p.distanceTo(q) > 0.05) pieces.push({ p, q, r });
        if (start === 0) join(p, r);
        if (i - 1 === n) join(q, r);
        start = -1;
      }
    }
  }

  const group = new THREE.Group();
  const up = new THREE.Vector3(0, 1, 0), out = new THREE.Vector3(0, 0, 1);
  const instanced = (geometry, material, list, set) => {
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    const m = new THREE.Matrix4(), position = new THREE.Vector3(), turn = new THREE.Quaternion(), scale = new THREE.Vector3();
    list.forEach((item, i) => {
      set(item, position, turn, scale);
      mesh.setMatrixAt(i, m.compose(position, turn, scale));
    });
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  };
  const axis = new THREE.Vector3();
  instanced(new THREE.CylinderGeometry(1, 1, 1, 28, 1, true), materials.metal, pieces, ({ p, q, r }, position, turn, scale) => {
    position.addVectors(p, q).multiplyScalar(0.5);
    axis.subVectors(q, p);
    scale.set(r, axis.length(), r);
    turn.setFromUnitVectors(up, axis.normalize());
  });
  instanced(new THREE.SphereGeometry(1, 28, 18), materials.metal, [...joints.values()].filter((j) => j.count > 1), ({ p, r }, position, turn, scale) => {
    position.copy(p);
    turn.identity();
    scale.setScalar(r * 1.005);
  });
  for (const { p, q, r } of pieces) {
    const length = p.distanceTo(q), count = Math.floor(length / SEAM), dir = q.clone().sub(p).normalize();
    for (let k = 1; k <= count; k++) seams.push({ at: p.clone().lerp(q, k / (count + 1)), dir, r });
  }
  const ring = new THREE.TorusGeometry(1.02, 0.035, 8, 36);
  instanced(ring, materials.seam, seams, ({ at, dir, r }, position, turn, scale) => {
    position.copy(at);
    turn.setFromUnitVectors(out, dir);
    scale.setScalar(r);
  });
  instanced(new THREE.TorusGeometry(1.04, 0.09, 12, 40), materials.seam, openings, (o, position, turn, scale) => {
    position.set(o.x, o.y, o.z);
    turn.setFromUnitVectors(out, axis.set(o.nx, 0, o.nz).normalize());
    scale.setScalar(o.r);
  });
  return group;
}

/* ---------- timber framing and drywall ---------- */

const STUD_SPACING = 0.406; // m: 16 inches
const STUD = 0.09, PLATE = 0.045; // m: a stud's depth, and a plate's or stud's thickness
const JOIST_DEPTH = 0.18;
const SHEET = 1.22; // m: a sheet of drywall or decking

// Collects boxes by material, then draws each material's boxes in one go.
function boxes() {
  const lists = new Map();
  const unit = new THREE.BoxGeometry(1, 1, 1);
  return {
    // A box of size [along, up, across] centred at `c`, its first side turned to the way (dx, dz), tipped up by `slope`.
    add(material, c, size, dx = 1, dz = 0, slope = 0) {
      if (!lists.has(material)) lists.set(material, []);
      lists.get(material).push({ c, size, turn: Math.atan2(-dz, dx), slope });
    },
    build() {
      const group = new THREE.Group();
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), tip = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3(0, 0, 1);
      for (const [material, list] of lists) {
        // (texture coordinates in metres need a geometry of their own for every size: boxes are grouped by size, to the centimetre)
        const sizes = new Map();
        for (const box of list) {
          const key = box.size.map((v) => Math.round(v * 100)).join(",");
          if (!sizes.has(key)) sizes.set(key, []);
          sizes.get(key).push(box);
        }
        for (const same of sizes.values()) {
          const [l, h, w] = same[0].size;
          const geometry = unit.clone().scale(Math.max(l, 0.01), Math.max(h, 0.01), Math.max(w, 0.01));
          const p = geometry.attributes.position, n = geometry.attributes.normal, uv = geometry.attributes.uv;
          const longUp = h > l; // (the grain runs along the longer of the two)
          for (let i = 0; i < p.count; i++) {
            const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
            const a = Math.abs(n.getX(i)) > 0.5 ? z : x, b = Math.abs(n.getY(i)) > 0.5 ? z : y;
            if (longUp) uv.setXY(i, b, a);
            else uv.setXY(i, a, b);
          }
          const mesh = new THREE.InstancedMesh(geometry, material, same.length);
          same.forEach((box, i) => {
            q.setFromAxisAngle(up, box.turn).multiply(tip.setFromAxisAngle(side, box.slope));
            mesh.setMatrixAt(i, m.compose(new THREE.Vector3(...box.c), q, new THREE.Vector3(1, 1, 1)));
          });
          mesh.castShadow = mesh.receiveShadow = true;
          mesh.frustumCulled = false;
          group.add(mesh);
        }
      }
      return group;
    },
  };
}

const chance = (a, b, c) => { const v = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453; return v - Math.floor(v); };

// A framed wall from (x0, z0) to (x1, z1), standing from y0 to y1: plates, studs, a row of blocking, and drywall on the
// side (nx, nz). Where `sheet(k)` says no, that sheet is left off, so that the framing shows.
function framedWall(out, materials, x0, z0, x1, z1, y0, y1, nx, nz, sheet) {
  const length = Math.hypot(x1 - x0, z1 - z0);
  if (length < 0.2) return;
  const dx = (x1 - x0) / length, dz = (z1 - z0) / length, height = y1 - y0;
  const at = (s, y, off = 0) => [x0 + dx * s + nx * off, y, z0 + dz * s + nz * off];
  for (const [y, h] of [[y0 + PLATE / 2, PLATE], [y1 - PLATE / 2, PLATE], [y1 - PLATE * 1.6, PLATE]]) out.add(materials.wood, at(length / 2, y), [length, h, STUD], dx, dz);
  const studs = Math.max(1, Math.round(length / STUD_SPACING));
  for (let i = 0; i <= studs; i++) out.add(materials.wood, at(Math.min(length - PLATE / 2, Math.max(PLATE / 2, (i * length) / studs)), y0 + height / 2), [PLATE, height - 3 * PLATE, STUD], dx, dz);
  out.add(materials.wood, at(length / 2, y0 + height * 0.52), [length, PLATE, STUD * 0.8], dx, dz);
  const sheets = Math.max(1, Math.round(length / SHEET)), wide = length / sheets;
  for (let k = 0; k < sheets; k++) {
    const cover = sheet(k); // 0: bare studs; else the share of the height that is boarded
    if (cover > 0) out.add(materials.drywall, at((k + 0.5) * wide, y0 + (height * cover) / 2, STUD / 2 + 0.008), [wide - 0.012, height * cover, 0.016], dx, dz);
  }
}

// The cells of one floor's connected hallways: the floor's joists and decking, and a framed wall along every open edge.
function hallwayFloor(out, materials, plan, floor) {
  const { a0, b0, g, na, nb, A, B } = plan.grid, mask = floor.mask;
  const world = (a, b, y) => [a * A[0] + b * B[0], y, a * A[1] + b * B[1]];
  const has = (i, j) => i >= 0 && j >= 0 && i < na && j < nb && mask[j * na + i] === 1;
  const inCore = (i, j) => { // (a hallway's edge against a core is its doorway: no wall there)
    const a = a0 + (i + 0.5) * g, b = b0 + (j + 0.5) * g;
    return plan.cores.some((c) => floor.s >= c.s0 && floor.s < c.s1 && a > c.a0 - 0.01 && a < c.a1 + 0.01 && b > c.b0 - 0.01 && b < c.b1 + 0.01);
  };
  const y0 = floor.y0 + 0.04, y1 = floor.y0 + plan.head;
  const runs = (count, filled, visit) => { // unbroken stretches of filled cells along a line
    let start = -1;
    for (let i = 0; i <= count; i++) {
      const on = i < count && filled(i);
      if (on && start < 0) start = i;
      if (!on && start >= 0) { visit(start, i); start = -1; }
    }
  };
  // joists across the A axis, at the usual spacing
  for (let a = a0 + 0.1; a < a0 + na * g; a += STUD_SPACING) {
    const i = Math.floor((a - a0) / g);
    runs(nb, (j) => has(i, j), (s, e) => out.add(materials.wood, world(a, b0 + ((s + e) / 2) * g, y0 - JOIST_DEPTH / 2), [(e - s) * g, JOIST_DEPTH, PLATE], B[0], B[1]));
  }
  // decking in strips along the B axis; some left off, to show the joists
  for (let j = 0; j < nb; j++) {
    runs(na, (i) => has(i, j), (s, e) => {
      const sheets = Math.max(1, Math.round(((e - s) * g) / (2 * SHEET))), long = ((e - s) * g) / sheets;
      for (let k = 0; k < sheets; k++) {
        if (chance(Math.floor((j * g) / SHEET), s + k, floor.s) < 0.18) continue;
        out.add(materials.deck, world(a0 + s * g + (k + 0.5) * long, b0 + (j + 0.5) * g, y0 + 0.012), [long - 0.012, 0.024, g], A[0], A[1]);
      }
    });
  }
  // walls: for each of the four sides a cell can be open on
  for (const [di, dj] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const alongA = dj !== 0, lines = alongA ? nb : na, cells = alongA ? na : nb;
    for (let line = 0; line < lines; line++) {
      const cell = (k) => (alongA ? [k, line] : [line, k]);
      runs(cells, (k) => { const [i, j] = cell(k); return has(i, j) && !has(i + di, j + dj) && !inCore(i + di, j + dj); }, (s, e) => {
        const edge = alongA ? b0 + (line + (dj > 0 ? 1 : 0)) * g : a0 + (line + (di > 0 ? 1 : 0)) * g;
        const from = alongA ? world(a0 + s * g, edge, 0) : world(edge, b0 + s * g, 0);
        const to = alongA ? world(a0 + e * g, edge, 0) : world(edge, b0 + e * g, 0);
        const nx = alongA ? B[0] * dj : A[0] * di, nz = alongA ? B[1] * dj : A[1] * di;
        // the boarding is peeled back in places: most sheets are whole, some stop part way up, some are off
        framedWall(out, materials, from[0], from[2], to[0], to[2], floor.y0, y1, nx, nz, (k) => {
          const c = chance(line + di * 3, s + k, floor.s + dj * 5);
          return c < 0.5 ? 1 : c < 0.68 ? 0.5 : 0;
        });
      });
    }
  }
}

// A core: its framed shaft, with timber stairs (treads on two stringers) or a steel lift. The layout is that of
// circulation/view.js, which draws the same cores in the working view.
function core(out, materials, plan, c) {
  const { g, A, B } = plan.grid, long = c.w >= c.h, u = long ? A : B;
  const length = Math.max(c.w, c.h) * g, width = Math.min(c.w, c.h) * g;
  const bottom = c.s0 * plan.storey, top = c.s1 * plan.storey + plan.head, height = top - bottom;
  const ca = (c.a0 + c.a1) / 2, cb = (c.b0 + c.b1) / 2, cx = ca * A[0] + cb * B[0], cz = ca * A[1] + cb * B[1];
  const dx = u[0], dz = u[1], vx = -dz, vz = dx; // along the long side, and across it
  const at = (x, y, z) => [cx + dx * x + vx * z, y, cz + dz * x + vz * z];
  const corner = (x, z) => { const p = at(x, 0, z); return [p[0], p[2]]; };
  // the shaft: corner posts, a ring of beams at every floor, and boarding on the lower part of two sides
  const hl = length / 2, hw = width / 2;
  for (const x of [-hl, hl]) for (const z of [-hw, hw]) out.add(materials.wood, at(x, bottom + height / 2, z), [0.14, height, 0.14], dx, dz);
  for (let s = c.s0; s <= c.s1; s++) {
    const y = Math.min(top - 0.1, s * plan.storey);
    for (const z of [-hw, hw]) out.add(materials.wood, at(0, y, z), [length, 0.18, 0.09], dx, dz);
    for (const x of [-hl, hl]) out.add(materials.wood, at(x, y, 0), [width, 0.18, 0.09], vx, vz);
  }
  for (let s = c.s0; s < c.s1; s++) {
    const y0 = s * plan.storey, y1 = y0 + plan.storey - 0.1;
    for (const [p, q, nx, nz] of [[corner(-hl, -hw), corner(hl, -hw), -vx, -vz], [corner(-hl, -hw), corner(-hl, hw), -dx, -dz]]) {
      framedWall(out, materials, p[0], p[1], q[0], q[1], y0 + 0.1, y1, nx, nz, (k) => (chance(c.a0 + s, k, c.b0) < 0.35 ? 0.5 : 0));
    }
  }
  if (c.kind === "lift") {
    for (const x of [-hl + 0.25, hl - 0.25]) for (const z of [-hw + 0.25, hw - 0.25]) out.add(materials.steel, at(x, bottom + height / 2, z), [0.1, height, 0.1], dx, dz);
    out.add(materials.steel, at(0, bottom + 1.25, 0), [length - 0.7, 2.4, width - 0.7], dx, dz);
    return;
  }
  const wall = 0.2, lift = plan.lift ? Math.min(2.4, width - 2 * wall) : 0;
  if (lift) {
    const x = -hl + wall + lift / 2;
    for (const px of [-lift / 2, lift / 2]) for (const pz of [-lift / 2, lift / 2]) out.add(materials.steel, at(x + px, bottom + height / 2, pz), [0.09, height, 0.09], dx, dz);
    out.add(materials.steel, at(x, bottom + 1.2, 0), [lift - 0.2, 2.3, lift - 0.2], dx, dz);
  }
  const xA = -hl + wall + (lift ? lift + 0.2 : 0), xB = hl - wall, flightWidth = Math.max(0.6, (width - 3 * wall) / 2);
  if (xB - xA <= 1) return;
  const flight = (x0, x1, y0, y1, z, wide) => {
    const steps = Math.max(2, Math.round((y1 - y0) / 0.18)), run = (x1 - x0) / steps, rise = (y1 - y0) / steps;
    for (let i = 0; i < steps; i++) out.add(materials.deck, at(x0 + (i + 0.5) * run, y0 + (i + 1) * rise - 0.03, z), [Math.abs(run) + 0.04, 0.05, wide], dx, dz);
    const span = Math.hypot(x1 - x0, y1 - y0), slope = Math.atan2(y1 - y0, x1 - x0);
    for (const side of [-wide / 2, wide / 2]) out.add(materials.wood, at((x0 + x1) / 2, (y0 + y1) / 2 - 0.12, z + side), [span, 0.24, 0.05], dx, dz, slope);
    for (const side of [-wide / 2, wide / 2]) out.add(materials.steel, at((x0 + x1) / 2, (y0 + y1) / 2 + 0.95, z + side), [span, 0.05, 0.05], dx, dz, slope);
  };
  for (let s = c.s0; s < c.s1; s++) {
    const y = s * plan.storey;
    if (c.narrow) {
      const forward = (s - c.s0) % 2 === 0;
      flight(forward ? xA : xB, forward ? xB : xA, y, y + plan.storey, 0, Math.max(0.6, width - 2 * wall));
    } else {
      const z = flightWidth / 2 + wall / 2;
      flight(xA, xB, y, y + plan.storey / 2, -z, flightWidth);
      flight(xB, xA, y + plan.storey / 2, y + plan.storey, z, flightWidth);
      out.add(materials.deck, at(xB - 0.35, y + plan.storey / 2 - 0.03, 0), [0.7, 0.06, width - 2 * wall], dx, dz);
    }
  }
}

// The circulation that is joined to an entrance: hallways, cores and doors. `plan` is circulation/structures.js's.
export function buildFraming(plan, materials) {
  const out = boxes();
  for (const part of plan.parts ?? [plan]) {
    for (const floor of part.floors) if (floor?.mask) hallwayFloor(out, materials, part, floor);
    for (const c of part.cores) if (c.connected !== false) core(out, materials, part, c);
    for (const e of part.entrances) {
      const w = part.grid.width, tx = e.nz, tz = -e.nx; // (along the wall)
      out.add(materials.door, [e.x, 1.1, e.z], [w - 0.16, 2.2, 0.08], tx, tz);
      for (const side of [-w / 2, w / 2]) out.add(materials.wood, [e.x + tx * side, 1.18, e.z + tz * side], [0.12, 2.36, 0.2], tx, tz);
      out.add(materials.wood, [e.x, 2.32, e.z], [w + 0.12, 0.14, 0.2], tx, tz);
    }
  }
  return out.build();
}

/* ---------- the massing's outline, for the interior view ---------- */

export function buildOutline(geometries, materials) {
  const group = new THREE.Group();
  for (const g of geometries) group.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), materials.ghost));
  return group;
}
