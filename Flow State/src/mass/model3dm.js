import * as THREE from "three";
import { Rhino3dmLoader } from "three/addons/loaders/3DMLoader.js";
import { renderer, camera, controls, onFrame } from "../view/scene.js";
import { aimRay, groundPoint } from "../view/pick.js";
import { state, layers } from "../core/state.js";
import { on, emit } from "../core/events.js";
import { $ } from "../core/dom.js";
import { registerPersist } from "../core/persist.js";

// The starting massings: one or more Rhino .3dm files dropped on the site, restyled as white-model massings. One of them is
// selected at a time; it has a gumball to move and turn it and corner points to scale it (shown while "Manipulate" is ticked).
// Together they are "the mass" the erosion modules carve and the wind flows round: they all sit under one group, so the gaps
// between them are simply open air.

// Rhino UnitSystem enum values and names -> metres per unit.
const UNIT_BY_ENUM = { 1: 1e-6, 2: 1e-3, 3: 1e-2, 4: 1, 5: 1e3, 6: 2.54e-8, 7: 2.54e-5, 8: 0.0254, 9: 0.3048, 10: 1609.344 };
const UNIT_BY_NAME = { microns: 1e-6, millimeters: 1e-3, centimeters: 1e-2, meters: 1, kilometers: 1e3, inches: 0.0254, feet: 0.3048, miles: 1609.344 };

let models = []; // [{ name, buffer, placement, size, scale, initial }]
let model = null; // the selected one of `models` (null only when there are none)
let massRoot = null; // the group (under layers.model) holding every massing's placement, and nothing else
let ui = null; // { outline, handles, gumball }: the manipulation controls, shared, put on the selected massing
let manipulating = false;
let modelDrag = null; // { part, start, scale, rotation, x, z, distance, angle }: the state when a drag began
let rhinoLoader = null;

const MODEL_MAT = new THREE.MeshLambertMaterial({ color: 0xffd9c9, side: THREE.DoubleSide });
const MODEL_EDGE = new THREE.LineBasicMaterial({ color: 0x7a2a12 });
const MODEL_LINE = new THREE.LineBasicMaterial({ color: 0xd4542b });

// ---- public API for other modules

// All the placed massings as one mass, or null. `object` is a THREE.Group holding every massing, each already scaled and
// positioned in world space (metres, base on y = 0); `bounds` is the world-space Box3 round all of them.
export function getMassInfo() {
  if (!models.length) return null;
  massRoot.updateMatrixWorld(true);
  const name = models.length === 1 ? models[0].name : `${models.length} massings`;
  return { name, object: massRoot, bounds: new THREE.Box3().setFromObject(massRoot), count: models.length };
}

// Raw file bytes, so a saved site can reload the massings. `files` is in the same order as the massings (see registerPersist
// below); copies of one massing share its bytes, which browser storage keeps only once.
export const getMassFile = () =>
  models.length
    ? { name: models[0].name, buffer: models[0].buffer, files: models.map((m) => ({ name: m.name, buffer: m.buffer })) }
    : null;

// ---- loading

const PARSE_TIMEOUT = 60000; // ms
const READER_FILES = "vendor/rhino3dm/";

// The loader runs the reader in a worker of its own and does not listen for the worker failing, so a worker that cannot start or
// that dies leaves the read waiting for ever. Every worker made while this module is in use is watched here: a failure is
// reported at once, and the number started is kept for the diagnosis below.
let workersStarted = 0;
let onWorkerFailed = null; // set while a read is waiting
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(...args) {
    super(...args);
    workersStarted++;
    this.addEventListener("error", (e) => onWorkerFailed?.(e.message || "it could not start"));
  }
};

