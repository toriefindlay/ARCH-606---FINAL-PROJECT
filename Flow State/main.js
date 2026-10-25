import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const MAX_BUILDINGS = 6000;
const LEVEL_HEIGHT = 3.2;

const $ = (id) => document.getElementById(id);
const startEl = $("start");
const loadingEl = $("loading");
const hudEl = $("hud");

// ---------------------------------------------------------------- scene setup

const renderer = new THREE.WebGLRenderer({ canvas: $("scene"), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const SKY = new THREE.Color(0xeceae4);
scene.background = SKY;

const camera = new THREE.PerspectiveCamera(45, 1, 1, 6000);
camera.position.set(400, 350, 400);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.02;
controls.autoRotateSpeed = 0.6;

const hemi = new THREE.HemisphereLight(0xffffff, 0xb9b4a6, 1.4);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun, sun.target);

let siteGroup = null;
const layers = {};

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

let lastT = 0;
renderer.setAnimationLoop((t) => {
  const dt = Math.min((t - lastT) / 1000, 0.1);
  lastT = t;
  controls.update();
  runRise(t);
  tickSun(dt);
  tickWind(dt);
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------- start form

const form = $("site-form");
const latEl = $("lat");
const lonEl = $("lon");
const radiusEl = $("radius");

radiusEl.addEventListener("input", () => ($("radius-out").textContent = `${radiusEl.value} m`));

// Paste "lat, lon" into either field and split it.
for (const el of [latEl, lonEl]) {
  el.addEventListener("paste", (e) => {
    const text = (e.clipboardData || window.clipboardData).getData("text");
    const m = text.match(/(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)/);
    if (!m) return;
    e.preventDefault();
    latEl.value = m[1];
    lonEl.value = m[2];
  });
}

document.querySelectorAll(".presets button").forEach((b) =>
  b.addEventListener("click", () => {
    latEl.value = b.dataset.lat;
    lonEl.value = b.dataset.lon;
  })
);

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const lat = parseFloat(latEl.value);
  const lon = parseFloat(lonEl.value);
  const err = $("form-error");
  if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) {
    err.textContent = "Enter a latitude between -90 and 90 and a longitude between -180 and 180.";
    return;
  }
  err.textContent = "";
  generate(lat, lon, parseInt(radiusEl.value, 10));
});

$("new-site").addEventListener("click", async () => {
  if (currentSave) await saveCurrent(); // a saved site keeps its changes when you leave it
  hudEl.classList.add("hidden");
  startEl.classList.remove("hidden");
  clearSite();
  currentSave = null;
  currentData = null;
  renderSaved();
});

document.querySelectorAll("[data-layer]").forEach((box) =>
  box.addEventListener("change", () => {
    if (layers[box.dataset.layer]) layers[box.dataset.layer].visible = box.checked;
    if (box.dataset.layer === "sun" || box.dataset.layer === "wind") syncAnalysis();
  })
);
$("orbit").addEventListener("change", (e) => (controls.autoRotate = e.target.checked));

// ---------------------------------------------------------------- pipeline

const STEPS = ["fetch", "ground", "lines", "mass"];

function setStep(name) {
  const idx = STEPS.indexOf(name);
  document.querySelectorAll("#steps li").forEach((li) => {
    const i = STEPS.indexOf(li.dataset.step);
    li.classList.toggle("done", i < idx);
    li.classList.toggle("active", i === idx);
  });
  $("bar-fill").style.width = `${(idx / STEPS.length) * 100 + 10}%`;
}

// Yield to the browser so the loading screen can repaint between heavy steps.
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60)));

// `saved` (optional) is a record from loadSite(): reuses its map data and restores its state.
async function generate(lat, lon, radius, saved = null) {
  startEl.classList.add("hidden");
  loadingEl.classList.remove("hidden", "fade");
  $("loading-coords").textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}  ·  ${radius} m`;
  clearSite();

  try {
    setStep("fetch");
    const data = saved ? saved.data : await fetchOSM(lat, lon, radius);
    currentData = data;
    currentSave = saved ? { id: saved.id, name: saved.name } : null;

    setStep("ground");
    await frame();
    siteGroup = new THREE.Group();
    scene.add(siteGroup);
    const project = makeProjector(lat, lon);
    const features = parseFeatures(data, project, radius);
    buildGround(radius);

    setStep("lines");
    await frame();
    layers.green = buildGreen(features.green);
    layers.roads = buildLines(features.roads, ROAD_STYLE);
    layers.paths = buildLines(features.paths, PATH_STYLE);
    siteGroup.add(layers.green, layers.roads, layers.paths);

    setStep("mass");
    await frame();
    layers.buildings = buildBuildings(features.buildings);
    siteGroup.add(layers.buildings, buildMarker(radius));
    layers.drawn = new THREE.Group();
    siteGroup.add(layers.drawn);
    initAnalysis(lat, lon, radius);
    userLines = [];
    renderDrawn();

    frameCamera(radius);
    $("bar-fill").style.width = "100%";
    showStats(features);
    document.querySelectorAll("[data-layer]").forEach((b) => (b.checked = layers[b.dataset.layer]?.visible ?? true));
    syncAnalysis();
    if (saved) applyState(saved.state);
    $("save-name").value = saved?.name ?? `Site ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    $("save-status").textContent = saved ? "Loaded saved site." : "Not saved yet.";

    await frame();
    loadingEl.classList.add("fade");
    hudEl.classList.remove("hidden");
    setTimeout(() => loadingEl.classList.add("hidden"), 800);
  } catch (err) {
    console.error(err);
    loadingEl.classList.add("hidden");
    startEl.classList.remove("hidden");
    $("form-error").textContent = err.message || "Something went wrong generating the site.";
  }
}

