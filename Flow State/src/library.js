import { state } from "./core/state.js";
import { captureAll } from "./core/persist.js";
import { putSite, getSite, listSites, removeSite } from "./core/storage.js";
import { on } from "./core/events.js";
import { $ } from "./core/dom.js";
import { getMassFile } from "./mass/model3dm.js";
import { generate, clearSite } from "./pipeline.js";

// Saved sites: the Save button, the start screen's "Saved sites" list, and the "← Sites" button.

export async function saveCurrent() {
  const { site, siteGroup, data } = state;
  if (!siteGroup || !site || !data) return;
  const name = $("save-name").value.trim() || `Site ${site.lat.toFixed(4)}, ${site.lon.toFixed(4)}`;
  const id = state.saveRef?.id ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const meta = { id, name, lat: site.lat, lon: site.lon, radius: site.radius, savedAt: Date.now(), state: captureAll() };
  try {
    await putSite(meta, data, getMassFile());
    state.saveRef = { id, name };
    $("save-status").textContent = `Saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Find it on the start screen.`;
  } catch (e) {
    console.error(e);
    $("save-status").textContent = "Couldn't save (browser storage unavailable or full).";
  }
}

export async function renderSaved() {
  const box = $("saved");
  const ul = $("saved-list");
  let sites = [];
  try {
    sites = await listSites();
  } catch { /* storage unavailable: just show no saved sites */ }
  box.classList.toggle("hidden", !sites.length);
  ul.innerHTML = "";

  for (const s of sites) {
    const li = document.createElement("li");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "open";
    const title = document.createElement("b");
    title.textContent = s.name;
    const sub = document.createElement("span");
    sub.textContent = `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)} · ${s.radius} m · ${new Date(s.savedAt).toLocaleDateString()}`;
    open.append(title, sub);
    open.addEventListener("click", async () => {
      try {
        const rec = await getSite(s.id);
        generate(rec.lat, rec.lon, rec.radius, rec);
      } catch (e) {
        $("form-error").textContent = e.message;
      }
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.textContent = "✕";
    del.title = "Delete saved site";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete "${s.name}"? This can't be undone.`)) return;
      await removeSite(s.id);
      renderSaved();
    });
    li.append(open, del);
    ul.append(li);
  }
}

$("save-site").addEventListener("click", saveCurrent);

$("new-site").addEventListener("click", async () => {
  if (state.saveRef) await saveCurrent(); // a saved site keeps its changes when you leave it
  $("hud").classList.add("hidden");
  $("start").classList.remove("hidden");
  clearSite();
  state.saveRef = null;
  state.data = null;
  renderSaved();
});

on("site:ready", ({ site, saved }) => {
  $("save-name").value = saved?.name ?? `Site ${site.lat.toFixed(4)}, ${site.lon.toFixed(4)}`;
  $("save-status").textContent = saved ? "Loaded saved site." : "Not saved yet.";
});

renderSaved();