// What to tell the user (and the console) when the reader gave no answer: whether its files came, whether a worker started, and
// whether this browser can compile WebAssembly at all (the reader is WebAssembly).
async function diagnoseReader() {
  const notes = [];
  const files = performance.getEntriesByType("resource").filter((r) => /rhino3dm\.(js|wasm)/.test(r.name));
  notes.push(
    files.length
      ? `files: ${files.map((f) => `${f.name.split("/").pop()} ${Math.round(f.duration)} ms${f.responseStatus && f.responseStatus !== 200 ? ` HTTP ${f.responseStatus}` : ""}`).join(", ")}`
      : "files: never requested"
  );
  notes.push(`workers started: ${workersStarted}`);
  try {
    const t = performance.now();
    const bytes = await (await fetch(`${READER_FILES}rhino3dm.wasm`)).arrayBuffer();
    await Promise.race([WebAssembly.compile(bytes), new Promise((_, no) => setTimeout(() => no(new Error("took over 15 s")), 15000))]);
    notes.push(`WebAssembly compiles on the page (${Math.round(performance.now() - t)} ms)`);
  } catch (e) {
    notes.push(`WebAssembly failed: ${e?.message ?? e}`);
  }
  return notes.join("; ");
}

// If the reader stalls it never answers and never reports an error, so there is a limit: after it the reader is thrown away (so
// that the next try starts a fresh one) and the read fails with a message that says what was found out about why.
function parse3dm(buffer) {
  rhinoLoader ??= new Rhino3dmLoader().setLibraryPath(READER_FILES); // the reader's code, kept in the project (see vendor/rhino3dm/README.md)
  const loader = rhinoLoader;
  const discard = () => {
    if (rhinoLoader === loader) rhinoLoader = null;
    try { loader.dispose(); } catch { /* already gone */ }
  };
  // The loader transfers its input to a worker, so hand it a copy and keep ours for saving.
  return new Promise((resolve, reject) => {
    const done = (settle, value) => {
      clearTimeout(timer);
      onWorkerFailed = null;
      settle(value);
    };
    const timer = setTimeout(async () => {
      discard();
      const why = await diagnoseReader();
      console.error("Rhino reader gave no answer:", why);
      done(reject, new Error(`the Rhino reader did not answer within ${PARSE_TIMEOUT / 1000} s (${why})`));
    }, PARSE_TIMEOUT);
    onWorkerFailed = (message) => {
      discard();
      done(reject, new Error(`the Rhino reader's worker failed: ${message}`));
    };
    loader.parse(buffer.slice(0), (obj) => done(resolve, obj), (err) => done(reject, err));
  });
}

function unitFactor(obj) {
  let u = obj.userData?.settings?.modelUnitSystem;
  if (u && typeof u === "object") u = u.value ?? u.name;
  if (typeof u === "string") return UNIT_BY_NAME[u.toLowerCase()] ?? null;
  return UNIT_BY_ENUM[u] ?? null;
}

function setModelMsg(text, isError = false) {
  const el = $("model-info");
  el.classList.toggle("hidden", !text);
  el.style.color = isError ? "#b3261e" : "";
  el.innerHTML = text;
}

const emitChanged = () => emit("mass:changed", { mass: getMassInfo() });

function discard(entry) {
  massRoot?.remove(entry.placement);
  entry.placement.traverse((o) => o.geometry?.dispose()); // (a copy still using it simply sends it to the GPU again)
}

// Deletes one massing (the selected one unless told otherwise).
function removeModel(entry = model) {
  if (!entry) return;
  const at = models.indexOf(entry);
  if (at < 0) return;
  discard(entry);
  models.splice(at, 1);
  modelDrag = null;
  controls.enabled = true;
  if (entry === model) model = models[Math.min(at, models.length - 1)] ?? null;
  refresh();
  emitChanged();
}

function removeAll() {
  if (!models.length) return;
  models.forEach(discard);
  models = [];
  model = null;
  modelDrag = null;
  controls.enabled = true;
  refresh();
  emitChanged();
}

// Choosing another massing only moves the controls: the mass itself has not changed.
function selectModel(entry) {
  if (!entry || entry === model) return;
  model = entry;
  refresh();
}

// Reads a .3dm, restyles it as a white-model massing and adds it to the site. The first lands on the pin; later ones land
// beside what is already there. `scale` and `pose` ({ x, z, rot }) restore a saved size and position; otherwise the size is
// chosen from the model's units. Files are read one at a time (the reader reports failures to whoever is waiting).
let queue = Promise.resolve();
export function placeModel(buffer, name, scale = null, pose = null) {
  const site = state.siteGroup;
  const next = queue.then(() => (site && state.siteGroup === site ? readAndPlace(buffer, name, scale, pose, site) : undefined));
  queue = next.catch(() => {});
  return next;
}

