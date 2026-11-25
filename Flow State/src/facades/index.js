// CONTROLLER (facades): the Facades section of the menu. Choosing a facade covers the outside walls of every massing with
// panels that stand out from them (panels.js, placed by walls.js) over a matching wall (shader.js). The slider that softens
// the skin lives here too (the skin itself is made by erosion/exterior). The panels are only there to be looked at: the
// tunnels, wind and cooling are worked out from the massings alone.
import * as THREE from "three";
import { $ } from "../core/dom.js";
import { on } from "../core/events.js";
import { state, layers } from "../core/state.js";
import { onFrame } from "../view/scene.js";
import { registerPersist } from "../core/persist.js";
import { getMassFrames, getMassInfo } from "../mass/model3dm.js";
import { settings as exteriorSettings } from "../erosion/exterior/panel.js";
import { getFinishedTunnels } from "../erosion/exterior/index.js";
import { facadeUniforms, MAX_FRAMES } from "./shader.js";
import { readWalls } from "./walls.js";
import { PANELS, createMeshData } from "./panels.js";

// The choices, in the order of their numbers in the shader. `swatch` is a small CSS likeness for the button.
const STYLES = [
  { id: "none", name: "None", swatch: "#ffd9c9" },
  { id: "triangle", name: "Triangular", swatch: "conic-gradient(from 150deg at 50% 25%, #d8c39a 60deg, transparent 0) 0 0 / 20px 17px, conic-gradient(from -30deg at 50% 75%, #e9e5da 60deg, transparent 0) 0 0 / 20px 17px, #344a58" },
  { id: "cubic", name: "Cubic", swatch: "conic-gradient(#ded3b8 90deg, #a89c80 0 180deg, #ded3b8 0 270deg, #f0e8d2 0) 0 0 / 14px 12px" },
  { id: "organic", name: "Organic", swatch: "radial-gradient(ellipse 45% 38% at 50% 50%, #2c3e4c 92%, #eceae6 100%) 0 0 / 27px 19px, #eceae6" },
  { id: "fins", name: "Protruding fins", swatch: "repeating-linear-gradient(90deg, #f0d7b4 0 2px, #d9a66f 2px 5px, #2c3e4c 5px 10px)" },
  { id: "hex", name: "Hexagonal", swatch: "radial-gradient(circle, #5c7c90 36%, #ffffff 40% 54%, #b4bcc0 58%) 0 0 / 17px 17px" },
];
const SETTLE = 450; // ms the massings and their surfaces must stay unchanged before the panels are made again
const settings = { style: "none", size: 100 }; // size: percent of the panels' usual size
let mesh = null; // every panel of every massing, as one mesh under layers.model
let material = null; // (kept from one set of panels to the next, so that the x-ray mode goes on applying to them)
let builtKey = "", wantKey = "", wantSince = 0;

function mountPanel(el) {
  el.innerHTML = `
    <p class="hint" style="margin-top:0">Choose a facade: its panels stand out from the outside walls of every massing and stop at the tunnel openings. Roofs stay plain. It changes the look only, not the tunnels, wind or cooling.</p>
    <div id="facade-styles" role="radiogroup" aria-label="Facade">
      ${STYLES.map((s) => `<button type="button" class="tool" role="radio" data-facade="${s.id}"><span class="facade-swatch" aria-hidden="true"></span>${s.name}</button>`).join("")}
    </div>
    <label title="How big the facade's panels are, and how far they stand out.">Panel size <output id="facade-size-out"></output>
      <input type="range" id="facade-size" min="60" max="200" step="10">
    </label>
    <p id="facade-note" class="hint" style="margin:0 0 6px"></p>
    <label title="How soft the outside of the mass is once the tunnels are finished. At the rigid end (0) it is a flat, smooth facade with crisp round openings, each with a flared, angled reveal. Towards the soft end the corners round off, and the faces dish in round every opening and swell out between them, so that the edge of each tunnel flows into the face (the skin eases from rigid to the setting slowly). It only reshapes the surface and never changes the tunnels or the cooling.">Soften the skin (rigid to soft) <output id="skin-soften-out"></output>
      <input type="range" id="skin-soften" min="0" max="100" step="5">
    </label>
    <p class="hint" style="margin:0 0 6px">The skin softens once the wind tunnels are finished (under Passive cooling).</p>`;
  el.querySelectorAll("[data-facade]").forEach((button) => {
    button.querySelector(".facade-swatch").style.background = STYLES.find((s) => s.id === button.dataset.facade).swatch;
    button.addEventListener("click", () => { settings.style = button.dataset.facade; syncControls(); });
  });
  $("facade-size").addEventListener("input", (e) => { settings.size = Number(e.target.value); syncControls(); });
  $("skin-soften").addEventListener("input", (e) => { exteriorSettings.skinSoften = Number(e.target.value); syncControls(); });
  syncControls();
}

