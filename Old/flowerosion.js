/* Exterior traffic particles. Lines are drawn in canvas pixels; motion is computed in metres per second
   and converted with `scale` (metres per pixel), so speeds stay realistic whatever the site size. */
const $ = id => document.getElementById(id);
const canvas = $('site'), ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height, CELL = 8, GW = W / CELL, GH = H / CELL;
const KINDS = {
  road: { width: 7, color: '#8d9094' },   // metres, two lanes
  walk: { width: 3, color: '#dccf9f' }
};
const CAR_LENGTH = 4.5, HEADWAY = 1.5, MIN_GAP = 3;

let scale = 0.5, bg = null, lines = [], people = [], cars = [];
let density = { walk: new Float32Array(GW * GH), road: new Float32Array(GW * GH) };
let tool = null, draft = [], mouse = null, paused = false, simTime = 0, lastTime = null, spawnDebt = new Map();

/* ---------- geometry ---------- */
function makeLine(type, pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  // Turn angle at each interior vertex, used to slow cars into bends.
  const turns = pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return 0;
    const a = Math.atan2(p[1] - pts[i - 1][1], p[0] - pts[i - 1][0]), b = Math.atan2(pts[i + 1][1] - p[1], pts[i + 1][0] - p[0]);
    return Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
  });
  return { type, pts, cum, turns, length: cum[cum.length - 1] };
}
function sample(line, s) {
  s = Math.max(0, Math.min(line.length, s));
  let i = 1; while (i < line.cum.length - 1 && line.cum[i] < s) i++;
  const a = line.pts[i - 1], b = line.pts[i], t = (s - line.cum[i - 1]) / ((line.cum[i] - line.cum[i - 1]) || 1);
  const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1;
  return { x: a[0] + dx * t, y: a[1] + dy * t, tx: dx / d, ty: dy / d };
}
const distToLine = (line, x, y) => {
  let best = Infinity;
  for (let i = 1; i < line.pts.length; i++) {
    const [ax, ay] = line.pts[i - 1], [bx, by] = line.pts[i], dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return best;
};
// Standard normal sample (Box–Muller) for natural variation in speed.
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

/* ---------- particles ---------- */
function newPerson(line, dir) {
  return {
    line, dir, s: dir > 0 ? 0 : line.length, v: Math.max(0.7, 1.4 + gauss() * 0.22),   // walking speed, m/s
    lane: (Math.random() - 0.5) * KINDS.walk.width * 0.7 / scale,                      // px across the path
    wobble: Math.random() * 6.28, wobbleAmp: (0.1 + Math.random() * 0.25) / scale, pause: 0
  };
}
function newCar(line, dir) {
  return { line, dir, s: dir > 0 ? 0 : line.length, v: 0, vDes: Math.max(6, 11 + gauss() * 2) };  // ≈40 km/h
}
function carTargetSpeed(car) {
  // Slow to ~40% of desired speed on a right-angle bend, within 25 m of the vertex.
  let factor = 1;
  const { line } = car;
  for (let i = 1; i < line.pts.length - 1; i++) {
    const away = Math.abs(line.cum[i] - car.s) * scale;
    if (away < 25) factor = Math.min(factor, 1 - 0.6 * Math.min(1, line.turns[i] / (Math.PI / 2)) * (1 - away / 25));
  }
  return car.vDes * factor;
}
function stepPeople(dt) {
  people = people.filter(p => {
    if (p.pause > 0) p.pause -= dt;
    else {
      p.s += p.dir * p.v * dt / scale;
      if (Math.random() < 0.015 * dt) p.pause = 1 + Math.random() * 4;     // stop to look, chat, or check a phone
    }
    p.wobble += dt * 0.9;
    return p.s >= 0 && p.s <= p.line.length;
  });
}
function stepCars(dt) {
  const groups = new Map();
  cars.forEach(c => { const k = c.line.id + ':' + c.dir; (groups.get(k) || groups.set(k, []).get(k)).push(c); });
  groups.forEach(group => {
    group.sort((a, b) => (b.s - a.s) * a.dir);           // front of the queue first
    group.forEach((car, i) => {
      let target = carTargetSpeed(car);
      if (i > 0) {                                        // car-following: keep a time headway behind the leader
        const gap = (group[i - 1].s - car.s) * car.dir * scale - CAR_LENGTH;
        target = Math.min(target, Math.max(0, (gap - MIN_GAP) / HEADWAY));
      }
      car.v += Math.max(-6 * dt, Math.min(2.5 * dt, target - car.v));       // brake ≤6 m/s², accelerate ≤2.5 m/s²
      car.s += car.dir * car.v * dt / scale;
    });
  });
  cars = cars.filter(c => c.s >= 0 && c.s <= c.line.length);
}
function spawn(dt) {
  const rates = { walk: Number($('peopleRate').value), road: Number($('carRate').value) };
  lines.forEach(line => [1, -1].forEach(dir => {
    const k = line.id + ':' + dir;
    // Poisson arrivals: accumulate expected arrivals and release whole ones.
    const debt = (spawnDebt.get(k) || 0) + rates[line.type] / 60 * dt * (0.5 + Math.random());
    let n = Math.floor(debt); spawnDebt.set(k, debt - n);
    for (; n > 0; n--) {
      if (line.type === 'walk') people.push(newPerson(line, dir));
      else {
        const start = dir > 0 ? 0 : line.length;
        const blocked = cars.some(c => c.line === line && c.dir === dir && Math.abs(c.s - start) * scale < CAR_LENGTH + MIN_GAP);
        if (!blocked) cars.push(newCar(line, dir));
      }
    }
  }));
}
function accumulate(dt) {
  const add = (grid, x, y) => {
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) grid[gy * GW + gx] += dt;
  };
  people.forEach(p => { const q = sample(p.line, p.s); add(density.walk, q.x, q.y); });
  cars.forEach(c => { const q = sample(c.line, c.s); add(density.road, q.x, q.y); });
}
function step(dt) {
  spawn(dt); stepPeople(dt); stepCars(dt); accumulate(dt); simTime += dt;
}

