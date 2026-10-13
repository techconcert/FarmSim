// Parallel animal update (simulation worker side). Animals never leave their pen and every neighbour query in the per-animal
// loop stays inside the pen, so species can be split across threads: this thread (the coordinator) and K helper workers each
// run animalsStep for their own species on a World whose typed arrays live in SharedArrayBuffers. Item spawns from helpers
// (eggs, manure) are queued and applied here, and the per-species tallies are merged before animalsEnd, which stays single-threaded.
// Needs SharedArrayBuffer (a cross-origin isolated page: serve.py sends COOP / COEP); otherwise createAnimalPool returns null.
import { SPECIES_COUNT, ItemKind } from '../config.js';
import { spawnItem } from '../ecs/world.js';
import { animalsStep, animalsEnd, animalTallies, initAnimalsState } from './animals.js';

const NS = SPECIES_COUNT, QCAP = 4096, MANURE_CAP = 40;
const SC_DT = 0, SC_TICK = 1, SC_NA = 2, SC_NF = 3, SC_HOUR = 4;

// move every typed array of W (and of W.hash) into SharedArrayBuffer memory, keeping contents
function share(obj) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (!ArrayBuffer.isView(v) || v.buffer instanceof SharedArrayBuffer) continue;
    const s = new v.constructor(new SharedArrayBuffer(v.byteLength));
    s.set(v); obj[k] = s;
  }
}

export function createAnimalPool(W, seed, threads) {
  if (!(threads > 0) || typeof SharedArrayBuffer === 'undefined' || !globalThis.crossOriginIsolated) return null;
  share(W); share(W.hash);
  // species -> thread (0 = coordinator), greedy by live count so threads get similar animal totals
  const bins = threads + 1, load = new Float64Array(bins), owner = new Int8Array(NS);
  const order = [...Array(NS).keys()].sort((a, b) => W.speciesCount[b] - W.speciesCount[a]);
  for (const s of order) { let b = 0; for (let k = 1; k < bins; k++) if (load[k] < load[b]) b = k; owner[s] = b; load[b] += Math.max(1, W.speciesCount[s]); }
  const masks = []; for (let b = 0; b < bins; b++) { const m = new Uint8Array(NS); for (let s = 0; s < NS; s++) m[s] = owner[s] === b ? 1 : 0; masks.push(m); }

  const ctrl = new Int32Array(new SharedArrayBuffer(8));                 // [0] generation, [1] helpers done
  const sc = new Float64Array(new SharedArrayBuffer(8 * 8));             // per-tick scalars for helpers
  const tallies = new Int32Array(new SharedArrayBuffer(4 * 5 * NS));     // tCnt, tReady, tSick, tEat, tDrink per species
  const queues = [];
  const arrays = {}; for (const k of Object.keys(W)) if (ArrayBuffer.isView(W[k])) arrays[k] = W[k];
  const H = W.hash, hash = { cell: H.cell, half: H.half, dim: H.dim, cellStart: H.cellStart, items: H.items, cellOf: H.cellOf, _cnt: H._cnt };
  const pool = { ready: false, threads, workers: [], masks };
  let readyN = 0;
  for (let k = 1; k <= threads; k++) {
    const q = new Float32Array(new SharedArrayBuffer(4 * (1 + QCAP * 6)));   // [0] count, then (kind, x, y, z, pen, -) per spawn
    queues.push(q);
    const w = new Worker(new URL('./animalWorker.js', import.meta.url), { type: 'module' });
    w.onmessage = (ev) => { if (ev.data.t === 'ready' && ++readyN === threads) pool.ready = true; else if (ev.data.t === 'error') pool.error = ev.data.msg; };
    w.postMessage({ t: 'init', arrays, hash, ctrl, sc, tallies, queue: q, mask: masks[k], seed: (seed * 2654435761 + k * 40503) >>> 0 });
    pool.workers.push(w);
  }

  const { tCnt, tReady, tSick, tEat, tDrink } = animalTallies;
  pool.updateAnimals = (W, dt) => {
    initAnimalsState(W);
    sc[SC_DT] = dt; sc[SC_TICK] = W.tick; sc[SC_NA] = W.animalCount; sc[SC_NF] = W.farmerCount; sc[SC_HOUR] = W.hour;
    Atomics.store(ctrl, 1, 0);
    Atomics.add(ctrl, 0, 1); Atomics.notify(ctrl, 0);
    animalsStep(W, dt, masks[0]);                                         // the coordinator's own share
    let d; while ((d = Atomics.load(ctrl, 1)) < threads) Atomics.wait(ctrl, 1, d);
    for (let s = 0; s < NS; s++) {
      if (owner[s] === 0) continue;
      tCnt[s] = tallies[s]; tReady[s] = tallies[NS + s]; tSick[s] = tallies[2 * NS + s]; tEat[s] = tallies[3 * NS + s]; tDrink[s] = tallies[4 * NS + s];
    }
    for (const q of queues) {
      const n = q[0];
      for (let i = 0; i < n; i++) {
        const o = 1 + i * 6, kind = q[o], pen = q[o + 4];
        if (kind === ItemKind.MANURE && W.pen_manure[pen] >= MANURE_CAP) continue;
        spawnItem(W, kind, q[o + 1], q[o + 2], q[o + 3], pen);
      }
      q[0] = 0;
    }
    animalsEnd(W, dt);
  };
  return pool;
}
