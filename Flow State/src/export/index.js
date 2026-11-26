// CONTROLLER (export): the "Export to Rhino" button. Gathers what is on screen into four parts, each one mesh on a layer of
// its own in a .3dm file (rhinoFile.js): the massing, the wind tunnels, the people's circulation that is connected to an
// entrance, and the facade. A part that does not exist (yet) is left out, and the line under the button says why.
import * as THREE from "three";
import { $ } from "../core/dom.js";
import { on } from "../core/events.js";
import { getMassInfo, hasRoundedMass } from "../mass/model3dm.js";
import { getFinishedTunnels, getShownMeshes } from "../erosion/exterior/index.js";
import { settings as exteriorSettings } from "../erosion/exterior/panel.js";
import { getCirculationPlan } from "../erosion/circulation/index.js";
import { createCirculationView } from "../erosion/circulation/view.js";
import { getFacade } from "../facades/index.js";
import { write3dm } from "./rhinoFile.js";

const setStatus = (text) => ($("export-status").textContent = text);

// Adds the triangles of every mesh under `object` to `out`, in world metres. Anything marked userData.noExport is skipped,
// with all that is under it.
function collect(object, out = []) {
  if (!object || object.userData.noExport) return out;
  const position = object.isMesh && object.geometry?.attributes.position;
  if (position) {
    object.updateWorldMatrix(true, false);
    const index = object.geometry.index, count = index ? index.count : position.count;
    const v = new THREE.Vector3(), flip = object.matrixWorld.determinant() < 0; // (a mirrored object's triangles are turned back)
    for (let i = 0; i + 2 < count; i += 3) {
      for (const k of flip ? [0, 2, 1] : [0, 1, 2]) {
        v.fromBufferAttribute(position, index ? index.getX(i + k) : i + k).applyMatrix4(object.matrixWorld);
        out.push(v.x, v.y, v.z);
      }
    }
  }
  object.children.forEach((child) => collect(child, out));
  return out;
}

// The connected circulation, whether or not it is shown on screen: it is drawn afresh into a group of its own.
function circulationTriangles(plan) {
  const view = createCirculationView(), holder = new THREE.Group();
  view.update(holder, plan, "export", true);
  const out = collect(holder);
  view.clear();
  return out;
}

// { parts, notes } for write3dm, or { wait } when something is still being made.
function gather() {
  const tunnels = getFinishedTunnels();
  const shown = getShownMeshes();
  if (tunnels && shown.busy) return { wait: "The tunnels are still being redrawn: try again in a few seconds." };
  const facade = getFacade();
  if (facade.pending) return { wait: "The facade panels are still being made: try again in a few seconds." };

  const notes = [];
  const skin = tunnels ? shown.skin : null;
  const massing = collect(skin ?? getMassInfo().object);
  if (tunnels && !skin && hasRoundedMass()) notes.push("A rounded massing is exported as imported, without the tunnel openings cut into it.");

  const walls = tunnels ? collect(shown.walls) : [];
  if (!walls.length) notes.push(exteriorSettings.erodeTunnels && !tunnels ? "No wind tunnels: they aren't finished yet." : "No wind tunnels: there are none.");

  const plan = tunnels ? getCirculationPlan() : null;
  const circulation = plan ? circulationTriangles(plan) : [];
  if (!circulation.length) notes.push("No circulation: turn it on and wait for it to be planned.");

  const panels = collect(facade.mesh);
  if (!panels.length) notes.push("No facade: none is chosen or ready.");

  const parts = [
    { name: "Massing", colour: [190, 150, 135], triangles: massing },
    { name: "Wind tunnels", colour: [15, 118, 110], triangles: walls },
    { name: "Connected circulation", colour: [217, 130, 43], triangles: circulation },
    { name: "Facade", colour: [74, 111, 165], triangles: panels },
  ].filter((p) => p.triangles.length);
  return { parts, notes };
}

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportSite() {
  if (!getMassInfo()) return setStatus("Import a .3dm massing first.");
  const button = $("export-3dm");
  button.disabled = true;
  try {
    const { parts, notes, wait } = gather();
    if (wait) return setStatus(wait);
    setStatus("Writing the Rhino file…");
    await new Promise((resolve) => setTimeout(resolve, 30)); // (so that the line above is drawn before the page is busy writing)
    const name = `${$("save-name").value.trim().replace(/[\\/:*?"<>|]+/g, "-") || "flow-state"}.3dm`;
    download(await write3dm(parts), name);
    setStatus([`Exported ${parts.map((p) => p.name.toLowerCase()).join(", ")} to ${name}.`, ...notes].join(" "));
  } catch (e) {
    console.error("Export failed:", e);
    setStatus("Couldn't export (see the console).");
  } finally {
    button.disabled = false;
  }
}

$("export-3dm").addEventListener("click", exportSite);
on("site:ready", () => setStatus(""));
