import { $ } from "../../core/dom.js";
import { on } from "../../core/events.js";
import { state, layers } from "../../core/state.js";
import { onFrame } from "../../view/scene.js";
import { getMassInfo } from "../../mass/model3dm.js";
import { registerCutProvider, collectCuts, notifyCutsChanged } from "../combine.js";
import { provideCuts } from "./rules.js";
import { createForm } from "./form.js";
import { createWindErosion, setActiveForm } from "./windErode.js";
import { createSunGrowth } from "./sunGrow.js";
import { createVoxelMass, solveFlow } from "./voxelFlow.js";
import { createFlowView } from "./flowView.js";
import { createTunnels, REACH, ZONE } from "./tunnels.js";
import { setActiveTunnels } from "./tunnelCut.js";
import { renderPreview, createFormView, createTunnelView, setXray } from "./view.js";
import { mountPanel, settings, syncControls, setWindNote, setSunNote, setFlowNote, setTunnelNote, setBandOptions } from "./panel.js";
import { getWind, getWarmPeriods, requestWind, setWindObstacle, downwind } from "../../site/wind.js";
import { cityHeights } from "../../site/windFlow.js";

const RESCAN_DELAY = 350; // ms after the mass stops moving before it is analysed again
const WIND_INTERVAL = 0.6; // seconds between updates of the wind-rounded shape
const FLOW_DELAY = 1500; // ms after the form last changed before the wind streaks bend around the new shape
const SUN_INTERVAL = 0.1; // seconds between times the sun's warmth is collected
const SUN_SHAPE_INTERVAL = 0.6; // seconds between updates of the grown shape
const SUN_IDLE = 1500; // ms without the sun moving before the panel says what to press

let form = null; // the one shape the sun and the wind work on (see form.js)
let formView = null;
let tunnelView = null; // the tunnels' walls, and the hole they leave in the mass's own surface
let tunnelShown = ""; // which tunnels, and which state of them, the view and the cuts were last given
let tunnelBusy = false; // a step of the tunnels (a solve) is running
let tunnelWorking = false; // the search for the tunnel shapes is under way: the shapes tried are not shown, only the result
let tunnelWinds = []; // the wind of every pair of floors (by band number), as last worked out by tunnelFrame
let tunnelStats = null; // per pair of floors: the air speed in its tunnels and the cooling, in its last solution
let tunnels = null; // the persistent voxel mass the wind tunnels are carved from (tunnels.js), built from the form when first wanted
let mode = "none"; // the kind of erosion working now: "sun" | "wind" | "tunnels" | "none" (the panel allows one at a time)
let phase = 0; // changes whenever the mode does, so that slow set-up for an earlier mode is dropped
let windErosion = null; // the wind's rounding of the form as it was when the wind started, once worked out
let windBuilding = false; // it is being worked out
let windClock = 0; // simulated seconds of wind not yet applied
let windTick = 0;
let flowTimer = 0;
let flowView = null; // the airflow slice (test view)
let flowVox = null; // the voxel mass the airflow was solved on
let flowResult = null; // the airflow
let flowKey = ""; // what the airflow was solved for: the mass, its form and the wind direction
let flowBusy = false;
let massVersion = 0; // changes whenever the mass does, so that slow set-up for an old mass is dropped
let sunGrowth = null; // the sun's growth of the form as it was when the sun started, once worked out
let sunBuilding = false;
let sunHours = 0; // simulated hours of sun not yet applied
let sunVec = null; // where the sun last was
let sunSeen = 0; // when (ms) the Sun panel last advanced the sun
let sunTick = 0;
let sunShape = 0; // seconds since the grown shape was last redrawn
let rescanTimer = 0;

const currentMode = () => (settings.erodeSun ? "sun" : settings.erodeWind ? "wind" : settings.erodeTunnels ? "tunnels" : "none");

// The sun's and the wind's set-up is worked out from the form as it is when they start, so it is dropped whenever the form
// is changed by anything else (the other mode, or clearing).
function resetPhases() {
  phase++;
  windErosion = sunGrowth = null;
  windBuilding = sunBuilding = false;
  windClock = windTick = sunHours = sunTick = sunShape = 0;
  setWindNote("");
  setSunNote("");
}

// Switching mode: the new one carries on from the form as the last one left it.
function syncMode() {
  const next = currentMode();
  if (next === mode) return;
  mode = next;
  resetPhases();
}

