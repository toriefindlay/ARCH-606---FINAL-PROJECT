import * as THREE from "three";
import { $ } from "../../core/dom.js";
import { on } from "../../core/events.js";
import { state, layers } from "../../core/state.js";
import { onFrame } from "../../view/scene.js";
import { getUserLines } from "../../site/draw.js";
import { getMassInfo } from "../../mass/model3dm.js";
import { registerCutProvider, collectCuts, notifyCutsChanged } from "../combine.js";
import { provideCuts } from "./rules.js";
import { createTraffic } from "./traffic.js";
import { scanMass } from "./massScan.js";
import { createErosion, setActiveErosion } from "./erosion.js";
import { createForm } from "./form.js";
import { createWindErosion, setActiveForm } from "./windErode.js";
import { createSunGrowth } from "./sunGrow.js";
import { renderPreview, createTrafficView, createCarveView, createFormView } from "./view.js";
import { mountPanel, settings, syncControls, updateReadout, setWindNote, setSunNote } from "./panel.js";
import { getWind, requestWind, setWindObstacle } from "../../site/wind.js";
import { cityHeights } from "../../site/windFlow.js";

// Rough check for the places a preset or a user is most likely to pick that drive on the left.
const LEFT_HAND = [
  { lat: [49, 61], lon: [-11, 2] }, // UK and Ireland
  { lat: [24, 46], lon: [122, 146] }, // Japan
];
const drivesLeft = ({ lat, lon }) => LEFT_HAND.some((b) => lat >= b.lat[0] && lat <= b.lat[1] && lon >= b.lon[0] && lon <= b.lon[1]);

const MAX_SUBSTEP = 0.2; // seconds: keeps car-following stable when playback is fast
const WARM_UP = 90; // seconds simulated before the site first appears
const RESCAN_DELAY = 350; // ms after the mass stops moving before it is analysed again
const CARVE_INTERVAL = 0.6; // seconds between updates of the carved shape
const WIND_INTERVAL = 0.6; // seconds between updates of the wind-rounded shape
const FLOW_DELAY = 1500; // ms after the form last changed before the wind streaks bend around the new shape
const SUN_INTERVAL = 0.1; // seconds between times the sun's warmth is collected
const SUN_SHAPE_INTERVAL = 0.6; // seconds between updates of the grown shape
const SUN_IDLE = 1500; // ms without the sun moving before the panel says what to press

let sim = null;
let view = null;
let erosion = null;
let carve = null;
let form = null; // the one shape the sun, the wind and the traffic all work on (see form.js)
let formView = null;
let trafficScan = null; // the height map the traffic touches and carves, kept in step with the form
let trafficVersion = 0; // the form version the traffic's height map was last matched to
let mode = "traffic"; // the kind of erosion working now: "sun" | "wind" | "traffic" (the panel allows one at a time)
let phase = 0; // changes whenever the mode does, so that slow set-up for an earlier mode is dropped
let windErosion = null; // the wind's rounding of the form as it was when the wind started, once worked out
let windBuilding = false; // it is being worked out
let windClock = 0; // simulated seconds of wind not yet applied
let windTick = 0;
let flowTimer = 0;
let massVersion = 0; // changes whenever the mass does, so that slow set-up for an old mass is dropped
let sunGrowth = null; // the sun's growth of the form as it was when the sun started, once worked out
let sunBuilding = false;
let sunHours = 0; // simulated hours of sun not yet applied
let sunVec = null; // where the sun last was
let sunSeen = 0; // when (ms) the Sun panel last advanced the sun
let sunTick = 0;
let sunShape = 0; // seconds since the grown shape was last redrawn
let rescanTimer = 0;
let carveClock = 0;
let healClock = 0; // simulated seconds since the erosion last healed
let massArea = null; // the mass's footprint, as the traffic needs it (see makeArea)
const rates = () => ({ people: settings.people, cars: settings.cars });

