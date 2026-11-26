// CONTROLLER (render): the "Render view" button. It takes a copy of the project as it stands (massing, tunnels,
// circulation, facade, surroundings), builds the render scene from it, and runs the view's buttons. Nothing here changes the
// project: the render only looks at it.
import * as THREE from "three";
import { $ } from "../core/dom.js";
import { on } from "../core/events.js";
import { state } from "../core/state.js";
import { setPaused } from "../view/scene.js";
import { getMassInfo, hasRoundedMass } from "../mass/model3dm.js";
import { getFinishedTunnels, getShownMeshes } from "../erosion/exterior/index.js";
import { settings as exteriorSettings } from "../erosion/exterior/panel.js";
import { getCirculationPlan } from "../erosion/circulation/index.js";
import { createForm } from "../erosion/exterior/form.js";
import { getFacade } from "../facades/index.js";
import { getStructure } from "../structure/index.js";
import { buildStructureMeshes } from "../structure/view.js";
import { createMaterials, worldUV } from "./materials.js";
import { buildSurroundings } from "./surroundings.js";
import { buildDucts, buildLiners, buildFraming, buildOutline, placeEntrances, buildEntrances, clearEntrances } from "./systems.js";
import { createStudio } from "./studio.js";

let view = null; // { studio, parts, canvas, recorder }

const meshesUnder = (object) => {
  const out = [];
  object?.traverse((o) => o.isMesh && o.geometry?.attributes.position && out.push(o));
  return out;
};

function addMesh(group, source, material) {
  source.updateWorldMatrix(true, false);
  const geometry = worldUV(source.geometry, source.matrixWorld);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = mesh.receiveShadow = true;
  group.add(mesh);
  return geometry;
}

// Everything the render is made from, and what is missing from it.
function gather() {
  const mass = getMassInfo();
  if (!mass) return { wait: "Import a .3dm massing first." };
  const tunnels = getFinishedTunnels(), shown = getShownMeshes(), facade = getFacade();
  if (tunnels && shown.busy) return { wait: "The tunnels are still being redrawn: try again in a few seconds." };
  if (facade.pending) return { wait: "The facade panels are still being made: try again in a few seconds." };
  const plan = tunnels ? getCirculationPlan() : null;
  const structure = getStructure();
  if (structure.pending) return { wait: "The structure is still being planned: try again in a few seconds." };
  const missing = [];
  if (!tunnels) missing.push(exteriorSettings.erodeTunnels ? "wind tunnels (not finished yet)" : "wind tunnels");
  if (!plan) missing.push("circulation (turn it on under Circulation)");
  if (!facade.mesh) missing.push("facade (choose one under Facades)");
  const style = document.querySelector("#facade-styles button.on")?.dataset.facade;
  return { mass, tunnels, shown, facade, plan, style, structure, missing };
}

