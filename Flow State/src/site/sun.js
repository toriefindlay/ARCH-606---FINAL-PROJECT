import * as THREE from "three";
import { sunLight, hemiLight, onFrame } from "../view/scene.js";
import { makeLabel, clearChildren } from "../view/labels.js";
import { state, layers } from "../core/state.js";
import { on } from "../core/events.js";
import { $ } from "../core/dom.js";
import { registerPersist } from "../core/persist.js";

// Sun layer: sun-path arcs over the site, a sun marker, and real shadows from the chosen date/time.

const RAD = Math.PI / 180;
export const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

let sunObjs = null; // { path, marker, ray }
let sunPlaying = false;
const todayISO = new Date().toISOString().slice(0, 10);
$("sun-date").value = todayISO;

const sunDoy = () => {
  const [y, m, d] = ($("sun-date").value || todayISO).split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 864e5);
};

// Solar position from local solar time (no timezone or equation-of-time correction, good to ~15 min).
export function sunPosition(lat, doy, hour) {
  const decl = 23.44 * RAD * Math.sin((2 * Math.PI * (284 + doy)) / 365);
  const H = (hour - 12) * 15 * RAD;
  const phi = lat * RAD;
  const alt = Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) + Math.PI; // from north, clockwise
  // World: x = east, y = up, z = -north.
  const vec = new THREE.Vector3(Math.cos(alt) * Math.sin(az), Math.sin(alt), -Math.cos(alt) * Math.cos(az));
  return { alt, az, vec };
}

// Hours of local solar time at which the sun rises/sets, or { polar } for polar day/night.
function sunTimes(lat, doy) {
  const decl = 23.44 * RAD * Math.sin((2 * Math.PI * (284 + doy)) / 365);
  const c = -Math.tan(lat * RAD) * Math.tan(decl);
  if (c >= 1) return { polar: "night" };
  if (c <= -1) return { polar: "day" };
  const h0 = Math.acos(c) / (15 * RAD);
  return { rise: 12 - h0, set: 12 + h0 };
}

