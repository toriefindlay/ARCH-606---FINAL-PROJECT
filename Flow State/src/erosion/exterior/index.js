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
import { createTunnels, REACH } from "./tunnels.js";
import { setActiveTunnels } from "./tunnelCut.js";
import { renderPreview, createFormView, createTunnelView, setXray } from "./view.js";
import { mountPanel, settings, syncControls, setWindNote, setSunNote, setFlowNote, setTunnelNote, setFloorRows, setWindOptions, setParticleNote, setParticleWindOptions } from "./panel.js";
import { createWindParticles } from "./windParticles.js";
import { createCoolingView } from "./coolingView.js";
import { getSpaces, spacesSignature } from "../interior/spaces.js";
import { getWind, getWarmWind, getWarmPeriods, requestWind, setWindObstacle, downwind } from "../../site/wind.js";
import { cityHeights } from "../../site/windFlow.js";

const RESCAN_DELAY = 350; // ms after the mass stops moving before it is analysed again
const WIND_INTERVAL = 0.6; // seconds between updates of the wind-rounded shape
const FLOW_DELAY = 1500; // ms after the form last changed before the wind streaks bend around the new shape
const SUN_INTERVAL = 0.1; // seconds between times the sun's warmth is collected
const SUN_SHAPE_INTERVAL = 0.6; // seconds between updates of the grown shape
const SUN_IDLE = 1500; // ms without the sun moving before the panel says what to press

let form = null; // the one shape the sun and the wind work on (see form.js)
let formView = null;
let coolingView = null; // the floor plans shaded by cooling (the "cooling data" layer)
let tunnelView = null; // the tunnels' walls, and the hole they leave in the mass's own surface
let tunnelShown = ""; // which tunnels, and which state of them, the view and the cuts were last given
let tunnelBusy = false; // a step of the tunnels (a solve) is running
let tunnelWorking = false; // the tunnels are being worn: the cut offered to the pipeline waits for the end
let skinClock = 0; // simulated seconds since the tunnels were finished (the skin softens with it)
const SKIN_SECONDS = 150, SKIN_STEPS = 5; // how long the skin takes to soften fully (at the erosion speed), and in how many steps
let tunnelWinds = null; // the wind of the whole structure, as last worked out by tunnelFrame
let tunnelStats = null; // the air speed in the tunnels and the cooling, in the last solution
let tunnels = null; // the persistent voxel mass the wind tunnels are carved from (tunnels.js), built from the form when first wanted
let mode = "none"; // the kind of erosion working now: "sun" | "wind" | "tunnels" | "none" (the panel allows one at a time)
let phase = 0; // changes whenever the mode does, so that slow set-up for an earlier mode is dropped
let windErosion = null; // the wind's rounding of the form as it was when the wind started, once worked out
let windBuilding = false; // it is being worked out
let windClock = 0; // simulated seconds of wind not yet applied
let windTick = 0;
let flowTimer = 0;
let particles = null; // the wind particles flowing through the finished tunnels
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
  particles?.clear();
  flowVox = flowResult = null;
  flowKey = "";
  tunnels = null;
  tunnelStats = null;
}

// The wind tunnels' voxel mass is built from the form the first time it is wanted and then kept, so tunnels stay worn between solves and when
// another mode is switched on and off. It is built afresh if the sun or the wind has changed the form since (the tunnels would no longer fit
// the shape), or if the mass moved (stopForm).
function ensureTunnels() {
  if (tunnels && tunnels.builtOn !== form.version) tunnels = null;
  tunnels ??= createTunnels(form, { cityHeight: cityHeights(state.site.radius, state.features?.buildings) });
  return tunnels;
}

// A line in place of the floor table (nothing to show yet, or why not).
function tunnelMessage(text) {
  setFloorRows([]);
  setTunnelNote(text);
}

// The occupied spaces (interior erosion) the tunnels grow round. A change is only taken up once the spheres have stopped changing for a moment, so
// that dragging one does not start the tunnels again at every step.
const SPACES_SETTLE = 800; // ms
let spacesSeen = "", spacesSince = 0, spacesApplied = "", spacesList = [];
function settledSpaces() {
  const sig = spacesSignature(), now = performance.now();
  if (sig !== spacesSeen) { spacesSeen = sig; spacesSince = now; }
  if (sig !== spacesApplied && now - spacesSince >= SPACES_SETTLE) { spacesApplied = sig; spacesList = getSpaces().map((s) => ({ ...s })); }
  return spacesApplied;
}

