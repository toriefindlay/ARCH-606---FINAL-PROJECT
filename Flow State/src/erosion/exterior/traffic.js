// MODEL (exterior erosion): people and cars moving along the site's paths and roads.
// Pure logic, with no THREE scene or DOM code. Coordinates are site metres (x = east, y = north),
// the same as features.roads / features.paths. The view turns them into world positions.
//
// Roads and paths become a graph: ways that share a vertex are connected. Particles enter where a
// way leaves the site, follow their way, and choose a connecting way at junctions (preferring to
// go straight). They leave when they run off a dead end or out of the site.

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
  residential: { speed: 1.4, width: 5, rate: 1.5 }, // people also walk minor streets
  living_street: { speed: 1.4, width: 4.5, rate: 2 },
  service: { speed: 1.4, width: 3.5, rate: 0.7 },
  unclassified: { speed: 1.4, width: 5, rate: 1 },
};
const WALK_DEFAULT = { speed: 1.4, width: 2.5, rate: 2 };
const walkSpec = (kind) => WALK[kind] ?? WALK_DEFAULT;
const WALKABLE_ROADS = new Set(["residential", "living_street", "service", "unclassified"]);

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
  const walkable = [...features.paths, ...features.roads.filter((r) => WALKABLE_ROADS.has(r.kind))];
  const walks = buildNetwork(connect(walkable, drawn.paths), walkSpec, radius);
  const limit2 = (radius * 1.1) ** 2;
  // sim.visit(isCar, x, y, dt), when set, is told every step where each particle is (site metres): used to wear the mass.
  const sim = { people: [], cars: [], time: 0, visit: null, entryPoints: { people: walks.spawns.length, cars: roads.spawns.length } };

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
    const q = sample(a.way, a.s);
    sim.visit?.(a.car, q.x, q.y, dt);
    return q.x * q.x + q.y * q.y < limit2 || q.x * q.tx * a.dir + q.y * q.ty * a.dir < 0;
  };

  // opts: { people: multiplier, cars: multiplier }
  sim.step = (dt, opts) => {
    release(walks.spawns, opts.people, dt, (sp) => sim.people.length < MAX_PEOPLE && sim.people.push(newPerson(sp.way, sp.dir, sp.s)));
    release(roads.spawns, opts.cars, dt, (sp) => {
      const clear = !sim.cars.some((c) => c.way === sp.way && c.dir === sp.dir && Math.abs(c.s - sp.s) < CAR_LENGTH + MIN_GAP + 2);
      if (clear && sim.cars.length < MAX_CARS) sim.cars.push(newCar(sp.way, sp.dir, sp.s));
    });

    sim.people = sim.people.filter((p) => {
      if (p.pause > 0) p.pause -= dt;
      else {
        if (!travel(p, p.v * dt)) return false;
        if (Math.random() < 0.012 * dt) p.pause = 1 + Math.random() * 4; // stop to look, chat, or check a phone
      }
      p.wobble += dt * 0.9;
      return inside(p, dt);
    });

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
        car.v += Math.max(-BRAKE * dt, Math.min(ACCEL * dt, target - car.v));
        if (!travel(car, car.v * dt) || !inside(car, dt)) gone.add(car);
      });
    }
    if (gone.size) sim.cars = sim.cars.filter((c) => !gone.has(c));
    sim.time += dt;
  };

  // Fills in x, y (site metres) and hx, hy (unit heading) on every particle.
  sim.pose = (leftHand) => {
    for (const a of [...sim.people, ...sim.cars]) {
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
