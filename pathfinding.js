/* The computational model. Coordinates are grid cells, not metres.
   This file works in a browser and in Node for the optional checks. */
(function (root) {
  const WIDTH = 37, HEIGHT = 25;
  const rooms = [
    { name: 'Studio', x1: 1, x2: 11, y1: 1, y2: 9, wall: 10, door: 3, target: [6, 5] },
    { name: 'Meeting', x1: 13, x2: 23, y1: 1, y2: 9, wall: 10, door: 15, target: [18, 5] },
    { name: 'Library', x1: 25, x2: 35, y1: 1, y2: 9, wall: 10, door: 27, target: [30, 5] },
    { name: 'Workshop', x1: 1, x2: 17, y1: 15, y2: 23, wall: 14, door: 3, target: [9, 19] },
    { name: 'Gallery', x1: 19, x2: 35, y1: 15, y2: 23, wall: 14, door: 21, target: [27, 19] }
  ];
  const entrance = [0, 12];
  const key = (x, y) => y * WIDTH + x;
  function makeGrid(doors) {
    const grid = Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(false));
    // Three-cell-wide central corridor, five room interiors, and one door each.
    for (let y = 11; y <= 13; y++) for (let x = 1; x < WIDTH - 1; x++) grid[y][x] = true;
    rooms.forEach((r, i) => {
      for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) grid[y][x] = true;
      grid[r.wall][doors[i]] = true;
    });
    grid[12][0] = true;
    return grid;
  }
  function astar(grid, start, goal) {
    // A*: f = distance travelled (g) + Manhattan estimate to destination (h).
    // Only four neighbours are allowed: paths cannot cut diagonally through walls.
    const valid = (x, y) => !!grid[y]?.[x];
    if (!valid(...start) || !valid(...goal)) return null;
    const startKey = key(...start), goalKey = key(...goal);
    const open = [startKey], cost = new Map([[startKey, 0]]), previous = new Map();
    const h = id => Math.abs(id % WIDTH - goal[0]) + Math.abs(Math.floor(id / WIDTH) - goal[1]);
    while (open.length) {
      open.sort((a, b) => cost.get(a) + h(a) - cost.get(b) - h(b));
      const current = open.shift();
      if (current === goalKey) {
        const path = [current];
        while (previous.has(path[0])) path.unshift(previous.get(path[0]));
        return path.map(id => [id % WIDTH, Math.floor(id / WIDTH)]);
      }
      const x = current % WIDTH, y = Math.floor(current / WIDTH);
      for (const [nx, ny] of [[x + 1, y], [x, y + 1], [x - 1, y], [x, y - 1]]) {
        if (!valid(nx, ny)) continue;
        const next = key(nx, ny), newCost = cost.get(current) + 1;
        if (newCost < (cost.get(next) ?? Infinity)) {
          cost.set(next, newCost); previous.set(next, current);
          if (!open.includes(next)) open.push(next);
        }
      }
    }
    return null;
  }
  const model = { WIDTH, HEIGHT, rooms, entrance, key, makeGrid, astar };
  if (typeof module !== 'undefined') module.exports = model;
  else root.Circulation = model;
})(typeof window !== 'undefined' ? window : globalThis);
