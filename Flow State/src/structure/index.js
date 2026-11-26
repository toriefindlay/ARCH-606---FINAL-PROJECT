// CONTROLLER (structure): the Structure section of the menu. When the structure is added it is planned (model.js) from the
// massings as placed, once the wind tunnels and the circulation (where they are wanted) are finished, drawn in the scene
// (view.js), and planned again whenever any of them changes. It only reads them: nothing else is changed by it.
import * as THREE from "three";
import { $ } from "../core/dom.js";
import { on } from "../core/events.js";
import { state, layers } from "../core/state.js";
import { onFrame } from "../view/scene.js";
import { registerPersist } from "../core/persist.js";
import { createSolid, meshTriangles } from "../core/solid.js";
import { getMassFrames, getMassInfo } from "../mass/model3dm.js";
import { getFinishedTunnels } from "../erosion/exterior/index.js";
import { settings as exteriorSettings } from "../erosion/exterior/panel.js";
import { getCirculationPlan } from "../erosion/circulation/index.js";
import { settings as circulationSettings } from "../erosion/circulation/panel.js";
import { STOREY } from "../erosion/exterior/tunnels.js";
import { planStructure } from "./model.js";
import { buildStructureMeshes } from "./view.js";

const settings = { enabled: false, plates: true, steel: true, spacing: 7.5 };
const DEFAULTS = { ...settings };
const SETTLE = 600; // ms things must stay unchanged before the structure is planned again
let data = null, builtKey = "", wantKey = "", wantSince = 0;
let drawn = null; // { group, plates, steel, materials }
let planNumbers = new WeakMap(), planCount = 0; // (tells one circulation plan from another)

function mountPanel(el) {
  el.innerHTML = `
    <p class="hint" style="margin-top:0">Concrete floor plates under each floor and a generic steel frame. The wind tunnels and the circulation come first: they cut through the plates, and nothing else changes. A concept only: nothing is sized or checked for loads.</p>
    <label><input type="checkbox" id="structure-enabled"> Add structure</label>
    <label><input type="checkbox" id="structure-plates"> Concrete floor plates</label>
    <label><input type="checkbox" id="structure-steel"> Steel frame</label>
    <label title="The most there is between two lines of columns. Each column may move a little off its place to avoid tunnels, hallways and stairs.">Column spacing <output id="structure-spacing-out"></output>
      <input type="range" id="structure-spacing" min="5" max="10" step="0.5">
    </label>
    <p class="hint" style="margin:0 0 6px">To see it inside the mass, turn on X-ray under Passive cooling.</p>
    <p id="structure-note" class="hint" style="margin:0"></p>`;
  for (const key of ["enabled", "plates", "steel"]) $(`structure-${key}`).addEventListener("change", (e) => { settings[key] = e.target.checked; syncControls(); });
  $("structure-spacing").addEventListener("input", (e) => { settings.spacing = Number(e.target.value); syncControls(); });
  syncControls();
}

function syncControls() {
  if (!$("structure-enabled")) return;
  for (const key of ["enabled", "plates", "steel"]) $(`structure-${key}`).checked = settings[key];
  for (const key of ["plates", "steel", "spacing"]) $(`structure-${key}`).disabled = !settings.enabled;
  $("structure-spacing").value = settings.spacing;
  $("structure-spacing-out").textContent = `${settings.spacing.toFixed(1)} m`;
}

const setNote = (text) => {
  const el = $("structure-note");
  if (el && el.textContent !== text) el.textContent = text;
};

function clearDrawn() {
  if (!drawn) return;
  drawn.group.traverse((o) => o.geometry?.dispose());
  Object.values(drawn.materials).forEach((m) => m.dispose());
  drawn.group.parent?.remove(drawn.group);
  drawn = null;
}

function describe({ stats }, tunnels, plan) {
  const lines = [`${stats.floors} floor plate${stats.floors === 1 ? "" : "s"} (${Math.round(stats.area).toLocaleString()} m² of concrete floor), ${stats.columns} steel columns and ${stats.beams} beam lengths.`];
  if (tunnels || plan) lines.push(`${stats.clearColumns} of ${stats.columns} columns miss every tunnel, hallway and stair${stats.clearColumns < stats.columns ? `; the others still pass through one, in ${stats.columnClashes} places (storeys) altogether` : ""}.`);
  if (!tunnels) lines.push("There are no wind tunnels yet, so nothing is cut for them.");
  if (!plan) lines.push("There is no circulation yet, so there are no stair openings.");
  return lines.join(" ");
}