/* ---------- drawing ---------- */
const place = (p, kind) => {
  const q = sample(p.line, p.s), hx = q.tx * p.dir, hy = q.ty * p.dir, nx = -hy, ny = hx;   // heading and its right-hand normal
  const off = kind === 'car' ? KINDS.road.width / 4 / scale : p.lane + Math.sin(p.wobble) * p.wobbleAmp;
  return { x: q.x + nx * off, y: q.y + ny * off, hx, hy };
};
function strokeLine(pts, width, color, dash) {
  ctx.beginPath(); pts.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](x, y));
  ctx.setLineDash(dash || []); ctx.lineWidth = width; ctx.strokeStyle = color; ctx.lineJoin = ctx.lineCap = 'round'; ctx.stroke(); ctx.setLineDash([]);
}
function drawDensity() {
  const max = Math.max(1e-6, ...density.walk, ...density.road);
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    const i = gy * GW + gx, w = density.walk[i], r = density.road[i];
    if (!w && !r) continue;
    const t = Math.min(1, Math.sqrt((w + r) / max));            // square root keeps quiet areas visible
    ctx.fillStyle = `hsla(${46 - t * 42}, 85%, 52%, ${0.12 + t * 0.55})`;
    ctx.fillRect(gx * CELL, gy * CELL, CELL, CELL);
  }
}
function draw() {
  ctx.fillStyle = '#f2f3eb'; ctx.fillRect(0, 0, W, H);
  if (bg) {
    const f = Math.min(W / bg.width, H / bg.height);
    ctx.globalAlpha = 0.85; ctx.drawImage(bg, 0, 0, bg.width * f, bg.height * f); ctx.globalAlpha = 1;
  }
  lines.filter(l => l.type === 'road').forEach(l => strokeLine(l.pts, KINDS.road.width / scale, KINDS.road.color));
  lines.filter(l => l.type === 'road').forEach(l => strokeLine(l.pts, 1, '#f2f3eb', [8, 8]));
  lines.filter(l => l.type === 'walk').forEach(l => strokeLine(l.pts, KINDS.walk.width / scale, KINDS.walk.color));
  if ($('showDensity').checked) drawDensity();
  if ($('showCars').checked) cars.forEach(c => {
    const { x, y, hx, hy } = place(c, 'car'), len = Math.max(8, CAR_LENGTH / scale), wid = Math.max(4, 1.8 / scale);
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(hy, hx));
    ctx.fillStyle = '#b5502f'; ctx.strokeStyle = '#fffef8'; ctx.lineWidth = 1;
    ctx.fillRect(-len / 2, -wid / 2, len, wid); ctx.strokeRect(-len / 2, -wid / 2, len, wid); ctx.restore();
  });
  if ($('showPeople').checked) people.forEach(p => {
    const { x, y } = place(p, 'person');
    ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 6.283); ctx.fillStyle = '#204e47'; ctx.fill(); ctx.strokeStyle = '#fffef8'; ctx.lineWidth = 1; ctx.stroke();
  });
  if (draft.length) {
    const pts = mouse ? [...draft, mouse] : draft;
    strokeLine(pts, 2, tool === 'road' ? '#5b5e62' : '#a89452', [6, 4]);
    draft.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 3, 0, 6.283); ctx.fillStyle = '#264d43'; ctx.fill(); });
  }
}

