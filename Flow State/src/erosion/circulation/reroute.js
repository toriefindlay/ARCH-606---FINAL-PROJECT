// MODEL (circulation): moving the tunnels a little to go round the main cores. Pure logic, on a plain graph; nothing here touches the real tunnels (the
// caller applies the result with tunnels.applyRoute). Only the cores may do this: the hallways and the smaller stairs never move a tunnel.
//
// The graph is { nodes: [{ x, y, z, wall, ... }], edges: [{ a, b, r, ... }] } (a and b are indices into nodes). Each core is a rectangle in the axes the
// tunnels are drawn in (a, b), with a ring round it for the hallways to branch from. A tube may not come within its own radius (and a margin) of the
// ring's edge, so:
//  1. a point where tubes meet (not an opening on a wall) that is inside is moved out, to the nearest side, and the tubes at it go with it;
//  2. a tube that still crosses is cut where it enters and where it leaves, and goes round the ring by the shorter way (round its corners).
// The new points are given the height the tube had there, and every new tube keeps the old one's radius and properties.
const EPS = 0.1; // m: how far outside the ring the detour runs

// frame: { A, B } the axes (unit vectors in x, z). boxes: [{ a0, a1, b0, b1, ring }] in (a, b) metres (ring: m kept clear all round, on top of the tube's radius).
export function rerouteGraph(graph, boxes, frame, { margin = 0.3 } = {}) {
  const { A, B } = frame;
  const toAB = (x, z) => [x * A[0] + z * A[1], x * B[0] + z * B[1]];
  const fromAB = (a, b) => [a * A[0] + b * B[0], a * A[1] + b * B[1]];
  const nodes = graph.nodes.map((n) => ({ ...n }));
  const radius = new Float64Array(nodes.length);
  for (const e of graph.edges) { radius[e.a] = Math.max(radius[e.a], e.r); radius[e.b] = Math.max(radius[e.b], e.r); }

  // 1. points inside the rings are moved out
  const movedSet = new Set();
  for (let pass = 0; pass < 4; pass++) {
    let any = false;
    nodes.forEach((n, i) => {
      if (n.wall) return;
      for (const bx of boxes) {
        const ex = radius[i] + margin + bx.ring, [pa, pb] = toAB(n.x, n.z);
        if (pa > bx.a0 - ex && pa < bx.a1 + ex && pb > bx.b0 - ex && pb < bx.b1 + ex) {
          const dl = pa - (bx.a0 - ex), dr = bx.a1 + ex - pa, dd = pb - (bx.b0 - ex), du = bx.b1 + ex - pb, m = Math.min(dl, dr, dd, du);
          let na = pa, nb = pb;
          if (m === dl) na = bx.a0 - ex - EPS; else if (m === dr) na = bx.a1 + ex + EPS; else if (m === dd) nb = bx.b0 - ex - EPS; else nb = bx.b1 + ex + EPS;
          [n.x, n.z] = fromAB(na, nb);
          movedSet.add(i);
          any = true;
        }
      }
    });
    if (!any) break;
  }

  // 2. tubes that still cross a ring go round it
  const edges = [];
  let detoured = 0;
  for (const e of graph.edges) {
    const na = nodes[e.a], nb = nodes[e.b];
    const [a0p, a0q] = toAB(na.x, na.z), [b0p, b0q] = toAB(nb.x, nb.z);
    const dx = b0p - a0p, dz = b0q - a0q, len2 = dx * dx + dz * dz;
    const chain = [e.a]; // node indices from a to b
    if (len2 > 1e-8) {
      const yAt = (p, q) => { const u = Math.max(0, Math.min(1, ((p - a0p) * dx + (q - a0q) * dz) / len2)); return na.y + (nb.y - na.y) * u; };
      const used = new Set();
      let sp = a0p, sq = a0q;
      for (let guard = 0; guard < boxes.length; guard++) {
        // the first ring (not yet gone round) that the rest of the tube, from (sp, sq) to b, goes through
        let best = null;
        boxes.forEach((bx, bi) => {
          if (used.has(bi)) return;
          const ex = e.r + margin + bx.ring, hit = clip(sp, sq, b0p, b0q, bx.a0 - ex, bx.a1 + ex, bx.b0 - ex, bx.b1 + ex);
          if (hit && hit.t1 - hit.t0 > 1e-6 && (!best || hit.t0 < best.hit.t0)) best = { bi, bx, ex, hit };
        });
        if (!best) break;
        used.add(best.bi);
        const { bx, ex, hit } = best;
        const rect = { a0: bx.a0 - ex, a1: bx.a1 + ex, b0: bx.b0 - ex, b1: bx.b1 + ex };
        const corners = [[rect.a0, rect.b0], [rect.a1, rect.b0], [rect.a1, rect.b1], [rect.a0, rect.b1]]; // counterclockwise; side s runs from corner s to s + 1
        const p0 = [sp + (b0p - sp) * hit.t0, sq + (b0q - sq) * hit.t0], p1 = [sp + (b0p - sp) * hit.t1, sq + (b0q - sq) * hit.t1];
        const sideOf = (p) => { // the side of the rectangle a point on its edge is on
          const d = [Math.abs(p[1] - rect.b0), Math.abs(p[0] - rect.a1), Math.abs(p[1] - rect.b1), Math.abs(p[0] - rect.a0)];
          return d.indexOf(Math.min(...d));
        };
        const sIn = hit.e0 >= 0 ? SIDE_OF[hit.e0] : sideOf(p0), sOut = hit.e1 >= 0 ? SIDE_OF[hit.e1] : sideOf(p1); // (the sides it goes in and out by)
        if (sIn === sOut) continue; // (it only grazes a side: nothing to go round)
        const ccw = [], cw = [];
        for (let s = sIn; s !== sOut;) { s = (s + 1) % 4; ccw.push(corners[s]); }
        for (let s = sIn; ;) { cw.push(corners[s]); if (s === (sOut + 1) % 4) break; s = (s + 3) % 4; }
        const length = (list) => { let l = 0, p = p0; for (const c of list) { l += Math.hypot(c[0] - p[0], c[1] - p[1]); p = c; } return l + Math.hypot(p1[0] - p[0], p1[1] - p[1]); };
        const way = length(ccw) <= length(cw) ? ccw : cw;
        const cx = (rect.a0 + rect.a1) / 2, cy = (rect.b0 + rect.b1) / 2;
        for (const c of way) {
          const pa = c[0] + Math.sign(c[0] - cx) * EPS, pb = c[1] + Math.sign(c[1] - cy) * EPS, [x, z] = fromAB(pa, pb);
          nodes.push({ x, y: yAt(pa, pb), z, wall: false, br: na.br });
          chain.push(nodes.length - 1);
          sp = pa; sq = pb;
        }
        detoured++;
      }
    }
    chain.push(e.b);
    for (let i = 0; i + 1 < chain.length; i++) {
      const p = nodes[chain[i]], q = nodes[chain[i + 1]];
      edges.push({ ...e, a: chain[i], b: chain[i + 1], L: Math.max(0.2, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)) });
    }
  }
  return { nodes, edges, moved: movedSet.size, detoured };
}

