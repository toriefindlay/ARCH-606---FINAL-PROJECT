import * as THREE from "three";
import { Rhino3dmLoader } from "three/addons/loaders/3DMLoader.js";
import { renderer, camera, controls, onFrame } from "../view/scene.js";
import { aimRay, groundPoint } from "../view/pick.js";
import { clearChildren } from "../view/labels.js";
import { state, layers } from "../core/state.js";
import { on, emit } from "../core/events.js";
import { $ } from "../core/dom.js";
import { registerPersist } from "../core/persist.js";

// The starting mass: a Rhino .3dm dropped on the pin, restyled as a white-model massing,
// with a gumball to move and turn it and corner points to scale it (shown while "Manipulate" is ticked).
// This is the geometry the erosion modules carve.

// Rhino UnitSystem enum values and names -> metres per unit.
const UNIT_BY_ENUM = { 1: 1e-6, 2: 1e-3, 3: 1e-2, 4: 1, 5: 1e3, 6: 2.54e-8, 7: 2.54e-5, 8: 0.0254, 9: 0.3048, 10: 1609.344 };
const UNIT_BY_NAME = { microns: 1e-6, millimeters: 1e-3, centimeters: 1e-2, meters: 1, kilometers: 1e3, inches: 0.0254, feet: 0.3048, miles: 1609.344 };

let model = null; // { name, buffer, placement, size, scale, initial, handles, outline, gumball, manipulating }
let modelDrag = null; // { part, start, scale, rotation, x, z, distance, angle }: the state when a drag began
let rhinoLoader = null;

const MODEL_MAT = new THREE.MeshLambertMaterial({ color: 0xffd9c9, side: THREE.DoubleSide });
const MODEL_EDGE = new THREE.LineBasicMaterial({ color: 0x7a2a12 });
const MODEL_LINE = new THREE.LineBasicMaterial({ color: 0xd4542b });

// ---- public API for other modules

// The placed mass, or null. `object` is a THREE.Group already scaled and positioned in world
// space (metres, centred on the pin, base on y = 0); `bounds` is its world-space Box3.
export function getMassInfo() {
  if (!model) return null;
  model.placement.updateMatrixWorld(true);
  return { name: model.name, object: model.placement, bounds: new THREE.Box3().setFromObject(model.placement), scale: model.scale };
}

// Raw file bytes, so a saved site can reload the model.
export const getMassFile = () => (model ? { name: model.name, buffer: model.buffer } : null);

// ---- loading

function parse3dm(buffer) {
  rhinoLoader ??= new Rhino3dmLoader().setLibraryPath("https://cdn.jsdelivr.net/npm/rhino3dm@8.0.1/");
  // The loader transfers its input to a worker, so hand it a copy and keep ours for saving.
  return new Promise((resolve, reject) => rhinoLoader.parse(buffer.slice(0), resolve, reject));
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

function removeModel() {
  if (layers.model) clearChildren(layers.model);
  model = null;
  modelDrag = null;
  controls.enabled = true;
  setModelMsg("");
  $("model-actions").classList.add("hidden");
  $("model-manipulate").checked = false;
  emit("mass:changed", { mass: null });
}

// Reads a .3dm, restyles it as a white-model massing and drops it on the pin.
// `scale` and `pose` ({ x, z, rot }) restore a saved size and position; otherwise the size is chosen from the model's units.
export async function placeModel(buffer, name, scale = null, pose = null) {
  if (!state.siteGroup || !layers.model) return;
  setModelMsg(`Reading ${name}…`);
  let obj;
  try {
    obj = await parse3dm(buffer);
  } catch (e) {
    console.error(e);
    setModelMsg(`Couldn't read that file (${e?.message ?? e}).`, true);
    return;
  }
  if (!state.siteGroup) return; // site was closed while the file loaded

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

  removeModel();
  const placement = new THREE.Group();
  placement.add(inner);
  layers.model.add(placement);

  // Fit absurd sizes (wrong units) to the site so the model is findable; the user can still resize.
  const R = state.site.radius;
  const horiz = Math.max(size.x, size.z, 1e-6);
  let initial = 1;
  if (horiz > R * 0.8) initial = (R * 0.3) / horiz;
  else if (horiz < R * 0.01) initial = (R * 0.05) / horiz;

  model = { name, buffer, placement, size, scale: initial, initial, handles: [], outline: null, gumball: null, manipulating: false };
  if (scale > 0) model.scale = scale;
  if (pose) {
    placement.position.set(pose.x ?? 0, 0, pose.z ?? 0);
    placement.rotation.y = pose.rot ?? 0;
  }
  buildHandles();
  applyModelScale(model.scale);
  setManipulating(false);
  $("model-actions").classList.remove("hidden");
  if (!(scale > 0) && initial !== 1) setModelMsg(`${name}: units looked wrong, so it was resized to fit. Drag a corner to adjust.`);
}

// ---- scale handles

function buildHandles() {
  const outline = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xd4542b, depthTest: false }));
  outline.renderOrder = 20;
  layers.model.add(outline);
  model.outline = outline;

  for (let i = 0; i < 4; i++) {
    // An invisible sphere keeps the handle easy to grab; the small orange point inside it is what you see.
    const h = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), new THREE.MeshBasicMaterial({ color: 0xd4542b, depthTest: false }));
    dot.scale.setScalar(0.3);
    dot.renderOrder = 21;
    h.add(dot);
    h.userData.part = "scale";
    layers.model.add(h);
    model.handles.push(h);
  }
  model.gumball = buildGumball();
  layers.model.add(model.gumball.group);
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