/* ---------- editing ---------- */
let nextId = 1;
function addLine(type, pts) { const l = makeLine(type, pts); l.id = nextId++; lines.push(l); }
function resetParticles() { people = []; cars = []; spawnDebt.clear(); simTime = 0; }
function setTool(t) {
  tool = tool === t ? null : t; draft = [];
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  canvas.classList.toggle('erase', tool === 'erase'); $('finish').disabled = true;
}
function finishDraft() {
  if (draft.length >= 2) { addLine(tool, draft); resetParticles(); }
  draft = []; $('finish').disabled = true;
}
const pointer = e => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H]; };
document.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
canvas.onclick = e => {
  if (!tool) return;
  const p = pointer(e);
  if (tool === 'erase') {
    const hit = lines.map(l => [l, distToLine(l, p[0], p[1])]).filter(([, d]) => d < 12).sort((a, b) => a[1] - b[1])[0];
    if (hit) { lines = lines.filter(l => l !== hit[0]); resetParticles(); }
    return;
  }
  if (e.detail > 1) return;                    // second click of a double-click is handled by ondblclick
  draft.push(p); $('finish').disabled = draft.length < 2;
};
canvas.ondblclick = finishDraft;
canvas.onmousemove = e => {
  mouse = pointer(e);
  $('coords').textContent = `${(mouse[0] * scale).toFixed(0)} m, ${(mouse[1] * scale).toFixed(0)} m`;
};
canvas.onmouseleave = () => { mouse = null; $('coords').textContent = ''; };
addEventListener('keydown', e => {
  if (e.key === 'Escape') { draft = []; $('finish').disabled = true; }
  if (e.key === 'Enter') finishDraft();
});
$('finish').onclick = finishDraft;
$('clearNet').onclick = () => { lines = []; draft = []; resetParticles(); };

function loadSample() {
  lines = []; draft = [];
  const roads = [
    [[0, 330], [320, 320], [640, 340], [960, 325]],
    [[180, 640], [230, 480], [320, 320], [350, 150], [330, 0]]
  ];
  const walks = [
    [[0, 311], [320, 301], [640, 321], [960, 306]], [[0, 349], [320, 339], [640, 359], [960, 344]],
    [[960, 60], [700, 180], [560, 250], [500, 316]], [[0, 120], [200, 200], [320, 300]]
  ];
  roads.forEach(p => addLine('road', p)); walks.forEach(p => addLine('walk', p));
  resetParticles();
}
$('sample').onclick = loadSample;
$('file').onchange = e => {
  const file = e.target.files[0]; if (!file) return;
  const img = new Image(), url = URL.createObjectURL(file);
  img.onload = () => { bg = img; URL.revokeObjectURL(url); };
  img.src = url;
};
function readScale() {
  const metres = Math.max(20, Number($('width').value) || 480);
  scale = metres / W; $('scaleNote').textContent = `${scale.toFixed(2)} m per pixel · site ${metres} × ${(H * scale).toFixed(0)} m`;
  resetParticles();
}
$('width').onchange = readScale;

/* ---------- controls and loop ---------- */
const outputs = () => { $('peopleRateOut').textContent = $('peopleRate').value; $('carRateOut').textContent = $('carRate').value; };
$('peopleRate').oninput = $('carRate').oninput = outputs;
$('pause').onclick = () => { paused = !paused; $('pause').textContent = paused ? 'Resume' : 'Pause'; };
$('reset').onclick = resetParticles;
$('clearDensity').onclick = () => { density.walk.fill(0); density.road.fill(0); };
['showDensity', 'showPeople', 'showCars'].forEach(id => $(id).onchange = draw);

function frame(time) {
  const real = lastTime === null ? 0 : Math.min((time - lastTime) / 1000, 0.1); lastTime = time;
  if (!paused) {
    const sim = real * Number($('speed').value), n = Math.max(1, Math.ceil(sim / 0.1));   // substeps keep fast playback stable
    for (let i = 0; i < n; i++) step(sim / n);
  }
  $('nPeople').textContent = people.length; $('nCars').textContent = cars.length;
  $('clock').textContent = `${Math.floor(simTime / 60)}:${String(Math.floor(simTime % 60)).padStart(2, '0')}`;
  draw(); requestAnimationFrame(frame);
}
outputs(); readScale(); loadSample(); requestAnimationFrame(frame);
