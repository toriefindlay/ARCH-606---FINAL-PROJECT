import { controls } from "../view/scene.js";
import { layers } from "../core/state.js";
import { on, emit } from "../core/events.js";
import { $ } from "../core/dom.js";
import { registerPersist } from "../core/persist.js";

// The side panel's shared parts: layer toggles, orbit toggle, context statistics.
// Each feature module (sun, wind, draw, mass, erosion) owns its own panel section.

const layerBoxes = () => document.querySelectorAll("[data-layer]");

layerBoxes().forEach((box) =>
  box.addEventListener("change", () => {
    const name = box.dataset.layer;
    if (layers[name]) layers[name].visible = box.checked;
    emit("layer:toggled", { name, visible: box.checked });
  })
);

$("orbit").addEventListener("change", (e) => (controls.autoRotate = e.target.checked));

on("site:ready", ({ features }) => {
  layerBoxes().forEach((b) => (b.checked = layers[b.dataset.layer]?.visible ?? true));
  $("stats").innerHTML =
    `<b>${features.counts.buildings}</b> buildings<br>` +
    `<b>${features.counts.roads}</b> road segments<br>` +
    `<b>${features.counts.paths}</b> paths<br>` +
    `<b>${features.counts.green}</b> green / water areas`;
});

registerPersist("layers", {
  capture: () => Object.fromEntries([...layerBoxes()].map((b) => [b.dataset.layer, b.checked])),
  restore: (saved) => {
    layerBoxes().forEach((b) => {
      const name = b.dataset.layer;
      if (saved[name] === undefined) return;
      b.checked = saved[name];
      if (layers[name]) layers[name].visible = saved[name];
      emit("layer:toggled", { name, visible: saved[name] });
    });
  },
});
