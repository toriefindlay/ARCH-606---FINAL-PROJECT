// VIEW (render): the site's surroundings, from the map features (site/osm.js): the ground with its roads, pavements, planting
// and water; the neighbouring buildings with windows and roofs; trees and cars. The footprints, heights and road lines come
// from the map. Everything else (windows, roofs, road widths, where each tree and car stands) is illustrative.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { randomiser, speckle, canvasTexture } from "./materials.js";

const ROAD_WIDTH = { motorway: 15, trunk: 13, primary: 12, secondary: 10.5, tertiary: 9, residential: 7, unclassified: 7, living_street: 6, service: 4 };
const roadWidth = (kind) => ROAD_WIDTH[String(kind).replace(/_link$/, "")] ?? 6;
const PAVEMENT = 2.4; // m: on each side of a street
const MAX_TREES = 2600, MAX_CARS = 220;

// Features are in (east, north); the scene is x east, z south.
const trace = (ctx, pts, to, close) => {
  pts.forEach((p, i) => ctx[i ? "lineTo" : "moveTo"](...to(p.x, -p.y)));
  if (close) ctx.closePath();
};
const polygon = (ctx, item, to) => {
  trace(ctx, item.outer, to, true);
  for (const h of item.holes ?? []) trace(ctx, h, to, true);
};

/* ---------- ground ---------- */

// Paints the ground, one canvas over a square of side 2R: `to` takes world metres to pixels, `px` is pixels per metre.
function paintGround(ctx, size, features, to, px) {
  const rand = randomiser(7);
  ctx.fillStyle = "#837d67";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 9000; i++) { // soft patches of earth, gravel and rough grass between everything
    const tone = ["86,100,52", "158,146,122", "104,92,72", "74,92,46"][i % 4];
    const x = rand() * size, y = rand() * size, r = (1.5 + rand() * 7) * px;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${tone},0.5)`);
    g.addColorStop(0.55, `rgba(${tone},0.3)`);
    g.addColorStop(1, `rgba(${tone},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  speckle(ctx, size, size, rand, 90000, 1.8, 0.13);
  ctx.lineJoin = ctx.lineCap = "round";
  for (const item of features.green) {
    ctx.fillStyle = item.kind === "water" ? "#3f5c66" : "#566b32";
    ctx.beginPath();
    if (item.line) {
      trace(ctx, item.line, to, false);
      ctx.strokeStyle = "#4f6f7c";
      ctx.lineWidth = 4 * px;
      ctx.stroke();
    } else {
      polygon(ctx, item, to);
      ctx.fill("evenodd");
    }
  }
  speckle(ctx, size, size, rand, 60000, 2.5, 0.14);
  const stroke = (list, width, style, dash = []) => {
    ctx.strokeStyle = style;
    ctx.setLineDash(dash.map((d) => d * px));
    for (const road of list) {
      ctx.lineWidth = width(road) * px;
      ctx.beginPath();
      trace(ctx, road.pts, to, false);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  };
  stroke(features.paths, () => 2.4, "#a89f8c");
  stroke(features.roads, (r) => roadWidth(r.kind) + 2 * PAVEMENT + 0.4, "#6d685e"); // kerb shadow
  stroke(features.roads, (r) => roadWidth(r.kind) + 2 * PAVEMENT, "#a9a398");
  stroke(features.roads, (r) => roadWidth(r.kind) + 0.5, "#c3beb2"); // kerb
  stroke(features.roads, (r) => roadWidth(r.kind), "#3b3d40");
  speckle(ctx, size, size, rand, 70000, 2, 0.1); // grit over the paving
  const streets = features.roads.filter((r) => roadWidth(r.kind) >= 6);
  stroke(streets, () => 0.18, "rgba(235,232,218,0.85)", [3, 3.5]);
}

function buildGroundMesh(features, R) {
  const size = 4096, px = size / (2 * R);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  paintGround(canvas.getContext("2d"), size, features, (x, z) => [(x + R) * px, (z + R) * px], px);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 16;
  const geometry = new THREE.CircleGeometry(R, 128); // (its own texture coordinates run over the square round it)
  geometry.rotateX(-Math.PI / 2);
  const ground = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map, roughness: 0.96 }));
  ground.receiveShadow = true;
  ground.position.y = -0.03;
  return ground;
}

