import { $ } from "../../core/dom.js";
import { on } from "../../core/events.js";
import { registerCutProvider, collectCuts } from "../combine.js";
import { provideCuts } from "./rules.js";
import { renderPreview } from "./view.js";
import { mountPanel } from "./panel.js";
import { mountSpacesView } from "./spacesView.js";

export function mountInterior() {
  registerCutProvider("interior", provideCuts);
  const panel = $("interior-panel"); // (the Interior erosion section has been taken out of the page: no controls to add spaces)
  if (panel) mountPanel(panel);
  mountSpacesView(); // the occupied spaces (spaces.js) as spheres in the scene
  on("cuts:changed", () => renderPreview(collectCuts().filter((c) => c.source === "interior")));
}
