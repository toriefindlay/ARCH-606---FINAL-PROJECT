// VIEW (floor plans): one drawn plan (SVG) for every floor, in the manner of a hand-drafted ink plan: black on white, with
// no solid fills, told apart by the weight of the line and by dots and fine hatching. It shows the walls where they
// are cut through, the wind tunnels that run through the floor, and the circulation (hallways, stairs, lifts, doors and
// entrances). It only reads what the tunnels and the circulation have worked out.
//
// The sheet is turned so that the hallways (which run along the tunnels' two axes) are square to it, turned the lesser way,
// so that north stays towards the top; the north arrow shows by how much. All sheets share one frame, so the floors lie on
// one another as the deck is gone through.

const CELL = 0.25; // m: the grid a floor's extent is read on
const CUT = 1.2; // m above the floor: where the walls are cut
const HEADROOM = 2.2; // m: a floor is where the massing stands at least this far above it
const LEAST_FLOOR = 20; // m2: a level with less floor than this gets no sheet
const INK = "#111";
// The pens, in hundredths of the sheet: from the hairline of details up to the faces of the walls.
const PEN = { hair: 0.09, fine: 0.13, medium: 0.2, heavy: 0.3 };
const WALL = 1.05; // between the outer edges of the two lines a cut wall is drawn with, in hundredths of the sheet
const LETTERS = "'Century Gothic', 'Futura', 'Avenir Next', 'Helvetica Neue', Arial, sans-serif"; // thin and geometric, where there is one

const n2 = (v) => Math.round(v * 100) / 100;
const line = (p, q) => `M${n2(p[0])} ${n2(p[1])}L${n2(q[0])} ${n2(q[1])}`;
const shape = (points) => `M${points.map((p) => `${n2(p[0])} ${n2(p[1])}`).join("L")}Z`;

// The turn of the sheet: the angle of the tunnels' axis, brought to within 45 degrees either way. toSheet(x, z) gives the
// place on the sheet of a world point (north, -z, is up the sheet before the turn).
function sheetTurn(frame) {
  const A = frame?.A ?? [1, 0];
  let angle = Math.atan2(A[1], A[0]);
  while (angle > Math.PI / 4) angle -= Math.PI / 2;
  while (angle <= -Math.PI / 4) angle += Math.PI / 2;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return {
    toSheet: (x, z) => [x * cos + z * sin, -x * sin + z * cos],
    toWorld: (u, v) => [u * cos - v * sin, u * sin + v * cos],
    north: [-sin, -cos],
  };
}

