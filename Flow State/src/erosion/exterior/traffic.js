// MODEL (exterior erosion): people and cars moving along the site's paths and roads.
// Pure logic, with no THREE scene or DOM code. Coordinates are site metres (x = east, y = north),
// the same as features.roads / features.paths. The view turns them into world positions.
//
// Roads and paths become a graph: ways that share a vertex are connected. Particles enter where a
// way leaves the site, follow their way, and choose a connecting way at junctions (preferring to
// go straight). They leave when they run off a dead end or out of the site.
//
// Cars drive on roads only; people walk on paths only. People and cars never share space: a person
// waits at a road until the cars have passed, and cars stop for anyone on the carriageway.
//
// When a mass is set (sim.setMass), a person who walks into it leaves the path and wanders over the
// floor inside it, from the paths' entrances to the paths' exits, keeping off any road that runs through.

export const MAX_PEOPLE = 1200;
export const MAX_CARS = 500;

const CAR_LENGTH = 4.5;
const MIN_GAP = 3; // metres kept to the car ahead when stopped
const HEADWAY = 1.5; // seconds kept to the car ahead when moving
const BRAKE = 6, ACCEL = 2.5; // m/s²
const TURN_PROB = 0.2; // chance to turn off at a junction the particle passes through
const NODE_GRID = 0.5; // metres: vertices closer than this are the same junction
const SNAP = 10; // metres: a drawn line's end this close to another line joins it

// speed m/s, width m (both lanes), rate = arrivals per minute at each entry point
const ROAD = {
  motorway: { speed: 22, width: 9, rate: 12 },
  trunk: { speed: 18, width: 8, rate: 12 },
  primary: { speed: 14, width: 7.5, rate: 10 },
  secondary: { speed: 12, width: 7, rate: 8 },
  tertiary: { speed: 10, width: 6.5, rate: 6 },
  residential: { speed: 7, width: 5.5, rate: 3 },
  unclassified: { speed: 8, width: 5.5, rate: 3 },
  living_street: { speed: 3.5, width: 4.5, rate: 1.5 },
  service: { speed: 4, width: 3.5, rate: 1.5 },
};
const ROAD_DEFAULT = { speed: 8, width: 5.5, rate: 3 };
const roadSpec = (kind) => ROAD[kind.replace(/_link$/, "")] ?? ROAD_DEFAULT;

const WALK = {
  pedestrian: { speed: 1.4, width: 6, rate: 6 },
  footway: { speed: 1.4, width: 2.5, rate: 3 },
  path: { speed: 1.4, width: 2.5, rate: 2 },
  steps: { speed: 0.8, width: 2.5, rate: 1.5 },
  cycleway: { speed: 1.4, width: 2.5, rate: 1.5 },
};
const WALK_DEFAULT = { speed: 1.4, width: 2.5, rate: 2 };
const walkSpec = (kind) => WALK[kind] ?? WALK_DEFAULT;

const LANE_BAND = 1.2; // metres either side of a lane's centre that a car's lane takes up
const CROSS_LOOKAHEAD = 1.5; // metres ahead a person looks before stepping onto a road
const MAX_WAIT = 40; // seconds a person waits to cross before giving up
const ROAM_CELL = 1; // metres: the grid people wander on inside the mass
const ATTRACTION = 2.5; // how strongly people inside the mass favour worn ground (in steps of the route to their goal)

const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const expo = (rate) => -Math.log(1 - Math.random()) / rate; // seconds until the next Poisson arrival

/* ---------- network ---------- */

const nodeKey = (p) => `${Math.round(p.x / NODE_GRID)},${Math.round(p.y / NODE_GRID)}`;

