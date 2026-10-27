// CONTROLLER (exterior erosion): the controls in the side panel.
// `el` is the empty #exterior-panel container in index.html. Call notifyCutsChanged() from
// erosion/combine.js after any control changes the cuts, and registerPersist() to save settings.
import { registerPersist } from "../../core/persist.js";

// Read each frame by index.js. `speed` is simulated seconds per real second.
export const settings = { playing: true, speed: 4, people: 1, cars: 1, size: 2, leftHand: false, erode: 2, heal: 1, erodePeople: false, erodeCars: false, erodeWind: false, erodeSun: false };

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
    <p class="hint" style="margin-bottom:6px">Work on the mass with one of these at a time (none by default); each carries on from the shape the others left. Traffic must be switched on under Layers.</p>
    <label><input type="checkbox" id="erode-people"> People</label>
    <label><input type="checkbox" id="erode-cars"> Cars</label>
    <label title="The mass grows towards the sun: the longer the sun hits a roof or wall, the more it grows. Runs while the Sun panel plays a day or the year."><input type="checkbox" id="erode-sun"> Sun (grows towards the sun)</label>
    <p id="sun-erode-note" class="hint" style="margin:0 0 6px"></p>
    <label title="The prevailing wind slowly rounds the mass's edges, windward ones first. It never cuts into the mass."><input type="checkbox" id="erode-wind"> Wind (rounds the edges)</label>
    <p id="wind-erode-note" class="hint" style="margin:0 0 6px"></p>
    <label>Erosion speed <output id="traffic-erode-out"></output>
      <input type="range" id="traffic-erode" min="0.5" max="8" step="0.5">
    </label>
    <label>Healing <output id="traffic-heal-out"></output>
      <input type="range" id="traffic-heal" min="0" max="4" step="0.25">
    </label>
    <button type="button" class="tool" id="traffic-clear-erosion" style="width:100%;margin-bottom:8px">Clear erosion</button>
    <p class="hint" style="margin-top:0">Import a mass: where people and cars touch it they slice hair-thin strands along their routes. Each pass through a channel makes it 1% wider and its purple darker. The wind rounds convex edges and corners (windward first); the more it wears a surface the bluer it gets.</p>`;

  $("traffic-play").addEventListener("click", () => { settings.playing = !settings.playing; syncControls(); });
  $("traffic-reset").addEventListener("click", () => onReset());
  $("traffic-clear-erosion").addEventListener("click", () => onClearErosion());
  $("traffic-speed").addEventListener("change", (e) => (settings.speed = Number(e.target.value)));
  for (const key of ["people", "cars", "size", "erode", "heal"]) {
    $(`traffic-${key}`).addEventListener("input", (e) => { settings[key] = Number(e.target.value); syncControls(); });
  }
  $("traffic-left").addEventListener("change", (e) => (settings.leftHand = e.target.checked));
  // One kind of erosion works at a time, all on the same form: switching one on switches the others off. People and cars
  // count as one (the traffic) and may run together.
  const exclusive = (key, group) => (e) => {
    settings[key] = e.target.checked;
    if (e.target.checked) for (const other of ["erodePeople", "erodeCars", "erodeSun", "erodeWind"]) if (!group.includes(other)) settings[other] = false;
    syncControls();
  };
  $("erode-people").addEventListener("change", exclusive("erodePeople", ["erodePeople", "erodeCars"]));
  $("erode-cars").addEventListener("change", exclusive("erodeCars", ["erodePeople", "erodeCars"]));
  $("erode-wind").addEventListener("change", exclusive("erodeWind", ["erodeWind"]));
  $("erode-sun").addEventListener("change", exclusive("erodeSun", ["erodeSun"]));
  syncControls();
}

// Pushes `settings` into the controls (after a restore or a site change).
export function syncControls() {
  if (!$("traffic-play")) return;
  $("traffic-play").textContent = settings.playing ? "Pause" : "Play";
  $("traffic-speed").value = String(settings.speed);
  for (const key of ["people", "cars", "size", "erode", "heal"]) {
    $(`traffic-${key}`).value = settings[key];
    $(`traffic-${key}-out`).textContent = `${settings[key]}×`;
  }
  $("traffic-left").checked = settings.leftHand;
  $("erode-people").checked = settings.erodePeople;
  $("erode-cars").checked = settings.erodeCars;
  $("erode-wind").checked = settings.erodeWind;
  $("erode-sun").checked = settings.erodeSun;
}

// A line under the Sun checkbox saying what the sun growth is waiting for ("" when it is simply working).
export function setSunNote(text) {
  const el = $("sun-erode-note");
  if (el && el.textContent !== text) el.textContent = text;
}

// A line under the Wind checkbox saying what the wind erosion is waiting for ("" when it is simply working).
export function setWindNote(text) {
  const el = $("wind-erode-note");
  if (el && el.textContent !== text) el.textContent = text;
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
