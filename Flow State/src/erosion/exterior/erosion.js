// MODEL (exterior erosion): slices thin strands into the mass wherever people and cars touch it.
// No scene or DOM code. The erosion is uniform: it does not depend on the mass's shape, only on the routes taken.
//
// Contact is recorded on a grid of small cells. Each time a figure moves from one cell to the next while touching the
// mass, the link between those two cells is one more pass of that channel. A link is a straight piece of strand between the
// two cells' centres of use; linked cells form continuous strands that follow the routes exactly, and routes that share
// cells share strands. A strand starts hair-thin and gets 1% wider every time its channel is passed through.
import * as THREE from "three";
import { createCut } from "../contract.js";

const CELL = 0.5; // metres: the grid that passes are recorded on
const START_WIDTH = 0.03; // metres: half the width of a strand that has been passed once
const GROWTH = 1.01; // each pass makes a strand this much wider
const MAX_WIDTH = 1.2; // metres: the widest a strand's half-width gets
const DARKEST_PASSES = 200; // a channel passed this many times is as dark as it gets
const MAX_LINKS = 40000;
const JUMP = 8; // metres: a figure that moves farther than this between two steps has not walked there

export function createErosion(scan) {
  const { nU, nV, cu, cv } = scan;
  const cell = Math.max(CELL, Math.max(nU * cu, nV * cv) / 600);
  const fU = Math.ceil((nU * cu) / cell), fV = Math.ceil((nV * cv) / cell);
  const cells = fU * fV;
  const er = { scan, version: 0 };
  const passes = new Float32Array(cells); // passes through each cell
  const sumX = new Float32Array(cells), sumZ = new Float32Array(cells), uses = new Uint32Array(cells); // where in the cell figures were
  const links = new Map(); // "lower cell, higher cell" -> { a, b, count }
  let dirty = false;

  const touching = (x, y) => {
    const [u, v] = scan.toUV(x, -y); // site (east, north) -> world (x, z = -north) -> grid
    if (u < 0 || v < 0) return false;
    const i = Math.floor(u / (cu / scan.sub)), j = Math.floor(v / (cv / scan.sub));
    return i < scan.hw && j < scan.hh && scan.hf[j * scan.hw + i] > 0.5;
  };
  const cellOf = (x, y) => {
    const [u, v] = scan.toUV(x, -y);
    const i = Math.floor(u / cell), j = Math.floor(v / cell);
    return u < 0 || v < 0 || i >= fU || j >= fV ? -1 : j * fU + i;
  };
  const note = (k, x, y) => {
    sumX[k] += x;
    sumZ[k] += -y;
    uses[k]++;
  };
  const link = (a, b, strength) => {
    const key = a < b ? a * cells + b : b * cells + a;
    let l = links.get(key);
    if (!l) {
      if (links.size >= MAX_LINKS) return;
      l = { a: Math.min(a, b), b: Math.max(a, b), count: 0 };
      links.set(key, l);
    }
    l.count += strength;
    passes[b] += strength;
    dirty = true;
  };

  // A figure at (x, y) (site metres). `strength` is how many passes this counts as (the erosion speed). `agent` is the
  // figure, which remembers where it last touched the mass so that the cells in between can be linked.
  er.visit = (isCar, x, y, strength, agent) => {
    if (agent.erOwner !== er) { agent.erOwner = er; agent.erContact = false; } // its remembered cell belongs to an older erosion
    if (!touching(x, y)) { agent.erContact = false; return; }
    const k = cellOf(x, y);
    if (k < 0) { agent.erContact = false; return; }
    if (agent.erContact && Math.hypot(x - agent.erX, y - agent.erY) <= JUMP) {
      // Step along from the last position in half-cell steps, linking each new cell to the one before.
      const d = Math.hypot(x - agent.erX, y - agent.erY), steps = Math.max(1, Math.ceil(d / (cell * 0.5)));
      let last = agent.erCell;
      for (let s = 1; s <= steps; s++) {
        const px = agent.erX + ((x - agent.erX) * s) / steps, py = agent.erY + ((y - agent.erY) * s) / steps;
        const c = cellOf(px, py);
        if (c < 0 || c === last) continue;
        note(c, px, py);
        if (last >= 0) link(last, c, strength);
        last = c;
      }
      agent.erCell = last;
    } else {
      note(k, x, y);
      agent.erCell = k;
    }
    agent.erX = x;
    agent.erY = y;
    agent.erContact = true;
  };

  // How worn the ground is at a point, 0 (untouched) to 1 (very worn). People inside the mass are drawn to worn ground,
  // which is what makes separate trails settle into the same channels.
  er.wearAt = (x, y) => {
    const k = cellOf(x, y);
    return k < 0 ? 0 : Math.min(1, Math.log2(1 + passes[k]) / 8);
  };

  // Every strand as { ax, az, bx, bz, w, wear } in world metres: w is its half-width, wear 0..1 sets how dark it is.
  er.segments = () => {
    const at = (k) => {
      const n = uses[k];
      return n ? [sumX[k] / n, sumZ[k] / n] : scan.toXZ(((k % fU) + 0.5) * cell, (Math.floor(k / fU) + 0.5) * cell);
    };
    const out = [];
    for (const l of links.values()) {
      const [ax, az] = at(l.a), [bx, bz] = at(l.b);
      out.push({
        ax, az, bx, bz,
        w: Math.min(MAX_WIDTH, START_WIDTH * GROWTH ** Math.max(0, l.count - 1)),
        wear: Math.min(1, Math.log(1 + l.count) / Math.log(1 + DARKEST_PASSES)),
      });
    }
    return out;
  };

  // Call every so often: says whether the strands have changed since the last call.
  er.recompute = () => {
    if (!dirty) return false;
    dirty = false;
    er.version++;
    return true;
  };

  er.clear = () => {
    const had = links.size > 0;
    passes.fill(0);
    sumX.fill(0);
    sumZ.fill(0);
    uses.fill(0);
    links.clear();
    dirty = false;
    if (had) er.version++;
    return had;
  };
  return er;
}

