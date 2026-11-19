// VIEW (exterior erosion): the wind as small particles with short trails, drifting through and round the finished wind tunnels.
//
// The particles follow the real airflow of the tunnels (voxelFlow.js: a velocity in every open voxel, relative to the wind far
// away), so they enter the openings, speed up inside the tunnels and part round the outside of the mass. The flow is solved
// for the wind of the chosen time of year (its direction; its mean speed scales the particles). Changing the time of year
// solves the flow for the new wind in the background and then fades the old field into the new one, so the particles bend
// round smoothly instead of jumping.
//
// Smoothness comes from: a gentle blur of the voxel velocities, trilinear sampling, midpoint (RK2) steps, and a fade in/out at
// birth and death. Everything is in world metres, in the same frame as the tunnels (it is added under layers.model).
import * as THREE from "three";
import { solveFlow, tick } from "./voxelFlow.js";
import { downwind } from "../../site/wind.js";

const COUNT = 36000; // particles
const TUNNEL_SHARE = 0.85; // the part of the particles started in the tunnel air (and traced back upwind), the rest are open wind
const TRAIL = 7; // points per trail (the head and TRAIL - 1 older ones)
const SEG = TRAIL - 1;
const TRAIL_DT = 0.07; // seconds between the points kept along a trail
const FADE_IN = 0.8, FADE_OUT = 1.2; // seconds
const BLEND_SECONDS = 1.6; // how long the old season's flow takes to turn into the new one
const RAMP_AT = 2.2; // the speed ratio at which the colour ramp ends

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (t) => t * t * (3 - 2 * t);

// Colour by speed relative to the open wind: blue (slow), teal, amber, red (fast). Written as plain sRGB (the shader does no conversion).
const STOPS = [[0, 0x4a7bd0], [0.4, 0x2aa7a0], [0.7, 0xe3a31b], [1, 0xd9331f]];
const LUT = new Float32Array(65 * 3);
for (let i = 0; i <= 64; i++) {
  const t = i / 64;
  let a = STOPS[0], b = STOPS[STOPS.length - 1];
  for (let s = 0; s < STOPS.length - 1; s++) if (t >= STOPS[s][0] && t <= STOPS[s + 1][0]) { a = STOPS[s]; b = STOPS[s + 1]; break; }
  const u = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
  for (let ch = 0; ch < 3; ch++) {
    const sh = 16 - 8 * ch;
    LUT[i * 3 + ch] = (((a[1] >> sh) & 255) * (1 - u) + ((b[1] >> sh) & 255) * u) / 255;
  }
}