// Where things are, on a grid: for keeping trees and cars off buildings, roads, water and the massing.
function occupancy(features, R, onMass) {
  const size = 1024, px = size / (2 * R), to = (x, z) => [(x + R) * px, (z + R) * px];
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const layer = (draw) => {
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = ctx.strokeStyle = "#000";
    ctx.lineJoin = ctx.lineCap = "round";
    draw();
    const data = ctx.getImageData(0, 0, size, size).data;
    return (x, z) => {
      const [u, v] = to(x, z), i = Math.floor(u), j = Math.floor(v);
      return i >= 0 && j >= 0 && i < size && j < size && data[(j * size + i) * 4 + 3] > 100;
    };
  };
  const blocked = layer(() => {
    for (const b of features.buildings) {
      ctx.beginPath();
      polygon(ctx, b, to);
      ctx.fill("evenodd");
      ctx.lineWidth = 3 * px;
      ctx.stroke();
    }
    for (const [list, width] of [[features.roads, (r) => roadWidth(r.kind) + 1.6], [features.paths, () => 3]]) {
      for (const r of list) {
        ctx.lineWidth = width(r) * px;
        ctx.beginPath();
        trace(ctx, r.pts, to, false);
        ctx.stroke();
      }
    }
    for (const item of features.green) {
      if (item.kind !== "water") continue;
      ctx.beginPath();
      if (item.line) { trace(ctx, item.line, to, false); ctx.lineWidth = 5 * px; ctx.stroke(); }
      else { polygon(ctx, item, to); ctx.fill("evenodd"); }
    }
  });
  const green = layer(() => {
    for (const item of features.green) {
      if (item.kind !== "green" || !item.outer) continue;
      ctx.beginPath();
      polygon(ctx, item, to);
      ctx.fill("evenodd");
    }
  });
  const nearMass = (x, z, margin) => [[0, 0], [margin, 0], [-margin, 0], [0, margin], [0, -margin]].some(([dx, dz]) => onMass(x + dx, z + dz));
  return { blocked, green, nearMass };
}

/* ---------- buildings ---------- */

// One bay (3.2 m) by one storey (3.2 m): a wall with a window. White where the wall's own colour shows.
const facadeTexture = (kind) =>
  canvasTexture(256, 256, 3.2, 3.2, (ctx, w, h, rand) => {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, rand, 1800, 2, 0.08);
    const [x, y, ww, wh] = kind === 0 ? [76, 56, 104, 130] : kind === 1 ? [24, 62, 208, 124] : [52, 40, 152, 190];
    ctx.fillStyle = "#d8d3c8";
    ctx.fillRect(x - 8, y - 8, ww + 16, wh + 18);
    const glass = ctx.createLinearGradient(x, y, x + ww, y + wh);
    glass.addColorStop(0, "#8fa6b3");
    glass.addColorStop(0.45, "#3c4d59");
    glass.addColorStop(1, "#26323b");
    ctx.fillStyle = glass;
    ctx.fillRect(x, y, ww, wh);
    ctx.fillStyle = "#c9c5bb";
    for (let k = 1; k < (kind === 1 ? 4 : 2); k++) ctx.fillRect(x + (ww * k) / (kind === 1 ? 4 : 2) - 2, y, 4, wh);
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(x, y, ww, 9);
    ctx.fillStyle = "rgba(0,0,0,0.1)";
    ctx.fillRect(0, h - 5, w, 5); // floor line
  });

const roofTiles = () =>
  canvasTexture(256, 256, 2.4, 2.4, (ctx, w, h, rand) => {
    ctx.fillStyle = "#b8664a";
    ctx.fillRect(0, 0, w, h);
    for (let j = 0; j < 8; j++) {
      for (let i = 0; i < 12; i++) {
        ctx.fillStyle = `rgba(${rand() < 0.5 ? "80,32,18" : "235,160,120"},${rand() * 0.35})`;
        ctx.fillRect((i * w) / 12, (j * h) / 8, w / 12 - 1, h / 8 - 3);
      }
      ctx.fillStyle = "rgba(55,20,10,0.4)";
      ctx.fillRect(0, (j * h) / 8, w, 3);
    }
  });

const WALL_TONES = [0xf1ece0, 0xe6ddca, 0xf7f5ef, 0xd9cfc0, 0xcdb7a0, 0xdcdedd, 0xb98a72, 0xe9d9b8];

const signedArea = (ring) => ring.reduce((s, p, i) => { const q = ring[(i + 1) % ring.length]; return s + p.x * q.y - q.x * p.y; }, 0) / 2;

