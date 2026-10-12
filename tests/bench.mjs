// Sim bench: ms per tick (whole sim tick: snapshot + clock + hash rebuild + animals + tasks + farmers + trucks) at N animals / M farmers.
// usage: node tests/bench.mjs [quick]      (full: 2k/5k/10k animals x 40/100/200 farmers, 100 s warm-up, 30 s measured)
// Target: mean <= 6 ms per tick at 10000 animals / 200 farmers (a 1/30 s tick; the app runs 1 tick per 2 frames at 60 fps).
import { createWorld, setAnimalCount, setFarmerCount, initialSeed, snapshotPrev, advanceClock } from '../src/ecs/world.js';
import { buildHash } from '../src/ecs/spatialHash.js';
import { SIM_DT } from '../src/config.js';
import { updateAnimals } from '../src/sim/animals.js';
import { updateTasks } from '../src/sim/tasks.js';
import { updateFarmers } from '../src/sim/farmers.js';
import { updateTrucks } from '../src/sim/trucks.js';

const quick = process.argv.includes('quick');
const cases = quick ? [[3000, 40], [10000, 200]]
  : [[2000, 40], [2000, 100], [2000, 200], [5000, 40], [5000, 100], [5000, 200], [10000, 40], [10000, 100], [10000, 200]];
const WARM_S = quick ? 30 : 100, MEAS_S = quick ? 10 : 30;
function run(na, nf) {
  const W = createWorld({ seed: 4242 });
  setAnimalCount(W, na); setFarmerCount(W, nf); initialSeed(W);
  const t = { hash: 0, animals: 0, other: 0, max: 0, all: [] };
  const tick = (m) => {
    const t0 = performance.now();
    snapshotPrev(W); advanceClock(W, SIM_DT); buildHash(W.hash, W.a_px, W.a_pz, W.animalCount);
    const t1 = performance.now(); updateAnimals(W, SIM_DT); const t2 = performance.now();
    updateTasks(W, SIM_DT); updateFarmers(W, SIM_DT); updateTrucks(W, SIM_DT); const t3 = performance.now();
    if (m) { t.hash += t1 - t0; t.animals += t2 - t1; t.other += t3 - t2; if (t3 - t0 > t.max) t.max = t3 - t0; t.all.push(t3 - t0); }
  };
  for (let i = 0; i < WARM_S / SIM_DT; i++) tick(false);
  const n = Math.round(MEAS_S / SIM_DT);
  for (let i = 0; i < n; i++) tick(true);
  t.all.sort((x, y) => x - y);
  const f = v => (v / n).toFixed(2);
  return { na, nf, hash: f(t.hash), animals: f(t.animals), other: f(t.other), total: f(t.hash + t.animals + t.other), p99: t.all[Math.floor(t.all.length * 0.99)].toFixed(2), max: t.max.toFixed(2) };
}
console.log('animals farmers | snapshot+hash | updateAnimals | tasks+farmers+trucks | TOTAL mean | p99 | max   (ms per 1/30 s tick, warm ' + WARM_S + ' s, measured ' + MEAS_S + ' s)');
for (const [na, nf] of cases) {
  const r = run(na, nf);
  console.log(`${String(r.na).padStart(6)} ${String(r.nf).padStart(4)} | ${r.hash.padStart(6)} | ${r.animals.padStart(7)} | ${r.other.padStart(7)} | ${r.total.padStart(7)} | ${r.p99.padStart(6)} | ${r.max.padStart(6)}`);
}
