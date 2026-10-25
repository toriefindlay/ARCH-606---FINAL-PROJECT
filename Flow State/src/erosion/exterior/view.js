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
// shown in two parts. (1) The strands are drawn into a fine map over the mass's footprint that holds how tall each strand is
// there, and the mass's material discards every fragment that lies on a strand below that height. (2) The faces of every
// slice are built as walls and ceilings along that map, tinted purple: lighter where a channel has been passed few times,
// darker with every pass.

const MIN_TEXEL = 0.06; // metres: the finest the map gets
const MAX_TEXELS = 1200; // per side
const HEIGHT_UNIT = 10; // the map stores height in tenths of a metre (one byte, so up to 25.5 m)
const WALL_TOP_LIFT = 0.05; // metres a wall stands above the mass's top, so no gap shows at the roof

const heightTextureOf = (data, w, h) => {
  const t = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
  t.unpackAlignment = 1; // rows are one byte per texel, not padded to four
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
};
const EMPTY = heightTextureOf(new Uint8Array(1), 1, 1);

const carveUniforms = {
  uCarveHeight: { value: EMPTY }, // height of the strand on each texel, in tenths of a metre (0 = none)
  uCarveBox: { value: new THREE.Vector4(0, 0, 1, 1) }, // the map's corner (x, z) and size
};

const CARVE_GLSL = /* glsl */ `
uniform sampler2D uCarveHeight;
uniform vec4 uCarveBox;
varying vec3 vCarvePos;
bool carved(vec3 p) {
  vec2 uv = (p.xz - uCarveBox.xy) / uCarveBox.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return false;
  float h = texture2D(uCarveHeight, uv).r * ${(255 / HEIGHT_UNIT).toFixed(1)};
  return h > 0.0 && p.y < h;
}
`;