function build(studio, source) {
  const { mass, tunnels, shown, facade, plan, style } = source;
  const materials = createMaterials();
  const envelope = new THREE.Group(), interior = new THREE.Group();

  const placed = meshesUnder(mass.object);
  const skin = tunnels ? shown.skin : null;
  // The working view draws the skin in two pieces (the face, and what lies on the tunnels, split triangle by triangle). Here
  // they are one concrete surface, so that the reveals of the openings match the wall, with no ragged line between them.
  for (const m of skin ? [skin, shown.walls].filter(Boolean) : placed) addMesh(envelope, m, materials.concrete);
  // the metal of the ducts shows as a clean round liner, set back inside every opening
  if (tunnels && skin) {
    const shaped = !!skin.userData.shapesKey && !skin.userData.shapesKey.startsWith("tint");
    envelope.add(buildLiners(tunnels.network().edges, tunnels.openings(), shaped, materials));
  }
  // of the circulation, the whole building shows only its ground-floor entrances: the hallways and stairs would stand out
  // wherever the skin cuts across them
  const entrances = plan ? placeEntrances(plan, placed) : [];
  if (facade.mesh) {
    facade.mesh.updateWorldMatrix(true, false);
    const whole = facade.mesh.geometry.clone().applyMatrix4(facade.mesh.matrixWorld);
    const panels = new THREE.Mesh(clearEntrances(whole, entrances), materials.facade(style));
    whole.dispose();
    panels.castShadow = panels.receiveShadow = true;
    envelope.add(panels);
  }
  if (entrances.length) envelope.add(buildEntrances(entrances, materials));

  const form = createForm(mass);
  const heightAt = (x, z) => form?.heightAt(x, z) ?? 0;
  if (tunnels) interior.add(buildDucts(tunnels.network().edges, tunnels.openings(), tunnels.heightAt, materials));
  if (plan) interior.add(buildFraming(plan, materials));

  const outlines = placed.map((m) => { m.updateWorldMatrix(true, false); return m.geometry.clone().applyMatrix4(m.matrixWorld); });
  const outline = buildOutline(outlines, materials);
  outlines.forEach((g) => g.dispose());

  const { ground, context } = buildSurroundings(state.features, state.site.radius, (x, z) => heightAt(x, z) > 0.5, mass.bounds);
  // the structure, if it has been added: of the same parts as are shown in the working view. The plates are seen through,
  // so that they do not hide the systems under them.
  let structure = null;
  const frame = source.structure;
  if (frame.data && (frame.plates || frame.steel)) {
    const plate = materials.concrete.clone();
    Object.assign(plate, { transparent: true, opacity: 0.38, depthWrite: false });
    const built = buildStructureMeshes(frame.data, { plate, steel: materials.frame });
    built.plates.visible = frame.plates;
    built.steel.visible = frame.steel;
    structure = built.group;
    studio.scene.add(structure);
  }

  // (`interior`, the ducts and the framing, belongs to the view of the systems alone: see showMode)
  studio.scene.add(ground, context, envelope, interior, outline);
  // (only metals mirror the bright sky strongly: on everything else it would wash out the sun's light and shade)
  studio.scene.traverse((o) => {
    for (const m of [o.material].flat()) if (m?.isMeshStandardMaterial && m.metalness < 0.5) m.envMapIntensity = 0.45;
  });
  return { envelope, interior, outline, context, structure };
}

function showMode(mode) {
  const { parts, studio } = view;
  const systems = mode === "systems";
  parts.envelope.visible = !systems;
  parts.outline.visible = systems && $("render-outline").checked;
  parts.interior.visible = systems;
  if (parts.structure) parts.structure.visible = systems && $("render-structure").checked;
  $("render-structure-label").classList.toggle("hidden", !systems || !parts.structure);
  $("render-outline-label").classList.toggle("hidden", !systems);
  for (const b of document.querySelectorAll("[data-render-mode]")) b.classList.toggle("on", b.dataset.renderMode === mode);
  view.mode = mode;
  studio.refresh();
}

function setOrbit(on) {
  if (on) view.studio.whenRefined(null); // (a picture that was to be saved is given up: it can't be refined while orbiting)
  if (on && $("render-note").textContent.startsWith("Saving the picture")) $("render-note").textContent = "Image not saved.";
  view.studio.setOrbit(on);
  $("render-orbit").textContent = on ? "Pause orbit" : "Play orbit";
}

