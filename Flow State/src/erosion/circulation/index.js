// Mounts the circulation (hallways, stairs and lifts): once the wind tunnels are finished, reads them and plans the hallways (rules.js), and draws the plan
// (view.js). In "scattered" mode nothing here changes the tunnels. In "main" mode (two stair cores and a lift core) the tubes are moved a little to go round
// the cores: the plan comes back with the moved tunnels (a graph), which are applied to the real tunnels with tunnels.applyRoute (and put back with
// restoreRoute when the mode is changed or the circulation is turned off). The plan is always made from the tunnels as they were before (baseGraph).
import { $ } from "../../core/dom.js";
import { on } from "../../core/events.js";
import { state, layers } from "../../core/state.js";
import { onFrame } from "../../view/scene.js";
import { getFinishedTunnels, setSkinCuts } from "../exterior/index.js";
import { STOREY } from "../exterior/tunnels.js";
import { settings as exteriorSettings } from "../exterior/panel.js";
import { planCirculation } from "./rules.js";
import { createCirculationView } from "./view.js";
import { mountPanel, settings, setNote, setReport } from "./panel.js";

const SETTLE = 300; // ms a changed control waits before the plan is made again (so that dragging a slider does not plan at every step)

let view = null;
let plan = null; // the plan as made, and the key of what it was made from
let planKey = "";
let wantKey = "", wantSince = 0;

// The roads and paths round the site as line segments in world metres (x east, z south): where the entrance faces.
function streetsOf() {
  const out = [];
  for (const list of [state.features?.roads ?? [], state.features?.paths ?? []]) {
    for (const r of list) for (let i = 0; i + 1 < r.pts.length; i++) out.push([r.pts[i].x, -r.pts[i].y, r.pts[i + 1].x, -r.pts[i + 1].y]);
  }
  return out;
}

// A plain copy of what the plan needs from the finished tunnels.
function snapshot(t) {
  const b = t.massBox;
  return { storey: STOREY, storeys: t.storeys, frame: t.frame, heightAt: t.heightAt, graph: t.baseGraph(), spaces: t.spaces, box: { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, top: b.top }, streets: streetsOf() };
}

const pct = (v) => `${Math.round(100 * v)}%`;
function reportOf(p) {
  const lines = [];
  const st = p.stats;
  if (p.mode === "main") {
    const main = p.cores.filter((c) => c.main), stairs = main.filter((c) => c.kind === "stair").length, lifts = main.filter((c) => c.kind === "lift").length;
    lines.push(`Main cores: ${stairs} stair${stairs === 1 ? "" : "s"} and ${lifts} lift${lifts === 1 ? "" : "s"}, ${main.length ? `floors ${Math.min(...main.map((c) => c.s0)) + 1} to ${Math.max(...main.map((c) => c.s1)) + 1}` : "none placed"}, each one continuous line; ${p.cores.length - main.length} supplemental stair${p.cores.length - main.length === 1 ? "" : "s"}.`);
    if (p.reroute) lines.push(`The tunnels were moved a little to go round the cores: ${p.reroute.moved} junction${p.reroute.moved === 1 ? "" : "s"} moved and ${p.reroute.detoured} tube${p.reroute.detoured === 1 ? "" : "s"} bent round them (turn the circulation off, or choose Scattered, to put them back).`);
    lines.push(`${st.length.toFixed(0)} m of hallway on ${st.floorsServed} of ${p.storeys} floors (${pct(st.length ? st.reachableLength / st.length : 0)} joined to an exit).`);
  } else {
    lines.push(`${st.links} stair${p.lift ? "-and-lift" : ""} link${st.links === 1 ? "" : "s"} between floors, making ${st.cores} core${st.cores === 1 ? "" : "s"}; ${st.length.toFixed(0)} m of hallway on ${st.floorsServed} of ${p.storeys} floors (${pct(st.length ? st.reachableLength / st.length : 0)} joined to an entrance).`);
  }
  p.entrances.forEach((e, i) => lines.push(`${p.mode === "main" ? (i ? "Exit" : "Main entrance") : "Entrance"}${p.mode === "main" && i ? ` ${i + 1}` : p.mode === "main" ? "" : ` ${i + 1}`} on the ground floor${e.street != null ? `, ${e.street.toFixed(0)} m from the nearest street or path` : ""}.`));
  p.floors.forEach((f, s) => { if (f) lines.push(`Floor ${s + 1}: ${f.length.toFixed(0)} m of hallway in ${f.pieces} piece${f.pieces === 1 ? "" : "s"}, ${f.loops} loop${f.loops === 1 ? "" : "s"}, ${pct(f.served)} of the floor within reach.`); });
  for (const w of p.warnings) lines.push(`⚠ ${w}`);
  return lines;
}

