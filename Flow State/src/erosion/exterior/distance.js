// MODEL (exterior erosion): the exact distance transform used by the wind tunnels' cut and the skin. No scene or DOM code.
const INF = 1e20;

/* ---------- distance transform ---------- */

// Squared distance to the nearest zero, along one line (Felzenszwalb & Huttenlocher).
function line1d(f, d, n, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// In place: `grid` holds 0 at the sites and a huge number elsewhere; afterwards the squared distance (in cells) to the nearest site.
export function distance3d(grid, nx, nz, ny) {
  const m = Math.max(nx, nz, ny);
  const f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  const pass = (n, stride, count, start) => {
    for (let c = 0; c < count; c++) {
      const base = start(c);
      for (let q = 0; q < n; q++) f[q] = grid[base + q * stride];
      line1d(f, d, n, v, z);
      for (let q = 0; q < n; q++) grid[base + q * stride] = d[q];
    }
  };
  pass(nx, 1, nz * ny, (c) => c * nx);
  pass(nz, nx, nx * ny, (c) => (Math.floor(c / nx) * nz) * nx + (c % nx));
  pass(ny, nx * nz, nx * nz, (c) => c);
}
