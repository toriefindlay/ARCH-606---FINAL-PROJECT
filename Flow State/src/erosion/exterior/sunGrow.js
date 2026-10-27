// MODEL (exterior erosion): the mass grows towards the sun. The reverse of the wind erosion (windErode.js): it adds material
// where the wind took it away. No scene or DOM code.
//
// The grown mass is a dilation of the original: every point within r of the mass is added, so a roof rises by r and a wall
// moves out by r, rounded at the edges. The dilations for a ladder of radii are worked out once per mass (the ground does not
// count as mass, so it does not swell). As in windErode.js the mass is a height map, so the result is too.
//
// Sunlight sets r. Whenever simulated time passes (see the Sun panel), every roof cell and every wall the sun can see
// collects warmth: the sun's height for a roof, how squarely it faces the wall for a wall. Shadows from the site's buildings
// and from the mass itself are traced. The warmer a roof, the higher it grows; the warmer a wall, the further it grows
// outwards into the air beside it. Growth only ever increases, and never grows into a neighbouring building.
import { distance3d, tick } from "./windErode.js";

const LEVELS = 8; // dilations between "none" and the largest radius
const FULL_HOURS = 800; // hours of full, square-on sunlight for a surface to reach the largest radius
const MIN_DROP = 0.3; // metres: a neighbour this much lower makes a cell's side a wall the sun can fall on
const MAX_RAY = 500; // metres a shadow ray is followed
const RAY_STEP = 1.5; // metres
const INF = 1e20;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// form: the shared form (form.js). The sun grows the shape it has now, whatever the wind or the traffic made of it.
// `cityHeight(x, z)`: the height of the site's buildings (they shade the form and block its growth).
export async function createSunGrowth(form, { cityHeight = () => 0, cityTop = 0 } = {}) {
  const { nx, nz, cx: cu, cz: cv, x0: u0, z0: v0 } = form;
  const h0 = Float32Array.from(form.heights); // the shape this growth starts from
  const cy = (cu + cv) / 2;
  const top = h0.reduce((m, h) => Math.max(m, h), 0);
  if (top <= 0) return null;
  const rMax = clamp(0.2 * Math.min(nx * cu, nz * cv), 2, 10); // metres: the most a surface grows
  const rVox = rMax / cy;
  const pad = Math.ceil(rVox) + 2;
  const nxp = nx + 2 * pad, nzp = nz + 2 * pad, below = pad, nyp = below + Math.ceil(top / cy) + pad;
  const voxel = (i, j, l) => (l * nzp + j) * nxp + i;
  const cells = nx * nz;

  // Distance from every voxel to the mass (the ground is not mass).
  const dist = new Float32Array(nxp * nzp * nyp).fill(INF);
  for (let l = below; l < nyp; l++) {
    const y = (l - below + 0.5) * cy;
    for (let gj = 0; gj < nz; gj++) {
      for (let gi = 0; gi < nx; gi++) if (y <= h0[gj * nx + gi]) dist[voxel(gi + pad, gj + pad, l)] = 0;
    }
  }
  await tick();
  distance3d(dist, nxp, nzp, nyp);
  await tick();

  // Height of the grown mass in every column, for each radius.
  const topLayer0 = new Int32Array(cells);
  for (let k = 0; k < cells; k++) topLayer0[k] = h0[k] > 0.5 * cy ? Math.floor(h0[k] / cy - 0.5) + below : below - 1;
  const levels = [h0];
  for (let n = 1; n <= LEVELS; n++) {
    const reach = (((n * rVox) / LEVELS) + 0.5) ** 2;
    const heights = new Float32Array(cells);
    for (let gj = 0; gj < nz; gj++) {
      for (let gi = 0; gi < nx; gi++) {
        const col = gj * nx + gi;
        let l = nyp - 1;
        while (l > topLayer0[col] && dist[voxel(gi + pad, gj + pad, l)] > reach) l--;
        heights[col] = l > topLayer0[col] ? h0[col] + (l - topLayer0[col]) * cy : h0[col];
      }
    }
    levels.push(heights);
    await tick();
  }

  // The sides of each cell the sun can fall on: the directions (of 4) in which the neighbour is lower.
  const solid = [], walls = [];
  for (let gj = 0; gj < nz; gj++) {
    for (let gi = 0; gi < nx; gi++) {
      const col = gj * nx + gi;
      if (h0[col] <= 0.5) continue;
      solid.push(col);
      walls.push(DIRS.filter(([di, dj]) => {
        const i = gi + di, j = gj + dj;
        return (i < 0 || j < 0 || i >= nx || j >= nz ? 0 : h0[j * nx + i]) < h0[col] - MIN_DROP;
      }));
    }
  }
  // Columns beside the mass that a neighbouring building occupies: nothing grows there.
  const blocked = new Uint8Array(cells);
  for (let gj = 0; gj < nz; gj++) {
    for (let gi = 0; gi < nx; gi++) {
      if (h0[gj * nx + gi] <= 0.5 && cityHeight(u0 + (gi + 0.5) * cu, v0 + (gj + 0.5) * cv) > 0.5) blocked[gj * nx + gi] = 1;
    }
  }

  const er = { rMax, growth: 0 };
  const roof = new Float32Array(cells), wall = new Float32Array(cells); // 0..1: warmth collected by each column's roof and walls
  let dirty = false;
  let grownCells = 0;

  // What shades a point: the mass as placed, else the site's buildings.
  const shadeHeight = (x, z) => {
    const i = Math.floor((x - u0) / cu), j = Math.floor((z - v0) / cv);
    if (i >= 0 && j >= 0 && i < nx && j < nz && h0[j * nx + i] > 0) return h0[j * nx + i];
    return cityHeight(x, z);
  };
  const ceiling = Math.max(top, cityTop);
  const lit = (x, y, z, s) => {
    for (let t = RAY_STEP; t <= MAX_RAY; t += RAY_STEP) {
      const py = y + s.y * t;
      if (py > ceiling) return true;
      if (shadeHeight(x + s.x * t, z + s.z * t) > py) return false;
    }
    return true;
  };

  // The sun is in direction `sun` (world unit vector, y up) for `hours` of simulated time, at `rate` times the usual strength.
  er.expose = (sun, hours, rate) => {
    if (sun.y <= 0.02) return;
    const gain = (hours * rate) / FULL_HOURS, flat = Math.hypot(sun.x, sun.z);
    const toward = flat > 1e-6 ? [sun.x / flat, sun.z / flat] : [0, 0];
    for (let e = 0; e < solid.length; e++) {
      const col = solid[e], gi = col % nx, gj = (col - gi) / nx;
      const x = u0 + (gi + 0.5) * cu, z = v0 + (gj + 0.5) * cv, h = h0[col];
      if (roof[col] < 1 && lit(x, h + 0.05, z, sun)) { roof[col] = Math.min(1, roof[col] + sun.y * gain); dirty = true; }
      for (const [di, dj] of walls[e]) {
        const facing = flat * (di * toward[0] + dj * toward[1]); // how squarely the wall faces the sun
        if (facing <= 0 || wall[col] >= 1) continue;
        const i = gi + di, j = gj + dj, low = i < 0 || j < 0 || i >= nx || j >= nz ? 0 : h0[j * nx + i];
        if (lit(x + di * (0.5 * cu + 0.3), (h + low) / 2, z + dj * (0.5 * cv + 0.3), sun)) {
          wall[col] = Math.min(1, wall[col] + facing * gain);
          dirty = true;
        }
      }
    }
  };

  // Max filter or box blur along one axis of the plan grid.
  const spread = (src, radius, horizontal, mode) => {
    const dst = new Float32Array(cells), n = horizontal ? nx : nz, lines = horizontal ? nz : nx, r = horizontal ? radius[0] : radius[1];
    for (let line = 0; line < lines; line++) {
      for (let q = 0; q < n; q++) {
        let acc = 0;
        const a = Math.max(0, q - r), b = Math.min(n - 1, q + r);
        for (let t = a; t <= b; t++) {
          const v = src[horizontal ? line * nx + t : t * nx + line];
          acc = mode === "max" ? Math.max(acc, v) : acc + v;
        }
        dst[horizontal ? line * nx + q : q * nx + line] = mode === "max" ? acc : acc / (b - a + 1);
      }
    }
    return dst;
  };

  // Call every so often: grows the mass where the warmth has grown. Says whether the shape changed.
  er.recompute = () => {
    if (!dirty) return false;
    dirty = false;
    const reach = [Math.max(1, Math.round(rMax / cu)), Math.max(1, Math.round(rMax / cv))];
    const soft = [Math.max(1, reach[0] >> 2), Math.max(1, reach[1] >> 2)];
    const smooth = (a) => {
      for (let pass = 0; pass < 2; pass++) a = spread(spread(a, soft, true, "mean"), soft, false, "mean");
      return a;
    };
    const roofs = smooth(roof);
    // The warmth of the walls reaches outwards into the air beside them, by as much as the walls can grow.
    const sides = smooth(spread(spread(wall, reach, true, "max"), reach, false, "max"));
    grownCells = 0;
    let most = 0;
    for (let col = 0; col < cells; col++) {
      if (blocked[col]) continue;
      const warmth = clamp(h0[col] > 0 ? roofs[col] : sides[col], 0, 1), at = warmth * LEVELS, n = Math.min(LEVELS - 1, Math.floor(at));
      const h = levels[n][col] + (levels[n + 1][col] - levels[n][col]) * (at - n);
      form.heights[col] = Math.max(form.heights[col], h); // growth only increases
      form.heat[col] = Math.max(form.heat[col], warmth);
      if (form.heights[col] > h0[col] + 0.02) grownCells++;
      most = Math.max(most, form.heights[col] - h0[col]);
    }
    er.growth = most;
    form.top = Math.max(form.top, top + most);
    form.version++;
    return true;
  };

  er.changed = () => grownCells > 0;
  return er;
}