const hhmm = (h) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60) % 60).padStart(2, "0")}`;

function pathPoints(doy, dist) {
  const pts = [];
  for (let h = 0; h <= 24; h += 0.1) {
    const s = sunPosition(state.site.lat, doy, h);
    if (s.alt > 0) pts.push(s.vec.clone().multiplyScalar(dist));
  }
  return pts;
}

function buildSunPath() {
  if (!sunObjs) return;
  const { site } = state;
  clearChildren(sunObjs.path);
  const dist = site.radius * 0.95;
  const dash = site.radius * 0.02;

  for (const [doy, color] of [[172, 0xb08a1e], [80, 0x9a978d], [355, 0x6f9bb5]]) {
    const pts = pathPoints(doy, dist);
    if (pts.length < 2) continue;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color, dashSize: dash, gapSize: dash * 0.7 }));
    line.computeLineDistances();
    sunObjs.path.add(line);
  }

  const doy = sunDoy();
  const pts = pathPoints(doy, dist);
  if (pts.length > 1) sunObjs.path.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xd4542b })));
  const hourly = [];
  for (let h = 1; h < 24; h++) {
    const s = sunPosition(site.lat, doy, h);
    if (s.alt > 0) hourly.push(s.vec.clone().multiplyScalar(dist));
  }
  sunObjs.path.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(hourly), new THREE.PointsMaterial({ color: 0xd4542b, size: site.radius * 0.014 })));
}

function updateSun() {
  const { site } = state;
  if (!site || !sunObjs) return;
  const enabled = layers.sun.visible;
  const hour = parseFloat($("sun-time").value);
  const doy = sunDoy();
  const s = sunPosition(site.lat, doy, hour);

  if (!enabled) {
    // Default studio lighting.
    sunLight.position.set(site.radius * 0.9, site.radius * 1.4, site.radius * 0.5);
    sunLight.intensity = 2.2;
    hemiLight.intensity = 1.4;
    return;
  }

  const dist = site.radius * 0.95;
  sunObjs.marker.visible = s.alt > 0;
  sunObjs.marker.position.copy(s.vec).multiplyScalar(dist);
  sunObjs.ray.visible = s.alt > 0;
  sunObjs.ray.geometry.setFromPoints([new THREE.Vector3(0, 0, 0), sunObjs.marker.position]);

  // Real sun drives the directional light, and so the shadows.
  const up = Math.max(0, Math.min(1, s.alt / (8 * RAD)));
  sunLight.position.copy(s.vec).multiplyScalar(site.radius * 1.6);
  sunLight.intensity = 2.4 * up;
  hemiLight.intensity = 0.35 + 1.05 * up;

  $("sun-time-out").textContent = hhmm(hour);
  const t = sunTimes(site.lat, doy);
  const day = t.polar ? (t.polar === "day" ? "Sun up all day" : "Sun never rises") : `Sunrise <b>${hhmm(t.rise)}</b> · Sunset <b>${hhmm(t.set)}</b><br>Daylight <b>${(t.set - t.rise).toFixed(1)} h</b>`;
  $("sun-readout").innerHTML =
    (s.alt > 0 ? `Altitude <b>${(s.alt / RAD).toFixed(0)}°</b> · Azimuth <b>${compass(s.az / RAD)} ${(s.az / RAD).toFixed(0)}°</b>` : "Sun below horizon") +
    `<br>${day}<br><span class="note">Local solar time</span>`;
}

// Show/hide the panel and switch lighting between the real sun and the default.
function syncSunPanel() {
  const visible = !!layers.sun?.visible;
  $("sun-panel").classList.toggle("hidden", !visible);
  if (!visible) sunPlaying = false;
  updateSun();
}

onFrame((dt) => {
  if (!sunPlaying || !layers.sun?.visible) return;
  const t = sunTimes(state.site.lat, sunDoy());
  const [from, to] = t.polar ? [0, 24] : [t.rise, t.set];
  let h = parseFloat($("sun-time").value) + (dt * (to - from)) / 10; // sweep the daylight in ~10 s
  if (h > to || h < from) h = from;
  $("sun-time").value = h;
  updateSun();
});

$("sun-time").addEventListener("input", updateSun);
$("sun-date").addEventListener("change", () => {
  buildSunPath();
  updateSun();
});
$("sun-play").addEventListener("click", () => {
  sunPlaying = !sunPlaying;
  $("sun-play").textContent = sunPlaying ? "❚❚ Pause" : "▶ Play day";
});

on("site:built", ({ site }) => {
  sunPlaying = false;
  $("sun-play").textContent = "▶ Play day";

  layers.sun = new THREE.Group();
  layers.sun.visible = false;
  state.siteGroup.add(layers.sun);

  // Path group (rebuilt per date), marker, ray to the sun, compass labels.
  const radius = site.radius;
  sunObjs = {
    path: new THREE.Group(),
    marker: new THREE.Mesh(new THREE.SphereGeometry(radius * 0.025, 24, 16), new THREE.MeshBasicMaterial({ color: 0xf2a33a, fog: false })),
    ray: new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xf2a33a })),
  };
  layers.sun.add(sunObjs.path, sunObjs.marker, sunObjs.ray);
  [["N", 0, -1], ["E", 1, 0], ["S", 0, 1], ["W", -1, 0]].forEach(([t, x, z]) => {
    const l = makeLabel(t, radius * 0.07, "#6d6b64");
    l.position.set(x * radius * 1.07, 2, z * radius * 1.07);
    layers.sun.add(l);
  });
  buildSunPath();
  syncSunPanel();
});

on("site:cleared", () => {
  sunPlaying = false;
  sunObjs = null;
});

on("layer:toggled", ({ name }) => name === "sun" && syncSunPanel());

registerPersist("sun", {
  capture: () => ({ date: $("sun-date").value, time: parseFloat($("sun-time").value) }),
  restore: (s) => {
    if (!s.date) return;
    $("sun-date").value = s.date;
    $("sun-time").value = s.time;
    buildSunPath();
    updateSun();
  },
});
