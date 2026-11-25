// VIEW (exterior erosion): the mass's surface as the wind tunnels open it, and the x-ray mode.
// Create a group under layers.* on "site:built" and redraw it on "cuts:changed".
import * as THREE from "three";
import { createMeshView } from "./tunnelMesh.js";
import { facadeUniforms, FACADE_GLSL } from "../../facades/shader.js";

export function renderPreview(cuts) {
  // TODO
}

/* ---------- the placed mass, opened by the wind tunnels ---------- */

// The wind tunnels (tunnelMesh.js, grown by tunnels.js): the shader is told where they are by a 3D map over the mass, one byte per texel, how much
// of the point is tunnel (0 to 1, softened so that the edges are smooth). The mass's own surface is discarded where the map is above
// TUNNEL_ISO, so the opening in a wall is exactly the cross-section of the tunnel that tunnelMesh.js draws inside it.
const EMPTY_TUNNEL = new THREE.Data3DTexture(new Uint8Array([0]), 1, 1, 1);
EMPTY_TUNNEL.format = THREE.RedFormat;
EMPTY_TUNNEL.type = THREE.UnsignedByteType;
EMPTY_TUNNEL.unpackAlignment = 1;
EMPTY_TUNNEL.needsUpdate = true;
const tunnelUniforms = {
  uTunnelTex: { value: EMPTY_TUNNEL },
  uHideMass: { value: 0 }, // 1 while the softened skin (skinShell.js) is drawn: it replaces the mass's own surface and edge lines altogether
  uTunnelOrigin: { value: new THREE.Vector3() }, // the map's corner in world metres (y = 0 is the ground)
  uTunnelSize: { value: new THREE.Vector3(1, 1, 1) }, // its size in x, y, z
  uTunnelIso: { value: 0.5 },
};
const TUNNEL_GLSL = /* glsl */ `
uniform highp sampler3D uTunnelTex;
uniform float uHideMass;
uniform vec3 uTunnelOrigin;
uniform vec3 uTunnelSize;
uniform float uTunnelIso;
varying vec3 vWindPos;
bool tunnelAt(vec3 p) {
  vec3 uvw = (p - uTunnelOrigin) / uTunnelSize;
  uvw = vec3(uvw.x, uvw.z, uvw.y); // the map's depth is height
  if (uvw.x < 0.0 || uvw.y < 0.0 || uvw.z < 0.0 || uvw.x > 1.0 || uvw.y > 1.0 || uvw.z > 1.0) return false;
  return texture(uTunnelTex, uvw).r > uTunnelIso;
}
// A piece of the mass's surface (not a roof or an underside) goes if it lies in a tunnel, or just inside one (lines have no normal and are only tested where they are).
bool tunnelCut(vec3 p, vec3 n) {
  if (dot(n, n) > 0.0 && abs(n.y) > 0.6) return false; // roofs and undersides are never opened (the tunnels run through the walls)
  if (tunnelAt(p)) return true;
  return dot(n, n) > 0.0 && tunnelAt(p - n * 0.2);
}
vec3 facing() {
  vec3 c = cross(dFdx(vWindPos), dFdy(vWindPos));
  float l = length(c);
  return l > 1e-9 ? c / l : vec3(0.0);
}
`;

// The facade on a wall (facades/shader.js): its colour, with a pale trim round every tunnel opening, and the lean of its
// panels for the light. Roofs and undersides stay plain.
const FACADE_COLOUR = /* glsl */ `
#include <color_fragment>
if (uFacade > 0) {
  vec3 fn = facing();
  if (abs(fn.y) < 0.6) {
    float u = facadeU(vWindPos, fn);
    float aa = 0.7 * length(fwidth(vWindPos)) + 1e-4;
    diffuseColor.rgb = facadeColour(u, vWindPos.y, aa);
    vec3 inside = vWindPos - fn * 0.2;
    if (tunnelAt(inside + fAlong * 0.28) || tunnelAt(inside - fAlong * 0.28) || tunnelAt(inside + vec3(0.0, 0.28, 0.0)) || tunnelAt(inside - vec3(0.0, 0.28, 0.0))) {
      diffuseColor.rgb = srgb(232.0, 226.0, 214.0);
      fSlope = vec2(0.0);
    }
  }
}`;
const FACADE_LIGHT = /* glsl */ `
#include <normal_fragment_maps>
if (uFacade > 0) normal = normalize(normal + mat3(viewMatrix) * (fAlong * fSlope.x + vec3(0.0, fSlope.y, 0.0)));`;

// `kind`: "mesh" (a surface: tested just inside), "line" (the mass's edge lines: tested where they are) or "skin" (the
// softened skin, which has the tunnels' openings in its own shape: nothing of it is discarded). Surfaces carry the facade.
const patched = new WeakSet();
function patch(material, key, kind) {
  if (patched.has(material)) return;
  patched.add(material);
  const discard = "uHideMass > 0.5 || tunnelCut(vWindPos, wn)";
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, tunnelUniforms, facadeUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWindPos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWindPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>\n${TUNNEL_GLSL}${kind === "line" ? "" : FACADE_GLSL}`);
    if (kind !== "skin") {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>\nvec3 wn = ${kind === "line" ? "vec3(0.0)" : "facing()"};\nif (${discard}) discard;`
      );
    }
    if (kind !== "line") {
      shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>", FACADE_COLOUR).replace("#include <normal_fragment_maps>", FACADE_LIGHT);
    }
  };
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
}

// The mass's own materials (shared white-model material and its edge lines) start discarding what the tunnels open.
export function patchMass(root) {
  root.traverse((o) => {
    const materials = [o.material].flat().filter(Boolean);
    if (o.isMesh) materials.forEach((m) => patch(m, "wind-mass", "mesh"));
    else if (o.isLineSegments) materials.forEach((m) => patch(m, "wind-mass-edge", "line"));
  });
}

/* ---------- the wind tunnels ---------- */

// The tunnels' walls and the openings they leave in the mass's surface: see tunnelMesh.js, which draws them and fills the map above.
export const createTunnelView = () => createMeshView(tunnelUniforms, EMPTY_TUNNEL, (skin) => patch(skin, "facade-skin", "skin"));

/* ---------- x-ray ---------- */

// X-ray: the mass's own surfaces and edge lines are drawn faint (and do not hide what is behind them) so that only the tunnels,
// which are left alone (userData.solid), show as solid. Switched back, the materials are put as they were.
const original = new WeakMap();
let xrayState = "";
export function setXray(root, on) {
  if (!root) return;
  let count = 0;
  root.traverse(() => count++);
  const state = `${on}|${root.id}|${count}`; // redone when the mass changes (a new model, the tunnels' surfaces)
  if (state === xrayState) return;
  xrayState = state;
  const visit = (o) => {
    if (o.userData?.solid) return;
    const materials = [o.material].flat().filter(Boolean);
    for (const m of materials) {
      if (!original.has(m)) original.set(m, { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite });
      const was = original.get(m);
      m.transparent = on || was.transparent;
      m.opacity = on ? (o.isLineSegments ? 0.35 : 0.14) * was.opacity : was.opacity;
      m.depthWrite = on ? false : was.depthWrite;
      m.needsUpdate = true;
    }
    o.children.forEach(visit);
  };
  visit(root);
}


