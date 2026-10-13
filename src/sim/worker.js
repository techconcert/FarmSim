// Simulation worker: owns the authoritative World and runs the fixed-step systems off the main thread. The main thread asks for
// ticks with a spare snapshot buffer; the worker runs them, fills the buffer (see snapshot.js) and transfers it back.
import { createWorld, setAnimalCount, setFarmerCount, initialSeed, snapshotPrev, advanceClock } from '../ecs/world.js';
import { buildHash } from '../ecs/spatialHash.js';
import { START_HOUR, DAY_LENGTH_SEC } from '../config.js';
import { updateAnimals } from './animals.js';
import { updateTasks } from './tasks.js';
import { updateFarmers } from './farmers.js';
import { updateTrucks, spawnTruck } from './trucks.js';
import { snapshotLayout, writeSnapshot } from './snapshot.js';
import { createAnimalPool } from './parallel.js';

let W = null, layout = null, dt = 1 / 30, dayCycle = true, pool = null;
function tick() {
  snapshotPrev(W);
  advanceClock(W, dt);
  if (!dayCycle) W.hour = 12;
  buildHash(W.hash, W.a_px, W.a_pz, W.animalCount);
  const t0 = performance.now();
  if (pool && pool.ready) pool.updateAnimals(W, dt); else updateAnimals(W, dt);
  const ms = performance.now() - t0; W.simAnimalsMs = W.simAnimalsMs ? W.simAnimalsMs + (ms - W.simAnimalsMs) * 0.05 : ms;
  updateTasks(W, dt);
  updateFarmers(W, dt);
  updateTrucks(W, dt);
}
function reply(id, buf, extra) {
  const s = writeSnapshot(W, layout, buf);
  postMessage({ t: 'snap', id, buf, s, extra }, [buf]);
}

onmessage = (ev) => {
  const m = ev.data;
  try {
    switch (m.t) {
      case 'init':
        dt = m.dt;
        W = createWorld({ seed: m.seed });
        setAnimalCount(W, m.animals); setFarmerCount(W, m.farmers); initialSeed(W);
        pool = createAnimalPool(W, m.seed, m.threads | 0);   // shares W's arrays first, so the layout below sees the final ones
        layout = snapshotLayout(W);
        postMessage({ t: 'ready' });
        break;
      case 'step': {   // run n ticks (n may be 0: just refresh the snapshot after a command)
        if (m.dayCycle !== undefined) dayCycle = m.dayCycle;
        const t0 = performance.now();
        for (let i = 0; i < m.n; i++) tick();
        if (m.n > 0) { const ms = (performance.now() - t0) / m.n; W.simTickMs = W.simTickMs ? W.simTickMs + (ms - W.simTickMs) * 0.1 : ms; }
        W.simThreads = pool && pool.ready ? pool.threads + 1 : 1;
        reply(m.id, m.buf, m.n);
        break;
      }
      case 'cmd': {
        let r = null;
        if (m.op === 'animals') setAnimalCount(W, m.v);
        else if (m.op === 'farmers') setFarmerCount(W, m.v);
        else if (m.op === 'hour') { const h = m.v; W.time = (W.day * 24 + ((h - START_HOUR + 24) % 24)) * DAY_LENGTH_SEC / 24; W.hour = h; }
        else if (m.op === 'truck') r = spawnTruck(W, m.v | 0);
        postMessage({ t: 'cmd', id: m.id, r });
        break;
      }
    }
  } catch (e) {
    postMessage({ t: 'error', msg: (e && (e.stack || e.message)) || String(e) });
  }
};
