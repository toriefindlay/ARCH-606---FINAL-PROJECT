// MODEL (exterior erosion): the wind tunnels as a vein network driven by the air that flows through it. No scene or DOM code.
//
// The tunnels are a graph: points joined by tubes, each tube with a radius. The wind loads the walls of the mass (high pressure on the windward
// ones, low on the leeward and side ones), the walls where a tube ends are held at that pressure, and the air flows through the tubes from high
// pressure to low like current through a network of resistors: a tube of radius r and length L carries (pressure difference) x r^4 / L.
// Everything about the network is then decided by that flow, round after round:
//  - Radius. A tube takes a radius that grows with the air it carries (a Murray's-law relation, r proportional to a power of the flow): trunks that carry a lot
//    are wide, the branches they split into are thinner, and a tube that carries almost nothing shrinks away and is removed. All radii are
//    scaled together so that the whole network holds the volume limit.
//  - Growth. Channels start at windward walls and grow, a metre at a time, towards the low-pressure walls (wandering a little, bending round
//    the occupied spaces and keeping inside the mass), and branches sprout from the tubes that carry most air, towards the parts of the floors
//    that no tunnel cools yet. A branch that finds no way for the air to go carries nothing and withers.
//  - Joining. Where two tubes that are at different pressures come near, a link is made between them: if air flows through it, it stays and
//    widens, which is how tunnels join, split round a space and make loops.
// Nothing fixes where a tunnel is or how wide: only the flow. Never touched: the roof, the ground layer, the corners of the mass (CLEAR from
// them), and the occupied spaces (the interior erosion's spheres).
//
// The network is grown for one wind (the main one), then tuned against the cooling it gives over several (see startTuning), by simulated annealing.
// When the network is finished it is cut into the voxels, the real airflow (potential flow, voxelFlow.js) is solved through them, and
// cooling() says how well the floors are cooled: every floor voxel takes the strongest cooling of any tunnel air within REACH metres.
import { createVoxelMass, solveFlow, tick, AIR, MASS } from "./voxelFlow.js";

export const STOREY = 14 * 0.3048; // metres: one storey, 14 ft
export const REACH = 3; // metres: how far from a tunnel its moving air is taken to cool the floor
export const NEAR = 0.3; // cooling (see cooling()) at which a floor voxel counts as fully cooled: about 2 m from air at the open wind's speed. Less counts in proportion.
const LAYERS = 5; // voxel layers in a storey
const CLEAR = 1; // metres: the least that tunnels keep from the corners of the mass
const STEP = 1.5; // metres a channel grows in a round
const R_START = 0.6, R_MIN = 0.5, R_MAX = 1.6; // metres: the radius of a new tube, the radius below which a shrinking tube is removed, the most a trunk gets
const R_FLOOR = 0.7; // metres: the least radius of a tube that carries air (no thin veins: few, wide tunnels move more air and cool further, see reachOf)
const REL_PRUNE = 0.015; // a tube that carries less than this part of the flow near it is removed
const R_REF = 0.7; // metres: the radius of a tube whose moving air cools out to REACH (a wider tube reaches further, a narrower one less far, see reachOf)
const GROW_ROUNDS = 100, SETTLE_ROUNDS = 15;
const ALIGN = 0.4, FLAT = 0.4; // how strongly a branch is turned along the wind, and how much its up-and-down is damped
const TRUNK_GAP = 9; // metres: the trunks start at least this far apart (about twice the reach of a trunk, so that they cover the floor between them)
const TRUNK_ROUNDS = 45; // rounds in which only the straight trunks grow, before any branch sprouts
const TUNE_SECONDS = 14; // (40 s gave about 4.4% more cooling score on the test slab, 10 s about 2.4%) // (30 s gave only about 1.5% more cooling score than this slice of trials: about 300 trials, each re-solving the whole network) // how long the best network is tuned for (see startTuning)
const TUNE_PER_WIND = 4; // seconds more tuning for every wind after the first that the network is judged against (see startTuning)
const VARIANTS = 1; // (one network, so that the tunnels are never wiped to grow another; the tuning does the improving)
const TUNE_SHOW_MS = 900; // while tuning, the drawn network is brought up to date at most this often (a change at a time would twitch) // networks grown from different random starts, of which the best is kept
const JUNCTION = 0.8, BEND = 0.05, FRICTION = 0.04, PICARD = 3; // losses at a point where a tube ends or tubes meet (the opening, a junction), at a point where one simply carries on (a slight bend), friction along it (per diameter), and the rounds of settling the flow
const MAX_GROWING = 50; // channels growing at once at most (each is a tube that carries nothing yet, and costs volume) // rounds in which the network grows, and rounds after that in which it only adapts
const RAMP_ROUNDS = 80; // rounds over which the volume allowed rises to the limit
const MURRAY = 0.22; // radius ~ flow^MURRAY (Murray's law says 1/3, but with that parallel tubes fight until one is left: a smaller power lets them share)
const WALL_OUT = 1.2; // metres: a tube that ends at a wall goes this far outside it (so that the opening is cut cleanly)
const HASH_CELL = 4; // metres: the cells of the lookup for what is near

