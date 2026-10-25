// CONTROLLER (interior erosion): the controls in the side panel.
// `el` is the empty #interior-panel container in index.html. Call notifyCutsChanged() from
// erosion/combine.js after any control changes the cuts, and registerPersist() to save settings.

export function mountPanel(el) {
  el.innerHTML = `<p class="hint">Interior erosion: not built yet.</p>`;
}
