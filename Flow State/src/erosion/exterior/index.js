import * as THREE from "three";
import { $ } from "../../core/dom.js";
import { on } from "../../core/events.js";
import { state, layers } from "../../core/state.js";
import { onFrame } from "../../view/scene.js";
import { getUserLines } from "../../site/draw.js";
import { registerCutProvider, collectCuts } from "../combine.js";
import { provideCuts } from "./rules.js";
import { createTraffic } from "./traffic.js";
import { renderPreview, createTrafficView } from "./view.js";
import { mountPanel, settings, syncControls, updateReadout } from "./panel.js";

// Rough check for the places a preset or a user is most likely to pick that drive on the left.
const LEFT_HAND = [
  { lat: [49, 61], lon: [-11, 2] }, // UK and Ireland
  { lat: [24, 46], lon: [122, 146] }, // Japan
];
const drivesLeft = ({ lat, lon }) => LEFT_HAND.some((b) => lat >= b.lat[0] && lat <= b.lat[1] && lon >= b.lon[0] && lon <= b.lon[1]);

const MAX_SUBSTEP = 0.2; // seconds: keeps car-following stable when playback is fast
const WARM_UP = 90; // seconds simulated before the site first appears

let sim = null;
let view = null;
const rates = () => ({ people: settings.people, cars: settings.cars });

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
  sim.warmUp(WARM_UP, rates());
}

export function mountExterior() {
  registerCutProvider("exterior", provideCuts);
  mountPanel($("exterior-panel"), { reset: () => { sim?.reset(); sim?.warmUp(WARM_UP, rates()); } });
  on("cuts:changed", () => renderPreview(collectCuts().filter((c) => c.source === "exterior")));

  on("site:built", ({ site }) => {
    layers.traffic = new THREE.Group();
    state.siteGroup.add(layers.traffic);
    view = createTrafficView(layers.traffic);
    settings.leftHand = drivesLeft(site);
    rebuild();
  });
  on("drawn:changed", rebuild);
  on("site:ready", syncControls);
  on("site:cleared", () => {
    sim = view = null;
    updateReadout(null);
  });

  onFrame((dt) => {
    if (!sim) return;
    if (settings.playing) {
      const total = dt * settings.speed, n = Math.max(1, Math.ceil(total / MAX_SUBSTEP));
      for (let i = 0; i < n; i++) sim.step(total / n, rates());
    }
    if (layers.traffic?.visible) {
      sim.pose(settings.leftHand);
      view.update(sim, settings.size);
    }
    updateReadout(sim);
  });
}
