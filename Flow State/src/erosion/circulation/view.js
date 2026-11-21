// VIEW (circulation): draws a plan from rules.js in the scene: the hallways (a floor and low walls on every storey), the stair-and-lift cores
// (a translucent shaft, a lift and the flights of the stair), and the entrance (a door and an arrow on the wall). No planning code.
// Everything is marked solid (userData.solid), so the x-ray mode (exterior/view.js) leaves it as it is while the mass goes faint.
import * as THREE from "three";

const APART_FLOOR_COLOUR = 0xb9c2c9, APART_WALL_COLOUR = 0x7d8a94; // hallways with no route to an entrance
const FLOOR_COLOUR = 0xf2c14e, WALL_COLOUR = 0xd9822b, CORE_COLOUR = 0x7a4f8f, STAIR_COLOUR = 0x4d3360, DOOR_COLOUR = 0x2f9e44;
const LIFT = 2.4; // m: the lift's side
const SLAB = 0.15; // m: a floor slab's thickness (also a flight of stairs)

export function createCirculationView() {
  let group = null, owner = null, shownKey = "", parts = null, showAccessible = true, showCutoff = true;

  const clear = () => {
    group?.traverse((o) => { o.geometry?.dispose(); [o.material].flat().filter(Boolean).forEach((m) => m.dispose()); });
    group?.parent?.remove(group);
    group = owner = parts = null;
    shownKey = "";
  };

  // The floor plates and the walls of every hallway: a quad per cell of the plan, the walls where a cell has no hallway beside it.
  function hallways(plan) {
    const { a0, b0, g, na, nb, A, B } = plan.grid;
    const world = (i, j, y) => { const a = a0 + i * g, b = b0 + j * g; return [a * A[0] + b * B[0], y, a * A[1] + b * B[1]]; };
    const quad = (out, p, q, r, s) => out.push(...p, ...q, ...r, ...p, ...r, ...s);
    const geometry = (pos) => { const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.computeVertexNormals(); return geo; };
    const out = { mask: new THREE.Group(), detached: new THREE.Group() }; // (each can be shown or hidden on its own: see setParts)
    // the hallways joined to an entrance, and (grey) the ones the tunnels leave no way down from
    for (const [which, floorColour, wallColour] of [["mask", FLOOR_COLOUR, WALL_COLOUR], ["detached", APART_FLOOR_COLOUR, APART_WALL_COLOUR]]) {
      const floorPos = [], wallPos = [];
      for (const f of plan.floors) {
        const m = f?.[which];
        if (!m) continue;
        const yF = f.y0 + 0.04, yT = f.y0 + plan.head;
        const has = (i, j) => i >= 0 && j >= 0 && i < na && j < nb && m[j * na + i] === 1;
        for (let j = 0; j < nb; j++) {
          for (let i = 0; i < na; i++) {
            if (!m[j * na + i]) continue;
            quad(floorPos, world(i, j, yF), world(i + 1, j, yF), world(i + 1, j + 1, yF), world(i, j + 1, yF));
            if (!has(i - 1, j)) quad(wallPos, world(i, j, f.y0), world(i, j + 1, f.y0), world(i, j + 1, yT), world(i, j, yT));
            if (!has(i + 1, j)) quad(wallPos, world(i + 1, j, f.y0), world(i + 1, j + 1, f.y0), world(i + 1, j + 1, yT), world(i + 1, j, yT));
            if (!has(i, j - 1)) quad(wallPos, world(i, j, f.y0), world(i + 1, j, f.y0), world(i + 1, j, yT), world(i, j, yT));
            if (!has(i, j + 1)) quad(wallPos, world(i, j + 1, f.y0), world(i + 1, j + 1, f.y0), world(i + 1, j + 1, yT), world(i, j + 1, yT));
          }
        }
      }
      if (floorPos.length) {
        const mesh = new THREE.Mesh(geometry(floorPos), new THREE.MeshLambertMaterial({ color: floorColour, side: THREE.DoubleSide }));
        mesh.renderOrder = 7;
        out[which].add(mesh);
      }
      if (wallPos.length) {
        const mesh = new THREE.Mesh(geometry(wallPos), new THREE.MeshLambertMaterial({ color: wallColour, side: THREE.DoubleSide, transparent: true, opacity: 0.5, depthWrite: false }));
        mesh.renderOrder = 8;
        out[which].add(mesh);
      }
    }
    return out;
  }

  // A core: a translucent shaft from its lowest floor to the headroom of its highest, the lift at one end, and a two-flight stair for every storey.
  function core(plan, c) {
    const { g, A, B } = plan.grid, long = c.w >= c.h, u = long ? A : B;
    const Lx = Math.max(c.w, c.h) * g, Lz = Math.min(c.w, c.h) * g;
    const y0 = c.s0 * plan.storey, y1 = c.s1 * plan.storey + plan.head, H = y1 - y0;
    const ca = (c.a0 + c.a1) / 2, cb = (c.b0 + c.b1) / 2;
    const gr = new THREE.Group();
    gr.position.set(ca * A[0] + cb * B[0], 0, ca * A[1] + cb * B[1]);
    gr.rotation.y = Math.atan2(-u[1], u[0]); // (its x axis along the long side)
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(Lx, H, Lz), new THREE.MeshLambertMaterial({ color: CORE_COLOUR, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
    shaft.position.y = y0 + H / 2;
    shaft.renderOrder = 8;
    gr.add(shaft);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(shaft.geometry), new THREE.LineBasicMaterial({ color: CORE_COLOUR }));
    edges.position.copy(shaft.position);
    gr.add(edges);
    if (c.kind === "lift") { // a lift core (main cores): the whole shaft is lifts, from the ground to the top, with the landing at every floor
      const inner = new THREE.Mesh(new THREE.BoxGeometry(Lx - 0.4, H, Lz - 0.4), new THREE.MeshLambertMaterial({ color: CORE_COLOUR, transparent: true, opacity: 0.6 }));
      inner.position.y = y0 + H / 2;
      gr.add(inner);
      return gr;
    }
    const wall = 0.2, lift = plan.lift ? Math.min(LIFT, Lz - 2 * wall) : 0;
    if (lift) { // (a lift at one end, if the plan has one)
      const liftBox = new THREE.Mesh(new THREE.BoxGeometry(lift, H, lift), new THREE.MeshLambertMaterial({ color: CORE_COLOUR, transparent: true, opacity: 0.55 }));
      liftBox.position.set(-Lx / 2 + wall + lift / 2, y0 + H / 2, 0);
      gr.add(liftBox);
    }
    // the stair: in the rest of the length, one flight up and one back for each storey (side by side)
    const xA = -Lx / 2 + wall + (lift ? lift + 0.2 : 0), xB = Lx / 2 - wall, run = xB - xA, fw = Math.max(0.6, (Lz - 3 * wall) / 2);
    if (run > 1 && c.narrow) { // a straight single flight for each storey, the way it goes alternating (it is only 2 m wide)
      const mat = new THREE.MeshLambertMaterial({ color: STAIR_COLOUR });
      for (let s = c.s0; s < c.s1; s++) {
        const dir = (s - c.s0) % 2 ? -1 : 1, yb = s * plan.storey, x0 = dir > 0 ? xA : xB, x1 = dir > 0 ? xB : xA, dx = x1 - x0, dy = plan.storey, len = Math.hypot(dx, dy);
        const flight = new THREE.Mesh(new THREE.BoxGeometry(len, SLAB, Math.max(0.6, Lz - 2 * wall)), mat);
        flight.position.set((x0 + x1) / 2, yb + dy / 2, 0);
        flight.rotation.z = Math.atan2(dy, dx);
        gr.add(flight);
      }
    } else if (run > 1) {
      const mat = new THREE.MeshLambertMaterial({ color: STAIR_COLOUR });
      for (let s = c.s0; s < c.s1; s++) {
        const yb = s * plan.storey, ym = yb + plan.storey / 2, yt = yb + plan.storey;
        for (const [x0, x1, ya, yb2, z] of [[xA, xB, yb, ym, -(fw / 2 + wall / 2)], [xB, xA, ym, yt, fw / 2 + wall / 2]]) {
          const dx = x1 - x0, dy = yb2 - ya, len = Math.hypot(dx, dy);
          const flight = new THREE.Mesh(new THREE.BoxGeometry(len, SLAB, fw), mat);
          flight.position.set((x0 + x1) / 2, (ya + yb2) / 2, z);
          flight.rotation.z = Math.atan2(dy, dx);
          gr.add(flight);
        }
        const landing = new THREE.Mesh(new THREE.BoxGeometry(Lx - 2 * wall, SLAB, Lz - 2 * wall), new THREE.MeshLambertMaterial({ color: CORE_COLOUR, transparent: true, opacity: 0.5 }));
        landing.position.set(0, yt + SLAB / 2, 0); // (the floor of the storey above: the stair comes out through it)
        if (s + 1 < c.s1) gr.add(landing);
      }
    }
    return gr;
  }

  // The entrance: a door on the wall and an arrow pointing out of it.
  function door(plan, e) {
    const w = plan.grid.width, gr = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: DOOR_COLOUR });
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(w, 2.2, 0.2), mat);
    leaf.position.y = 1.1;
    gr.add(leaf);
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.2, 16), mat);
    arrow.rotation.x = Math.PI / 2; // (the cone's tip along +z, then turned to the way out below)
    arrow.position.set(0, 1.1, 1.0);
    gr.add(arrow);
    gr.position.set(e.x, 0, e.z);
    gr.rotation.y = Math.atan2(e.nx, e.nz); // (its +z along the way out)
    return gr;
  }

  return {
    clear,
    // Shows the plan under `parent` (cheap to call every frame: it is only rebuilt when `key` changes); `plan` null or `on` false clears it.
    update(parent, plan, key, on) {
      if (!parent || !plan || !on) return clear();
      if (key === shownKey && group?.parent === parent) return;
      clear();
      shownKey = key;
      owner = plan;
      group = new THREE.Group();
      group.userData.solid = true; // the x-ray mode leaves this as it is
      parts = hallways(plan);
      group.add(parts.mask, parts.detached);
      for (const c of plan.cores) group.add(core(plan, c));
      for (const e of plan.entrances) group.add(door(plan, e));
      parts.mask.visible = showAccessible; parts.detached.visible = showCutoff;
      parent.add(group);
    },
    // Shows or hides the hallways joined to an exit (amber) and the ones cut off from every exit (grey), each on its own. (The cores and the exits stay.)
    // Cheap to call every frame, and kept for when the plan is drawn again.
    setParts(accessible, cutoff) {
      showAccessible = !!accessible; showCutoff = !!cutoff;
      if (parts) { parts.mask.visible = showAccessible; parts.detached.visible = showCutoff; }
    },
    get plan() { return owner; },
  };
}