async function readAndPlace(buffer, name, scale, pose, site) {
  if (!layers.model) return;
  setModelMsg(`Reading ${name}…`);
  let obj;
  try {
    obj = await parse3dm(buffer);
  } catch (e) {
    console.error(e);
    setModelMsg(`Couldn't read that file (${e?.message ?? e}).`, true);
    return;
  }
  if (state.siteGroup !== site) return; // the site was closed while the file loaded

  // Drop hidden layers and points, and restyle everything else.
  const drop = [];
  obj.traverse((o) => {
    if (!o.visible || o.isPoints) drop.push(o);
    else if (o.isMesh) {
      o.geometry.attributes.normal || o.geometry.computeVertexNormals();
      o.material = MODEL_MAT;
      o.castShadow = o.receiveShadow = true;
      o.add(new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 30), MODEL_EDGE));
    } else if (o.isLine && !o.parent?.isMesh) o.material = MODEL_LINE;
  });
  drop.forEach((o) => o.parent?.remove(o));

  // Rhino is Z-up in model units; the scene is Y-up in metres.
  const inner = new THREE.Group();
  inner.add(obj);
  inner.rotation.x = -Math.PI / 2;
  const box = new THREE.Box3();
  const measure = (f) => {
    inner.scale.setScalar(f);
    inner.position.set(0, 0, 0);
    inner.updateMatrixWorld(true);
    return box.setFromObject(inner);
  };

  let f = unitFactor(obj);
  measure(f ?? 1);
  if (box.isEmpty()) {
    setModelMsg("That file has no visible geometry to place.", true);
    return;
  }
  if (f === null) f = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) > 1000 ? 0.001 : 1; // assume mm for huge values
  measure(f);
  const centre = box.getCenter(new THREE.Vector3());
  inner.position.set(-centre.x, -box.min.y, -centre.z); // centred on the pin, sitting on the ground
  inner.updateMatrixWorld(true);
  const size = box.getSize(new THREE.Vector3());

  const placement = new THREE.Group();
  placement.add(inner);

  // Fit absurd sizes (wrong units) to the site so the model is findable; the user can still resize.
  const R = state.site.radius;
  const horiz = Math.max(size.x, size.z, 1e-6);
  let initial = 1;
  if (horiz > R * 0.8) initial = (R * 0.3) / horiz;
  else if (horiz < R * 0.01) initial = (R * 0.05) / horiz;

  const entry = { name, buffer, placement, size, scale: clampScale(size, scale > 0 ? scale : initial), initial };
  placement.scale.setScalar(entry.scale);
  if (pose) {
    placement.position.set(pose.x ?? 0, 0, pose.z ?? 0);
    placement.rotation.y = pose.rot ?? 0;
  }
  addEntry(entry, !pose);
  if (!(scale > 0) && initial !== 1) setModelMsg(`${name}: units looked wrong, so it was resized to fit. Tick Manipulate and drag a corner to adjust.`);
}

// Moves a new massing clear of the ones already there: to their east, a street's width away.
function placeBeside(placement) {
  const others = getMassInfo()?.bounds;
  if (!others) return;
  placement.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(placement);
  const gap = Math.min(15, Math.max(4, 0.4 * (box.max.x - box.min.x)));
  placement.position.x += others.max.x + gap - box.min.x;
  placement.position.z += (model ? model.placement.position.z : 0) - placement.position.z;
}

function addEntry(entry, beside) {
  if (beside) placeBeside(entry.placement);
  massRoot.add(entry.placement);
  models.push(entry);
  model = entry;
  refresh();
  emitChanged();
}

// A second copy of the selected massing, with its size and turn, set down beside the others.
function duplicateModel() {
  if (!model) return;
  const placement = model.placement.clone(true);
  addEntry({ ...model, placement }, true);
}

// ---- scale handles

function buildHandles() {
  const outline = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xd4542b, depthTest: false }));
  outline.renderOrder = 20;
  outline.frustumCulled = false; // its points move from massing to massing
  layers.model.add(outline);

  const handles = [];
  for (let i = 0; i < 4; i++) {
    // An invisible sphere keeps the handle easy to grab; the small orange point inside it is what you see.
    const h = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), new THREE.MeshBasicMaterial({ color: 0xd4542b, depthTest: false }));
    dot.scale.setScalar(0.3);
    dot.renderOrder = 21;
    h.add(dot);
    h.userData.part = "scale";
    layers.model.add(h);
    handles.push(h);
  }
  const gumball = buildGumball();
  layers.model.add(gumball.group);
  ui = { outline, handles, gumball };
}