function clearSite() {
  stopDrawing();
  if (!siteGroup) return;
  siteGroup.traverse((o) => {
    o.geometry?.dispose();
    o.material?.map?.dispose();
    o.material?.dispose?.();
    o.customDepthMaterial?.dispose();
  });
  site = null;
  windState = null;
  sunPlaying = false;
  scene.remove(siteGroup);
  siteGroup = null;
  riseEnd = 0;
  riseUniform.value = 0;
  for (const k in layers) delete layers[k];
}

// ---------------------------------------------------------------- data

async function fetchOSM(lat, lon, r) {
  const a = `(around:${r},${lat},${lon})`;
  const query = `[out:json][timeout:40];(
    way["highway"]${a};
    way["building"]${a};
    way["leisure"~"^(park|garden|playground|pitch|common|recreation_ground|nature_reserve)$"]${a};
    way["landuse"~"^(grass|forest|meadow|village_green|recreation_ground|cemetery|orchard|allotments)$"]${a};
    way["natural"~"^(wood|water|scrub|grassland|wetland)$"]${a};
    way["waterway"~"^(river|canal|stream)$"]${a};
    relation["type"="multipolygon"]["building"]${a};
    relation["type"="multipolygon"]["leisure"~"^(park|garden|common)$"]${a};
    relation["type"="multipolygon"]["natural"~"^(water|wood)$"]${a};
    relation["type"="multipolygon"]["landuse"~"^(grass|forest|meadow)$"]${a};
  );out geom qt;`;

  // Same site (to ~11 m) and radius within a week: skip the network entirely.
  const key = `${lat.toFixed(4)},${lon.toFixed(4)},${r}`;
  const cached = await cacheGet(key);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.json;

  // Ask every server at once and take the first good answer.
  const ctrl = new AbortController();
  const attempts = OVERPASS.map(async (url) => {
    const res = await fetch(url, {
      method: "POST",
      body: "data=" + encodeURIComponent(query),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Map server responded ${res.status}`);
    const json = await res.json();
    // An empty reply with a remark is a server-side failure, not an empty site.
    if (json.remark && !json.elements?.length) throw new Error(json.remark);
    return json;
  });

  let json;
  try {
    json = await Promise.any(attempts);
    ctrl.abort();
  } catch (e) {
    throw new Error(`Couldn't reach the map servers (${e.errors?.[0]?.message ?? e.message}). Try again in a moment.`);
  }
  if (!json.elements?.length) throw new Error("No map data found at those coordinates. Check the latitude and longitude.");

  cachePut(key, { time: Date.now(), json });
  return json;
}

const CACHE_TTL = 7 * 24 * 3600 * 1000;

// Stores: osm (download cache), sites (saved-site metadata), siteData (saved map data, kept
// apart so listing sites doesn't load megabytes of geometry).
let dbPromise = null;
function openCache() {
  dbPromise ??= new Promise((resolve, reject) => {
    const rq = indexedDB.open("flow-state", 2);
    rq.onupgradeneeded = () => {
      for (const name of ["osm", "sites", "siteData"]) {
        if (!rq.result.objectStoreNames.contains(name)) rq.result.createObjectStore(name);
      }
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => {
      dbPromise = null;
      reject(rq.error);
    };
  });
  return dbPromise;
}

// The cache is an optimisation only: any failure just means a normal fetch.
async function cacheGet(key) {
  try {
    const db = await openCache();
    return await new Promise((resolve) => {
      const rq = db.transaction("osm").objectStore("osm").get(key);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function cachePut(key, value) {
  try {
    const db = await openCache();
    db.transaction("osm", "readwrite").objectStore("osm").put(value, key);
  } catch { /* ignore */ }
}

// Local equirectangular projection: x = east, z = -north, in metres.
function makeProjector(lat0, lon0) {
  const mLat = 111320;
  const mLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return (lat, lon) => new THREE.Vector2((lon - lon0) * mLon, (lat - lat0) * mLat); // (east, north)
}

const PATH_TYPES = new Set(["footway", "path", "pedestrian", "steps", "cycleway", "bridleway", "corridor", "track"]);
const SKIP_ROADS = new Set(["proposed", "construction", "razed", "abandoned"]);

function parseFeatures(data, project, radius) {
  const out = { roads: [], paths: [], green: [], buildings: [], counts: {} };
  const toPts = (geom) => geom.map((g) => project(g.lat, g.lon));
  const isClosed = (g) => g.length > 3 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;

  // Returns [{outer: Vector2[], holes: Vector2[][]}]
  const polygonsOf = (el) => {
    if (el.type === "way") return el.geometry && isClosed(el.geometry) ? [{ outer: toPts(el.geometry), holes: [] }] : [];
    const outers = (el.members || []).filter((m) => m.role !== "inner" && m.geometry && isClosed(m.geometry));
    const inners = (el.members || []).filter((m) => m.role === "inner" && m.geometry && isClosed(m.geometry));
    return outers.map((o) => ({ outer: toPts(o.geometry), holes: inners.map((i) => toPts(i.geometry)) }));
  };

  for (const el of data.elements) {
    const t = el.tags || {};

    if (t.highway && el.type === "way" && !SKIP_ROADS.has(t.highway) && el.geometry) {
      (PATH_TYPES.has(t.highway) ? out.paths : out.roads).push({ pts: toPts(el.geometry), kind: t.highway });
    } else if (t.waterway && el.geometry) {
      out.green.push({ line: toPts(el.geometry), kind: "water" });
    } else if (t.building || t["building:part"]) {
      for (const poly of polygonsOf(el)) out.buildings.push({ ...poly, height: buildingHeight(t, poly.outer) });
    } else if (t.leisure || t.landuse || t.natural) {
      const kind = t.natural === "water" || t.natural === "wetland" ? "water" : "green";
      for (const poly of polygonsOf(el)) out.green.push({ ...poly, kind });
    }
  }

  // Drop overlapping duplicates of building:part inside a building outline is overkill here;
  // just cap the count, keeping the buildings nearest the site.
  const dist = (b) => b.outer.reduce((s, p) => s + p.length(), 0) / b.outer.length;
  out.buildings.sort((a, b) => dist(a) - dist(b));
  out.buildings = out.buildings.slice(0, MAX_BUILDINGS);

  out.counts = {
    roads: out.roads.length,
    paths: out.paths.length,
    green: out.green.length,
    buildings: out.buildings.length,
  };
  return out;
}

function buildingHeight(t, outer) {
  const h = parseFloat(t.height ?? t["building:height"]);
  if (h > 0) return h;
  const levels = parseFloat(t["building:levels"]);
  if (levels > 0) return levels * LEVEL_HEIGHT + (t["roof:levels"] ? 1.5 : 0);
  // No tag: deterministic pseudo-random 2-4 storeys so reloads match.
  const seed = Math.abs(Math.sin(outer[0].x * 12.9898 + outer[0].y * 78.233) * 43758.5453) % 1;
  return (2 + Math.floor(seed * 3)) * LEVEL_HEIGHT;
}

// ---------------------------------------------------------------- geometry

const ROAD_STYLE = { color: 0x1d1d1b, y: 0.3 };
const PATH_STYLE = { color: 0xd4542b, y: 0.3 };

function buildGround(radius) {
  const R = radius * 1.15;
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(R, 96).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0xf6f5f0 })
  );
  disc.receiveShadow = true;
  siteGroup.add(disc);

  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 129 }, (_, i) => new THREE.Vector3(Math.cos((i / 128) * Math.PI * 2) * radius, 0.2, Math.sin((i / 128) * Math.PI * 2) * radius))
    ),
    new THREE.LineBasicMaterial({ color: 0x9a978d })
  );
  siteGroup.add(ring);

  scene.fog = new THREE.Fog(SKY, radius * 2.2, radius * 5);
  sun.position.set(radius * 0.9, radius * 1.4, radius * 0.5);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -R;
  sun.shadow.camera.right = sun.shadow.camera.top = R;
  sun.shadow.camera.far = radius * 4;
  sun.shadow.camera.updateProjectionMatrix();
}

function buildLines(items, style) {
  const g = new THREE.Group();
  const verts = [];
  for (const { pts } of items) {
    for (let i = 0; i < pts.length - 1; i++) {
      verts.push(pts[i].x, style.y, -pts[i].y, pts[i + 1].x, style.y, -pts[i + 1].y);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: style.color })));
  return g;
}

