// CONTROLLER (interior erosion): the controls in the side panel.
// `el` is the empty #interior-panel container in index.html. Call notifyCutsChanged() from
// erosion/combine.js after any control changes the cuts, and registerPersist() to save settings.

export function mountPanel(el) {
  const demoUrl = new URL("./boids/index.html", import.meta.url).href;
  el.innerHTML = `<p class="hint">Explore circulation inside a cube with Boids, five modifier types, trails and density.</p>
    <a class="tool" href="${demoUrl}" target="_blank" rel="noopener">Open interior circulation demo ↗</a>
    <p class="hint">Standalone study; does not modify or carve your imported mass.</p>`;
}
