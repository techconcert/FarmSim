// DOM HUD. createHud(handlers) -> { update(stats), setState(partial) }. Refreshes DOM at ~4 Hz.
import { SPECIES, SPECIES_COUNT, SLIDER_MAX_ANIMALS, SLIDER_MAX_FARMERS, DEFAULT_ANIMALS, DEFAULT_FARMERS } from '../config.js';

const SPEEDS = [0.5, 1, 2, 4, 8];
const TASK_NAMES = ['Feed', 'Water', 'Eggs', 'Milk', 'Shear', 'Clean', 'Treat'];
const FTYPES = ['Feeder', 'Collector', 'Cleaner', 'Vet'];
const FSTATES = ['idle', 'move', 'pickup', 'work', 'dropoff', 'wander', 'lean', 'rest'];
const cap = s => s[0].toUpperCase() + s.slice(1);

export function createHud(handlers = {}) {
  const root = document.getElementById('hud');
  root.innerHTML = `
  <div class="panel" id="hud-stats">
    <div class="clock"><b id="h-clock">08:00</b><span id="h-day">Day 1</span></div>
    <div class="row"><span>FPS</span><span id="h-fps">--</span></div>
    <div class="row"><span>Frame</span><span id="h-ms">--</span></div>
    <div class="row"><span>Draw calls / tris</span><span id="h-draw">--</span></div>
    <div class="sep"></div>
    <h3>Animals <span id="h-animals" style="color:var(--fg)"></span></h3>
    <div class="grid2" id="h-species"></div>
    <div class="sep"></div>
    <h3>Farmers <span id="h-farmers" style="color:var(--fg)"></span></h3>
    <div class="grid2" id="h-ftypes"></div>
    <div class="row hide-sm" style="margin-top:4px"><span>States</span><span id="h-fstates" style="font-size:10px;text-align:right"></span></div>
    <div class="sep"></div>
    <h3>Tasks</h3>
    <div class="row"><span>Open</span><span id="h-open">0</span></div>
    <div class="row"><span>Done / created</span><span id="h-done">0 / 0</span></div>
    <div class="grid2 hide-sm" id="h-tasks" style="margin-top:3px"></div>
    <div class="row" style="margin-top:3px"><span>Items in world</span><span id="h-items">0</span></div>
    <div class="row"><span>Delivered</span><span id="h-deliv">0</span></div>
    <div class="sep"></div>
    <h3>Trucks</h3>
    <div class="row"><span>On farm / visits</span><span id="h-trk">0 / 0</span></div>
    <div class="row"><span>Stock (egg/milk/wool)</span><span id="h-trkv">0 / 0 / 0</span></div>
    <div class="row"><span>Goods shipped</span><span id="h-trks">0</span></div>
  </div>
  <div class="panel" id="hud-ctrl">
    <h3>Simulation</h3>
    <div class="ctl"><div class="btns" id="c-speed"><button id="c-pause" title="Space">Pause</button></div></div>
    <div class="ctl"><label>Animals <output id="c-an-v">${DEFAULT_ANIMALS}</output></label><input id="c-an" type="range" min="0" max="${SLIDER_MAX_ANIMALS}" step="250" value="${DEFAULT_ANIMALS}"></div>
    <div class="ctl"><label>Farmers <output id="c-fa-v">${DEFAULT_FARMERS}</output></label><input id="c-fa" type="range" min="4" max="${SLIDER_MAX_FARMERS}" step="1" value="${DEFAULT_FARMERS}"></div>
    <label class="chk"><input id="c-day" type="checkbox" checked> Day / night cycle</label>
    <button id="c-cam">Reset camera</button>
  </div>
  <div class="panel" id="hud-help"><kbd>Drag</kbd> orbit &middot; <kbd>Right-drag</kbd>/<kbd>WASD</kbd> pan &middot; <kbd>Wheel</kbd> zoom &middot; <kbd>Q</kbd>/<kbd>E</kbd> rotate &middot; <kbd>Space</kbd> pause &middot; <kbd>+</kbd>/<kbd>-</kbd> speed</div>`;
  const $ = id => document.getElementById(id);
  const el = {
    clock: $('h-clock'), day: $('h-day'), fps: $('h-fps'), ms: $('h-ms'), draw: $('h-draw'),
    animals: $('h-animals'), species: $('h-species'), farmers: $('h-farmers'), ftypes: $('h-ftypes'), fstates: $('h-fstates'),
    open: $('h-open'), done: $('h-done'), tasks: $('h-tasks'), items: $('h-items'), deliv: $('h-deliv'), trk: $('h-trk'), trkv: $('h-trkv'), trks: $('h-trks'),
    pause: $('c-pause'), speed: $('c-speed'), an: $('c-an'), anV: $('c-an-v'), fa: $('c-fa'), faV: $('c-fa-v'), day2: $('c-day'), cam: $('c-cam'),
  };
  // static rows
  const mk = (parent, n) => { const out = []; for (let i = 0; i < n; i++) { const d = document.createElement('div'); d.className = 'row'; d.innerHTML = '<span></span><span>0</span>'; parent.appendChild(d); out.push(d); } return out; };
  const spRows = mk(el.species, SPECIES_COUNT); spRows.forEach((r, i) => r.firstChild.textContent = cap(SPECIES[i].name));
  const ftRows = mk(el.ftypes, 4); ftRows.forEach((r, i) => r.firstChild.textContent = FTYPES[i]);
  const tkRows = mk(el.tasks, 7); tkRows.forEach((r, i) => r.firstChild.textContent = TASK_NAMES[i]);

  const state = { paused: false, speed: 1 };
  const speedBtns = SPEEDS.map(s => {
    const b = document.createElement('button'); b.textContent = s + 'x'; b.onclick = () => setSpeed(s); el.speed.appendChild(b); return b;
  });
  function paintSpeed() { speedBtns.forEach((b, i) => b.classList.toggle('on', SPEEDS[i] === state.speed)); el.pause.classList.toggle('on', state.paused); el.pause.textContent = state.paused ? 'Resume' : 'Pause'; }
  function setPaused(p) { state.paused = p; paintSpeed(); handlers.onPause && handlers.onPause(p); }
  function setSpeed(s) { state.speed = s; paintSpeed(); handlers.onSpeed && handlers.onSpeed(s); }
  el.pause.onclick = () => setPaused(!state.paused);
  let t1 = 0, t2 = 0;
  el.an.oninput = () => { el.anV.textContent = el.an.value; clearTimeout(t1); t1 = setTimeout(() => handlers.onAnimalCount && handlers.onAnimalCount(+el.an.value), 200); };
  el.fa.oninput = () => { el.faV.textContent = el.fa.value; clearTimeout(t2); t2 = setTimeout(() => handlers.onFarmerCount && handlers.onFarmerCount(+el.fa.value), 200); };
  el.day2.onchange = () => handlers.onDayCycle && handlers.onDayCycle(el.day2.checked);
  el.cam.onclick = () => handlers.onResetCamera && handlers.onResetCamera();
  window.addEventListener('keydown', e => {
    if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'range' && e.code === 'Space') e.preventDefault();
    if (e.code === 'Space') { e.preventDefault(); setPaused(!state.paused); }
    else if (e.key === '+' || e.key === '=') { const i = SPEEDS.indexOf(state.speed); if (i < SPEEDS.length - 1) setSpeed(SPEEDS[i + 1]); }
    else if (e.key === '-' || e.key === '_') { const i = SPEEDS.indexOf(state.speed); if (i > 0) setSpeed(SPEEDS[i - 1]); }
    else if (e.code === 'KeyR') handlers.onResetCamera && handlers.onResetCamera();
  });
  paintSpeed();

  let last = 0;
  const sum = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
  function update(s, now = performance.now()) {
    if (now - last < 250) return;
    last = now;
    const hh = Math.floor(s.hour), mm = Math.floor((s.hour - hh) * 60);
    el.clock.textContent = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
    el.day.textContent = 'Day ' + ((s.day | 0) + 1);
    el.fps.textContent = s.fps.toFixed(0);
    el.fps.className = s.fps >= 50 ? 'fps-good' : s.fps >= 25 ? 'fps-mid' : 'fps-bad';
    el.ms.textContent = s.frameMs.toFixed(1) + ' ms';
    el.draw.textContent = s.drawCalls + ' / ' + (s.triangles >= 1e6 ? (s.triangles / 1e6).toFixed(2) + 'M' : (s.triangles / 1e3).toFixed(0) + 'k');
    el.animals.textContent = s.animals;
    for (let i = 0; i < SPECIES_COUNT; i++) spRows[i].lastChild.textContent = s.speciesCounts[i];
    el.farmers.textContent = s.farmers;
    for (let i = 0; i < 4; i++) ftRows[i].lastChild.textContent = s.farmerTypes[i];
    let fs = '';
    for (let i = 0; i < 8; i++) if (s.farmerStates[i]) fs += (fs ? ' ' : '') + FSTATES[i] + ' ' + s.farmerStates[i];
    el.fstates.textContent = fs;
    el.open.textContent = s.tasksOpen;
    el.done.textContent = sum(s.tasksDone) + ' / ' + sum(s.tasksCreated);
    for (let i = 0; i < 7; i++) tkRows[i].lastChild.textContent = s.tasksDone[i];
    el.items.textContent = s.items;
    el.deliv.textContent = sum(s.delivered);
    el.trk.textContent = (s.trucks | 0) + ' / ' + (s.trucksVisited | 0);
    el.trkv.textContent = s.truckStock ? s.truckStock.join(' / ') : '0';
    el.trks.textContent = s.shipped ? sum(s.shipped) : 0;
  }
  return { update, setPaused, setSpeed, state };
}
