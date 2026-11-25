// MODEL (circulation): planning every separate structure on its own. Pure logic, like rules.js.
//
// With several massings the mass can be several buildings with open air between them. rules.js plans one building: its stairs
// between two floors, main cores and entrances are limited in number, and a stair has to open up a fair share of the floor to
// be worth having. Planned together, the buildings would compete for all of these, and some would be left with few stairs or
// none. So the footprint is split into its separate pieces (massings that touch are one building), each is planned as if it
// stood alone, and the plans are put side by side. A single building is planned exactly as rules.js does it.
import { planCirculation } from "./rules.js";

const CELL = 0.5; // m: the grid the footprint is split on
const MAX_CELLS = 1000000; // (made coarser above this)
const MARGIN = 3; // m: the ground round a structure that goes with it, so that its walls are read exactly where they are
const MIN_AREA = 40; // m2: a smaller piece of footprint has no room for hallways (see MIN_FLOOR in rules.js)
const SOLID = 0.5; // m: lower than this is not part of a structure

// The separate structures of the mass: { list: [{ box }], at(x, z) } where at gives the index in `list` of the structure
// whose footprint (or margin) a point is in, or -1. They are listed from west to east.
export function findStructures(site) {
  const b = site.box, x0 = b.x0 - MARGIN, z0 = b.z0 - MARGIN, W = b.x1 - b.x0 + 2 * MARGIN, D = b.z1 - b.z0 + 2 * MARGIN;
  const g = Math.max(CELL, Math.sqrt((W * D) / MAX_CELLS)), nx = Math.ceil(W / g), nz = Math.ceil(D / g);
  const solid = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) solid[j * nx + i] = site.heightAt(x0 + (i + 0.5) * g, z0 + (j + 0.5) * g) > SOLID ? 1 : 0;

  // the pieces of footprint (cells that touch, corners included)
  const label = new Int32Array(nx * nz).fill(-1), seen = new Uint8Array(nx * nz), found = [];
  for (let start = 0; start < solid.length; start++) {
    if (!solid[start] || seen[start]) continue;
    const cells = [start];
    seen[start] = 1;
    let i0 = nx, i1 = 0, j0 = nz, j1 = 0;
    for (let head = 0; head < cells.length; head++) {
      const k = cells[head], i = k % nx, j = (k - i) / nx;
      i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj, q = jj * nx + ii;
          if (ii >= 0 && jj >= 0 && ii < nx && jj < nz && solid[q] && !seen[q]) { seen[q] = 1; cells.push(q); }
        }
      }
    }
    if (cells.length * g * g < MIN_AREA) continue;
    found.push({ cells, box: { x0: x0 + i0 * g, x1: x0 + (i1 + 1) * g, z0: z0 + j0 * g, z1: z0 + (j1 + 1) * g, top: b.top } });
  }
  found.sort((p, q) => p.box.x0 + p.box.x1 - (q.box.x0 + q.box.x1));

  // each takes the open ground within MARGIN of it (the nearer structure where two margins meet)
  let front = [];
  found.forEach((s, n) => { for (const k of s.cells) { label[k] = n; front.push(k); } });
  for (let step = Math.ceil(MARGIN / g); step > 0; step--) {
    const next = [];
    for (const k of front) {
      const i = k % nx, j = (k - i) / nx;
      for (const [q, ok] of [[k - 1, i > 0], [k + 1, i < nx - 1], [k - nx, j > 0], [k + nx, j < nz - 1]]) {
        if (ok && !solid[q] && label[q] < 0) { label[q] = label[k]; next.push(q); }
      }
    }
    front = next;
  }

  const at = (x, z) => {
    const i = Math.floor((x - x0) / g), j = Math.floor((z - z0) / g);
    return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : label[j * nx + i];
  };
  return { list: found.map((s) => ({ box: s.box })), at };
}

// The circulation of everything: as planCirculation (rules.js). With more than one structure, the result also has `parts`, the
// plan of each (each with its own grid, along the same axes), and its cores, entrances, paths and totals are those of all.
export function planStructures(site, options = {}) {
  const { list, at } = findStructures(site);
  if (list.length < 2) return planCirculation(site, options);

  // The tunnels as a graph. In "main" mode each structure moves them round its own cores, so each starts from the last one's.
  let graph = site.graph, moved = false;
  const parts = list.map((s, n) => {
    const heightAt = (x, z) => (at(x, z) === n ? site.heightAt(x, z) : 0);
    const plan = planCirculation({ ...site, box: s.box, heightAt, graph }, options);
    if (plan.graph) { graph = plan.graph; moved = true; }
    return plan;
  });

  const stats = {};
  for (const p of parts) for (const [key, value] of Object.entries(p.stats)) stats[key] = (stats[key] ?? 0) + value;
  const all = (key) => parts.flatMap((p) => p[key] ?? []);
  const entrances = all("entrances");
  return {
    parts,
    grid: parts[0].grid, storey: site.storey, storeys: site.storeys, head: parts[0].head,
    mode: parts.some((p) => p.mode === "main") ? "main" : "scattered",
    graph: moved ? graph : null,
    cores: all("cores"), paths: all("paths"), entrances, entrance: entrances[0] ?? null,
    stats,
    warnings: parts.flatMap((p, n) => p.warnings.map((text) => `Structure ${n + 1}: ${text}`)),
  };
}