// The side of the rectangle (0 bottom, 1 right, 2 top, 3 left: the order its corners are walked in) that each of clip's four limits (left, right, bottom,
// top) is on.
const SIDE_OF = [3, 1, 0, 2];

// The part of the segment (p0, q0) to (p1, q1) inside the rectangle [a0, a1] x [b0, b1] (Liang-Barsky), as parameters { t0, t1 } along it, with the limit
// (0 left, 1 right, 2 bottom, 3 top) it comes in by (e0) and goes out by (e1), -1 for an end that is already inside; or null.
function clip(p0, q0, p1, q1, a0, a1, b0, b1) {
  let t0 = 0, t1 = 1, e0 = -1, e1 = -1;
  const dp = p1 - p0, dq = q1 - q0;
  [[-dp, p0 - a0], [dp, a1 - p0], [-dq, q0 - b0], [dq, b1 - q0]].forEach(([pk, qk], idx) => {
    if (t0 === null) return;
    if (Math.abs(pk) < 1e-12) { if (qk <= 0) t0 = null; return; }
    const t = qk / pk;
    if (pk < 0) { if (t > t1) t0 = null; else if (t > t0) { t0 = t; e0 = idx; } } else if (t < t0) t0 = null; else if (t < t1) { t1 = t; e1 = idx; }
  });
  return t0 !== null && t0 < t1 ? { t0, t1, e0, e1 } : null;
}
