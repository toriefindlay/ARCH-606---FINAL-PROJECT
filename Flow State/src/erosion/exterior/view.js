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
// shown in two parts. (1) The mass's material discards any fragment inside a carved cell. (2) The inside of each carved
// space (ceiling and walls) is drawn as its own mesh, clipped to where the mass actually is.
// Cells live on the lattice from language.js; both parts read it from textures through these shared uniforms.

const dataTexture = (data, w, h) => {
  const t = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
};
const EMPTY = dataTexture(new Float32Array(1), 1, 1);

const carveUniforms = {
  uCarveH: { value: EMPTY }, // carved height per cell
  uTopTex: { value: EMPTY }, // top of the mass, 2 × 2 samples per cell
  uCarveFrame: { value: new THREE.Vector4() }, // lattice origin u, v and cell size u, v
  uCarveSize: { value: new THREE.Vector2() }, // cells in u, v (0 = nothing carved)
  uCarveInv: { value: new THREE.Vector4(1, 0, 0, 1) }, // world (x, z) -> lattice (u, v): u = xy·(x, z), v = zw·(x, z)
  uSphereTex: { value: EMPTY }, // round hollows: x, z, radius per texel
  uSphereCount: { value: 0 },
};

const CARVE_GLSL = /* glsl */ `
uniform sampler2D uCarveH;
uniform sampler2D uTopTex;
uniform vec4 uCarveFrame;
uniform vec2 uCarveSize;
uniform vec4 uCarveInv;
uniform sampler2D uSphereTex;
uniform float uSphereCount;
varying vec3 vCarvePos;
// True if p is inside a round hollow (a sphere centred on the ground, squashed in height), shrunk by \`shrink\` metres.
bool carveSphere(vec3 p, float shrink) {
  for (int i = 0; i < ${MAX_SPHERES}; i++) {
    if (float(i) >= uSphereCount) break;
    vec4 s = texture2D(uSphereTex, vec2((float(i) + 0.5) / ${MAX_SPHERES}.0, 0.5));
    vec3 d = vec3(p.x - s.x, p.y / ${SPHERE_SQUASH.toFixed(2)}, p.z - s.y);
    float r = s.z - shrink;
    if (dot(d, d) < r * r) return true;
  }
  return false;
}
vec2 carveUV(vec3 p) {
  return vec2(uCarveInv.x * p.x + uCarveInv.y * p.z - uCarveFrame.x, uCarveInv.z * p.x + uCarveInv.w * p.z - uCarveFrame.y);
}
bool carveInside(vec3 p, float eps) {
  vec2 uv = carveUV(p);
  vec2 cell = uCarveFrame.zw;
  vec2 c0 = floor(uv / cell);
  for (int a = -1; a <= 1; a++) {
    for (int b = -1; b <= 1; b++) {
      vec2 c = c0 + vec2(float(a), float(b));
      if (c.x < 0.0 || c.y < 0.0 || c.x >= uCarveSize.x || c.y >= uCarveSize.y) continue;
      float h = texture2D(uCarveH, (c + 0.5) / uCarveSize).r;
      if (h <= 0.0) continue;
      vec2 d = abs(uv - (c + 0.5) * cell) - (0.5 * cell + eps);
      if (d.x <= 0.0 && d.y <= 0.0 && p.y < h) return true;
    }
  }
  return false;
}
float carveTop(vec3 p) {
  if (uCarveSize.x <= 0.0) return 0.0;
  vec2 uv = carveUV(p) / (uCarveSize * uCarveFrame.zw);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  return texture2D(uTopTex, uv).r;
}
`;
// The mass: drop what lies inside a carved cell or a round hollow.
const DISCARD_CARVED = "if (carveInside(vCarvePos, 0.06) || carveSphere(vCarvePos, -0.06)) discard;";
// The inside of a carved space: drop what is outside the mass, underground, or inside a neighbouring hollow.
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

// The mass's own materials (shared white-model material and its edge lines) start discarding carved cells.
function patchMass(root) {
  root.traverse((o) => {
    const materials = [o.material].flat().filter(Boolean);
    if (o.isMesh) materials.forEach((m) => patch(m, "carve-mass", DISCARD_CARVED));
    else if (o.isLineSegments) materials.forEach((m) => patch(m, "carve-mass-edge", DISCARD_CARVED));
  });
}

const wallMaterial = new THREE.MeshLambertMaterial({ color: 0xf2cbb9, side: THREE.DoubleSide });
const wallEdgeMaterial = new THREE.LineBasicMaterial({ color: 0x7a2a12 });
patch(wallMaterial, "carve-wall", DISCARD_OUTSIDE_MASS);
patch(wallEdgeMaterial, "carve-wall-edge", DISCARD_OUTSIDE_MASS);

