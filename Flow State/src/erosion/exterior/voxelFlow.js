// MODEL (exterior erosion): the mass as a 3D voxel grid, and the air flowing through and around it. No scene or DOM code.
//
// Why voxels: the form (form.js) is a height map, which cannot hold a tunnel. Wind tunnels are overhangs, so the mass needs a
// volume that can have voxels switched from solid to air. This file is that volume plus a solver that says how fast the air
// moves in every open voxel; later steps erode the voxels where the air is fastest and re-solve.
//
// The flow is an incompressible, irrotational ("potential") flow: velocity = gradient of a potential phi, with laplace(phi) = 0
// in the air. The far boundary of the box (the four sides and the top) holds the potential of the free stream, so the wind
// can come from any direction. Solid voxels and the ground are walls: no air goes through them. Air is forced round or
// through whatever is in its way and speeds up where it is squeezed, which is the effect the tunnels rely on. It has no
// turbulence, wake or friction, so it is a good judge of *where* the air accelerates, not of the exact speed.
//
// Everything is in world metres (x east, y up, z south) so it lines up with the form and the site's buildings.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const tick = () => new Promise((r) => setTimeout(r, 0)); // lets the page breathe between the heavy steps

export const AIR = 0, MASS = 1, CONTEXT = 2; // what a voxel holds

/* ---------- the voxel mass ---------- */

// form: the shared form (form.js). cityHeight: (x, z) => metres, the site's buildings (windFlow.js cityHeights), or null.
// The box reaches a good way past the mass on every side and above it, so the free stream can be held at its edge.
// Returns null if the form has no mass.
// storey: a floor-to-floor height in metres; if given, the voxel height is made a whole fraction of it (2 to 6 layers a storey) so
// that every floor lies on a voxel layer.
export function createVoxelMass(form, { cityHeight = null, maxCells = 250000, storey = 0 } = {}) {
  const { nx: fnx, nz: fnz, cx, cz, x0: fx0, z0: fz0, h0 } = form;
  let i0 = fnx, i1 = -1, j0 = fnz, j1 = -1;
  for (let j = 0; j < fnz; j++) {
    for (let i = 0; i < fnx; i++) {
      if (h0[j * fnx + i] <= 0.5) continue;
      i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j);
    }
  }
  if (i1 < 0) return null;
  const top = Math.max(form.top, h0.reduce((m, h) => Math.max(m, h), 0));
  const mx0 = fx0 + i0 * cx, mx1 = fx0 + (i1 + 1) * cx, mz0 = fz0 + j0 * cz, mz1 = fz0 + (j1 + 1) * cz;

  const pad = clamp(Math.max(mx1 - mx0, mz1 - mz0, top), 12, 80); // metres of air round the mass
  const Lx = mx1 - mx0 + 2 * pad, Lz = mz1 - mz0 + 2 * pad, Ly = top + clamp(1.5 * top, 10, 60);
  let c = clamp(Math.cbrt((Lx * Lz * Ly) / maxCells), 0.5, 4); // metres: one voxel
  if (storey > 0) c = storey / clamp(Math.round(storey / c), 2, 6);
  const nx = Math.ceil(Lx / c), nz = Math.ceil(Lz / c), ny = Math.ceil(Ly / c);
  const x0 = (mx0 + mx1) / 2 - (nx * c) / 2, z0 = (mz0 + mz1) / 2 - (nz * c) / 2; // the box's corner; the ground is y = 0
  const nxz = nx * nz;

  const vox = {
    nx, nz, ny, c, x0, z0, top,
    cells: new Uint8Array(nxz * ny), // AIR | MASS | CONTEXT
    version: 0, // changes whenever a voxel does
    index: (i, j, l) => (l * nz + j) * nx + i,
    centre: (i, j, l) => [x0 + (i + 0.5) * c, (l + 0.5) * c, z0 + (j + 0.5) * c],
    // The voxel holding a world point, or -1 outside the box.
    at(x, y, z) {
      const i = Math.floor((x - x0) / c), j = Math.floor((z - z0) / c), l = Math.floor(y / c);
      return i < 0 || j < 0 || l < 0 || i >= nx || j >= nz || l >= ny ? -1 : (l * nz + j) * nx + i;
    },
    // Switches a voxel to air (what a tunnel does) or back.
    set(k, kind) {
      if (vox.cells[k] === kind) return false;
      vox.cells[k] = kind;
      vox.version++;
      return true;
    },
  };

  // Fills the box from the form's height map (the mass) and the site's buildings (the context). Call again after the form changes.
  vox.load = (f = form) => {
    const massH = new Float32Array(nxz), cityH = new Float32Array(nxz);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = x0 + (i + 0.5) * c, z = z0 + (j + 0.5) * c;
        massH[j * nx + i] = f.heightAt(x, z);
        cityH[j * nx + i] = cityHeight ? cityHeight(x, z) : 0;
      }
    }
    for (let l = 0; l < ny; l++) {
      const y = (l + 0.5) * c;
      for (let col = 0; col < nxz; col++) vox.cells[l * nxz + col] = y <= massH[col] ? MASS : y <= cityH[col] ? CONTEXT : AIR;
    }
    // The faces of the box are the free stream: always air.
    for (let l = 0; l < ny; l++) {
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          if (i === 0 || j === 0 || i === nx - 1 || j === nz - 1 || l === ny - 1) vox.cells[(l * nz + j) * nx + i] = AIR;
        }
      }
    }
    vox.version++;
  };

  vox.load(form);
  return vox;
}