// plan: the circulation's plan (circulation/structures.js). tunnels: the finished tunnels. triangles: calls visit() with
// every triangle of the massings' own meshes. Returns [{ level, svg, area, hallway, joined, openings, stairs, lifts }] from
// the ground up.
export function drawFloorPlans({ plan, tunnels, triangles }) {
  const { toSheet, toWorld, north } = sheetTurn(tunnels.frame);
  const storey = plan.storey, parts = plan.parts ?? [plan], box = tunnels.massBox;

  // the sheet's frame: round the whole massing, the same for every floor
  const corners = [[box.x0, box.z0], [box.x1, box.z0], [box.x1, box.z1], [box.x0, box.z1]].map(([x, z]) => toSheet(x, z));
  const left = Math.min(...corners.map((p) => p[0])), right = Math.max(...corners.map((p) => p[0]));
  const topEdge = Math.min(...corners.map((p) => p[1])), bottom = Math.max(...corners.map((p) => p[1]));
  const g = Math.max(CELL, Math.sqrt(((right - left) * (bottom - topEdge)) / 250000));
  const nu = Math.ceil((right - left) / g), nv = Math.ceil((bottom - topEdge) / g);
  const heights = new Float32Array(nu * nv);
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) heights[j * nu + i] = tunnels.heightAt(...toWorld(left + (i + 0.5) * g, topEdge + (j + 0.5) * g));
  }

  // each level's floor, as strips of the grid; its extent on the sheet
  const levels = [];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let s = 0; s < plan.storeys; s++) {
    const need = s * storey + HEADROOM;
    let strips = "", count = 0;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        if (heights[j * nu + i] < need) continue;
        let end = i;
        while (end < nu && heights[j * nu + end] >= need) end++;
        const u = left + i * g, v = topEdge + j * g, w = (end - i) * g;
        strips += `M${n2(u)} ${n2(v)}h${n2(w)}v${n2(g * 1.04)}h${n2(-w)}Z`;
        count += end - i;
        x0 = Math.min(x0, u); x1 = Math.max(x1, u + w); y0 = Math.min(y0, v); y1 = Math.max(y1, v + g);
        i = end;
      }
    }
    if (count * g * g >= LEAST_FLOOR) levels.push({ s, strips, area: count * g * g });
  }
  if (!levels.length) return [];

  // the walls: the massings' own mesh cut through at each level; a piece with building on both sides is inside, not a wall
  const walls = new Map(levels.map((l) => [l.s, ""]));
  triangles((ax, ay, az, bx, by, bz, cx, cy, cz) => {
    const P = [[ax, ay, az], [bx, by, bz], [cx, cy, cz]], low = Math.min(ay, by, cy), high = Math.max(ay, by, cy);
    for (const { s } of levels) {
      const cut = s * storey + CUT;
      if (cut <= low || cut >= high) continue;
      const ends = [];
      for (let i = 0; i < 3; i++) {
        const p = P[i], q = P[(i + 1) % 3];
        if ((p[1] - cut) * (q[1] - cut) >= 0) continue;
        const t = (cut - p[1]) / (q[1] - p[1]);
        ends.push([p[0] + (q[0] - p[0]) * t, p[2] + (q[2] - p[2]) * t]);
      }
      if (ends.length !== 2) continue;
      const [p, q] = ends, dx = q[0] - p[0], dz = q[1] - p[1], length = Math.hypot(dx, dz);
      if (length < 1e-4) continue;
      const ox = (-dz / length) * 0.7, oz = (dx / length) * 0.7, pieces = Math.ceil(length / 0.6);
      let d = "";
      for (let i = 0; i < pieces; i++) {
        const t = (i + 0.5) / pieces, x = p[0] + dx * t, z = p[1] + dz * t;
        if (tunnels.heightAt(x + ox, z + oz) > cut && tunnels.heightAt(x - ox, z - oz) > cut) continue;
        d += line(toSheet(p[0] + (dx * i) / pieces, p[1] + (dz * i) / pieces), toSheet(p[0] + (dx * (i + 1)) / pieces, p[1] + (dz * (i + 1)) / pieces));
      }
      if (d) walls.set(s, walls.get(s) + d);
    }
  });

  const pad = Math.max(x1 - x0, y1 - y0) * 0.14 + 2;
  const view = { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad + pad * 0.5 };
  const unit = Math.max(view.w, view.h) / 100; // a hundredth of the sheet: line weights and lettering go by it
  const { edges } = tunnels.network(), openings = tunnels.openings();

  return levels.map(({ s, strips, area }, index) => {
    const bandLow = s * storey, bandHigh = bandLow + storey;
    const id = `fp${s}`;

    // ---- the wind tunnels: each tube's run through this level, as wide as it is
    let outline = "", body = "", axis = "", shafts = "";
    for (const e of edges) {
      const dy = e.b.y - e.a.y;
      let from = 0, to = 1;
      if (Math.abs(dy) < 1e-6) { if (e.a.y < bandLow || e.a.y >= bandHigh) continue; } else {
        const p = (bandLow - e.a.y) / dy, q = (bandHigh - e.a.y) / dy;
        from = Math.max(0, Math.min(p, q)); to = Math.min(1, Math.max(p, q));
        if (to - from < 1e-3) continue;
      }
      const at = (t) => toSheet(e.a.x + (e.b.x - e.a.x) * t, e.a.z + (e.b.z - e.a.z) * t);
      const d = line(at(from), at(to)), width = Math.max(2 * e.r, unit * 0.9);
      outline += `<path d="${d}" stroke-width="${n2(width + 2 * unit * PEN.fine)}"/>`;
      body += `<path d="${d}" stroke-width="${n2(width)}"/>`;
      const flat = Math.hypot(e.b.x - e.a.x, e.b.z - e.a.z);
      if (flat * (to - from) > 1) axis += d;
      if (Math.abs(dy) > 1.2 * flat) { // (a shaft up through the floor)
        const [u, v] = at((from + to) / 2), r = Math.max(e.r, unit);
        shafts += `<circle cx="${n2(u)}" cy="${n2(v)}" r="${n2(r)}"/><circle cx="${n2(u)}" cy="${n2(v)}" r="${n2(r * 0.72)}" stroke-width="${n2(unit * PEN.hair)}"/><path d="${line([u - r * 0.7, v - r * 0.7], [u + r * 0.7, v + r * 0.7])}${line([u - r * 0.7, v + r * 0.7], [u + r * 0.7, v - r * 0.7])}"/>`;
      }
    }

    // ---- the circulation
    let joined = "", cutOff = "", joinedEdge = "", cutOffEdge = "", cores = "", doors = "", entrances = "";
    let hallway = 0, reachable = 0, stairs = 0, lifts = 0;
    const words = []; // where ENTRY has been written, so that two do not run into each other
    for (const part of parts) {
      const { a0, b0, g: step, na, nb, A, B } = part.grid;
      const at = (a, b) => toSheet(a * A[0] + b * B[0], a * A[1] + b * B[1]);
      const floor = part.floors[s];
      if (floor) {
        hallway += floor.length;
        for (const kind of ["mask", "detached"]) {
          const m = floor[kind];
          if (!m) continue;
          const has = (i, j) => i >= 0 && j >= 0 && i < na && j < nb && m[j * na + i] === 1;
          let fill = "", edge = "", cells = 0;
          for (let j = 0; j < nb; j++) {
            for (let i = 0; i < na; i++) {
              if (!has(i, j)) continue;
              let end = i;
              while (has(end, j)) end++;
              fill += shape([at(a0 + i * step, b0 + j * step), at(a0 + end * step, b0 + j * step), at(a0 + end * step, b0 + (j + 1.03) * step), at(a0 + i * step, b0 + (j + 1.03) * step)]);
              cells += end - i;
              i = end;
            }
          }
          // its sides, each straight run as one line
          for (const [across, outer, count, along] of [[0, -1, nb, na], [0, 1, nb, na], [1, -1, na, nb], [1, 1, na, nb]]) {
            for (let c = 0; c < count; c++) {
              let start = -1;
              for (let t = 0; t <= along; t++) {
                const i = across ? c : t, j = across ? t : c;
                const side = t < along && has(i, j) && !has(i + (across ? outer : 0), j + (across ? 0 : outer));
                if (side && start < 0) start = t;
                if (!side && start >= 0) {
                  const w = c + (outer > 0 ? 1 : 0);
                  edge += across ? line(at(a0 + w * step, b0 + start * step), at(a0 + w * step, b0 + t * step)) : line(at(a0 + start * step, b0 + w * step), at(a0 + t * step, b0 + w * step));
                  start = -1;
                }
              }
            }
          }
          if (kind === "mask") { joined += fill; joinedEdge += edge; reachable += cells; } else { cutOff += fill; cutOffEdge += edge; }
        }
      }
      for (const core of part.cores) {
        if (s < core.s0 || s > core.s1) continue;
        const drawn = drawCore(core, s, at, unit, !!part.lift);
        cores += drawn.svg; doors += drawn.doors; stairs += drawn.stairs; lifts += drawn.lifts;
      }
      if (s === 0) {
        for (const e of part.entrances) {
          const p = toSheet(e.x, e.z), q = toSheet(e.x + e.nx, e.z + e.nz), n = [q[0] - p[0], q[1] - p[1]], t = [-n[1], n[0]];
          const point = (out, side) => [p[0] + n[0] * out + t[0] * side, p[1] + n[1] * out + t[1] * side];
          entrances += `<path d="${shape([point(unit * 0.8, 0), point(unit * 3.4, unit * 1.05), point(unit * 3.4, -unit * 1.05)])}${line(point(unit * 3.4, 0), point(unit * 4.4, 0))}" fill="none" stroke="${INK}" stroke-width="${n2(unit * PEN.fine)}"/>`;
          // the word beyond the arrow, running away from it
          const label = point(unit * 4.8, 0), anchor = n[0] > 0.5 ? "start" : n[0] < -0.5 ? "end" : "middle";
          const drop = anchor === "middle" ? Math.sign(n[1]) * unit * 0.9 : 0;
          const middle = [label[0] + (anchor === "start" ? 1 : anchor === "end" ? -1 : 0) * unit * 3.4, label[1] + drop];
          if (words.some((w) => Math.abs(w[0] - middle[0]) < unit * 7.5 && Math.abs(w[1] - middle[1]) < unit * 2.6)) continue; // (the arrow is enough)
          words.push(middle);
          entrances += `<text x="${n2(label[0])}" y="${n2(label[1] + drop)}" text-anchor="${anchor}" dominant-baseline="middle" font-size="${n2(unit * 1.75)}" font-weight="300" letter-spacing="${n2(unit * 0.35)}">ENTRY</text>`;
        }
      }
    }

    // ---- the sheet's furniture: a scale bar and the north arrow
    const pen = (w) => n2(unit * PEN[w]);
    const bar = [20, 10, 5, 2].find((m) => m < view.w * 0.35) ?? 2;
    const bx = view.x + unit * 3, by = view.y + view.h - unit * 4;
    let ticks = line([bx, by], [bx + bar, by]) + line([bx, by + unit * 0.7], [bx + bar / 2, by + unit * 0.7]);
    for (let i = 0; i <= 4; i++) ticks += line([bx + (i * bar) / 4, by - unit * (i % 2 ? 0.5 : 1)], [bx + (i * bar) / 4, by + unit * (i <= 2 ? 0.7 : 0)]);
    const scale = `<path d="${ticks}" fill="none" stroke="${INK}" stroke-width="${pen("fine")}"/>` +
      `<text x="${n2(bx)}" y="${n2(by - unit * 1.8)}" text-anchor="middle">0</text><text x="${n2(bx + bar)}" y="${n2(by - unit * 1.8)}" text-anchor="middle">${bar} m</text>`;
    const nx = view.x + view.w - unit * 6, ny = view.y + unit * 7, [ux, uy] = north, r = unit * 2.8;
    const arrow = `<g fill="none" stroke="${INK}"><circle cx="${n2(nx)}" cy="${n2(ny)}" r="${n2(r)}" stroke-width="${pen("hair")}"/>` +
      `<path d="${line([nx - ux * r * 1.5, ny - uy * r * 1.5], [nx + ux * r * 1.5, ny + uy * r * 1.5])}${line([nx - uy * r * 1.25, ny + ux * r * 1.25], [nx + uy * r * 1.25, ny - ux * r * 1.25])}" stroke-width="${pen("hair")}"/>` +
      `<path d="${shape([[nx + ux * r * 1.5, ny + uy * r * 1.5], [nx - uy * r * 0.34, ny + ux * r * 0.34], [nx + uy * r * 0.34, ny - ux * r * 0.34]])}" stroke-width="${pen("fine")}"/></g>` +
      `<text x="${n2(nx + ux * (r + unit * 3.2))}" y="${n2(ny + uy * (r + unit * 3.2))}" text-anchor="middle" dominant-baseline="middle">N</text>`;

    // a line drawn twice, black then a narrower white, leaves the two fine lines of its sides, joined where such lines meet
    const wall = walls.get(s), face = unit * PEN.heavy;
    const dots = unit * 0.78, hatch = unit * 0.62;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n2(view.x)} ${n2(view.y)} ${n2(view.w)} ${n2(view.h)}" role="img" aria-label="Floor plan, level ${index + 1}" font-family="${LETTERS}" font-size="${n2(unit * 1.9)}" font-weight="300" letter-spacing="${n2(unit * 0.12)}" fill="${INK}" shape-rendering="geometricPrecision">` +
      `<defs><mask id="${id}-in" maskUnits="userSpaceOnUse" x="${n2(view.x)}" y="${n2(view.y)}" width="${n2(view.w)}" height="${n2(view.h)}"><path d="${strips}" fill="#fff" stroke="#fff" stroke-width="1.1"/></mask>` +
      // stipple for the wind's passages, close fine hatching for the hallways nothing reaches
      `<pattern id="${id}-dots" patternUnits="userSpaceOnUse" width="${n2(dots)}" height="${n2(dots)}" patternTransform="rotate(30)"><circle cx="${n2(dots / 2)}" cy="${n2(dots / 2)}" r="${n2(unit * 0.105)}" fill="${INK}"/></pattern>` +
      `<pattern id="${id}-hatch" patternUnits="userSpaceOnUse" width="${n2(hatch)}" height="${n2(hatch)}" patternTransform="rotate(45)"><line x1="${n2(hatch / 2)}" y1="0" x2="${n2(hatch / 2)}" y2="${n2(hatch)}" stroke="${INK}" stroke-width="${pen("hair")}"/></pattern></defs>` +
      // the hallways
      `<path d="${cutOff}" fill="url(#${id}-hatch)"/><path d="${joined}" fill="#fff"/>` +
      `<path d="${cutOffEdge}" fill="none" stroke="${INK}" stroke-width="${pen("fine")}" stroke-dasharray="${n2(unit * 0.9)} ${n2(unit * 0.45)}" stroke-linecap="butt"/>` +
      `<path d="${joinedEdge}" fill="none" stroke="${INK}" stroke-width="${pen("medium")}" stroke-linecap="square"/>` +
      // the walls cut through: two fine lines; the tunnels then break them where they open to the outside
      `<path d="${wall}" fill="none" stroke="${INK}" stroke-width="${n2(unit * WALL)}" stroke-linecap="round"/>` +
      `<path d="${wall}" fill="none" stroke="#fff" stroke-width="${n2(unit * WALL - 2 * face)}" stroke-linecap="round"/>` +
      `<path d="${wall}" fill="none" stroke="${INK}" stroke-width="${pen("hair")}" stroke-linecap="round" opacity="0.5"/>` +
      `<g mask="url(#${id}-in)" fill="none" stroke-linecap="round"><g stroke="${INK}">${outline}</g><g stroke="#fff">${body}</g><g stroke="url(#${id}-dots)">${body}</g>` +
      `<path d="${axis}" stroke="${INK}" stroke-width="${pen("hair")}" stroke-dasharray="${n2(unit * 2.4)} ${n2(unit * 0.5)} ${n2(unit * 0.12)} ${n2(unit * 0.5)}"/>` +
      `<g stroke="${INK}" stroke-width="${pen("fine")}" fill="#fff">${shafts}</g></g>` +
      cores + doors + entrances + scale + arrow +
      `</svg>`;

    const cellArea = parts[0].grid.g ** 2;
    return {
      level: index + 1, svg, area, hallway, joined: reachable * cellArea, stairs, lifts,
      openings: openings.filter((o) => o.y >= bandLow && o.y < bandHigh).length,
    };
  });
}