const toShape = (outer, holes = []) => {
  const shape = new THREE.Shape(outer);
  for (const h of holes) shape.holes.push(new THREE.Path(h));
  return shape;
};

function buildGreen(items) {
  const g = new THREE.Group();
  const mats = {
    green: { fill: new THREE.MeshBasicMaterial({ color: 0xd3dfc0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 }), line: 0x7f9a5c },
    water: { fill: new THREE.MeshBasicMaterial({ color: 0xc4d8e4, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 }), line: 0x6f9bb5 },
  };
  const lineVerts = { green: [], water: [] };

  for (const item of items) {
    if (item.line) {
      for (let i = 0; i < item.line.length - 1; i++) {
        const a = item.line[i], b = item.line[i + 1];
        lineVerts.water.push(a.x, 0.25, -a.y, b.x, 0.25, -b.y);
      }
      continue;
    }
    try {
      const geo = new THREE.ShapeGeometry(toShape(item.outer, item.holes));
      geo.rotateX(-Math.PI / 2); // shape (x, north) -> world (x, up, -north)
      const mesh = new THREE.Mesh(geo, mats[item.kind].fill);
      mesh.position.y = 0.05;
      mesh.receiveShadow = true;
      g.add(mesh);
    } catch { /* skip degenerate polygon */ }

    for (const ring of [item.outer, ...item.holes]) {
      for (let i = 0; i < ring.length - 1; i++) {
        lineVerts[item.kind].push(ring[i].x, 0.2, -ring[i].y, ring[i + 1].x, 0.2, -ring[i + 1].y);
      }
    }
  }

  for (const kind of ["green", "water"]) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(lineVerts[kind], 3));
    g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: mats[kind].line })));
  }
  return g;
}

// All massings share one mesh and all their outlines one line set (two draw calls).
// Each vertex carries its building's start delay, and the vertex shader scales it
// up from the ground, so buildings still rise nearest-first.
const RISE_SECONDS = 0.7;
const riseUniform = { value: 0 };
let riseStart = 0;
let riseEnd = 0; // seconds after riseStart when the last building has finished

