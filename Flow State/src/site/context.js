import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { scene, SKY, sunLight, onFrame } from "../view/scene.js";
import { on } from "../core/events.js";

// Builders for the surrounding context: ground, roads, green space, neighbouring massings.
// Each returns a THREE.Group (or adds to the one given); the pipeline decides where it goes.

export const ROAD_STYLE = { color: 0x1d1d1b, y: 0.3 };
export const PATH_STYLE = { color: 0xd4542b, y: 0.3 };

const toShape = (outer, holes = []) => {
  const shape = new THREE.Shape(outer);
  for (const h of holes) shape.holes.push(new THREE.Path(h));
  return shape;
};

export function buildGround(group, radius) {
  const R = radius * 1.15;
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(R, 96).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0xf6f5f0 })
  );
  disc.receiveShadow = true;
  group.add(disc);

  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 129 }, (_, i) => new THREE.Vector3(Math.cos((i / 128) * Math.PI * 2) * radius, 0.2, Math.sin((i / 128) * Math.PI * 2) * radius))
    ),
    new THREE.LineBasicMaterial({ color: 0x9a978d })
  );
  group.add(ring);

  scene.fog = new THREE.Fog(SKY, radius * 2.2, radius * 5);
  sunLight.position.set(radius * 0.9, radius * 1.4, radius * 0.5);
  sunLight.shadow.camera.left = sunLight.shadow.camera.bottom = -R;
  sunLight.shadow.camera.right = sunLight.shadow.camera.top = R;
  sunLight.shadow.camera.far = radius * 4;
  sunLight.shadow.camera.updateProjectionMatrix();
}

export function buildLines(items, style) {
  const g = new THREE.Group();
  const verts = [];
  for (const { pts } of items) {
    for (let i = 0; i < pts.length - 1; i++) {
      verts.push(pts[i].x, style.y, -pts[i].y, pts[i + 1].x, style.y, -pts[i + 1].y);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: style.color })));
  return g;
}

export function buildGreen(items) {
  const g = new THREE.Group();
  const mats = {
    green: { fill: new THREE.MeshBasicMaterial({ color: 0xd3dfc0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 }), line: 0x7f9a5c },
    water: { fill: new THREE.MeshBasicMaterial({ color: 0xc4d8e4, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 }), line: 0x6f9bb5 },
  };
  const lineVerts = { green: [], water: [] };

  for (const item of items) {
    if (item.line) {
      for (let i = 0; i < item.line.length - 1; i++) {
        const a = item.line[i], b = item.line[i + 1];
        lineVerts.water.push(a.x, 0.25, -a.y, b.x, 0.25, -b.y);
      }
      continue;
    }
    try {
      const geo = new THREE.ShapeGeometry(toShape(item.outer, item.holes));
      geo.rotateX(-Math.PI / 2); // shape (x, north) -> world (x, up, -north)
      const mesh = new THREE.Mesh(geo, mats[item.kind].fill);
      mesh.position.y = 0.05;
      mesh.receiveShadow = true;
      g.add(mesh);
    } catch { /* skip degenerate polygon */ }

    for (const ring of [item.outer, ...item.holes]) {
      for (let i = 0; i < ring.length - 1; i++) {
        lineVerts[item.kind].push(ring[i].x, 0.2, -ring[i].y, ring[i + 1].x, 0.2, -ring[i + 1].y);
      }
    }
  }

  for (const kind of ["green", "water"]) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(lineVerts[kind], 3));
    g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: mats[kind].line })));
  }
  return g;
}

// All massings share one mesh and all their outlines one line set (two draw calls).
// Each vertex carries its building's start delay, and the vertex shader scales it
// up from the ground, so buildings still rise nearest-first.
const RISE_SECONDS = 0.7;
const riseUniform = { value: 0 };
let riseStart = 0;
let riseEnd = 0; // seconds after riseStart when the last building has finished

function withRise(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRise = riseUniform;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aDelay;\nuniform float uRise;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        float rp = clamp((uRise - aDelay) / ${RISE_SECONDS.toFixed(1)}, 0.0, 1.0);
        transformed.y *= max(1.0 - pow(1.0 - rp, 3.0), 0.001);`
      );
  };
  material.customProgramCacheKey = () => "rise";
  return material;
}

function setDelay(geo, delay) {
  const n = geo.attributes.position.count;
  geo.setAttribute("aDelay", new THREE.Float32BufferAttribute(new Float32Array(n).fill(delay), 1));
}

export function buildBuildings(items) {
  const g = new THREE.Group();
  const solids = [];
  const edges = [];
  let maxDelay = 0;

  for (const b of items) {
    let geo;
    try {
      geo = new THREE.ExtrudeGeometry(toShape(b.outer, b.holes), { depth: b.height, bevelEnabled: false });
    } catch { continue; }
    geo.rotateX(-Math.PI / 2); // extrusion axis -> up, shape y (north) -> -z
    geo.deleteAttribute("uv"); // not needed, and merging requires matching attributes
    geo.clearGroups();

    const delay = b.outer[0].length() * 0.006;
    maxDelay = Math.max(maxDelay, delay);
    const outline = new THREE.EdgesGeometry(geo, 30);
    setDelay(geo, delay);
    setDelay(outline, delay);
    solids.push(geo);
    edges.push(outline);
  }
  if (!solids.length) return g;

  const mesh = new THREE.Mesh(mergeGeometries(solids), withRise(new THREE.MeshLambertMaterial({ color: 0xffffff })));
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.customDepthMaterial = withRise(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }));
  const lines = new THREE.LineSegments(mergeGeometries(edges), withRise(new THREE.LineBasicMaterial({ color: 0x3a3a36 })));
  g.add(mesh, lines);
  solids.forEach((s) => s.dispose());
  edges.forEach((e) => e.dispose());

  riseUniform.value = 0;
  riseStart = performance.now() + 400;
  riseEnd = maxDelay + RISE_SECONDS;
  return g;
}

onFrame((dt, now) => {
  if (!riseEnd) return;
  const t = Math.max(0, (now - riseStart) / 1000);
  riseUniform.value = t;
  if (t > riseEnd) riseEnd = 0; // done: uniform stays past every delay
});

on("site:cleared", () => {
  riseEnd = 0;
  riseUniform.value = 0;
});

// The orange pin at the site coordinates.
export function buildMarker(radius) {
  const g = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: 0xd4542b });
  const s = Math.max(radius * 0.03, 6);
  const circle = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 49 }, (_, i) => new THREE.Vector3(Math.cos((i / 48) * Math.PI * 2) * s, 0.5, Math.sin((i / 48) * Math.PI * 2) * s))
    ),
    mat
  );
  const pole = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, s * 5, 0)]),
    mat
  );
  g.add(circle, pole);
  return g;
}
