import { $ } from "../core/dom.js";

// The panel sections (Model, Exterior erosion, Layers, ...) are <details class="section"> in index.html, so the
// browser opens and closes them. This only remembers which ones are closed, per heading, in this browser.

const KEY = "flowstate.collapsed";
let closed = {};
try {
  closed = JSON.parse(localStorage.getItem(KEY)) ?? {};
} catch { /* no storage: sections just start open */ }

for (const section of $("hud").querySelectorAll("details.section")) {
  const name = section.querySelector("summary").textContent.trim();
  if (closed[name]) section.open = false;
  section.addEventListener("toggle", () => {
    closed[name] = !section.open;
    try {
      localStorage.setItem(KEY, JSON.stringify(closed));
    } catch { /* not remembered */ }
  });
}
