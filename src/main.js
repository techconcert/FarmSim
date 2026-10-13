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
const W = createWorld({ seed: 1337 });
setAnimalCount(W, DEFAULT_ANIMALS);
setFarmerCount(W, DEFAULT_FARMERS);
initialSeed(W);
const env = createEnvironment(G, W);
const units = createUnitRenderer(G, W);
const trucks = createTruckRenderer(G, W);
const orbit = createOrbit(canvas, G);
ctx.orbit = orbit;

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
  setAnimalCount(n) { setAnimalCount(W, Math.max(0, n | 0)); },
  setFarmerCount(n) { setFarmerCount(W, Math.max(0, n | 0)); },
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
farm.units = units;   // STRESS-HARNESS HOOK: lets stress.html toggle adaptive LOD and read LOD distance
for (const m of errors) { farm.error = m; farm.errors.push(m); }

let last = performance.now(), fpsEma = 60, msEma = 16, frames = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const raw = Math.max(0, (now - last) / 1000); last = now;
  const dt = Math.min(raw, 0.25);
  if (raw > 0) { fpsEma += (Math.min(1 / raw, 240) - fpsEma) * 0.08; msEma += (raw * 1000 - msEma) * 0.08; }
  try {
    G.resize();
    const t0 = performance.now();   // STRESS-HARNESS HOOK: t0/t1/t2 split CPU time into sim and render (read by stress.html)
    let steps = 0;
    if (!ctx.paused) {
      ctx.acc += dt * ctx.speed;
      const maxSteps = MAX_STEPS_PER_FRAME;
      while (ctx.acc >= SIM_DT && steps < maxSteps) { ctx.tick(); ctx.acc -= SIM_DT; steps++; }
      if (steps === maxSteps) ctx.acc = 0;
    }
    const t1 = performance.now();
    env.update(W, dt);
    units.update(W, Math.min(1, ctx.acc / SIM_DT));
    trucks.update(W, Math.min(1, ctx.acc / SIM_DT));
    orbit.update(dt);
    G.render();
    frames++;
    const s = farm.stats;
    const t2 = performance.now(); s.simMs = t1 - t0; s.renderMs = t2 - t1; s.simSteps = steps;
    s.fps = fpsEma; s.frameMs = msEma; s.frames = frames;
    farm.refresh(false);
    hud.update(s, now);
    if (!farm.ready) farm.ready = true;
  } catch (e) { reportError(e); try { G.render(); } catch (_) {} }
}
requestAnimationFrame(frame);
