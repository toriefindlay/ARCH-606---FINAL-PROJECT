// CONTROLLER (exterior erosion): the controls in the side panel.
// `el` is the empty #exterior-panel container in index.html. Call notifyCutsChanged() from
// erosion/combine.js after any control changes the cuts, and registerPersist() to save settings.
import { registerPersist } from "../../core/persist.js";
import { coolingGradient, COOLING_RAMP, COOLED_AT } from "./coolingView.js";

// Read each frame by index.js. `speed` is simulated seconds per real second.
export const settings = { playing: true, speed: 4, erode: 2, erodeWind: false, erodeSun: false, erodeTunnels: false, tunnelVolume: 20, tunnelWind: -1, xray: false, coolingData: false, flowDebug: false, flowHeight: 2 };

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
    <label title="The wind the tunnels are worn for: one time of the warm season, or all of it, for the whole structure.">Wind for the tunnels
      <select id="tunnel-wind"><option value="-1">Whole warm season</option></select>
    </label>
    <label title="The most of the mass the tunnels may carve away. The wind keeps widening them until they reach this.">Tunnel volume <output id="tunnel-volume-out"></output>
      <input type="range" id="tunnel-volume" min="2" max="30" step="1">
    </label>
    <label title="Draws the mass faint so that only the wind tunnels stay solid."><input type="checkbox" id="xray"> X-ray (mass faint, tunnels solid)</label>
    <label title="Needs X-ray. Inside the faint mass, every storey gets a floor plan shaded by how well the wind tunnels cool that part of the floor." style="margin-left:18px"><input type="checkbox" id="cooling-data"> Cooling data (shade the floors by cooling)</label>
    <div id="cool-legend" style="display:none;margin:4px 0 8px 18px">
      <div style="height:22px;border-radius:4px;border:1px solid #bbb;background:${coolingGradient()}"></div>
      <div style="position:relative;height:20px;font-size:11px;color:#555">${COOLING_RAMP.map(([p]) => `<span style="position:absolute;left:${p}%;transform:translateX(${p === 0 ? "0" : p === 100 ? "-100%" : "-50%"})">${p}%</span>`).join("")}</div>
      <div style="font-size:11px;color:#555;line-height:1.35">Cooling just above the floor: 100% = as much as right beside a tunnel carrying the open wind, fading to 0% three metres away. <b>${COOLED_AT}% and above counts as fully cooled; less counts in proportion.</b> Red: little or none; blue: fully cooled.</div>
    </div>
    <p id="tunnel-note" class="hint" style="margin:0 0 6px"></p>
    <details id="floor-data" open style="margin:0 0 8px">
      <summary style="cursor:pointer;font-weight:600;font-size:13px">Floor data (open a pair of floors for its numbers)</summary>
      <div id="floor-rows"></div>
    </details>
    <div class="tools">
      <button type="button" class="tool" id="erode-play">Pause</button>
      <select id="erode-speed" aria-label="Simulation speed">
        <option value="1">Real time</option>
        <option value="4">4×</option>
        <option value="12">12×</option>
      </select>
    </div>
    <label title="How fast the wind tunnels are eroded out of the mass, from a dimple in the wall to the whole way through: 2× takes half a minute, 8× under ten seconds.">Erosion speed <output id="erode-out"></output>
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
  $("xray").addEventListener("change", (e) => { settings.xray = e.target.checked; syncControls(); });
  $("cooling-data").addEventListener("change", (e) => { settings.coolingData = e.target.checked; syncControls(); });
  $("tunnel-wind").addEventListener("change", (e) => { settings.tunnelWind = Number(e.target.value); syncControls(); });
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
  $("tunnel-wind").value = String(settings.tunnelWind);
  $("xray").checked = settings.xray;
  $("cooling-data").checked = settings.coolingData;
  $("cooling-data").disabled = !settings.xray; // the cooling data is drawn inside the x-rayed mass
  $("cool-legend").style.display = settings.xray && settings.coolingData ? "block" : "none";
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
// The floor data table: one collapsible row per pair of floors. `rows`: [{ b, title, summary, fields: [[label, value], ...] }] in floor order.
// Rows are kept (and stay open or shut) between calls; only text that changed is written.
const floorRows = new Map(); // band number -> { details, summary, body, labels }
export function setFloorRows(rows) {
  const host = $("floor-rows");
  if (!host) return;
  const keep = new Set(rows.map((r) => r.b));
  for (const [b, el] of floorRows) if (!keep.has(b)) { el.details.remove(); floorRows.delete(b); }
  let previous = null;
  for (const r of rows) {
    let el = floorRows.get(r.b);
    if (!el) {
      const details = document.createElement("details"), summary = document.createElement("summary"), body = document.createElement("table");
      details.style.cssText = "border-bottom:1px solid #d6cfc3;padding:3px 0";
      summary.style.cssText = "cursor:pointer;font-size:12px;line-height:1.35";
      body.style.cssText = "width:100%;font-size:11.5px;border-collapse:collapse;margin:4px 0 2px";
      details.append(summary, body);
      el = { details, summary, body, labels: "" };
      floorRows.set(r.b, el);
    }
    const text = `${r.title} · ${r.summary}`;
    if (el.summary.textContent !== text) el.summary.textContent = text;
    const labels = r.fields.map((f) => f[0]).join("|");
    if (labels !== el.labels) { // the fields are new or different: rebuild the table
      el.labels = labels;
      el.body.replaceChildren(...r.fields.map(([label]) => {
        const tr = document.createElement("tr"), th = document.createElement("th"), td = document.createElement("td");
        th.textContent = label;
        th.style.cssText = "text-align:left;vertical-align:top;font-weight:600;padding:2px 6px 2px 0;white-space:nowrap;color:#555";
        td.style.cssText = "padding:2px 0;vertical-align:top";
        tr.append(th, td);
        return tr;
      }));
    }
    r.fields.forEach(([, value], i) => { const td = el.body.rows[i].cells[1]; if (td.textContent !== value) td.textContent = value; });
    if (!el.details.parentNode || el.details.previousElementSibling !== previous) host.insertBefore(el.details, previous ? previous.nextSibling : host.firstChild);
    previous = el.details;
  }
}

// Lists the parts of the warm season the tunnels can be worn for (`periods`: getWarmPeriods(), each with a label), keeping the one chosen.
export function setWindOptions(periods) {
  const el = $("tunnel-wind"), list = periods.map((p) => p.label).join(",");
  if (!el || el.dataset.periods === list) return;
  el.dataset.periods = list;
  el.innerHTML = `<option value="-1">Whole warm season</option>` + periods.map((p, i) => `<option value="${i}">${p.label}</option>`).join("");
  if (settings.tunnelWind >= periods.length) settings.tunnelWind = -1;
  el.value = String(settings.tunnelWind);
}
registerPersist("exteriorErosion", {
  capture: () => ({ ...settings }),
  restore: (saved) => {
    Object.assign(settings, saved);
    syncControls();
  },
});



