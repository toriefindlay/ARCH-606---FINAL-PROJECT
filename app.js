/* Interface + animation. Read pathfinding.js first for the grid and A* model. */
const { WIDTH, HEIGHT, rooms, entrance, key, makeGrid, astar } = Circulation;
const $ = id => document.getElementById(id);
const TOTAL = 60, CELL = 24;
let doors = rooms.map(r => r.door), grid = makeGrid(doors);
let heat = Array(WIDTH * HEIGHT).fill(0), agents = [], paths = [];
let running = false, paused = false, finished = false, spawned = 0, arrived = 0;
let spawnClock = 0, baseline = null, meanDistance = 0, lastTime = null;
const destinationInputs = rooms.map((r, i) => {
  const label = document.createElement('label');
  const input = document.createElement('input'); input.type = 'checkbox'; input.checked = true;
  input.onchange = () => { clearRun(); say('Destinations changed. Run a new trip batch.'); };
  label.append(input, document.createTextNode(r.name)); $('destinations').append(label);
  $('room').add(new Option(r.name, i));
  return input;
});
const selected = () => destinationInputs.flatMap((input, i) => input.checked ? [i] : []);
const say = text => $('status').textContent = text;
function controls() {
  destinationInputs.forEach(input => input.disabled = running || !!baseline);
  $('run').disabled = running || !selected().length;
  $('pause').disabled = !running;
  $('save').disabled = !finished || !!baseline;
  $('edit').disabled = running; $('room').disabled = running || !$('edit').checked;
  $('door').disabled = running || !$('edit').checked;
  $('reset').disabled = running;
  $('pause').textContent = paused ? 'Resume' : 'Pause';
  $('discard').hidden = !baseline;
}
function clearRun() {
  running = paused = finished = false; spawned = arrived = 0;
  heat.fill(0); agents = []; paths = []; meanDistance = 0; spawnClock = 0;
  controls(); metrics(); draw();
}
function metrics() {
  $('arrivals').textContent = `${arrived} / ${TOTAL}`;
  $('distance').textContent = paths.length ? `${meanDistance.toFixed(1)} steps` : '—';
  $('peak').textContent = Math.max(...heat);
  if (baseline) {
    $('comparisonText').textContent = finished
      ? `Same 60 trips · Before: ${baseline.mean.toFixed(1)} steps/trip. After: ${meanDistance.toFixed(1)} steps/trip. Change: ${(meanDistance - baseline.mean).toFixed(1)} steps/trip. Peak visits: ${Math.max(...baseline.heat)} → ${Math.max(...heat)}. The entrance is shared by every trip.`
      : `Before saved: ${baseline.mean.toFixed(1)} steps/trip. Move a door and finish a new run to compare. Destinations are locked to keep the trips identical.`;
  } else $('comparisonText').textContent = 'Save a completed run to hold its layout and heatmap here.';
}
function run() {
  clearRun();
  const choices = selected();
  if (!choices.length) return;
  // Deterministic round-robin demand makes before/after comparisons repeatable.
  paths = Array.from({ length: TOTAL }, (_, i) => astar(grid, entrance, rooms[choices[i % choices.length]].target));
  if (paths.some(path => !path)) { clearRun(); say('A destination cannot be reached. Restore the layout.'); return; }
  meanDistance = paths.reduce((sum, p) => sum + p.length - 1, 0) / TOTAL;
  running = true; $('edit').checked = false; controls(); metrics();
  say('Running 60 one-way trips. Darker cells accumulate more visits.');
}
function changeDoor(index, x) {
  if (running || !$('edit').checked) return;
  const room = rooms[index];
  doors[index] = Math.max(room.x1, Math.min(room.x2, x));
  grid = makeGrid(doors); clearRun(); syncSlider();
  say(`${room.name} door moved. Current traffic cleared; the saved “before” stays available.`);
}
function syncSlider() {
  const i = Number($('room').value), r = rooms[i];
  $('door').min = r.x1; $('door').max = r.x2; $('door').value = doors[i];
  $('layoutLabel').textContent = doors.every((d, i) => d === rooms[i].door) ? 'Original doors' : 'Modified doors';
}
$('run').onclick = run;
$('pause').onclick = () => { paused = !paused; controls(); say(paused ? 'Paused. Resume to continue or clear the current run.' : 'Simulation resumed.'); };
$('clear').onclick = () => { clearRun(); say('Current run cleared. Ready for another batch.'); };
$('save').onclick = () => {
  baseline = { doors: [...doors], heat: [...heat], mean: meanDistance };
  $('before').hidden = false; controls(); metrics(); draw();
  say('Before saved. Turn on door editing, move a door, then run again.');
};
$('discard').onclick = () => { baseline = null; $('before').hidden = true; controls(); metrics(); draw(); };
$('edit').onchange = () => { controls(); draw(); };
$('room').onchange = syncSlider;
$('door').oninput = () => changeDoor(Number($('room').value), Number($('door').value));
$('reset').onclick = () => { doors = rooms.map(r => r.door); grid = makeGrid(doors); clearRun(); syncSlider(); say('Original door locations restored.'); };
$('heat').onchange = draw; $('routes').onchange = draw;
$('plan').onclick = event => {
  if (!$('edit').checked || running) return;
  const rect = $('plan').getBoundingClientRect();
  const x = Math.floor((event.clientX - rect.left) / rect.width * WIDTH);
  const y = Math.floor((event.clientY - rect.top) / rect.height * HEIGHT);
  const i = rooms.findIndex(r => y === r.wall && x >= r.x1 && x <= r.x2);
  if (i >= 0) { $('room').value = i; changeDoor(i, x); }
  else say('Click a highlighted horizontal wall between a room and the corridor.');
};
function paint(canvas, layout, visits, showAgents) {
  const ctx = canvas.getContext('2d'), cells = makeGrid(layout);
  const maximum = Math.max(1, ...heat, ...(baseline ? baseline.heat : []));
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    ctx.fillStyle = cells[y][x] ? (y >= 11 && y <= 13 ? '#e6ede4' : '#f2f3eb') : '#344e48';
    ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    if (cells[y][x]) {
      ctx.strokeStyle = '#dce3d8'; ctx.lineWidth = .4; ctx.strokeRect(x * CELL, y * CELL, CELL, CELL);
      const count = visits[key(x, y)];
      if ($('heat').checked && count) {
        ctx.fillStyle = `hsla(${46 - count / maximum * 42}, 85%, 52%, ${.22 + count / maximum * .63})`;
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }
  }
  if (showAgents && $('edit').checked) {
    ctx.fillStyle = '#d8bd76';
    rooms.forEach(r => ctx.fillRect(r.x1 * CELL, r.wall * CELL + 9, (r.x2 - r.x1 + 1) * CELL, 6));
  }
  rooms.forEach((r, i) => {
    ctx.fillStyle = '#63af95'; ctx.fillRect(layout[i] * CELL, r.wall * CELL, CELL, CELL);
    ctx.fillStyle = '#264d43'; ctx.textAlign = 'center'; ctx.font = 'bold 18px Arial';
    ctx.fillText(r.name, (r.x1 + r.x2 + 1) / 2 * CELL, (r.y1 + 1.5) * CELL);
    ctx.beginPath(); ctx.arc((r.target[0] + .5) * CELL, (r.target[1] + .5) * CELL, 5, 0, Math.PI * 2); ctx.strokeStyle = '#55796a'; ctx.lineWidth = 2; ctx.stroke();
  });
  ctx.textAlign = 'left'; ctx.font = '12px Arial'; ctx.fillStyle = '#243f37';
  ctx.fillText('IN →', 4, 12 * CELL + 16);
  ctx.textAlign = 'right'; ctx.fillText('CENTRAL CORRIDOR', 35 * CELL, 13 * CELL + 18);
  if (showAgents && $('routes').checked) {
    paths.slice(0, selected().length).forEach(path => {
      ctx.beginPath(); path.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo']((x + .5) * CELL, (y + .5) * CELL));
      ctx.strokeStyle = '#386f8a88'; ctx.lineWidth = 3; ctx.stroke();
    });
  }
  if (showAgents) agents.forEach(agent => {
    const i = Math.floor(agent.progress), t = agent.progress - i;
    const a = agent.path[i], b = agent.path[Math.min(i + 1, agent.path.length - 1)];
    ctx.beginPath(); ctx.arc((a[0] + (b[0] - a[0]) * t + .5) * CELL, (a[1] + (b[1] - a[1]) * t + .5) * CELL, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#204e47'; ctx.fill(); ctx.strokeStyle = '#fffef8'; ctx.lineWidth = 1.5; ctx.stroke();
  });
}
function draw() { paint($('plan'), doors, heat, true); if (baseline) paint($('before'), baseline.doors, baseline.heat, false); }
function frame(time) {
  const dt = lastTime === null ? 0 : Math.min((time - lastTime) / 1000, .1); lastTime = time;
  if (running && !paused) {
    const speed = Number($('speed').value);
    spawnClock += dt * speed;
    while (spawnClock >= 1 && spawned < TOTAL) {
      agents.push({ path: paths[spawned++], progress: 0 }); heat[key(...entrance)]++; spawnClock--;
    }
    agents = agents.filter(agent => {
      const oldCell = Math.floor(agent.progress);
      agent.progress = Math.min(agent.progress + dt * speed, agent.path.length - 1);
      // Count each cell entry once, independent of frame rate and animation speed.
      for (let i = oldCell + 1; i <= Math.floor(agent.progress); i++) heat[key(...agent.path[i])]++;
      if (agent.progress === agent.path.length - 1) { arrived++; return false; }
      return true;
    });
    if (arrived === TOTAL) { running = false; finished = true; controls(); say('Run complete. Save this as “before”, or edit the layout and compare another run.'); }
    metrics(); draw();
  }
  requestAnimationFrame(frame);
}
syncSlider(); controls(); draw(); requestAnimationFrame(frame);