// The form changed (the sun or the wind worked on it): redraw it, tell the pipeline, and let the wind streaks follow it.
function formChanged() {
  formView.update(form);
  notifyCutsChanged();
  clearTimeout(flowTimer);
  flowTimer = setTimeout(() => form && setWindObstacle(form.asScan()), FLOW_DELAY);
}

// The mass moved, scaled or went away: its shape no longer fits, so start again from the new mass.
function stopMass() {
  clearTimeout(rescanTimer);
  const had = !!form?.changed();
  stopForm();
  if (had) notifyCutsChanged();
}

function stopForm() {
  massVersion++;
  clearTimeout(flowTimer);
  form = null;
  resetPhases();
  setActiveForm(null);
  formView?.clear();
  flowView?.clear();
  flowVox = flowResult = null;
  flowKey = "";
  tunnels = null;
  tunnelStats = null;
}

// The wind tunnels' voxel mass is built from the form the first time it is wanted and then kept, so tunnels stay carved
// between solves and when another mode is switched on and off. It is built afresh if the sun or the wind has changed the form
// since (the tunnels would no longer fit the shape), or if the mass moved (stopForm).
function ensureTunnels() {
  if (tunnels && tunnels.builtOn !== form.version) tunnels = null;
  tunnels ??= createTunnels(form, { cityHeight: cityHeights(state.site.radius, state.features?.buildings) });
  return tunnels;
}

// The tunnels are worked out one step per pass, strictly one thing at a time (see nextWork): try another shape for a pair of
// floors (cut it, solve its airflow, score the cooling) or solve an airflow again. Every pair of floors has its own wind, a different part of
// the warm season (getWarmPeriods), so that whichever part of the year it is, one pair of floors or another has air moving through it.
function tunnelFrame() {
  tunnelWorking = false;
  if (!settings.erodeTunnels) return setTunnelNote("");
  if (!form || !getMassInfo()) return setTunnelNote("Place a .3dm mass to cut wind tunnels through.");
  requestWind();
  if (!getWind()) return setTunnelNote("Loading wind data…");
  const t = ensureTunnels();
  if (!t) return setTunnelNote("");
  setBandOptions(t.usable);
  if (!t.usable.length) return setTunnelNote("The mass is too low for tunnels: they need a whole storey (14 ft) of mass.");
  // The wind of each pair of floors: the warm season in as many consecutive periods as there are pairs. (The ordinary prevailing
  // wind is used if the data has no temperatures.)
  const periods = getWarmPeriods(t.usable.length); // one period for each pair of floors that gets tunnels (thin ones are skipped)
  const winds = []; // by band number
  t.usable.forEach((b, n) => {
    const p = periods.length ? periods[n % periods.length] : { ...getWind(), label: "all year" };
    winds[b] = { ...p, dir: downwind(p.from) };
  });
  tunnelWinds = winds;
  const chosen = t.usable.includes(settings.tunnelBand) ? settings.tunnelBand : -1;
  const limit = settings.tunnelVolume / 100, key = `${limit}`;
  const plan = `${chosen}|${key}|${t.usable.map((b) => winds[b].from).join(",")}`;
  if (t.plan !== plan) { // other floors, winds or volume limit: the mass is put back and the tunnels start again
    t.plan = plan;
    t.setActive(chosen < 0 ? t.usable : [chosen]);
    tunnelStats = null;
  }
  const work = t.failed === key ? null : nextWork(t, winds, key);
  tunnelWorking = work?.what === "search" && settings.playing;
  const lines = t.active.map((b) => {
    const w = winds[b], s = tunnelStats?.[b], cool = s?.cooling;
    return `Floors ${2 * b + 1}–${2 * b + 2}, ${w.label} (wind from ${w.from.toFixed(0)}°${w.meanTemp ? `, ${w.meanTemp.toFixed(0)} °C` : ""}): ${(100 * t.bandShare(b)).toFixed(1)}% carved` +
      shape(t.shapeInfo(b)) +
      (s && s.mean > 0 ? `, tunnel air ${s.mean.toFixed(2)}× the open wind` : "") +
      (cool && s.mean > 0 ? `, ${cool.coverage.map((v) => `${(100 * v).toFixed(0)}%`).join(" / ")} of the two floors within ${REACH} m of moving air (evenness ${(100 * cool.evenness).toFixed(0)}%)` : "");
  });
  const head = t.failed === key ? "Stopped (see the console)"
    : !work ? "Settled" : !settings.playing ? "Paused" : "Searching for the best tunnel shapes";
  setTunnelNote(`${head} (limit ${settings.tunnelVolume}% of a pair's mass):\n${lines.join("\n")}`);
  if (tunnelBusy || !work || !settings.playing) return;
  tunnelStep(t, work, winds, limit, key);
}