// The mass's footprint in site metres, for the people who walk into it: where there is mass (the height map says so),
// and a box around it.
function makeArea(scan) {
  const { hf, hw, hh, cu, cv, sub, nU, nV } = scan;
  const contains = (x, y) => {
    const [u, v] = scan.toUV(x, -y); // site (east, north) -> world (x, z = -north) -> lattice
    if (u < 0 || v < 0) return false;
    const i = Math.floor(u / (cu / sub)), j = Math.floor(v / (cv / sub));
    return i < hw && j < hh && hf[j * hw + i] > 0.5;
  };
  const corners = [[0, 0], [nU * cu, 0], [0, nV * cv], [nU * cu, nV * cv]].map(([u, v]) => {
    const [x, z] = scan.toXZ(u, v);
    return [x, -z];
  });
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
  return { contains, bounds: { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) } };
}

// Called by the traffic for every particle step: wears the mass where particles pass through it.
const visit = (isCar, x, y, dt, particle) => {
  if (erosion && (isCar ? settings.erodeCars : settings.erodePeople)) erosion.visit(isCar, x, y, settings.erode, particle); // a pass counts as erode passes, however long a step is
};

// Drawn lines are world coordinates (x east, z = -north); traffic uses site coordinates (x east, y north).
// A drawn road behaves like a minor main street, a drawn path like a footway.
function drawnLines() {
  const lines = getUserLines();
  const convert = (kind, osmKind) =>
    lines.filter((l) => l.kind === kind).map((l) => ({ kind: osmKind, pts: l.pts.map((p) => ({ x: p.x, y: -p.z })) }));
  return { roads: convert("road", "tertiary"), paths: convert("path", "footway") };
}

// (Re)builds the traffic for the current site and drawn lines. Particles restart, pre-populated.
function rebuild() {
  if (!state.features || !layers.traffic) return;
  sim = createTraffic(state.features, state.site.radius, drawnLines());
  sim.warmUp(WARM_UP, rates()); // before the mass is hooked up: the warm-up should not carve
  sim.visit = visit;
  sim.wear = (x, y) => (erosion ? erosion.wearAt(x, y) : 0); // people inside the mass favour worn ground
  sim.setMass(massArea);
}


const currentMode = () => (settings.erodeSun ? "sun" : settings.erodeWind ? "wind" : "traffic");

// The sun's and the wind's set-up is worked out from the form as it is when they start, so it is dropped whenever the form
// is changed by anything else (another mode, or clearing).
function resetPhases() {
  phase++;
  windErosion = sunGrowth = null;
  windBuilding = sunBuilding = false;
  windClock = windTick = sunHours = sunTick = sunShape = 0;
  setWindNote("");
  setSunNote("");
}

// Keeps the traffic's height map the same as the form's, so that people and cars touch what the sun grew and miss what the
// wind took (and the strands they carve stay below the form's roof).
function matchTraffic() {
  if (!form || !trafficScan || trafficVersion === form.version) return;
  trafficVersion = form.version;
  const { hf, hw, hh, cu, cv, sub } = trafficScan;
  for (let j = 0; j < hh; j++) {
    for (let i = 0; i < hw; i++) {
      const [x, z] = trafficScan.toXZ(((i + 0.5) * cu) / sub, ((j + 0.5) * cv) / sub);
      hf[j * hw + i] = form.heightAt(x, z);
    }
  }
  if (erosion) carve.update(erosion);
}

// Switching mode: the new one carries on from the form as the last one left it.
function syncMode() {
  const next = currentMode();
  if (next === mode) return;
  mode = next;
  resetPhases();
  if (mode === "traffic") matchTraffic();
}

// The form changed (the sun or the wind worked on it): redraw it, tell the pipeline, and let the wind streaks follow it.
function formChanged() {
  formView.update(form);
  notifyCutsChanged();
  clearTimeout(flowTimer);
  flowTimer = setTimeout(() => form && setWindObstacle(form.asScan()), FLOW_DELAY);
}

