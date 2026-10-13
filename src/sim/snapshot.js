// World snapshots for the simulation worker: every typed array the renderer, HUD or QA hooks read, packed into one
// ArrayBuffer that is transferred (not copied) between the worker and the main thread, plus the plain scalar state.
// No DOM, no WebGL; runs in a worker and under Node.
import { MAX_ANIMALS, MAX_FARMERS, MAX_ITEMS, MAX_TASKS } from '../config.js';

const SKIP = new Set(['hash', '_an', 'rand', '_freeItems', '_freeTasks']);   // sim-private state the main thread never reads

// Layout of every typed array in W (top level and W.stats), in a fixed order. Animal and farmer arrays are copied only up to
// the live count (scaled by their per-entity width, e.g. f_route has ROUTE_MAX * 2 floats per farmer), item and task arrays
// up to their high-water mark.
const CAP = { a_: MAX_ANIMALS, f_: MAX_FARMERS, i_: MAX_ITEMS, t_: MAX_TASKS };
const live = (W, key) => (key.startsWith('a_') ? W.animalCount : key.startsWith('f_') ? W.farmerCount : key.startsWith('i_') ? W.itemHigh : W.taskHigh);
export function snapshotLayout(W) {
  const entries = [];
  let off = 0;
  const add = (obj, key, path) => {
    const v = obj[key];
    if (!ArrayBuffer.isView(v)) return;
    off = (off + 7) & ~7;
    const cap = CAP[key.slice(0, 2)], per = cap ? v.length / cap : 0;
    entries.push({ path, key, ctor: v.constructor, length: v.length, offset: off, per });
    off += v.byteLength;
  };
  for (const k of Object.keys(W)) if (!SKIP.has(k)) add(W, k, null);
  for (const k of Object.keys(W.stats)) add(W.stats, k, 'stats');
  return { entries, bytes: (off + 7) & ~7 };
}

// worker side: copy W's arrays into buf (an ArrayBuffer of layout.bytes) and return the scalar state
export function writeSnapshot(W, layout, buf) {
  for (const e of layout.entries) {
    const src = e.path ? W[e.path][e.key] : W[e.key];
    const n = e.per ? Math.min(e.length, Math.ceil(e.per * live(W, e.key))) : e.length;
    new e.ctor(buf, e.offset, n).set(n === e.length ? src : src.subarray(0, n));
  }
  const sc = {}, st = {};
  for (const k of Object.keys(W)) { const v = W[k]; if (typeof v === 'number' || typeof v === 'boolean') sc[k] = v; }
  for (const k of Object.keys(W.stats)) { const v = W.stats[k]; if (typeof v === 'number') st[k] = v; }
  return { sc, st, truck: W.truck ? { ...W.truck } : null };
}

// main side: point W's arrays at views into buf and apply the scalars (W is the main thread's long-lived view object)
export function readSnapshot(W, layout, buf, s) {
  for (const e of layout.entries) {
    const v = new e.ctor(buf, e.offset, e.length);
    if (e.path) W[e.path][e.key] = v; else W[e.key] = v;
  }
  Object.assign(W, s.sc); Object.assign(W.stats, s.st);
  if (s.truck) W.truck = Object.assign(W.truck || {}, s.truck);
}
