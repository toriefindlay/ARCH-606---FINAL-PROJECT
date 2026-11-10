// VIEW (exterior erosion): draws the mass as the sun and the wind have shaped it.
// Create a group under layers.* on "site:built" and redraw it on "cuts:changed".
import * as THREE from "three";

export function renderPreview(cuts) {
  // TODO
}

/* ---------- the placed mass, with the wind-rounded part hidden ---------- */

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

// The wind tunnels (tunnels.js): a 3D map with one byte per voxel, 255 where the voxel is a tunnel. The mass's own surface is
// discarded wherever it lies in one; the tunnel's walls are built by createTunnelView.
const EMPTY_TUNNEL = new THREE.Data3DTexture(new Uint8Array([0]), 1, 1, 1);
EMPTY_TUNNEL.format = THREE.RedFormat;
EMPTY_TUNNEL.type = THREE.UnsignedByteType;
EMPTY_TUNNEL.unpackAlignment = 1;
EMPTY_TUNNEL.needsUpdate = true;
const tunnelUniforms = {
  uTunnelTex: { value: EMPTY_TUNNEL },
  uTunnelOrigin: { value: new THREE.Vector3() }, // the box's corner (x, z) in world metres (y = 0 is the ground)
  uTunnelBox: { value: new THREE.Vector4(1, 1, 1, 1) }, // the box's size in x, y, z and the size of one voxel
};

const WIND_GLSL = /* glsl */ `
uniform sampler2D uWindHeight;
uniform vec4 uWindBox;
uniform float uWindCell;
uniform highp sampler3D uTunnelTex;
uniform vec3 uTunnelOrigin;
uniform vec4 uTunnelBox;
varying vec3 vWindPos;
bool tunnelAt(vec3 p) {
  vec3 uvw = vec3((p.x - uTunnelOrigin.x) / uTunnelBox.x, (p.z - uTunnelOrigin.z) / uTunnelBox.z, p.y / uTunnelBox.y);
  if (uvw.x < 0.0 || uvw.y < 0.0 || uvw.z < 0.0 || uvw.x > 1.0 || uvw.y > 1.0 || uvw.z > 1.0) return false;
  return texture(uTunnelTex, uvw).r > 0.5;
}
// A piece of the mass's surface goes if it lies in a tunnel voxel, or just inside one (a surface sits on the edge of the voxel
// that it opens into; lines have no normal and are only tested where they are).
bool tunnelCut(vec3 p, vec3 n) {
  if (tunnelAt(p)) return true;
  return dot(n, n) > 0.0 && tunnelAt(p - n * 0.5 * uTunnelBox.w);
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
  vec3 c = cross(dFdx(vWindPos), dFdy(vWindPos));
  float l = length(c);
  return l > 1e-9 ? c / l : vec3(0.0);
}
`;

// `kind`: "mesh" (a surface: tested just inside) or "line" (the mass's edge lines: tested where they are).
const patched = new WeakSet();
function patch(material, key, kind) {
  if (patched.has(material)) return;
  patched.add(material);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, windUniforms, tunnelUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWindPos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWindPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${WIND_GLSL}`)
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>\nvec3 wn = ${kind === "mesh" ? "facing()" : "vec3(0.0)"};\nif (windRounded(vWindPos, wn) || tunnelCut(vWindPos, wn)) discard;`
      );
  };
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
}