// Saves what the plan was made from (the tunnels' tubes, the spaces, the axes, and the mass's heights on a 1 m grid) as a .json file, so that a plan that
// does not come out as expected can be looked at and run again elsewhere.
let lastTunnels = null;
function saveSnapshot() {
  const t = lastTunnels;
  if (!t) return setNote("Nothing to save yet: wait for the tunnels to finish.");
  const site = snapshot(t), b = site.box, step = 1, x0 = b.x0 - 3, z0 = b.z0 - 3, nx = Math.ceil((b.x1 - b.x0 + 6) / step), nz = Math.ceil((b.z1 - b.z0 + 6) / step), heights = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) heights.push(Math.round(t.heightAt(x0 + (i + 0.5) * step, z0 + (j + 0.5) * step) * 100) / 100);
  const text = JSON.stringify({ site: { ...site, heightAt: undefined }, heights: { x0, z0, step, nx, nz, h: heights }, settings: { ...settings } });
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = "circulation-snapshot.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function frame() {
  const finished = getFinishedTunnels();
  const wantMain = settings.enabled && settings.mode === "main";
  // the tunnels are only moved while the main cores are wanted: otherwise they are put back as they were
  if (finished?.rerouted && !wantMain) finished.restoreRoute();
  const t = settings.enabled ? finished : null;
  if (!t) {
    plan = null; planKey = ""; wantKey = "";
    setSkinCuts(null, "");
    view.clear();
    setNote(settings.enabled ? "Waiting for the wind tunnels to finish (turn them on under Passive cooling)." : "");
    setReport([]);
    return;
  }
  lastTunnels = t;
  // (the versions of the tunnels before they were moved, which do not change when the cores move them: or the plan would be made again for ever)
  const key = `${t.id}|${t.baseVersion}|${t.baseVoxVersion}|${settings.mode}|${settings.width}|${settings.serve}|${settings.cores}|${settings.loops}|${settings.lift}|${settings.fill}|${settings.extraCores}|${settings.setback}`;
  if (key !== planKey) {
    if (key !== wantKey) { wantKey = key; wantSince = performance.now(); }
    setNote(wantMain ? "Planning the main cores and moving the tunnels round them…" : "Planning the hallways…");
    if (performance.now() - wantSince >= SETTLE) {
      try {
        plan = planCirculation(snapshot(t), { mode: settings.mode, width: settings.width, serve: settings.serve, cores: settings.cores, loops: settings.loops, lift: settings.lift, fill: settings.fill, extraCores: settings.extraCores, setback: settings.setback });
        if (plan.graph) t.applyRoute(plan.graph); // (the tunnels moved round the main cores)
        else if (t.rerouted) t.restoreRoute(); // (no main cores could be placed: the tunnels stay as they were)
        setReport(reportOf(plan));
        setNote("");
      } catch (e) {
        plan = null;
        console.error("Hallway planning failed:", e);
        setNote("The hallways could not be planned (see the console).");
        setReport([]);
      }
      planKey = key;
    }
  }
  // the skin is cut along the hallways where they reach it: only while the circulation is shown (else there would be openings with nothing behind them)
  const cutsOn = !!plan && exteriorSettings.showCirculation;
  setSkinCuts(cutsOn ? { frame: { A: plan.grid.A, B: plan.grid.B }, rects: plan.paths ?? [] } : null, cutsOn ? planKey : "");
  view.setParts(exteriorSettings.showAccessible, exteriorSettings.showCutoff); // (which hallways: the amber ones, the grey ones, or both)
  view.update(layers.model, plan, planKey, exteriorSettings.showCirculation); // (shown or hidden with the checkbox under X-ray, in Passive cooling)
}

export function mountCirculation() {
  view = createCirculationView();
  mountPanel($("circulation-panel"), { save: saveSnapshot });
  on("site:cleared", () => { plan = null; planKey = ""; wantKey = ""; setSkinCuts(null, ""); view.clear(); });
  on("mass:changed", () => { plan = null; planKey = ""; wantKey = ""; setSkinCuts(null, ""); view.clear(); });
  onFrame(frame);
}