const VERT = `
attribute vec3 aColor; attribute float aAlpha; uniform float uSize; varying vec3 vC; varying float vA;
void main() { vC = aColor; vA = aAlpha; gl_PointSize = uSize; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAG_LINE = `varying vec3 vC; varying float vA; void main() { gl_FragColor = vec4(vC, vA); }`;
const FRAG_DOT = `varying vec3 vC; varying float vA;
void main() { float r = length(gl_PointCoord - 0.5); if (r > 0.5) discard; gl_FragColor = vec4(vC, vA * smoothstep(0.5, 0.15, r)); }`;
const material = (frag, size) => new THREE.ShaderMaterial({
  vertexShader: VERT, fragmentShader: frag, transparent: true, depthWrite: false,
  uniforms: { uSize: { value: size * (window.devicePixelRatio || 1) } },
});

// The solved flow with its velocities blurred over the neighbouring open voxels (a 3x3x3 mean), which removes the stair-steps of the grid.
async function buildField(vox, flow, alive) {
  const { nx, nz, ny } = vox, nxz = nx * nz, n = nxz * ny, { open } = flow;
  const vx = new Float32Array(n), vy = new Float32Array(n), vz = new Float32Array(n);
  for (let l = 0; l < ny; l++) {
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = (l * nz + j) * nx + i;
        if (!open[k]) continue;
        let sx = 0, sy = 0, sz = 0, m = 0;
        for (let dl = -1; dl <= 1; dl++) {
          const ll = l + dl;
          if (ll < 0 || ll >= ny) continue;
          for (let dj = -1; dj <= 1; dj++) {
            const jj = j + dj;
            if (jj < 0 || jj >= nz) continue;
            for (let di = -1; di <= 1; di++) {
              const ii = i + di;
              if (ii < 0 || ii >= nx) continue;
              const q = (ll * nz + jj) * nx + ii;
              if (!open[q]) continue;
              const w = dl === 0 && dj === 0 && di === 0 ? 2 : 1;
              sx += w * flow.vx[q]; sy += w * flow.vy[q]; sz += w * flow.vz[q]; m += w;
            }
          }
        }
        vx[k] = sx / m; vy[k] = sy / m; vz[k] = sz / m;
      }
    }
    if (l % 6 === 5) { await tick(); if (!alive()) return null; }
  }
  return { vx, vy, vz, open, dir: flow.dir, maxSpeed: flow.maxSpeed };
}

// The tunnel air: open voxels inside the mass (below its top, in its footprint) that have solid on at least three sides, with the
// air speed in each, so that particles can be started in proportion to the air the tunnels carry.
function addTunnelCells(t, field) {
  const { vox, massBox: mb } = t, { nx, nz, ny, c, x0, z0, yc } = vox, nxz = nx * nz, open = field.open;
  const cells = [], speeds = [];
  let fastest = 0;
  for (let l = 1; l < ny && yc[l] < mb.top; l++) {
    for (let j = 1; j < nz - 1; j++) {
      const z = z0 + (j + 0.5) * c;
      if (z < mb.z0 || z > mb.z1) continue;
      for (let i = 1; i < nx - 1; i++) {
        const x = x0 + (i + 0.5) * c, k = (l * nz + j) * nx + i;
        if (x < mb.x0 || x > mb.x1 || !open[k]) continue;
        const solid = (open[k - 1] ? 0 : 1) + (open[k + 1] ? 0 : 1) + (open[k - nx] ? 0 : 1) + (open[k + nx] ? 0 : 1) + (open[k - nxz] ? 0 : 1) + (l < ny - 1 && !open[k + nxz] ? 1 : 0);
        if (solid < 3) continue;
        const s = Math.hypot(field.vx[k], field.vy[k], field.vz[k]);
        if (s < 0.03) continue; // dead air: no stream there
        cells.push(k); speeds.push(s);
        if (s > fastest) fastest = s;
      }
    }
  }
  field.cells = Int32Array.from(cells);
  field.cellSpeed = Float32Array.from(speeds);
  field.fastest = fastest || 1;
}

// The velocity of field f at a world point (trilinear between the open voxel centres around it), written to out = [vx, vy, vz].
// False if the point is not in open air.
function sample(vox, f, x, y, z, out) {
  const { nx, nz, ny, c, x0, z0, yc } = vox;
  const k0 = vox.at(x, y, z);
  if (k0 < 0 || !f.open[k0]) return false;
  const fx = (x - x0) / c - 0.5, fz = (z - z0) / c - 0.5;
  const i0 = Math.floor(fx), j0 = Math.floor(fz), tx = fx - i0, tz = fz - j0;
  const l = vox.layerAt(y);
  let l0 = y >= yc[l] ? l : l - 1, l1 = l0 + 1, ty = 0;
  if (l0 < 0) l0 = l1 = 0;
  else if (l1 >= ny) l0 = l1 = ny - 1;
  else ty = (y - yc[l0]) / (yc[l1] - yc[l0]);
  let ax = 0, ay = 0, az = 0, m = 0;
  for (let dl = 0; dl < 2; dl++) {
    const wl = dl ? ty : 1 - ty, ll = dl ? l1 : l0;
    if (wl <= 0) continue;
    for (let dj = 0; dj < 2; dj++) {
      const jj = j0 + dj;
      if (jj < 0 || jj >= nz) continue;
      const wj = wl * (dj ? tz : 1 - tz);
      for (let di = 0; di < 2; di++) {
        const ii = i0 + di;
        if (ii < 0 || ii >= nx) continue;
        const q = (ll * nz + jj) * nx + ii;
        if (!f.open[q]) continue;
        const w = wj * (di ? tx : 1 - tx);
        ax += w * f.vx[q]; ay += w * f.vy[q]; az += w * f.vz[q]; m += w;
      }
    }
  }
  if (m < 1e-6) return false;
  out[0] = ax / m; out[1] = ay / m; out[2] = az / m;
  return true;
}

export function createWindParticles() {
  const px = new Float32Array(COUNT), py = new Float32Array(COUNT), pz = new Float32Array(COUNT);
  const age = new Float32Array(COUNT), life = new Float32Array(COUNT), trailClock = new Float32Array(COUNT);
  const hist = new Float32Array(COUNT * TRAIL * 3);
  const speedNow = new Float32Array(COUNT);

  let group = null, lineGeo = null, dotGeo = null, parent = null;
  let curVox = null, curVersion = -1, token = 0, busy = false, seeded = false;
  const cache = new Map(); // wind direction -> blurred field
  let fieldA = null, fieldB = null, speedA = 1, speedB = 1, blend = 1, wantedKey = "";
  const v1 = [0, 0, 0], v2 = [0, 0, 0], tmp = [0, 0, 0];

  const dispose = () => {
    if (group) {
      group.parent?.remove(group);
      lineGeo.dispose(); dotGeo.dispose();
      for (const o of group.children) o.material.dispose();
    }
    group = lineGeo = dotGeo = parent = null;
  };
  const reset = () => {
    token++;
    busy = false;
    seeded = false;
    cache.clear();
    fieldA = fieldB = null;
    blend = 1;
    wantedKey = "";
    curVox = null;
    curVersion = -1;
  };
  const clear = () => { reset(); dispose(); };

  const build = (to) => {
    dispose();
    lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(COUNT * SEG * 6), 3));
    lineGeo.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(COUNT * SEG * 6), 3));
    lineGeo.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(COUNT * SEG * 2), 1));
    dotGeo = new THREE.BufferGeometry();
    dotGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
    dotGeo.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
    dotGeo.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(COUNT), 1));
    const lines = new THREE.LineSegments(lineGeo, material(FRAG_LINE, 1));
    const dots = new THREE.Points(dotGeo, material(FRAG_DOT, 3.2));
    lines.frustumCulled = dots.frustumCulled = false;
    lines.renderOrder = dots.renderOrder = 6;
    group = new THREE.Group();
    group.add(lines, dots);
    parent = to;
    parent.add(group);
  };

  // Solves (or takes) the airflow for a wind direction and blurs it into a field, in the background.
  const ensure = async (key, dir, t) => {
    busy = true;
    const mine = token, alive = () => mine === token;
    try {
      const flow = t.flow && !t.stale(dir) ? t.flow : await solveFlow(t.vox, { dir });
      if (!alive() || !flow) return;
      const field = await buildField(t.vox, flow, alive);
      if (field && alive()) { addTunnelCells(t, field); cache.set(key, field); }
    } catch (e) {
      console.error("Wind particles: the airflow could not be solved:", e);
      if (alive()) cache.set(key, null); // do not retry until something changes
    } finally {
      if (alive()) busy = false;
    }
  };

  // A particle born in the tunnel air (more where the tunnels carry more) and traced back upwind along the flow, so that a dense
  // stream runs in through the opening and out of the far side. When `first`, only part of the way back, so the view starts full.
  const bt = [0, 0, 0];
  const tunnelSeed = (i, t, first, pathSpeed, R) => {
    const f = fieldB, { vox } = t, { nx, nz, c, x0, z0, ye, dz } = vox, nxz = nx * nz;
    if (!f?.cells?.length) return false;
    const q = (Math.random() * f.cells.length) | 0; // every tunnel cell is equally likely, so a slow tunnel gets as many particles per metre as a fast one
    const k = f.cells[q], l = Math.floor(k / nxz), j = Math.floor((k - l * nxz) / nx), ci = k - l * nxz - j * nx;
    let x = x0 + (ci + Math.random()) * c, z = z0 + (j + Math.random()) * c, y = ye[l] + Math.random() * dz[l];
    const step = 0.6 * c, limit = first ? Math.floor(Math.random() * 160) : 160;
    let back = 0;
    for (let n = 0; n < limit; n++) {
      if (!velocity(vox, x, y, z, bt)) break;
      const m = Math.hypot(bt[0], bt[1], bt[2]);
      if (m < 1e-6) break;
      const ex = x - (bt[0] / m) * step, ey = y - (bt[1] / m) * step, ez = z - (bt[2] / m) * step;
      if (!velocity(vox, ex, ey, ez, bt)) break;
      x = ex; y = ey; z = ez; back += step;
    }
    px[i] = x; py[i] = y; pz[i] = z;
    life[i] = clamp((1.5 * (back + 2 * R + 20)) / Math.max(pathSpeed, 0.1), 5, 60) * (0.8 + Math.random() * 0.4);
    age[i] = 0;
    trailClock[i] = 0;
    for (let p = 0; p < TRAIL; p++) hist.set([x, y, z], (i * TRAIL + p) * 3);
    return true;
  };

  // Where particles are born: upwind of the mass, spread across it, mostly low. `first` scatters them through the whole region instead.
  const spawn = (i, t, dir, pathSpeed, first) => {
    const { vox, massBox: mb } = t;
    const cx = (mb.x0 + mb.x1) / 2, cz = (mb.z0 + mb.z1) / 2, R = Math.hypot(mb.x1 - mb.x0, mb.z1 - mb.z0) / 2;
    const [ux, uz] = dir, hMax = mb.top * 1.05;
    const reach = R * 1.5 + 12;
    if (Math.random() < TUNNEL_SHARE && tunnelSeed(i, t, first, pathSpeed, R)) return;
    // The stream is aimed at the mass: as wide as the mass looks from upwind, and as high as it is, so most particles meet the tunnels.
    const half = (Math.abs(uz) * (mb.x1 - mb.x0) + Math.abs(ux) * (mb.z1 - mb.z0)) / 2 * 1.05 + 3;
    for (let attempt = 0; attempt < 12; attempt++) {
      const a = first ? (Math.random() * 2 - 1) * reach : -reach + Math.random() * 4, b = (Math.random() * 2 - 1) * half;
      const x = cx + ux * a - uz * b, z = cz + uz * a + ux * b, y = 0.3 + Math.random() * hMax;
      const k = vox.at(x, y, z);
      if (k < 0) continue;
      px[i] = x; py[i] = y; pz[i] = z;
      life[i] = clamp((1.7 * (2 * reach)) / Math.max(pathSpeed, 0.1), 5, 45) * (0.7 + Math.random() * 0.6);
      age[i] = first ? Math.random() * life[i] : 0;
      trailClock[i] = 0;
      for (let p = 0; p < TRAIL; p++) hist.set([x, y, z], (i * TRAIL + p) * 3);
      return;
    }
    age[i] = life[i] = 1e9; // nowhere to start (drawn invisible): try again next frame
  };

  const velocity = (vox, x, y, z, out) => {
    const okB = sample(vox, fieldB, x, y, z, v1);
    if (blend >= 1 || !fieldA) { if (okB) { out[0] = v1[0] * speedB; out[1] = v1[1] * speedB; out[2] = v1[2] * speedB; } return okB; }
    const okA = sample(vox, fieldA, x, y, z, v2);
    if (!okA && !okB) return false;
    const e = smooth(blend);
    const ax = okA ? v2[0] * speedA : v1[0] * speedB, ay = okA ? v2[1] * speedA : v1[1] * speedB, az = okA ? v2[2] * speedA : v1[2] * speedB;
    const bx = okB ? v1[0] * speedB : ax, by = okB ? v1[1] * speedB : ay, bz = okB ? v1[2] * speedB : az;
    out[0] = ax + (bx - ax) * e; out[1] = ay + (by - ay) * e; out[2] = az + (bz - az) * e;
    return true;
  };

  return {
    clear,
    // t: the tunnels (tunnels.js), done. wind: { from, mean } the time of year. dt: seconds. pace: scene speed relative to the real wind.
    // Returns a line for the panel ("" when it is simply running).
    update(to, t, wind, { dt = 0, pace = 2 } = {}) {
      if (!to || !t?.done || !wind) { clear(); return ""; }
      const vox = t.vox;
      if (vox !== curVox || vox.version !== curVersion) { reset(); curVox = vox; curVersion = vox.version; }
      if (!group || parent !== to) build(to);

      const dir = downwind(wind.from), key = `${dir[0].toFixed(4)},${dir[1].toFixed(4)}`;
      const U = Math.max(wind.mean || 3, 0.5);
      if (!cache.has(key) && !busy) ensure(key, dir, t);
      const wanted = cache.get(key);
      if (wanted && wanted !== fieldB) { // a new time of year is ready: fade into it
        fieldA = fieldB; speedA = speedB;
        fieldB = wanted; blend = fieldA ? 0 : 1; wantedKey = key;
      }
      if (!fieldB) return cache.get(key) === null ? "The airflow for the particles could not be solved (see the console)." : "Solving the airflow for the particles…";
      speedB = U * pace;
      if (blend < 1) { blend = Math.min(1, blend + dt / BLEND_SECONDS); if (blend >= 1) fieldA = null; }

      const bdir = fieldB.dir, e = blend < 1 ? smooth(blend) : 1;
      const mixDir = fieldA ? [fieldA.dir[0] + (bdir[0] - fieldA.dir[0]) * e, fieldA.dir[1] + (bdir[1] - fieldA.dir[1]) * e] : bdir;
      const mixLen = Math.hypot(mixDir[0], mixDir[1]) || 1, sdir = [mixDir[0] / mixLen, mixDir[1] / mixLen];
      const typical = speedB * 1.1;
      if (!seeded) { for (let i = 0; i < COUNT; i++) spawn(i, t, sdir, typical, true); seeded = true; }

      // Fewer, larger steps when the air is fast relative to a voxel (and a hard cap, so a slow frame cannot stall the page).
      const top = (fieldB.maxSpeed || 2) * Math.max(speedB, fieldA ? speedA : 0);
      const steps = clamp(Math.ceil((top * dt) / (0.5 * vox.c)), 1, 4), h = dt / steps;

      const lp = lineGeo.attributes.position.array, lc = lineGeo.attributes.aColor.array, la = lineGeo.attributes.aAlpha.array;
      const dp = dotGeo.attributes.position.array, dc = dotGeo.attributes.aColor.array, da = dotGeo.attributes.aAlpha.array;

      for (let i = 0; i < COUNT; i++) {
        age[i] += dt;
        let x = px[i], y = py[i], z = pz[i], dead = age[i] >= life[i];
        if (!dead) {
          for (let s = 0; s < steps && !dead; s++) {
            if (!velocity(vox, x, y, z, tmp)) { dead = true; break; }
            const a0 = tmp[0], a1 = tmp[1], a2 = tmp[2];
            if (!velocity(vox, x + a0 * h * 0.5, y + a1 * h * 0.5, z + a2 * h * 0.5, tmp)) { tmp[0] = a0; tmp[1] = a1; tmp[2] = a2; }
            const nx = x + tmp[0] * h, nz = z + tmp[2] * h, ny = Math.max(0.05, y + tmp[1] * h);
            if (vox.at(nx, ny, nz) < 0) { dead = true; break; }
            x = nx; y = ny; z = nz;
            speedNow[i] = Math.hypot(tmp[0], tmp[1], tmp[2]) / Math.max(1e-6, speedB);
          }
        }
        if (dead) { spawn(i, t, sdir, typical, false); x = px[i]; y = py[i]; z = pz[i]; speedNow[i] = 0; }
        else { px[i] = x; py[i] = y; pz[i] = z; }

        // The trail: the head is live, an older point is kept every TRAIL_DT.
        const b = i * TRAIL * 3;
        hist[b] = x; hist[b + 1] = y; hist[b + 2] = z;
        trailClock[i] += dt;
        if (trailClock[i] >= TRAIL_DT) {
          trailClock[i] -= TRAIL_DT;
          hist.copyWithin(b + 6, b + 3, b + 3 * (TRAIL - 1));
          hist[b + 3] = x; hist[b + 4] = y; hist[b + 5] = z;
        }

        const fade = clamp(Math.min(age[i] / FADE_IN, (life[i] - age[i]) / FADE_OUT), 0, 1) * (age[i] > 1e8 ? 0 : 1);
        const li = Math.round(clamp(speedNow[i] / RAMP_AT, 0, 1) * 64) * 3, r = LUT[li], g = LUT[li + 1], bl = LUT[li + 2];
        dp[i * 3] = x; dp[i * 3 + 1] = y; dp[i * 3 + 2] = z;
        dc[i * 3] = r; dc[i * 3 + 1] = g; dc[i * 3 + 2] = bl;
        da[i] = fade * 0.95;
        for (let k = 0; k < SEG; k++) {
          const o = (i * SEG + k) * 6, src = b + k * 3;
          for (let q = 0; q < 6; q++) lp[o + q] = hist[src + q];
          lc[o] = lc[o + 3] = r; lc[o + 1] = lc[o + 4] = g; lc[o + 2] = lc[o + 5] = bl;
          la[(i * SEG + k) * 2] = fade * 0.5 * (1 - k / SEG);
          la[(i * SEG + k) * 2 + 1] = fade * 0.5 * (1 - (k + 1) / SEG);
        }
      }
      lineGeo.attributes.position.needsUpdate = lineGeo.attributes.aColor.needsUpdate = lineGeo.attributes.aAlpha.needsUpdate = true;
      dotGeo.attributes.position.needsUpdate = dotGeo.attributes.aColor.needsUpdate = dotGeo.attributes.aAlpha.needsUpdate = true;
      return blend < 1 ? "Turning the wind to the new time of year…" : "";
    },
  };
}