function withRise(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRise = riseUniform;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aDelay;\nuniform float uRise;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        float rp = clamp((uRise - aDelay) / ${RISE_SECONDS.toFixed(1)}, 0.0, 1.0);
        transformed.y *= max(1.0 - pow(1.0 - rp, 3.0), 0.001);`
      );
  };
  material.customProgramCacheKey = () => "rise";
  return material;
}

function setDelay(geo, delay) {
  const n = geo.attributes.position.count;
  geo.setAttribute("aDelay", new THREE.Float32BufferAttribute(new Float32Array(n).fill(delay), 1));
}

function buildBuildings(items) {
  const g = new THREE.Group();
  const solids = [];
  const edges = [];
  let maxDelay = 0;

  for (const b of items) {
    let geo;
    try {
      geo = new THREE.ExtrudeGeometry(toShape(b.outer, b.holes), { depth: b.height, bevelEnabled: false });
    } catch { continue; }
    geo.rotateX(-Math.PI / 2); // extrusion axis -> up, shape y (north) -> -z
    geo.deleteAttribute("uv"); // not needed, and merging requires matching attributes
    geo.clearGroups();

    const delay = b.outer[0].length() * 0.006;
    maxDelay = Math.max(maxDelay, delay);
    const outline = new THREE.EdgesGeometry(geo, 30);
    setDelay(geo, delay);
    setDelay(outline, delay);
    solids.push(geo);
    edges.push(outline);
  }
  if (!solids.length) return g;

  const mesh = new THREE.Mesh(mergeGeometries(solids), withRise(new THREE.MeshLambertMaterial({ color: 0xffffff })));
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.customDepthMaterial = withRise(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }));
  const lines = new THREE.LineSegments(mergeGeometries(edges), withRise(new THREE.LineBasicMaterial({ color: 0x3a3a36 })));
  g.add(mesh, lines);
  solids.forEach((s) => s.dispose());
  edges.forEach((e) => e.dispose());

  riseUniform.value = 0;
  riseStart = performance.now() + 400;
  riseEnd = maxDelay + RISE_SECONDS;
  return g;
}

function runRise(now) {
  if (!riseEnd) return;
  const t = Math.max(0, (now - riseStart) / 1000);
  riseUniform.value = t;
  if (t > riseEnd) riseEnd = 0; // done: uniform stays past every delay
}

function buildMarker(radius) {
  const g = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: 0xd4542b });
  const s = Math.max(radius * 0.03, 6);
  const circle = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 49 }, (_, i) => new THREE.Vector3(Math.cos((i / 48) * Math.PI * 2) * s, 0.5, Math.sin((i / 48) * Math.PI * 2) * s))
    ),
    mat
  );
  const pole = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, s * 5, 0)]),
    mat
  );
  g.add(circle, pole);
  return g;
}

function frameCamera(radius) {
  camera.far = radius * 12;
  camera.updateProjectionMatrix();
  camera.position.set(radius * 0.9, radius * 0.75, radius * 0.9);
  controls.target.set(0, 0, 0);
  controls.minDistance = 20;
  controls.maxDistance = radius * 4;
  controls.update();
}

// ---------------------------------------------------------------- drawing roads & paths

// Drawn lines are kept in world coordinates (x, z in metres, y = 0).
const DRAW_STYLE = {
  road: { width: 8, color: 0x1d1d1b, fill: 0x8f8d86, label: "Road" },
  path: { width: 2.5, color: 0xd4542b, fill: 0xe9a58e, label: "Path" },
};
let userLines = []; // { kind, pts: Vector3[] }
let drawKind = null;
let draftPts = [];
let cursor = null;
let draftObj = null;
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function groundPoint(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const p = new THREE.Vector3();
  return raycaster.ray.intersectPlane(ground, p) ? p : null;
}

function startDrawing(kind) {
  finishLine(); // commit anything in progress before switching tools
  drawKind = kind;
  document.body.classList.add("drawing");
  document.querySelectorAll("[data-draw]").forEach((b) => b.classList.toggle("on", b.dataset.draw === kind));
}

function stopDrawing() {
  drawKind = null;
  draftPts = [];
  cursor = null;
  updateDraft();
  document.body.classList.remove("drawing");
  document.querySelectorAll("[data-draw]").forEach((b) => b.classList.remove("on"));
}

function finishLine() {
  if (drawKind && draftPts.length >= 2) {
    userLines.push({ kind: drawKind, pts: draftPts });
    renderDrawn();
  }
  draftPts = [];
  updateDraft();
}

function updateDraft() {
  if (draftObj) {
    draftObj.geometry.dispose();
    draftObj.material.dispose();
    scene.remove(draftObj);
    draftObj = null;
  }
  if (!drawKind || !draftPts.length) return;
  const pts = (cursor ? [...draftPts, cursor] : draftPts).map((p) => new THREE.Vector3(p.x, 0.8, p.z));
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  draftObj = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: DRAW_STYLE[drawKind].color, dashSize: 3, gapSize: 2 }));
  draftObj.computeLineDistances();
  scene.add(draftObj);
}

// A flat ribbon of the road/path width along the polyline, plus a centreline.
function ribbonGeometry(pts, width) {
  const pos = [];
  const h = width / 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * h, nz = (dx / len) * h;
    pos.push(
      a.x + nx, 0, a.z + nz, a.x - nx, 0, a.z - nz, b.x + nx, 0, b.z + nz,
      a.x - nx, 0, a.z - nz, b.x - nx, 0, b.z - nz, b.x + nx, 0, b.z + nz
    );
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return geo;
}

function renderDrawn() {
  const g = layers.drawn;
  if (!g) return;
  for (const c of [...g.children]) {
    c.geometry?.dispose();
    c.material?.dispose();
    g.remove(c);
  }
  for (const { kind, pts } of userLines) {
    const s = DRAW_STYLE[kind];
    const ribbon = new THREE.Mesh(
      ribbonGeometry(pts, s.width),
      new THREE.MeshBasicMaterial({ color: s.fill, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 })
    );
    ribbon.position.y = 0.3;
    const centre = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p.x, 0.5, p.z))),
      new THREE.LineBasicMaterial({ color: s.color })
    );
    g.add(ribbon, centre);
  }
  renderDrawnList();
}

const lineLength = (pts) => pts.slice(1).reduce((s, p, i) => s + p.distanceTo(pts[i]), 0);

function renderDrawnList() {
  const ul = $("drawn-list");
  ul.innerHTML = "";
  const counts = { road: 0, path: 0 };
  userLines.forEach((l, i) => {
    const li = document.createElement("li");
    li.className = l.kind;
    li.innerHTML = `<span><i></i>${DRAW_STYLE[l.kind].label} ${++counts[l.kind]} · ${Math.round(lineLength(l.pts))} m</span>`;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "✕";
    del.title = "Delete";
    del.addEventListener("click", () => {
      userLines.splice(i, 1);
      renderDrawn();
    });
    li.append(del);
    ul.append(li);
  });
}

document.querySelectorAll("[data-draw]").forEach((b) =>
  b.addEventListener("click", () => (drawKind === b.dataset.draw ? (finishLine(), stopDrawing()) : startDrawing(b.dataset.draw)))
);

// Distinguish a click from an orbit drag.
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => (downAt = { x: e.clientX, y: e.clientY }));
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!drawKind || e.button !== 0 || !downAt) return;
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  const p = groundPoint(e);
  if (!p) return;
  const last = draftPts[draftPts.length - 1];
  if (last && last.distanceTo(p) < 0.5) return; // second click of a double-click
  draftPts.push(p);
  updateDraft();
});
renderer.domElement.addEventListener("pointermove", (e) => {
  if (!drawKind || !draftPts.length) return;
  cursor = groundPoint(e);
  updateDraft();
});
renderer.domElement.addEventListener("dblclick", () => drawKind && finishLine());

addEventListener("keydown", (e) => {
  if (!drawKind || e.target.matches("input, textarea")) return;
  if (e.key === "Enter") finishLine();
  else if (e.key === "Backspace") {
    e.preventDefault();
    draftPts.pop();
    updateDraft();
  } else if (e.key === "Escape") {
    if (draftPts.length) {
      draftPts = [];
      updateDraft();
    } else stopDrawing();
  }
});

// ---------------------------------------------------------------- sun & wind analysis

let site = null; // { lat, lon, radius } of the generated context
const RAD = Math.PI / 180;
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

function makeLabel(text, size, color = "#1d1d1b") {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  ctx.fillStyle = color;
  ctx.font = "600 40px Helvetica, Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 32, 34);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false }));
  s.scale.set(size, size, 1);
  s.renderOrder = 12;
  return s;
}

function clearChildren(g) {
  for (const c of [...g.children]) {
    c.traverse((o) => {
      o.geometry?.dispose();
      o.material?.map?.dispose();
      o.material?.dispose?.();
    });
    g.remove(c);
  }
}

function initAnalysis(lat, lon, radius) {
  site = { lat, lon, radius };
  windState = null;
  sunPlaying = false;
  $("sun-play").textContent = "▶ Play day";
  $("wind-readout").textContent = "";

  layers.sun = new THREE.Group();
  layers.wind = new THREE.Group();
  layers.sun.visible = layers.wind.visible = false;
  siteGroup.add(layers.sun, layers.wind);

  // Sun: path group (rebuilt per date), marker, ray to the sun, compass labels.
  sunObjs = {
    path: new THREE.Group(),
    marker: new THREE.Mesh(new THREE.SphereGeometry(radius * 0.025, 24, 16), new THREE.MeshBasicMaterial({ color: 0xf2a33a, fog: false })),
    ray: new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xf2a33a })),
  };
  layers.sun.add(sunObjs.path, sunObjs.marker, sunObjs.ray);
  [["N", 0, -1], ["E", 1, 0], ["S", 0, 1], ["W", -1, 0]].forEach(([t, x, z]) => {
    const l = makeLabel(t, radius * 0.07, "#6d6b64");
    l.position.set(x * radius * 1.07, 2, z * radius * 1.07);
    layers.sun.add(l);
  });
  buildSunPath();
  updateSun();
}

// Show/hide the sun and wind panels, and switch lighting between the real sun and the default.
function syncAnalysis() {
  const sunOn = !!layers.sun?.visible;
  const windOn = !!layers.wind?.visible;
  $("sun-panel").classList.toggle("hidden", !sunOn);
  $("wind-panel").classList.toggle("hidden", !windOn);
  if (!sunOn) sunPlaying = false;
  updateSun();
  if (windOn) ensureWind();
}

// ---- sun

let sunObjs = null;
let sunPlaying = false;
const todayISO = new Date().toISOString().slice(0, 10);
$("sun-date").value = todayISO;

const sunDoy = () => {
  const [y, m, d] = ($("sun-date").value || todayISO).split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 864e5);
};

// Solar position from local solar time (no timezone or equation-of-time correction, good to ~15 min).
function sunPosition(lat, doy, hour) {
  const decl = 23.44 * RAD * Math.sin((2 * Math.PI * (284 + doy)) / 365);
  const H = (hour - 12) * 15 * RAD;
  const phi = lat * RAD;
  const alt = Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) + Math.PI; // from north, clockwise
  // World: x = east, y = up, z = -north.
  const vec = new THREE.Vector3(Math.cos(alt) * Math.sin(az), Math.sin(alt), -Math.cos(alt) * Math.cos(az));
  return { alt, az, vec };
}

// Hours of local solar time at which the sun rises/sets, or null for polar day/night.
function sunTimes(lat, doy) {
  const decl = 23.44 * RAD * Math.sin((2 * Math.PI * (284 + doy)) / 365);
  const c = -Math.tan(lat * RAD) * Math.tan(decl);
  if (c >= 1) return { polar: "night" };
  if (c <= -1) return { polar: "day" };
  const h0 = Math.acos(c) / (15 * RAD);
  return { rise: 12 - h0, set: 12 + h0 };
}

const hhmm = (h) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60) % 60).padStart(2, "0")}`;

function pathPoints(doy, dist) {
  const pts = [];
  for (let h = 0; h <= 24; h += 0.1) {
    const s = sunPosition(site.lat, doy, h);
    if (s.alt > 0) pts.push(s.vec.clone().multiplyScalar(dist));
  }
  return pts;
}

function buildSunPath() {
  if (!sunObjs) return;
  clearChildren(sunObjs.path);
  const dist = site.radius * 0.95;
  const dash = site.radius * 0.02;

  for (const [doy, color] of [[172, 0xb08a1e], [80, 0x9a978d], [355, 0x6f9bb5]]) {
    const pts = pathPoints(doy, dist);
    if (pts.length < 2) continue;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color, dashSize: dash, gapSize: dash * 0.7 }));
    line.computeLineDistances();
    sunObjs.path.add(line);
  }

  const doy = sunDoy();
  const pts = pathPoints(doy, dist);
  if (pts.length > 1) sunObjs.path.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xd4542b })));
  const hourly = [];
  for (let h = 1; h < 24; h++) {
    const s = sunPosition(site.lat, doy, h);
    if (s.alt > 0) hourly.push(s.vec.clone().multiplyScalar(dist));
  }
  sunObjs.path.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(hourly), new THREE.PointsMaterial({ color: 0xd4542b, size: site.radius * 0.014 })));
}

