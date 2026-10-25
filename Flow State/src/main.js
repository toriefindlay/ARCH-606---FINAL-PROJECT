// Bootstrap only: importing a module wires it up. Order matters in one way: parts saved with a
// site are restored in the order they are registered here (see core/persist.js).
import "./view/scene.js";
import "./ui/hud.js";
import "./ui/collapse.js";
import "./site/context.js";
import "./site/draw.js";
import "./site/sun.js";
import "./site/wind.js";
import "./mass/model3dm.js";
import "./erosion/index.js";
import "./library.js";
import "./ui/start.js";