/* ---------- the flow ---------- */

// Solves the flow of a free stream of unit speed blowing towards dir = [ux, uz] (world x, z; see downwind() in site/wind.js).
// Resolves with { phi, vx, vy, vz, speed, open, maxSpeed, iterations, converged, dir }: velocity and speed are relative to the
// free stream (1 = as fast as the wind far away). `open` marks the air that the free stream reaches (1); air shut in by solid
// voxels has no flow. `previous` (a result for the same dir and box) warm-starts the solve after a small change to the voxels.
export async function solveFlow(vox, { dir, previous = null, maxIter = 500, omega = 1.85, tol = 2e-4 } = {}) {
  const { nx, nz, ny, c, cells } = vox;
  const nxz = nx * nz, n = nxz * ny;
  const [ux, uz] = dir;
  const fixed = (i, j, l) => i === 0 || j === 0 || i === nx - 1 || j === nz - 1 || l === ny - 1;

  // Air the free stream reaches: flood fill from the faces of the box.
  const open = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let l = 0; l < ny; l++) {
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = (l * nz + j) * nx + i;
        if (fixed(i, j, l) && cells[k] === AIR) { open[k] = 1; queue[tail++] = k; }
      }
    }
  }
  while (head < tail) {
    const k = queue[head++], l = Math.floor(k / nxz), j = Math.floor((k - l * nxz) / nx), i = k - l * nxz - j * nx;
    const visit = (q) => { if (!open[q] && cells[q] === AIR) { open[q] = 1; queue[tail++] = q; } };
    if (i > 0) visit(k - 1);
    if (i < nx - 1) visit(k + 1);
    if (j > 0) visit(k - nx);
    if (j < nz - 1) visit(k + nx);
    if (l > 0) visit(k - nxz);
    if (l < ny - 1) visit(k + nxz);
  }

  // The potential: the free stream's (ux * x + uz * z) everywhere to start with, and held there on the faces of the box.
  const phi = new Float32Array(n);
  const warm = previous && previous.dir[0] === ux && previous.dir[1] === uz && previous.phi.length === n;
  const free = [[], []]; // the cells that are solved, by checkerboard colour (so each half can be updated in place)
  for (let l = 0; l < ny; l++) {
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = (l * nz + j) * nx + i;
        const stream = ux * (vox.x0 + (i + 0.5) * c) + uz * (vox.z0 + (j + 0.5) * c);
        phi[k] = warm && open[k] && !fixed(i, j, l) ? previous.phi[k] : stream;
        if (open[k] && !fixed(i, j, l)) free[(i + j + l) & 1].push(k);
      }
    }
  }
  const sets = free.map((a) => Int32Array.from(a));

  // Successive over-relaxation: each free cell moves towards the mean of its open neighbours. A solid neighbour (or the
  // ground below) is left out, which is what makes it a wall.
  let iterations = 0, residual = Infinity;
  while (iterations < maxIter && residual > tol * c) {
    for (let burst = 0; burst < 20 && iterations < maxIter; burst++, iterations++) {
      residual = 0;
      for (const set of sets) {
        for (let t = 0; t < set.length; t++) {
          const k = set[t];
          let s = 0, m = 0;
          if (open[k - 1]) { s += phi[k - 1]; m++; }
          if (open[k + 1]) { s += phi[k + 1]; m++; }
          if (open[k - nx]) { s += phi[k - nx]; m++; }
          if (open[k + nx]) { s += phi[k + nx]; m++; }
          if (open[k + nxz]) { s += phi[k + nxz]; m++; }
          if (k >= nxz && open[k - nxz]) { s += phi[k - nxz]; m++; }
          if (!m) continue;
          const delta = s / m - phi[k];
          phi[k] += omega * delta;
          const a = Math.abs(delta);
          if (a > residual) residual = a;
        }
      }
    }
    await tick();
  }

  // Velocity = gradient of the potential at the centre of every open voxel. Beside a wall the missing neighbour counts as
  // having the voxel's own potential (no flow through it), the same rule the solver used.
  const vx = new Float32Array(n), vy = new Float32Array(n), vz = new Float32Array(n), speed = new Float32Array(n);
  let maxSpeed = 0;
  for (let l = 0; l < ny; l++) {
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = (l * nz + j) * nx + i;
        if (!open[k]) continue;
        const p = phi[k];
        const nb = (q, ok) => (ok && open[q] ? phi[q] : p);
        vx[k] = (nb(k + 1, i < nx - 1) - nb(k - 1, i > 0)) / (2 * c);
        vz[k] = (nb(k + nx, j < nz - 1) - nb(k - nx, j > 0)) / (2 * c);
        vy[k] = (nb(k + nxz, l < ny - 1) - nb(k - nxz, l > 0)) / (2 * c);
        speed[k] = Math.hypot(vx[k], vy[k], vz[k]);
        if (!fixed(i, j, l) && speed[k] > maxSpeed) maxSpeed = speed[k];
      }
    }
  }
  return { phi, vx, vy, vz, speed, open, maxSpeed, iterations, converged: residual <= tol * c, dir: [ux, uz] };
}
