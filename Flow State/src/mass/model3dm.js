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
// with corner handles to scale it. This is the geometry the erosion modules carve.

// Rhino UnitSystem enum values and names -> metres per unit.
const UNIT_BY_ENUM = { 1: 1e-6, 2: 1e-3, 3: 1e-2, 4: 1, 5: 1e3, 6: 2.54e-8, 7: 2.54e-5, 8: 0.0254, 9: 0.3048, 10: 1609.344 };
const UNIT_BY_NAME = { microns: 1e-6, millimeters: 1e-3, centimeters: 1e-2, meters: 1, kilometers: 1e3, inches: 0.0254, feet: 0.3048, miles: 1609.344 };

let model = null; // { name, buffer, placement, size, scale, initial, handles, outline }
let modelDrag = null; // { startScale, startDist }
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
  emit("mass:changed", { mass: null });
}

// Reads a .3dm, restyles it as a white-model massing and drops it on the pin.
// `scale` restores a saved size; otherwise the size is chosen from the model's units.
export async function placeModel(buffer, name, scale = null) {
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

  model = { name, buffer, placement, size, scale: initial, initial, handles: [], outline: null };
  if (scale > 0) model.scale = scale;
  buildHandles();
  applyModelScale(model.scale);
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
    const h = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
    h.add(new THREE.LineSegments(new THREE.EdgesGeometry(h.geometry), new THREE.LineBasicMaterial({ color: 0xd4542b, depthTest: false })));
    h.renderOrder = 21;
    h.children[0].renderOrder = 22;
    layers.model.add(h);
    model.handles.push(h);
  }
}

function applyModelScale(s) {
  const R = state.site.radius;
  const horiz = Math.max(model.size.x, model.size.z);
  s = Math.min(Math.max(s, 1 / horiz), (R * 2) / horiz); // between 1 m and twice the context radius
  model.scale = s;
  model.placement.scale.setScalar(s);

  const hx = (model.size.x * s) / 2, hz = (model.size.z * s) / 2, y = 0.6;
  const corners = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
  model.outline.geometry.setFromPoints(corners.map(([x, z]) => new THREE.Vector3(x, y, z)));
  model.handles.forEach((h, i) => h.position.set(corners[i][0], y, corners[i][1]));

  setModelMsg(
    `<b>${model.name}</b><br>${(model.size.x * s).toFixed(1)} × ${(model.size.z * s).toFixed(1)} m footprint · ${(model.size.y * s).toFixed(1)} m high<br>` +
      `Scale <b>×${(s / model.initial).toFixed(2)}</b>`
  );
  emit("mass:changed", { mass: getMassInfo() });
}

// Keep the corner handles a constant size on screen.
onFrame(() => {
  if (!model || !layers.model.visible) return;
  for (const h of model.handles) h.scale.setScalar(camera.position.distanceTo(h.position) * 0.018);
});

function pickHandle(e) {
  if (!model || !layers.model.visible) return null;
  return aimRay(e).intersectObjects(model.handles, false)[0]?.object ?? null;
}

// Capture-phase listeners so a handle drag takes priority over orbiting and line drawing.
const canvasEl = renderer.domElement;
canvasEl.addEventListener(
  "pointerdown",
  (e) => {
    if (e.button !== 0) return;
    const handle = pickHandle(e);
    const p = handle && groundPoint(e);
    if (!handle || !p) return;
    modelDrag = { startScale: model.scale, startDist: Math.max(Math.hypot(p.x, p.z), 0.01) };
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
      canvasEl.style.cursor = pickHandle(e) ? "nwse-resize" : "";
      return;
    }
    const p = groundPoint(e);
    if (p) applyModelScale((modelDrag.startScale * Math.hypot(p.x, p.z)) / modelDrag.startDist);
    e.stopImmediatePropagation();
  },
  true
);
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
  capture: () => (model ? { name: model.name, scale: model.scale } : null),
  restore: async (saved, extras) => {
    if (saved && extras.modelBuffer) await placeModel(extras.modelBuffer, saved.name ?? "model.3dm", saved.scale);
  },
});