// The mass moved, scaled or went away: its carving no longer fits, so start again from the new mass.
function stopCarving() {
  clearTimeout(rescanTimer);
  const had = !!erosion || !!form?.changed();
  erosion = null;
  massArea = null;
  trafficScan = null;
  sim?.setMass(null);
  setActiveErosion(null);
  carve?.clear();
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

function startCarving() {
  const info = getMassInfo();
  if (!info || !layers.model) return;
  const scan = scanMass(info);
  if (!scan) return;
  erosion = createErosion(scan);
  setActiveErosion(erosion);
  massArea = makeArea(scan);
  trafficScan = scan;
  sim?.setMass(massArea); // from now on people who walk into the mass wander its floor
  carve.setLattice(scan, layers.model, info.object);
  form = createForm(info);
  if (form) {
    setActiveForm(form);
    formView.setForm(form, layers.model, info.object);
    trafficVersion = form.version;
  }
}

function carveFrame(dt, simSeconds) {
  if (!erosion) return;
  carveClock += dt;
  healClock += simSeconds;
  if (carveClock < CARVE_INTERVAL) return;
  carveClock = 0;
  if (settings.heal > 0) erosion.heal(healClock * settings.heal); // channels nobody uses fade
  healClock = 0;
  if (erosion.recompute()) {
    carve.update(erosion);
    notifyCutsChanged();
  }
}

export function mountExterior() {
  carve = createCarveView();
  formView = createFormView();
  registerCutProvider("exterior", provideCuts);
  mountPanel($("exterior-panel"), {
    reset: () => { sim?.reset(); sim?.warmUp(WARM_UP, rates()); },
    clearErosion: () => {
      const strands = erosion?.clear();
      const shape = form?.clear();
      if (strands) carve.update(erosion);
      if (shape) {
        resetPhases(); // the sun and the wind start again from the mass as placed
        formView.update(form);
        setWindObstacle(form.asScan());
        matchTraffic();
      }
      if (strands || shape) notifyCutsChanged();
    },
  });
  on("sun:advanced", ({ vec, hours }) => {
    sunSeen = performance.now();
    if (!settings.erodeSun || !sunGrowth) return; // sunlight before the growth is ready or switched on does not count
    sunVec = vec;
    sunHours += hours;
  });
  on("cuts:changed", () => renderPreview(collectCuts().filter((c) => c.source === "exterior")));

  on("site:built", ({ site }) => {
    layers.traffic = new THREE.Group();
    layers.traffic.visible = false; // a site opens bare: traffic, sun and wind are switched on by the user
    state.siteGroup.add(layers.traffic);
    view = createTrafficView(layers.traffic);
    settings.leftHand = drivesLeft(site);
    rebuild();
  });
  on("drawn:changed", rebuild);
  on("mass:changed", ({ mass }) => {
    stopCarving();
    if (mass) rescanTimer = setTimeout(startCarving, RESCAN_DELAY);
  });
  on("site:ready", syncControls);
  on("site:cleared", () => {
    sim = view = erosion = massArea = trafficScan = null;
    clearTimeout(rescanTimer);
    setActiveErosion(null);
    carve.clear();
    stopForm();
    updateReadout(null);
  });

  onFrame((dt) => {
    syncMode();
    windFrame(dt);
    sunFrame(dt);
    if (!sim) return;
    if (settings.playing && layers.traffic?.visible) {
      const total = dt * settings.speed, n = Math.max(1, Math.ceil(total / MAX_SUBSTEP));
      for (let i = 0; i < n; i++) sim.step(total / n, rates());
      carveFrame(dt, total);
    }
    if (layers.traffic?.visible) {
      sim.pose(settings.leftHand);
      view.update(sim, settings.size);
    }
    updateReadout(sim);
  });
}
