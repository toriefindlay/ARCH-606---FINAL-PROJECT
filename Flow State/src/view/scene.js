import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { $ } from "../core/dom.js";
import { registerPersist } from "../core/persist.js";

export const renderer = new THREE.WebGLRenderer({ canvas: $("scene"), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

export const scene = new THREE.Scene();
export const SKY = new THREE.Color(0xeceae4);
scene.background = SKY;

export const camera = new THREE.PerspectiveCamera(45, 1, 1, 6000);
camera.position.set(400, 350, 400);

export const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI - 0.02; // past the horizon: the camera can go under the ground
controls.autoRotateSpeed = 0.6;

export const hemiLight = new THREE.HemisphereLight(0xffffff, 0xb9b4a6, 1.4);
export const sunLight = new THREE.DirectionalLight(0xfff4e0, 2.2);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
scene.add(hemiLight, sunLight, sunLight.target);

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

// Modules register per-frame work here: fn(dtSeconds, timeMs).
const frameHandlers = [];
export const onFrame = (fn) => frameHandlers.push(fn);

let lastT = 0;
renderer.setAnimationLoop((t) => {
  const dt = Math.min((t - lastT) / 1000, 0.1);
  lastT = t;
  controls.update();
  for (const fn of frameHandlers) fn(dt, t);
  renderer.render(scene, camera);
});

export function frameCamera(radius) {
  camera.far = radius * 12;
  camera.updateProjectionMatrix();
  camera.position.set(radius * 0.9, radius * 0.75, radius * 0.9);
  controls.target.set(0, 0, 0);
  controls.minDistance = 20;
  controls.maxDistance = radius * 4;
  controls.update();
}

registerPersist("camera", {
  capture: () => ({ pos: camera.position.toArray(), target: controls.target.toArray() }),
  restore: (s) => {
    camera.position.fromArray(s.pos);
    controls.target.fromArray(s.target);
    controls.update();
  },
});