// What the note says of the shape of a pair of floors' tunnels: the numbers being tried, or the ones chosen.
function shape({ tried, rough, chosen, shape: p }) {
  if (!p) return "";
  return `, ${chosen ? "tunnels" : rough ? `quick answer, refining (${tried} shapes so far)` : `trying quickly (${tried} shapes so far)`} ${p.spacing} m apart, ${p.throat} m wide at the throat, mouth ×${p.mouth}, exit ×${p.exit}, throat ${p.pos * 100}% along, in the ${ZONE} m ceiling void of each storey`;
}

// The next thing to do, one pair of floors at a time: search for the shape of every pair's tunnels, then solve again whatever the
// later carving has left out of date, so that the numbers shown are for the tunnels as they are. null once there is nothing left.
function nextWork(t, winds, key) {
  for (const b of t.active) if (!t.isRough(b)) return { b, what: "search" }; // the quick answer for every pair of floors first
  for (const b of t.active) if (!t.isDone(b, key)) return { b, what: "search" }; // then the fine search for each
  for (const b of t.active) if (t.stale(b, winds[b].dir)) return { b, what: "solve" };
  return null;
}

// Keeps what is drawn, and the cut offered to the pipeline, in step with the tunnels: shown whenever there are tunnels that fit the
// form (also while another mode is on), and cleared when they are gone.
function tunnelShowFrame(dt = 0, force = false) {
  const t = tunnels && form && tunnels.builtOn === form.version ? tunnels : null;
  if (!t) boreState = {};
  else advanceBores(t, dt);
  if (!tunnelWorking || force) { // the shapes being tried flicker by: the cut offered to the pipeline follows when a search has an answer (see tunnelStep)
    const cut = t && t.carved ? t : null;
    const key = cut ? `${cut.id}|${cut.vox.version}` : "";
    if (key !== tunnelShown) {
      tunnelShown = key;
      setActiveTunnels(cut);
      notifyCutsChanged();
    }
  }
  if (t) tunnelView.update(layers.model, t, Object.values(boreState));
  else tunnelView.clear();
}

// What is drawn of the tunnels is eroded out of the mass over time (tunnelBore.js), not shown as the search tries them: for every pair of
// floors the shape on show and how far its erosion has got. A shape is shown once the search has a first answer for it; later answers
// replace it only when the search is settled, and then the old tunnels fill in again (quickly) before the new ones are eroded.
const HEAL = 1.5; // per second: how fast tunnels that are being replaced fill in
let boreState = {}; // by band number: { b, dir, shape, key, prog, token }
function advanceBores(t, dt) {
  const winds = tunnelWinds;
  for (const b of Object.keys(boreState)) if (!t.active.includes(Number(b))) boreState[b].want = null;
  for (const b of t.active) {
    const info = t.shapeInfo(b), s = (boreState[b] ??= { b, dir: null, shape: null, key: "", prog: 0, token: null, want: null });
    const stale = s.token !== info.token;
    const dir = winds[b]?.dir ?? s.dir;
    s.want = !dir ? null : info.chosen ? info.shape : info.rough ? (stale || !s.shape ? info.shape : s.shape) : null;
    s.wantDir = dir;
    s.wantToken = info.token;
  }
  for (const s of Object.values(boreState)) {
    const wantKey = s.want ? `${JSON.stringify(s.want)}|${s.wantDir}` : "";
    if (s.shape && wantKey !== s.key) { // the tunnels are to change: fill in what is there first
      if (settings.playing || !wantKey) s.prog = Math.max(0, s.prog - dt * HEAL);
      if (s.prog > 0) continue;
      s.shape = null;
    }
    if (!s.shape && s.want) { s.shape = s.want; s.dir = s.wantDir; s.key = wantKey; s.token = s.wantToken; s.prog = 0; }
    else if (s.shape) s.token = s.wantToken;
    if (s.shape && settings.playing) s.prog = Math.min(1, s.prog + (dt * settings.erode) / 60); // erosion speed 2x: half a minute, 8x: under 8 s
  }
}