const patched = new WeakSet();
function patch(material, key) {
  if (patched.has(material)) return;
  patched.add(material);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, carveUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCarvePos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvCarvePos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${CARVE_GLSL}`)
      .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nif (carved(vCarvePos)) discard;");
  };
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
}

// The mass's own materials (shared white-model material and its edge lines) start discarding what lies in a slice.
function patchMass(root) {
  root.traverse((o) => {
    const materials = [o.material].flat().filter(Boolean);
    if (o.isMesh) materials.forEach((m) => patch(m, "carve-mass"));
    else if (o.isLineSegments) materials.forEach((m) => patch(m, "carve-mass-edge"));
  });
}

const wallMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });

// Light lilac where little has passed, deep purple where most has: wear 0..1.
const LIGHT_PURPLE = 0.8, DARK_PURPLE = 0.12; // lightness
const wearColour = (color, wear) => color.setHSL(0.76, 0.5, LIGHT_PURPLE + (DARK_PURPLE - LIGHT_PURPLE) * wear);

export function createCarveView() {
  let group = null, heightTexture = null, scan = null, grid = null;
  const colour = new THREE.Color();

  const clear = () => {
    carveUniforms.uCarveHeight.value = EMPTY;
    group?.traverse((o) => o.geometry?.dispose());
    group?.parent?.remove(group);
    heightTexture?.dispose();
    group = heightTexture = scan = grid = null;
  };

  // The mass's top height at (x, z): bilinear between the height-map samples, or the nearest one near the mass's edge.
  const topAt = (x, z) => {
    const step = scan.cu / scan.sub, stepV = scan.cv / scan.sub;
    const gx = (x - scan.u0) / step - 0.5, gz = (z - scan.v0) / stepV - 0.5;
    const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
    const at = (a, b) => scan.hf[Math.min(scan.hh - 1, Math.max(0, b)) * scan.hw + Math.min(scan.hw - 1, Math.max(0, a))];
    const h00 = at(i, j), h10 = at(i + 1, j), h01 = at(i, j + 1), h11 = at(i + 1, j + 1);
    if (h00 <= 0.5 || h10 <= 0.5 || h01 <= 0.5 || h11 <= 0.5) return at(Math.round(gx), Math.round(gz));
    return h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;
  };

  // Walls and ceilings of the slices. Each texel with a strand gets a ceiling at its strand's height (unless that is above the
  // mass's roof, where the slice is open to the sky) and a wall on every side where its neighbour is lower, from the neighbour's
  // height up to its own, never above the roof.
  function wallGeometry() {
    const { height, wear, nx, nz, t, x0, z0, bbox } = grid;
    const pos = [], nrm = [], col = [];
    const quad = (a, b, c, d, normal, tint) => {
      for (const v of [a, b, c, a, c, d]) {
        pos.push(v[0], v[1], v[2]);
        nrm.push(normal[0], normal[1], normal[2]);
        col.push(tint.r, tint.g, tint.b);
      }
    };
    for (let j = Math.max(0, bbox.j0 - 1); j <= Math.min(nz - 1, bbox.j1 + 1); j++) {
      for (let i = Math.max(0, bbox.i0 - 1); i <= Math.min(nx - 1, bbox.i1 + 1); i++) {
        const k = j * nx + i;
        if (!height[k]) continue;
        const cx = x0 + (i + 0.5) * t, cz = z0 + (j + 0.5) * t, roof = topAt(cx, cz);
        if (roof <= 0.3) continue; // off the edge of the mass
        const h = height[k] / HEIGHT_UNIT, reach = Math.min(h, roof + WALL_TOP_LIFT);
        const tint = wearColour(colour, wear[k] / 255), xa = x0 + i * t, xb = xa + t, za = z0 + j * t, zb = za + t;
        if (h < roof - 0.05) quad([xa, h, za], [xb, h, za], [xb, h, zb], [xa, h, zb], [0, -1, 0], tint);
        const sides = [
          [i + 1 < nx, k + 1, [xb, za], [xb, zb], [-1, 0]],
          [i > 0, k - 1, [xa, za], [xa, zb], [1, 0]],
          [j + 1 < nz, k + nx, [xa, zb], [xb, zb], [0, -1]],
          [j > 0, k - nx, [xa, za], [xb, za], [0, 1]],
        ];
        for (const [exists, nk, [ax, az], [bx, bz], [nxn, nzn]] of sides) {
          if (!exists) continue;
          const low = Math.min(height[nk] / HEIGHT_UNIT, reach);
          if (height[nk] >= height[k] || reach <= low) continue; // the neighbour is as tall, or the wall would be above the roof
          quad([ax, low, az], [bx, low, bz], [bx, reach, bz], [ax, reach, az], [nxn, 0, nzn], tint);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    return geo;
  }

  return {
    clear,
    // Start showing strands in `root` (the placed mass), adding their walls to `parent`.
    setLattice(lattice, parent, root) {
      clear();
      scan = lattice;
      patchMass(root);
      const Lu = lattice.nU * lattice.cu, Lv = lattice.nV * lattice.cv;
      const t = Math.max(MIN_TEXEL, Math.max(Lu, Lv) / MAX_TEXELS);
      const nx = Math.ceil(Lu / t), nz = Math.ceil(Lv / t);
      grid = { t, nx, nz, x0: lattice.u0, z0: lattice.v0, height: new Uint8Array(nx * nz), wear: new Uint8Array(nx * nz), bbox: { i0: 0, i1: -1, j0: 0, j1: -1 } };
      heightTexture = heightTextureOf(grid.height, nx, nz);
      carveUniforms.uCarveBox.value.set(lattice.u0, lattice.v0, nx * t, nz * t);
      carveUniforms.uCarveHeight.value = heightTexture;
      group = new THREE.Group();
      parent.add(group);
    },
    // Show the strands of an erosion (see erosion.js).
    update(er) {
      if (!group) return;
      const { height, wear, nx, nz, t, x0, z0, bbox } = grid;
      height.fill(0);
      wear.fill(0);
      let i0 = nx, i1 = -1, j0 = nz, j1 = -1;
      for (const s of er.segments()) {
        // Texels within the strand's half-width, plus 0.75 texel so that even the thinnest strand stays unbroken.
        const r = s.w + 0.75 * t;
        const dx = s.bx - s.ax, dz = s.bz - s.az, len2 = dx * dx + dz * dz || 1;
        const level = Math.max(1, Math.min(255, Math.round(s.h * HEIGHT_UNIT))), shade = Math.round(s.wear * 255);
        const ia = Math.max(0, Math.floor((Math.min(s.ax, s.bx) - r - x0) / t)), ib = Math.min(nx - 1, Math.floor((Math.max(s.ax, s.bx) + r - x0) / t));
        const ja = Math.max(0, Math.floor((Math.min(s.az, s.bz) - r - z0) / t)), jb = Math.min(nz - 1, Math.floor((Math.max(s.az, s.bz) + r - z0) / t));
        for (let j = ja; j <= jb; j++) {
          const z = z0 + (j + 0.5) * t;
          for (let i = ia; i <= ib; i++) {
            const x = x0 + (i + 0.5) * t;
            const u = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / len2));
            if (Math.hypot(x - s.ax - dx * u, z - s.az - dz * u) > r) continue;
            const k = j * nx + i;
            if (height[k] < level) height[k] = level;
            if (wear[k] < shade) wear[k] = shade;
            if (i < i0) i0 = i;
            if (i > i1) i1 = i;
            if (j < j0) j0 = j;
            if (j > j1) j1 = j;
          }
        }
      }
      Object.assign(bbox, { i0, i1, j0, j1 });
      heightTexture.needsUpdate = true;
      group.traverse((o) => o.geometry?.dispose());
      group.clear();
      if (i1 < 0) return;
      const geo = wallGeometry();
      if (geo.attributes.position.count) group.add(new THREE.Mesh(geo, wallMaterial));
    },
  };
}
