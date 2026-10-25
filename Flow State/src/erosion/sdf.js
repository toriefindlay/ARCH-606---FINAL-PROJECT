// Signed-distance primitives for building cuts (negative inside, positive outside, in metres).
// Shared so both sides describe volumes the same way. Add new primitives here via review.

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Ball centred on c ({x, y, z}).
export const sphere = (c, r) => (x, y, z) => Math.hypot(x - c.x, y - c.y, z - c.z) - r;

// Tube of radius r from a to b with rounded ends: the natural shape for a pathway.
export const capsule = (a, b, r) => {
  const bx = b.x - a.x, by = b.y - a.y, bz = b.z - a.z;
  const len2 = bx * bx + by * by + bz * bz || 1e-9;
  return (x, y, z) => {
    const px = x - a.x, py = y - a.y, pz = z - a.z;
    const h = clamp((px * bx + py * by + pz * bz) / len2, 0, 1);
    return Math.hypot(px - bx * h, py - by * h, pz - bz * h) - r;
  };
};

// Axis-aligned box from min to max ({x, y, z} each).
export const box = (min, max) => {
  const cx = (min.x + max.x) / 2, cy = (min.y + max.y) / 2, cz = (min.z + max.z) / 2;
  const hx = (max.x - min.x) / 2, hy = (max.y - min.y) / 2, hz = (max.z - min.z) / 2;
  return (x, y, z) => {
    const qx = Math.abs(x - cx) - hx, qy = Math.abs(y - cy) - hy, qz = Math.abs(z - cz) - hz;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
  };
};

// Combine volumes: union removes all of them, intersect only where they overlap.
export const union = (...fns) => (x, y, z) => Math.min(...fns.map((f) => f(x, y, z)));
export const intersect = (...fns) => (x, y, z) => Math.max(...fns.map((f) => f(x, y, z)));