async function tunnelStep(t, work, winds, limit, key) {
  tunnelBusy = true;
  const version = massVersion, { b } = work, dir = winds[b].dir;
  try {
    if (work.what === "search") {
      const result = await t.searchStep(b, dir, limit); // another shape for this pair of floors
      if (result === "settled") t.markDone(b, key);
      if (result && tunnels === t) tunnelShowFrame(0, true); // a quick answer, or the final one: the cut follows it (the voxels are as it left them)
    } else {
      await t.solve(b, dir);
    }
    if (version === massVersion && tunnels === t) (tunnelStats ??= {})[b] = { ...t.tunnelSpeed(b), cooling: t.cooling(b) };
  } catch (e) {
    t.failed = key; // do not retry until something changes
    console.error("Wind tunnels failed:", e);
  } finally {
    tunnelBusy = false;
  }
}

// The sun growth is worked out the first time it is wanted for the form (it takes a moment).
function buildSun() {
  if (sunGrowth || sunBuilding || !form) return;
  sunBuilding = true;
  const version = massVersion, mine = phase;
  setSunNote("Working out how this mass can grow…");
  const buildings = state.features?.buildings;
  const cityTop = buildings?.reduce((m, b) => Math.max(m, b.height), 0) ?? 0;
  createSunGrowth(form, { cityHeight: cityHeights(state.site.radius, buildings), cityTop })
    .then((er) => {
      if (version !== massVersion || mine !== phase) return;
      sunBuilding = false;
      sunGrowth = er;
    })
    .catch((e) => {
      if (version === massVersion && mine === phase) sunBuilding = false;
      console.error("Sun growth failed:", e);
    });
}

function sunFrame(dt) {
  if (!settings.erodeSun) return setSunNote("");
  if (!getMassInfo()) return setSunNote("Place a .3dm mass for the sun to grow.");
  buildSun();
  if (!sunGrowth) return;
  const moving = performance.now() - sunSeen < SUN_IDLE;
  setSunNote(
    !layers.sun?.visible
      ? "Switch on the Sun layer, then run a day or the year."
      : !moving && !sunGrowth.changed()
        ? "Press Play day or Run through the year in the Sun panel: the mass grows as the sun moves."
        : sunGrowth.growth > 0
          ? `Sun has grown the mass by up to ${sunGrowth.growth.toFixed(1)} m (limit ${sunGrowth.rMax.toFixed(1)} m).`
          : "The sun is warming the mass; growth starts shortly."
  );
  sunTick += dt;
  sunShape += dt;
  if (sunTick >= SUN_INTERVAL && sunVec && sunHours > 0) {
    sunGrowth.expose(sunVec, sunHours, settings.erode / 2);
    sunHours = sunTick = 0;
  }
  if (sunShape >= SUN_SHAPE_INTERVAL) {
    sunShape = 0;
    if (sunGrowth.recompute()) formChanged();
  }
}

// The wind erosion is worked out the first time it is wanted for the form (it takes a moment).
function buildWind() {
  if (windErosion || windBuilding || !form) return;
  windBuilding = true;
  const version = massVersion, mine = phase;
  setWindNote("Working out how the wind can round this mass…");
  createWindErosion(form)
    .then((er) => {
      if (version !== massVersion || mine !== phase) return;
      windBuilding = false;
      windErosion = er;
    })
    .catch((e) => {
      if (version === massVersion && mine === phase) windBuilding = false;
      console.error("Wind erosion failed:", e);
    });
}

function windFrame(dt) {
  if (!settings.erodeWind) return setWindNote("");
  if (!settings.playing) return;
  if (!getMassInfo()) return setWindNote("Place a .3dm mass for the wind to round.");
  const rose = getWind();
  if (!rose) {
    requestWind(); // needs the wind data, whether or not the wind layer is switched on
    return setWindNote("Loading wind data…");
  }
  buildWind();
  if (!windErosion) return;
  setWindNote(
    windErosion.radius > 0
      ? `Wind has rounded the edges by up to ${windErosion.radius.toFixed(1)} m (limit ${windErosion.rMax.toFixed(1)} m).`
      : "The wind is blowing; the first edges start to round shortly."
  );
  windClock += dt * settings.speed;
  windTick += dt;
  if (windTick < WIND_INTERVAL) return;
  windErosion.expose(rose, windClock, settings.erode / 2);
  windClock = windTick = 0;
  if (windErosion.recompute()) formChanged();
}

