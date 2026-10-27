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
const ROOF_CLEARANCE = 0.25; // metres of mass always left above a slice: a slice never cuts through the roof
const MIN_SLICE = 0.3; // metres: a slice that would be lower than this at some spot is not cut there

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

// The wind erosion's map holds, for each cell of the mass's footprint, how tall the mass is left after the wind has rounded it
// (in metres, or -1 where the wind has not touched it) and how tall it was placed. The mass's own surface is discarded above
// the rounded height of the column it belongs to (the taller of the two either side of a wall).
const windUniforms = {
  uWindHeight: { value: null }, // set below, once EMPTY_WIND exists
  uWindBox: { value: new THREE.Vector4(0, 0, 1, 1) }, // the map's corner (x, z) and size
  uWindCell: { value: 1 }, // metres: one cell of the map
};
const EMPTY_WIND = new THREE.DataTexture(new Float32Array([-1, 0]), 1, 1, THREE.RGFormat, THREE.FloatType);
EMPTY_WIND.needsUpdate = true;
windUniforms.uWindHeight.value = EMPTY_WIND;

const CARVE_GLSL = /* glsl */ `
uniform sampler2D uCarveHeight;
uniform vec4 uCarveBox;
uniform sampler2D uWindHeight;
uniform vec4 uWindBox;
uniform float uWindCell;
varying vec3 vCarvePos;
bool carved(vec3 p) {
  vec2 uv = (p.xz - uCarveBox.xy) / uCarveBox.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return false;
  float h = texture2D(uCarveHeight, uv).r * ${(255 / HEIGHT_UNIT).toFixed(1)};
  return h > 0.0 && p.y < h;
}
// (rounded height or -1, original height) of the column at an (x, z); an empty column off the map.
vec2 windColumn(vec2 xz) {
  vec2 uv = (xz - uWindBox.xy) / uWindBox.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec2(-1.0, 0.0);
  return texture2D(uWindHeight, uv).rg;
}
// The columns whose surface the form view replaces are marked (>= 0). A piece of the mass's own surface goes if it lies in one,
// or touches one: a wall can lie up to half a cell from the edge of the cell it stands on, so a full cell either side of it is
// looked at (all round, for lines, which have no normal). The view builds its replacement one column further out than this,
// so nothing is left over and nothing is left open.
bool windRounded(vec3 p, vec3 n) {
  bool cut = windColumn(p.xz).x >= 0.0;
  if (dot(n, n) > 0.0) {
    cut = cut || windColumn((p - n * uWindCell).xz).x >= 0.0 || windColumn((p + n * uWindCell).xz).x >= 0.0;
  } else {
    cut = cut || windColumn(p.xz + vec2(uWindCell, 0.0)).x >= 0.0 || windColumn(p.xz - vec2(uWindCell, 0.0)).x >= 0.0
              || windColumn(p.xz + vec2(0.0, uWindCell)).x >= 0.0 || windColumn(p.xz - vec2(0.0, uWindCell)).x >= 0.0;
  }
  return cut;
}
vec3 facing() {
  vec3 c = cross(dFdx(vCarvePos), dFdy(vCarvePos));
  float l = length(c);
  return l > 1e-9 ? c / l : vec3(0.0);
}
`;

// `wind`: "mesh" (a surface: tested just inside), "line" (the mass's edge lines: tested where they are) or none (the walls we
// build ourselves, which the wind never discards).
const patched = new WeakSet();
function patch(material, key, wind = null) {
  if (patched.has(material)) return;
  patched.add(material);
  const test = wind ? "if (windRounded(vCarvePos, wn)) discard;" : "";
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, carveUniforms, windUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCarvePos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvCarvePos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${CARVE_GLSL}`)
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>\nvec3 wn = ${wind === "mesh" ? "facing()" : "vec3(0.0)"};\nif (carved(vCarvePos)) discard;\n${test}`
      );
  };
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
}

