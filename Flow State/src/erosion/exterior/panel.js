// CONTROLLER (exterior erosion): the controls in the side panel.
// `el` is the empty #exterior-panel container in index.html. Call notifyCutsChanged() from
// erosion/combine.js after any control changes the cuts, and registerPersist() to save settings.
import { coolingGradient, COOLING_RAMP, COOLING_MAX, COOLED_AT } from "./coolingView.js";

// Read each frame by index.js. `speed` is simulated seconds per real second.
export const settings = { playing: true, speed: 12, erodeTunnels: false, tunnelVolume: 40, tunnelStack: 10, tunnelWind: -1, tunnelMulti: false, skinSoften: 0, xray: false, showTunnels: true, showCirculation: false, showAccessible: true, showCutoff: true, coolingData: false, windParticles: false, particleWind: -2, particleSpeed: 0.5 };

const $ = (id) => document.getElementById(id);
let onClearErosion = () => {};

export function mountPanel(el, hooks = {}) {
  onClearErosion = hooks.clearErosion ?? onClearErosion;
  // (the erosion speed and the airflow slice no longer have controls: keep them at their defaults, whatever an old session saved)
  el.innerHTML = `
    <label title="Wind tunnels: the solver works out where the wind can cut through the mass to cool its interior, and opens them. Keeps its own 3D version of the mass."><input type="checkbox" id="erode-tunnels"> Wind tunnels (cut through the mass)</label>
    <label title="The wind the tunnels are worn for: one time of the warm season, or all of it, for the whole structure.">Wind for the tunnels
      <select id="tunnel-wind"><option value="-1">Whole warm season</option></select>
    </label>
    <label title="On: the tunnels are tuned for the main wind directions of the warm season together (each weighted by its hours and speed), so they still cool when the wind turns. Off: tuned for the main wind alone."><input type="checkbox" id="tunnel-multi"> Tune for all main wind directions</label>
    <label title="Draws the mass faint so that only the wind tunnels stay solid."><input type="checkbox" id="xray"> X-ray (mass faint, tunnels solid)</label>
    <label title="Shows the wind tunnels. Turn it off, with Circulation on, to see only the hallways and stairs." style="margin-left:18px"><input type="checkbox" id="show-tunnels"> Tunnels</label>
    <label title="Shows the hallways, stairs and lifts (planned under Circulation, once the tunnels are finished). Turn it off to see only the tunnels." style="margin-left:18px"><input type="checkbox" id="show-circulation"> Circulation (hallways and stairs)</label>
    <label title="The hallways that are joined to a core or an exit on the ground floor: people can get to them (amber)." style="margin-left:36px"><input type="checkbox" id="show-accessible"> Accessible (amber)</label>
    <label title="The hallways the tunnels cut off from every exit: there is room for them, but no stair reaches them (grey-blue)." style="margin-left:36px"><input type="checkbox" id="show-cutoff"> Cut off (grey-blue)</label>
    <label title="Needs X-ray. Inside the faint mass, every storey gets a floor plan shaded by how well the wind tunnels cool that part of the floor." style="margin-left:18px"><input type="checkbox" id="cooling-data"> Cooling data (shade the floors by cooling)</label>
    <div id="cool-legend" style="display:none;margin:4px 0 8px 18px">
      <div style="height:22px;border-radius:4px;border:1px solid #bbb;background:${coolingGradient()}"></div>
      <div style="position:relative;height:20px;font-size:11px;color:#555">${COOLING_RAMP.map(([p]) => `<span style="position:absolute;left:${(100 * p) / COOLING_MAX}%;transform:translateX(${p === 0 ? "0" : p === COOLING_MAX ? "-100%" : "-50%"})">${p}${p === COOLING_MAX ? "%+" : "%"}</span>`).join("")}</div>
      <div style="font-size:11px;color:#555;line-height:1.35">Cooling just above the floor: 100% = as much as right beside a tunnel carrying the open wind, fading to 0% three metres away. <b>${COOLED_AT}% and above counts as fully cooled; less counts in proportion.</b> Red: little or none; blue: fully cooled. (The colour scale stops at ${COOLING_MAX}%: anything above is the darkest blue.)</div>
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
    <button type="button" class="tool" id="erode-clear" style="width:100%;margin-bottom:8px">Clear erosion</button>
    <label title="Shows the wind as small flowing particles that curve round the massings and run through the gaps between them. Once wind tunnels are finished they also enter and leave the tunnels (turn on X-ray to see them inside the mass)."><input type="checkbox" id="wind-particles"> Wind particles (round, between and through the massings)</label>
    <label title="The time of year whose wind direction and speed the particles follow. Changing it solves the airflow for that wind (a few seconds) and then turns the particles smoothly to it.">Wind for the particles
      <select id="particle-wind"><option value="-2">Same as the tunnels</option><option value="-1">Whole warm season</option></select>
    </label>
    <label title="How fast the particles drift, relative to the real wind speed of that time of year (exaggerated so the motion is easy to see).">Particle speed <output id="particle-speed-out"></output>
      <input type="range" id="particle-speed" min="0.5" max="6" step="0.5">
    </label>
    <p id="particle-note" class="hint" style="margin:0 0 6px"></p>`;

  $("erode-play").addEventListener("click", () => { settings.playing = !settings.playing; syncControls(); });
  $("erode-clear").addEventListener("click", () => onClearErosion());
  $("erode-speed").addEventListener("change", (e) => (settings.speed = Number(e.target.value)));
  $("wind-particles").addEventListener("change", (e) => { settings.windParticles = e.target.checked; syncControls(); });
  $("particle-wind").addEventListener("change", (e) => { settings.particleWind = Number(e.target.value); syncControls(); });
  $("particle-speed").addEventListener("input", (e) => { settings.particleSpeed = Number(e.target.value); syncControls(); });
  $("erode-tunnels").addEventListener("change", (e) => { settings.erodeTunnels = e.target.checked; syncControls(); });
  $("xray").addEventListener("change", (e) => { settings.xray = e.target.checked; syncControls(); });
  $("show-tunnels").addEventListener("change", (e) => { settings.showTunnels = e.target.checked; syncControls(); });
  $("show-circulation").addEventListener("change", (e) => { settings.showCirculation = e.target.checked; syncControls(); });
  $("show-accessible").addEventListener("change", (e) => { settings.showAccessible = e.target.checked; syncControls(); });
  $("show-cutoff").addEventListener("change", (e) => { settings.showCutoff = e.target.checked; syncControls(); });
  $("cooling-data").addEventListener("change", (e) => { settings.coolingData = e.target.checked; syncControls(); });
  $("tunnel-multi").addEventListener("change", (e) => { settings.tunnelMulti = e.target.checked; syncControls(); });
  $("tunnel-wind").addEventListener("change", (e) => { settings.tunnelWind = Number(e.target.value); syncControls(); });
  syncControls();
}

