// VIEW (exterior erosion): draws a preview of the exterior cuts in the scene.
// Create a group under layers.* on "site:built" and redraw it on "cuts:changed".
import * as THREE from "three";
import { MAX_PEOPLE, MAX_CARS } from "./traffic.js";
import { MAX_SPHERES, SPHERE_SQUASH } from "./erosion.js";

export function renderPreview(cuts) {
  // TODO
}

/* ---------- traffic particles ---------- */

// One instanced mesh for people, one for cars. `size` exaggerates them so they
// read at site scale (1 = true size: a 1.7 m person, a 4.5 m car).
const GROUND = 0.35;

export function createTrafficView(group) {
  const people = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.3, 0.3, 1.7, 8).translate(0, 0.85, 0),
    new THREE.MeshLambertMaterial({ color: 0x0f766e }),
    MAX_PEOPLE
  );
  const cars = new THREE.InstancedMesh(
    new THREE.BoxGeometry(4.5, 1.5, 1.8).translate(0, 0.75, 0),
    new THREE.MeshLambertMaterial({ color: 0x2f4b8f }),
    MAX_CARS
  );
  for (const mesh of [people, cars]) {
    mesh.count = 0;
    mesh.frustumCulled = false; // instances move; the geometry's own bounds sit at the origin
    group.add(mesh);
  }

  const dummy = new THREE.Object3D();
  const fill = (mesh, list, size, rotate) => {
    list.forEach((a, i) => {
      dummy.position.set(a.x, GROUND, -a.y); // site (east, north) -> world (x, up, -north)
      dummy.rotation.y = rotate ? Math.atan2(a.hy, a.hx) : 0;
      dummy.scale.setScalar(size);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.count = list.length;
    mesh.instanceMatrix.needsUpdate = true;
  };

  return {
    update(sim, size) {
      fill(people, sim.people, size, false);
      fill(cars, sim.cars, size, true);
    },
  };
}

/* ---------- carved mass ---------- */

// The mass is a plain mesh with no boolean applied (see ARCHITECTURE: erosion uses distance fields), so the carve is
// shown in two parts. (1) The mass's material discards any fragment inside a hollow. (2) The inside of each hollow is
// drawn as its own surface, clipped to where the mass actually is, and coloured purple: lighter where little has
// passed, darker with every pass. Both read the hollows from textures through these shared uniforms.

const dataTexture = (data, w, h) => {
  const t = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
};
const EMPTY = dataTexture(new Float32Array(1), 1, 1);

const carveUniforms = {
  uTopTex: { value: EMPTY }, // top of the mass, 2 × 2 samples per cell
  uCarveFrame: { value: new THREE.Vector4() }, // grid origin u, v and cell size u, v
  uCarveSize: { value: new THREE.Vector2() }, // cells in u, v (0 = nothing carved)
  uCarveInv: { value: new THREE.Vector4(1, 0, 0, 1) }, // world (x, z) -> grid (u, v): u = xy·(x, z), v = zw·(x, z)
  uSphereTex: { value: EMPTY }, // hollows: x, z, radius per texel
  uSphereCount: { value: 0 },
  uSphereMask: { value: EMPTY }, // 1 in every grid cell a hollow reaches
};

const CARVE_GLSL = /* glsl */ `
uniform sampler2D uTopTex;
uniform vec4 uCarveFrame;
uniform vec2 uCarveSize;
uniform vec4 uCarveInv;
uniform sampler2D uSphereTex;
uniform float uSphereCount;
uniform sampler2D uSphereMask;
varying vec3 vCarvePos;
vec2 carveUV(vec3 p) {
  return vec2(uCarveInv.x * p.x + uCarveInv.y * p.z - uCarveFrame.x, uCarveInv.z * p.x + uCarveInv.w * p.z - uCarveFrame.y);
}
float carveTop(vec3 p) {
  if (uCarveSize.x <= 0.0) return 0.0;
  vec2 uv = carveUV(p) / (uCarveSize * uCarveFrame.zw);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  return texture2D(uTopTex, uv).r;
}
// True if p is inside a hollow (a sphere centred on the ground, stretched in height), shrunk by \`shrink\` metres.
// The mask says which grid cells any hollow reaches, so most of the mass skips the loop.
bool carveSphere(vec3 p, float shrink) {
  if (uSphereCount <= 0.0) return false;
  vec2 uv = carveUV(p) / (uCarveSize * uCarveFrame.zw);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return false;
  if (texture2D(uSphereMask, uv).r < 0.5) return false;
  for (int i = 0; i < ${MAX_SPHERES}; i++) {
    if (float(i) >= uSphereCount) break;
    vec4 s = texture2D(uSphereTex, vec2((float(i) + 0.5) / ${MAX_SPHERES}.0, 0.5));
    vec3 d = vec3(p.x - s.x, p.y / ${SPHERE_SQUASH.toFixed(2)}, p.z - s.y);
    float r = s.z - shrink;
    if (dot(d, d) < r * r) return true;
  }
  return false;
}
`;
// The mass: drop what lies inside a hollow.
const DISCARD_CARVED = "if (carveSphere(vCarvePos, -0.06)) discard;";
// The inside of a hollow: drop what is outside the mass, underground, or inside a neighbouring hollow.
const DISCARD_OUTSIDE_MASS =
  "float carveT = carveTop(vCarvePos); if (carveT < 0.05 || vCarvePos.y > carveT + 0.03 || vCarvePos.y < 0.0 || carveSphere(vCarvePos, 0.05)) discard;";

const patched = new WeakSet();
function patch(material, key, body) {
  if (patched.has(material)) return;
  patched.add(material);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, carveUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCarvePos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvec4 carveLocal = vec4(transformed, 1.0);\n#ifdef USE_INSTANCING\ncarveLocal = instanceMatrix * carveLocal;\n#endif\nvCarvePos = (modelMatrix * carveLocal).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${CARVE_GLSL}`)
      .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>\n${body}`);
  };
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
}

// The mass's own materials (shared white-model material and its edge lines) start discarding what lies in a hollow.
function patchMass(root) {
  root.traverse((o) => {
    const materials = [o.material].flat().filter(Boolean);
    if (o.isMesh) materials.forEach((m) => patch(m, "carve-mass", DISCARD_CARVED));
    else if (o.isLineSegments) materials.forEach((m) => patch(m, "carve-mass-edge", DISCARD_CARVED));
  });
}

// Hollows are drawn as spheres seen from inside (domed, stretched in height). Each one's colour comes from its wear.
const hollowMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.BackSide });
patch(hollowMaterial, "carve-hollow", DISCARD_OUTSIDE_MASS);

// Light lilac where little has passed, deep purple where most has: wear 0..1.
const LIGHT_PURPLE = 0.8, DARK_PURPLE = 0.13; // lightness
const wearColour = (color, wear) => color.setHSL(0.76, 0.5, LIGHT_PURPLE + (DARK_PURPLE - LIGHT_PURPLE) * wear);

export function createCarveView() {
  let group = null, topTexture = null, sphereTexture = null, maskTexture = null, hollows = null, scan = null;
  const dummy = new THREE.Object3D(), colour = new THREE.Color();

  const clear = () => {
    carveUniforms.uCarveSize.value.set(0, 0);
    carveUniforms.uSphereCount.value = 0;
    carveUniforms.uTopTex.value = carveUniforms.uSphereTex.value = carveUniforms.uSphereMask.value = EMPTY;
    group?.traverse((o) => o.geometry?.dispose());
    group?.parent?.remove(group);
    topTexture?.dispose();
    sphereTexture?.dispose();
    maskTexture?.dispose();
    group = topTexture = sphereTexture = maskTexture = hollows = scan = null;
  };

  return {
    clear,
    // Start showing hollows in `root` (the placed mass), adding their inside surfaces to `parent`.
    setLattice(lattice, parent, root) {
      clear();
      scan = lattice;
      patchMass(root);
      topTexture = dataTexture(lattice.hf, lattice.hw, lattice.hh);
      sphereTexture = new THREE.DataTexture(new Float32Array(MAX_SPHERES * 4), MAX_SPHERES, 1, THREE.RGBAFormat, THREE.FloatType);
      sphereTexture.minFilter = sphereTexture.magFilter = THREE.NearestFilter;
      sphereTexture.needsUpdate = true;
      maskTexture = dataTexture(new Float32Array(lattice.nU * lattice.nV), lattice.nU, lattice.nV);
      carveUniforms.uCarveFrame.value.set(lattice.u0, lattice.v0, lattice.cu, lattice.cv);
      carveUniforms.uCarveSize.value.set(lattice.nU, lattice.nV);
      carveUniforms.uCarveInv.value.set(...lattice.inv);
      carveUniforms.uTopTex.value = topTexture;
      carveUniforms.uSphereTex.value = sphereTexture;
      carveUniforms.uSphereMask.value = maskTexture;
      hollows = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 10), hollowMaterial, MAX_SPHERES);
      hollows.setColorAt(0, colour.set(0xffffff)); // creates the per-instance colour, so the material uses it from the start
      hollows.count = 0;
      hollows.frustumCulled = false;
      group = new THREE.Group();
      group.add(hollows);
      parent.add(group);
    },
    // Show the hollows of an erosion (see erosion.js).
    update(er) {
      if (!group) return;
      const data = sphereTexture.image.data, mask = maskTexture.image.data;
      data.fill(0);
      mask.fill(0);
      const { nU, nV, cu, cv } = scan;
      er.spheres.forEach((s, i) => {
        data.set([s.x, s.z, s.r, 0], i * 4);
        // Mark the grid cells this hollow reaches, with a cell to spare.
        const [u, v] = scan.toUV(s.x, s.z), reach = s.r * 1.5;
        for (let j = Math.max(0, Math.floor((v - reach) / cv) - 1); j <= Math.min(nV - 1, Math.floor((v + reach) / cv) + 1); j++) {
          for (let k = Math.max(0, Math.floor((u - reach) / cu) - 1); k <= Math.min(nU - 1, Math.floor((u + reach) / cu) + 1); k++) mask[j * nU + k] = 1;
        }
        dummy.position.set(s.x, 0, s.z);
        dummy.scale.set(s.r, s.r * SPHERE_SQUASH, s.r);
        dummy.updateMatrix();
        hollows.setMatrixAt(i, dummy.matrix);
        hollows.setColorAt(i, wearColour(colour, s.wear));
      });
      hollows.count = er.spheres.length;
      hollows.instanceMatrix.needsUpdate = true;
      hollows.instanceColor.needsUpdate = true;
      sphereTexture.needsUpdate = true;
      maskTexture.needsUpdate = true;
      carveUniforms.uSphereCount.value = er.spheres.length;
    },
  };
}
