import { $ } from "../../core/dom.js";
import { on } from "../../core/events.js";
import { state, layers } from "../../core/state.js";
import { onFrame } from "../../view/scene.js";
import { getMassInfo, getMassFrames, hasRoundedMass } from "../../mass/model3dm.js";
import { registerPersist } from "../../core/persist.js";
import { registerCutProvider, collectCuts, notifyCutsChanged } from "../combine.js";
import { provideCuts } from "./rules.js";
import { createForm } from "./form.js";
import { createTunnels, REACH } from "./tunnels.js";
import { createVoxelMass } from "./voxelFlow.js";
import { setActiveTunnels } from "./tunnelCut.js";
import { renderPreview, patchMass, createTunnelView, setXray, setRounded } from "./view.js";
import { mountPanel, settings, syncControls, setTunnelNote, setFloorRows, setWindOptions, setParticleNote, setParticleWindOptions } from "./panel.js";
import { createWindParticles } from "./windParticles.js";
import { createCoolingView } from "./coolingView.js";
import { getSpaces, spacesSignature } from "../interior/spaces.js";
import { getWind, getWarmWind, getWarmPeriods, requestWind, downwind } from "../../site/wind.js";
import { cityHeights } from "../../site/windFlow.js";

const RESCAN_DELAY = 350; // ms after the mass stops moving before it is analysed again

let form = null; // the height map of the mass that the tunnels are built from (see form.js)
let coolingView = null; // the floor plans shaded by cooling (the "cooling data" layer)
let tunnelView = null; // the tunnels' walls, and the hole they leave in the mass's own surface
let tunnelShown = ""; // which tunnels, and which state of them, the view and the cuts were last given
let tunnelBusy = false; // a step of the tunnels (a solve) is running
let tunnelWorking = false; // the tunnels are being worn: the cut offered to the pipeline waits for the end
let tunnelWinds = null; // the wind of the whole structure, as last worked out by tunnelFrame
let tunnelStats = null; // the air speed in the tunnels and the cooling, in the last solution
let tunnels = null; // the persistent voxel mass the wind tunnels are carved from (tunnels.js), built from the form when first wanted
let particles = null; // the wind particles flowing through the finished tunnels
let massVersion = 0; // changes whenever the mass does, so that slow set-up for an old mass is dropped
let rescanTimer = 0;

// The mass moved, scaled or went away: its shape no longer fits, so start again from the new mass.
function stopMass() {
  clearTimeout(rescanTimer);
  stopForm();
}

function stopForm() {
  massVersion++;
  form = null;
  particles?.clear();
  tunnels = null;
  tunnelStats = null;
  preview = null;
}

// The wind tunnels' voxel mass is built from the form the first time it is wanted and then kept, so tunnels stay worn between solves and when
// they are switched off and on. It is built afresh if the mass moved (stopForm).
function ensureTunnels() {
  if (tunnels && tunnels.builtOn !== form.version) tunnels = null;
  tunnels ??= createTunnels(form, { cityHeight: cityHeights(state.site.radius, state.features?.buildings) });
  return tunnels;
}

/* ---------- saving the tunnels with a site ---------- */

// The settings the tunnels are made with. They are saved with a site (with the finished tunnels themselves), and a site opened
// or started afresh begins from these defaults, not from what the last one was set to.
const TUNNEL_KEYS = ["erodeTunnels", "tunnelVolume", "tunnelStack", "tunnelWind", "tunnelMulti"];
const TUNNEL_DEFAULTS = Object.fromEntries(TUNNEL_KEYS.map((k) => [k, settings[k]]));
const tunnelSettings = () => Object.fromEntries(TUNNEL_KEYS.map((k) => [k, settings[k]]));
let pending = null; // saved tunnels waiting for their massings to be read: { massings, made, network }
let adopt = null; // tunnels just put back, whose plan is still to be taken up: { tunnels, made }

// Where the massings stand and how big they are, to the nearest centimetre: saved tunnels fit only these.
const massingsKey = () => JSON.stringify(getMassFrames().map((f) => [f.x, f.z, f.turn, f.halfX, f.halfZ, f.height].map((v) => Math.round(v * 100) / 100)));
// What the tunnels were made with: while it is the same, they stand as they are.
const madeWith = () => `${settings.tunnelVolume}|${settings.tunnelStack}|${settings.tunnelWind}|${settings.tunnelMulti}|${spacesSignature()}`;

function captureTunnels() {
  const live = tunnels && form && tunnels.builtOn === form.version ? tunnels.save() : null;
  return { settings: tunnelSettings(), tunnels: live ? { massings: massingsKey(), made: tunnels.made ?? madeWith(), network: live } : pending };
}

