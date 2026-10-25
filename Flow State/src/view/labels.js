import * as THREE from "three";

// A small text sprite that always faces the camera and draws over geometry.
export function makeLabel(text, size, color = "#1d1d1b") {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  ctx.fillStyle = color;
  ctx.font = "600 40px Helvetica, Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 32, 34);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false }));
  s.scale.set(size, size, 1);
  s.renderOrder = 12;
  return s;
}

// Remove and dispose everything inside a group.
export function clearChildren(g) {
  for (const c of [...g.children]) {
    c.traverse((o) => {
      o.geometry?.dispose();
      o.material?.map?.dispose();
      o.material?.dispose?.();
    });
    g.remove(c);
  }
}