// Manipulating shows the scale box, its corner points and the gumball. Otherwise only the model itself is drawn.
function setManipulating(on) {
  model.manipulating = on;
  model.outline.visible = on;
  model.handles.forEach((h) => (h.visible = on));
  model.gumball.group.visible = on;
  $("model-manipulate").checked = on;
  if (!on) canvasEl.style.cursor = "";
}

const rad2deg = (r) => ((((r * 180) / Math.PI) % 360) + 360) % 360;

// Puts the scale box, corner points and gumball where the mass is, and tells everyone the mass changed.
function layout() {
  const { placement, size, scale: s } = model;
  const hx = (size.x * s) / 2, hz = (size.z * s) / 2, y = 0.6;
  const cos = Math.cos(placement.rotation.y), sin = Math.sin(placement.rotation.y);
  // Rotating about Y by r sends local (x, z) to (x cos r + z sin r, -x sin r + z cos r).
  const corners = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([x, z]) => [
    placement.position.x + x * cos + z * sin,
    placement.position.z - x * sin + z * cos,
  ]);
  model.outline.geometry.setFromPoints(corners.map(([x, z]) => new THREE.Vector3(x, y, z)));
  model.handles.forEach((h, i) => h.position.set(corners[i][0], y, corners[i][1]));
  model.gumball.group.position.set(placement.position.x, y, placement.position.z);

  setModelMsg(
    `<b>${model.name}</b><br>${(size.x * s).toFixed(1)} × ${(size.z * s).toFixed(1)} m footprint · ${(size.y * s).toFixed(1)} m high<br>` +
      `Scale <b>×${(s / model.initial).toFixed(2)}</b> · turned <b>${rad2deg(-placement.rotation.y).toFixed(0)}°</b>`
  );
  emit("mass:changed", { mass: getMassInfo() });
}

function applyModelScale(s) {
  const R = state.site.radius;
  const horiz = Math.max(model.size.x, model.size.z);
  s = Math.min(Math.max(s, 1 / horiz), (R * 2) / horiz); // between 1 m and twice the context radius
  model.scale = s;
  model.placement.scale.setScalar(s);
  layout();
}

// Keep the corner points and the gumball a constant size on screen.
onFrame(() => {
  if (!model || !model.manipulating || !layers.model.visible) return;
  for (const h of model.handles) h.scale.setScalar(camera.position.distanceTo(h.position) * 0.018);
  model.gumball.group.scale.setScalar(camera.position.distanceTo(model.gumball.group.position) * 0.12);
});

// The part of the manipulation controls under the pointer: a corner point, or one of the gumball's pieces.
function pickPart(e) {
  if (!model || !model.manipulating || !layers.model.visible) return null;
  return aimRay(e).intersectObjects([...model.handles, ...model.gumball.pickers], false)[0]?.object.userData.part ?? null;
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

// ---- import by button or by dropping a file anywhere on the scene

async function importFile(file) {
  if (!state.siteGroup) return;
  if (!/\.3dm$/i.test(file.name)) {
    setModelMsg("Please choose a Rhino .3dm file.", true);
    return;
  }
  await placeModel(await file.arrayBuffer(), file.name);
}

$("model-import").addEventListener("click", () => $("model-file").click());
$("model-file").addEventListener("change", (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (f) importFile(f);
});
$("model-reset").addEventListener("click", () => model && applyModelScale(model.initial));
$("model-remove").addEventListener("click", removeModel);
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
  const f = e.dataTransfer?.files?.[0];
  if (f) importFile(f);
});

// ---- lifecycle

on("site:built", () => {
  layers.model = new THREE.Group();
  state.siteGroup.add(layers.model);
});

on("site:cleared", () => {
  model = null;
  modelDrag = null;
  controls.enabled = true;
  $("model-info").classList.add("hidden");
  $("model-actions").classList.add("hidden");
});

registerPersist("model", {
  capture: () =>
    model
      ? { name: model.name, scale: model.scale, pose: { x: model.placement.position.x, z: model.placement.position.z, rot: model.placement.rotation.y } }
      : null,
  restore: async (saved, extras) => {
    if (saved && extras.modelBuffer) await placeModel(extras.modelBuffer, saved.name ?? "model.3dm", saved.scale, saved.pose);
  },
});
