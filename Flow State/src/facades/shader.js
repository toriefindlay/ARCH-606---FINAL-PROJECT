// VIEW (facades): the wall behind a facade's protruding panels (panels.js): glazing or stonework, drawn by the shader on the
// outside walls. Every pixel of a wall works out where it is on its facade (how far along the wall, how high up) and takes
// the colour there, so it covers whatever surface it is given (the massings as placed, or the softened skin), follows its
// curves and stops at the tunnel openings by itself. Roofs are left as they are.
//
// view.js adds this to the materials of the mass and of the skin.
import * as THREE from "three";
import { STOREY } from "../erosion/exterior/tunnels.js";

export const MAX_FRAMES = 16; // massings whose own directions the facade can follow

// Shared by every material that shows a facade; facades/index.js keeps them up to date.
export const facadeUniforms = {
  uFacade: { value: 0 }, // the style (see facades/index.js), 0 for none
  uFacadeSize: { value: 1 }, // how big the panels are, relative to their usual size
  uFrameCount: { value: 0 },
  uFramePos: { value: Array.from({ length: MAX_FRAMES }, () => new THREE.Vector4(0, 0, 1, 0)) }, // centre x, z; cos and sin of the turn
  uFrameHalf: { value: Array.from({ length: MAX_FRAMES }, () => new THREE.Vector2(1, 1)) }, // half its width and depth
};

export const FACADE_GLSL = /* glsl */ `
uniform int uFacade;
uniform float uFacadeSize;
uniform int uFrameCount;
uniform vec4 uFramePos[${MAX_FRAMES}];
uniform vec2 uFrameHalf[${MAX_FRAMES}];
const float STOREY = ${STOREY.toFixed(4)};

vec2 fSlope = vec2(0.0); // how the panel's surface leans, along the wall and up (for the light)
vec3 fAlong = vec3(1.0, 0.0, 0.0); // the world direction along the wall

// Where a point of a wall is along its facade, in metres. Each massing's facades run along its own sides (it may be turned),
// measured from the middle of the side.
float facadeU(vec3 p, vec3 n) {
  float best = 1e9;
  vec4 f = vec4(0.0, 0.0, 1.0, 0.0);
  for (int i = 0; i < ${MAX_FRAMES}; i++) {
    if (i >= uFrameCount) break;
    vec2 d = p.xz - uFramePos[i].xy;
    vec2 l = vec2(d.x * uFramePos[i].z - d.y * uFramePos[i].w, d.x * uFramePos[i].w + d.y * uFramePos[i].z);
    vec2 q = abs(l) - uFrameHalf[i];
    float away = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    if (away < best) { best = away; f = uFramePos[i]; }
  }
  vec2 d = p.xz - f.xy;
  vec2 l = vec2(d.x * f.z - d.y * f.w, d.x * f.w + d.y * f.z);
  vec2 ln = vec2(n.x * f.z - n.z * f.w, n.x * f.w + n.z * f.z);
  bool endWall = abs(ln.x) > abs(ln.y); // faces along the massing's own x: the wall runs along its z
  fAlong = endWall ? vec3(f.w, 0.0, f.z) : vec3(f.z, 0.0, -f.w);
  return endWall ? l.y : l.x;
}

float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
}
// 1 where d (metres) is below w, with an edge softened over a pixel (aa)
float under(float d, float w, float aa) { return 1.0 - smoothstep(w - aa, w + aa, d); }
// how far x is from the nearest line of a set spaced "pitch" apart
float lineAt(float x, float pitch) { return abs(x - pitch * floor(x / pitch + 0.5)); }
vec3 srgb(float r, float g, float b) { return pow(vec3(r, g, b) / 255.0, vec3(2.2)); }
// a pattern too fine to see from here fades into its average colour, instead of flickering
float seen(float cell, float aa) { return 1.0 - smoothstep(0.18, 0.45, aa / cell); }
// 1 on the lines of a grid of equal triangles with sides "side" long
float triangleGrid(vec2 p, float side, float w, float aa) {
  float h = side * 0.866;
  float d = min(lineAt(p.y, h), min(lineAt(p.x * 0.866 - p.y * 0.5, h), lineAt(p.x * 0.866 + p.y * 0.5, h)));
  return under(d, w, aa) * seen(h * 0.5, aa);
}
// dark reflective glass, a little different from pane to pane and paler higher up
vec3 darkGlass(float u, float y, vec2 pane) {
  float k = 0.6 * hash2(floor(vec2(u, y) / pane)) + 0.4 * noise2(vec2(u, y) * 0.12);
  return mix(srgb(30.0, 44.0, 56.0), srgb(88.0, 116.0, 134.0), k);
}

// The wall's colour at u along it and y up. aa: the size of a pixel there, in metres.
vec3 facadeColour(float u, float y, float aa) {
  float s = uFacadeSize;

  if (uFacade == 1) { // behind the triangular shades: glass in tall panes, with a band at every floor
    vec3 col = darkGlass(u, y, vec2(1.2, STOREY));
    col = mix(col, srgb(150.0, 154.0, 150.0), under(lineAt(u, 1.2), 0.025, aa) * seen(1.2, aa));
    return mix(col, srgb(100.0, 104.0, 102.0), under(lineAt(y, STOREY), 0.12, aa));
  }
  if (uFacade == 2) { // behind the blockwork: courses of pale stone
    float courses = max(3.0, floor(STOREY / (0.78 * s) + 0.5)), h = STOREY / courses;
    float row = floor(y / h), x = u / (1.3 * h) + mod(row, 2.0) * 0.5;
    vec3 col = mix(srgb(178.0, 166.0, 142.0), srgb(198.0, 186.0, 164.0), hash2(vec2(floor(x), row)));
    col *= 0.95 + 0.1 * noise2(vec2(u, y) * 9.0);
    float mortar = max(under(lineAt(y, h), 0.022, aa), under(lineAt(x * 1.3 * h, 1.3 * h), 0.022, aa));
    return mix(col, srgb(150.0, 140.0, 120.0), mortar * seen(h, aa));
  }
  if (uFacade == 3) { // behind the web: dark glass in small triangles
    vec3 col = darkGlass(u, y, vec2(0.8, 0.7));
    return mix(col, srgb(128.0, 142.0, 150.0), triangleGrid(vec2(u, y), 1.3 * s, 0.025, aa));
  }
  if (uFacade == 4) { // behind the fins: glass with a pale slab edge at every floor
    vec3 col = darkGlass(u, y, vec2(1.05 * s, STOREY));
    return mix(col, srgb(214.0, 206.0, 192.0), under(lineAt(y, STOREY), 0.16, aa));
  }
  if (uFacade == 5) { // behind the honeycomb: blue-grey glass in triangles
    vec3 col = mix(darkGlass(u, y, vec2(1.1, 1.2)), srgb(112.0, 150.0, 172.0), 0.35);
    col = mix(col, srgb(176.0, 186.0, 192.0), triangleGrid(vec2(u, y), 1.5 * s, 0.022, aa));
    return mix(col, srgb(150.0, 158.0, 162.0), under(lineAt(y, STOREY), 0.09, aa) * 0.6);
  }  return vec3(1.0);
}
`;