// For the Save button: whether the tunnels went with the site ("saved"), are still being worn and so did not ("unfinished"),
// or there are none ("none").
export function tunnelSaveStatus() {
  if (pending || getFinishedTunnels()) return "saved";
  return settings.erodeTunnels && getMassInfo() ? "unfinished" : "none";
}

// Once all the massings a site was saved with are back, its tunnels are put back in place of being grown again.
function restorePending() {
  if (!pending || !form) return;
  if (getMassFrames().length < JSON.parse(pending.massings).length) return; // (more massings are still being read)
  const saved = pending;
  pending = null;
  if (massingsKey() !== saved.massings) return; // (a massing has been moved or changed since)
  const t = ensureTunnels();
  if (!t?.load(saved.network)) {
    tunnels = null;
    console.warn("The saved wind tunnels do not fit these massings, so they will be worn again.");
    return;
  }
  // the occupied spaces are taken up at once, so that they are not seen as just changed
  spacesSeen = spacesApplied = spacesSignature();
  spacesList = getSpaces().map((s) => ({ ...s }));
  t.made = saved.made;
  adopt = { tunnels: t, made: saved.made };
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
  if (adopt?.tunnels === t) { // (tunnels put back from a saved site stand for this plan, unless a setting has been changed since)
    if (adopt.made === madeWith()) t.plan = plan;
    adopt = null;
  }
  if (t.plan !== plan) { // another wind, volume limit or occupied spaces: the mass is put back and the tunnels start again
    t.plan = plan;
    t.made = madeWith();
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
  const head = failed ? "Stopped (see the console)" : growing ? (settings.playing ? (t.refining ? `Refining the tunnels from the real airflow (round ${t.refining.round}; weakest floor ${(100 * t.refining.floor).toFixed(1)}% average cooling, aiming for ${(100 * t.refining.goal).toFixed(0)}%${t.refining.coverGoal ? `; ${(100 * t.refining.cover).toFixed(0)}% of the weakest floor cooled, aiming for ${(100 * t.refining.coverGoal).toFixed(0)}%` : ""})` : t.tuning ? `Tuning the best network for cooling (${t.tuning.kept} of ${t.tuning.trials} changes kept)` : `Wearing the tunnels into the stone (network ${t.variant + 1} of ${t.variants}; the best is kept)`) : "Paused") : solving ? "Working out the airflow" : "Settled";
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
    if (rr) fields.push(["Airflow refinement", `measured cooling score ${pct(rr.from)} → ${pct(rr.to)} (round ${rr.kept} of ${rr.rounds}); weakest floor ${pct(rr.floorFrom)} → ${pct(rr.floorTo)} average cooling, ${rr.goalMet ? "goal reached" : `goal not reached (stopped: ${rr.reason})`}; ${rr.tubes} tubes, ${rr.openings} wall openings, ${(100 * rr.share).toFixed(1)}% of the mass`]);
    cool.avg.forEach((v, i) => fields.push([`Floor ${i + 1}`, `average cooling ${pct(v)}, ${pct(cool.coverage[i])} cooled by moving air within ${REACH} m`]));
    fields.push(["Evenness", `${pct(cool.evenness)} (the weakest floor over the strongest)`]);
  }
  return { b: 0, title: "Whole structure", summary: `${w.label}${ready ? ` · ${pct(cool.mean)} average cooling` : ""}`, fields };
}