function updateSun() {
  if (!site || !sunObjs) return;
  const on = layers.sun.visible;
  const hour = parseFloat($("sun-time").value);
  const doy = sunDoy();
  const s = sunPosition(site.lat, doy, hour);

  if (!on) {
    // Default studio lighting.
    sun.position.set(site.radius * 0.9, site.radius * 1.4, site.radius * 0.5);
    sun.intensity = 2.2;
    hemi.intensity = 1.4;
    return;
  }

  const dist = site.radius * 0.95;
  sunObjs.marker.visible = s.alt > 0;
  sunObjs.marker.position.copy(s.vec).multiplyScalar(dist);
  sunObjs.ray.visible = s.alt > 0;
  sunObjs.ray.geometry.setFromPoints([new THREE.Vector3(0, 0, 0), sunObjs.marker.position]);

  // Real sun drives the directional light, and so the shadows.
  const up = Math.max(0, Math.min(1, s.alt / (8 * RAD)));
  sun.position.copy(s.vec).multiplyScalar(site.radius * 1.6);
  sun.intensity = 2.4 * up;
  hemi.intensity = 0.35 + 1.05 * up;

  $("sun-time-out").textContent = hhmm(hour);
  const t = sunTimes(site.lat, doy);
  const day = t.polar ? (t.polar === "day" ? "Sun up all day" : "Sun never rises") : `Sunrise <b>${hhmm(t.rise)}</b> · Sunset <b>${hhmm(t.set)}</b><br>Daylight <b>${(t.set - t.rise).toFixed(1)} h</b>`;
  $("sun-readout").innerHTML =
    (s.alt > 0 ? `Altitude <b>${(s.alt / RAD).toFixed(0)}°</b> · Azimuth <b>${compass(s.az / RAD)} ${(s.az / RAD).toFixed(0)}°</b>` : "Sun below horizon") +
    `<br>${day}<br><span class="note">Local solar time</span>`;
}

