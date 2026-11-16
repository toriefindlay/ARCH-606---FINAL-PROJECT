// VIEW (exterior erosion): the "cooling data" layer. Inside the (x-rayed) mass, every storey gets a floor plan shaded by how well that
// part of the floor is cooled by the wind tunnels, just above the floor (CHEST). No solver code.
//
// Cooling is the solver's cooling (tunnels.js coolingMap): 1 = as much cooling as right beside a tunnel carrying the open wind's speed,
// fading to nothing 3 m away. Shown as a percentage, 0 to 100% (anything above 1 counts as 100%).
import * as THREE from "three";
import { STOREY, NEAR } from "./tunnels.js";

const CHEST = 0.6; // metres above the floor that the plan is drawn at

// The colour ramp: [percent, hex]. Red where there is no cooling, through amber and pale yellow, to blue where it is fully cooled.
export const COOLING_RAMP = [[0, 0xb8321f], [25, 0xe8a23a], [50, 0xf2e394], [75, 0x6fb0d2], [100, 0x1d4e89]];
export const COOLED_AT = Math.round(NEAR * 100); // the percentage that counts as cooled (the solver's coverage threshold)

const stops = COOLING_RAMP.map(([p, hex]) => [p, new THREE.Color(hex)]);
const tmp = new THREE.Color();
// The colour for a percentage (0 to 100).
export function coolingColour(pct) {
  const p = Math.max(0, Math.min(100, pct));
  for (let i = 1; i < stops.length; i++) {
    if (p <= stops[i][0]) return tmp.copy(stops[i - 1][1]).lerp(stops[i][1], (p - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]));
  }
  return tmp.copy(stops[stops.length - 1][1]);
}
// The ramp as a CSS gradient, for the legend.
export const coolingGradient = () => `linear-gradient(to right, ${COOLING_RAMP.map(([p, hex]) => `#${hex.toString(16).padStart(6, "0")} ${p}%`).join(", ")})`;

export function createCoolingView() {
  let group = null, owner = null, shownKey = "";

  const clear = () => {
    group?.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); });
    group?.parent?.remove(group);
    group = owner = null;
    shownKey = "";
  };

  return {
    clear,
    // Shows the floor plans of the given bands (a list of band numbers) of `tunnels` under `parent`; none clears them. Cheap to call every frame.
    update(parent, tunnels, bands) {
      if (!parent || !tunnels || !bands.length) return clear();
      const { vox } = tunnels;
      const maps = bands.map((b) => [b, tunnels.coolingMap(b)]).filter(([, m]) => m);
      const key = `${tunnels.id}|${parent.id}|` + maps.map(([b, m]) => `${b}:${m.cool.length}:${tunnels.coolingMapKey(b)}`).join("|");
      if (key === shownKey && group?.parent === parent) return;
      clear();
      shownKey = key;
      owner = tunnels;
      group = new THREE.Group();
      group.userData.solid = true; // the x-ray mode (view.js) leaves this as it is
      parent.add(group);
      const { nx, nz, c, x0, z0, cells } = vox, nxz = nx * nz;
      for (const [b, m] of maps) {
        for (let s = 0; s < 2; s++) {
          const storey = 2 * b + s, l = vox.layerAt(storey * STOREY + CHEST);
          if (l < m.lo || l >= m.hi) continue;
          const data = new Uint8Array(nxz * 4);
          let any = false;
          for (let j = 0; j < nz; j++) {
            const row = nz - 1 - j; // the plane's top edge is north (-z), and a texture's first row is its bottom edge
            for (let i = 0; i < nx; i++) {
              const k = (l * nz + j) * nx + i;
              if (cells[k] !== 1) continue; // only inside the mass (1 = MASS)
              const rgb = coolingColour(100 * Math.min(1, m.cool[(l - m.lo) * nxz + j * nx + i])), o = (row * nx + i) * 4;
              data[o] = Math.round(rgb.r * 255); data[o + 1] = Math.round(rgb.g * 255); data[o + 2] = Math.round(rgb.b * 255); data[o + 3] = 215;
              any = true;
            }
          }
          if (!any) continue;
          const texture = new THREE.DataTexture(data, nx, nz, THREE.RGBAFormat, THREE.UnsignedByteType);
          texture.minFilter = texture.magFilter = THREE.LinearFilter;
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.needsUpdate = true;
          const mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(nx * c, nz * c).rotateX(-Math.PI / 2),
            new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
          );
          mesh.position.set(x0 + (nx * c) / 2, vox.yc[l], z0 + (nz * c) / 2);
          mesh.renderOrder = 6;
          group.add(mesh);
        }
      }
    },
  };
}
