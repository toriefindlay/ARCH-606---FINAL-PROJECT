// What is inside the massings and what is not. A height map takes everything under a surface to be solid, which is wrong
// under the curved-in side of a rounded form or an overhang; this answers for any point, from the meshes themselves.
//
// Each massing mesh is taken as a solid of its own: a point is inside it if a ray straight up crosses it an odd number of
// times (so a mesh with no underside works too, standing on the ground). A point is inside the massings if it is inside any
// of them, so overlapping ones are simply joined.

const BUCKET = 2; // m: the triangles are sorted into squares of this size, seen from above

// `meshes`: one flat array of world positions (9 numbers a triangle) for every mesh.
export function createSolid(meshes) {
  const buckets = new Map(); // square -> [mesh number, where its triangle starts]...
  const key = (i, j) => i * 100003 + j;
  meshes.forEach((tris, mesh) => {
    for (let t = 0; t + 8 < tris.length; t += 9) {
      const det = (tris[t + 3] - tris[t]) * (tris[t + 8] - tris[t + 2]) - (tris[t + 6] - tris[t]) * (tris[t + 5] - tris[t + 2]);
      if (Math.abs(det) < 1e-9) continue; // (upright: a ray straight up never crosses it)
      const i0 = Math.floor(Math.min(tris[t], tris[t + 3], tris[t + 6]) / BUCKET), i1 = Math.floor(Math.max(tris[t], tris[t + 3], tris[t + 6]) / BUCKET);
      const j0 = Math.floor(Math.min(tris[t + 2], tris[t + 5], tris[t + 8]) / BUCKET), j1 = Math.floor(Math.max(tris[t + 2], tris[t + 5], tris[t + 8]) / BUCKET);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          let list = buckets.get(key(i, j));
          if (!list) buckets.set(key(i, j), (list = []));
          list.push(mesh, t);
        }
      }
    }
  });

  // Where the ray straight up through (x, z) crosses each mesh: Map of a mesh's number to its heights.
  function crossings(px, pz) {
    const x = px + 1.37e-5, z = pz + 2.11e-5; // (nudged off the exact edges that triangles share)
    const list = buckets.get(key(Math.floor(x / BUCKET), Math.floor(z / BUCKET))), out = new Map();
    if (!list) return out;
    for (let n = 0; n < list.length; n += 2) {
      const tris = meshes[list[n]], t = list[n + 1];
      const ax = tris[t], az = tris[t + 2], bx = tris[t + 3] - ax, bz = tris[t + 5] - az, cx = tris[t + 6] - ax, cz = tris[t + 8] - az;
      const det = bx * cz - cx * bz, q = ((x - ax) * cz - cx * (z - az)) / det, r = (bx * (z - az) - (x - ax) * bz) / det;
      if (q < 0 || r < 0 || q + r > 1) continue;
      const y = tris[t + 1] + q * (tris[t + 4] - tris[t + 1]) + r * (tris[t + 7] - tris[t + 1]);
      let heights = out.get(list[n]);
      if (!heights) out.set(list[n], (heights = []));
      heights.push(y);
    }
    return out;
  }
  // is height y inside, given crossings() of its place?
  const insideAt = (found, y) => {
    for (const heights of found.values()) {
      let above = 0;
      for (const h of heights) if (h > y) above++;
      if (above % 2) return true;
    }
    return false;
  };
  return { crossings, insideAt, inside: (x, y, z) => y > 0 && insideAt(crossings(x, z), y) };
}

// The world triangles of every mesh under a three.js object, one flat array for each.
export function meshTriangles(object, Vector3) {
  const meshes = [], v = new Vector3();
  object.traverse((o) => {
    const position = o.isMesh && o.geometry?.attributes.position;
    if (!position) return;
    o.updateWorldMatrix(true, false);
    const index = o.geometry.index, count = index ? index.count : position.count, out = [];
    for (let i = 0; i + 2 < count; i += 3) {
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(position, index ? index.getX(i + k) : i + k).applyMatrix4(o.matrixWorld);
        out.push(v.x, v.y, v.z);
      }
    }
    meshes.push(out);
  });
  return meshes;
}

const OFF = 0.08; // m: how far each side of a triangle is looked at

// The way out of the massings from a triangle with its middle at (x, y, z) and unit normal (nx, ny, nz): 1 along the
// normal, -1 against it, or 0 if it is buried inside the massings and so is no part of their outside.
export function outward(solid, x, y, z, nx, ny, nz) {
  const front = solid.inside(x + nx * OFF, y + ny * OFF, z + nz * OFF), back = solid.inside(x - nx * OFF, y - ny * OFF, z - nz * OFF);
  if (front && back) return 0;
  if (front) return -1;
  if (back) return 1;
  return ny >= 0 ? 1 : -1; // (a surface with nothing behind it, such as a single sheet: it is taken to face up)
}
