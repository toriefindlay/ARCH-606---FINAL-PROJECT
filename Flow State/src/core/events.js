// Tiny pub/sub so modules can react to each other without importing each other.
//
// Events in use (payload in braces):
//   site:built     {site, features, saved}  site geometry exists; modules create their layers here
//   site:ready     {site, features, saved}  every module has built its layer; UI can sync
//   site:cleared                            the site is being torn down; reset module state
//   layer:toggled  {name, visible}          a Layers checkbox changed
//   drawn:changed                            a road or path was drawn, deleted or restored (see site/draw.js getUserLines)
//   mass:changed  {mass}                    the imported mass was placed, scaled or removed (mass may be null)
//   cuts:changed                             an erosion module's cuts changed (see erosion/combine.js)
//   sun:advanced  {vec, hours}              the Sun panel's simulation moved the sun: vec is its direction (world, y up) and
//                                           hours the simulated time that passed (only while a day or the year is playing)

const handlers = new Map();

export function on(name, fn) {
  if (!handlers.has(name)) handlers.set(name, new Set());
  handlers.get(name).add(fn);
  return () => handlers.get(name).delete(fn);
}

export function emit(name, payload) {
  handlers.get(name)?.forEach((fn) => fn(payload));
}
