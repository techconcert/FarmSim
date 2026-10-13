// App entry: wires engine, sim systems, renderers, camera, HUD and QA hooks.
import { createGL } from './render/gl.js';
import { createWorld, setAnimalCount, setFarmerCount, initialSeed, snapshotPrev, advanceClock } from './ecs/world.js';
import { buildHash } from './ecs/spatialHash.js';
import { SIM_DT, MAX_STEPS_PER_FRAME, DEFAULT_ANIMALS, DEFAULT_FARMERS } from './config.js';
import { updateAnimals } from './sim/animals.js';
import { updateTasks } from './sim/tasks.js';
import { updateFarmers } from './sim/farmers.js';
import { updateTrucks } from './sim/trucks.js';
import { createUnitRenderer } from './render/units.js';
import { createEnvironment } from './render/environment.js';
import { createTruckRenderer } from './render/trucks.js';
import { createOrbit } from './render/camera.js';
import { createHud } from './ui/hud.js';
import { installQA } from './qa.js';
import { snapshotLayout, readSnapshot } from './sim/snapshot.js';

const canvas = document.getElementById('c');
const errors = [];
let farm = null;
const ctx = { paused: false, speed: 1, dayCycle: true, acc: 0 };
function reportError(err) {
  const msg = (err && (err.stack || err.message)) || String(err);
  if (errors.length >= 20) return;
  errors.push(msg);
  console.error('[farm]', msg);
  if (farm) { farm.error = msg; farm.errors.push(msg); }
  ctx.paused = true;
  showFatal(msg);
}
// On-screen error panel so startup failures are visible without a devtools console (e.g. Safari).
function showFatal(msg) {
  try {
    let box = document.getElementById('fatal');
    if (!box) {
      box = document.createElement('pre');
      box.id = 'fatal';
      box.style.cssText = 'position:fixed;left:12px;right:12px;top:12px;max-height:60vh;overflow:auto;z-index:99;margin:0;padding:12px;background:rgba(40,0,0,.92);color:#ffd6d6;font:12px/1.4 Menlo,monospace;border-radius:8px;white-space:pre-wrap';
      document.body.appendChild(box);
    }
    box.textContent = 'Farm failed to start (please send this text):\n\n' + msg;
  } catch (_) { /* ignore */ }
}
window.addEventListener('error', e => reportError(e.error || e.message));
window.addEventListener('unhandledrejection', e => reportError(e.reason));

const G = createGL(canvas); G.resize();
const SEED = 1337;
// The simulation runs in a module worker (src/sim/worker.js) so frame time is max(sim, render) instead of their sum.
// ?worker=0 runs it on the main thread as before (debugging, or browsers without module workers).
const QS = new URLSearchParams(location.search);
const USE_WORKER = typeof Worker !== 'undefined' && QS.get('worker') !== '0';
// Extra threads for the animal update inside the worker (src/sim/parallel.js; needs a cross-origin isolated page, see serve.py).
// ?threads=N overrides, ?threads=0 keeps it single-threaded.
const ANIMAL_THREADS = QS.has('threads') ? Math.max(0, QS.get('threads') | 0) : Math.max(0, Math.min(3, (navigator.hardwareConcurrency || 2) - 3));
// W is the renderer's view of the world. In worker mode it starts as an identical local copy (same seed and set-up as the
// worker) and its arrays are then re-pointed at each snapshot the worker sends back.
const W = createWorld({ seed: SEED });
setAnimalCount(W, DEFAULT_ANIMALS);
setFarmerCount(W, DEFAULT_FARMERS);
initialSeed(W);
const env = createEnvironment(G, W);
const units = createUnitRenderer(G, W);
const trucks = createTruckRenderer(G, W);
const orbit = createOrbit(canvas, G);
ctx.orbit = orbit;

// ---- simulation worker client: two snapshot buffers ping-pong between threads (one being filled, one being drawn)
const sim = USE_WORKER ? createSimClient() : null;
function createSimClient() {
  const layout = snapshotLayout(W);
  const worker = new Worker(new URL('./sim/worker.js', import.meta.url), { type: 'module' });
  const c = { busy: true, spare: new ArrayBuffer(layout.bytes), back: new ArrayBuffer(layout.bytes), refresh: false, queue: [], cmds: new Map(), waiters: [], nextId: 1, onSnap: null };
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.t === 'ready') { c.busy = false; c.refresh = true; }
    else if (m.t === 'snap') {
      readSnapshot(W, layout, m.buf, m.s);           // W now draws from m.buf; the buffer it drew from before becomes the spare
      c.spare = c.back; c.back = m.buf; c.busy = false;
      if (c.onSnap) c.onSnap(m);
      if (c.waiters.length) { const w = c.waiters; c.waiters = []; for (const f of w) f(); }
    } else if (m.t === 'cmd') {
      // a command settles once a snapshot taken after it is in W (asked for right away when the worker is idle)
      const r = c.cmds.get(m.id); c.cmds.delete(m.id);
      if (r) c.waiters.push(() => r(m.r));
      if (!c.busy) c.step(0); else c.refresh = true;
    }
    else if (m.t === 'error') reportError(m.msg);
  };
  worker.onerror = e => reportError(e.message || 'simulation worker failed');
  worker.postMessage({ t: 'init', seed: SEED, animals: DEFAULT_ANIMALS, farmers: DEFAULT_FARMERS, dt: SIM_DT, threads: ANIMAL_THREADS });
  c.cmd = (op, v) => new Promise(res => { const id = c.nextId++; c.cmds.set(id, res); worker.postMessage({ t: 'cmd', op, v, id }); });
  // ask for n ticks if the worker is idle; returns false while a previous request is still running
  c.step = (n) => {
    if (c.busy) return false;
    const buf = c.spare; c.spare = null; c.busy = true; c.refresh = false;
    worker.postMessage({ t: 'step', n, buf, dayCycle: ctx.dayCycle }, [buf]);
    return true;
  };
  // QA: run n ticks as one request (works while paused); resolves after the resulting snapshot is in W
  c.stepN = (n) => new Promise(res => c.queue.push({ n, res }));
  c.pump = () => {
    if (c.busy || !c.queue.length) return false;
    const q = c.queue.shift();
    const prev = c.onSnap;
    c.onSnap = () => { c.onSnap = prev; q.res(q.n); };
    return c.step(q.n);
  };
  return c;
}