// The mass's own materials (shared white-model material and its edge lines) start discarding what the form replaces.
function patchMass(root) {
  root.traverse((o) => {
    const materials = [o.material].flat().filter(Boolean);
    if (o.isMesh) materials.forEach((m) => patch(m, "wind-mass", "mesh"));
    else if (o.isLineSegments) materials.forEach((m) => patch(m, "wind-mass-edge", "line"));
  });
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

/* ---------- the wind tunnels ---------- */

// The mass's own surface is discarded inside the tunnels (see tunnelCut above) and the walls, floor and ceiling of every tunnel
// are built here: a square face wherever a tunnel voxel meets a voxel of the mass that is left. They are coloured by the air
// speed beside them, as the airflow slice is: blue where the air is slower than the open wind, grey where it is as fast, red
// where it is faster.
const TUNNEL_SLOW = new THREE.Color(0x2a5cc0), TUNNEL_SAME = new THREE.Color(0xe6e6e6), TUNNEL_FAST = new THREE.Color(0xd9331f);
const TUNNEL_RANGE = 2; // the speed ratio at which the ramp ends

export function createTunnelView() {
  const wallMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  let group = null, texture = null, data = null, shownVersion = -1, shownFlow = null, shownTunnels = null;
  const colour = new THREE.Color();

  const clear = () => {
    tunnelUniforms.uTunnelTex.value = EMPTY_TUNNEL;
    group?.traverse((o) => o.geometry?.dispose());
    group?.parent?.remove(group);
    texture?.dispose();
    group = texture = data = shownTunnels = shownFlow = null;
    shownVersion = -1;
  };

  const speedColour = (ratio) => {
    const t = Math.max(0, Math.min(1, ratio / TUNNEL_RANGE));
    return t < 0.5 ? colour.copy(TUNNEL_SLOW).lerp(TUNNEL_SAME, t * 2) : colour.copy(TUNNEL_SAME).lerp(TUNNEL_FAST, (t - 0.5) * 2);
  };

  return {
    clear,
    // Shows the tunnels of `tunnels` (tunnels.js) under `parent`. Cheap to call every frame: it only rebuilds when they change.
    update(parent, tunnels) {
      if (!parent) return clear();
      const { vox, flow } = tunnels;
      if (shownTunnels === tunnels && shownVersion === vox.version && shownFlow === flow && group.parent === parent) return;
      const { nx, nz, ny, c, x0, z0, cells } = vox;
      const nxz = nx * nz;
      if (shownTunnels !== tunnels || group.parent !== parent) {
        clear();
        data = new Uint8Array(cells.length);
        texture = new THREE.Data3DTexture(data, nx, nz, ny);
        texture.format = THREE.RedFormat;
        texture.type = THREE.UnsignedByteType;
        texture.minFilter = texture.magFilter = THREE.NearestFilter;
        texture.unpackAlignment = 1;
        group = new THREE.Group();
        parent.add(group);
        shownTunnels = tunnels;
        tunnelUniforms.uTunnelOrigin.value.set(x0, 0, z0);
        tunnelUniforms.uTunnelBox.value.set(nx * c, ny * c, nz * c, c);
      }
      const pos = [], nrm = [], col = [];
      const faces = [ // [neighbour offset, normal pointing into the tunnel, the face's four corners relative to the voxel's corner]
        [1, [-1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
        [-1, [1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
        [nx, [0, 0, -1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
        [-nx, [0, 0, 1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]],
        [nxz, [0, -1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]],
        [-nxz, [0, 1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
      ];
      for (let k = 0; k < cells.length; k++) {
        const tunnel = tunnels.carvedAt(k);
        data[k] = tunnel ? 255 : 0;
        if (!tunnel) continue;
        const l = Math.floor(k / nxz), j = Math.floor((k - l * nxz) / nx), i = k - l * nxz - j * nx;
        const tint = speedColour(flow?.open[k] ? flow.speed[k] : 1);
        for (const [offset, normal, corners] of faces) {
          const q = k + offset;
          if (q < 0 || q >= cells.length || cells[q] !== 1) continue; // only where the mass is left (voxelFlow.js MASS)
          const v = corners.map(([a, b, d]) => [x0 + (i + a) * c, (l + b) * c, z0 + (j + d) * c]);
          for (const p of [v[0], v[1], v[2], v[0], v[2], v[3]]) {
            pos.push(p[0], p[1], p[2]);
            nrm.push(normal[0], normal[1], normal[2]);
            col.push(tint.r, tint.g, tint.b);
          }
        }
      }
      texture.needsUpdate = true;
      tunnelUniforms.uTunnelTex.value = texture;
      group.traverse((o) => o.geometry?.dispose());
      group.clear();
      if (pos.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
        geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
        group.add(new THREE.Mesh(geo, wallMaterial));
      }
      shownVersion = vox.version;
      shownFlow = flow;
    },
  };
}
