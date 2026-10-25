// CONTROLLER (exterior erosion): the controls in the side panel.
// `el` is the empty #exterior-panel container in index.html. Call notifyCutsChanged() from
// erosion/combine.js after any control changes the cuts, and registerPersist() to save settings.
import { registerPersist } from "../../core/persist.js";

// Read each frame by index.js. `speed` is simulated seconds per real second.
export const settings = { playing: true, speed: 4, people: 1, cars: 1, size: 2, leftHand: false, carve: true, erode: 2 };

const $ = (id) => document.getElementById(id);
let onReset = () => {};
let onClearErosion = () => {};
let lastReadout = "";

export function mountPanel(el, hooks = {}) {
  onReset = hooks.reset ?? onReset;
  onClearErosion = hooks.clearErosion ?? onClearErosion;
  el.innerHTML = `
    <p class="hint" style="margin-top:0">Traffic: people and cars moving along the site's paths and roads.</p>
    <div class="tools">
      <button type="button" class="tool" id="traffic-play">Pause</button>
      <button type="button" class="tool" id="traffic-reset">Reset</button>
    </div>
    <label>Speed
      <select id="traffic-speed">
        <option value="1">Real time</option>
        <option value="4">4×</option>
        <option value="12">12×</option>
      </select>
    </label>
    <label>People <output id="traffic-people-out"></output>
      <input type="range" id="traffic-people" min="0" max="4" step="0.25">
    </label>
    <label>Cars <output id="traffic-cars-out"></output>
      <input type="range" id="traffic-cars" min="0" max="4" step="0.25">
    </label>
    <label>Particle size <output id="traffic-size-out"></output>
      <input type="range" id="traffic-size" min="1" max="6" step="0.5">
    </label>
    <label><input type="checkbox" id="traffic-left"> Left-hand traffic</label>
    <p id="traffic-readout" class="stats"></p>
    <label><input type="checkbox" id="traffic-carve"> Carve the mass</label>
    <label>Erosion speed <output id="traffic-erode-out"></output>
      <input type="range" id="traffic-erode" min="0.5" max="8" step="0.5">
    </label>
    <button type="button" class="tool" id="traffic-clear-erosion" style="width:100%;margin-bottom:8px">Clear erosion</button>
    <p id="carve-readout" class="stats"></p>
    <p class="hint" style="margin-top:0">Import a mass: people and cars passing through it wear stepped tunnels, built from the mass's own axis, block size and storey height.</p>`;

  $("traffic-play").addEventListener("click", () => { settings.playing = !settings.playing; syncControls(); });
  $("traffic-reset").addEventListener("click", () => onReset());
  $("traffic-clear-erosion").addEventListener("click", () => onClearErosion());
  $("traffic-speed").addEventListener("change", (e) => (settings.speed = Number(e.target.value)));
  for (const key of ["people", "cars", "size", "erode"]) {
    $(`traffic-${key}`).addEventListener("input", (e) => { settings[key] = Number(e.target.value); syncControls(); });
  }
  $("traffic-left").addEventListener("change", (e) => (settings.leftHand = e.target.checked));
  $("traffic-carve").addEventListener("change", (e) => (settings.carve = e.target.checked));
  syncControls();
}

// Pushes `settings` into the controls (after a restore or a site change).
export function syncControls() {
  if (!$("traffic-play")) return;
  $("traffic-play").textContent = settings.playing ? "Pause" : "Play";
  $("traffic-speed").value = String(settings.speed);
  for (const key of ["people", "cars", "size", "erode"]) {
    $(`traffic-${key}`).value = settings[key];
    $(`traffic-${key}-out`).textContent = `${settings[key]}×`;
  }
  $("traffic-left").checked = settings.leftHand;
  $("traffic-carve").checked = settings.carve;
}

// What was read from the mass, shown under the carving controls.
export function showLanguage(scan) {
  const el = $("carve-readout");
  if (!el) return;
  const form = scan?.organic ? "organic" : scan?.skewed ? "skewed" : "orthogonal";
  el.innerHTML = scan
    ? `Mass reads as <b>${form}</b> (${Math.round(scan.orthogonality * 100)}% of walls on its two axes)<br>` +
      `axes <b>${scan.axis1.toFixed(0)}°</b> and <b>${(scan.axis2 % 180).toFixed(0)}°</b> · blocks <b>${scan.blockU.toFixed(0)} × ${scan.blockV.toFixed(0)} m</b><br>` +
      (scan.organic
        ? `lobes about <b>${scan.lobeRadius.toFixed(0)} m</b> across · round hollows <b>${scan.tunnelRadius.toFixed(1)} m</b> radius`
        : `storey <b>${scan.storey.toFixed(1)} m</b> · <b>${scan.profile}</b> profile<br>` +
          `carving in <b>${scan.cu.toFixed(1)} × ${scan.cv.toFixed(1)} m</b> cells (${scan.nU} × ${scan.nV})`)
    : "";
}

export function updateReadout(sim) {
  const el = $("traffic-readout");
  if (!el) return;
  const text = sim ? `<b>${sim.people.length}</b> people · <b>${sim.cars.length}</b> cars on site` : "";
  if (text !== lastReadout) el.innerHTML = lastReadout = text;
}

registerPersist("exteriorErosion", {
  capture: () => ({ ...settings }),
  restore: (saved) => {
    Object.assign(settings, saved);
    syncControls();
  },
});
