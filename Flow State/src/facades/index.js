// CONTROLLER (facades): the Facades section of the menu. Choosing a facade covers the outside walls of every massing with
// panels that stand out from them (panels.js, placed by walls.js) over a matching wall (shader.js). The panels are only there to
// be looked at: the tunnels, wind and cooling are worked out from the massings alone.
import * as THREE from "three";
import { $ } from "../core/dom.js";
import { on } from "../core/events.js";
import { state, layers } from "../core/state.js";
import { onFrame } from "../view/scene.js";
import { registerPersist } from "../core/persist.js";
import { getMassFrames, getMassInfo, hasRoundedMass } from "../mass/model3dm.js";
import { settings as exteriorSettings } from "../erosion/exterior/panel.js";
import { getFinishedTunnels, setSkinShapes } from "../erosion/exterior/index.js";
import { facadeUniforms, MAX_FRAMES } from "./shader.js";
import { readWalls, placeOpenings } from "./walls.js";
import { PANELS, createMeshData } from "./panels.js";
import { readWalls as readPlainWalls } from "./plainWalls.js";
import { PLAIN_PANELS } from "./plainPanels.js";
import { readCurvedWalls } from "./curvedWalls.js";
import { findFaces, faceWalls } from "./faceWalls.js";
import { triangleGrid } from "./openings.js";

// The choices, in the order of their numbers in the shader. `swatch` is a small CSS likeness for the button. A facade with a
// `lining` gives the tunnel openings shapes from its own pattern, lined in that colour (walls.js, panels.js); the others leave
// them round, and their panels stop short of them (plainWalls.js, plainPanels.js); a `tint` colours those round openings.
const NAVY = 0x364b5c; // the dark blue of the glazing behind the panels
const WHITE = 0xffffff; // the white of the cubic facade's blocks
const STYLES = [
  { id: "none", name: "None", swatch: "#ffd9c9" },
  { id: "triangle", name: "Triangular", lining: 0x54472f, swatch: "conic-gradient(from 150deg at 50% 25%, #d8c39a 60deg, transparent 0) 0 0 / 20px 17px, conic-gradient(from -30deg at 50% 75%, #e9e5da 60deg, transparent 0) 0 0 / 20px 17px, #344a58" },
  { id: "cubic", name: "Cubic", tint: WHITE, glow: 0x808080, swatch: "conic-gradient(#f2f1ed 90deg, #c4c3be 0 180deg, #f2f1ed 0 270deg, #ffffff 0) 0 0 / 14px 12px" },
  { id: "organic", name: "Organic", lining: 0x6c6d6b, swatch: "radial-gradient(ellipse 45% 38% at 50% 50%, #2c3e4c 92%, #eceae6 100%) 0 0 / 27px 19px, #eceae6" },
  { id: "fins", name: "Protruding fins", tint: NAVY, swatch: "repeating-linear-gradient(90deg, #f0d7b4 0 2px, #d9a66f 2px 5px, #2c3e4c 5px 10px)" },
  { id: "hex", name: "Hexagonal", tint: NAVY, swatch: "radial-gradient(circle, #5c7c90 36%, #ffffff 40% 54%, #b4bcc0 58%) 0 0 / 17px 17px" },
];
const SETTLE = 450; // ms the massings and their surfaces must stay unchanged before the panels are made again
// size: percent of the panels' usual size. The triangular facade has a range of its own, which goes larger, so its size is kept
// apart and choosing it does not change the others'.
const settings = { style: "none", size: 100, triangleSize: 100 };
const DEFAULTS = { ...settings }; // (every site starts from these, with no facade, unless it was saved with one)
const SIZES = { min: 60, max: 200 };
const OWN_SIZES = { triangle: { key: "triangleSize", min: 60, max: 400 } };
const sizeKey = () => OWN_SIZES[settings.style]?.key ?? "size"; // which size the slider sets
const sizeNow = () => settings[sizeKey()];
let mesh = null; // every panel of every massing, as one mesh under layers.model
let material = null; // (kept from one set of panels to the next, so that the x-ray mode goes on applying to them)
let builtKey = "", wantKey = "", wantSince = 0;

