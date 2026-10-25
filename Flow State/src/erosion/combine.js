import { state } from "../core/state.js";
import { emit } from "../core/events.js";
import { getMassInfo } from "../mass/model3dm.js";
import { getWind } from "../site/wind.js";
import { SOURCES } from "./contract.js";

// Gathers cuts from the exterior and interior modules. Each module registers one provider:
//
//   registerCutProvider("exterior", (ctx) => [createCut({...}), ...]);
//
// ctx is everything a module may read (never write):
//   mass      getMassInfo(): { name, object, bounds, scale } or null
//   site      { lat, lon, radius }
//   features  parsed context: roads, paths, green, buildings (site coordinates: Vector2 east, north)
//   wind      getWind(): { from, mean, bins, ... } or null until the wind layer has loaded

const providers = new Map();

export function registerCutProvider(source, fn) {
  if (!SOURCES.includes(source)) throw new Error(`Unknown cut source "${source}".`);
  providers.set(source, fn);
}

export function collectCuts() {
  const ctx = { mass: getMassInfo(), site: state.site, features: state.features, wind: getWind() };
  if (!ctx.mass) return [];
  return [...providers].flatMap(([source, provide]) =>
    provide(ctx).map((cut) => {
      if (cut.source !== source) throw new Error(`Cut "${cut.id}" came from the ${source} module but says ${cut.source}.`);
      return cut;
    })
  );
}

// True where any cut removes material at this world point.
export const isRemoved = (cuts, x, y, z) => cuts.some((c) => c.bounds.containsPoint({ x, y, z }) && c.sdf(x, y, z) < 0);

// Call after a module's cuts change so views and the combined result can refresh.
export const notifyCutsChanged = () => emit("cuts:changed");
