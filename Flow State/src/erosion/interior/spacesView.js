// VIEW (interior erosion): the occupied spaces as translucent spheres in the scene, with a gizmo on the selected one to move it along x, y
// and z (the arrows) or scale it (the centre box). A sphere is hidden behind whatever is in front of it, the wind tunnels included. With the
// mass solid (x-ray off) a faint copy is also drawn through everything, so that the spheres can still be seen and placed inside it.
// Click a sphere to select it. See spaces.js for what a space is.
import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { scene, camera, renderer, controls, onFrame } from "../../view/scene.js";
import { settings as exteriorSettings } from "../exterior/panel.js";
import { on } from "../../core/events.js";
import { SPACE_KINDS, getSpaces, getSelectedId, getGizmoMode, selectSpace, updateSpace, MIN_RADIUS } from "./spaces.js";

const geometry = new THREE.SphereGeometry(1, 36, 24);
const materials = new Map(); // `${kind}|${selected}` -> [fill, wire, ghost]
function materialsFor(kind, selected) {
  const key = `${kind}|${selected}`;
  if (!materials.has(key)) {
    const colour = SPACE_KINDS[kind].colour;
    const common = { color: colour, transparent: true, depthWrite: false };
    materials.set(key, [
      new THREE.MeshBasicMaterial({ ...common, opacity: selected ? 0.5 : 0.3 }),
      new THREE.MeshBasicMaterial({ ...common, wireframe: true, opacity: selected ? 0.75 : 0.4 }),
      new THREE.MeshBasicMaterial({ ...common, depthTest: false, opacity: selected ? 0.2 : 0.1 }), // seen through everything
    ]);
  }
  return materials.get(key);
}

export function mountSpacesView() {
  const group = new THREE.Group();
  group.name = "interior-spaces";
  scene.add(group);
  const meshes = new Map(); // space id -> mesh

  const gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setSize(0.8);
  const helper = gizmo.getHelper ? gizmo.getHelper() : gizmo; // (newer three.js: a helper object; this one: the controls themselves)
  helper.renderOrder = 20;
  helper.traverse((o) => { if (o.material) { o.material.depthTest = false; o.material.depthWrite = false; } });
  scene.add(helper);
  gizmo.addEventListener("dragging-changed", (e) => { controls.enabled = !e.value; });
  gizmo.addEventListener("objectChange", () => {
    const mesh = gizmo.object;
    if (!mesh) return;
    const id = mesh.userData.id;
    if (getGizmoMode() === "scale") {
      const r = Math.max(MIN_RADIUS, mesh.scale.x, mesh.scale.y, mesh.scale.z);
      mesh.scale.setScalar(r);
      updateSpace(id, { r });
    } else {
      updateSpace(id, { x: mesh.position.x, y: Math.max(0, mesh.position.y), z: mesh.position.z });
    }
  });

  const applyMode = () => {
    const scaling = getGizmoMode() === "scale";
    gizmo.setMode(scaling ? "scale" : "translate");
    gizmo.showX = gizmo.showY = gizmo.showZ = !scaling; // the box in the middle of the scale gizmo scales evenly: a sphere stays a sphere
  };

  // Brings the meshes in line with the list of spaces.
  function sync() {
    const spaces = getSpaces(), selected = getSelectedId(), seen = new Set();
    for (const s of spaces) {
      seen.add(s.id);
      const [fill, wire, ghost] = materialsFor(s.kind, s.id === selected);
      let mesh = meshes.get(s.id);
      if (!mesh) {
        mesh = new THREE.Mesh(geometry, fill);
        mesh.add(new THREE.Mesh(geometry, wire), new THREE.Mesh(geometry, ghost));
        mesh.userData.id = s.id;
        mesh.renderOrder = 10;
        mesh.children[0].renderOrder = 10;
        mesh.children[1].renderOrder = 11;
        group.add(mesh);
        meshes.set(s.id, mesh);
      }
      if (mesh.userData.kind !== s.kind || mesh.userData.selected !== (s.id === selected)) {
        mesh.material = fill;
        mesh.children[0].material = wire;
        mesh.children[1].material = ghost;
        mesh.userData.kind = s.kind;
        mesh.userData.selected = s.id === selected;
      }
      if (!gizmo.dragging) { // while it is being dragged the gizmo owns the mesh
        mesh.position.set(s.x, s.y, s.z);
        mesh.scale.setScalar(s.r);
      }
    }
    for (const [id, mesh] of meshes) {
      if (seen.has(id)) continue;
      if (gizmo.object === mesh) gizmo.detach();
      group.remove(mesh);
      meshes.delete(id);
    }
    const target = selected !== null ? meshes.get(selected) : null;
    if (target && gizmo.object !== target) gizmo.attach(target);
    else if (!target && gizmo.object) gizmo.detach();
  }

  // Clicking a sphere (not dragging the view) selects it; the nearest one along the ray if there are several.
  const ray = new THREE.Raycaster(), pointer = new THREE.Vector2();
  let down = null;
  const canvas = renderer.domElement;
  canvas.addEventListener("pointerdown", (e) => { down = gizmo.axis ? null : [e.clientX, e.clientY]; });
  canvas.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || gizmo.axis) return;
    down = null;
    const rect = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(pointer, camera);
    const hit = ray.intersectObjects([...meshes.values()], false)[0];
    if (hit) selectSpace(hit.object.userData.id);
  });

  // The faint copy that shows through the solid mass is not wanted once the mass is x-rayed.
  onFrame(() => { const show = !exteriorSettings.xray; for (const m of meshes.values()) if (m.children[1].visible !== show) m.children[1].visible = show; });

  on("spaces:changed", sync);
  on("spaces:selected", sync);
  on("spaces:mode", () => { applyMode(); sync(); });
  applyMode();
  sync();
}