Object.assign(ctx, {
  G, W,
  tick() {
    snapshotPrev(W);
    advanceClock(W, SIM_DT);
    if (!ctx.dayCycle) W.hour = 12;
    buildHash(W.hash, W.a_px, W.a_pz, W.animalCount);
    updateAnimals(W, SIM_DT);
    updateTasks(W, SIM_DT);
    updateFarmers(W, SIM_DT);
    updateTrucks(W, SIM_DT);
  },
  setAnimalCount(n) { n = Math.max(0, n | 0); if (sim) return sim.cmd('animals', n); setAnimalCount(W, n); },
  setFarmerCount(n) { n = Math.max(0, n | 0); if (sim) return sim.cmd('farmers', n); setFarmerCount(W, n); },
  // worker mode only (qa.js falls back to acting on W directly when these are absent)
  ...(sim ? {
    setHour(h) { return sim.cmd('hour', h); },
    spawnTruck(type) { return sim.cmd('truck', type); },
    stepSim(n) { return sim.stepN(n); },
  } : {}),
  setSpeed(x) { ctx.speed = x; hud.state.speed !== x && hud.setSpeed(x); },
  setPaused(p) { ctx.paused = !!p; if (hud.state.paused !== !!p) hud.setPaused(!!p); },
});
const hud = createHud({
  onPause: p => { ctx.paused = p; },
  onSpeed: s => { ctx.speed = s; },
  onAnimalCount: n => ctx.setAnimalCount(n),
  onFarmerCount: n => ctx.setFarmerCount(n),
  onDayCycle: on => { ctx.dayCycle = on; },
  onResetCamera: () => orbit.reset(),
});
farm = installQA(ctx);
for (const m of errors) { farm.error = m; farm.errors.push(m); }

let last = performance.now(), fpsEma = 60, msEma = 16, frames = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const raw = Math.max(0, (now - last) / 1000); last = now;
  const dt = Math.min(raw, 0.25);
  if (raw > 0) { fpsEma += (Math.min(1 / raw, 240) - fpsEma) * 0.08; msEma += (raw * 1000 - msEma) * 0.08; }
  try {
    G.resize();
    if (sim) {
      // worker: request the due ticks as one batch whenever the worker is idle; the latest snapshot is drawn meanwhile
      if (!sim.pump()) {
        let steps = 0;
        if (!ctx.paused) {
          ctx.acc += dt * ctx.speed;
          steps = Math.min(MAX_STEPS_PER_FRAME, Math.floor(ctx.acc / SIM_DT));
          if (ctx.acc > MAX_STEPS_PER_FRAME * SIM_DT) ctx.acc = MAX_STEPS_PER_FRAME * SIM_DT;   // worker behind: drop time like the inline cap
        }
        if ((steps > 0 || sim.refresh) && sim.step(steps)) ctx.acc -= steps * SIM_DT;
      }
    } else if (!ctx.paused) {
      ctx.acc += dt * ctx.speed;
      let steps = 0;
      const maxSteps = MAX_STEPS_PER_FRAME;
      while (ctx.acc >= SIM_DT && steps < maxSteps) { ctx.tick(); ctx.acc -= SIM_DT; steps++; }
      if (steps === maxSteps) ctx.acc = 0;
    }
    env.update(W, dt);
    units.update(W, Math.min(1, ctx.acc / SIM_DT));
    trucks.update(W, Math.min(1, ctx.acc / SIM_DT));
    orbit.update(dt);
    G.render();
    frames++;
    const s = farm.stats;
    s.fps = fpsEma; s.frameMs = msEma; s.frames = frames;
    farm.refresh(false);
    hud.update(s, now);
    if (!farm.ready) farm.ready = true;
  } catch (e) { reportError(e); try { G.render(); } catch (_) {} }
}
requestAnimationFrame(frame);
