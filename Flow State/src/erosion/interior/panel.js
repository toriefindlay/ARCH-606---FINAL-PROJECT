// CONTROLLER (interior erosion): the controls in the side panel.
// `el` is the empty #interior-panel container in index.html. Call notifyCutsChanged() from
// erosion/combine.js after any control changes the cuts, and registerPersist() to save settings.
//
// Occupied spaces: add cold and warm spheres one at a time, then move (x, y, z) and scale them. The wind tunnels grow round them
// (see spaces.js).
import { on } from "../../core/events.js";
import { getMassInfo } from "../../mass/model3dm.js";
import { SPACE_KINDS, addSpace, getSpaces, getSelected, getSelectedId, selectSpace, updateSpace, removeSpace, getGizmoMode, setGizmoMode } from "./spaces.js";

const $ = (id) => document.getElementById(id);
const hex = (n) => `#${n.toString(16).padStart(6, "0")}`;

// Where a new sphere goes: the middle of the mass, at half its height, a few metres across; the middle of the site with no mass.
function startingPlace() {
  const box = getMassInfo()?.bounds;
  if (!box) return { x: 0, y: 6, z: 0, r: 4 };
  const size = box.getSize(box.min.clone()), centre = box.getCenter(box.min.clone());
  return { x: centre.x, y: box.min.y + size.y / 2, z: centre.z, r: Math.max(2, Math.min(12, 0.15 * Math.min(size.x, size.z))) };
}

export function mountPanel(el) {
  el.innerHTML = `
    <p class="hint" style="margin-top:0">Occupied spaces: add as many cold and warm spaces as you want, one at a time. Move and scale them inside the mass; they can overlap to join up. The wind tunnels grow round them.</p>
    <div class="tools">
      <button type="button" class="tool" id="space-add-cold">+ Cold space</button>
      <button type="button" class="tool" id="space-add-warm">+ Warm space</button>
    </div>
    <div id="space-list" style="display:flex;flex-direction:column;gap:3px;margin:6px 0"></div>
    <div id="space-edit" style="display:none">
      <div class="tools">
        <button type="button" class="tool" id="space-mode-move">Move (x, y, z)</button>
        <button type="button" class="tool" id="space-mode-scale">Scale</button>
      </div>
      <label>East–west (x, m) <input type="number" step="0.5" id="space-x"></label>
      <label>Height (y, m) <input type="number" step="0.5" min="0" id="space-y"></label>
      <label>North–south (z, m, south +) <input type="number" step="0.5" id="space-z"></label>
      <label>Radius (m) <input type="number" step="0.5" min="0.5" id="space-r"></label>
      <button type="button" class="tool" id="space-delete" style="width:100%;margin-top:4px">Delete this space</button>
    </div>
    <p id="space-note" class="hint"></p>`;

  const add = (kind) => addSpace(kind, startingPlace());
  $("space-add-cold").addEventListener("click", () => add("cold"));
  $("space-add-warm").addEventListener("click", () => add("warm"));
  $("space-mode-move").addEventListener("click", () => setGizmoMode("move"));
  $("space-mode-scale").addEventListener("click", () => setGizmoMode("scale"));
  $("space-delete").addEventListener("click", () => { const id = getSelectedId(); if (id !== null) removeSpace(id); });
  for (const key of ["x", "y", "z", "r"]) {
    $(`space-${key}`).addEventListener("input", (e) => {
      const id = getSelectedId(), v = e.target.valueAsNumber;
      if (id !== null && Number.isFinite(v)) updateSpace(id, { [key]: v });
    });
  }

  function sync() {
    const spaces = getSpaces(), selected = getSelected();
    const list = $("space-list");
    list.replaceChildren(...spaces.map((s) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tool";
      b.style.cssText = `text-align:left;border-left:6px solid ${hex(SPACE_KINDS[s.kind].colour)};${s.id === selected?.id ? "font-weight:600;background:#e8e2d6" : ""}`;
      b.textContent = `${s.label} · radius ${s.r.toFixed(1)} m`;
      b.addEventListener("click", () => selectSpace(s.id));
      return b;
    }));
    $("space-edit").style.display = selected ? "block" : "none";
    if (selected) {
      for (const key of ["x", "y", "z", "r"]) {
        const input = $(`space-${key}`);
        if (document.activeElement !== input) input.value = Number(selected[key].toFixed(2));
      }
      $("space-mode-move").style.fontWeight = getGizmoMode() === "move" ? "600" : "400";
      $("space-mode-scale").style.fontWeight = getGizmoMode() === "scale" ? "600" : "400";
    }
    $("space-note").textContent = spaces.length
      ? `${spaces.filter((s) => s.kind === "cold").length} cold, ${spaces.filter((s) => s.kind === "warm").length} warm. Click a sphere in the scene to select it; drag its arrows to move it.`
      : "No spaces yet.";
  }
  on("spaces:changed", sync);
  on("spaces:selected", sync);
  on("spaces:mode", sync);
  sync();
}
