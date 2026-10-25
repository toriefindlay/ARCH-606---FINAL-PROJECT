import * as THREE from "three";
import { scene, renderer } from "../view/scene.js";
import { groundPoint } from "../view/pick.js";
import { state, layers } from "../core/state.js";
import { on, emit } from "../core/events.js";
import { $ } from "../core/dom.js";
import { registerPersist } from "../core/persist.js";

// Drawing new roads and pedestrian paths as polylines on the ground.
// Drawn lines are kept in world coordinates (x, z in metres, y = 0).

const DRAW_STYLE = {
  road: { width: 8, color: 0x1d1d1b, fill: 0x8f8d86, label: "Road" },
  path: { width: 2.5, color: 0xd4542b, fill: 0xe9a58e, label: "Path" },
};
let userLines = []; // { kind, pts: Vector3[] }
export const getUserLines = () => userLines;
let drawKind = null;
let draftPts = [];
let cursor = null;
let draftObj = null;

function startDrawing(kind) {
  finishLine(); // commit anything in progress before switching tools
  drawKind = kind;
  document.body.classList.add("drawing");
  document.querySelectorAll("[data-draw]").forEach((b) => b.classList.toggle("on", b.dataset.draw === kind));
}

function stopDrawing() {
  drawKind = null;
  draftPts = [];
  cursor = null;
  updateDraft();
  document.body.classList.remove("drawing");
  document.querySelectorAll("[data-draw]").forEach((b) => b.classList.remove("on"));
}

function finishLine() {
  if (drawKind && draftPts.length >= 2) {
    userLines.push({ kind: drawKind, pts: draftPts });
    renderDrawn();
  }
  draftPts = [];
  updateDraft();
}

function updateDraft() {
  if (draftObj) {
    draftObj.geometry.dispose();
    draftObj.material.dispose();
    scene.remove(draftObj);
    draftObj = null;
  }
  if (!drawKind || !draftPts.length) return;
  const pts = (cursor ? [...draftPts, cursor] : draftPts).map((p) => new THREE.Vector3(p.x, 0.8, p.z));
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  draftObj = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: DRAW_STYLE[drawKind].color, dashSize: 3, gapSize: 2 }));
  draftObj.computeLineDistances();
  scene.add(draftObj);
}

// A flat ribbon of the road/path width along the polyline.
function ribbonGeometry(pts, width) {
  const pos = [];
  const h = width / 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * h, nz = (dx / len) * h;
    pos.push(
      a.x + nx, 0, a.z + nz, a.x - nx, 0, a.z - nz, b.x + nx, 0, b.z + nz,
      a.x - nx, 0, a.z - nz, b.x - nx, 0, b.z - nz, b.x + nx, 0, b.z + nz
    );
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return geo;
}

function renderDrawn() {
  const g = layers.drawn;
  if (!g) return;
  for (const c of [...g.children]) {
    c.geometry?.dispose();
    c.material?.dispose();
    g.remove(c);
  }
  for (const { kind, pts } of userLines) {
    const s = DRAW_STYLE[kind];
    const ribbon = new THREE.Mesh(
      ribbonGeometry(pts, s.width),
      new THREE.MeshBasicMaterial({ color: s.fill, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 })
    );
    ribbon.position.y = 0.3;
    const centre = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p.x, 0.5, p.z))),
      new THREE.LineBasicMaterial({ color: s.color })
    );
    g.add(ribbon, centre);
  }
  renderDrawnList();
  emit("drawn:changed");
}

const lineLength = (pts) => pts.slice(1).reduce((s, p, i) => s + p.distanceTo(pts[i]), 0);

function renderDrawnList() {
  const ul = $("drawn-list");
  ul.innerHTML = "";
  const counts = { road: 0, path: 0 };
  userLines.forEach((l, i) => {
    const li = document.createElement("li");
    li.className = l.kind;
    li.innerHTML = `<span><i></i>${DRAW_STYLE[l.kind].label} ${++counts[l.kind]} · ${Math.round(lineLength(l.pts))} m</span>`;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "✕";
    del.title = "Delete";
    del.addEventListener("click", () => {
      userLines.splice(i, 1);
      renderDrawn();
    });
    li.append(del);
    ul.append(li);
  });
}

document.querySelectorAll("[data-draw]").forEach((b) =>
  b.addEventListener("click", () => (drawKind === b.dataset.draw ? (finishLine(), stopDrawing()) : startDrawing(b.dataset.draw)))
);

// Distinguish a click from an orbit drag.
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => (downAt = { x: e.clientX, y: e.clientY }));
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!drawKind || e.button !== 0 || !downAt) return;
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  const p = groundPoint(e);
  if (!p) return;
  const last = draftPts[draftPts.length - 1];
  if (last && last.distanceTo(p) < 0.5) return; // second click of a double-click
  draftPts.push(p);
  updateDraft();
});
renderer.domElement.addEventListener("pointermove", (e) => {
  if (!drawKind || !draftPts.length) return;
  cursor = groundPoint(e);
  updateDraft();
});
renderer.domElement.addEventListener("dblclick", () => drawKind && finishLine());

addEventListener("keydown", (e) => {
  if (!drawKind || e.target.matches("input, textarea")) return;
  if (e.key === "Enter") finishLine();
  else if (e.key === "Backspace") {
    e.preventDefault();
    draftPts.pop();
    updateDraft();
  } else if (e.key === "Escape") {
    if (draftPts.length) {
      draftPts = [];
      updateDraft();
    } else stopDrawing();
  }
});

on("site:built", () => {
  layers.drawn = new THREE.Group();
  state.siteGroup.add(layers.drawn);
  userLines = [];
  renderDrawn();
});

on("site:cleared", stopDrawing);

registerPersist("userLines", {
  capture: () => userLines.map((l) => ({ kind: l.kind, pts: l.pts.map((p) => [p.x, p.z]) })),
  restore: (saved) => {
    userLines = saved.map((l) => ({ kind: l.kind, pts: l.pts.map(([x, z]) => new THREE.Vector3(x, 0, z)) }));
    renderDrawn();
  },
});