function tickSun(dt) {
  if (!sunPlaying || !layers.sun?.visible) return;
  const t = sunTimes(site.lat, sunDoy());
  const [from, to] = t.polar ? [0, 24] : [t.rise, t.set];
  let h = parseFloat($("sun-time").value) + dt * (to - from) / 10; // sweep the daylight in ~10 s
  if (h > to || h < from) h = from;
  $("sun-time").value = h;
  updateSun();
}

$("sun-time").addEventListener("input", updateSun);
$("sun-date").addEventListener("change", () => {
  buildSunPath();
  updateSun();
});
$("sun-play").addEventListener("click", () => {
  sunPlaying = !sunPlaying;
  $("sun-play").textContent = sunPlaying ? "❚❚ Pause" : "▶ Play day";
});

// ---- wind

let windState = null; // { raw, stats, streaks }
const windRaw = new Map(); // site key -> hourly series
const SEASONS = { all: null, djf: [12, 1, 2], mam: [3, 4, 5], jja: [6, 7, 8], son: [9, 10, 11] };

async function fetchWind(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (windRaw.has(key)) return windRaw.get(key);
  const y = new Date().getFullYear() - 1; // last full year of reanalysis data
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&start_date=${y}-01-01&end_date=${y}-12-31&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=GMT`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wind service responded ${res.status}`);
  const j = await res.json();
  const raw = {
    speed: j.hourly.wind_speed_10m,
    dir: j.hourly.wind_direction_10m,
    month: j.hourly.time.map((t) => parseInt(t.slice(5, 7), 10)),
    year: y,
  };
  windRaw.set(key, raw);
  return raw;
}

