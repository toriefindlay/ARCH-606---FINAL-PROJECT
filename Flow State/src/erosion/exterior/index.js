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
import { scanMass } from "./language.js";
import { createErosion, setActiveErosion } from "./erosion.js";
import { renderPreview, createTrafficView, createCarveView } from "./view.js";
import { mountPanel, settings, syncControls, updateReadout, showLanguage } from "./panel.js";

// Rough check for the places a preset or a user is most likely to pick that drive on the left.
const LEFT_HAND = [
  { lat: [49, 61], lon: [-11, 2] }, // UK and Ireland
  { lat: [24, 46], lon: [122, 146] }, // Japan
];
const drivesLeft = ({ lat, lon }) => LEFT_HAND.some((b) => lat >= b.lat[0] && lat <= b.lat[1] && lon >= b.lon[0] && lon <= b.lon[1]);

const MAX_SUBSTEP = 0.2; // seconds: keeps car-following stable when playback is fast
const WARM_UP = 90; // seconds simulated before the site first appears
const RESCAN_DELAY = 350; // ms after the mass stops moving before it is analysed again
const CARVE_INTERVAL = 0.4; // seconds between updates of the carved shape

let sim = null;
let view = null;
let erosion = null;
let carve = null;
let rescanTimer = 0;
let carveClock = 0;
const rates = () => ({ people: settings.people, cars: settings.cars });

// Called by the traffic for every particle step: wears the mass where particles pass through it.
const visit = (isCar, x, y, dt) => {
  if (settings.carve && erosion) erosion.visit(isCar, x, y, dt * settings.erode);
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
}

// The mass moved, scaled or went away: its carving no longer fits, so start again from the new mass.
function stopCarving() {
  clearTimeout(rescanTimer);
  const had = !!erosion;
  erosion = null;
  setActiveErosion(null);
  carve?.clear();
  showLanguage(null);
  if (had) notifyCutsChanged();
}

function startCarving() {
  const info = getMassInfo();
  if (!info || !layers.model) return;
  const scan = scanMass(info);
  if (!scan) return;
  erosion = createErosion(scan);
  setActiveErosion(erosion);
  carve.setLattice(scan, layers.model, info.object);
  showLanguage(scan);
}

function carveFrame(dt) {
  if (!erosion || !settings.carve) return;
  carveClock += dt;
  if (carveClock < CARVE_INTERVAL) return;
  carveClock = 0;
  if (erosion.recompute()) {
    carve.update(erosion.H);
    notifyCutsChanged();
  }
}

export function mountExterior() {
  carve = createCarveView();
  registerCutProvider("exterior", provideCuts);
  mountPanel($("exterior-panel"), {
    reset: () => { sim?.reset(); sim?.warmUp(WARM_UP, rates()); },
    clearErosion: () => {
      if (erosion?.clear()) {
        carve.update(erosion.H);
        notifyCutsChanged();
      }
    },
  });
  on("cuts:changed", () => renderPreview(collectCuts().filter((c) => c.source === "exterior")));

  on("site:built", ({ site }) => {
    layers.traffic = new THREE.Group();
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
    sim = view = erosion = null;
    clearTimeout(rescanTimer);
    setActiveErosion(null);
    carve.clear();
    updateReadout(null);
    showLanguage(null);
  });

  onFrame((dt) => {
    if (!sim) return;
    if (settings.playing) {
      const total = dt * settings.speed, n = Math.max(1, Math.ceil(total / MAX_SUBSTEP));
      for (let i = 0; i < n; i++) sim.step(total / n, rates());
      carveFrame(dt);
    }
    if (layers.traffic?.visible) {
      sim.pose(settings.leftHand);
      view.update(sim, settings.size);
    }
    updateReadout(sim);
  });
}