/* ---------- the cut handed to the shared erosion pipeline ---------- */

let active = null;
let cached = { version: -1, cuts: [] };

export function setActiveErosion(er) {
  active = er;
  cached = { version: -1, cuts: [] };
}

// Signed-distance cut (negative inside the carved volume) for the shared pipeline: the union of the strands, each a vertical
// slice through the full height of the mass.
export function activeErosionCuts() {
  if (!active) return [];
  if (cached.version === active.version) return cached.cuts;
  const segments = active.segments();
  let cut = null;
  if (segments.length) {
    let top = 0;
    for (const h of active.scan.hf) top = Math.max(top, h);
    const bounds = new THREE.Box3();
    for (const s of segments) {
      bounds.expandByPoint(new THREE.Vector3(Math.min(s.ax, s.bx) - s.w, 0, Math.min(s.az, s.bz) - s.w));
      bounds.expandByPoint(new THREE.Vector3(Math.max(s.ax, s.bx) + s.w, top, Math.max(s.az, s.bz) + s.w));
    }
    const sdf = (x, y, z) => {
      let best = 1e3;
      for (const s of segments) {
        const dx = s.bx - s.ax, dz = s.bz - s.az;
        const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / (dx * dx + dz * dz || 1)));
        const d = Math.hypot(x - s.ax - dx * t, z - s.az - dz * t) - s.w;
        if (d < best) best = d;
      }
      return best;
    };
    cut = createCut({ id: "ext-flow-erosion", source: "exterior", label: "Flow erosion (people and cars)", bounds, sdf });
  }
  cached = { version: active.version, cuts: cut ? [cut] : [] };
  return cached.cuts;
}