function mountPanel(el) {
  el.innerHTML = `
    <p class="hint" style="margin-top:0">Choose a facade: its panels stand out from the outside walls of every massing, around the tunnel openings. With Triangular, shades open wide over the openings; with Organic, the web flows round them. Roofs stay plain. It changes the look only, not the tunnels, wind or cooling.</p>
    <div id="facade-styles" role="radiogroup" aria-label="Facade">
      ${STYLES.map((s) => `<button type="button" class="tool" role="radio" data-facade="${s.id}"><span class="facade-swatch" aria-hidden="true"></span>${s.name}</button>`).join("")}
    </div>
    <label title="How big the facade's panels are, and how far they stand out.">Panel size <output id="facade-size-out"></output>
      <input type="range" id="facade-size" min="60" max="200" step="10">
    </label>
    <p id="facade-note" class="hint" style="margin:0 0 6px"></p>`;
  el.querySelectorAll("[data-facade]").forEach((button) => {
    button.querySelector(".facade-swatch").style.background = STYLES.find((s) => s.id === button.dataset.facade).swatch;
    button.addEventListener("click", () => { settings.style = button.dataset.facade; syncControls(); });
  });
  $("facade-size").addEventListener("input", (e) => { settings[sizeKey()] = Number(e.target.value); syncControls(); });
  syncControls();
}

