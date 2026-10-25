import * as THREE from "three";
import { SKY, onFrame } from "../view/scene.js";
import { makeLabel, clearChildren } from "../view/labels.js";
import { state, layers } from "../core/state.js";
import { on } from "../core/events.js";
import { $ } from "../core/dom.js";
import { registerPersist } from "../core/persist.js";
import { compass } from "./sun.js";

// Wind layer: a wind rose at the site centre plus streaks drifting downwind at the average speed.
// Data: a year of hourly 10 m reanalysis wind from Open-Meteo (regional, not measured on site).

const RAD = Math.PI / 180;
let windState = null; // { raw, stats, streaks }
const windRaw = new Map(); // site key -> hourly series
const SEASONS = { all: null, djf: [12, 1, 2], mam: [3, 4, 5], jja: [6, 7, 8], son: [9, 10, 11] };
const STREAKS = 450;

async function fetchWind(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (windRaw.has(key)) return windRaw.get(key);
  const y = new Date().getFullYear() - 1; // last full year of reanalysis data
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&start_date=${y}-01-01&end_date=${y}-12-31&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=GMT`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wind service responded ${res.status}`);
  const j = await res.json();
  const raw = {
    speed: j.hourly.wind_speed_10m,
    dir: j.hourly.wind_direction_10m,
    month: j.hourly.time.map((t) => parseInt(t.slice(5, 7), 10)),
    year: y,
  };
  windRaw.set(key, raw);
  return raw;
}

// Meteorological convention: direction is where the wind comes FROM, degrees clockwise from north.
function windStats(raw, months) {
  const bins = Array.from({ length: 16 }, () => ({ n: 0, sum: 0 }));
  let n = 0, sum = 0, calm = 0;
  for (let i = 0; i < raw.speed.length; i++) {
    const v = raw.speed[i], d = raw.dir[i];
    if (v == null || d == null || (months && !months.includes(raw.month[i]))) continue;
    n++;
    sum += v;
    if (v < 0.5) { calm++; continue; }
    const b = bins[Math.round(d / 22.5) % 16];
    b.n++;
    b.sum += v;
  }
  const out = bins.map((b) => ({ freq: n ? b.n / n : 0, mean: b.n ? b.sum / b.n : 0 }));
  const top = out.reduce((best, b, i) => (b.freq > out[best].freq ? i : best), 0);
  return { n, mean: n ? sum / n : 0, calm: n ? calm / n : 0, bins: out, top, from: top * 22.5 };
}

async function ensureWind() {
  const s = state.site;
  if (!s || windState) return;
  $("wind-readout").textContent = "Loading wind data…";
  try {
    const raw = await fetchWind(s.lat, s.lon);
    if (state.site !== s) return; // site changed while loading
    windState = { raw, stats: null, streaks: null };
    refreshWind();
  } catch (e) {
    if (state.site === s) $("wind-readout").textContent = `Couldn't load wind data (${e.message}).`;
  }
}

function refreshWind() {
  if (!windState) return;
  const st = windStats(windState.raw, SEASONS[$("wind-season").value]);
  windState.stats = st;
  buildWind();
  const top = st.bins[st.top];
  $("wind-readout").innerHTML =
    `Prevailing from <b>${compass(st.from)} (${st.from.toFixed(0)}°)</b><br>` +
    `<b>${(top.freq * 100).toFixed(0)}%</b> of hours, avg <b>${top.mean.toFixed(1)} m/s</b><br>` +
    `Average speed <b>${st.mean.toFixed(1)} m/s</b> (${(st.mean * 3.6).toFixed(0)} km/h)<br>` +
    `Calm <b>${(st.calm * 100).toFixed(0)}%</b><br>` +
    `<span class="note">${windState.raw.year} hourly reanalysis at 10 m, regional not on-site. Rose points to where wind comes from.</span>`;
}

// Downwind unit vector in world (x, z): wind from θ blows toward θ + 180°.
export const downwind = (fromDeg) => [-Math.sin(fromDeg * RAD), Math.cos(fromDeg * RAD)];

// Prevailing wind for other modules (e.g. erosion rules): { from, mean, bins } or null until loaded.
export const getWind = () => windState?.stats ?? null;

