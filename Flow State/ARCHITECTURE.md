# Flow State: architecture

## Run it

Serve this folder over HTTP (module scripts don't load from `file://`), e.g. the VS Code
"Live Server" extension, or `python -m http.server` in this folder, then open `index.html`.
No build step. Three.js and rhino3dm load from a CDN.

## Layout

```
index.html, style.css
src/
  main.js              bootstrap only: imports every module
  pipeline.js          builds / tears down a site; emits the site:* events
  library.js           saved sites: Save button, start-screen list, "â† Sites"
  core/                shared plumbing: events, state, persist, storage, coords, dom
  view/                scene (renderer, camera, lights, frame loop), pick (pointer -> ground), labels
  ui/                  hud (layers, stats), start (coordinate form)
  site/                context from the real world: osm, context geometry, draw, sun, wind
  mass/                model3dm: the imported starting mass, scale handles
  erosion/
    contract.js        THE CONTRACT: what a Cut is
    sdf.js             shared volume primitives (sphere, capsule, box, union, intersect)
    combine.js         collects cuts from both sides
    exterior/          EXTERIOR EROSION: rules.js (model), view.js, panel.js (controller)
    interior/          INTERIOR EROSION: rules.js (model), view.js, panel.js (controller)
```

## Ownership

| Area | Owner |
| --- | --- |
| `src/erosion/exterior/` | exterior partner |
| `src/erosion/interior/` | interior partner |
| `src/erosion/contract.js`, `sdf.js`, `combine.js`, everything else | shared: change by review |

Work on your own branch, edit only your own folder, merge small and often.

## Decision: erosion uses distance fields

Cuts are signed-distance functions, not mesh booleans. Why: combining cuts is just taking the
minimum, so it never fails on messy meshes, order doesn't matter, cuts can be toggled and
compared instantly, and cuts can blend smoothly (organic forms). Trade-off: there is no surface
until one is extracted from the field (marching cubes), and sharp edges round off at coarse
resolution. If crisp, exportable geometry is needed later, redo the chosen design as a clean
boolean in Rhino.

Still to build: the step that samples the combined field over the mass and extracts the carved
mesh (suggested home: `erosion/carve.js`, called from `combine.js` on `cuts:changed`).

## How the two erosion modules combine

Neither edits the mass. Each returns **cuts** (volumes to remove, as signed-distance
functions) from `rules.js -> provideCuts(ctx)`. `combine.js` collects them; the mass is
carved by their union. `ctx` gives read-only access to:

- `mass`: `{ name, object, bounds, scale }`, the placed mass (metres, base on y = 0)
- `site`: `{ lat, lon, radius }`
- `features`: roads, paths, green, buildings (Vector2: east, north)
- `wind`: prevailing wind `{ from, mean, bins }`, or null until the wind layer has loaded. Sun: `sunPosition()` from `site/sun.js`.

World coordinates everywhere: metres, x = east, y = up, z = -north, pin at the origin.

Inside each erosion folder: `rules.js` is the model (pure logic, no scene or DOM), `view.js`
the scene preview, `panel.js` the controls. After a control changes your cuts, call
`notifyCutsChanged()`; listen for `mass:changed` to recompute when the mass moves or scales.

## Events (`core/events.js`)

`site:built` (create your layer under `layers.*`), `site:ready` (sync UI), `site:cleared`
(reset your module state), `layer:toggled`, `mass:changed`, `cuts:changed`.

## Saving settings

Anything that should survive reopening a saved site: `registerPersist("key", { capture, restore })`
from `core/persist.js`. Use a key unique to your module (e.g. `"exteriorErosion"`).
Parts restore in the order modules are imported in `main.js`.

## Adding a panel section

Put a `<fieldset>` in `index.html`'s side panel. Exterior and interior already have containers
(`#exterior-panel`, `#interior-panel`).