// Meteorological convention: direction is where the wind comes FROM, degrees clockwise from north.
function windStats(raw, months) {
  const bins = Array.from({ length: 16 }, () => ({ n: 0, sum: 0 }));
  let n = 0, sum = 0, calm = 0;
  for (let i = 0; i < raw.speed.length; i++) {
    const v = raw.speed[i], d = raw.dir[i];
    if (v == null || d == null || (months && !months.includes(raw.month[i]))) continue;
    n++;
    sum += v;
    if (v < 0.5) { calm++; continue; }
    const b = bins[Math.round(d / 22.5) % 16];
    b.n++;
    b.sum += v;
  }
  const out = bins.map((b) => ({ freq: n ? b.n / n : 0, mean: b.n ? b.sum / b.n : 0 }));
  const top = out.reduce((best, b, i) => (b.freq > out[best].freq ? i : best), 0);
  return { n, mean: n ? sum / n : 0, calm: n ? calm / n : 0, bins: out, top, from: top * 22.5 };
}

async function ensureWind() {
  if (!site || windState) return;
  const s = site;
  $("wind-readout").textContent = "Loading wind data…";
  try {
    const raw = await fetchWind(s.lat, s.lon);
    if (site !== s) return; // site changed while loading
    windState = { raw, stats: null, streaks: null };
    refreshWind();
  } catch (e) {
    if (site === s) $("wind-readout").textContent = `Couldn't load wind data (${e.message}).`;
  }
}

function refreshWind() {
  if (!windState) return;
  const st = windStats(windState.raw, SEASONS[$("wind-season").value]);
  windState.stats = st;
  buildWind();
  const top = st.bins[st.top];
  $("wind-readout").innerHTML =
    `Prevailing from <b>${compass(st.from)} (${st.from.toFixed(0)}°)</b><br>` +
    `<b>${(top.freq * 100).toFixed(0)}%</b> of hours, avg <b>${top.mean.toFixed(1)} m/s</b><br>` +
    `Average speed <b>${st.mean.toFixed(1)} m/s</b> (${(st.mean * 3.6).toFixed(0)} km/h)<br>` +
    `Calm <b>${(st.calm * 100).toFixed(0)}%</b><br>` +
    `<span class="note">${windState.raw.year} hourly reanalysis at 10 m, regional not on-site. Rose points to where wind comes from.</span>`;
}

// Downwind unit vector in world (x, z): wind from θ blows toward θ + 180°.
const downwind = (fromDeg) => [-Math.sin(fromDeg * RAD), Math.cos(fromDeg * RAD)];

const STREAKS = 450;

function buildWind() {
  const g = layers.wind;
  clearChildren(g);
  const R = site.radius;
  const st = windState.stats;

  // Wind rose at the site centre: petal length = share of hours, colour = average speed.
  const roseR = R * 0.28;
  const maxFreq = Math.max(...st.bins.map((b) => b.freq), 1e-6);
  const slow = new THREE.Color(0xbcd4e6), fast = new THREE.Color(0x1f4e79);
  const pos = [], col = [];
  st.bins.forEach((b, i) => {
    if (!b.freq) return;
    const len = roseR * (b.freq / maxFreq);
    const c = slow.clone().lerp(fast, Math.min(b.mean / 8, 1));
    const a0 = (i * 22.5 - 9) * RAD, a1 = (i * 22.5 + 9) * RAD;
    const at = (a, l) => [Math.sin(a) * l, 1.5, -Math.cos(a) * l]; // from-direction: x = east, z = -north
    const steps = 4;
    for (let k = 0; k < steps; k++) {
      const p = a0 + ((a1 - a0) * k) / steps, q = a0 + ((a1 - a0) * (k + 1)) / steps;
      pos.push(0, 1.5, 0, ...at(p, len), ...at(q, len));
      for (let j = 0; j < 3; j++) col.push(c.r, c.g, c.b);
    }
  });
  const roseGeo = new THREE.BufferGeometry();
  roseGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  roseGeo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const rose = new THREE.Mesh(roseGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthTest: false }));
  rose.renderOrder = 10;
  g.add(rose);

  for (const f of [0.5, 1]) {
    const ring = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(Array.from({ length: 65 }, (_, i) => new THREE.Vector3(Math.cos((i / 64) * Math.PI * 2) * roseR * f, 1.5, Math.sin((i / 64) * Math.PI * 2) * roseR * f))),
      new THREE.LineBasicMaterial({ color: 0x6d6b64, transparent: true, opacity: 0.6, depthTest: false })
    );
    ring.renderOrder = 11;
    g.add(ring);
  }
  const n = makeLabel("N", R * 0.06, "#1f4e79");
  n.position.set(0, 2, -roseR * 1.15);
  g.add(n);

  // Streaks drifting downwind at the average speed.
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(STREAKS * 6), 3));
  const colors = new Float32Array(STREAKS * 6);
  const head = new THREE.Color(0x2b6cb0), tail = SKY;
  for (let i = 0; i < STREAKS; i++) {
    colors.set([tail.r, tail.g, tail.b, head.r, head.g, head.b], i * 6);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
  lines.frustumCulled = false;
  g.add(lines);

  const Rd = R * 1.05;
  const xz = new Float32Array(STREAKS * 2);
  const y = new Float32Array(STREAKS);
  for (let i = 0; i < STREAKS; i++) {
    const r = Rd * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
    xz[i * 2] = Math.cos(a) * r;
    xz[i * 2 + 1] = Math.sin(a) * r;
    y[i] = 3 + Math.random() * 45;
  }
  windState.streaks = { geo, xz, y, Rd };
}