function frame() {
  const mass = state.siteGroup && layers.model ? getMassInfo() : null;
  if (!settings.enabled || !mass) {
    clearDrawn();
    data = null;
    builtKey = wantKey = "";
    return setNote(settings.enabled ? "Place a .3dm mass to give a structure to." : "");
  }
  const tunnels = getFinishedTunnels(), plan = tunnels ? getCirculationPlan() : null;
  // (it is planned after the tunnels and the circulation, where those are wanted)
  const waiting = exteriorSettings.erodeTunnels && !tunnels ? "the wind tunnels" : circulationSettings.enabled && tunnels && !plan ? "the circulation" : "";
  if (waiting) {
    if (drawn) drawn.group.visible = false;
    data = null;
    builtKey = wantKey = "";
    return setNote(`The structure follows once ${waiting} ${waiting.endsWith("s") ? "are" : "is"} finished.`);
  }
  if (plan && !planNumbers.has(plan)) planNumbers.set(plan, ++planCount);
  const key = `${JSON.stringify(getMassFrames())}|${tunnels ? `${tunnels.id}:${tunnels.version}` : ""}|${plan ? planNumbers.get(plan) : ""}|${settings.spacing}`;
  if (key !== builtKey) {
    if (key !== wantKey) {
      wantKey = key;
      wantSince = performance.now();
      if (drawn) drawn.group.visible = false; // (what is drawn no longer fits)
      data = null;
      setNote("Planning the structure…");
    }
    if (performance.now() - wantSince < SETTLE) return;
    builtKey = key; // (a failure is not retried until something changes)
    clearDrawn();
    try {
      const turn = getMassFrames()[0]?.turn ?? 0;
      const axes = tunnels?.frame ?? { A: [Math.cos(turn), -Math.sin(turn)], B: [Math.sin(turn), Math.cos(turn)] };
      const meshes = meshTriangles(mass.object, THREE.Vector3);
      data = planStructure({ triangles: meshes.flat(), bounds: mass.bounds, storey: STOREY, axes, tubes: tunnels ? tunnels.network().edges : [], plan, spacing: settings.spacing, solid: createSolid(meshes) });
      const materials = {
        plate: new THREE.MeshLambertMaterial({ color: 0xb4b1aa, side: THREE.DoubleSide, transparent: true, opacity: 0.55, depthWrite: false }),
        steel: new THREE.MeshLambertMaterial({ color: 0x8c3b32 }),
      };
      drawn = { ...buildStructureMeshes(data, materials), materials };
      drawn.group.userData.solid = true; // the x-ray mode leaves it as it is
      layers.model.add(drawn.group);
      setNote(describe(data, tunnels, plan));
    } catch (e) {
      console.error("The structure could not be planned:", e);
      data = null;
      setNote("The structure could not be planned (see the console).");
    }
  }
  if (drawn) {
    drawn.group.visible = true;
    drawn.plates.visible = settings.plates;
    drawn.steel.visible = settings.steel;
  }
}

// For the render view: { data (planStructure's, or null), plates, steel (which parts are shown), pending }.
export function getStructure() {
  return { data: settings.enabled ? data : null, plates: settings.plates, steel: settings.steel, pending: settings.enabled && !!wantKey && wantKey !== builtKey };
}

function mount() {
  mountPanel($("structure-panel"));
  onFrame(frame);
  on("site:ready", syncControls);
  on("mass:changed", () => { if (drawn) drawn.group.visible = false; data = null; builtKey = wantKey = ""; });
  on("site:cleared", () => { // (what is drawn is disposed with the site's group)
    drawn = data = null;
    builtKey = wantKey = "";
    Object.assign(settings, DEFAULTS);
    syncControls();
  });
}

registerPersist("structure", {
  capture: () => ({ ...settings }),
  restore: (saved) => { Object.assign(settings, saved); syncControls(); },
});

mount();
