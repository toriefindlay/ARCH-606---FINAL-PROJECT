import { generate } from "../pipeline.js";
import { $ } from "../core/dom.js";

// The start screen: coordinates in, site out.

const latEl = $("lat");
const lonEl = $("lon");
const radiusEl = $("radius");

radiusEl.addEventListener("input", () => ($("radius-out").textContent = `${radiusEl.value} m`));

// Paste "lat, lon" into either field and split it.
for (const el of [latEl, lonEl]) {
  el.addEventListener("paste", (e) => {
    const text = (e.clipboardData || window.clipboardData).getData("text");
    const m = text.match(/(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)/);
    if (!m) return;
    e.preventDefault();
    latEl.value = m[1];
    lonEl.value = m[2];
  });
}

document.querySelectorAll(".presets button").forEach((b) =>
  b.addEventListener("click", () => {
    latEl.value = b.dataset.lat;
    lonEl.value = b.dataset.lon;
  })
);

$("site-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const lat = parseFloat(latEl.value);
  const lon = parseFloat(lonEl.value);
  const err = $("form-error");
  if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) {
    err.textContent = "Enter a latitude between -90 and 90 and a longitude between -180 and 180.";
    return;
  }
  err.textContent = "";
  generate(lat, lon, parseInt(radiusEl.value, 10));
});