// Solves the airflow round the form as it is now, in the prevailing wind, on a throwaway voxel mass built from the form, and the
// slice shows the result once it is ready. (In the tunnels mode the tunnels solve their own, see tunnelFrame.)
async function solveAirflow(key, rose) {
  flowBusy = true;
  setFlowNote("Solving the airflow…");
  const version = massVersion;
  try {
    const vox = createVoxelMass(form, { cityHeight: cityHeights(state.site.radius, state.features?.buildings) });
    const result = vox && (await solveFlow(vox, { dir: downwind(rose.from) }));
    if (version !== massVersion) return;
    flowKey = key;
    flowVox = vox;
    flowResult = result;
    if (result) {
      setFlowNote(
        `Wind from ${rose.from.toFixed(0)}°: the air reaches up to ${result.maxSpeed.toFixed(2)}× the open wind speed ` +
        `(${vox.nx}×${vox.nz}×${vox.ny} voxels of ${vox.c.toFixed(1)} m, ${result.iterations} passes${result.converged ? "" : ", not fully settled"}).`
      );
    }
  } catch (e) {
    flowKey = key; // do not retry until something changes
    console.error("Airflow failed:", e);
    setFlowNote("The airflow could not be solved (see the console).");
  } finally {
    flowBusy = false;
  }
}

function flowFrame() {
  if (!settings.flowDebug) {
    if (flowResult) { flowView.clear(); flowVox = flowResult = null; flowKey = ""; }
    return setFlowNote("");
  }
  if (!form || !getMassInfo()) return setFlowNote("Place a .3dm mass to test the airflow around it.");
  const rose = getWind();
  if (!rose) {
    requestWind();
    return setFlowNote("Loading wind data…");
  }
  if (settings.erodeTunnels) { // the tunnels' own airflow, which changes as they are carved
    flowKey = "";
    const t = tunnels;
    if (t?.flow) flowView.update(layers.model, t.vox, t.flow, settings.flowHeight);
    return setFlowNote(t?.flow ? "Showing the airflow through the tunnels (see the tunnel note for the wind it faces)." : "");
  }
  const key = `${massVersion}|${form.version}|${rose.from}`;
  if (key !== flowKey && !flowBusy) solveAirflow(key, rose);
  if (flowResult) flowView.update(layers.model, flowVox, flowResult, settings.flowHeight);
}

function startForm() {
  const info = getMassInfo();
  if (!info || !layers.model) return;
  form = createForm(info);
  if (!form) return;
  setActiveForm(form);
  formView.setForm(form, layers.model, info.object);
}

export function mountExterior() {
  formView = createFormView();
  flowView = createFlowView();
  tunnelView = createTunnelView();
  registerCutProvider("exterior", provideCuts);
  mountPanel($("exterior-panel"), {
    clearErosion: () => {
      tunnels = null; // the tunnels are built afresh from the mass as placed
      tunnelStats = null;
          flowKey = "";
      if (!form?.clear()) return;
      resetPhases(); // the sun and the wind start again from the mass as placed
      formView.update(form);
      setWindObstacle(form.asScan());
      notifyCutsChanged();
    },
  });
  on("sun:advanced", ({ vec, hours }) => {
    sunSeen = performance.now();
    if (!settings.erodeSun || !sunGrowth) return; // sunlight before the growth is ready or switched on does not count
    sunVec = vec;
    sunHours += hours;
  });
  on("cuts:changed", () => renderPreview(collectCuts().filter((c) => c.source === "exterior")));

  on("mass:changed", ({ mass }) => {
    stopMass();
    if (mass) rescanTimer = setTimeout(startForm, RESCAN_DELAY);
  });
  on("site:ready", syncControls);
  on("site:cleared", () => {
    clearTimeout(rescanTimer);
    stopForm();
  });

  onFrame((dt) => {
    syncMode();
    windFrame(dt);
    sunFrame(dt);
    tunnelFrame();
    tunnelShowFrame(dt);
    setXray(layers.model, settings.xray);
    flowFrame();
  });
}