// The gumball: arrows to slide the mass east-west (red) and north-south (green), a square to slide it freely,
// and a ring (blue) to turn it about the vertical axis. Drawn on top of everything; picked through invisible stand-ins.
const GUMBALL = { east: 0xd23c3c, north: 0x3c9a4a, turn: 0x3c6ed2, free: 0xe0b040 };

function buildGumball() {
  const group = new THREE.Group(), pickers = [];
  const solid = (color) => new THREE.MeshBasicMaterial({ color, depthTest: false });
  const invisible = new THREE.MeshBasicMaterial({ visible: false });
  const show = (geometry, color) => {
    const mesh = new THREE.Mesh(geometry, solid(color));
    mesh.renderOrder = 25;
    group.add(mesh);
    return mesh;
  };
  const pick = (geometry, part) => {
    const mesh = new THREE.Mesh(geometry, invisible);
    mesh.userData.part = part;
    group.add(mesh);
    pickers.push(mesh);
    return mesh;
  };
  for (const [part, color, direction] of [["slide-x", GUMBALL.east, [1, 0, 0]], ["slide-z", GUMBALL.north, [0, 0, -1]]]) {
    const turnToAxis = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...direction));
    show(new THREE.CylinderGeometry(0.025, 0.025, 0.55, 8).translate(0, 0.5, 0), color).quaternion.copy(turnToAxis);
    show(new THREE.ConeGeometry(0.09, 0.25, 12).translate(0, 0.9, 0), color).quaternion.copy(turnToAxis);
    pick(new THREE.CylinderGeometry(0.1, 0.1, 1, 6).translate(0, 0.6, 0), part).quaternion.copy(turnToAxis);
  }
  show(new THREE.TorusGeometry(0.8, 0.02, 8, 64).rotateX(Math.PI / 2), GUMBALL.turn);
  pick(new THREE.TorusGeometry(0.8, 0.09, 6, 48).rotateX(Math.PI / 2), "turn");
  show(new THREE.BoxGeometry(0.2, 0.04, 0.2), GUMBALL.free);
  pick(new THREE.BoxGeometry(0.32, 0.2, 0.32), "slide");
  return { group, pickers };
}

// Manipulating shows the selected massing's scale box, corner points and gumball. Otherwise only the massings are drawn.
function setManipulating(on) {
  manipulating = on;
  $("model-manipulate").checked = on;
  if (!on) canvasEl.style.cursor = "";
  refresh();
}

const rad2deg = (r) => ((((r * 180) / Math.PI) % 360) + 360) % 360;

// Brings the panel and the manipulation controls up to date with the massings and the selection.
function refresh() {
  const show = manipulating && !!model;
  if (ui) {
    ui.outline.visible = show;
    ui.handles.forEach((h) => (h.visible = show));
    ui.gumball.group.visible = show;
  }
  $("model-actions").classList.toggle("hidden", !model);
  renderList();
  if (!model) {
    manipulating = false;
    $("model-manipulate").checked = false;
    canvasEl.style.cursor = "";
    setModelMsg("");
    return;
  }

  const { placement, size, scale: s } = model;
  const hx = (size.x * s) / 2, hz = (size.z * s) / 2, y = 0.6;
  const cos = Math.cos(placement.rotation.y), sin = Math.sin(placement.rotation.y);
  // Rotating about Y by r sends local (x, z) to (x cos r + z sin r, -x sin r + z cos r).
  const corners = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([x, z]) => [
    placement.position.x + x * cos + z * sin,
    placement.position.z - x * sin + z * cos,
  ]);
  ui.outline.geometry.setFromPoints(corners.map(([x, z]) => new THREE.Vector3(x, y, z)));
  ui.handles.forEach((h, i) => h.position.set(corners[i][0], y, corners[i][1]));
  ui.gumball.group.position.set(placement.position.x, y, placement.position.z);

  setModelMsg(
    `<b>${escapeHtml(model.name)}</b><br>${(size.x * s).toFixed(1)} × ${(size.z * s).toFixed(1)} m footprint · ${(size.y * s).toFixed(1)} m high<br>` +
      `Scale <b>×${(s / model.initial).toFixed(2)}</b> · turned <b>${rad2deg(-placement.rotation.y).toFixed(0)}°</b>`
  );
}