function buildWind() {
  const g = layers.wind;
  clearChildren(g);
  const R = state.site.radius;
  const st = windState.stats;

  // Wind rose at the site centre: petal length = share of hours, colour = average speed.
  const roseR = R * 0.28;
  const maxFreq = Math.max(...st.bins.map((b) => b.freq), 1e-6);
  const slow = new THREE.Color(0xbcd4e6), fast = new THREE.Color(0x1f4e79);
  const pos = [], col = [];
  st.bins.forEach((b, i) => {
    if (!b.freq) return;
    const len = roseR * (b.freq / maxFreq);
    const c = slow.clone().lerp(fast, Math.min(b.mean / 8, 1));
    const a0 = (i * 22.5 - 9) * RAD, a1 = (i * 22.5 + 9) * RAD;
    const at = (a, l) => [Math.sin(a) * l, 1.5, -Math.cos(a) * l]; // from-direction: x = east, z = -north
    const steps = 4;
    for (let k = 0; k < steps; k++) {
      const p = a0 + ((a1 - a0) * k) / steps, q = a0 + ((a1 - a0) * (k + 1)) / steps;
      pos.push(0, 1.5, 0, ...at(p, len), ...at(q, len));
      for (let j = 0; j < 3; j++) col.push(c.r, c.g, c.b);
    }
  });
  const roseGeo = new THREE.BufferGeometry();
  roseGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  roseGeo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const rose = new THREE.Mesh(roseGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthTest: false }));
  rose.renderOrder = 10;
  g.add(rose);

  for (const f of [0.5, 1]) {
    const ring = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(Array.from({ length: 65 }, (_, i) => new THREE.Vector3(Math.cos((i / 64) * Math.PI * 2) * roseR * f, 1.5, Math.sin((i / 64) * Math.PI * 2) * roseR * f))),
      new THREE.LineBasicMaterial({ color: 0x6d6b64, transparent: true, opacity: 0.6, depthTest: false })
    );
    ring.renderOrder = 11;
    g.add(ring);
  }
  const n = makeLabel("N", R * 0.06, "#1f4e79");
  n.position.set(0, 2, -roseR * 1.15);
  g.add(n);

  // Streaks drifting downwind at the average speed.
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(STREAKS * 6), 3));
  const colors = new Float32Array(STREAKS * 6);
  const head = new THREE.Color(0x2b6cb0), tail = SKY;
  for (let i = 0; i < STREAKS; i++) {
    colors.set([tail.r, tail.g, tail.b, head.r, head.g, head.b], i * 6);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
  lines.frustumCulled = false;
  g.add(lines);

  const Rd = R * 1.05;
  const xz = new Float32Array(STREAKS * 2);
  const y = new Float32Array(STREAKS);
  for (let i = 0; i < STREAKS; i++) {
    const r = Rd * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
    xz[i * 2] = Math.cos(a) * r;
    xz[i * 2 + 1] = Math.sin(a) * r;
    y[i] = 3 + Math.random() * 45;
  }
  windState.streaks = { geo, xz, y, Rd };
}

onFrame((dt) => {
  const w = windState;
  if (!w?.streaks || !layers.wind?.visible) return;
  const { geo, xz, y, Rd } = w.streaks;
  const [dx, dz] = downwind(w.stats.from);
  const v = w.stats.mean * 4; // scene m/s: exaggerated so drift is visible
  const len = 8 + w.stats.mean * 4;
  const p = geo.attributes.position.array;
  const baseA = Math.atan2(-dz, -dx); // upwind direction

  for (let i = 0; i < STREAKS; i++) {
    let x = xz[i * 2] + dx * v * dt;
    let z = xz[i * 2 + 1] + dz * v * dt;
    if (x * x + z * z > Rd * Rd) {
      const a = baseA + (Math.random() - 0.5) * Math.PI;
      x = Math.cos(a) * Rd;
      z = Math.sin(a) * Rd;
      y[i] = 3 + Math.random() * 45;
    }
    xz[i * 2] = x;
    xz[i * 2 + 1] = z;
    p.set([x - dx * len, y[i], z - dz * len, x, y[i], z], i * 6);
  }
  geo.attributes.position.needsUpdate = true;
});

function syncWindPanel() {
  const visible = !!layers.wind?.visible;
  $("wind-panel").classList.toggle("hidden", !visible);
  if (visible) ensureWind();
}

$("wind-season").addEventListener("change", refreshWind);

on("site:built", () => {
  windState = null;
  $("wind-readout").textContent = "";
  layers.wind = new THREE.Group();
  layers.wind.visible = false;
  state.siteGroup.add(layers.wind);
  syncWindPanel();
});

on("site:cleared", () => (windState = null));

on("layer:toggled", ({ name }) => name === "wind" && syncWindPanel());

registerPersist("windSeason", {
  capture: () => $("wind-season").value,
  restore: (season) => {
    $("wind-season").value = season;
    refreshWind(); // no-op until the data has loaded
  },
});
