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
import { createTunnels } from "./tunnels.js";
import { setActiveTunnels } from "./tunnelCut.js";
import { renderPreview, createFormView, createTunnelView } from "./view.js";
import { mountPanel, settings, syncControls, setWindNote, setSunNote, setFlowNote, setTunnelNote } from "./panel.js";
import { getWind, getWarmWind, requestWind, setWindObstacle, downwind } from "../../site/wind.js";
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
let tunnelSettled = ""; // what the tunnels last settled for (see tunnelFrame)
let tunnelStats = null; // air speed in the tunnels in the last solution
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
  tunnelSettled = "";
}

// The wind tunnels' voxel mass is built from the form the first time it is wanted and then kept, so tunnels stay carved
// between solves and when another mode is switched on and off. It is built afresh if the sun or the wind has changed the form
// since (the tunnels would no longer fit the shape), or if the mass moved (stopForm).
function ensureTunnels() {
  if (tunnels && tunnels.builtOn !== form.version) tunnels = null;
  tunnels ??= createTunnels(form, { cityHeight: cityHeights(state.site.radius, state.features?.buildings) });
  return tunnels;
}

// The tunnels grow one step per pass, strictly one thing at a time: solve the airflow (if the voxels or the wind changed since the
// last solution), otherwise wear the walls and open what is worn through. The next pass then solves again. Settled = a wearing
// that opened nothing: it is not repeated until something changes (the voxels, the volume limit or the erosion speed).
function tunnelFrame() {
  if (!settings.erodeTunnels) return setTunnelNote("");
  if (!form || !getMassInfo()) return setTunnelNote("Place a .3dm mass to cut wind tunnels through.");
  // The tunnels are for cooling, so they face the wind of the warm part of the year (see getWarmWind), not whichever period the
  // Wind panel shows. (The ordinary prevailing wind is used if the data has no temperatures.)
  const warm = getWarmWind(), rose = warm ?? getWind();
  if (!rose) {
    requestWind();
    return setTunnelNote("Loading wind data…");
  }
  const t = ensureTunnels();
  if (!t) return setTunnelNote("");
  const dir = downwind(rose.from), limit = settings.tunnelVolume / 100;
  const wind = warm ? `warm-season wind from ${rose.from.toFixed(0)}° (hours above ${warm.base.toFixed(0)} °C, averaging ${warm.meanTemp.toFixed(0)} °C)` : `prevailing wind from ${rose.from.toFixed(0)}°`;
  const settled = tunnelSettled === `${t.vox.version}|${limit}|${settings.erode}` && !t.stale(dir);
  const share = `${(100 * t.share).toFixed(1)}% of the mass carved (limit ${settings.tunnelVolume}%)`;
  const speed = tunnelStats && tunnelStats.mean > 0 ? `, the air in the tunnels averages ${tunnelStats.mean.toFixed(2)}× the open wind` : "";
  setTunnelNote(
    (!t.seeded ? "Opening the first channel…"
      : tunnelBusy ? `Solving the airflow… ${share}.`
        : settled ? `Settled: ${share}${speed}.`
          : !settings.playing ? `Paused: ${share}${speed}.`
            : `Wearing the tunnels: ${share}${speed}.`) + ` Facing the ${wind}.`
  );
  if (tunnelBusy || settled || !settings.playing) return;
  tunnelStep(t, dir, limit);
}

// Keeps what is drawn, and the cut offered to the pipeline, in step with the tunnels: shown whenever there are tunnels that fit the
// form (also while another mode is on), and cleared when they are gone.
function tunnelShowFrame() {
  const t = tunnels && form && tunnels.builtOn === form.version && tunnels.carved ? tunnels : null;
  const key = t ? `${t.id}|${t.vox.version}` : "";
  if (key !== tunnelShown) {
    tunnelShown = key;
    setActiveTunnels(t);
    notifyCutsChanged();
  }
  if (t) tunnelView.update(layers.model, t);
  else tunnelView.clear();
}

async function tunnelStep(t, dir, limit) {
  tunnelBusy = true;
  const version = massVersion;
  try {
    if (!t.seeded) t.seedPilot(dir); // a fixed height for now: the solver will pick the place (see tunnels.js)
    if (t.stale(dir)) {
      await t.solve(dir);
      if (version === massVersion && tunnels === t) tunnelStats = t.tunnelSpeed();
    } else if (!t.erode(settings.erode, limit) && !t.gaining) { // nothing opened and no wall is wearing: nothing more will
      tunnelSettled = `${t.vox.version}|${limit}|${settings.erode}`;
    }
  } catch (e) {
    tunnelSettled = `${t.vox.version}|${limit}|${settings.erode}`; // do not retry until something changes
    console.error("Wind tunnels failed:", e);
    setTunnelNote("The wind tunnels could not be worked out (see the console).");
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
      tunnelSettled = "";
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
    tunnelShowFrame();
    flowFrame();
  });
}