const escapeHtml = (text) => text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

// One button per massing; the selected one is marked.
function renderList() {
  $("model-list").replaceChildren(
    ...models.map((m, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = m === model ? "tool on" : "tool";
      b.textContent = `Massing ${i + 1} · ${m.name}`;
      b.setAttribute("aria-pressed", String(m === model));
      b.addEventListener("click", () => selectModel(m));
      return b;
    })
  );
}

// The selected massing moved, turned or changed size: tell everyone the mass changed.
function layout() {
  refresh();
  emitChanged();
}

function clampScale(size, s) {
  const R = state.site.radius;
  const horiz = Math.max(size.x, size.z, 1e-6);
  return Math.min(Math.max(s, 1 / horiz), (R * 2) / horiz); // between 1 m and twice the context radius
}

function applyModelScale(s) {
  model.scale = clampScale(model.size, s);
  model.placement.scale.setScalar(model.scale);
  layout();
}

// Keep the corner points and the gumball a constant size on screen.
onFrame(() => {
  if (!model || !manipulating || !layers.model.visible) return;
  for (const h of ui.handles) h.scale.setScalar(camera.position.distanceTo(h.position) * 0.018);
  ui.gumball.group.scale.setScalar(camera.position.distanceTo(ui.gumball.group.position) * 0.12);
});

// The part of the manipulation controls under the pointer: a corner point, or one of the gumball's pieces.
function pickPart(e) {
  if (!model || !manipulating || !layers.model.visible) return null;
  return aimRay(e).intersectObjects([...ui.handles, ...ui.gumball.pickers], false)[0]?.object.userData.part ?? null;
}

// The massing under the pointer, or null.
function pickModel(e) {
  if (!models.length || !layers.model?.visible) return null;
  const hit = aimRay(e).intersectObjects(models.map((m) => m.placement), true).find((h) => h.object.isMesh);
  if (!hit) return null;
  return models.find((m) => { let found = false; hit.object.traverseAncestors((a) => { if (a === m.placement) found = true; }); return found; }) ?? null;
}

const CURSORS = { scale: "nwse-resize", slide: "move", "slide-x": "ew-resize", "slide-z": "ns-resize", turn: "grab" };

// Capture-phase listeners so a drag on the controls takes priority over orbiting and line drawing.
const canvasEl = renderer.domElement;
canvasEl.addEventListener(
  "pointerdown",
  (e) => {
    if (e.button !== 0) return;
    const part = pickPart(e);
    const p = part && groundPoint(e);
    if (!part || !p) return;
    const { position, rotation } = model.placement;
    modelDrag = {
      part, start: p, scale: model.scale, rotation: rotation.y, x: position.x, z: position.z,
      distance: Math.max(Math.hypot(p.x - position.x, p.z - position.z), 0.01),
      angle: Math.atan2(p.z - position.z, p.x - position.x),
    };
    controls.enabled = false;
    canvasEl.setPointerCapture(e.pointerId);
    e.stopImmediatePropagation();
  },
  true
);
canvasEl.addEventListener(
  "pointermove",
  (e) => {
    if (!modelDrag) {
      canvasEl.style.cursor = CURSORS[pickPart(e)] ?? "";
      return;
    }
    const p = groundPoint(e);
    if (p) dragTo(p);
    e.stopImmediatePropagation();
  },
  true
);

function dragTo(p) {
  const d = modelDrag, { position, rotation } = model.placement;
  if (d.part === "scale") {
    applyModelScale((d.scale * Math.hypot(p.x - position.x, p.z - position.z)) / d.distance);
    return;
  }
  if (d.part === "turn") {
    // The angle the pointer sweeps about the centre turns the mass the opposite way in this coordinate system.
    rotation.y = d.rotation - (Math.atan2(p.z - position.z, p.x - position.x) - d.angle);
  } else {
    if (d.part !== "slide-z") position.x = d.x + (p.x - d.start.x);
    if (d.part !== "slide-x") position.z = d.z + (p.z - d.start.z);
  }
  layout();
}
const endDrag = (e) => {
  if (!modelDrag) return;
  modelDrag = null;
  controls.enabled = true;
  canvasEl.releasePointerCapture?.(e.pointerId);
  e.stopImmediatePropagation();
};
canvasEl.addEventListener("pointerup", endDrag, true);
canvasEl.addEventListener("pointercancel", endDrag, true);

