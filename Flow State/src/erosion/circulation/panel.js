// CONTROLLER (circulation): the controls in the side panel. `el` is the empty #circulation-panel container in index.html.
// The hallways and cores are planned once the wind tunnels are finished (see index.js); a control that changes the plan makes it again.
import { registerPersist } from "../../core/persist.js";

export const settings = { enabled: false, mode: "scattered", width: 2.0, serve: 10, cores: 0, loops: 3, lift: false, fill: true, extraCores: 0 };

const $ = (id) => document.getElementById(id);
let mounted = false;

export function mountPanel(el, { save = null } = {}) {
  el.innerHTML = `
    <p class="hint" style="margin-top:0">Hallways for people on every floor, with stairs and lifts between the floors, planned in the spaces the wind tunnels leave. It only reads the tunnels: it never changes them. Starts at an entrance on the ground floor.</p>
    <label title="Plans the hallways, stairs and lifts once the wind tunnels are finished."><input type="checkbox" id="circ-enabled"> Hallways and stairs (after the tunnels)</label>
    <p class="hint" style="margin:0 0 6px 18px">To see inside the mass, turn on X-ray under Exterior erosion. There you can show the tunnels and the circulation separately.</p>
    <label title="Scattered: stairs wherever the gaps between the tunnels allow, and the tunnels are never touched. Main cores: two stair cores and a lift core, each one continuous line from the ground to the top, with the hallways branching from them and only a few extra stairs; to make room, the tunnels are moved a little to go round the cores (and put back when you switch to Scattered or turn this off).">Circulation type
      <select id="circ-mode">
        <option value="scattered">Scattered stairs (tunnels untouched)</option>
        <option value="main">Main cores: 2 stairs + a lift (tunnels move round them)</option>
      </select>
    </label>
    <label title="On: hallways in every part of the floors that has room for them. Extra stairs are added wherever one can join a part to the rest, and parts that no stair can reach get hallways of their own (drawn grey), and an exit if they touch the ground floor and have a way to a wall. The walk to a hallway is then at most 4 m. Off: hallways only as far as the reach below, and only where a stair joins them to the rest."><input type="checkbox" id="circ-fill"> Fill every space that has room</label>
    <label title="Main cores only. Hallways the tunnels cut off from every exit (grey-blue) can only be reached by a stair that fits between them and the rest, and often none does. A core may move the tunnels, so each extra stair core is a full-height stair placed where the most cut-off hallway is, and kept only if it makes more hallway reachable. More of the tunnels are moved.">Extra stair cores (main cores only)
      <select id="circ-extra">
        <option value="0">None</option>
        <option value="1">1</option>
        <option value="2">2</option>
        <option value="3">3</option>
        <option value="4">4</option>
      </select>
    </label>
    <label>Hallway width <output id="circ-width-out"></output>
      <input type="range" id="circ-width" min="1.2" max="3.2" step="0.2">
    </label>
    <label title="Every part of a floor should be within this walk of a hallway.">Walk to a hallway at most <output id="circ-serve-out"></output>
      <input type="range" id="circ-serve" min="6" max="20" step="1">
    </label>
    <label title="Puts a lift at one end of every stair. That makes each link 2.4 m longer, so it fits in fewer of the gaps between the tunnels: floors may be left unconnected."><input type="checkbox" id="circ-lift"> Include a lift (needs more room)</label>
    <label title="The most stairs between two neighbouring floors. Auto adds them while they bring more floor within reach. With Main cores these are the extra stairs, on top of the cores: Auto adds up to 2 where a part of a floor would otherwise be cut off.">Stairs between two floors (the extra ones, with Main cores)
      <select id="circ-cores">
        <option value="0">Auto</option>
        <option value="-1">None (main cores only)</option>
        <option value="1">1</option>
        <option value="2">2</option>
        <option value="3">3</option>
        <option value="4">4</option>
      </select>
    </label>
    <label title="Straight shortcuts that join two hallways far apart by the network, so that the plan has loops.">Loops per floor <output id="circ-loops-out"></output>
      <input type="range" id="circ-loops" min="0" max="8" step="1">
    </label>
    <p id="circ-note" class="hint"></p>
    <div id="circ-report" class="stats"></div>
    <button type="button" class="tool" id="circ-save" title="Saves what the plan was made from (the tunnels, as a .json file) so that it can be looked at again elsewhere.">Save a snapshot of the tunnels (.json)</button>`;
  mounted = true;
  $("circ-save").addEventListener("click", () => save?.());
  const bind = (id, key, parse, out, fmt) => {
    $(id).addEventListener("input", (e) => { settings[key] = parse(e.target); syncControls(); });
    if (out) $(out).textContent = fmt(settings[key]);
  };
  $("circ-enabled").addEventListener("change", (e) => { settings.enabled = e.target.checked; });
  $("circ-lift").addEventListener("change", (e) => { settings.lift = e.target.checked; });
  $("circ-fill").addEventListener("change", (e) => { settings.fill = e.target.checked; });
  bind("circ-width", "width", (t) => t.valueAsNumber, "circ-width-out", (v) => `${v.toFixed(1)} m`);
  bind("circ-serve", "serve", (t) => t.valueAsNumber, "circ-serve-out", (v) => `${v} m`);
  bind("circ-loops", "loops", (t) => t.valueAsNumber, "circ-loops-out", (v) => `${v}`);
  $("circ-cores").addEventListener("change", (e) => { settings.cores = Number(e.target.value); });
  $("circ-mode").addEventListener("change", (e) => { settings.mode = e.target.value; syncControls(); });
  $("circ-extra").addEventListener("change", (e) => { settings.extraCores = Number(e.target.value); });
  syncControls();
}

export function syncControls() {
  if (!mounted) return;
  $("circ-enabled").checked = settings.enabled;
  $("circ-lift").checked = settings.lift;
  $("circ-fill").checked = settings.fill;
  $("circ-mode").value = settings.mode;
  $("circ-extra").value = String(settings.extraCores);
  $("circ-extra").disabled = settings.mode !== "main";
  $("circ-lift").disabled = settings.mode === "main"; // (the main cores have a lift core of their own)
  $("circ-width").value = settings.width;
  $("circ-width-out").textContent = `${settings.width.toFixed(1)} m`;
  $("circ-serve").value = settings.serve;
  $("circ-serve-out").textContent = `${settings.serve} m`;
  $("circ-cores").value = String(settings.cores);
  $("circ-loops").value = settings.loops;
  $("circ-loops-out").textContent = `${settings.loops}`;
}

// A line under the controls: what the plan is waiting for, or doing ("" for nothing).
export function setNote(text) {
  if (mounted && $("circ-note").textContent !== text) $("circ-note").textContent = text;
}

// The lines of the report (what was planned, and what could not be): [string].
export function setReport(lines) {
  if (!mounted) return;
  const box = $("circ-report"), text = lines.join("\n");
  if (box.dataset.text === text) return;
  box.dataset.text = text;
  box.replaceChildren(...lines.map((line) => { const p = document.createElement("p"); p.style.margin = "2px 0"; p.textContent = line; return p; }));
}

registerPersist("circulation", {
  capture: () => ({ ...settings }),
  restore: (saved) => { Object.assign(settings, saved); syncControls(); },
});