const siteName = () => $("save-name").value.trim().replace(/[\\/:*?"<>|]+/g, "-") || "flow-state";

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Pauses the orbit and saves the view as it stands, once it is refined.
function saveImage() {
  if (view.studio.orbiting) setOrbit(false);
  const current = view;
  $("render-note").textContent = "Saving the picture once it is refined. The camera is held until then.";
  current.studio.whenRefined(() => {
    const name = `${siteName()}-render-${current.mode}.png`;
    // (called straight after the frame is drawn, so the canvas holds the finished picture)
    current.canvas.toBlob((blob) => {
      if (view !== current) return;
      if (!blob) return ($("render-note").textContent = "The image couldn't be made. Try a smaller window.");
      download(blob, name);
      $("render-note").textContent = `Saved ${name} to your downloads.`;
    }, "image/png");
  });
}

// Records the canvas through one whole orbit, as it plays.
function recordOrbit() {
  if (view.recorder) return view.recorder.stop();
  if (!window.MediaRecorder) return ($("render-note").textContent = "This browser can't record video.");
  const type = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(view.canvas.captureStream(30), { mimeType: type, videoBitsPerSecond: 16e6 });
  const chunks = [], name = `${siteName()}-orbit-${view.mode}.${type?.startsWith("video/mp4") ? "mp4" : "webm"}`;
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const current = view;
  let timer = 0;
  recorder.onstop = () => {
    clearTimeout(timer);
    current.recorder = null;
    if (view !== current) return; // (the view was closed: the recording is dropped)
    download(new Blob(chunks, { type }), name);
    $("render-record").textContent = "Record orbit";
    $("render-note").textContent = `Saved ${name}.`;
  };
  setOrbit(true);
  recorder.start(1000);
  view.recorder = recorder;
  timer = setTimeout(() => recorder.state !== "inactive" && recorder.stop(), 36500); // one turn
  $("render-record").textContent = "Stop and save";
  $("render-note").textContent = "Recording one orbit (36 s). Keep this tab in front.";
}

async function open() {
  if (view || !state.site) return;
  const source = gather();
  if (source.wait) return ($("export-status").textContent = source.wait);
  const overlay = $("render-view");
  overlay.classList.remove("hidden");
  $("render-status").textContent = "Building the render…";
  $("render-note").textContent = source.missing.length ? `Not in this render: ${source.missing.join(", ")}.` : "";
  if (source.tunnels && !source.shown.skin && hasRoundedMass()) $("render-note").textContent += " A rounded massing is shown without tunnel openings in the full building.";
  await new Promise((resolve) => setTimeout(resolve, 60)); // (so that the line above is drawn before the page is busy)

  const canvas = document.createElement("canvas"); // (a new one each time: a closed renderer's canvas can't be used again)
  canvas.className = "render-canvas";
  overlay.prepend(canvas);
  setPaused(true);
  let studio = null;
  try {
    const box = source.mass.bounds, across = box.getSize(new THREE.Vector3());
    const focus = { centre: new THREE.Vector3((box.min.x + box.max.x) / 2, across.y * 0.42, (box.min.z + box.max.z) / 2), size: Math.max(across.x, across.z, across.y * 1.4) };
    studio = createStudio(canvas, focus, (text) => {
      if ($("render-status").textContent !== text) $("render-status").textContent = text;
    });
    view = { studio, canvas, recorder: null, mode: "full" };
    view.parts = build(studio, source);
    $("render-projection").value = "perspective";
    $("render-surroundings").checked = true;
    $("render-structure").checked = true;
    setOrbit(true);
    showMode("full");
  } catch (e) {
    console.error("The render view failed:", e);
    studio?.dispose();
    canvas.remove();
    view = null;
    setPaused(false);
    overlay.classList.add("hidden");
    $("export-status").textContent = "Couldn't open the render view (see the console).";
  }
}

function close() {
  if (!view) return;
  const closing = view;
  view = null;
  closing.recorder?.stop();
  closing.studio.dispose();
  closing.canvas.remove();
  $("render-record").textContent = "Record orbit";
  $("render-view").classList.add("hidden");
  setPaused(false);
}

$("open-render").addEventListener("click", open);
$("render-close").addEventListener("click", close);
for (const b of document.querySelectorAll("[data-render-mode]")) b.addEventListener("click", () => view && showMode(b.dataset.renderMode));
$("render-orbit").addEventListener("click", () => view && setOrbit(!view.studio.orbiting));
$("render-projection").addEventListener("change", (e) => view?.studio.setProjection(e.target.value));
$("render-surroundings").addEventListener("change", (e) => {
  if (!view) return;
  view.parts.context.visible = e.target.checked;
  view.studio.refresh();
});
$("render-outline").addEventListener("change", () => view && showMode(view.mode));
$("render-structure").addEventListener("change", () => view && showMode(view.mode));
$("render-save").addEventListener("click", () => view && saveImage());
$("render-record").addEventListener("click", () => view && recordOrbit());
// (while the render view is open, keys must not reach the working view behind it: Delete would remove a massing)
addEventListener("keydown", (e) => {
  if (!view) return;
  e.stopImmediatePropagation();
  if (e.key === "Escape") close();
}, true);
for (const type of ["dragover", "dragenter", "drop"]) $("render-view").addEventListener(type, (e) => { e.preventDefault(); e.stopPropagation(); });
on("site:cleared", close);