// One stair or lift on level s. at(a, b): the place on the sheet of a point of the circulation's grid.
function drawCore(core, s, at, unit, withLift) {
  const alongA = core.a1 - core.a0 >= core.b1 - core.b0;
  const length = alongA ? core.a1 - core.a0 : core.b1 - core.b0, width = alongA ? core.b1 - core.b0 : core.a1 - core.a0;
  // p along the core's length, q across it
  const P = (p, q) => (alongA ? at(core.a0 + p, core.b0 + q) : at(core.a0 + q, core.b0 + p));
  const frame = (p0, p1, inset = 0) => shape([P(p0 + inset, inset), P(p1 - inset, inset), P(p1 - inset, width - inset), P(p0 + inset, width - inset)]);
  const hair = n2(unit * PEN.hair), fine = n2(unit * PEN.fine), heavy = n2(unit * PEN.heavy), skin = Math.min(0.28, width * 0.1);
  // a shaft's walls: two fine lines
  const walled = (p0, p1) => `<path d="${frame(p0, p1)}" fill="#fff" stroke="${INK}" stroke-width="${heavy}"/><path d="${frame(p0, p1, skin)}" fill="none" stroke="${INK}" stroke-width="${fine}"/>`;
  const text = (p, q, words) => { const [u, v] = P(p, q); return `<text x="${n2(u)}" y="${n2(v)}" text-anchor="middle" dominant-baseline="middle" font-size="${n2(unit * 1.4)}" font-weight="400" stroke="#fff" stroke-width="${n2(unit * 0.55)}" paint-order="stroke">${words}</text>`; };
  const lift = (p0, p1) => {
    const [cu, cv] = P((p0 + p1) / 2, width / 2), r = Math.min(p1 - p0, width) * 0.27;
    return `${walled(p0, p1)}<path d="${line(P(p0 + skin, skin), P(p1 - skin, width - skin))}${line(P(p0 + skin, width - skin), P(p1 - skin, skin))}" stroke="${INK}" stroke-width="${hair}"/>` +
      `<circle cx="${n2(cu)}" cy="${n2(cv)}" r="${n2(r)}" fill="none" stroke="${INK}" stroke-width="${hair}"/>${text((p0 + p1) / 2, width / 2, "LIFT")}`;
  };

  let svg = "", stairs = 0, lifts = 0;
  if (core.kind === "lift") {
    svg = lift(0, length);
    lifts = 1;
  } else {
    let start = 0;
    if (withLift) { start = Math.min(2.4, length * 0.4); svg += lift(0, start); lifts = 1; }
    svg += walled(start, length);
    // treads, between a landing at each end; two flights side by side unless it is a narrow, straight stair
    const landing = Math.min(1.1, (length - start) * 0.2), from = start + landing, to = length - landing;
    let treads = "";
    for (let p = from; p <= to + 1e-6; p += 0.28) treads += line(P(p, skin), P(p, width - skin));
    if (!core.narrow) treads += line(P(from, width / 2 - 0.07), P(to, width / 2 - 0.07)) + line(P(from, width / 2 + 0.07), P(to, width / 2 + 0.07));
    // the break line, where the plan cuts the flight above
    const mid = from + (to - from) * 0.62;
    treads += line(P(mid - 0.35, width - skin), P(mid + 0.35, width / 2)) + line(P(mid - 0.17, width - skin), P(mid + 0.53, width / 2));
    svg += `<path d="${treads}" fill="none" stroke="${INK}" stroke-width="${hair}"/>`;
    const up = s < core.s1, q = core.narrow ? width / 2 : width * 0.25, head = Math.min(0.5, width * 0.2);
    const [su, sv] = P(from, q);
    svg += `<path d="${line(P(from, q), P(to, q))}${line(P(to, q), P(to - head, q - head * 0.45))}${line(P(to, q), P(to - head, q + head * 0.45))}" fill="none" stroke="${INK}" stroke-width="${fine}"/><circle cx="${n2(su)}" cy="${n2(sv)}" r="${n2(unit * 0.28)}" fill="${INK}"/>`;
    svg += text((start + length) / 2, core.narrow ? width / 2 : width * 0.72, up && s > core.s0 ? "UP / DN" : up ? "UP" : "DN");
    stairs = 1;
  }

  // the doors of this level: a gap in the wall, the leaf standing open, and its swing
  let doors = "";
  for (const door of core.doors.filter((d) => d.floor === s)) {
    // sides 0 and 1 are the ends in a, 2 and 3 the ends in b
    const endA = door.side < 2, fixed = endA ? (door.side ? core.a1 : core.a0) : door.side === 2 ? core.b0 : core.b1;
    const mid = endA ? (core.b0 + core.b1) / 2 : (core.a0 + core.a1) / 2, out = door.side === 0 || door.side === 2 ? -1 : 1;
    const point = (run, away) => (endA ? at(fixed + out * away, mid + run) : at(mid + run, fixed + out * away));
    const w = 0.55, hinge = point(-w, 0), shut = point(w, 0), open = point(-w, 2 * w);
    const swing = [1, 2, 3, 4, 5, 6].map((i) => { const a = (i / 6) * (Math.PI / 2); return point(-w + 2 * w * Math.cos(a), 2 * w * Math.sin(a)); });
    doors += `<path d="${line(hinge, shut)}" stroke="#fff" stroke-width="${n2(unit * 0.62)}"/>` +
      `<path d="${line(point(-w, -0.18), point(-w, 0.18))}${line(point(w, -0.18), point(w, 0.18))}${line(hinge, open)}" fill="none" stroke="${INK}" stroke-width="${fine}"/>` +
      `<path d="M${n2(shut[0])} ${n2(shut[1])}${swing.map((p) => `L${n2(p[0])} ${n2(p[1])}`).join("")}" fill="none" stroke="${INK}" stroke-width="${hair}"/>`;
  }
  return { svg, doors, stairs, lifts };
}
