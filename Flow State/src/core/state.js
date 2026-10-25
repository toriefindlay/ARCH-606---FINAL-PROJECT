// Shared, mutable app state. Modules read it and the pipeline writes it.
export const state = {
  site: null, // { lat, lon, radius } of the generated context
  siteGroup: null, // THREE.Group holding everything belonging to the current site
  data: null, // raw OpenStreetMap response for the current site
  features: null, // parsed context (roads, paths, green, buildings) in site coordinates
  saveRef: null, // { id, name } once the site has been saved or loaded
};

// Named scene layers (THREE.Groups) that the Layers panel can toggle.
// Each module creates its own on "site:built".
export const layers = {};
