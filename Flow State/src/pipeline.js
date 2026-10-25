import * as THREE from "three";
import { scene, frameCamera } from "./view/scene.js";
import { state, layers } from "./core/state.js";
import { emit } from "./core/events.js";
import { restoreAll } from "./core/persist.js";
import { makeProjector } from "./core/coords.js";
import { $ } from "./core/dom.js";
import { fetchOSM, parseFeatures } from "./site/osm.js";
import { buildGround, buildLines, buildGreen, buildBuildings, buildMarker, ROAD_STYLE, PATH_STYLE } from "./site/context.js";

// Builds (and tears down) a site. Core context is built here; every other module hooks in
// through events: "site:built" to create its layer, "site:ready" to sync the UI, "site:cleared" to reset.

const startEl = $("start");
const loadingEl = $("loading");
const hudEl = $("hud");

const STEPS = ["fetch", "ground", "lines", "mass"];

function setStep(name) {
  const idx = STEPS.indexOf(name);
  document.querySelectorAll("#steps li").forEach((li) => {
    const i = STEPS.indexOf(li.dataset.step);
    li.classList.toggle("done", i < idx);
    li.classList.toggle("active", i === idx);
  });
  $("bar-fill").style.width = `${(idx / STEPS.length) * 100 + 10}%`;
}

// Yield to the browser so the loading screen can repaint between heavy steps.
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60)));

// `saved` (optional) is a record from storage.getSite(): reuses its map data and restores its state.
export async function generate(lat, lon, radius, saved = null) {
  startEl.classList.add("hidden");
  loadingEl.classList.remove("hidden", "fade");
  $("loading-coords").textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}  ·  ${radius} m`;
  clearSite();

  try {
    setStep("fetch");
    const data = saved ? saved.data : await fetchOSM(lat, lon, radius);
    state.data = data;
    state.saveRef = saved ? { id: saved.id, name: saved.name } : null;

    setStep("ground");
    await frame();
    state.siteGroup = new THREE.Group();
    scene.add(state.siteGroup);
    state.site = { lat, lon, radius };
    const features = parseFeatures(data, makeProjector(lat, lon));
    state.features = features;
    buildGround(state.siteGroup, radius);

    setStep("lines");
    await frame();
    layers.green = buildGreen(features.green);
    layers.roads = buildLines(features.roads, ROAD_STYLE);
    layers.paths = buildLines(features.paths, PATH_STYLE);
    state.siteGroup.add(layers.green, layers.roads, layers.paths);

    setStep("mass");
    await frame();
    layers.buildings = buildBuildings(features.buildings);
    state.siteGroup.add(layers.buildings, buildMarker(radius));

    frameCamera(radius);
    $("bar-fill").style.width = "100%";

    const payload = { site: state.site, features, saved };
    emit("site:built", payload);
    emit("site:ready", payload);
    if (saved) await restoreAll(saved.state, { modelBuffer: saved.modelBuffer });

    await frame();
    loadingEl.classList.add("fade");
    hudEl.classList.remove("hidden");
    setTimeout(() => loadingEl.classList.add("hidden"), 800);
  } catch (err) {
    console.error(err);
    loadingEl.classList.add("hidden");
    startEl.classList.remove("hidden");
    $("form-error").textContent = err.message || "Something went wrong generating the site.";
  }
}

export function clearSite() {
  emit("site:cleared");
  if (!state.siteGroup) return;
  state.siteGroup.traverse((o) => {
    o.geometry?.dispose();
    o.material?.map?.dispose();
    o.material?.dispose?.();
    o.customDepthMaterial?.dispose();
  });
  scene.remove(state.siteGroup);
  state.siteGroup = null;
  state.site = null;
  state.features = null;
  for (const k in layers) delete layers[k];
}