// The mass's own materials (shared white-model material and its edge lines) start discarding what lies in a slice.
function patchMass(root) {
  root.traverse((o) => {
    const materials = [o.material].flat().filter(Boolean);
    if (o.isMesh) materials.forEach((m) => patch(m, "carve-mass", "mesh"));
    else if (o.isLineSegments) materials.forEach((m) => patch(m, "carve-mass-edge", "line"));
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

  // Walls and ceilings of the slices. Each texel with a strand gets a ceiling at its strand's height and a wall on every side
  // where its neighbour is lower, from the neighbour's height up to its own.
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
        const h = height[k] / HEIGHT_UNIT;
        const tint = wearColour(colour, wear[k] / 255), xa = x0 + i * t, xb = xa + t, za = z0 + j * t, zb = za + t;
        quad([xa, h, za], [xb, h, za], [xb, h, zb], [xa, h, zb], [0, -1, 0], tint);
        const sides = [
          [i + 1 < nx, k + 1, [xb, za], [xb, zb], [-1, 0]],
          [i > 0, k - 1, [xa, za], [xa, zb], [1, 0]],
          [j + 1 < nz, k + nx, [xa, zb], [xb, zb], [0, -1]],
          [j > 0, k - nx, [xa, za], [xb, za], [0, 1]],
        ];
        for (const [exists, nk, [ax, az], [bx, bz], [nxn, nzn]] of sides) {
          if (!exists) continue;
          if (height[nk] >= height[k]) continue; // the neighbour is as tall: its own wall (if any) covers this edge
          const low = height[nk] / HEIGHT_UNIT;
          quad([ax, low, az], [bx, low, bz], [bx, h, bz], [ax, h, az], [nxn, 0, nzn], tint);
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
      // A slice never cuts through the roof: it stops short of the roof wherever the roof is low, and where there is no
      // room for even a short slice (the thin rim of a rounded mass, or beyond the mass) it is not cut at all.
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * nx + i;
          if (!height[k]) continue;
          const room = topAt(x0 + (i + 0.5) * t, z0 + (j + 0.5) * t) - ROOF_CLEARANCE;
          height[k] = room < MIN_SLICE ? 0 : Math.min(height[k], Math.floor(room * HEIGHT_UNIT));
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

/* ---------- the form: grown by the sun, rounded by the wind ---------- */

// The form (form.js) is a height map of the mass as it is now. Where it differs from the mass as placed, the mass's own surface
// is discarded (a ring of columns beyond the changed ones too) and replaced by one continuous smooth surface built here: a
// vertex at every column, joined into triangles, shaded smoothly, with the steps between columns evened out wherever the
// height changes gradually (a real wall is left sharp). What grew starts pale yellow and turns orange the warmer it got; what
// was rounded off starts the colour of the white model and turns blue the more the wind wore it.
const WARM_FROM = new THREE.Color(0xffe9a8), WARM_TO = new THREE.Color(0xe8672a);
const WORN_FROM = new THREE.Color(0xffd9c9), WORN_TO = new THREE.Color(0x6f9fd8);
const SAME = 0.02; // metres
const SKIN_FLOOR = 0.05; // metres: triangles lower than this are not built (the site's ground is there)
const EVEN_OUT = 2; // passes of evening out; steps up to twice a cell's width in height are treated as a slope, not a wall

// A copy of `mask` with every set cell's 8 neighbours set too.
function grow(mask, nx, nz) {
  const out = Uint8Array.from(mask);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      if (!mask[j * nx + i]) continue;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const a = i + di, b = j + dj;
          if (a >= 0 && b >= 0 && a < nx && b < nz) out[b * nx + a] = 1;
        }
      }
    }
  }
  return out;
}

