// CONTROLLER (exterior erosion): the controls in the side panel.
// `el` is the empty #exterior-panel container in index.html. Call notifyCutsChanged() from
// erosion/combine.js after any control changes the cuts, and registerPersist() to save settings.

export function mountPanel(el) {
  el.innerHTML = `<p class="hint">Exterior erosion: not built yet.</p>`;
}