function syncControls() {
  if (!$("facade-size")) return;
  document.querySelectorAll("[data-facade]").forEach((button) => {
    const chosen = button.dataset.facade === settings.style;
    button.classList.toggle("on", chosen);
    button.setAttribute("aria-checked", String(chosen));
  });
  $("facade-size").value = settings.size;
  $("facade-size-out").textContent = `${settings.size}%`;
  $("skin-soften").value = exteriorSettings.skinSoften;
  $("skin-soften-out").textContent = exteriorSettings.skinSoften ? `${exteriorSettings.skinSoften}%` : "rigid";
  facadeUniforms.uFacade.value = Math.max(0, STYLES.findIndex((s) => s.id === settings.style));
  facadeUniforms.uFacadeSize.value = settings.size / 100;
}

// Where each massing stands and how it is turned, so that its facades can run along its own sides.
function followMassings() {
  const frames = getMassFrames().slice(0, MAX_FRAMES);
  facadeUniforms.uFrameCount.value = frames.length;
  frames.forEach((f, i) => {
    facadeUniforms.uFramePos.value[i].set(f.x, f.z, Math.cos(f.turn), Math.sin(f.turn));
    facadeUniforms.uFrameHalf.value[i].set(f.halfX, f.halfZ);
  });
}

const setNote = (text) => {
  const el = $("facade-note");
  if (el && el.textContent !== text) el.textContent = text;
};

// Calls visit() with every triangle of the outside surfaces: the softened skin where it is drawn, else the massings.
function surfaceTriangles(skin) {
  const meshes = [];
  if (skin) meshes.push(skin);
  else getMassInfo()?.object.traverse((o) => o.isMesh && o.geometry?.attributes.position && meshes.push(o));
  return (visit) => {
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (const m of meshes) {
      const pos = m.geometry.attributes.position, index = m.geometry.index, count = index ? index.count : pos.count;
      m.updateWorldMatrix(true, false);
      for (let i = 0; i + 2 < count; i += 3) {
        [a, b, c].forEach((v, n) => v.fromBufferAttribute(pos, index ? index.getX(i + n) : i + n).applyMatrix4(m.matrixWorld));
        visit(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      }
    }
  };
}

function buildPanels(frames, skin, tunnels) {
  const walls = readWalls(frames, surfaceTriangles(skin), tunnels?.openings() ?? []);
  const data = createMeshData();
  for (const wall of walls) PANELS[settings.style](data, wall, settings.size / 100);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(data.position, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(data.color, 3));
  geometry.computeVertexNormals();
  if (!mesh) {
    material ??= new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, flatShading: true });
    mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    layers.model.add(mesh);
  } else {
    mesh.geometry.dispose();
    mesh.geometry = geometry;
  }
}

// Keeps the panels in step: they are made again, once things have stopped changing for a moment, when the choice, a massing,
// the tunnels or the skin changes.
function panelFrame() {
  const frames = state.siteGroup && layers.model ? getMassFrames() : [];
  if (settings.style === "none" || !frames.length) {
    if (mesh) mesh.visible = false;
    wantKey = "";
    return setNote("");
  }
  const tunnels = getFinishedTunnels();
  if (exteriorSettings.erodeTunnels && !tunnels) { // (panels would cover the openings being worn)
    if (mesh) mesh.visible = false;
    builtKey = wantKey = "";
    return setNote("The panels come back once the wind tunnels are finished.");
  }
  const skin = layers.model.children.find((o) => o.isMesh && o.userData.skin) ?? null;
  const placed = JSON.stringify(frames);
  const key = `${settings.style}|${settings.size}|${placed}|${skin?.geometry.uuid ?? "mass"}|${tunnels ? `${tunnels.id}:${tunnels.version}` : ""}`;
  if (key === builtKey && mesh) { mesh.visible = true; return setNote(""); }
  if (key !== wantKey) {
    wantKey = key;
    wantSince = performance.now();
    if (mesh && mesh.userData.placed !== placed) mesh.visible = false; // (a massing moved: the old panels are in the wrong place)
  }
  if (performance.now() - wantSince < SETTLE) return;
  try {
    buildPanels(frames.slice(0, MAX_FRAMES), skin, tunnels);
    mesh.userData.placed = placed;
    mesh.visible = true;
    setNote("");
  } catch (e) {
    console.error("The facade panels could not be made:", e);
    setNote("The panels could not be made (see the console).");
  }
  builtKey = key; // (a failure is not retried until something changes)
}

function mountFacades() {
  mountPanel($("facades-panel"));
  onFrame(() => { followMassings(); panelFrame(); });
  on("site:ready", syncControls);
  on("mass:changed", () => { if (mesh) mesh.visible = false; builtKey = wantKey = ""; });
  on("site:cleared", () => { mesh = material = null; builtKey = wantKey = ""; }); // (disposed with the site's group)
}
registerPersist("facade", {
  capture: () => ({ ...settings }),
  restore: (saved) => {
    if (STYLES.some((s) => s.id === saved.style)) settings.style = saved.style;
    if (saved.size > 0) settings.size = saved.size;
    syncControls();
  },
});

mountFacades();