function syncControls() {
  if (!$("facade-size")) return;
  document.querySelectorAll("[data-facade]").forEach((button) => {
    const chosen = button.dataset.facade === settings.style;
    button.classList.toggle("on", chosen);
    button.setAttribute("aria-checked", String(chosen));
  });
  const range = OWN_SIZES[settings.style] ?? SIZES;
  Object.assign($("facade-size"), { min: range.min, max: range.max }); // (before the value, which is held within them)
  $("facade-size").value = sizeNow();
  $("facade-size-out").textContent = `${sizeNow()}%`;
  facadeUniforms.uFacade.value = Math.max(0, STYLES.findIndex((s) => s.id === settings.style));
  facadeUniforms.uFacadeSize.value = sizeNow() / 100;
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

// Calls visit() with every triangle of the outside surfaces: the skin where it is drawn, else the massings.
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

const shapesOpenings = () => !!STYLES.find((s) => s.id === settings.style)?.lining;

// On a rounded massing the openings stay as the tunnels leave them, but the triangular shades over each still open wide:
// this notes which those are (as shapeOpenings does on flat walls).
function markShadesOver(openings, size) {
  const grid = triangleGrid(size);
  for (const o of openings) {
    o.cells = grid.near(o.u, o.y, o.r + grid.a)
      .filter(({ corners }) => Math.hypot((corners[0][0] + corners[1][0] + corners[2][0]) / 3 - o.u, (corners[0][1] + corners[1][1] + corners[2][1]) / 3 - o.y) < o.r + grid.h / 3)
      .map((c) => c.key);
  }
}

function buildPanels(frames, skin, tunnels) {
  const size = sizeNow() / 100;
  const data = createMeshData(), triangles = surfaceTriangles(skin), openings = tunnels?.openings() ?? [];
  if (hasRoundedMass()) {
    const draw = PLAIN_PANELS[settings.style] ?? PANELS[settings.style];
    for (const wall of readCurvedWalls(frames, triangles, tunnels)) {
      if (settings.style === "triangle") markShadesOver(wall.openings, size);
      draw(data, wall, size);
    }
  } else {
    // A simple box has its four walls (walls.js or plainWalls.js); a massing of several blocks has every face of its own
    // (faceWalls.js).
    const shaped = shapesOpenings(), draw = shaped ? PANELS[settings.style] : PLAIN_PANELS[settings.style];
    const placed = shaped ? placeOpenings(frames, openings, settings.style, size) : null;
    const massings = findFaces(frames, surfaceTriangles(null));
    if (massings.some((m) => m.simple)) {
      const fourSided = shaped ? readWalls(frames, triangles, placed) : readPlainWalls(frames, triangles, openings);
      for (const wall of fourSided) if (massings[Math.floor(wall.id / 4)].simple) draw(data, wall, size);
    }
    for (const wall of faceWalls(massings, skin ? surfaceTriangles(skin) : null, openings, placed)) draw(data, wall, size);
  }
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
  // (a little light of their own keeps white panels reading as white on the sides away from the sun)
  mesh.material.emissive.set(STYLES.find((s) => s.id === settings.style).glow ?? 0x000000);
}

// Keeps the panels in step: they are made again, once things have stopped changing for a moment, when the choice, a massing,
// the tunnels or the skin changes.
function panelFrame() {
  const frames = state.siteGroup && layers.model ? getMassFrames() : [];
  if (settings.style === "none" || !frames.length) {
    if (mesh) mesh.visible = false;
    wantKey = "";
    setSkinShapes(null); // (round openings)
    return setNote("");
  }
  // where the facade shapes the openings, the skin is cut again when the choice, the size or a massing changes
  const placed = JSON.stringify(frames), style = settings.style, size = sizeNow() / 100;
  const rounded = hasRoundedMass(), shaped = !rounded && shapesOpenings(), { lining, tint } = STYLES.find((s) => s.id === style);
  const shapesKey = shaped ? `${style}|${size}|${placed}` : lining || tint ? `tint|${lining ?? tint}` : "";
  setSkinShapes(!shapesKey ? null : {
    key: shapesKey,
    lining: lining ?? tint,
    shape: shaped ? (openings) => placeOpenings(frames.slice(0, MAX_FRAMES), openings, style, size).each : null, // (null: they stay round)
  });
  const tunnels = getFinishedTunnels();
  if (exteriorSettings.erodeTunnels && !tunnels) { // (panels would cover the openings being worn)
    if (mesh) mesh.visible = false;
    builtKey = wantKey = "";
    return setNote("The panels come back once the wind tunnels are finished.");
  }
  const skin = layers.model.children.find((o) => o.isMesh && o.userData.skin) ?? null;
  if (!rounded && tunnels?.openings().length && skin?.userData.shapesKey !== shapesKey) { // (the openings are still being cut in the new shapes)
    if (mesh) mesh.visible = false;
    builtKey = wantKey = "";
    return setNote(shaped ? "Shaping the tunnel openings to the panels…" : "Cutting the tunnel openings again…");
  }
  const key = `${settings.style}|${sizeNow()}|${placed}|${skin?.geometry.uuid ?? "mass"}|${tunnels ? `${tunnels.id}:${tunnels.version}` : ""}`;
  if (key === builtKey && mesh) { wantKey = key; mesh.visible = true; return setNote(""); }
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

// The facade's panels for exporting: { mesh (or null), pending (a facade is chosen and its panels are about to be made) }.
export function getFacade() {
  const chosen = settings.style !== "none";
  return { mesh: chosen && mesh?.visible ? mesh : null, pending: chosen && !!wantKey && wantKey !== builtKey };
}

function mountFacades() {
  mountPanel($("facades-panel"));
  onFrame(() => { followMassings(); panelFrame(); });
  on("site:ready", syncControls);
  on("mass:changed", () => { if (mesh) mesh.visible = false; builtKey = wantKey = ""; });
  on("site:cleared", () => { // (the panels are disposed with the site's group)
    mesh = material = null;
    builtKey = wantKey = "";
    setSkinShapes(null);
    Object.assign(settings, DEFAULTS);
    syncControls();
  });
}
registerPersist("facade", {
  capture: () => ({ ...settings }),
  restore: (saved) => {
    if (STYLES.some((s) => s.id === saved.style)) settings.style = saved.style;
    if (saved.size > 0) settings.size = saved.size;
    // (a site saved before the triangular facade had its own range keeps the size it had)
    const { min, max } = OWN_SIZES.triangle, was = saved.style === "triangle" && saved.size > 0 ? saved.size : 100;
    settings.triangleSize = Math.min(max, Math.max(min, saved.triangleSize ?? was));
    syncControls();
  },
});

mountFacades();