// The tunnels are worn by the airflow one round per pass (see tunnels.js), growing in front of you, and then the real airflow is solved through
// them for the cooling numbers. One wind, a time of the warm season chosen in the panel, serves the whole structure.
function tunnelFrame() {
  tunnelWorking = false;
  if (!settings.erodeTunnels) return tunnelMessage("");
  if (!form || !getMassInfo()) return tunnelMessage("Place a .3dm mass to cut wind tunnels through.");
  requestWind();
  if (!getWind()) return tunnelMessage("Loading wind data…");
  const t = ensureTunnels();
  if (!t) return tunnelMessage("");
  if (!t.usable) return tunnelMessage("The mass is too low for tunnels: they need a whole storey (14 ft) of mass.");
  // The wind of the whole structure: a part of the warm season, or all of it. (The ordinary prevailing wind is used if the data has no temperatures.)
  const periods = getWarmPeriods(4);
  setWindOptions(periods);
  const picked = periods[settings.tunnelWind];
  const base = picked ?? getWarmWind() ?? { ...getWind(), label: "all year" };
  const wind = { ...base, label: picked ? base.label : base.label === "all year" ? "all year" : "whole warm season", dir: downwind(base.from) };
  // The winds the tunnels are tuned against: the main directions of the rose (up to 4, none under a fifth of the main one's share of the hours),
  // each weighted by its share of the hours times its speed (more wind, more cooling). The first is the main wind the network is grown for.
  const rose = (base.bins ?? []).map((b, i) => ({ from: i * 22.5, freq: b.freq, weight: b.freq * Math.max(b.mean, 0.5) })).sort((a, b) => b.freq - a.freq);
  const windSet = rose.filter((b, i) => i < (settings.tunnelMulti ? 4 : 1) && b.freq > 0 && b.freq >= 0.2 * rose[0].freq).map((b) => ({ ...b, dir: downwind(b.from) }));
  const weightSum = windSet.reduce((s, b) => s + b.weight, 0) || 1;
  wind.set = windSet.map((b) => ({ from: b.from, share: b.weight / weightSum }));
  tunnelWinds = wind;
  const limit = settings.tunnelVolume / 100;
  // The stack effect: air inside warmer by dT than outside is lighter, and a column of it of height y has the pressure head g*(dT/T)*y; in units of
  // the open wind's dynamic pressure (U^2/2) that is stack * y per metre. Strong in weak wind and in tall masses.
  const U = Math.max(1.5, base.mean || 3), stack = settings.tunnelStack ? (9.81 * (settings.tunnelStack / (273.15 + (base.meanTemp ?? 20)))) / (0.5 * U * U) : 0;
  const plan = `${wind.from}|${limit}|${settledSpaces()}|${stack.toFixed(4)}|${wind.set.map((b) => `${b.from}:${b.share.toFixed(2)}`).join(",")}`;
  if (t.plan !== plan) { // another wind, volume limit or occupied spaces: the mass is put back and the tunnels start again
    t.plan = plan;
    t.setBuoyancy(stack);
    t.setObstacles(spacesList);
    t.setWind(wind.dir);
    t.setWindSet(windSet.map((b) => ({ dir: b.dir, weight: b.weight })));
    tunnelStats = null;
    t.failed = null;
  }
  if (t.done && !tunnelStats) tunnelStats = { ...t.tunnelSpeed(), cooling: t.cooling() }; // (the cooling is read from the network itself)
  const failed = t.failed === plan;
  const growing = !t.done;
  const solving = t.done && t.stale(wind.dir);
  tunnelWorking = growing && settings.playing;
  const head = failed ? "Stopped (see the console)" : growing ? (settings.playing ? (t.refining ? `Refining the tunnels from the real airflow (round ${t.refining.round}; weakest floor ${(100 * t.refining.floor).toFixed(1)}% average cooling, aiming for ${(100 * t.refining.goal).toFixed(0)}%)` : t.tuning ? `Tuning the best network for cooling (${t.tuning.kept} of ${t.tuning.trials} changes kept)` : `Wearing the tunnels into the stone (network ${t.variant + 1} of ${t.variants}; the best is kept)`) : "Paused") : solving ? "Working out the airflow" : "Settled";
  setTunnelNote(`${head} (limit ${settings.tunnelVolume}% of the mass, ${(100 * t.share).toFixed(1)}% worn away)`);
  setFloorRows([floorRow(t, wind)]);
  if (tunnelBusy || failed || !settings.playing || (!growing && !solving)) return;
  tunnelStep(t, wind, limit, plan, growing);
}