function tickWind(dt) {
  const w = windState;
  if (!w?.streaks || !layers.wind?.visible) return;
  const { geo, xz, y, Rd } = w.streaks;
  const [dx, dz] = downwind(w.stats.from);
  const v = w.stats.mean * 4; // scene m/s: exaggerated so drift is visible
  const len = 8 + w.stats.mean * 4;
  const p = geo.attributes.position.array;
  const baseA = Math.atan2(-dz, -dx); // upwind direction

  for (let i = 0; i < STREAKS; i++) {
    let x = xz[i * 2] + dx * v * dt;
    let z = xz[i * 2 + 1] + dz * v * dt;
    if (x * x + z * z > Rd * Rd) {
      const a = baseA + (Math.random() - 0.5) * Math.PI;
      x = Math.cos(a) * Rd;
      z = Math.sin(a) * Rd;
      y[i] = 3 + Math.random() * 45;
    }
    xz[i * 2] = x;
    xz[i * 2 + 1] = z;
    p.set([x - dx * len, y[i], z - dz * len, x, y[i], z], i * 6);
  }
  geo.attributes.position.needsUpdate = true;
}

$("wind-season").addEventListener("change", refreshWind);

// ---------------------------------------------------------------- saved sites

let currentData = null; // map data of the site on screen
let currentSave = null; // { id, name } once the site has been saved or loaded

const idbRequest = (rq) =>
  new Promise((resolve, reject) => {
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });

function captureState() {
  const layerState = {};
  document.querySelectorAll("[data-layer]").forEach((b) => (layerState[b.dataset.layer] = b.checked));
  return {
    layers: layerState,
    userLines: userLines.map((l) => ({ kind: l.kind, pts: l.pts.map((p) => [p.x, p.z]) })),
    sun: { date: $("sun-date").value, time: parseFloat($("sun-time").value) },
    windSeason: $("wind-season").value,
    camera: { pos: camera.position.toArray(), target: controls.target.toArray() },
  };
}

function applyState(s) {
  if (!s) return;
  document.querySelectorAll("[data-layer]").forEach((b) => {
    const v = s.layers?.[b.dataset.layer];
    if (v === undefined) return;
    b.checked = v;
    if (layers[b.dataset.layer]) layers[b.dataset.layer].visible = v;
  });
  userLines = (s.userLines || []).map((l) => ({ kind: l.kind, pts: l.pts.map(([x, z]) => new THREE.Vector3(x, 0, z)) }));
  renderDrawn();
  if (s.sun?.date) {
    $("sun-date").value = s.sun.date;
    $("sun-time").value = s.sun.time;
    buildSunPath();
  }
  if (s.windSeason) $("wind-season").value = s.windSeason;
  syncAnalysis();
  if (s.camera) {
    camera.position.fromArray(s.camera.pos);
    controls.target.fromArray(s.camera.target);
    controls.update();
  }
}

async function saveCurrent() {
  if (!siteGroup || !site || !currentData) return;
  const name = $("save-name").value.trim() || `Site ${site.lat.toFixed(4)}, ${site.lon.toFixed(4)}`;
  const id = currentSave?.id ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const meta = { id, name, lat: site.lat, lon: site.lon, radius: site.radius, savedAt: Date.now(), state: captureState() };
  try {
    const db = await openCache();
    const tx = db.transaction(["sites", "siteData"], "readwrite");
    tx.objectStore("sites").put(meta, id);
    tx.objectStore("siteData").put(currentData, id);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    currentSave = { id, name };
    $("save-status").textContent = `Saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Find it on the start screen.`;
  } catch (e) {
    console.error(e);
    $("save-status").textContent = "Couldn't save (browser storage unavailable or full).";
  }
}

async function loadSite(id) {
  const db = await openCache();
  const [meta, data] = await Promise.all([
    idbRequest(db.transaction("sites").objectStore("sites").get(id)),
    idbRequest(db.transaction("siteData").objectStore("siteData").get(id)),
  ]);
  if (!meta || !data) throw new Error("That saved site is missing its data.");
  return { ...meta, data };
}

async function deleteSite(id) {
  const db = await openCache();
  const tx = db.transaction(["sites", "siteData"], "readwrite");
  tx.objectStore("sites").delete(id);
  tx.objectStore("siteData").delete(id);
  await new Promise((resolve) => (tx.oncomplete = tx.onerror = tx.onabort = resolve));
}

async function renderSaved() {
  const box = $("saved");
  const ul = $("saved-list");
  let sites = [];
  try {
    const db = await openCache();
    sites = await idbRequest(db.transaction("sites").objectStore("sites").getAll());
  } catch { /* storage unavailable: just show no saved sites */ }
  sites.sort((a, b) => b.savedAt - a.savedAt);
  box.classList.toggle("hidden", !sites.length);
  ul.innerHTML = "";

  for (const s of sites) {
    const li = document.createElement("li");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "open";
    const title = document.createElement("b");
    title.textContent = s.name;
    const sub = document.createElement("span");
    sub.textContent = `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)} · ${s.radius} m · ${new Date(s.savedAt).toLocaleDateString()}`;
    open.append(title, sub);
    open.addEventListener("click", async () => {
      try {
        const rec = await loadSite(s.id);
        generate(rec.lat, rec.lon, rec.radius, rec);
      } catch (e) {
        $("form-error").textContent = e.message;
      }
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.textContent = "✕";
    del.title = "Delete saved site";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete "${s.name}"? This can't be undone.`)) return;
      await deleteSite(s.id);
      renderSaved();
    });
    li.append(open, del);
    ul.append(li);
  }
}

$("save-site").addEventListener("click", saveCurrent);
renderSaved();

function showStats(f) {
  $("stats").innerHTML =
    `<b>${f.counts.buildings}</b> buildings<br>` +
    `<b>${f.counts.roads}</b> road segments<br>` +
    `<b>${f.counts.paths}</b> paths<br>` +
    `<b>${f.counts.green}</b> green / water areas`;
}
