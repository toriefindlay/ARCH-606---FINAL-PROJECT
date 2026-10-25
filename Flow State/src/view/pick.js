import * as THREE from "three";
import { renderer, camera } from "./scene.js";

export const raycaster = new THREE.Raycaster();
export const ndc = new THREE.Vector2();
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

// Point the pointer event aims at, as a ray from the camera in normalised device coordinates.
export function aimRay(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster;
}

// Where the pointer hits the ground plane (y = 0), or null if it points at the sky.
export function groundPoint(e) {
  const p = new THREE.Vector3();
  return aimRay(e).ray.intersectPlane(ground, p) ? p : null;
}
