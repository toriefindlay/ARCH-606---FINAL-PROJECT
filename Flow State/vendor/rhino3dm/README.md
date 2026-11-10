# rhino3dm (vendored)

`rhino3dm.js` and `rhino3dm.wasm` are copied unchanged from the npm package **rhino3dm 8.0.1**
(https://www.npmjs.com/package/rhino3dm, MIT licence, McNeel & Associates), fetched from
`https://cdn.jsdelivr.net/npm/rhino3dm@8.0.1/`.

They are what three.js's `Rhino3dmLoader` (src/mass/model3dm.js) reads a `.3dm` file with. The loader asks for exactly these
two file names. They live here so that importing a model does not depend on a CDN being reachable.

To update: download the same two files from a newer version of the package and replace them.