function buildNetwork(items, specOf, radius) {
  const ways = [], nodes = new Map();
  for (const item of items) {
    const pts = item.pts;
    if (pts.length < 2) continue;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const length = cum[cum.length - 1];
    if (length < 1) continue;
    // Turn angle at each interior vertex, used to slow cars into bends.
    const bends = [];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
      const b = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x);
      const turn = Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
      if (turn > 0.1) bends.push({ at: cum[i], turn });
    }
    const way = { id: ways.length, pts, cum, length, bends, spec: specOf(item.kind), nodeAt: [], junctions: [] };
    pts.forEach((p, i) => {
      const k = nodeKey(p);
      let node = nodes.get(k);
      if (!node) nodes.set(k, (node = { x: p.x, y: p.y, entries: [] }));
      node.entries.push({ way, index: i });
      way.nodeAt.push(node);
    });
    ways.push(way);
  }
  // A junction vertex is shared with some other way.
  for (const way of ways) way.nodeAt.forEach((node, i) => node.entries.some((e) => e.way !== way) && way.junctions.push(i));
  for (const way of ways) way.junctionEnds = [way.junctions.includes(0), way.junctions.includes(way.pts.length - 1)];

  // Connected groups of ways, so that every group can receive traffic.
  const parent = ways.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  for (const node of nodes.values()) for (const e of node.entries) parent[find(e.way.id)] = find(node.entries[0].way.id);

  // Entry points: loose ends of ways. Prefer ends near the edge of the site (traffic arriving from outside);
  // a group with none out there falls back to all its loose ends.
  const ends = new Map();
  for (const node of nodes.values()) {
    if (node.entries.length !== 1) continue;
    const { way, index } = node.entries[0];
    if (index !== 0 && index !== way.pts.length - 1) continue;
    const entry = { way, dir: index === 0 ? 1 : -1, s: index === 0 ? 0 : way.length, far: Math.hypot(node.x, node.y) >= radius * 0.6, wait: null };
    const group = find(way.id);
    if (!ends.has(group)) ends.set(group, []);
    ends.get(group).push(entry);
  }
  const spawns = [];
  for (const group of ends.values()) {
    const far = group.filter((e) => e.far);
    spawns.push(...(far.length ? far : group));
  }
  return { ways, spawns };
}

// Joins the ends of drawn lines to the nearest line within SNAP metres (existing or drawn). If the closest point is
// mid-segment, the target line gets a new vertex there, so the two share a junction. Inputs are not modified.
function connect(base, drawn) {
  const items = [...base, ...drawn].map((item) => ({ ...item, pts: [...item.pts] }));
  for (let d = base.length; d < items.length; d++) {
    const line = items[d];
    for (const end of [0, line.pts.length - 1]) {
      const p = line.pts[end];
      let best = null;
      items.forEach((other, o) => {
        if (o === d) return;
        for (let j = 0; j < other.pts.length - 1; j++) {
          const a = other.pts[j], b = other.pts[j + 1], dx = b.x - a.x, dy = b.y - a.y;
          const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
          const dist = Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
          if (dist < SNAP && (!best || dist < best.dist)) best = { dist, other, j, t, a, b };
        }
      });
      if (!best) continue;
      const { other, j, t, a, b } = best;
      if (t * Math.hypot(b.x - a.x, b.y - a.y) < 1) line.pts[end] = { x: a.x, y: a.y }; // at an existing vertex
      else if ((1 - t) * Math.hypot(b.x - a.x, b.y - a.y) < 1) line.pts[end] = { x: b.x, y: b.y };
      else {
        const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        other.pts.splice(j + 1, 0, q);
        line.pts[end] = { x: q.x, y: q.y };
      }
    }
  }
  return items;
}

function sample(way, s) {
  const { cum, pts } = way;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const a = pts[i - 1], b = pts[i];
  const t = Math.max(0, Math.min(1, (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1)));
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
  return { x: a.x + dx * t, y: a.y + dy * t, tx: dx / d, ty: dy / d };
}