// Ceiling of every carved cell, and a wall wherever it is taller than a neighbour that is also inside the mass.
// Neighbours outside the mass get no wall: that side is the opening.
function wallGeometry(scan, H) {
  const { nU, nV, cu, cv, ok } = scan;
  const pos = [];
  const P = (u, y, v) => {
    const [x, z] = scan.toXZ(u, v);
    return [x, y, z];
  };
  const quad = (a, b, c, d) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let j = 0; j < nV; j++) {
    for (let i = 0; i < nU; i++) {
      const h = H[j * nU + i];
      if (!h) continue;
      const x0 = i * cu, x1 = x0 + cu, z0 = j * cv, z1 = z0 + cv;
      quad(P(x0, h, z0), P(x1, h, z0), P(x1, h, z1), P(x0, h, z1));
      const sides = [
        [1, 0, [x1, z0], [x1, z1]],
        [-1, 0, [x0, z0], [x0, z1]],
        [0, 1, [x0, z1], [x1, z1]],
        [0, -1, [x0, z0], [x1, z0]],
      ];
      for (const [di, dj, [au, av], [bu, bv]] of sides) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= nU || nj >= nV || !ok[nj * nU + ni]) continue;
        const low = H[nj * nU + ni];
        if (low >= h) continue;
        quad(P(au, low, av), P(bu, low, bv), P(bu, h, bv), P(au, h, av));
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

// Round hollows are drawn as spheres seen from inside (domed, squashed in height), clipped like the walls above.
const hollowMaterial = new THREE.MeshLambertMaterial({ color: 0xf2cbb9, side: THREE.BackSide });
patch(hollowMaterial, "carve-hollow", DISCARD_OUTSIDE_MASS);

export function createCarveView() {
  let group = null, hTexture = null, topTexture = null, sphereTexture = null, hollows = null, scan = null;
  const dummy = new THREE.Object3D();

  const clear = () => {
    carveUniforms.uCarveSize.value.set(0, 0);
    carveUniforms.uSphereCount.value = 0;
    carveUniforms.uCarveH.value = carveUniforms.uTopTex.value = carveUniforms.uSphereTex.value = EMPTY;
    group?.traverse((o) => o.geometry?.dispose());
    group?.parent?.remove(group);
    hTexture?.dispose();
    topTexture?.dispose();
    sphereTexture?.dispose();
    group = hTexture = topTexture = sphereTexture = hollows = scan = null;
  };

  return {
    clear,
    // Start showing carving on `root` (the placed mass), adding the interior meshes to `parent`.
    setLattice(lattice, parent, root) {
      clear();
      scan = lattice;
      patchMass(root);
      topTexture = dataTexture(lattice.hf, lattice.hw, lattice.hh);
      hTexture = dataTexture(new Float32Array(lattice.nU * lattice.nV), lattice.nU, lattice.nV);
      carveUniforms.uCarveFrame.value.set(lattice.u0, lattice.v0, lattice.cu, lattice.cv);
      carveUniforms.uCarveSize.value.set(lattice.nU, lattice.nV);
      carveUniforms.uCarveInv.value.set(...lattice.inv);
      carveUniforms.uCarveH.value = hTexture;
      carveUniforms.uTopTex.value = topTexture;
      group = new THREE.Group();
      parent.add(group);
      if (lattice.profile === "round") {
        sphereTexture = new THREE.DataTexture(new Float32Array(MAX_SPHERES * 4), MAX_SPHERES, 1, THREE.RGBAFormat, THREE.FloatType);
        sphereTexture.minFilter = sphereTexture.magFilter = THREE.NearestFilter;
        sphereTexture.needsUpdate = true;
        carveUniforms.uSphereTex.value = sphereTexture;
        hollows = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 28, 18), hollowMaterial, MAX_SPHERES);
        hollows.count = 0;
        hollows.frustumCulled = false;
        group.add(hollows);
      }
    },
    // Show the carved shape of an erosion (see erosion.js): round hollows, or carved heights per cell.
    update(er) {
      if (!group) return;
      if (hollows) {
        const data = sphereTexture.image.data;
        data.fill(0);
        er.spheres.forEach((s, i) => {
          data.set([s.x, s.z, s.r, 0], i * 4);
          dummy.position.set(s.x, 0, s.z);
          dummy.scale.set(s.r, s.r * SPHERE_SQUASH, s.r);
          dummy.updateMatrix();
          hollows.setMatrixAt(i, dummy.matrix);
        });
        hollows.count = er.spheres.length;
        hollows.instanceMatrix.needsUpdate = true;
        sphereTexture.needsUpdate = true;
        carveUniforms.uSphereCount.value = er.spheres.length;
        return;
      }
      const H = er.H;
      hTexture.image.data.set(H);
      hTexture.needsUpdate = true;
      group.traverse((o) => o.geometry?.dispose());
      group.clear();
      const geo = wallGeometry(scan, H);
      if (!geo.attributes.position.count) return;
      group.add(new THREE.Mesh(geo, wallMaterial), new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), wallEdgeMaterial));
    },
  };
}
