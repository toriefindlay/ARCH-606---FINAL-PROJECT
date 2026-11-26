// VIEW (structure): draws what model.js plans: the floor plates as one mesh, and every steel member as an I section (two
// flanges and a web). Used by the working view and by the render view, each with materials of its own.
import * as THREE from "three";

const FLANGE = 0.03, WEB = 0.02; // m: the I section's plate thicknesses (drawn a little heavy, to be seen)

// `data`: planStructure()'s result. `materials`: { plate, steel }. Returns { group, plates, steel }.
export function buildStructureMeshes(data, materials) {
  const group = new THREE.Group(), plates = new THREE.Group(), steel = new THREE.Group();
  if (data.plates.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(data.plates, 3));
    geometry.computeVertexNormals(); // (every triangle has its own corners: the faces come out flat, the edges sharp)
    // texture coordinates in metres, from above
    const p = geometry.attributes.position, uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { uv[2 * i] = p.getX(i); uv[2 * i + 1] = p.getZ(i); }
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    const mesh = new THREE.Mesh(geometry, materials.plate);
    mesh.renderOrder = 4;
    mesh.receiveShadow = true;
    plates.add(mesh);
  }
  if (data.members.length) {
    const pieces = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), materials.steel, data.members.length * 3);
    const along = new THREE.Vector3(), side = new THREE.Vector3(), up = new THREE.Vector3(), middle = new THREE.Vector3(), at = new THREE.Vector3();
    const basis = new THREE.Matrix4(), turn = new THREE.Quaternion(), size = new THREE.Vector3(), m = new THREE.Matrix4();
    let n = 0;
    for (const member of data.members) {
      along.fromArray(member.to).sub(at.fromArray(member.from));
      const length = along.length();
      middle.fromArray(member.from).addScaledVector(along, 0.5);
      along.normalize();
      // the section's depth: upright for a beam; for a column, along x
      up.set(0, 1, 0);
      if (Math.abs(along.y) > 0.9) up.set(1, 0, 0);
      side.crossVectors(along, up).normalize();
      up.crossVectors(side, along);
      turn.setFromRotationMatrix(basis.makeBasis(along, up, side));
      const { depth, width } = member;
      for (const [offset, high, wide] of [[(depth - FLANGE) / 2, FLANGE, width], [-(depth - FLANGE) / 2, FLANGE, width], [0, depth - 2 * FLANGE, WEB]]) {
        pieces.setMatrixAt(n++, m.compose(at.copy(middle).addScaledVector(up, offset), turn, size.set(length, high, wide)));
      }
    }
    pieces.castShadow = pieces.receiveShadow = true;
    pieces.frustumCulled = false;
    steel.add(pieces);
  }
  group.add(plates, steel);
  return { group, plates, steel };
}