// The floor data table's row for the whole structure: a title and a summary line (always shown) and the fields shown when it is opened.
function floorRow(t, w) {
  const s = tunnelStats, cool = s?.cooling;
  const pct = (v) => `${(100 * v).toFixed(0)}%`;
  const fields = [
    ["Wind", `${w.label}, from ${w.from.toFixed(0)}°${w.meanTemp ? `, ${w.meanTemp.toFixed(0)} °C` : ""}`],
    ["Worn away", `${(100 * t.share).toFixed(1)}% of the mass, in ${t.iteration} rounds`],
  ];
  const ready = s && s.mean > 0 && cool && t.done;
  if (ready) {
    fields.push(["Tunnel air", `${s.mean.toFixed(2)}× the open wind`]);
    const tr = t.tuneResult;
    if (w.set?.length > 1 && tr) {
      fields.push(["Tuned for", w.set.map((b) => `${b.from.toFixed(0)}° (${pct(b.share)})`).join(", ")]);
      fields.push(["Cooling score", `all winds ${pct(tr.from)} → ${pct(tr.to)}; main wind ${pct(tr.mainFrom)} → ${pct(tr.mainTo)}`]);
    }
    const rr = t.refineResult;
    if (rr) fields.push(["Airflow refinement", `measured cooling score ${pct(rr.from)} → ${pct(rr.to)} (round ${rr.kept} of ${rr.rounds}); weakest floor ${pct(rr.floorFrom)} → ${pct(rr.floorTo)} average cooling, ${rr.goalMet ? "goal reached" : "goal not reached"}`]);
    cool.avg.forEach((v, i) => fields.push([`Floor ${i + 1}`, `average cooling ${pct(v)}, ${pct(cool.coverage[i])} cooled by moving air within ${REACH} m`]));
    fields.push(["Evenness", `${pct(cool.evenness)} (the weakest floor over the strongest)`]);
  }
  return { b: 0, title: "Whole structure", summary: `${w.label}${ready ? ` · ${pct(cool.mean)} average cooling` : ""}`, fields };
}

// Keeps what is drawn, and the cut offered to the pipeline, in step with the tunnels: shown whenever there are tunnels that fit the
// form (also while another mode is on), and cleared when they are gone.
function tunnelShowFrame(dt = 0, force = false) {
  const t = tunnels && form && tunnels.builtOn === form.version ? tunnels : null;
  if (!tunnelWorking || force) { // the cut offered to the pipeline follows once the tunnels are worn (not at every round)
    const cut = t && t.carved ? t : null;
    const key = cut ? `${cut.id}|${cut.vox.version}` : "";
    if (key !== tunnelShown) {
      tunnelShown = key;
      setActiveTunnels(cut);
      notifyCutsChanged();
    }
  }
  // The skin softens slowly once the tunnels are done (see tunnelMesh.js): the clock runs while they are, with the erosion speed, and starts again with new
  // tunnels. The amount moves in steps (every change is a rebuild of the walls), and the slider says how far it goes.
  if (!t || !t.done) skinClock = 0;
  else if (settings.playing) skinClock += dt * settings.speed;
  const skinAmount = t && t.done ? (Math.round(Math.min(1, skinClock / SKIN_SECONDS) * SKIN_STEPS) / SKIN_STEPS) * (settings.skinSoften / 100) : 0;
  if (t) tunnelView.update(layers.model, t, { amount: Math.round(skinAmount * 100) / 100 });
  else tunnelView.clear();
}

// The cooling data layer (x-ray mode): a floor plan per storey shaded by cooling, once the tunnels are done and their airflow is solved.
function coolingFrame() {
  const t = tunnels && form && tunnels.builtOn === form.version ? tunnels : null;
  coolingView.update(layers.model, t, !!(settings.xray && settings.coolingData && t?.done));
}

// One round of wearing away, or the airflow through the finished tunnels.
async function tunnelStep(t, wind, limit, plan, growing) {
  tunnelBusy = true;
  const version = massVersion;
  try {
    if (growing) {
      await t.grow(limit);
    } else {
      await t.solve(wind.dir);
      if (version === massVersion && tunnels === t) tunnelShowFrame(0, true);
    }
    if (version === massVersion && tunnels === t && t.done && !t.stale(wind.dir)) tunnelStats = { ...t.tunnelSpeed(), cooling: t.cooling() };
  } catch (e) {
    t.failed = plan; // do not retry until something changes
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

// The wind particles: once the tunnels are finished, small particles follow the airflow through and round them, for the wind of the time of
// year chosen in the panel (by default the one the tunnels were worn for).
function particleFrame(dt) {
  if (!settings.windParticles) { particles.clear(); return setParticleNote(""); }
  const t = tunnels && form && tunnels.builtOn === form.version ? tunnels : null;
  if (!t || !getMassInfo()) { particles.clear(); return setParticleNote("Wear wind tunnels into the mass first."); }
  requestWind();
  if (!getWind()) return setParticleNote("Loading wind data…");
  if (!t.done) { particles.clear(); return setParticleNote("Waiting for the tunnels to finish."); }
  const periods = getWarmPeriods(4);
  setParticleWindOptions(periods);
  const sel = settings.particleWind;
  const base = sel >= 0 && periods[sel] ? periods[sel] : sel === -1 ? getWarmWind() : tunnelWinds ?? getWarmWind();
  const wind = base ?? getWind();
  const note = particles.update(layers.model, t, wind, { dt, pace: settings.particleSpeed });
  setParticleNote(note || `Wind from ${wind.from.toFixed(0)}°, ${wind.mean.toFixed(1)} m/s${wind.label ? ` (${wind.label})` : ""}. Colour: blue slower, red faster than the open wind.`);
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
  particles = createWindParticles();
  tunnelView = createTunnelView();
  coolingView = createCoolingView();
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
    coolingFrame();
    flowFrame();
    particleFrame(dt);
  });
}


