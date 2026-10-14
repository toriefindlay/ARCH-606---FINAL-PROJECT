// Independent breadth-first search verifies that A* returns shortest legal routes.
const assert = require('node:assert/strict');
const { WIDTH, rooms, entrance, makeGrid, astar } = require('./pathfinding.js');
function bfs(grid, end) {
  const queue = [[...entrance, 0]], seen = new Set([entrance.join(',')]);
  for (let i = 0; i < queue.length; i++) {
    const [x, y, d] = queue[i]; if (x === end[0] && y === end[1]) return d;
    for (const [nx, ny] of [[x+1,y],[x-1,y],[x,y+1],[x,y-1]]) {
      const id = `${nx},${ny}`;
      if (grid[ny]?.[nx] && !seen.has(id)) { seen.add(id); queue.push([nx,ny,d+1]); }
    }
  }
  return null;
}
let checked = 0;
rooms.forEach((room, index) => {
  for (let door = room.x1; door <= room.x2; door++) {
    const doors = rooms.map(r => r.door); doors[index] = door;
    const grid = makeGrid(doors);
    for (const r of rooms) {
      const path = astar(grid, entrance, r.target);
      assert.ok(path); assert.equal(path.length - 1, bfs(grid, r.target));
      path.forEach(([x,y], i) => { assert.ok(grid[y][x]); if(i) assert.equal(Math.abs(x-path[i-1][0])+Math.abs(y-path[i-1][1]),1); });
      checked++;
    }
  }
});
const blocked = makeGrid(rooms.map(r => r.door)); blocked[10][3] = false;
assert.equal(astar(blocked, entrance, rooms[0].target), null);
const normal = makeGrid(rooms.map(r => r.door));
assert.deepEqual(astar(normal, entrance, entrance), [entrance]);
assert.equal(astar(normal, [0,0], entrance), null);
const shifted = rooms.map(r=>r.door); shifted[2] = 35;
assert.ok(astar(makeGrid(shifted), entrance, rooms[2].target).length > astar(normal, entrance, rooms[2].target).length);
console.log(`Passed: ${checked} routes checked against BFS, wall/adjacency checks, unreachable and same-cell cases, and before/after route change.`);
