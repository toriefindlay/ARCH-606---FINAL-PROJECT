import { $ } from "../../core/dom.js";
import { on } from "../../core/events.js";
import { registerCutProvider, collectCuts } from "../combine.js";
import { provideCuts } from "./rules.js";
import { renderPreview } from "./view.js";
import { mountPanel } from "./panel.js";

export function mountInterior() {
  registerCutProvider("interior", provideCuts);
  mountPanel($("interior-panel"));
  on("cuts:changed", () => renderPreview(collectCuts().filter((c) => c.source === "interior")));
}