// While manipulating, a click (not a drag, which orbits) on another massing selects it.
let pressed = null;
canvasEl.addEventListener("pointerdown", (e) => { pressed = e.button === 0 ? [e.clientX, e.clientY] : null; });
canvasEl.addEventListener("pointerup", (e) => {
  if (manipulating && pressed && Math.hypot(e.clientX - pressed[0], e.clientY - pressed[1]) < 5) selectModel(pickModel(e));
  pressed = null;
});

// ---- import by button or by dropping a file anywhere on the scene

async function importFiles(files) {
  if (!state.siteGroup || !files.length) return;
  const rhino = files.filter((f) => /\.3dm$/i.test(f.name));
  if (!rhino.length) {
    setModelMsg("Please choose a Rhino .3dm file.", true);
    return;
  }
  for (const file of rhino) await placeModel(await file.arrayBuffer(), file.name);
}

$("model-import").addEventListener("click", () => $("model-file").click());
$("model-file").addEventListener("change", (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  importFiles(files);
});
$("model-duplicate").addEventListener("click", duplicateModel);
$("model-reset").addEventListener("click", () => model && applyModelScale(model.initial));
$("model-remove").addEventListener("click", () => removeModel());
$("model-remove-all").addEventListener("click", () => {
  if (models.length < 2 || confirm(`Delete all ${models.length} massings?`)) removeAll();
});
$("model-manipulate").addEventListener("change", (e) => model && setManipulating(e.target.checked));
addEventListener("keydown", (e) => {
  if (e.key === "Delete" && model && !e.target.matches("input, textarea, select")) removeModel();
});

const hasFiles = (e) => e.dataTransfer?.types?.includes("Files");
let dragDepth = 0;
addEventListener("dragover", (e) => e.preventDefault()); // lets the drop through, and stops the browser opening the file
addEventListener("dragenter", (e) => {
  if (!state.siteGroup || !hasFiles(e)) return;
  dragDepth++;
  $("dropzone").classList.remove("hidden");
});
addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $("dropzone").classList.add("hidden");
  }
});
addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("dropzone").classList.add("hidden");
  importFiles([...(e.dataTransfer?.files ?? [])]);
});

// ---- lifecycle

on("site:built", () => {
  layers.model = new THREE.Group();
  state.siteGroup.add(layers.model);
  massRoot = new THREE.Group();
  layers.model.add(massRoot);
  buildHandles();
  refresh();
});

on("site:cleared", () => {
  models = [];
  model = null;
  massRoot = ui = null; // disposed with the site's group
  manipulating = false;
  modelDrag = null;
  controls.enabled = true;
  $("model-info").classList.add("hidden");
  $("model-actions").classList.add("hidden");
});

const savedState = (m) => ({ name: m.name, scale: m.scale, pose: { x: m.placement.position.x, z: m.placement.position.z, rot: m.placement.rotation.y } });

registerPersist("model", {
  capture: () => (models.length ? { items: models.map(savedState) } : null),
  // Not awaited: reading the files can take a while (or stall), and waiting for them would keep the loading screen up until they
  // answered, so the site opens first and each massing appears when it is read (the Model panel says "Reading…" meanwhile, or why
  // it could not be read). A site saved with a single massing holds just that massing's { name, scale, pose }.
  restore: (saved, extras) => {
    if (!saved) return;
    (saved.items ?? [saved]).forEach((item, i) => {
      const buffer = extras.modelFiles?.[i]?.buffer ?? (i === 0 ? extras.modelBuffer : null);
      if (!buffer) return;
      placeModel(buffer, item.name ?? "model.3dm", item.scale, item.pose).catch((e) => {
        console.error(e);
        setModelMsg(`Couldn't place ${escapeHtml(item.name ?? "the model")} (${escapeHtml(String(e?.message ?? e))}).`, true);
      });
    });
  },
});
