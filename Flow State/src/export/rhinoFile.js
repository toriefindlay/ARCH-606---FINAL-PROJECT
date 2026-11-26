// MODEL (export): writes triangle meshes to the bytes of a Rhino .3dm file, one object on a layer of its own for each part.
// No scene or DOM code beyond loading the writer (the vendored rhino3dm, see vendor/rhino3dm/README.md).
//
// The scene is in metres with x east, y up and z south; the file is in metres with Rhino's x east, y north and z up, and the
// same origin (the site pin, on the ground). That is a pure rotation, so the triangles keep their facing.

const WRITER_FILES = "vendor/rhino3dm/";
const WELD = 1000; // vertices closer than 1 mm are one
const CREASE = Math.cos((30 * Math.PI) / 180); // triangles meeting at less than this angle share vertices (shaded smooth); sharper edges stay sharp

let loading = null;
function loadWriter() {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${WRITER_FILES}rhino3dm.js`;
    script.onload = () => window.rhino3dm({ locateFile: (file) => WRITER_FILES + file }).then(resolve, reject);
    script.onerror = () => reject(new Error("the Rhino writer could not be loaded"));
    document.head.append(script);
  }).catch((e) => {
    loading = null; // (the next try starts afresh)
    throw e;
  });
  return loading;
}

// `triangles` is a flat array of world positions, 9 numbers a triangle. Gives { vertices: [[x, y, z]], faces: [[a, b, c]] }
// in Rhino's axes, with the triangle soup joined up and slivers of no area left out.
export function weld(triangles) {
  const vertices = [], faces = [], at = new Map();
  const index = (p, n) => {
    const key = `${Math.round(p[0] * WELD)},${Math.round(p[1] * WELD)},${Math.round(p[2] * WELD)}`;
    let list = at.get(key);
    if (!list) at.set(key, (list = []));
    const same = list.find((v) => v.n[0] * n[0] + v.n[1] * n[1] + v.n[2] * n[2] > CREASE);
    if (same) return same.i;
    list.push({ i: vertices.length, n });
    vertices.push(p);
    return vertices.length - 1;
  };
  for (let t = 0; t + 8 < triangles.length; t += 9) {
    const [a, b, c] = [0, 3, 6].map((k) => [triangles[t + k], -triangles[t + k + 2], triangles[t + k + 1]]);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, length = Math.hypot(nx, ny, nz);
    if (length < 1e-10) continue;
    const n = [nx / length, ny / length, nz / length];
    const face = [index(a, n), index(b, n), index(c, n)];
    if (face[0] !== face[1] && face[1] !== face[2] && face[2] !== face[0]) faces.push(face);
  }
  return { vertices, faces };
}

// parts: [{ name, colour: [r, g, b] (0 to 255), triangles }]. Gives the file's bytes (a Uint8Array).
export async function write3dm(parts) {
  const rhino = await loadWriter();
  const doc = new rhino.File3dm();
  doc.settings().modelUnitSystem = rhino.UnitSystem.Meters;
  for (const { name, colour: [r, g, b], triangles } of parts) {
    const layer = new rhino.Layer();
    layer.name = name;
    layer.color = { r, g, b, a: 255 };
    doc.layers().add(layer);
    const { vertices, faces } = weld(triangles);
    const mesh = new rhino.Mesh();
    const vertexList = mesh.vertices(), faceList = mesh.faces();
    for (const [x, y, z] of vertices) vertexList.add(x, y, z);
    for (const [i, j, k] of faces) faceList.addTriFace(i, j, k);
    mesh.normals().computeNormals();
    const attributes = new rhino.ObjectAttributes();
    attributes.name = name;
    attributes.layerIndex = doc.layers().count - 1;
    doc.objects().addMesh(mesh, attributes);
    [vertexList, faceList, mesh, attributes, layer].forEach((o) => o.delete?.());
  }
  const bytes = doc.toByteArray();
  doc.delete?.();
  return bytes;
}
