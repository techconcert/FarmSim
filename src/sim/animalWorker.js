// Helper thread for the parallel animal update (see parallel.js): runs animalsStep for its own species each time the
// coordinator bumps the generation counter, on World arrays shared with it.
import { animalsStep, animalTallies, setItemSpawner } from './animals.js';
import { mulberry32 } from '../ecs/rng.js';
import { SPECIES_COUNT } from '../config.js';

const NS = SPECIES_COUNT;
onmessage = (ev) => {
  const m = ev.data;
  if (m.t !== 'init') return;
  try {
    const { ctrl, sc, tallies, queue, mask } = m;
    const W = Object.assign({}, m.arrays, { hash: m.hash, rand: mulberry32(m.seed), tick: 0, animalCount: 0, farmerCount: 0, hour: 12 });
    const cap = (queue.length - 1) / 6;
    setItemSpawner((_, kind, x, y, z, pen) => {   // deferred: the coordinator allocates the item after this tick's parallel phase
      const n = queue[0]; if (n >= cap) return -1;
      const o = 1 + n * 6; queue[o] = kind; queue[o + 1] = x; queue[o + 2] = y; queue[o + 3] = z; queue[o + 4] = pen; queue[0] = n + 1;
      return -1;
    });
    const { tCnt, tReady, tSick, tEat, tDrink } = animalTallies;
    postMessage({ t: 'ready' });
    let gen = Atomics.load(ctrl, 0);
    for (;;) {
      Atomics.wait(ctrl, 0, gen);
      gen = Atomics.load(ctrl, 0);
      W.tick = sc[1]; W.animalCount = sc[2]; W.farmerCount = sc[3]; W.hour = sc[4];
      animalsStep(W, sc[0], mask);
      for (let s = 0; s < NS; s++) {
        if (!mask[s]) continue;
        tallies[s] = tCnt[s]; tallies[NS + s] = tReady[s]; tallies[2 * NS + s] = tSick[s]; tallies[3 * NS + s] = tEat[s]; tallies[4 * NS + s] = tDrink[s];
      }
      Atomics.add(ctrl, 1, 1); Atomics.notify(ctrl, 1);
    }
  } catch (e) {
    postMessage({ t: 'error', msg: (e && (e.stack || e.message)) || String(e) });
  }
};