// The smallest rectangle round a ring, along one of its sides: { cx, cy, ux, uy, long, short, area }.
function boundingRect(ring) {
  let best = null;
  for (let i = 0; i + 1 < ring.length; i++) {
    const len = Math.hypot(ring[i + 1].x - ring[i].x, ring[i + 1].y - ring[i].y);
    if (len < 0.5) continue;
    let ux = (ring[i + 1].x - ring[i].x) / len, uy = (ring[i + 1].y - ring[i].y) / len;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const p of ring) {
      const a = p.x * ux + p.y * uy, b = -p.x * uy + p.y * ux;
      a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
    }
    const area = (a1 - a0) * (b1 - b0);
    if (best && area >= best.area) continue;
    const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2, cx = ca * ux - cb * uy, cy = ca * uy + cb * ux;
    let long = a1 - a0, short = b1 - b0;
    if (short > long) { [long, short] = [short, long]; [ux, uy] = [-uy, ux]; }
    best = { cx, cy, ux, uy, long, short, area };
  }
  return best;
}

function geometryFrom({ position, uv, color }) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  if (color) g.setAttribute("color", new THREE.Float32BufferAttribute(color, 3));
  g.computeVertexNormals();
  return g;
}

function buildNeighbours(features) {
  const rand = randomiser(23);
  const soup = () => ({ position: [], uv: [], color: [] });
  const walls = [soup(), soup(), soup()], tiled = soup(), flat = soup(), boxes = soup();
  const colour = new THREE.Color();
  const tri = (out, pts, uvs, tone) => {
    colour.set(tone);
    for (let k = 0; k < 3; k++) {
      out.position.push(...pts[k]);
      out.uv.push(...uvs[k]);
      out.color.push(colour.r, colour.g, colour.b);
    }
  };
  const quad = (out, p, uv, tone) => {
    tri(out, [p[0], p[1], p[2]], [uv[0], uv[1], uv[2]], tone);
    tri(out, [p[0], p[2], p[3]], [uv[0], uv[2], uv[3]], tone);
  };

  for (const b of features.buildings) {
    const style = Math.floor(rand() * 3), tone = WALL_TONES[Math.floor(rand() * WALL_TONES.length)];
    const storeys = Math.max(1, Math.round(b.height / 3.2)), vTop = storeys * 3.2;
    const area = Math.abs(signedArea(b.outer));
    const rect = boundingRect(b.outer);
    const hipped = rect && b.height <= 13 && area < 500 && !b.holes.length && area > 0.78 * rect.area && rand() < 0.75;
    for (const ring of [b.outer, ...b.holes]) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const p = ring[i], q = ring[i + 1], len = Math.hypot(q.x - p.x, q.y - p.y);
        if (len < 0.05) continue;
        const bays = Math.max(1, Math.round(len / 3.2)) * 3.2, plain = len < 2;
        const u = plain ? [0, 0.3] : [0, bays];
        quad(walls[style], [[p.x, 0, -p.y], [q.x, 0, -q.y], [q.x, b.height, -q.y], [p.x, b.height, -p.y]], [[u[0], 0], [u[1], 0], [u[1], vTop], [u[0], vTop]], tone);
      }
    }
    if (hipped) { // a tiled hip roof over the building's rectangle, with a little overhang
      const { cx, cy, ux, uy } = rect, hl = rect.long / 2 + 0.35, hs = rect.short / 2 + 0.35, rise = Math.min(3, hs * 0.55);
      const at = (a, s, y) => [cx + a * ux - s * uy, y, -(cy + a * uy + s * ux)];
      const y = b.height, ridge = Math.max(0, hl - hs);
      const c = [at(-hl, -hs, y), at(hl, -hs, y), at(hl, hs, y), at(-hl, hs, y)], r0 = at(-ridge, 0, y + rise), r1 = at(ridge, 0, y + rise);
      const slope = Math.hypot(hs, rise);
      quad(tiled, [c[0], c[1], r1, r0], [[-hl, 0], [hl, 0], [ridge, slope], [-ridge, slope]], 0xffffff);
      quad(tiled, [c[2], c[3], r0, r1], [[-hl, 0], [hl, 0], [ridge, slope], [-ridge, slope]], 0xffffff);
      tri(tiled, [c[1], c[2], r1], [[-hs, 0], [hs, 0], [0, slope]], 0xe6e0da);
      tri(tiled, [c[3], c[0], r0], [[-hs, 0], [hs, 0], [0, slope]], 0xe6e0da);
    }
    // the flat top (under a hip roof it closes the walls)
    const holes = b.holes.map((h) => h.slice(0, -1)), outer = b.outer.slice(0, -1);
    const all = [outer, ...holes].flat();
    const roofTone = [0x9b978f, 0xb9b5ac, 0x87837c, 0xcfccc4][Math.floor(rand() * 4)];
    for (const face of THREE.ShapeUtils.triangulateShape(outer, holes)) {
      tri(flat, face.map((k) => [all[k].x, b.height, -all[k].y]), face.map((k) => [all[k].x, all[k].y]), roofTone);
    }
    if (!hipped) {
      for (let i = 0; i + 1 < b.outer.length; i++) { // parapet
        const p = b.outer[i], q = b.outer[i + 1];
        quad(flat, [[p.x, b.height, -p.y], [q.x, b.height, -q.y], [q.x, b.height + 0.6, -q.y], [p.x, b.height + 0.6, -p.y]], [[0, 0], [1, 0], [1, 1], [0, 1]], 0xe4e0d6);
      }
      if (rect && area > 120) { // plant on the roof
        const count = 1 + Math.floor(rand() * 3);
        for (let n = 0; n < count; n++) {
          const a = (rand() - 0.5) * rect.long * 0.45, s = (rand() - 0.5) * rect.short * 0.4;
          const w = 1 + rand() * 2.2, d = 1 + rand() * 1.6, h = 0.5 + rand() * 1.2;
          const at = (du, dv, y) => [rect.cx + (a + du) * rect.ux - (s + dv) * rect.uy, y, -(rect.cy + (a + du) * rect.uy + (s + dv) * rect.ux)];
          const base = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
          const low = base.map(([u, v]) => at(u, v, b.height)), high = base.map(([u, v]) => at(u, v, b.height + h));
          const flatUv = [[0, 0], [1, 0], [1, 1], [0, 1]];
          for (let k = 0; k < 4; k++) quad(boxes, [low[k], low[(k + 1) % 4], high[(k + 1) % 4], high[k]], flatUv, 0xc8cacb);
          quad(boxes, high, flatUv, 0xdadcdc);
        }
      }
    }
  }

  const group = new THREE.Group();
  const add = (data, options) => {
    if (!data.position.length) return;
    const mesh = new THREE.Mesh(geometryFrom(data), new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85, ...options }));
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  };
  walls.forEach((w, k) => add(w, { map: facadeTexture(k), roughness: 0.7 }));
  add(tiled, { map: roofTiles(), roughness: 0.8 });
  add(flat, {});
  add(boxes, { metalness: 0.35, roughness: 0.55 });
  return group;
}

