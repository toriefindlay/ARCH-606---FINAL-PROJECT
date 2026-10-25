// VIEW (exterior erosion): draws a preview of the exterior cuts in the scene.
// Create a group under layers.* on "site:built" and redraw it on "cuts:changed".
import * as THREE from "three";
import { MAX_PEOPLE, MAX_CARS } from "./traffic.js";

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
  uCarveRot: { value: new THREE.Vector2(1, 0) }, // cos, sin of the lattice axis
};

const CARVE_GLSL = /* glsl */ `
uniform sampler2D uCarveH;
uniform sampler2D uTopTex;
uniform vec4 uCarveFrame;
uniform vec2 uCarveSize;
uniform vec2 uCarveRot;
varying vec3 vCarvePos;
vec2 carveUV(vec3 p) {
  return vec2(p.x * uCarveRot.x + p.z * uCarveRot.y - uCarveFrame.x, -p.x * uCarveRot.y + p.z * uCarveRot.x - uCarveFrame.y);
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
const DISCARD_CARVED = "if (carveInside(vCarvePos, 0.06)) discard;";
const DISCARD_OUTSIDE_MASS = "float carveT = carveTop(vCarvePos); if (carveT < 0.05 || vCarvePos.y > carveT + 0.03) discard;";

const patched = new WeakSet();
function patch(material, key, body) {
  if (patched.has(material)) return;
  patched.add(material);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, carveUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCarvePos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvCarvePos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
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
  const { nU, nV, cu, cv, u0, v0, cos, sin, ok } = scan;
  const pos = [];
  const P = (u, y, v) => {
    const U = u0 + u, V = v0 + v;
    return [U * cos - V * sin, y, U * sin + V * cos];
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

export function createCarveView() {
  let group = null, hTexture = null, topTexture = null, scan = null;

  const clear = () => {
    carveUniforms.uCarveSize.value.set(0, 0);
    carveUniforms.uCarveH.value = carveUniforms.uTopTex.value = EMPTY;
    group?.traverse((o) => o.geometry?.dispose());
    group?.parent?.remove(group);
    hTexture?.dispose();
    topTexture?.dispose();
    group = hTexture = topTexture = scan = null;
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
      carveUniforms.uCarveRot.value.set(lattice.cos, lattice.sin);
      carveUniforms.uCarveH.value = hTexture;
      carveUniforms.uTopTex.value = topTexture;
      group = new THREE.Group();
      parent.add(group);
    },
    // Show the carved heights H (metres per cell).
    update(H) {
      if (!group) return;
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