// Keeps what is drawn, and the cut offered to the pipeline, in step with the tunnels: shown whenever there are tunnels that fit the
// form (also while another mode is on), and cleared when they are gone.
function tunnelShowFrame(force = false) {
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
  tunnelView.setVisible(settings.showTunnels);
  // (the skin is made of upright walls and flat roofs: on a rounded massing it would turn the curves into steps, so the
  // massing keeps its own surface, and the openings are cut in that)
  const rounded = hasRoundedMass();
  setRounded(rounded);
  if (t) tunnelView.update(layers.model, t, rounded ? null : { cuts: skinCuts, cutsKey: skinCutsKey, shapes: skinShapes }, skinShapes?.lining ?? null);
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
      if (version === massVersion && tunnels === t) tunnelShowFrame(true);
    }
    if (version === massVersion && tunnels === t && t.done && !t.stale(wind.dir)) tunnelStats = { ...t.tunnelSpeed(), cooling: t.cooling() };
  } catch (e) {
    t.failed = plan; // do not retry until something changes
    console.error("Wind tunnels failed:", e);
  } finally {
    tunnelBusy = false;
  }
}
// The massings without tunnels, as the particles want them: a voxel copy of the form (and the site's buildings) to solve the
// airflow on. It is made again when the form changes, but only once it has stopped changing for a moment.
const PREVIEW_SETTLE = 1500; // ms
let preview = null; // { uncarved, done, vox, massBox, form, builtOn }
let previewSeen = -1, previewSince = 0;
function uncarvedMass() {
  if (preview && preview.form === form && preview.builtOn === form.version) return preview;
  if (form.version !== previewSeen) { previewSeen = form.version; previewSince = performance.now(); }
  // (a new or moved mass has no copy yet, and need not wait: it has already settled, see RESCAN_DELAY)
  if (preview?.form === form && performance.now() - previewSince < PREVIEW_SETTLE) return preview;
  const vox = createVoxelMass(form, { cityHeight: cityHeights(state.site.radius, state.features?.buildings) });
  if (!vox) return null;
  // the footprint and height of the massings, which the particles are aimed at
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = 0;
  for (let j = 0; j < form.nz; j++) {
    for (let i = 0; i < form.nx; i++) {
      const h = form.heights[j * form.nx + i];
      if (h <= 0.5) continue;
      top = Math.max(top, h);
      x0 = Math.min(x0, form.x0 + i * form.cx); x1 = Math.max(x1, form.x0 + (i + 1) * form.cx);
      z0 = Math.min(z0, form.z0 + j * form.cz); z1 = Math.max(z1, form.z0 + (j + 1) * form.cz);
    }
  }
  if (top <= 0) return null;
  preview = { uncarved: true, done: true, vox, massBox: { x0, x1, z0, z1, top }, form, builtOn: form.version };
  return preview;
}

// The wind particles: small particles follow the airflow round and between the massings, or through the wind tunnels once there
// are some, for the wind of the time of year chosen in the panel (by default the one the tunnels were worn for).
function particleFrame(dt) {
  if (!settings.windParticles) { particles.clear(); return setParticleNote(""); }
  if (!getMassInfo()) { particles.clear(); return setParticleNote("Place a .3dm mass for the wind to flow round."); }
  if (!form) { particles.clear(); return setParticleNote("Reading the massings…"); }
  requestWind();
  if (!getWind()) return setParticleNote("Loading wind data…");
  const worn = tunnels && tunnels.builtOn === form.version ? tunnels : null;
  if (settings.erodeTunnels && worn && !worn.done) { particles.clear(); return setParticleNote("Waiting for the tunnels to finish."); }
  const t = worn?.done ? worn : uncarvedMass();
  if (!t) { particles.clear(); return setParticleNote(""); }
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
  patchMass(info.object); // (so that the tunnels can open the mass's own surface)
  restorePending();
}

// The circulation's hallways as boxes ({ frame: { A, B }, rects: [{ y0, y1, a0, a1, b0, b1 }] }, or null), where the skin is cut along the outline of any that
// reaches it, and a key that changes when they do (see circulation/index.js). The skin is made again when the key changes.
let skinCuts = null, skinCutsKey = "";
export function setSkinCuts(cuts, key) {
  skinCuts = cuts;
  skinCutsKey = key;
}

// The shapes the facade gives the tunnels' openings ({ key, lining, shape }, see tunnelMesh.js), or null for the round ones: the
// skin is made again when the key changes (see facades/index.js).
let skinShapes = null;
export function setSkinShapes(shapes) {
  skinShapes = shapes;
}

// The finished tunnels, read-only, for the hallways (erosion/circulation): null until the tunnels are done and fit the form.
export function getFinishedTunnels() {
  return tunnels && form && tunnels.builtOn === form.version && tunnels.done ? tunnels : null;
}

export function mountExterior() {
  particles = createWindParticles();
  tunnelView = createTunnelView();
  coolingView = createCoolingView();
  registerCutProvider("exterior", provideCuts);
  mountPanel($("exterior-panel"), {
    clearErosion: () => {
      tunnels = null; // the tunnels are built afresh from the mass as placed
      tunnelStats = null;
      pending = null;
    },
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
    pending = adopt = null;
    Object.assign(settings, TUNNEL_DEFAULTS);
    syncControls();
  });
  registerPersist("tunnels", {
    capture: captureTunnels,
    // (the massings are read after this, and the tunnels are put back once they are all in: see restorePending)
    restore: (saved) => {
      Object.assign(settings, saved?.settings ?? {});
      pending = saved?.tunnels ?? null;
      syncControls();
      restorePending();
    },
  });

  onFrame((dt) => {
    tunnelFrame();
    tunnelShowFrame();
    setXray(layers.model, settings.xray);
    coolingFrame();
    particleFrame(dt);
  });
}