// Where the cars are: a function (x, y, extra = 0) that says whether a point lies on a road's carriageway, i.e. within
// reach of a car lane (plus `extra` metres). Segments are hashed into 16 m squares so a query only looks nearby.
function buildCarriageway(ways) {
  const SIZE = 16, MARGIN = 2, map = new Map();
  for (const way of ways) {
    const band = way.spec.width / 4 + LANE_BAND;
    for (let i = 1; i < way.pts.length; i++) {
      const a = way.pts[i - 1], b = way.pts[i], reach = band + MARGIN;
      const seg = { ax: a.x, ay: a.y, dx: b.x - a.x, dy: b.y - a.y, band };
      for (let cx = Math.floor((Math.min(a.x, b.x) - reach) / SIZE); cx <= Math.floor((Math.max(a.x, b.x) + reach) / SIZE); cx++) {
        for (let cy = Math.floor((Math.min(a.y, b.y) - reach) / SIZE); cy <= Math.floor((Math.max(a.y, b.y) + reach) / SIZE); cy++) {
          const key = `${cx},${cy}`;
          if (!map.has(key)) map.set(key, []);
          map.get(key).push(seg);
        }
      }
    }
  }
  return (x, y, extra = 0) => {
    const list = map.get(`${Math.floor(x / SIZE)},${Math.floor(y / SIZE)}`);
    if (!list) return false;
    for (const s of list) {
      const t = Math.max(0, Math.min(1, ((x - s.ax) * s.dx + (y - s.ay) * s.dy) / (s.dx * s.dx + s.dy * s.dy || 1)));
      if (Math.hypot(x - s.ax - s.dx * t, y - s.ay - s.dy * t) < s.band + extra) return true;
    }
    return false;
  };
}

/* ---------- particles ---------- */

function setLane(agent) {
  // Distance to the right of the way's centreline. Cars keep to their lane; people use the path width.
  agent.lane = agent.car ? agent.way.spec.width / 4 : agent.laneFraction * agent.way.spec.width;
}

function newPerson(way, dir, s) {
  const p = {
    car: false, way, dir, s, v: Math.max(0.6, way.spec.speed + gauss() * 0.22),
    laneFraction: (Math.random() - 0.5) * 0.7, wobble: Math.random() * 6.28, wobbleAmp: 0.1 + Math.random() * 0.25, pause: 0,
  };
  setLane(p);
  return p;
}

function newCar(way, dir, s) {
  const vDes = Math.max(3, way.spec.speed * (1 + gauss() * 0.12));
  const c = { car: true, way, dir, s, v: vDes * 0.7, vDes };
  setLane(c);
  return c;
}

// At a junction vertex: pick a connecting way, favouring the one that continues most straight.
// `forced` is true at the end of a way (must continue or leave); otherwise only TURN_PROB of passers turn off.
function turnAt(agent, vertex, forced) {
  const { way, dir } = agent;
  const node = way.nodeAt[vertex], here = way.pts[vertex], from = way.pts[vertex - dir] ?? here;
  const ix = here.x - from.x, iy = here.y - from.y, il = Math.hypot(ix, iy) || 1;
  const options = [];
  for (const e of node.entries) {
    if (e.way === way) continue;
    for (const d of [1, -1]) {
      const next = e.way.pts[e.index + d];
      if (!next) continue;
      const p = e.way.pts[e.index], ox = next.x - p.x, oy = next.y - p.y;
      const cos = (ix * ox + iy * oy) / (il * (Math.hypot(ox, oy) || 1));
      options.push({ e, d, weight: e.way.spec.rate * (0.25 + Math.max(0, cos)) });
    }
  }
  if (!options.length || (!forced && Math.random() > TURN_PROB)) return false;
  let pick = Math.random() * options.reduce((sum, o) => sum + o.weight, 0);
  const chosen = options.find((o) => (pick -= o.weight) <= 0) ?? options[options.length - 1];
  agent.way = chosen.e.way;
  agent.dir = chosen.d;
  agent.s = agent.way.cum[chosen.e.index];
  setLane(agent);
  return true;
}

// Moves an agent `dist` metres along its way, switching ways at a junction. False once it has left the network.
function travel(agent, dist) {
  const { way, dir } = agent;
  const s0 = agent.s, s1 = s0 + dir * dist;
  let nearest = null;
  for (const i of way.junctions) {
    const ahead = (way.cum[i] - s0) * dir;
    if (ahead > 1e-6 && (way.cum[i] - s1) * dir <= 0 && (!nearest || ahead < nearest.ahead)) nearest = { i, ahead };
  }
  if (nearest && turnAt(agent, nearest.i, nearest.i === 0 || nearest.i === way.pts.length - 1)) return true;
  agent.s = s1;
  return s1 >= 0 && s1 <= way.length;
}