let salt = 0; // changes the random pattern (each variant of the network has its own)
const hash = (k) => { let x = Math.imul((k + salt) ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16; return (x >>> 0) / 4294967295; }; // 0..1

let serial = 0;
export function createTunnels(form, { cityHeight = null } = {}) {
  const vox = createVoxelMass(form, { cityHeight, maxCells: 500000, storey: STOREY, perStorey: LAYERS });
  if (!vox) return null;
  const { nx, nz, ny, c, cells, dz, yc } = vox;
  const nxz = nx * nz, perStorey = vox.perStorey, layerHeight = STOREY / perStorey;
  const placed = Uint8Array.from(cells); // the mass as it was placed, to put it back
  const roof = new Int16Array(nxz).fill(-1); // the layer of the top mass voxel in every column (-1 where there is none)
  for (let k = 0; k < placed.length; k++) if (placed[k] === MASS) roof[k % nxz] = Math.floor(k / nxz);
  let top = -1;
  for (let col = 0; col < nxz; col++) top = Math.max(top, roof[col]);
  const storeys = Math.max(1, Math.ceil((top + 1) / perStorey));
  const hiLayer = Math.min(ny, storeys * perStorey);
  let massVolume = 0, bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  for (let k = 0; k < placed.length; k++) if (placed[k] === MASS) massVolume += dz[Math.floor(k / nxz)] * c * c; // (m3: the layer's height times the area of a cell)
  for (let col = 0; col < nxz; col++) {
    if (roof[col] < 0) continue;
    const i = col % nx, j = Math.floor(col / nx);
    bx0 = Math.min(bx0, vox.x0 + i * c); bx1 = Math.max(bx1, vox.x0 + (i + 1) * c);
    bz0 = Math.min(bz0, vox.z0 + j * c); bz1 = Math.max(bz1, vox.z0 + (j + 1) * c);
  }
  const yFloor = vox.ye[1]; // the ground layer is never opened
  // the floor area of every storey (the mass cells at its middle layer): the trunks and the volume are shared out by it
  const stArea = new Float64Array(storeys);
  for (let s = 0; s < storeys; s++) {
    const l = Math.min(ny - 1, s * perStorey + (perStorey >> 1));
    for (let col = 0; col < nxz; col++) if (placed[l * nxz + col] === MASS) stArea[s] += c * c;
  }
  let stAreaSum = 0;
  for (const a of stArea) stAreaSum += a;
  const stShare = (s) => 0.5 * stArea[s] / (stAreaSum || 1) + 0.5 / storeys; // half by floor area, half equal, so that a small top floor is not starved
  const stOf = (e) => Math.max(0, Math.min(storeys - 1, Math.floor((e.a.y + e.b.y) / 2 / STOREY)));

  // The columns round the corners of the mass (a column with open sides both ways, and the ones within CLEAR of it): never opened.
  const isMass = (i, j) => i >= 0 && j >= 0 && i < nx && j < nz && roof[j * nx + i] >= 0;
  const prot = new Uint8Array(nxz);
  {
    const r = Math.max(1, Math.ceil(CLEAR / c));
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        if (!isMass(i, j)) continue;
        if (!((!isMass(i - 1, j) || !isMass(i + 1, j)) && (!isMass(i, j - 1) || !isMass(i, j + 1)))) continue;
        for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) if (i + di >= 0 && j + dj >= 0 && i + di < nx && j + dj < nz) prot[(j + dj) * nx + i + di] = 1;
      }
    }
  }
  const columnAt = (x, z) => { const i = Math.floor((x - vox.x0) / c), j = Math.floor((z - vox.z0) / c); return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : j * nx + i; };

  // The walls of the mass as points the tubes can end at: { x, y, z, nx, nz } (the way out). Not at the corners.
  const facade = [];
  const hasAt = (i, j, l) => i >= 0 && j >= 0 && i < nx && j < nz && roof[j * nx + i] >= l; // is there mass in this column at layer l?
  const cornerNear = (i, j, l) => {
    const r = Math.max(1, Math.ceil(CLEAR / c));
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const a = i + di, b = j + dj;
        if (!hasAt(a, b, l)) continue;
        if ((!hasAt(a - 1, b, l) || !hasAt(a + 1, b, l)) && (!hasAt(a, b - 1, l) || !hasAt(a, b + 1, l))) return true;
      }
    }
    return false;
  };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const col = j * nx + i;
      if (roof[col] < 0 || prot[col]) continue;
      // layer by layer: a face is a wall wherever the next column has no mass at that height (so the walls of an upper part that stands over a
      // lower one count too, not only the walls at the edge of the footprint)
      for (let l = 1; l < roof[col]; l++) {
        let ox = 0, oz = 0;
        if (!hasAt(i - 1, j, l)) ox -= 1;
        if (!hasAt(i + 1, j, l)) ox += 1;
        if (!hasAt(i, j - 1, l)) oz -= 1;
        if (!hasAt(i, j + 1, l)) oz += 1;
        if (!ox && !oz) continue;
        if (cornerNear(i, j, l)) continue; // corners at this height are kept clear too
        const len = Math.hypot(ox, oz), x = vox.x0 + (i + 0.5) * c + (ox / len) * (c / 2), z = vox.z0 + (j + 0.5) * c + (oz / len) * (c / 2);
        facade.push({ x, y: yc[l], z, nx: ox / len, nz: oz / len });
      }
    }
  }

  /* ---------- the network ---------- */
  let obstacles = [], obstaclesKey = "";
  let wind = [1, 0]; // the wind the network is grown for (the main one)
  let windSet = []; // the winds it is judged against: [{ dir: [ux, uz], weight }], the weights adding up to 1 (see setWindSet)
  let nodes = [], edges = [];
  const bTop = vox.ye[Math.min(ny, top + 1)]; // how high the mass is
  let variant = 0, best = null; // the variant being grown, and the best finished so far
  let buoyancy = 0; // the stack effect, per metre of height (see setBuoyancy)
  let iteration = 0, finished = false, version = 0, epoch = 0, branchCount = 0;
  let uncovered = []; // the points of the mass no tunnel cools yet
  let attractors = null; // sample points in the mass
  let flowResult = null, flowVersion = -1, flowDir = null, mapKey = "", map = null, networkVolume = 0;

  // The pressure (in units of the wind's dynamic pressure) the wind puts on a wall whose way out is (nx, nz) at height y, dc metres from the
  // nearest corner of the mass: high where it blows on it, low in its lee, a little low at the sides, and the stronger the higher up (the wind
  // is faster there); near a corner the suction on the leeward and side walls is much stronger (the air is pulled round it).
  const wallPressure = (wx, wz, y = 0, dc = 99, w = wind) => {
    const cd = wx * w[0] + wz * w[1]; // -1 on the windward wall, +1 on the leeward
    const height = 0.75 + 0.5 * Math.min(1, y / Math.max(5, bTop));
    let p = (cd < 0 ? -0.8 * cd : -0.5 * cd) - 0.3 * (1 - cd * cd);
    if (cd > -0.3) p -= 0.5 * Math.max(0, 1 - dc / 5);
    return p * height;
  };
  const corners = []; // the corners of the mass
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) if (isMass(i, j) && (!isMass(i - 1, j) || !isMass(i + 1, j)) && (!isMass(i, j - 1) || !isMass(i, j + 1))) corners.push([vox.x0 + (i + 0.5) * c, vox.z0 + (j + 0.5) * c]);
  const cornerDist = (x, z) => { let d = Infinity; for (const q of corners) d = Math.min(d, Math.hypot(q[0] - x, q[1] - z)); return d; };  const windOf = (f) => f.nx * wind[0] + f.nz * wind[1];

  const sphereClear = (x, y, z, rad) => { // is the point at least rad (and a margin) from every occupied space?
    for (const s of obstacles) if (Math.hypot(x - s.x, y - s.y, z - s.z) < s.r + rad + 0.3) return false;
    return true;
  };
  // May a tube of radius rad have its axis here? Inside the mass, with a roof left over it and a floor under it, and away from the corners.
  const inside = (x, y, z, rad) => {
    const h = form.heightAt(x, z);
    if (h < y + rad + 0.4 || y - rad < yFloor) return false;
    const col = columnAt(x, z);
    return col >= 0 && !prot[col];
  };

  const addNode = (x, y, z, extra = {}) => { const n = { x, y, z, wall: false, pf: 0, p: 0, br: 0, ...extra }; nodes.push(n); return n; };
  const addEdge = (a, b, r = R_START, extra = {}) => { const e = { a, b, r, L: Math.max(0.2, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)), q: 0, born: iteration, br: 0, ...extra }; edges.push(e); return e; };

  // A wall node outside the mass at a facade point.
  // (it keeps its way out (wx, wz) and its distance from the nearest corner (dc), so that its pressure can be worked out again for another wind)
  const wallNodeAt = (x, y, z, wx, wz) => { const dc = cornerDist(x, z); return addNode(x + wx * WALL_OUT, y, z + wz * WALL_OUT, { wall: true, wx, wz, dc, pf: wallPressure(wx, wz, y, dc) }); };

  /* ---------- growth ---------- */
  const growing = new Map(); // branch number -> the tip that is growing: { node, dir, target, len, maxLen }
  const startChannel = (f) => {
    const w = wallNodeAt(f.x, f.y, f.z, f.nx, f.nz);
    const first = addNode(f.x - f.nx * 1.5, f.y, f.z - f.nz * 1.5, { br: ++branchCount });
    addEdge(w, first, R_START, { br: first.br });
    first.p = w.pf;
    return { node: first, dir: [-f.nx, 0, -f.nz], target: null, len: 0, maxLen: 140 };
  };

  const normalise = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

  // A channel that has grown a little without a way for the air to go through it makes for the nearest wall at a very different pressure from
  // its own (a low-pressure wall if it is high-pressure, and the other way round), so that air can flow through it.
  const lowWalls = () => facade.filter((f) => windOf(f) > 0.1), highWalls = () => facade.filter((f) => windOf(f) < -0.3);
  let wallSets = null;
  const assignTarget = (g) => {
    wallSets ??= { low: lowWalls(), high: highWalls() };
    const t = g.node, set = t.p > 0.15 ? wallSets.low : wallSets.high;
    let best = null, bd = Infinity;
    for (const f of set) {
      const d = (f.x - t.x) ** 2 + (f.z - t.z) ** 2 + ((f.y - t.y) * 2) ** 2;
      if (d < bd) { bd = d; best = f; }
    }
    if (!best) return;
    g.target = { x: best.x - best.nx * 2, y: best.y, z: best.z - best.nz * 2 };
    g.exit = { x: best.x + best.nx * 3, y: best.y, z: best.z + best.nz * 3 };
    g.maxLen = Math.max(g.maxLen, g.len + 80);
  };

  // Grows a channel one step. Returns false once it has stopped (reached a wall, blocked, or grown as far as it may).
  const advance = (g) => {
    const t = g.node;
    if (!g.target && g.len >= (g.roam ?? 5)) assignTarget(g); // (a branch first roams towards the cooling still to be done, then makes for a wall)
    if (g.len > g.maxLen) return false;
    const rad = R_START + 0.15;
    // where it wants to go: on in the way it was going, towards its target, towards cooling it has not yet done, away from spaces, with some wandering
    const want = [g.dir[0] * 0.6, g.dir[1] * 0.6, g.dir[2] * 0.6];
    if (g.target) {
      if (Math.hypot(g.target.x - t.x, g.target.z - t.z) < 2.5 && g.exit) g.target = g.exit; // (reached the point inside: now through the wall)
      const d = normalise([g.target.x - t.x, g.target.y - t.y, g.target.z - t.z]);
      want[0] += d[0] * 1.0; want[1] += d[1] * 0.3; want[2] += d[2] * 1.0;
    }
    const pull = [0, 0, 0];
    let pulls = 0;
    for (const a of uncovered) {
      const dx = a[0] - t.x, dy = a[1] - t.y, dzz = a[2] - t.z, d2 = dx * dx + dy * dy + dzz * dzz;
      if (d2 > 100 || d2 < 1) continue;
      const w = 1 / d2;
      pull[0] += dx * w; pull[1] += dy * w; pull[2] += dzz * w; pulls++;
    }
    if (pulls && !g.noPull) { const k = g.target ? 0.25 : 0.7; const d = normalise(pull); want[0] += d[0] * k; want[1] += d[1] * k * 0.8; want[2] += d[2] * k; }
    for (const s of obstacles) { // pushed away from the spaces, along their surface
      const dx = t.x - s.x, dy = t.y - s.y, dzz = t.z - s.z, dist = Math.hypot(dx, dy, dzz), edge = s.r + rad + 0.3 + 2.5;
      if (dist < edge && dist > 1e-6) { const k = (edge - dist) / 2.5; want[0] += (dx / dist) * k * 0.7; want[1] += (dy / dist) * k * 0.7; want[2] += (dzz / dist) * k * 0.7; }
    }
    const jitter = (s) => hash(t.br * 7919 + iteration * 131 + s) - 0.5;
    const wob = g.jit ?? 0.5; // (a trunk wobbles little)
    want[0] += jitter(1) * wob; want[1] += jitter(2) * wob * 0.4; want[2] += jitter(3) * wob;
    // Branches run with the wind and keep to their floor: the air moves along the wind, so a branch across it or steeply up or down is longer than
    // it needs to be (more friction, slower air) for the same cooling. (The trunks are straight already.)
    if (!g.noPull) { want[0] += wind[0] * ALIGN; want[2] += wind[1] * ALIGN; want[1] *= FLAT; }
    const hHere = form.heightAt(t.x, t.z); // keep off the roof and the floor
    if (hHere - t.y < 3) want[1] -= 1.2;
    if (t.y - yFloor < 1.8) want[1] += 1.2;
    const d = normalise(want);
    // try the direction, then others turned to either side
    for (const [turn, lift] of [[0, 1], [0.5, 1], [-0.5, 1], [0, 0], [0.5, 0], [-0.5, 0], [1, 0.5], [-1, 0.5], [0, -1], [1.6, 0], [-1.6, 0], [2.4, 0], [-2.4, 0]]) {
      const cs = Math.cos(turn), sn = Math.sin(turn), dx = d[0] * cs - d[2] * sn, dzz = d[0] * sn + d[2] * cs;
      const q = [t.x + dx * STEP, t.y + d[1] * STEP * 0.7 * lift, t.z + dzz * STEP];
      const h = form.heightAt(q[0], q[2]);
      if (h < q[1] - 0.5 || h <= 0) {
        // out of the mass sideways: that is a wall, unless it is a corner
        const col = columnAt(q[0], q[2]), colHere = columnAt(t.x, t.z);
        if ((col >= 0 && prot[col]) || (colHere >= 0 && prot[colHere])) continue;
        const e = 0.6, gx = form.heightAt(q[0] - e, q[2]) - form.heightAt(q[0] + e, q[2]), gz = form.heightAt(q[0], q[2] - e) - form.heightAt(q[0], q[2] + e);
        const gl = Math.hypot(gx, gz), nxw = gl > 1e-6 ? gx / gl : dx, nzw = gl > 1e-6 ? gz / gl : dzz, nl = Math.hypot(nxw, nzw) || 1;
        if (!sphereClear(q[0], q[1], q[2], rad)) continue;
        const w = wallNodeAt(q[0], q[1], q[2], nxw / nl, nzw / nl);
        addEdge(t, w, R_START, { br: t.br });
        return false; // it has reached a wall: the channel is through
      }
      if (!inside(q[0], q[1], q[2], rad) || !sphereClear(q[0], q[1], q[2], rad)) continue;
      const node = addNode(q[0], q[1], q[2], { br: t.br });
      node.p = t.p;
      addEdge(t, node, R_START, { br: t.br });
      g.node = node;
      g.dir = normalise([g.dir[0] * 0.4 + dx, (g.dir[1] * 0.4 + d[1] * 0.7) * 0.6, g.dir[2] * 0.4 + dzz]);
      g.len++;
      return true;
    }
    return false;
  };

  /* ---------- the flow ---------- */
  // Solves the pressure at every point: the wall nodes held at the wind's pressure, the air flowing through the tubes. The tubes follow the law of
  // pipe flow in the large (turbulent) regime: the pressure lost between the ends of a tube is K x the dynamic pressure of the air in it, K being
  // the losses where it starts plus friction along it, so the air in it goes at v = sqrt(pressure difference / K) times the open wind and the flow is
  // (area) x v. (Solved by settling a linear network a few times over: the conductance of a tube is its C / sqrt(pressure difference).)
  // Sets every tube's flow (q) and air speed (speed, relative to the open wind). Returns the largest flow.
  const solvePressure = () => {
    const n = nodes.length;
    nodes.forEach((nd, i) => { nd.i = i; });
    // The loss in a tube is half the loss of each of its ends plus the friction along it. A tube is cut into short segments, so a point with two
    // tubes at it is only a bend (BEND): charging JUNCTION for every segment would make the air in a long tunnel crawl whatever its shape.
    const deg = new Uint16Array(n);
    for (const e of edges) { deg[e.a.i]++; deg[e.b.i]++; }
    const endLoss = (nd) => (deg[nd.i] === 2 ? BEND : JUNCTION);
    const K = edges.map((e) => (endLoss(e.a) + endLoss(e.b)) / 2 + (FRICTION * e.L) / (2 * e.r));
    const C = edges.map((e, k) => (Math.PI * e.r * e.r) / Math.sqrt(K[k]));
    const p = new Float64Array(n), fixed = new Uint8Array(n);
    let mean = 0, nf = 0;
    // (the stack effect: the potential of the air in the tubes is its pressure plus its weight, p + rho_in g y, and a wall's is the outside
    // pressure there plus the same: wind pressure minus (rho_out - rho_in) g y, so it falls with height by `buoyancy` per metre)
    nodes.forEach((nd, i) => { if (nd.wall) { const pw = nd.pf - buoyancy * nd.y; fixed[i] = 1; p[i] = pw; mean += pw; nf++; } else p[i] = nd.p || 0; });
    mean = nf ? mean / nf : 0;
    const leak = 1e-9;
    const quick = !tuning && !finished && iteration < GROW_ROUNDS; // (while the tunnels grow the flow need not be exact: a rough one is quicker and serves)
    for (let pass = 0; pass < (tuning ? 1 : quick ? 2 : PICARD); pass++) { // (while tuning: once, from the last solution, which is near enough to tell better from worse)
      const g = edges.map((e, k) => C[k] / Math.sqrt(Math.abs(p[e.a.i] - p[e.b.i]) + 1e-3));
      const diag = new Float64Array(n), adj = Array.from({ length: n }, () => []);
      edges.forEach((e, k) => { diag[e.a.i] += g[k]; diag[e.b.i] += g[k]; adj[e.a.i].push([e.b.i, g[k]]); adj[e.b.i].push([e.a.i, g[k]]); });
      const apply = (v, out) => { for (let i = 0; i < n; i++) { if (fixed[i]) { out[i] = 0; continue; } let s = (diag[i] + leak) * v[i]; for (const [j, gg] of adj[i]) if (!fixed[j]) s -= gg * v[j]; out[i] = s; } };
      const r = new Float64Array(n), z = new Float64Array(n), d = new Float64Array(n), ad = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        if (fixed[i]) continue;
        let s = leak * mean;
        for (const [j, gg] of adj[i]) if (fixed[j]) s += gg * p[j];
        r[i] = s;
      }
      apply(p, ad);
      let rz = 0, r0 = 0;
      for (let i = 0; i < n; i++) { if (fixed[i]) continue; r[i] -= ad[i]; z[i] = r[i] / (diag[i] + leak); d[i] = z[i]; rz += r[i] * z[i]; r0 += r[i] * r[i]; }
      if (r0 > 0) {
        for (let it = 0; it < 300; it++) {
          apply(d, ad);
          let dad = 0;
          for (let i = 0; i < n; i++) dad += d[i] * ad[i];
          if (dad <= 0) break;
          const alpha = rz / dad;
          let rr = 0, rz2 = 0;
          for (let i = 0; i < n; i++) { if (fixed[i]) continue; p[i] += alpha * d[i]; r[i] -= alpha * ad[i]; z[i] = r[i] / (diag[i] + leak); rz2 += r[i] * z[i]; rr += r[i] * r[i]; }
          if (Math.sqrt(rr / r0) < (tuning || quick ? 1e-4 : 1e-6)) break;
          const beta = rz2 / rz;
          rz = rz2;
          for (let i = 0; i < n; i++) if (!fixed[i]) d[i] = z[i] + beta * d[i];
        }
      }
    }
    nodes.forEach((nd, i) => { nd.p = p[i]; });
    let qmax = 0;
    edges.forEach((e, k) => {
      const dp = p[e.a.i] - p[e.b.i];
      e.q = Math.sign(dp) * C[k] * Math.sqrt(Math.abs(dp));
      e.speed = Math.min(1.6, Math.sqrt(Math.abs(dp) / K[k]));
      qmax = Math.max(qmax, Math.abs(e.q));
    });
    return qmax;
  };
  // The tubes take the radius their flow calls for; the weak ones go.
  const adapt = (qmax, budget) => {
    if (qmax <= 0) return;
    const held = (e) => (growing.has(e.br) && iteration < GROW_ROUNDS) || e.born >= iteration - 8 || (e.br === -1 && e.born >= iteration - 15); // a channel still growing (or a link just made) is not judged yet
    // a tube's flow is judged against the strongest flow near it (not against the strongest in the whole network, which would be the short run
    // between two walls close together, and starve everything far from them)
    const cell = 8, eh = new Map();
    for (const e of edges) {
      const key = Math.floor((e.a.x + e.b.x) / 2 / cell) + "," + Math.floor((e.a.y + e.b.y) / 2 / cell) + "," + Math.floor((e.a.z + e.b.z) / 2 / cell);
      eh.set(key, Math.max(eh.get(key) ?? 0, Math.abs(e.q)));
    }
    for (const e of edges) {
      const ix = Math.floor((e.a.x + e.b.x) / 2 / cell), iy = Math.floor((e.a.y + e.b.y) / 2 / cell), iz = Math.floor((e.a.z + e.b.z) / 2 / cell);
      let local = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) local = Math.max(local, eh.get(ix + a + "," + (iy + b) + "," + (iz + d)) ?? 0);
      e.rel = local > 0 ? Math.abs(e.q) / local : 0;
    }
    let vHeld = 0, vFree = 0;
    for (const e of edges) { if (held(e)) vHeld += Math.PI * e.r * e.r * e.L; else vFree += Math.PI * (R_MAX * e.rel ** MURRAY) ** 2 * e.L; }
    const k = vFree > 0 ? Math.min(1, Math.sqrt(Math.max(0.5 * budget, budget - vHeld) / vFree)) : 1;
    // A tube that carries any real flow is at least R_FLOOR wide (no hair-thin veins: a thin tube carries almost no air); one that carries next to
    // nothing shrinks away. If the tubes are over the volume allowed, the ones with the least flow go first.
    for (const e of edges) {
      if (held(e)) continue;
      const target = e.rel < REL_PRUNE ? 0 : Math.max(R_FLOOR, k * R_MAX * e.rel ** MURRAY);
      e.r += 0.4 * (target - e.r);
    }
    // If the tubes are over the volume allowed, the ones with the least flow go first.
    let total = 0;
    for (const e of edges) total += Math.PI * e.r * e.r * e.L;
    if (total > 1.05 * budget) {
      const weakest = edges.filter((e) => !held(e)).sort((a, b) => a.rel - b.rel);
      for (const e of weakest) {
        if (total <= budget) break;
        total -= Math.PI * e.r * e.r * e.L;
        e.r = 0;
      }
    }
    edges = edges.filter((e) => held(e) || e.r >= R_MIN);
    // points with no tube left go (the walls too)
    const used = new Set();
    for (const e of edges) { used.add(e.a); used.add(e.b); }
    nodes = nodes.filter((nd) => used.has(nd));
  };

  /* ---------- keeping track of what is near ---------- */
  const buildHash = () => {
    const h = new Map();
    for (const nd of nodes) {
      const key = `${Math.floor(nd.x / HASH_CELL)},${Math.floor(nd.y / HASH_CELL)},${Math.floor(nd.z / HASH_CELL)}`;
      if (!h.has(key)) h.set(key, []);
      h.get(key).push(nd);
    }
    return h;
  };
  const near = (h, x, y, z, radius, visit) => {
    const r = Math.ceil(radius / HASH_CELL), ix = Math.floor(x / HASH_CELL), iy = Math.floor(y / HASH_CELL), iz = Math.floor(z / HASH_CELL);
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) for (let d = -r; d <= r; d++) {
      const list = h.get(`${ix + a},${iy + b},${iz + d}`);
      if (list) for (const nd of list) visit(nd);
    }
  };
  const makeAttractors = () => { // sample points in the mass, every 2.5 m
    const out = [], s = 2.5;
    for (let x = bx0 + s / 2; x < bx1; x += s) {
      for (let z = bz0 + s / 2; z < bz1; z += s) {
        const h = form.heightAt(x, z);
        if (h <= 0) continue;
        const col = columnAt(x, z);
        if (col < 0 || prot[col]) continue;
        for (let y = yFloor + 1; y < h - 1.2; y += s) if (sphereClear(x, y, z, 0.5)) out.push([x, y, z]);
      }
    }
    return out;
  };
  const findUncovered = (h) => { // the sample points with no tunnel within 0.8 REACH
    const out = [];
    for (const a of attractors) {
      let covered = false;
      near(h, a[0], a[1], a[2], 0.8 * REACH, (nd) => { if (!covered && Math.hypot(nd.x - a[0], nd.y - a[1], nd.z - a[2]) < 0.8 * REACH) covered = true; });
      if (!covered) out.push(a);
    }
    return out;
  };

  // Is the straight run from a to b inside the mass and clear of the spaces?
  const runClear = (a, b) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z), m = Math.max(2, Math.ceil(len / 1));
    for (let i = 1; i < m; i++) {
      const u = i / m, x = a.x + (b.x - a.x) * u, y = a.y + (b.y - a.y) * u, z = a.z + (b.z - a.z) * u;
      if (!inside(x, y, z, 0.5) || !sphereClear(x, y, z, 0.5)) return false;
    }
    return true;
  };

  // When the growing rounds are over, every channel that has not found a way through yet is joined to the nearest wall at a very different
  // pressure, if there is a clear run to it (through a link to a tube at a different pressure if not), so that air can flow through it.
  const connectTips = () => {
    wallSets ??= { low: lowWalls(), high: highWalls() };
    const h = buildHash();
    for (const g of [...growing.values()]) {
      const t = g.node, set = t.p > 0.15 ? wallSets.low : wallSets.high;
      const ranked = set.map((f) => [(f.x - t.x) ** 2 + (f.z - t.z) ** 2 + ((f.y - t.y) * 2) ** 2, f]).sort((a, b) => a[0] - b[0]).slice(0, 6);
      let done = false;
      for (const [, f] of ranked) {
        const w = { x: f.x - f.nx * 0.3, y: f.y, z: f.z - f.nz * 0.3 };
        if (Math.hypot(w.x - t.x, w.z - t.z) > 30 || !runClear(t, w)) continue;
        const wn = wallNodeAt(f.x, f.y, f.z, f.nx, f.nz);
        addEdge(t, wn, R_START, { br: t.br });
        done = true;
        break;
      }
      if (!done) {
        let best = null, bs = 0;
        near(h, t.x, t.y, t.z, 9, (o) => {
          if (o.br === t.br || o.wall) return;
          const d = Math.hypot(o.x - t.x, o.y - t.y, o.z - t.z), dp = Math.abs(o.p - t.p);
          if (d < 1 || d > 9 || dp < 0.15) return;
          if (dp / d > bs && runClear(t, o)) { bs = dp / d; best = o; }
        });
        if (best) addEdge(t, best, R_START, { br: -1 });
      }
    }
    growing.clear();
  };

  const seed = () => {
    // First the trunks: a handful of straight channels from the windward walls, spaced well apart, each making straight for a point on a leeward or
    // side wall. They carry the air through the structure; branches come later (see TRUNK_ROUNDS) from the ones that carry most.
    const windward = facade.filter((f) => windOf(f) < -0.3), exits = facade.filter((f) => windOf(f) > 0.1);
    if (!windward.length || !exits.length) return;
    // the trunks make for the walls with the strongest suction (the lowest pressure): the greater the pressure difference, the faster the air
    const pressureOf = (f) => wallPressure(f.nx, f.nz, f.y, cornerDist(f.x, f.z));
    const suction = [...exits].sort((a, b) => pressureOf(a) - pressureOf(b)).slice(0, Math.max(8, Math.ceil(exits.length * 0.4)));
    const area = windward.length * c * layerHeight, wanted = Math.max(8, Math.min(90, Math.round(area / 50)));
    const order = windward.map((f, i) => [f, hash(i * 31 + 7)]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
    // the same number on every storey, so that every floor is reached (the trunks are not all at the foot of the walls)
    const bySt = new Map();
    for (const f of order) { const s = Math.floor(f.y / STOREY); if (!bySt.has(s)) bySt.set(s, []); bySt.get(s).push(f); }
    const chosen = [];
    for (const [s, list] of bySt) {
      // (extra trunks on the top storey were tried: they did not cool it better, and took cooling from the lower floors)
      // Core-first: on every storey a trunk wherever the spacing allows (about every TRUNK_GAP), so that every part of the floor, the middle too,
      // has a through-tunnel within reach (the 3 m of REACH) instead of only the edges near the windward wall. (`wanted` is now only the least.)
      const each = Math.max(2, Math.ceil(wanted / bySt.size), 40), gap = TRUNK_GAP;
      let count = 0;
      for (const f of list) {
        if (count >= each) break;
        if (chosen.some((o) => Math.hypot(o.x - f.x, o.y - f.y, o.z - f.z) < gap)) continue;
        if (!sphereClear(f.x - f.nx * 1.5, f.y, f.z - f.nz * 1.5, 0.6)) continue;
        chosen.push(f);
        count++;
      }
    }
    for (const f of chosen) {
      const g = startChannel(f), t = suction[Math.floor(hash(g.node.br * 977) * suction.length)];
      g.target = { x: t.x - t.nx * 2, y: f.y + (hash(g.node.br * 13) - 0.5) * 3, z: t.z - t.nz * 2 };
      g.exit = { x: t.x + t.nx * 3, y: g.target.y, z: t.z + t.nz * 3 }; // (and through the wall there)
      g.jit = 0.12; g.noPull = true; // straight, and not led off to the cooling still to be done
      growing.set(g.node.br, g);
    }
  };
  const reset = () => {
    cells.set(placed);
    vox.version++;
    nodes = []; edges = []; growing.clear();
    iteration = 0; finished = false; branchCount = 0; version++; epoch++; networkVolume = 0;
    uncovered = []; attractors = null;
    variant = 0; best = null; salt = 0; tuning = null; tuneResult = null; refining = null; refineResult = null;
    flowResult = null; flowVersion = -1; mapKey = ""; map = null;
  };

  // Cuts the finished network into the voxels, so that the airflow can be solved through it and the cooling read off it.
  const voxelise = () => {
    const carve = (x, y, z, r) => {
      const i0 = Math.max(0, Math.floor((x - r - vox.x0) / c)), i1 = Math.min(nx - 1, Math.floor((x + r - vox.x0) / c));
      const j0 = Math.max(0, Math.floor((z - r - vox.z0) / c)), j1 = Math.min(nz - 1, Math.floor((z + r - vox.z0) / c));
      const l0 = Math.max(1, vox.layerAt(Math.max(0, y - r))), l1 = vox.layerAt(y + r);
      if (l0 < 0 || l1 < 0) return;
      for (let l = l0; l <= l1; l++) {
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const col = j * nx + i, k = l * nxz + col;
            if (placed[k] !== MASS || l >= roof[col] || prot[col]) continue;
            const cc = vox.centre(i, j, l);
            if ((cc[0] - x) ** 2 + (cc[1] - y) ** 2 + (cc[2] - z) ** 2 > r * r) continue;
            let blocked = false;
            for (const s of obstacles) if (Math.hypot(cc[0] - s.x, cc[1] - s.y, cc[2] - s.z) < s.r) { blocked = true; break; }
            if (!blocked) vox.set(k, AIR);
          }
        }
      }
    };
    for (const e of edges) {
      const m = Math.max(1, Math.ceil(e.L / (c / 3))), r = Math.max(e.r, 0.45 * c);
      for (let i = 0; i <= m; i++) {
        const u = i / m;
        carve(e.a.x + (e.b.x - e.a.x) * u, e.a.y + (e.b.y - e.a.y) * u, e.a.z + (e.b.z - e.a.z) * u, r);
      }
    }
  };

  // The air speed in every tube relative to the open wind (see solvePressure): settled once more, for the tubes as they are.
  const computeSpeeds = () => {
    if (edges.length) solvePressure();
  };
  // The cooling at every voxel from the network (see cooling()): every voxel takes the strongest cooling of any tube within REACH metres, that tube's
  // air speed fading to nothing at REACH. Index (layer * nx * nz + column).
  const isTunnel = (k) => placed[k] === MASS && cells[k] === AIR;
  // How far from a tube its moving air cools: REACH for a tube of radius R_REF, further for a wider one (it moves more air), less far for a thinner one
  // (between 0.5 and 1.8 REACH). This is what makes the tuning prefer a few wide tunnels to many thin ones of the same volume.
  const reachOf = (e) => REACH * Math.max(0.5, Math.min(1.8, e.r / R_REF));
  const coolField = (stride = 1) => { // (stride 2 or more: only every stride-th voxel each way is worked out, for the tuning)
    const cool = new Float32Array(hiLayer * nxz);
    for (const e of edges) {
      const v0 = e.speed ?? 0;
      if (v0 < 0.02) continue;
      const reach = reachOf(e);
      const a = e.a, b = e.b, sx = b.x - a.x, sy = b.y - a.y, sz = b.z - a.z, len2 = sx * sx + sy * sy + sz * sz || 1;
      const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - vox.x0) / c)), i1 = Math.min(nx - 1, Math.floor((Math.max(a.x, b.x) + reach - vox.x0) / c));
      const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach - vox.z0) / c)), j1 = Math.min(nz - 1, Math.floor((Math.max(a.z, b.z) + reach - vox.z0) / c));
      let l0 = vox.layerAt(Math.max(0, Math.min(a.y, b.y) - reach)), l1 = vox.layerAt(Math.max(a.y, b.y) + reach);
      l0 = Math.max(0, l0); l1 = l1 < 0 ? hiLayer - 1 : Math.min(hiLayer - 1, l1);
      for (let l = l0 + ((stride - (l0 % stride)) % stride); l <= l1; l += stride) {
        const y = yc[l];
        for (let j = j0 + ((stride - (j0 % stride)) % stride); j <= j1; j += stride) {
          const z = vox.z0 + (j + 0.5) * c;
          for (let i = i0 + ((stride - (i0 % stride)) % stride); i <= i1; i += stride) {
            const x = vox.x0 + (i + 0.5) * c;
            const u = Math.max(0, Math.min(1, ((x - a.x) * sx + (y - a.y) * sy + (z - a.z) * sz) / len2));
            const d = Math.hypot(x - (a.x + sx * u), y - (a.y + sy * u), z - (a.z + sz * u));
            if (d >= reach) continue;
            const v = v0 * (1 - d / reach), q = l * nxz + j * nx + i;
            if (v > cool[q]) cool[q] = v;
          }
        }
      }
    }
    return cool;
  };
  // How well the floors are cooled, from the cooling at every voxel: { coverage: [per storey], avg: [per storey], mean, evenness } (see cooling()).
  // solid(k) says whether a voxel counts as floor.
  const coolStats = (cool, solid, stride = 1) => {
    const total = new Array(storeys).fill(0), nearW = new Array(storeys).fill(0), sum1 = new Array(storeys).fill(0);
    let acc = 0, count = 0;
    for (let l = 0; l < hiLayer; l += stride) {
      const s = Math.min(storeys - 1, Math.floor(l / perStorey));
      for (let col = 0; col < nxz; col++) {
        if (stride > 1 && ((col % nx) % stride || Math.floor(col / nx) % stride)) continue;
        const k = l * nxz + col;
        if (placed[k] !== MASS || !solid(k)) continue;
        const v = cool[k], w = dz[l];
        total[s] += w;
        nearW[s] += Math.min(1, v / NEAR) * w; // (it counts in proportion to the cooling, up to NEAR: slow air still cools, a little)
        acc += Math.min(v, 1.5) * w;
        sum1[s] += Math.min(v, 1) * w;
        count += w;
      }
    }
    const out = { coverage: total.map((t, s) => (t ? nearW[s] / t : 0)), avg: total.map((t, s) => (t ? sum1[s] / t : 0)), mean: count ? acc / count : 0, evenness: 0, covered: count ? nearW.reduce((a, b) => a + b, 0) / count : 0 };
    const used = out.coverage.filter((_, s) => total[s]);
    out.evenness = used.length && Math.max(...used) > 0 ? Math.min(...used) / Math.max(...used) : 0;
    return out;
  };

  // How good the network as it is now is: the part of the floor it cools, weighted towards cooling all the floors alike.
  const scoreOf = (stride) => {
    const st = coolStats(coolField(stride), () => true, stride);
    return st.covered * (0.5 + 0.5 * st.evenness);
  };
  // The walls take the pressure the wind w = [ux, uz] puts on them.
  const setPressures = (w) => { for (const nd of nodes) if (nd.wall) nd.pf = wallPressure(nd.wx, nd.wz, nd.y, nd.dc, w); };
  // The score for one wind. k >= 0 (while tuning): the pressures of the last solution for that wind are the start of this one, so that one pass is enough.
  const scoreWind = (w, stride, k = -1) => {
    setPressures(w);
    if (k >= 0) nodes.forEach((nd, i) => { nd.p = tuning.ps[k][i]; });
    computeSpeeds();
    if (k >= 0) nodes.forEach((nd, i) => { tuning.ps[k][i] = nd.p; });
    return scoreOf(stride);
  };
  // How good the network is over all the winds in windSet, each weighted by its share of the warm-season wind (the main wind alone if there is
  // only one). While tuning, every tube also gets `use`, its air speed averaged over the winds, for choosing which tubes to change. When it is
  // done the walls and the speeds are those of the main wind again (what the panel and the cooling map show).
  const networkScore = () => {
    const stride = tuning ? 2 : 1; // (the tuning looks at an eighth of the voxels: the same picture of the floors, much quicker)
    const ws = tuning ? tuning.winds : windSet.length > 1 ? windSet : null;
    if (!ws) { setPressures(wind); computeSpeeds(); return scoreOf(stride); }
    if (tuning) for (const e of edges) e.use = 0;
    let s = 0;
    ws.forEach((w, k) => {
      s += w.weight * scoreWind(w.dir, stride, tuning ? k : -1);
      if (tuning) for (const e of edges) e.use += w.weight * (e.speed ?? 0);
    });
    if (!tuning) { setPressures(wind); computeSpeeds(); }
    return s;
  };

  // Keeping a network, and putting it back (a copy that does not depend on the tubes' objects).
  const snapshot = () => {
    nodes.forEach((nd, i) => { nd.i = i; });
    return {
      nodes: nodes.map((n) => ({ x: n.x, y: n.y, z: n.z, wall: n.wall, wx: n.wx, wz: n.wz, dc: n.dc, pf: n.pf, p: n.p, br: n.br })),
      edges: edges.map((e) => ({ a: e.a.i, b: e.b.i, r: e.r, L: e.L, q: e.q, born: e.born, br: e.br, speed: e.speed })),
    };
  };
  const restore = (snap) => {
    nodes = snap.nodes.map((n) => ({ ...n }));
    edges = snap.edges.map((e) => ({ ...e, a: nodes[e.a], b: nodes[e.b] }));
    growing.clear();
    networkVolume = 0;
    for (const e of edges) networkVolume += Math.PI * e.r * e.r * e.L;
  };

  /* ---------- tuning ---------- */
  // The best of the networks grown is then improved by trial and error against the cooling itself: a small change is made, the flow and the cooling
  // are worked out again, and the change is kept if the floors are cooled better (networkScore), or sometimes if worse (see below).
  // The winds it is tuned against are those of windSet (the main wind alone if there is no set), the score being the weighted sum of the score for
  // each (see networkScore): so a network that suits only the prevailing wind, and is useless when it turns, does not win. The search is simulated
  // annealing: a change that makes the score worse is sometimes kept too, less and less often as the time runs out, so that it can leave a
  // local best; the best network met on the way is the one kept at the end. The changes (the first two keep the tubes and the volume as they are):
  //  - volume moved from a tube that carries little air (averaged over the winds) to one that carries much,
  //  - a point where tubes meet moved a little,
  //  - an opening moved along the facade (a little, or to a quite different place: the tube is re-aimed at another wall),
  //  - a link made between two tubes at different pressures (its volume taken from a tube that carries little),
  //  - a link between two junctions removed (its volume given to a tube that carries much).
  // Every change is refused if the tubes would then take more than 2% over the volume they had when the tuning began.
  let tuning = null; // { trials, kept, from, score, best, snap, until, dur, rng, adj, winds, ps, hash, walls, cap, moved } while it runs
  const T0 = 0.004; // the annealing temperature at the start, in score units (the score is between 0 and 1)
  const volumeNow = () => { let v = 0; for (const e of edges) v += Math.PI * e.r * e.r * e.L; return v; };
  const startTuning = () => {
    // the main wind alone first (in full, to start from), to say what the tuning has done for it
    setPressures(wind);
    computeSpeeds();
    const mainFrom = scoreOf(1);
    const adj = nodes.map(() => []);
    nodes.forEach((nd, i) => { nd.i = i; });
    for (const e of edges) { adj[e.a.i].push(e); adj[e.b.i].push(e); }
    const winds = windSet.length ? windSet : [{ dir: wind, weight: 1 }];
    // the pressures of the last solution for each wind: the start of the next (so that one pass settles it)
    const ps = winds.map((w) => {
      setPressures(w.dir);
      computeSpeeds(); // (in full)
      return Float64Array.from(nodes, (nd) => nd.p);
    });
    const dur = (TUNE_SECONDS + TUNE_PER_WIND * (winds.length - 1)) * 1000; // (every wind makes a trial dearer)
    tuning = { trials: 0, kept: 0, from: 0, score: 0, best: 0, snap: null, until: performance.now() + dur, dur, rng: 12345, adj, winds, ps, hash: null, walls: nodes.filter((nd) => nd.wall), cap: 1.02 * volumeNow(), mainFrom, windsUsed: winds.length };
    tuning.from = tuning.score = tuning.best = networkScore(); // (the quick way, the same as for every trial after it)
    tuning.snap = snapshot();
  };
  const rand = () => { tuning.rng = (tuning.rng * 1664525 + 1013904223) >>> 0; return tuning.rng / 4294967296; };
  const useOf = (e) => e.use ?? e.speed ?? 0;
  const pickEdge = (best) => { // of a few edges at random, the one with the least (best false) or the most (best true) air
    let pick = null;
    for (let k = 0; k < 6; k++) {
      const e = edges[Math.floor(rand() * edges.length)];
      if (!pick || (best ? useOf(e) > useOf(pick) : useOf(e) < useOf(pick))) pick = e;
    }
    return pick;
  };
  // Each move returns an undo function, or null if it could not be made (nothing has then been changed).
  const moveVolume = () => {
    const A = pickEdge(false), B = pickEdge(true);
    if (A === B) return null;
    const ra = A.r * Math.sqrt(0.75), dV = 0.25 * Math.PI * A.r * A.r * A.L, rb = Math.sqrt(B.r * B.r + dV / (Math.PI * B.L));
    if (ra < R_MIN || rb > R_MAX * 1.4) return null;
    const oa = A.r, ob = B.r;
    A.r = ra; B.r = rb;
    return () => { A.r = oa; B.r = ob; };
  };
  const moveNode = () => {
    const T = tuning;
    const nd = nodes[Math.floor(rand() * nodes.length)], inc = T.adj[nd.i];
    if (nd.wall || inc.length < 2) return null;
    const ang = rand() * Math.PI * 2, dy = (rand() - 0.5) * 1.2, x = nd.x + Math.cos(ang) * 1.5, z = nd.z + Math.sin(ang) * 1.5, y = nd.y + dy;
    if (!inside(x, y, z, 0.5) || !sphereClear(x, y, z, 0.5)) return null;
    for (const e of inc) { // the tubes at the new place: their middles must be inside the mass and clear of the spaces too
      const o = e.a === nd ? e.b : e.a, mx = (o.x + x) / 2, my = (o.y + y) / 2, mz = (o.z + z) / 2;
      if (!o.wall && !inside(mx, my, mz, 0.4)) return null;
      if (!sphereClear(mx, my, mz, 0.4)) return null;
    }
    const ox = nd.x, oy = nd.y, oz = nd.z, oL = inc.map((e) => e.L);
    nd.x = x; nd.y = y; nd.z = z;
    for (const e of inc) e.L = Math.max(0.2, Math.hypot(e.a.x - e.b.x, e.a.y - e.b.y, e.a.z - e.b.z));
    return () => { nd.x = ox; nd.y = oy; nd.z = oz; inc.forEach((e, k) => { e.L = oL[k]; }); };
  };
  const moveOpening = () => { // the way out of a tube moved to another place on the walls (and so its pressure, size of the loss and direction to the wind)
    const T = tuning;
    if (!T.walls.length || !facade.length) return null;
    const wn = T.walls[Math.floor(rand() * T.walls.length)], inc = T.adj[wn.i];
    if (inc.length !== 1) return null;
    const e = inc[0], o = e.a === wn ? e.b : e.a;
    if (o.wall) return null;
    const reach = rand() < 0.7 ? 6 : 25, px = wn.x - wn.wx * WALL_OUT, pz = wn.z - wn.wz * WALL_OUT;
    let f = null;
    for (let k = 0; k < 16 && !f; k++) {
      const g = facade[Math.floor(rand() * facade.length)], d = Math.hypot(g.x - px, g.y - wn.y, g.z - pz);
      if (d > 1 && d < reach) f = g;
    }
    if (!f) return null;
    const entry = { x: f.x - f.nx * 0.3, y: f.y, z: f.z - f.nz * 0.3 };
    if (Math.hypot(entry.x - o.x, entry.z - o.z) > 30 || !runClear(o, entry)) return null;
    const old = { x: wn.x, y: wn.y, z: wn.z, wx: wn.wx, wz: wn.wz, dc: wn.dc }, oL = e.L;
    wn.x = f.x + f.nx * WALL_OUT; wn.y = f.y; wn.z = f.z + f.nz * WALL_OUT; wn.wx = f.nx; wn.wz = f.nz; wn.dc = cornerDist(f.x, f.z);
    e.L = Math.max(0.2, Math.hypot(e.a.x - e.b.x, e.a.y - e.b.y, e.a.z - e.b.z));
    return () => { Object.assign(wn, old); e.L = oL; };
  };
  const addLink = () => { // a link between two tubes of different branches that are at very different pressures (in some wind)
    const T = tuning;
    const nd = nodes[Math.floor(rand() * nodes.length)];
    if (nd.wall) return null;
    let pick = null, bg = 0;
    near(T.hash, nd.x, nd.y, nd.z, 9, (o) => {
      if (o === nd || o.br === nd.br || o.wall) return;
      const d = Math.hypot(o.x - nd.x, o.y - nd.y, o.z - nd.z);
      if (d < 3 || d > 9 || T.adj[nd.i].some((e) => e.a === o || e.b === o)) return;
      let g = 0;
      T.winds.forEach((w, k) => { g += w.weight * Math.abs(T.ps[k][nd.i] - T.ps[k][o.i]); });
      if (g / d > bg) { bg = g / d; pick = o; }
    });
    if (!pick || !runClear(nd, pick)) return null;
    const L = Math.max(0.2, Math.hypot(pick.x - nd.x, pick.y - nd.y, pick.z - nd.z)), dV = Math.PI * R_FLOOR * R_FLOOR * L;
    let A = null;
    for (let k = 0; k < 3 && !A; k++) { // the volume comes from a tube with little air that can spare it
      const c = pickEdge(false);
      if (c.r * c.r - dV / (Math.PI * c.L) >= R_MIN * R_MIN) A = c;
    }
    if (!A) return null;
    const oa = A.r, link = { a: nd, b: pick, r: R_FLOOR, L, q: 0, born: iteration, br: -1, speed: 0, use: 0 };
    A.r = Math.sqrt(A.r * A.r - dV / (Math.PI * A.L));
    edges.push(link); T.adj[nd.i].push(link); T.adj[pick.i].push(link);
    return () => { edges.pop(); T.adj[nd.i].pop(); T.adj[pick.i].pop(); A.r = oa; };
  };
  const removeLink = () => { // a tube between two junctions (so that nothing is left hanging) that carries little air
    const T = tuning;
    let pick = null;
    for (let k = 0; k < 8; k++) {
      const e = edges[Math.floor(rand() * edges.length)];
      if (e.a.wall || e.b.wall || T.adj[e.a.i].length < 3 || T.adj[e.b.i].length < 3) continue;
      if (!pick || useOf(e) < useOf(pick)) pick = e;
    }
    if (!pick) return null;
    const B = pickEdge(true);
    if (B === pick) return null;
    const dV = Math.PI * pick.r * pick.r * pick.L, rb = Math.sqrt(B.r * B.r + dV / (Math.PI * B.L)), ob = B.r;
    if (rb > R_MAX * 1.4) return null;
    const idx = edges.indexOf(pick), ia = T.adj[pick.a.i], ib = T.adj[pick.b.i];
    edges.splice(idx, 1);
    ia.splice(ia.indexOf(pick), 1); ib.splice(ib.indexOf(pick), 1);
    B.r = rb;
    return () => { edges.splice(idx, 0, pick); ia.push(pick); ib.push(pick); B.r = ob; };
  };
  const trial = () => {
    const T = tuning;
    T.trials++;
    const saved = edges.map((e) => [e.speed, e.q, e.use]);
    const r = rand();
    const undo = r < 0.25 ? moveVolume() : r < 0.5 ? moveNode() : r < 0.75 ? moveOpening() : r < 0.9 ? addLink() : removeLink();
    if (!undo) return;
    const revert = () => { undo(); edges.forEach((e, k) => { e.speed = saved[k][0]; e.q = saved[k][1]; e.use = saved[k][2]; }); };
    if (volumeNow() > T.cap) return revert();
    const s = networkScore(), d = s - T.score, frac = 1 - (T.until - performance.now()) / T.dur;
    const temp = frac < 0.75 ? T0 * (1 - frac / 0.75) ** 2 : 0; // (cooling down; the last quarter only accepts better)
    if (d > 1e-5 || (temp > 0 && d < 0 && rand() < Math.exp(d / temp))) {
      T.score = s; T.kept++; T.moved = true;
      if (s > T.best + 1e-5) { T.best = s; T.snap = snapshot(); }
      return;
    }
    revert();
  };
  const tuneBatch = () => {
    const T = tuning, t0 = performance.now();
    T.hash = buildHash(); // (the points have moved a little)
    while (performance.now() - t0 < 40 && performance.now() < T.until) trial();
    if (T.moved && performance.now() - (T.shown ?? 0) > TUNE_SHOW_MS) { T.moved = false; T.shown = performance.now(); networkVolume = volumeNow(); version++; }
    if (performance.now() < T.until) return false;
    const { trials, kept, from, best, mainFrom, windsUsed } = T;
    restore(T.snap); // the best network met on the way
    tuning = null;
    setPressures(wind);
    computeSpeeds(); // (for the main wind, as shown)
    tuneResult = { trials, kept, from, to: best, winds: windsUsed, mainFrom, mainTo: scoreOf(1) };
    refining = { round: 0, best: null, bestScore: -1, bestRound: 0, from: 0, flow: null, cap: 1.02 * volumeNow(), stuck: 0, tabu: new Set() };
    version++;
    return false; // (not finished: the refinement from the real airflow follows, see refineStep)
  };
  let tuneResult = null;

  /* ---------- refinement from the real airflow ---------- */
  // The tuning above judges the network by the pipe model (solvePressure), which is only an approximation of the air that really moves through the
  // carved voxels (the airflow the particles show). So, after the tuning, the network is refined against that airflow, a few rounds:
  //  - the network is cut into the voxels and the potential flow is solved through them (voxelFlow.js, the main wind),
  //  - every tube is given the air speed measured along it in that flow (this replaces the pipe model's speed, so the cooling score is the real one),
  //  - the slowest tubes are thinned (and removed when they get too thin), which frees volume,
  //  - beside each of the fastest wall-to-wall tunnels a copy is made, a little to either side, with the freed volume (as long as the volume cap holds).
  // The best round (by the measured cooling score) is the one kept.
  const REFINE_ROUNDS = 4; // the least rounds
  const REFINE_GOAL = 0.10; // every floor's average cooling (coolStats avg) should reach this
  const REFINE_MAX = 40, REFINE_PATIENCE = 8, REFINE_SECONDS = 300; // ...but no more than this many rounds, or this many rounds without a better score, or this long
  const REFINE_CLONES = 4; // fastest tunnels copied each round
  const REFINE_THIN = 0.2; // the part of the tube length with the slowest air that is thinned each round
  const REFINE_OFFSETS = [4, -4, 6.5, -6.5]; // metres to the side that a copy is tried at
  let refining = null, refineResult = null;

  const recarve = () => { cells.set(placed); vox.version++; voxelise(); };

  // Every tube takes the mean air speed (relative to the open wind) of the voxels along it, from a solved flow.
  const measureSpeeds = (flow) => {
    for (const e of edges) {
      const m = Math.max(2, Math.ceil(e.L / (c / 2)));
      let s = 0, n = 0;
      for (let i = 0; i <= m; i++) {
        const u = i / m, k = vox.at(e.a.x + (e.b.x - e.a.x) * u, e.a.y + (e.b.y - e.a.y) * u, e.a.z + (e.b.z - e.a.z) * u);
        if (k < 0 || !flow.open[k]) continue;
        s += flow.speed[k]; n++;
      }
      e.speed = n ? Math.min(2, s / n) : 0;
    }
  };

  // The wall-to-wall chains of tubes (a tunnel that starts and ends at a wall): [{ list: edges in order, speed: mean along it, len }].
  const wallChains = () => {
    const by = new Map();
    for (const e of edges) { if (e.br > 0) { if (!by.has(e.br)) by.set(e.br, []); by.get(e.br).push(e); } }
    const out = [];
    for (const [br, list] of by) {
      const next = new Map(list.map((e) => [e.a, e]));
      const ends = new Set(list.map((e) => e.b));
      const start = list.find((e) => !ends.has(e.a));
      if (!start || !start.a.wall) continue;
      const ordered = [];
      for (let e = start; e && ordered.length <= list.length; e = next.get(e.b)) ordered.push(e);
      if (ordered.length !== list.length || !ordered[ordered.length - 1].b.wall) continue;
      let len = 0, sp = 0;
      for (const e of ordered) { len += e.L; sp += (e.speed ?? 0) * e.L; }
      if (len >= 6) out.push({ br, list: ordered, len, speed: sp / len });
    }
    return out;
  };

  // Tries to make a copy of a tunnel chain, off to the side by `off` metres. Returns true if it was made.
  const cloneChain = (ch, off, h) => {
    const pts = [ch.list[0].a, ...ch.list.map((e) => e.b)], n = pts.length;
    const dx = pts[n - 1].x - pts[0].x, dz = pts[n - 1].z - pts[0].z, dl = Math.hypot(dx, dz);
    if (dl < 1) return false;
    const px = (-dz / dl) * off, pz = (dx / dl) * off;
    // the two openings: the facade point nearest the shifted old one that faces the same way
    const opening = (nd) => {
      const x = nd.x - nd.wx * WALL_OUT + px, z = nd.z - nd.wz * WALL_OUT + pz;
      let best = null, bd = 3.5 * 3.5;
      for (const f of facade) {
        if (f.nx * nd.wx + f.nz * nd.wz < 0.7) continue;
        const d = (f.x - x) ** 2 + (f.z - z) ** 2 + (f.y - nd.y) ** 2;
        if (d < bd) { bd = d; best = f; }
      }
      return best;
    };
    const f0 = opening(pts[0]), f1 = opening(pts[n - 1]);
    if (!f0 || !f1) return false;
    const mid = [];
    for (let i = 1; i < n - 1; i++) {
      const x = pts[i].x + px, y = pts[i].y, z = pts[i].z + pz;
      if (!inside(x, y, z, 0.5) || !sphereClear(x, y, z, 0.5)) return false;
      let crowded = false;
      near(h, x, y, z, 2.5, (o) => { if (!o.wall && o.br !== ch.br && Math.hypot(o.x - x, o.y - y, o.z - z) < 2.2) crowded = true; });
      if (crowded) return false;
      mid.push({ x, y, z });
    }
    const entry = (f) => ({ x: f.x - f.nx * 0.3, y: f.y, z: f.z - f.nz * 0.3 });
    const run = [entry(f0), ...mid, entry(f1)];
    for (let i = 0; i + 1 < run.length; i++) if (!runClear(run[i], run[i + 1])) return false;
    let dV = 0;
    ch.list.forEach((e, i) => { dV += Math.PI * e.r * e.r * Math.hypot(run[i + 1].x - run[i].x, run[i + 1].y - run[i].y, run[i + 1].z - run[i].z); });
    if (volumeNow() + dV > refining.cap) return false;
    const br = ++branchCount, made = [wallNodeAt(f0.x, f0.y, f0.z, f0.nx, f0.nz)];
    for (const m of mid) made.push(addNode(m.x, m.y, m.z, { br }));
    made.push(wallNodeAt(f1.x, f1.y, f1.z, f1.nx, f1.nz));
    made.forEach((nd, i) => { if (!nd.wall) nd.p = pts[i].p; });
    ch.list.forEach((e, i) => addEdge(made[i], made[i + 1], e.r, { br, speed: e.speed }));
    return true;
  };

  // Removes the stubs: a tube that ends in the stone (a point inside the mass with only one tube at it) carries no air, so it goes, and so on back
  // along the tunnel until what is left joins walls at both ends or a junction. Then the points that no tube uses.
  const pruneDeadEnds = () => {
    for (let again = true; again;) {
      again = false;
      const deg = new Map();
      for (const e of edges) { deg.set(e.a, (deg.get(e.a) ?? 0) + 1); deg.set(e.b, (deg.get(e.b) ?? 0) + 1); }
      const keep = edges.filter((e) => (e.a.wall || deg.get(e.a) > 1) && (e.b.wall || deg.get(e.b) > 1));
      if (keep.length !== edges.length) { edges = keep; again = true; }
    }
    const used = new Set();
    for (const e of edges) { used.add(e.a); used.add(e.b); }
    nodes = nodes.filter((nd) => used.has(nd));
  };

  const refineModify = (weak) => {
    // the tunnels on the weakest floor are copied first, then the fastest of the rest
    const onWeak = (ch) => (stOf(ch.list[0]) === weak ? 1 : 0);
    const chains = wallChains().sort((a, b) => onWeak(b) - onWeak(a) || b.speed - a.speed);
    const top = chains.slice(0, REFINE_CLONES), protectedBr = new Set(top.map((ch) => ch.br));
    // thin the slowest tubes (not the ones about to be copied)
    let totalLen = 0;
    for (const e of edges) totalLen += e.L;
    // (a whole tunnel at a time, so that no half of one is left: its tubes are thinned together, and it goes entirely or not at all)
    const groups = new Map();
    edges.forEach((e, i) => { const key = e.br > 0 ? e.br : -1 - i; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(e); });
    const slow = [...groups.entries()].filter(([key]) => !protectedBr.has(key)).map(([, list]) => {
      let len = 0, sp = 0;
      for (const e of list) { len += e.L; sp += (e.speed ?? 0) * e.L; }
      return { list, len, speed: sp / len };
    }).sort((a, b) => a.speed - b.speed);
    let thinned = 0;
    const gone = new Set();
    for (const g of slow) {
      if (thinned >= REFINE_THIN * totalLen) break;
      thinned += g.len;
      if (g.list.reduce((s, e) => s + e.r, 0) / g.list.length * 0.8 < R_MIN) g.list.forEach((e) => gone.add(e));
      else g.list.forEach((e) => { e.r = Math.max(R_MIN, e.r * 0.8); });
    }
    edges = edges.filter((e) => !gone.has(e));
    pruneDeadEnds();
    // copy the fastest tunnels beside themselves
    for (const ch of top) {
      if (!ch.list.every((e) => edges.includes(e))) continue;
      const h = buildHash();
      for (const off of REFINE_OFFSETS) if (cloneChain(ch, off, h)) break;
    }
    networkVolume = volumeNow();
  };

  /* ---------- ducts: a rational network, like ductwork ---------- */
  // Every floor has its own network, drawn in the axes of the building (the footprint's), at the middle of the storey:
  //  - trunks: straight runs along the main axis (the one most along the wind) from a wall to the wall on the other side, on lattice lines
  //    (the lattice step is DUCT_STEP), at least DUCT_SEP from one another,
  //  - branches: a wye off a trunk (45 degrees towards downwind, a short diagonal) and then a bend of 45 degrees into a run along the cross axis to a side
  //    wall, so that every angle in the network is 0, 45 or 90 degrees,
  //  - sizes: a trunk is DUCT_R_TRUNK wide, a branch DUCT_R_BRANCH.
  // It starts with trunks every DUCT_SEED_PITCH on every floor and then grows: every round the floors that are under the goal each get a branch or a
  // trunk where their floor is cooled least (see ductModify), until every floor reaches the goal (or the volume limit, or the other limits of the refinement).
  const DUCTS = true; // false: the free-growing vein network (growth, annealing and refinement above) instead
  const DUCT_MAX_ROUNDS = 60, DUCT_SECONDS = 900; // the most rounds, and seconds, the ducts may grow for
  const DUCT_STEP = 1.5, DUCT_SEP = 3, DUCT_SEED_PITCH = 9, DUCT_R_TRUNK = 1.0, DUCT_R_BRANCH = 0.7, DUCT_BRANCH_REACH = 10, DUCT_MAX_SHARE = 0.4;
  let frame = null; // the axes: { A (main, downwind), B (cross), aMin, aMax, bMin, bMax }
  const aOf = (x, z) => x * frame.A[0] + z * frame.A[1], bOf = (x, z) => x * frame.B[0] + z * frame.B[1];
  const xzOf = (a, b) => [a * frame.A[0] + b * frame.B[0], a * frame.A[1] + b * frame.B[1]];
  const stY = (s) => (s + 0.5) * STOREY;

  const makeFrame = () => {
    // the building's axes: the footprint's walls mostly face in four directions 90 degrees apart (the mean of 4 x the angle of the wall normals)
    let sx = 0, sz = 0;
    for (const f of facade) { const ph = Math.atan2(f.nz, f.nx); sx += Math.cos(4 * ph); sz += Math.sin(4 * ph); }
    const th = facade.length ? Math.atan2(sz, sx) / 4 : 0, e1 = [Math.cos(th), Math.sin(th)], e2 = [-Math.sin(th), Math.cos(th)];
    let A = e1;
    for (const q of [e1, [-e1[0], -e1[1]], e2, [-e2[0], -e2[1]]]) if (q[0] * wind[0] + q[1] * wind[1] > A[0] * wind[0] + A[1] * wind[1]) A = q;
    frame = { A, B: [-A[1], A[0]], aMin: Infinity, aMax: -Infinity, bMin: Infinity, bMax: -Infinity };
    for (let col = 0; col < nxz; col++) {
      if (roof[col] < 0) continue;
      const x = vox.x0 + ((col % nx) + 0.5) * c, z = vox.z0 + (Math.floor(col / nx) + 0.5) * c, a = aOf(x, z), b = bOf(x, z);
      frame.aMin = Math.min(frame.aMin, a); frame.aMax = Math.max(frame.aMax, a); frame.bMin = Math.min(frame.bMin, b); frame.bMax = Math.max(frame.bMax, b);
    }
  };

  // Walks from a point inside the mass along d (xz, unit) at height y until the mass ends. Returns the wall there { x, z (the first point outside),
  // nx, nz (the way out) }, or null if something is in the way first (a space, a corner) or the wall is met at a slant.
  const marchOut = (x, y, z, d, rad) => {
    const step = 0.5;
    for (let s = 0; s < 400; s += step) {
      const px = x + d[0] * s, pz = z + d[1] * s;
      if (form.heightAt(px, pz) < y + rad + 0.4) {
        const e = 0.6, gx = form.heightAt(px - e, pz) - form.heightAt(px + e, pz), gz = form.heightAt(px, pz - e) - form.heightAt(px, pz + e), gl = Math.hypot(gx, gz);
        const nxw = gl > 1e-6 ? gx / gl : d[0], nzw = gl > 1e-6 ? gz / gl : d[1];
        return nxw * d[0] + nzw * d[1] > 0.8 && s > 0 ? { x: px, z: pz, nx: nxw, nz: nzw } : null;
      }
      if (!inside(px, y, pz, rad) || !sphereClear(px, y, pz, rad)) return null;
    }
    return null;
  };
  const ductWall = (w, y, d) => { // the node outside the wall, on the line of the run
    const dc = cornerDist(w.x, w.z);
    return addNode(w.x + d[0] * WALL_OUT, y, w.z + d[1] * WALL_OUT, { wall: true, wx: w.nx, wz: w.nz, dc, pf: wallPressure(w.nx, w.nz, y, dc) });
  };
  const distToTube = (x, y, z, e) => {
    const sx = e.b.x - e.a.x, sy = e.b.y - e.a.y, sz = e.b.z - e.a.z, l2 = sx * sx + sy * sy + sz * sz || 1;
    const u = Math.max(0, Math.min(1, ((x - e.a.x) * sx + (y - e.a.y) * sy + (z - e.a.z) * sz) / l2));
    return Math.hypot(x - (e.a.x + sx * u), y - (e.a.y + sy * u), z - (e.a.z + sz * u));
  };
  // Is the straight run p to q (points { x, z }) at height y at least DUCT_SEP from every tube on the floor, except those of branch `own`?
  const apart = (p, q, y, own) => {
    const len = Math.hypot(q.x - p.x, q.z - p.z), m = Math.max(1, Math.ceil(len));
    for (let i = 0; i <= m; i++) {
      const u = i / m, x = p.x + (q.x - p.x) * u, z = p.z + (q.z - p.z) * u;
      for (const e of edges) {
        if (e.br === own || Math.abs((e.a.y + e.b.y) / 2 - y) > 1.5) continue;
        if (distToTube(x, y, z, e) < DUCT_SEP - 0.05) return false;
      }
    }
    return true;
  };
  const roomFor = (len, r) => volumeNow() + Math.PI * r * r * len <= DUCT_MAX_SHARE * massVolume;

  const splitEdge = (e, x, y, z) => {
    const J = addNode(x, y, z, { br: e.br });
    addEdge(J, e.b, e.r, { br: e.br, kind: e.kind, y: e.y, speed: e.speed });
    e.b = J;
    e.L = Math.max(0.2, Math.hypot(e.a.x - x, e.a.y - y, e.a.z - z));
    return J;
  };

  // A trunk of floor s on the lattice line b: a wall-to-wall run along A. Returns whether it was made.
  const addTrunk = (s, b) => {
    const y = stY(s), d = frame.A, back = [-d[0], -d[1]];
    for (let a = frame.aMin; a <= frame.aMax; a += 2) {
      const [x, z] = xzOf(a, b);
      if (!inside(x, y, z, DUCT_R_TRUNK) || !sphereClear(x, y, z, DUCT_R_TRUNK)) continue;
      const to = marchOut(x, y, z, d, DUCT_R_TRUNK), from = marchOut(x, y, z, back, DUCT_R_TRUNK);
      if (!to || !from) continue;
      const len = Math.hypot(to.x - from.x, to.z - from.z);
      if (!apart(from, to, y, -999) || !roomFor(len, DUCT_R_TRUNK)) return false;
      const br = ++branchCount;
      addEdge(ductWall(from, y, back), ductWall(to, y, d), DUCT_R_TRUNK, { br, kind: "trunk", y });
      return true;
    }
    return false;
  };

  // A branch of floor s off the trunk nearest to (a0, b0), on the side of b0: a wye (a diagonal of n lattice steps, 45 degrees to the trunk, towards
  // downwind) and then a bend of 45 degrees into a run parallel to the trunk, n steps off it, to the downwind wall. (It starts upwind of a0 so that
  // the run passes the point.) Trunks and branches are all parallel, and every turn is 45 degrees.
  const addBranch = (s, a0, b0) => {
    const y = stY(s);
    let piece = null, pb = Infinity;
    for (const e of edges) {
      if (e.kind !== "trunk" || e.y !== y) continue;
      const d = Math.abs(bOf(e.a.x, e.a.z) - b0), lo = aOf(e.a.x, e.a.z) + 3, hi = aOf(e.b.x, e.b.z) - 3;
      if (d < pb && hi > lo && a0 > lo) { pb = d; piece = e; }
    }
    if (!piece || pb > DUCT_BRANCH_REACH) return false;
    const bt = bOf(piece.a.x, piece.a.z), side = b0 >= bt ? 1 : -1;
    const n = Math.max(2, Math.min(5, Math.round(pb / DUCT_STEP))); // (the run is n steps off the trunk, at least DUCT_SEP)
    const lo = aOf(piece.a.x, piece.a.z) + 3, hi = aOf(piece.b.x, piece.b.z) - 3;
    const aJ = Math.min(hi, Math.max(lo, a0 - n * DUCT_STEP));
    const aS = Math.round(aJ / DUCT_STEP) * DUCT_STEP;
    if (aS < lo || aS > hi) return false;
    const J = xzOf(aS, bt), D = xzOf(aS + n * DUCT_STEP, bt + side * n * DUCT_STEP), dir = frame.A;
    const Jp = { x: J[0], y, z: J[1] }, Dp = { x: D[0], y, z: D[1] };
    if (!inside(D[0], y, D[1], DUCT_R_BRANCH) || !sphereClear(D[0], y, D[1], DUCT_R_BRANCH) || !runClear(Jp, Dp)) return false;
    const wall = marchOut(D[0], y, D[1], dir, DUCT_R_BRANCH);
    if (!wall) return false;
    if (!apart({ x: J[0], z: J[1] }, { x: D[0], z: D[1] }, y, piece.br) || !apart({ x: D[0], z: D[1] }, wall, y, piece.br)) return false;
    if (!roomFor(Math.hypot(wall.x - J[0], wall.z - J[1]), DUCT_R_BRANCH)) return false;
    const br = ++branchCount, Jn = splitEdge(piece, J[0], y, J[1]), Dn = addNode(D[0], y, D[1], { br });
    addEdge(Jn, Dn, DUCT_R_BRANCH, { br, kind: "branch", y });
    addEdge(Dn, ductWall(wall, y, dir), DUCT_R_BRANCH, { br, kind: "branch", y });
    return true;
  };

  const ductSeed = () => {
    makeFrame();
    for (let s = 0; s < storeys; s++) {
      for (let b = Math.ceil(frame.bMin / DUCT_SEED_PITCH) * DUCT_SEED_PITCH; b <= frame.bMax; b += DUCT_SEED_PITCH) addTrunk(s, b);
    }
    networkVolume = volumeNow();
  };

  // Adds one branch or trunk on floor s where its floor is cooled least. Returns whether something was added.
  const ductAdd = (s, cool, R) => {
    const l = s * perStorey + (perStorey >> 1);
    let pick = -1, bv = Infinity;
    for (let col = 0; col < nxz; col++) {
      const k = l * nxz + col;
      if (placed[k] !== MASS || prot[col] || R.tabu.has(s * nxz + col)) continue;
      const key = cool[k] + hash(col * 13 + R.round * 97) * 0.02; // (the least cooled, at random among the uncooled)
      if (key < bv) { bv = key; pick = col; }
    }
    if (pick < 0) return false;
    const x = vox.x0 + ((pick % nx) + 0.5) * c, z = vox.z0 + (Math.floor(pick / nx) + 0.5) * c, a0 = aOf(x, z), b0 = bOf(x, z);
    if (addBranch(s, a0, b0)) return true;
    const b1 = Math.round(b0 / DUCT_STEP) * DUCT_STEP;
    for (const k of [0, 1, -1, 2, -2, 3, -3]) if (addTrunk(s, b1 + k * DUCT_STEP)) return true;
    R.tabu.add(s * nxz + pick);
    return false;
  };
  // The floors that are under the goal (the weakest three) each get something added. Returns whether anything was.
  const ductModify = (stats, cool, R) => {
    const low = stats.avg.map((v, s) => [v, s]).filter(([v, s]) => stArea[s] > 0 && v < REFINE_GOAL).sort((a, b) => a[0] - b[0]).slice(0, 3);
    let added = 0;
    for (const [, s] of low) for (let tries = 0; tries < 12 && !added; tries++) { if (ductAdd(s, cool, R)) { added++; break; } }
    if (low.length > 1) for (const [, s] of low.slice(1)) for (let tries = 0; tries < 12; tries++) if (ductAdd(s, cool, R)) { added++; break; }
    networkVolume = volumeNow();
    return added > 0;
  };

  const refineStep = async () => {
    const R = refining, mine = epoch;
    recarve();
    const flow = await solveFlow(vox, { dir: wind, previous: R.flow });
    if (mine !== epoch) return false;
    R.flow = flow;
    measureSpeeds(flow);
    const cool = coolField(1), stats = coolStats(cool, () => true), score = stats.covered * (0.5 + 0.5 * stats.evenness);
    let weak = 0, floor = Infinity;
    stats.avg.forEach((v, s) => { if (stArea[s] > 0 && v < floor) { floor = v; weak = s; } });
    R.floor = floor;
    if (R.round === 0) { R.from = score; R.startedAt = performance.now(); R.floorFrom = floor; }
    const minRounds = DUCTS ? 0 : REFINE_ROUNDS, maxRounds = DUCTS ? DUCT_MAX_ROUNDS : REFINE_MAX, maxSeconds = DUCTS ? DUCT_SECONDS : REFINE_SECONDS;
    const met = floor >= REFINE_GOAL;
    if (met && R.round >= minRounds) { R.met = true; R.best = snapshot(); R.bestScore = score; R.bestRound = R.round; } // (the round that reaches the goal is the one kept)
    else if (!R.met && score > R.bestScore) { R.bestScore = score; R.best = snapshot(); R.bestRound = R.round; R.bestAt = R.round; }
    let stop = R.met || R.round >= maxRounds || R.round - (R.bestAt ?? 0) >= REFINE_PATIENCE + minRounds || performance.now() - R.startedAt > maxSeconds * 1000;
    if (!stop && DUCTS) {
      if (ductModify(stats, cool, R)) R.stuck = 0;
      else if (++R.stuck >= 3) stop = true; // nothing more can be placed
    }
    if (!stop) {
      if (!DUCTS) refineModify(weak);
      R.round++;
      version++;
      return false;
    }
    restore(R.best); // the best round (its tubes carry the speeds measured for them)
    pruneDeadEnds(); // (no stubs left in the stone)
    recarve();
    refineResult = { from: R.from, to: R.bestScore, rounds: R.round, kept: R.bestRound, goalMet: !!R.met, floorFrom: R.floorFrom, floorTo: coolStats(coolField(1), () => true).avg.filter((_, s) => stArea[s] > 0).reduce((m, v) => Math.min(m, v), Infinity) };
    refining = null;
    version++;
    finished = true;
    return true;
  };

  const tunnels = {
    get tuning() { return tuning ? { trials: tuning.trials, kept: tuning.kept } : null; },
    get tuneResult() { return tuneResult; },
    get refining() { return refining ? { round: refining.round, floor: refining.floor ?? 0, goal: REFINE_GOAL } : null; },
    get refineResult() { return refineResult; },
    id: ++serial, // tells one set of tunnels from another
    vox,
    builtOn: form.version, // the form version the voxels were built from: if the form changes, the tunnels are built afresh
    storeys, // how many storeys the mass has
    layerHeight,
    usable: top >= perStorey, // a whole storey of mass or more
    massBox: { x0: bx0, x1: bx1, z0: bz0, z1: bz1, top: vox.ye[Math.min(ny, top + 1)] }, // where the mass is
    get carved() { return networkVolume; }, // the volume (m3) of the tubes
    get share() { return massVolume ? networkVolume / massVolume : 0; }, // the part of the mass the tubes take up
    get iteration() { return iteration; },
    get variant() { return variant; }, // the network being grown (0 up to variants - 1): the best of them is kept
    get variants() { return VARIANTS; },
    get done() { return finished; },
    get version() { return version; }, // changes whenever the network does
    carvedAt: isTunnel, // (once the network is finished and cut into the voxels)
    placedAt: (k) => placed[k] === MASS, // is this voxel part of the mass as placed (rather than outside air or a building)?
    heightAt: (x, z) => form.heightAt(x, z), // how high the mass is at a point (0 where there is none)

    // Where the finished network opens onto the walls: [{ x, y, z, nx, nz, r }] (the point on the wall, the way out, the radius of the tube there).
    // Read by the skin (tunnelMesh.js), which only shapes the surface round them; nothing here changes the network.
    openings() {
      if (!finished) return [];
      const found = new Map();
      for (const e of edges) {
        for (const nd of [e.a, e.b]) {
          if (!nd.wall || nd.wx === undefined) continue;
          const o = found.get(nd);
          if (!o || e.r > o.r) found.set(nd, { x: nd.x - nd.wx * WALL_OUT, y: nd.y, z: nd.z - nd.wz * WALL_OUT, nx: nd.wx, nz: nd.wz, r: e.r });
        }
      }
      return [...found.values()];
    },

    // The tubes: { nodes: [{ x, y, z, wall }], edges: [{ a, b, r }] } (a and b are nodes), as they are now.
    network: () => ({ nodes, edges }),

    // The occupied spaces to keep out of: a list of spheres { x, y, z, r } in world metres. The tunnels start again.
    setObstacles(list) {
      obstacles = list.map((s) => ({ x: s.x, y: s.y, z: s.z, r: s.r }));
      obstaclesKey = obstacles.map((s) => `${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)},${s.r.toFixed(2)}`).join(";");
      reset();
    },
    get obstaclesKey() { return obstaclesKey; },

    // The wind (the direction it blows towards, [ux, uz]) for the whole structure. The tunnels start again.
    // The stack effect (see solvePressure): the pressure head per metre of height of air warmer than the air outside, in units of the open wind's
    // dynamic pressure. (The tunnels start again.)
    setBuoyancy(b) {
      buoyancy = b;
    },
    setWind(dir) {
      wind = [dir[0], dir[1]];
      reset();
    },
    // The winds the finished network is judged and tuned against: [{ dir: [ux, uz], weight }] (the weights are scaled to add up to 1), the main
    // wind (setWind) being the one the network is grown for and shown for. An empty list, or one wind, tunes for the main wind alone.
    // (Set it after setWind, which starts the tunnels again; it does not start them again itself.)
    setWindSet(list) {
      const total = list.reduce((s, w) => s + Math.max(0, w.weight), 0) || 1;
      windSet = list.map((w) => ({ dir: [w.dir[0], w.dir[1]], weight: Math.max(0, w.weight) / total }));
    },
    get windSet() { return windSet; },
    reset,

    // One round: the flow is solved through the tubes, they take the radius it calls for (the weak ones go), channels grow on and branch, and
    // where tubes at different pressures are near each other they are joined. After the growing rounds a few more only adapt, and then the
    // network is cut into the voxels. `limit` (0..1) is the most of the mass the tubes may take up. Says whether the tunnels are finished.
    async grow(limit) {
      if (finished) return true;
      const mine = epoch;
      await tick();
      if (mine !== epoch) return false;
      if (tuning) return tuneBatch();
      if (refining) return refineStep();
      if (DUCTS) { // the ducts: seeded once, then grown round by round in refineStep, each round measured in the real airflow
        ductSeed();
        refining = { round: 0, best: null, bestScore: -1, bestRound: 0, from: 0, flow: null, cap: Infinity, stuck: 0, tabu: new Set() };
        iteration = 1;
        version++;
        return false;
      }
      const budget = limit * massVolume * Math.min(1, (iteration + 1) / RAMP_ROUNDS);
      if (iteration === 0) { attractors = makeAttractors(); seed(); }
      const qmax = nodes.length ? solvePressure() : 0;
      if (iteration === GROW_ROUNDS) connectTips(); // (before anything is judged, so that the channels still growing are still there)
      adapt(qmax, budget);
      if (iteration < GROW_ROUNDS) {
        const h = buildHash();
        if (iteration % 4 === 0) uncovered = findUncovered(h);
        // channels grow on
        for (const [id, g] of [...growing]) if (!advance(g)) growing.delete(id);
        // branches sprout from the tubes that carry most air
        if (qmax > 0 && iteration >= TRUNK_ROUNDS) {
          let sprouts = 0;
          for (let ei = 0; ei < edges.length && sprouts < 12 && growing.size < MAX_GROWING; ei++) {
            const e = edges[ei];
            if (Math.abs(e.q) < 0.08 * qmax || (growing.has(e.br) && e.born >= iteration - 20)) continue;
            if (hash(ei * 17 + iteration * 101) > 0.08) continue;
            const from = hash(iteration * 7 + sprouts) < 0.5 ? e.a : e.b;
            if (from.wall) continue;
            const along = normalise([e.b.x - e.a.x, e.b.y - e.a.y, e.b.z - e.a.z]);
            const side = hash(iteration * 13 + sprouts * 5) < 0.5 ? 1 : -1;
            const dir = normalise([along[0] * 0.3 - along[2] * side, (hash(iteration * 3 + sprouts) - 0.5) * 0.5, along[2] * 0.3 + along[0] * side]);
            const x = from.x + dir[0] * STEP, y = from.y + dir[1] * STEP, z = from.z + dir[2] * STEP;
            if (!inside(x, y, z, 0.5) || !sphereClear(x, y, z, 0.5)) continue;
            const tip = addNode(x, y, z, { br: ++branchCount });
            tip.p = from.p;
            addEdge(from, tip, R_START, { br: tip.br });
            growing.set(tip.br, { node: tip, dir, target: null, len: 0, maxLen: 200, roam: 8 + Math.floor(hash(iteration + sprouts * 3) * 16) });
            sprouts++;
          }
        }
        // and towards the floor that no tunnel cools yet: from the nearest tube that carries air, to some of the uncooled points
        if (qmax > 0 && iteration >= TRUNK_ROUNDS && uncovered.length > 0.03 * attractors.length) {
          const nodeQ = new Map();
          for (const e of edges) { const q = Math.abs(e.q); nodeQ.set(e.a, Math.max(nodeQ.get(e.a) ?? 0, q)); nodeQ.set(e.b, Math.max(nodeQ.get(e.b) ?? 0, q)); }
          for (let k = 0; k < 14 && growing.size < MAX_GROWING; k++) {
            const a = uncovered[Math.floor(hash(iteration * 211 + k * 37) * uncovered.length)];
            let best = null, bd = Infinity;
            near(h, a[0], a[1], a[2], 12, (nd) => {
              if (nd.wall || (nodeQ.get(nd) ?? 0) < 0.01 * qmax) return;
              const d = Math.hypot(nd.x - a[0], nd.y - a[1], nd.z - a[2]);
              if (d < bd && d > 2) { bd = d; best = nd; }
            });
            if (!best) continue;
            const dir = normalise([a[0] - best.x, a[1] - best.y, a[2] - best.z]);
            const x = best.x + dir[0] * STEP, y = best.y + dir[1] * STEP * 0.7, z = best.z + dir[2] * STEP;
            if (!inside(x, y, z, 0.5) || !sphereClear(x, y, z, 0.5)) continue;
            const tip = addNode(x, y, z, { br: ++branchCount });
            tip.p = best.p;
            addEdge(best, tip, R_START, { br: tip.br });
            growing.set(tip.br, { node: tip, dir, target: null, len: 0, maxLen: 200, roam: 10 + Math.floor(hash(iteration + k * 5) * 14) });
          }
        }
        // links between tubes at different pressures
        if (qmax > 0 && iteration >= TRUNK_ROUNDS && nodes.length > 4) {
          const h2 = buildHash();
          let pmin = Infinity, pmax = -Infinity;
          for (const nd of nodes) { pmin = Math.min(pmin, nd.p); pmax = Math.max(pmax, nd.p); }
          const span = pmax - pmin, linked = new Set(), candidates = [];
          for (let ni = iteration % 3; ni < nodes.length; ni += 3) { // (a third of the points each round)
            const nd = nodes[ni];
            if (nd.wall) continue;
            near(h2, nd.x, nd.y, nd.z, 7, (o) => {
              if (o === nd || o.br === nd.br || o.wall) return;
              const d = Math.hypot(o.x - nd.x, o.y - nd.y, o.z - nd.z);
              if (d < 3 || d > 7) return;
              const dp = Math.abs(o.p - nd.p);
              if (dp < 0.35 * span) return;
              candidates.push([dp / d, nd, o]);
            });
          }
          candidates.sort((a, b) => b[0] - a[0]);
          let made = 0;
          for (const [, a, b] of candidates) {
            if (made >= 6) break;
            if (linked.has(a) || linked.has(b) || !runClear(a, b)) continue;
            addEdge(a, b, R_START, { br: -1 });
            linked.add(a); linked.add(b);
            made++;
          }
        }
      }
      iteration++;
      version++;
      networkVolume = 0;
      for (const e of edges) networkVolume += Math.PI * e.r * e.r * e.L;
      if (iteration >= GROW_ROUNDS + SETTLE_ROUNDS) {
        const score = networkScore();
        if (!best || score > best.score) best = { ...snapshot(), score };
        if (variant < VARIANTS - 1) { // another network, from a different random start
          variant++;
          salt = variant * 7919 + 13;
          nodes = []; edges = []; growing.clear();
          iteration = 0; branchCount = 0; networkVolume = 0; uncovered = []; attractors = null;
          version++;
          return false;
        }
        restore(best); // the best of them
        startTuning();
        version++;
        return false;
      }
      return finished;
    },

    // Solves the airflow through the voxels as they are, for the wind dir = [ux, uz] (a solveFlow() result), starting from the last solution.
    async solve(dir, options = {}) {
      const v = vox.version;
      const result = await solveFlow(vox, { dir, previous: flowResult, ...options });
      flowResult = result;
      flowVersion = v;
      flowDir = dir;
      return result;
    },
    get flow() { return flowResult; },
    // Is the stored airflow out of date for the wind dir?
    stale: (dir) => !flowResult || flowVersion !== vox.version || flowDir[0] !== dir[0] || flowDir[1] !== dir[1],

    // The air speed in the tunnels (see computeSpeeds): { max, mean } relative to the open wind (0 if there is none yet).
    tunnelSpeed() {
      let max = 0, total = 0, len = 0;
      if (finished) for (const e of edges) { max = Math.max(max, e.speed ?? 0); total += (e.speed ?? 0) * e.L; len += e.L; }
      return { max, mean: len ? total / len : 0 };
    },

    // The cooling at every voxel (see coolField): { lo: 0, hi, cool }, or null until the network is finished. Kept until the network changes.
    coolingMap() {
      if (!finished || !edges.length) return null;
      const key = version + "|" + vox.version;
      if (mapKey !== key) { mapKey = key; map = { lo: 0, hi: hiLayer, cool: coolField() }; }
      return map;
    },
    coolingMapKey: () => version + "|" + vox.version,
    // How well the floors are cooled, read from the last airflow. Returns { coverage: [per storey], avg: [per storey], mean, evenness }: coverage
    // is how much of a storey's solid voxels are cooled, each counting in proportion to its cooling up to NEAR (1 = all of it fully cooled), avg the average cooling of the
    // storey (1 = as much as beside a tunnel carrying the open wind), mean the average over the whole mass (capped at 1.5), and evenness the weakest
    // storey's coverage over the strongest's (1 = all floors cooled alike). All 0 if there is nothing yet.
    cooling() {
      if (!finished || !edges.length) return { coverage: new Array(storeys).fill(0), avg: new Array(storeys).fill(0), mean: 0, evenness: 0 };
      return coolStats(tunnels.coolingMap().cool, (k) => cells[k] === MASS);
    },  };
  return tunnels;
}