// Pushes `settings` into the controls (after a restore or a site change).
export function syncControls() {
  if (!$("erode-play")) return;
  $("erode-play").textContent = settings.playing ? "Pause" : "Play";
  $("erode-speed").value = String(settings.speed);
  $("erode-tunnels").checked = settings.erodeTunnels;
  $("tunnel-wind").value = String(settings.tunnelWind);
  $("tunnel-multi").checked = settings.tunnelMulti;
  $("xray").checked = settings.xray;
  $("show-tunnels").checked = settings.showTunnels;
  $("show-circulation").checked = settings.showCirculation;
  $("show-accessible").checked = settings.showAccessible;
  $("show-cutoff").checked = settings.showCutoff;
  $("show-accessible").disabled = $("show-cutoff").disabled = !settings.showCirculation; // (they choose which hallways of the circulation are drawn)
  $("cooling-data").checked = settings.coolingData;
  $("cooling-data").disabled = !settings.xray; // the cooling data is drawn inside the x-rayed mass
  $("cool-legend").style.display = settings.xray && settings.coolingData ? "block" : "none";
  $("wind-particles").checked = settings.windParticles;
  $("particle-wind").value = String(settings.particleWind);
  $("particle-speed").value = settings.particleSpeed;
  $("particle-speed-out").textContent = `${settings.particleSpeed}×`;
}

const setNote = (id) => (text) => {
  const el = $(id);
  if (el && el.textContent !== text) el.textContent = text;
};
// A line under a checkbox saying what that feature is waiting for ("" when it is simply working).
export const setTunnelNote = setNote("tunnel-note");
export const setParticleNote = setNote("particle-note");
// Lists the parts of the warm season the particles can follow (like setWindOptions, for the particle view's own choice).
export function setParticleWindOptions(periods) {
  const el = $("particle-wind"), list = periods.map((p) => p.label).join(",");
  if (!el || el.dataset.periods === list) return;
  el.dataset.periods = list;
  el.innerHTML = `<option value="-2">Same as the tunnels</option><option value="-1">Whole warm season</option>` + periods.map((p, i) => `<option value="${i}">${p.label}</option>`).join("");
  if (settings.particleWind >= periods.length) settings.particleWind = -2;
  el.value = String(settings.particleWind);
}
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
// (This panel is not saved with the project: it always opens with the settings at the top of this file.)