/* ---------- trees ---------- */

// A crown made of many small leaves (flat triangles) scattered through an ellipsoid, so that its edge is ragged, light
// gets in, and its shadow is dappled.
function foliage(rand, leaves, size, shape) {
  const position = [], normal = [], color = [];
  const a = new THREE.Vector3(), n = new THREE.Vector3(), t = new THREE.Vector3(), s = new THREE.Vector3(), v = new THREE.Vector3();
  for (let i = 0; i < leaves; i++) {
    const { at, out, depth } = shape(rand);
    a.set(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
    t.crossVectors(a, out).normalize();
    s.crossVectors(t, a).normalize();
    n.copy(out).addScaledVector(a, 0.5).normalize(); // (lit as part of the crown, with some of each leaf's own tilt)
    const shade = (0.55 + 0.45 * depth) * (0.8 + rand() * 0.4);
    for (const [u, w] of [[0, 1], [-0.65, -0.5], [0.65, -0.5]]) {
      v.copy(at).addScaledVector(t, u * size).addScaledVector(s, w * size);
      position.push(v.x, v.y, v.z);
      normal.push(n.x, n.y, n.z);
      color.push(shade, shade, shade);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(color, 3));
  return g;
}

// A broadleaf crown: a few overlapping clumps. Size 1: about 6 m across, standing on the ground.
function broadleaf(rand) {
  const clumps = [[0, 4.9, 0, 2.2], [1.5, 4.2, 0.4, 1.6], [-1.4, 4.4, -0.5, 1.7], [0.2, 4.0, 1.5, 1.5], [-0.3, 4.1, -1.5, 1.5], [0.3, 6.1, -0.2, 1.4]];
  return foliage(rand, 850, 0.4, (r) => {
    const [x, y, z, radius] = clumps[Math.floor(r() * clumps.length)];
    const out = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
    const depth = 0.55 + 0.45 * Math.sqrt(r());
    return { at: new THREE.Vector3(x, y, z).addScaledVector(out, radius * depth), out, depth };
  });
}

// A cypress: a tall narrow flame. Size 1: about 9 m high.
const cypress = (rand) =>
  foliage(rand, 600, 0.32, (r) => {
    const h = r(), angle = r() * Math.PI * 2, wide = 0.95 * Math.sin(Math.PI * Math.min(1, h * 0.82 + 0.1)) ** 0.8;
    const depth = 0.55 + 0.45 * Math.sqrt(r());
    return { at: new THREE.Vector3(Math.cos(angle) * wide * depth, 0.7 + h * 8.4, Math.sin(angle) * wide * depth), out: new THREE.Vector3(Math.cos(angle), 0.35, Math.sin(angle)).normalize(), depth };
  });

function instances(geometry, material, items, tint) {
  const mesh = new THREE.InstancedMesh(geometry, material, items.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  items.forEach((it, i) => {
    m.compose(new THREE.Vector3(it.x, it.y ?? 0, it.z), q.setFromAxisAngle(up, it.turn), new THREE.Vector3(it.s, it.s * (it.tall ?? 1), it.s));
    mesh.setMatrixAt(i, m);
    if (tint) mesh.setColorAt(i, tint(it, i));
  });
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

function buildTrees(features, R, where) {
  const rand = randomiser(41), broad = [], tall = [], shrubs = [], taken = new Set();
  const place = (x, z, cypressShare, scale = 1) => {
    if (broad.length + tall.length >= MAX_TREES || Math.hypot(x, z) > R - 4) return;
    if (where.blocked(x, z) || where.nearMass(x, z, 5)) return;
    const key = `${Math.round(x / 3.6)},${Math.round(z / 3.6)}`;
    if (taken.has(key)) return;
    taken.add(key);
    const tree = { x, z, turn: rand() * 7, s: scale * (0.65 + rand() * 0.6), tall: 0.85 + rand() * 0.35 };
    (rand() < cypressShare ? tall : broad).push(tree);
    if (rand() < 0.5) shrubs.push({ x: x + (rand() - 0.5) * 5, z: z + (rand() - 0.5) * 5, turn: rand() * 7, s: 0.18 + rand() * 0.2 });
  };
  // along the streets, at the back of the pavement
  for (const road of features.roads) {
    const off = roadWidth(road.kind) / 2 + PAVEMENT - 0.5;
    for (let i = 0; i + 1 < road.pts.length; i++) {
      const p = road.pts[i], q = road.pts[i + 1], dx = q.x - p.x, dz = -(q.y - p.y), len = Math.hypot(dx, dz);
      for (let s = 4; s < len; s += 11) {
        for (const side of [-1, 1]) {
          if (rand() < 0.45) continue;
          place(p.x + (dx / len) * s - (dz / len) * off * side, -p.y + (dz / len) * s + (dx / len) * off * side, 0.2, 0.75);
        }
      }
    }
  }
  // thick in parks and gardens, thinner in the open ground between buildings (nearest the site first)
  const step = 5.5, spots = [];
  for (let x = -R; x < R; x += step) for (let z = -R; z < R; z += step) spots.push([x + (rand() - 0.5) * step, z + (rand() - 0.5) * step]);
  spots.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
  for (const [x, z] of spots) {
    const park = where.green(x, z);
    if (rand() < (park ? 0.6 : 0.2)) place(x, z, park ? 0.15 : 0.28, park ? 1 : 0.85);
  }
  for (const s of shrubs.splice(0)) if (!where.blocked(s.x, s.z) && !where.nearMass(s.x, s.z, 3)) shrubs.push({ ...s, y: -s.s * 2.6 });

  const group = new THREE.Group();
  const leaf = (c) => new THREE.MeshStandardMaterial({ color: c, vertexColors: true, roughness: 0.95, side: THREE.DoubleSide });
  const greens = [0x63803a, 0x4d6c30, 0x7a8f46, 0x58773f, 0x8a9a55, 0x3f5e2d].map((c) => new THREE.Color(c));
  const tintFrom = (list) => () => list[Math.floor(rand() * list.length)];
  const crown = broadleaf(randomiser(5));
  if (broad.length) {
    group.add(instances(crown, leaf(0xffffff), broad, tintFrom(greens)));
    const trunk = new THREE.CylinderGeometry(0.14, 0.24, 4, 6).translate(0, 2, 0);
    group.add(instances(trunk, new THREE.MeshStandardMaterial({ color: 0x5a4331, roughness: 1 }), broad));
  }
  if (tall.length) group.add(instances(cypress(randomiser(9)), leaf(0xffffff), tall, tintFrom([0x33502c, 0x2b4527, 0x40602f].map((c) => new THREE.Color(c)))));
  if (shrubs.length) group.add(instances(crown, leaf(0xffffff), shrubs, tintFrom([...greens, new THREE.Color(0x9a5560)])));
  return group;
}

/* ---------- cars ---------- */

function buildCars(features, R, where) {
  const rand = randomiser(61), cars = [];
  const near = features.roads.filter((r) => roadWidth(r.kind) >= 6);
  for (const road of near) {
    for (let i = 0; i + 1 < road.pts.length && cars.length < MAX_CARS; i++) {
      const p = road.pts[i], q = road.pts[i + 1], dx = q.x - p.x, dz = -(q.y - p.y), len = Math.hypot(dx, dz);
      for (let s = 6; s < len; s += 17) {
        if (rand() > 0.22) continue;
        const side = rand() < 0.5 ? -1 : 1, off = (roadWidth(road.kind) / 4) * side;
        const x = p.x + (dx / len) * s - (dz / len) * off, z = -p.y + (dz / len) * s + (dx / len) * off;
        if (Math.hypot(x, z) < R && !where.nearMass(x, z, 3)) cars.push({ x, z, turn: Math.atan2(-dz, dx) + (side < 0 ? Math.PI : 0), s: 1 });
      }
    }
  }
  const group = new THREE.Group();
  if (!cars.length) return group;
  const body = mergeGeometries([new THREE.BoxGeometry(4.3, 0.65, 1.8).translate(0, 0.72, 0), new THREE.BoxGeometry(1.9, 0.12, 1.55).translate(-0.3, 1.66, 0)]);
  const glass = new THREE.BoxGeometry(2.3, 0.56, 1.66).translate(-0.3, 1.33, 0);
  const wheels = mergeGeometries([[-1.35, -0.85], [-1.35, 0.85], [1.35, -0.85], [1.35, 0.85]].map(([x, z]) => new THREE.CylinderGeometry(0.34, 0.34, 0.24, 12).rotateX(Math.PI / 2).translate(x, 0.34, z)));
  const paints = [0xe8e8e6, 0x2c2f33, 0x8f969c, 0x9c3b32, 0x2f4a6b, 0xd9d4c7].map((c) => new THREE.Color(c));
  group.add(instances(body, new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.5, roughness: 0.3 }), cars, () => paints[Math.floor(rand() * paints.length)]));
  group.add(instances(glass, new THREE.MeshStandardMaterial({ color: 0x1d2830, metalness: 0.6, roughness: 0.15 }), cars));
  group.add(instances(wheels, new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.9 }), cars));
  return group;
}