export function createFormView() {
  const skinMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  patch(skinMaterial, "carve-skin"); // traffic's slices still cut through it
  let group = null, texture = null, data = null;
  const colour = new THREE.Color();

  const clear = () => {
    windUniforms.uWindHeight.value = EMPTY_WIND;
    group?.traverse((o) => o.geometry?.dispose());
    group?.parent?.remove(group);
    texture?.dispose();
    group = texture = data = null;
  };

  // The surface over the columns in `region`, which includes the changed ones (`changed`) and a margin round them.
  function skinGeometry(form, region, changed) {
    const { nx, nz, cx, cz, x0, z0, heights, h0, heat, wear } = form;
    // Even out the changed columns: each takes the mean of its neighbours that are close to its own height.
    let h = Float32Array.from(heights);
    const band = EVEN_OUT * Math.max(cx, cz);
    for (let pass = 0; pass < EVEN_OUT; pass++) {
      const next = Float32Array.from(h);
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          if (!changed[k]) continue;
          let sum = 2 * h[k], weight = 2;
          for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
              const a = i + di, b = j + dj;
              if ((!di && !dj) || a < 0 || b < 0 || a >= nx || b >= nz) continue;
              const n = h[b * nx + a];
              if (Math.abs(n - h[k]) < band) { sum += n; weight++; }
            }
          }
          next[k] = sum / weight;
        }
      }
      h = next;
    }

    const index = new Int32Array(nx * nz).fill(-1);
    const pos = [], col = [];
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (!region[k]) continue;
        index[k] = pos.length / 3;
        pos.push(x0 + (i + 0.5) * cx, h[k], z0 + (j + 0.5) * cz);
        const tint = !changed[k]
          ? colour.copy(WORN_FROM)
          : heights[k] > h0[k]
            ? colour.copy(WARM_FROM).lerp(WARM_TO, Math.pow(Math.min(1, heat[k]), 0.8))
            : colour.copy(WORN_FROM).lerp(WORN_TO, Math.pow(Math.min(1, wear[k]), 0.7));
        col.push(tint.r, tint.g, tint.b);
      }
    }
    const tri = [];
    const add = (a, b, c) => {
      if (Math.max(pos[a * 3 + 1], pos[b * 3 + 1], pos[c * 3 + 1]) > SKIN_FLOOR) tri.push(a, b, c);
    };
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = index[j * nx + i], b = index[j * nx + i + 1], c = index[(j + 1) * nx + i], d = index[(j + 1) * nx + i + 1];
        if (a < 0 || b < 0 || c < 0 || d < 0) continue;
        add(a, c, b);
        add(b, c, d);
      }
    }
    // Close the surface into a solid: wherever the built region ends (an edge with a quad on one side only) a wall drops from
    // the edge down to the ground, so there is never a way to look in underneath.
    const built = (i, j) => i >= 0 && j >= 0 && i < nx - 1 && j < nz - 1 && index[j * nx + i] >= 0 && index[j * nx + i + 1] >= 0 && index[(j + 1) * nx + i] >= 0 && index[(j + 1) * nx + i + 1] >= 0;
    const wall = (a, b) => {
      const ya = pos[a * 3 + 1], yb = pos[b * 3 + 1];
      if (Math.max(ya, yb) <= SKIN_FLOOR) return;
      const at = pos.length / 3;
      for (const [v, y] of [[a, ya], [b, yb], [b, 0], [a, 0]]) {
        pos.push(pos[v * 3], y, pos[v * 3 + 2]);
        col.push(col[v * 3], col[v * 3 + 1], col[v * 3 + 2]);
      }
      tri.push(at, at + 1, at + 2, at, at + 2, at + 3);
    };
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        if (i < nx - 1 && index[j * nx + i] >= 0 && index[j * nx + i + 1] >= 0 && built(i, j - 1) !== built(i, j)) wall(index[j * nx + i], index[j * nx + i + 1]);
        if (j < nz - 1 && index[j * nx + i] >= 0 && index[(j + 1) * nx + i] >= 0 && built(i - 1, j) !== built(i, j)) wall(index[j * nx + i], index[(j + 1) * nx + i]);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(tri);
    geo.computeVertexNormals();
    return geo;
  }

  return {
    clear,
    // Start showing the form `form` of the mass `root`, adding the surface it shapes to `parent`.
    setForm(form, parent, root) {
      clear();
      patchMass(root);
      data = new Float32Array(form.nx * form.nz * 2);
      for (let k = 0; k < form.h0.length; k++) {
        data[k * 2] = -1; // nothing cut away yet (0 would mean "everything above the ground")
        data[k * 2 + 1] = form.h0[k];
      }
      texture = new THREE.DataTexture(data, form.nx, form.nz, THREE.RGFormat, THREE.FloatType);
      texture.minFilter = texture.magFilter = THREE.NearestFilter;
      texture.needsUpdate = true;
      windUniforms.uWindHeight.value = texture;
      windUniforms.uWindBox.value.set(form.x0, form.z0, form.nx * form.cx, form.nz * form.cz);
      windUniforms.uWindCell.value = Math.max(form.cx, form.cz);
      group = new THREE.Group();
      parent.add(group);
    },
    // Show the form as it is now.
    update(form) {
      if (!group) return;
      const { nx, nz, h0, heights } = form;
      const changed = new Uint8Array(h0.length);
      let any = false;
      for (let k = 0; k < h0.length; k++) {
        if (Math.abs(heights[k] - h0[k]) > SAME) { changed[k] = 1; any = true; }
      }
      const cut = grow(changed, nx, nz); // the mass's own surface goes here: the new surface replaces it
      const region = grow(cut, nx, nz); // and the new surface reaches one column further, to meet what is left
      for (let k = 0; k < h0.length; k++) {
        data[k * 2] = cut[k] ? 0 : -1; // 0: everything of the mass's own surface here is discarded
        data[k * 2 + 1] = h0[k];
      }
      texture.needsUpdate = true;
      group.traverse((o) => o.geometry?.dispose());
      group.clear();
      if (!any) return;
      const geo = skinGeometry(form, region, changed);
      if (geo.index.count) group.add(new THREE.Mesh(geo, skinMaterial));
    },
  };
}
