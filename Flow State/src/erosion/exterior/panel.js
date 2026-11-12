// CONTROLLER (exterior erosion): the controls in the side panel.
// `el` is the empty #exterior-panel container in index.html. Call notifyCutsChanged() from
// erosion/combine.js after any control changes the cuts, and registerPersist() to save settings.
import { registerPersist } from "../../core/persist.js";

// Read each frame by index.js. `speed` is simulated seconds per real second.
export const settings = { playing: true, speed: 4, erode: 2, erodeWind: false, erodeSun: false, erodeTunnels: false, tunnelVolume: 20, tunnelBand: -1, flowDebug: false, flowHeight: 2 };

const $ = (id) => document.getElementById(id);
let onClearErosion = () => {};

export function mountPanel(el, hooks = {}) {
  onClearErosion = hooks.clearErosion ?? onClearErosion;
  el.innerHTML = `
    <p class="hint" style="margin-top:0">Work on the mass with one of these at a time (none by default); each carries on from the shape the other left.</p>
    <label title="The mass grows towards the sun: the longer the sun hits a roof or wall, the more it grows. Runs while the Sun panel plays a day or the year."><input type="checkbox" id="erode-sun"> Sun (grows towards the sun)</label>
    <p id="sun-erode-note" class="hint" style="margin:0 0 6px"></p>
    <label title="The prevailing wind slowly rounds the mass's edges, windward ones first. It never cuts into the mass."><input type="checkbox" id="erode-wind"> Wind (rounds the edges)</label>
    <p id="wind-erode-note" class="hint" style="margin:0 0 6px"></p>
    <label title="Wind tunnels: the solver works out where the wind can cut through the mass to cool its interior, and opens them. Keeps its own 3D version of the mass."><input type="checkbox" id="erode-tunnels"> Wind tunnels (cut through the mass)</label>
    <label title="Every pair of storeys (14 ft each) gets tunnels of its own for a different part of the warm season, or work on just one pair. Tunnels never leave their pair, so they span two storeys at most.">Floors
      <select id="tunnel-band"><option value="-1">All floors</option></select>
    </label>
    <label title="The most of the mass the tunnels may carve away. The wind keeps widening them until they reach this.">Tunnel volume <output id="tunnel-volume-out"></output>
      <input type="range" id="tunnel-volume" min="2" max="30" step="1">
    </label>
    <p id="tunnel-note" class="hint" style="margin:0 0 6px;white-space:pre-line"></p>
    <div class="tools">
      <button type="button" class="tool" id="erode-play">Pause</button>
      <select id="erode-speed" aria-label="Simulation speed">
        <option value="1">Real time</option>
        <option value="4">4×</option>
        <option value="12">12×</option>
      </select>
    </div>
    <label>Erosion speed <output id="erode-out"></output>
      <input type="range" id="erode" min="0.5" max="8" step="0.5">
    </label>
    <button type="button" class="tool" id="erode-clear" style="width:100%;margin-bottom:8px">Clear erosion</button>
    <label title="Test view for the wind tunnels: solves how the prevailing wind flows round and through the mass and the buildings, and shows the air speed on a horizontal slice (blue slower, red faster than the open wind). Does not change the mass."><input type="checkbox" id="flow-debug"> Airflow slice (test)</label>
    <label>Slice height <output id="flow-height-out"></output>
      <input type="range" id="flow-height" min="0" max="60" step="0.5">
    </label>
    <p id="flow-note" class="hint" style="margin:0 0 6px"></p>
    <p class="hint" style="margin-top:0">Import a mass. The wind rounds convex edges and corners (windward first); the more it wears a surface the bluer it gets.</p>`;

  $("erode-play").addEventListener("click", () => { settings.playing = !settings.playing; syncControls(); });
  $("erode-clear").addEventListener("click", () => onClearErosion());
  $("erode-speed").addEventListener("change", (e) => (settings.speed = Number(e.target.value)));
  $("erode").addEventListener("input", (e) => { settings.erode = Number(e.target.value); syncControls(); });
  $("flow-debug").addEventListener("change", (e) => (settings.flowDebug = e.target.checked));
  $("flow-height").addEventListener("input", (e) => { settings.flowHeight = Number(e.target.value); syncControls(); });
  // One kind of erosion works at a time, all on the same form: switching one on switches the other off.
  const exclusive = (key) => (e) => {
    settings[key] = e.target.checked;
    if (e.target.checked) for (const other of ["erodeSun", "erodeWind", "erodeTunnels"]) if (other !== key) settings[other] = false;
    syncControls();
  };
  $("erode-tunnels").addEventListener("change", exclusive("erodeTunnels"));
  $("tunnel-volume").addEventListener("input", (e) => { settings.tunnelVolume = Number(e.target.value); syncControls(); });
  $("tunnel-band").addEventListener("change", (e) => { settings.tunnelBand = Number(e.target.value); syncControls(); });
  $("erode-wind").addEventListener("change", exclusive("erodeWind"));
  $("erode-sun").addEventListener("change", exclusive("erodeSun"));
  syncControls();
}

// Pushes `settings` into the controls (after a restore or a site change).
export function syncControls() {
  if (!$("erode-play")) return;
  $("erode-play").textContent = settings.playing ? "Pause" : "Play";
  $("erode-speed").value = String(settings.speed);
  $("erode").value = settings.erode;
  $("erode-out").textContent = `${settings.erode}×`;
  $("erode-wind").checked = settings.erodeWind;
  $("erode-sun").checked = settings.erodeSun;
  $("erode-tunnels").checked = settings.erodeTunnels;
  $("tunnel-band").value = String(settings.tunnelBand);
  $("tunnel-volume").value = settings.tunnelVolume;
  $("tunnel-volume-out").textContent = `${settings.tunnelVolume}%`;
  $("flow-debug").checked = settings.flowDebug;
  $("flow-height").value = settings.flowHeight;
  $("flow-height-out").textContent = `${settings.flowHeight} m`;
}

const setNote = (id) => (text) => {
  const el = $(id);
  if (el && el.textContent !== text) el.textContent = text;
};
// A line under a checkbox saying what that feature is waiting for ("" when it is simply working).
export const setSunNote = setNote("sun-erode-note");
export const setWindNote = setNote("wind-erode-note");
export const setFlowNote = setNote("flow-note");
export const setTunnelNote = setNote("tunnel-note");

// Lists the pairs of floors that get tunnels in the Floors choice (`bands`: their numbers, 0 = floors 1-2), keeping the one chosen.
export function setBandOptions(bands) {
  const el = $("tunnel-band"), list = bands.join(",");
  if (!el || el.dataset.bands === list) return;
  el.dataset.bands = list;
  el.innerHTML = `<option value="-1">All floors</option>` + bands.map((b) => `<option value="${b}">Floors ${2 * b + 1}–${2 * b + 2}</option>`).join("");
  if (!bands.includes(settings.tunnelBand)) settings.tunnelBand = -1;
  el.value = String(settings.tunnelBand);
}

registerPersist("exteriorErosion", {
  capture: () => ({ ...settings }),
  restore: (saved) => {
    Object.assign(settings, saved);
    syncControls();
  },
});