// Is the point (east, north) inside a footprint? (even-odd, holes included)
function within(item, x, y) {
  let inside = false;
  for (const ring of [item.outer, ...item.holes]) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const p = ring[i], q = ring[j];
      if ((p.y > y) !== (q.y > y) && x < ((q.x - p.x) * (y - p.y)) / (q.y - p.y) + p.x) inside = !inside;
    }
  }
  return inside;
}

// { ground, context }: the ground is always shown; `context` (buildings, trees, cars) can be hidden. `onMass(x, z)` says
// whether the project's own massing stands there, so that nothing is planted or parked on it, and `bounds` is the box round
// the massing.
export function buildSurroundings(features, radius, onMass, bounds) {
  const R = radius * 1.15;
  const where = occupancy(features, R, onMass);
  const context = new THREE.Group();
  // (map buildings that overlap the massing would stand through it: they are the ones it replaces)
  const footprint = []; // points (east, north) all over the massing
  const step = Math.max(1, Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) / 60);
  for (let x = bounds.min.x + step / 2; x < bounds.max.x; x += step) {
    for (let z = bounds.min.z + step / 2; z < bounds.max.z; z += step) if (onMass(x, z)) footprint.push([x, -z]);
  }
  // either a corner of the building is on the massing, or part of the massing is inside the building
  const overlaps = (b) => b.outer.some((p) => onMass(p.x, -p.y)) || footprint.some(([x, y]) => within(b, x, y));
  context.add(buildNeighbours({ ...features, buildings: features.buildings.filter((b) => !overlaps(b)) }), buildTrees(features, R, where), buildCars(features, R, where));
  return { ground: buildGroundMesh(features, R), context };
}