function carTarget(car) {
  const { way } = car;
  let factor = 1;
  // Slow into bends (to 40% on a right angle) within 20 m of the vertex.
  for (const b of way.bends) {
    const away = Math.abs(b.at - car.s);
    if (away < 20) factor = Math.min(factor, 1 - 0.6 * Math.min(1, b.turn / (Math.PI / 2)) * (1 - away / 20));
  }
  // Ease off approaching a junction.
  const toEnd = car.dir > 0 ? way.length - car.s : car.s;
  if (way.junctionEnds[car.dir > 0 ? 1 : 0] && toEnd < 15) factor = Math.min(factor, 0.5 + 0.5 * toEnd / 15);
  return car.vDes * factor;
}

/* ---------- simulation ---------- */

// drawn: { roads, paths } the user's own lines, in the same form as features.roads / features.paths.
export function createTraffic(features, radius, drawn = { roads: [], paths: [] }) {
  const roads = buildNetwork(connect(features.roads, drawn.roads), roadSpec, radius);
  const walks = buildNetwork(connect(features.paths, drawn.paths), walkSpec, radius); // people stay off the roads
  const onCarriageway = buildCarriageway(roads.ways);
  const limit2 = (radius * 1.1) ** 2;
  // sim.visit(isCar, x, y, dt), when set, is told every step where each particle is (site metres): used to wear the mass.
  // sim.wear(x, y), when set, says how worn the mass is at a point (0..1): people inside it are drawn to worn ground.
  const sim = { people: [], cars: [], time: 0, visit: null, wear: null, entryPoints: { people: walks.spawns.length, cars: roads.spawns.length } };
  let mass = null; // the floor people can wander on inside the mass (see buildFloor), or null

  const release = (points, mult, dt, add) => {
    for (const sp of points) {
      const rate = (sp.way.spec.rate * mult) / 60;
      if (rate <= 0) { sp.wait = null; continue; }
      sp.wait = (sp.wait ?? expo(rate)) - dt;
      if (sp.wait <= 0) { add(sp); sp.wait = expo(rate); }
    }
  };
  // Entry points can lie beyond the site circle, so only drop particles that are outside AND heading outward.
  const inside = (a, dt) => {
    if (a.roam) { // wandering inside the mass: it never leaves except by a path
      sim.visit?.(false, a.x, a.y, dt);
      return true;
    }
    const q = sample(a.way, a.s);
    sim.visit?.(a.car, q.x, q.y, dt);
    return q.x * q.x + q.y * q.y < limit2 || q.x * q.tx * a.dir + q.y * q.ty * a.dir < 0;
  };

  /* --- the floor inside the mass --- */

  // area: { contains(x, y), bounds: { minX, maxX, minY, maxY } } in site metres. Builds a 1 m grid of the floor:
  // cells inside the mass and clear of any carriageway. Connected floor areas are numbered. Where a path crosses the
  // mass's edge is an entrance/exit (a portal), and each belongs to the floor area it opens onto.
  function buildFloor({ contains, bounds }) {
    const cell = Math.max(ROAM_CELL, Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 300);
    const minX = bounds.minX - 2 * cell, minY = bounds.minY - 2 * cell;
    const nx = Math.ceil((bounds.maxX - bounds.minX) / cell) + 5, ny = Math.ceil((bounds.maxY - bounds.minY) / cell) + 5;
    const cellAt = (x, y) => {
      const i = Math.floor((x - minX) / cell), j = Math.floor((y - minY) / cell);
      return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : j * nx + i;
    };
    const centre = (k) => [minX + ((k % nx) + 0.5) * cell, minY + (Math.floor(k / nx) + 0.5) * cell];
    const free = new Uint8Array(nx * ny);
    for (let k = 0; k < free.length; k++) {
      const [x, y] = centre(k);
      free[k] = contains(x, y) && !onCarriageway(x, y, 0.8) ? 1 : 0;
    }
    const around = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

    // Connected floor areas (8 neighbours).
    const area = new Int32Array(nx * ny).fill(-1), areaCells = [];
    for (let k0 = 0; k0 < free.length; k0++) {
      if (!free[k0] || area[k0] >= 0) continue;
      const id = areaCells.length, cells = [k0], stack = [k0];
      area[k0] = id;
      while (stack.length) {
        const k = stack.pop(), i = k % nx, j = Math.floor(k / nx);
        for (const [di, dj] of around) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
          const nk = nj * nx + ni;
          if (free[nk] && area[nk] < 0) { area[nk] = id; cells.push(nk); stack.push(nk); }
        }
      }
      areaCells.push(cells);
    }

    // The free cell nearest a point, within `reach` cells (-1 if none).
    const nearestFree = (x, y, reach = 3) => {
      const k0 = cellAt(x, y);
      if (k0 < 0) return -1;
      const i0 = k0 % nx, j0 = Math.floor(k0 / nx);
      let best = -1, bestD = Infinity;
      for (let dj = -reach; dj <= reach; dj++) {
        for (let di = -reach; di <= reach; di++) {
          const i = i0 + di, j = j0 + dj;
          if (i < 0 || j < 0 || i >= nx || j >= ny || !free[j * nx + i]) continue;
          const d = di * di + dj * dj;
          if (d < bestD) { bestD = d; best = j * nx + i; }
        }
      }
      return best;
    };

    // Portals: walk every path in 1 m steps and note where it passes through the mass's edge.
    const portals = [], portalsByArea = new Map();
    for (const way of walks.ways) {
      let prev = null;
      for (let s = 0; s <= way.length; s += 1) {
        const q = sample(way, s), here = { s, q, in: contains(q.x, q.y) };
        if (prev && prev.in !== here.in) {
          const at = prev.in ? prev : here; // the sample on the inside
          const k = nearestFree(at.q.x, at.q.y);
          if (k >= 0) {
            const portal = { way, s: at.s, dir: prev.in ? 1 : -1, x: at.q.x, y: at.q.y, cell: k, area: area[k] };
            portals.push(portal);
            if (!portalsByArea.has(portal.area)) portalsByArea.set(portal.area, []);
            portalsByArea.get(portal.area).push(portal);
          }
        }
        prev = here;
      }
    }

    // Steps to reach `goal` from every cell (8-neighbour breadth-first), cached: people follow it downhill.
    const fields = new Map();
    const fieldTo = (goal) => {
      if (fields.has(goal)) return fields.get(goal);
      const field = new Float32Array(nx * ny).fill(Infinity);
      const queue = new Int32Array(nx * ny);
      let head = 0, tail = 0;
      field[goal] = 0;
      queue[tail++] = goal;
      while (head < tail) {
        const k = queue[head++], i = k % nx, j = Math.floor(k / nx);
        for (const [di, dj] of around) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
          const nk = nj * nx + ni;
          if (free[nk] && field[nk] === Infinity) { field[nk] = field[k] + 1; queue[tail++] = nk; }
        }
      }
      if (fields.size >= 60) fields.delete(fields.keys().next().value);
      fields.set(goal, field);
      return field;
    };
    return { nx, ny, cell, free, area, areaCells, portalsByArea, cellAt, centre, nearestFree, fieldTo, contains };
  }

  // Someone on a path has just walked into the mass: they leave the path and wander its floor to one of the exits.
  function startRoaming(p, x, y) {
    const k = mass.nearestFree(x, y);
    if (k < 0) return;
    const area = mass.area[k], exits = mass.portalsByArea.get(area);
    if (!exits?.length) return;
    const farther = exits.filter((e) => Math.hypot(e.x - x, e.y - y) > 4); // not straight back out the way they came
    const pool = farther.length ? farther : exits;
    const exit = pool[Math.floor(Math.random() * pool.length)];
    const cells = mass.areaCells[area], goals = [];
    for (let n = 1 + Math.floor(Math.random() * 3); n > 0; n--) goals.push(cells[Math.floor(Math.random() * cells.length)]);
    goals.push(exit.cell);
    const q = sample(p.way, p.s);
    Object.assign(p, { roam: true, x, y, hx: q.tx * p.dir, hy: q.ty * p.dir, exit, goals, field: mass.fieldTo(goals[0]), pause: 0, inRoad: false, waiting: 0 });
  }

  // One step of someone wandering inside the mass. Returns false if they should be removed.
  function roam(p, dt) {
    if (!mass) return false;
    if (p.pause > 0) { p.pause -= dt; return true; }
    const c = mass.cellAt(p.x, p.y);
    if (c < 0) return false;
    const field = p.field;
    if (field[c] <= 1.5) { // reached this goal
      p.goals.shift();
      if (!p.goals.length) { // reached the exit: back onto the path, heading out
        const e = p.exit;
        Object.assign(p, { roam: false, way: e.way, s: e.s, dir: e.dir, wasIn: true, inRoad: false, waiting: 0 });
        setLane(p);
        return true;
      }
      p.field = mass.fieldTo(p.goals[0]);
      if (Math.random() < 0.4) p.pause = 1 + Math.random() * 3; // stop and look around
      return true;
    }
    // Head for a neighbouring cell that is no farther from the goal, preferring worn ground: that is what makes separate
    // trails settle into the same few routes, which merge like tributaries and branch out again near the entrances and exits.
    const i = c % mass.nx, j = Math.floor(c / mass.nx);
    let best = -1, bestScore = Infinity;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= mass.nx || nj >= mass.ny) continue;
      const nk = nj * mass.nx + ni;
      if (!mass.free[nk] || field[nk] > field[c]) continue;
      const score = field[nk] - (sim.wear ? ATTRACTION * sim.wear(...mass.centre(nk)) : 0) + Math.random() * 0.3;
      if (score < bestScore) { bestScore = score; best = nk; }
    }
    if (best < 0) { p.goals.shift(); if (!p.goals.length) return false; p.field = mass.fieldTo(p.goals[0]); return true; }
    const [tx, ty] = mass.centre(best);
    const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy) || 1;
    let hx = 0.85 * p.hx + 0.15 * (dx / d) + (Math.random() - 0.5) * 0.12;
    let hy = 0.85 * p.hy + 0.15 * (dy / d) + (Math.random() - 0.5) * 0.12;
    const h = Math.hypot(hx, hy) || 1;
    hx /= h; hy /= h;
    const step = p.v * dt;
    if (mass.free[mass.cellAt(p.x + hx * step, p.y + hy * step)]) { p.x += hx * step; p.y += hy * step; p.hx = hx; p.hy = hy; }
    else if (mass.free[mass.cellAt(p.x + (dx / d) * step, p.y + (dy / d) * step)]) { p.x += (dx / d) * step; p.y += (dy / d) * step; p.hx = dx / d; p.hy = dy / d; }
    return true;
  }

  /* --- people and cars keeping apart --- */

  // True if a car is close enough to a point that someone about to step there should wait.
  const carNear = (x, y) => sim.cars.some((c) => Math.hypot(c.x - x, c.y - y) < 5 + 1.5 * c.v);

  // A person about to step from the verge onto a carriageway waits for the cars. Returns true while waiting.
  function waitsForCars(p, dt) {
    const here = sample(p.way, p.s);
    p.cx = here.x;
    p.cy = here.y;
    p.inRoad = onCarriageway(here.x, here.y);
    if (p.inRoad) { p.waiting = 0; return false; } // already crossing: carry on
    const s = Math.max(0, Math.min(p.way.length, p.s + p.dir * CROSS_LOOKAHEAD)), ahead = sample(p.way, s);
    if (onCarriageway(ahead.x, ahead.y) && carNear(ahead.x, ahead.y)) { p.waiting = (p.waiting ?? 0) + dt; return true; }
    p.waiting = 0;
    return false;
  }

  // opts: { people: multiplier, cars: multiplier }
  sim.step = (dt, opts) => {
    release(walks.spawns, opts.people, dt, (sp) => sim.people.length < MAX_PEOPLE && sim.people.push(newPerson(sp.way, sp.dir, sp.s)));
    release(roads.spawns, opts.cars, dt, (sp) => {
      const clear = !sim.cars.some((c) => c.way === sp.way && c.dir === sp.dir && Math.abs(c.s - sp.s) < CAR_LENGTH + MIN_GAP + 2);
      if (clear && sim.cars.length < MAX_CARS) sim.cars.push(newCar(sp.way, sp.dir, sp.s));
    });

    // Where each car is and which way it faces, for people deciding whether to cross.
    for (const c of sim.cars) {
      const q = sample(c.way, c.s);
      c.x = q.x; c.y = q.y; c.hx = q.tx * c.dir; c.hy = q.ty * c.dir;
    }

    sim.people = sim.people.filter((p) => {
      if (p.roam) return roam(p, dt) && inside(p, dt);
      if (p.pause > 0) p.pause -= dt;
      else if (!waitsForCars(p, dt)) {
        if (!travel(p, p.v * dt)) return false;
        if (Math.random() < 0.012 * dt) p.pause = 1 + Math.random() * 4; // stop to look, chat, or check a phone
        if (mass) {
          const q = sample(p.way, p.s), now = mass.contains(q.x, q.y);
          if (p.wasIn === false && now) startRoaming(p, q.x, q.y); // walked in from a path
          p.wasIn = now;
        }
      }
      if (p.waiting > MAX_WAIT) return false; // gave up
      p.wobble += dt * 0.9;
      return inside(p, dt);
    });

    // People on a carriageway: cars stop for them.
    const crossing = sim.people.filter((p) => p.inRoad && !p.roam);

    // Cars follow the one ahead in the same lane of the same way.
    const lanes = new Map();
    for (const c of sim.cars) {
      const k = `${c.way.id}:${c.dir}`;
      if (!lanes.has(k)) lanes.set(k, []);
      lanes.get(k).push(c);
    }
    const gone = new Set();
    for (const lane of lanes.values()) {
      lane.sort((a, b) => (b.s - a.s) * a.dir); // front of the queue first
      lane.forEach((car, i) => {
        let target = carTarget(car);
        if (i > 0) {
          const gap = (lane[i - 1].s - car.s) * car.dir - CAR_LENGTH;
          target = Math.min(target, Math.max(0, (gap - MIN_GAP) / HEADWAY));
        }
        for (const p of crossing) {
          const dx = p.cx - car.x, dy = p.cy - car.y, ahead = dx * car.hx + dy * car.hy;
          if (ahead < 0 || ahead > 25 || Math.abs(-dx * car.hy + dy * car.hx) > 2.2) continue; // not in this car's way
          target = Math.min(target, Math.max(0, (ahead - CAR_LENGTH / 2 - 2 - MIN_GAP) / HEADWAY));
        }
        car.v += Math.max(-BRAKE * dt, Math.min(ACCEL * dt, target - car.v));
        if (!travel(car, car.v * dt) || !inside(car, dt)) gone.add(car);
      });
    }
    if (gone.size) sim.cars = sim.cars.filter((c) => !gone.has(c));
    sim.time += dt;
  };

  // Sets (or, with null, removes) the mass people can walk into. area: { contains(x, y), bounds } in site metres.
  sim.setMass = (area) => {
    mass = area ? buildFloor(area) : null;
    sim.people = sim.people.filter((p) => !p.roam); // anyone inside was on the old floor
    for (const p of sim.people) p.wasIn = undefined;
  };

  // Fills in x, y (site metres) and hx, hy (unit heading) on every particle.
  sim.pose = (leftHand) => {
    for (const a of [...sim.people, ...sim.cars]) {
      if (a.roam) continue; // already has its own position and heading
      const q = sample(a.way, a.s), hx = q.tx * a.dir, hy = q.ty * a.dir;
      // Right of the heading is (hy, -hx); left-hand traffic mirrors the cars' lane.
      const off = (a.car && leftHand ? -a.lane : a.lane) + (a.car ? 0 : Math.sin(a.wobble) * a.wobbleAmp);
      a.x = q.x + hy * off;
      a.y = q.y - hx * off;
      a.hx = hx;
      a.hy = hy;
    }
  };

  sim.reset = () => {
    sim.people = [];
    sim.cars = [];
    sim.time = 0;
    for (const sp of [...walks.spawns, ...roads.spawns]) sp.wait = null;
  };

  // Run ahead so the site starts populated instead of empty.
  sim.warmUp = (seconds, opts) => {
    for (let t = 0; t < seconds; t += 0.25) sim.step(0.25, opts);
    sim.time = 0;
  };
  return sim;
}
