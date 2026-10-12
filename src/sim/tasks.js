// Task generation, stale-task cancellation, and farmer claiming. No DOM, no allocation in update.
import { PENS, SPECIES, PEN_COUNT, ItemKind, TaskType, TaskState, AFlag, FState, FARMER_TASKS, MAX_TASKS } from '../config.js';
import { createTask, cancelTask, isNight } from '../ecs/world.js';
import { offerLoaders } from './trucks.js';

const GEN_INTERVAL = 0.5, CLAIM_INTERVAL = 0.1;

const candReady = new Int32Array(PEN_COUNT), candSick = new Int32Array(PEN_COUNT);
const openList = new Int32Array(MAX_TASKS);
// per-pen product chore: which task a ready animal / egg of pen p creates (from the species' product ItemKind)
const PEN_EGGS = new Uint8Array(PEN_COUNT), PEN_TASK = new Int8Array(PEN_COUNT).fill(-1);   // PEN_TASK: MILK / SHEAR or -1
for (let p = 0; p < PEN_COUNT; p++) {
  const pr = SPECIES[p].produce;
  if (pr === ItemKind.EGG) PEN_EGGS[p] = 1; else if (pr === ItemKind.MILK) PEN_TASK[p] = TaskType.MILK; else if (pr === ItemKind.WOOL) PEN_TASK[p] = TaskType.SHEAR;
}
// claim scratch: per open task precomputed score base, gate position and type bit (no PENS lookups in the O(farmers x open) loop)
const cBit = new Uint32Array(MAX_TASKS), cHelp = new Uint8Array(MAX_TASKS), cBase = new Float32Array(MAX_TASKS), cGX = new Float32Array(MAX_TASKS), cGZ = new Float32Array(MAX_TASKS);
// per FarmerType bitmask of allowed task types and rank-0 mask
const TYPE_MASK = new Uint32Array(4), TYPE_FIRST = new Uint32Array(4);
for (let k = 0; k < 4; k++) {
  let m = 0;
  for (const t of FARMER_TASKS[k]) m |= 1 << t;
  TYPE_MASK[k] = m; TYPE_FIRST[k] = 1 << FARMER_TASKS[k][0];
}

// Neglected FEED/WATER tasks (open >= HELP_AGE s) may be taken by any idle farmer type (barn/well trips are long).
const HELP_AGE = 5, HELP_MASK = (1 << TaskType.FEED) | (1 << TaskType.WATER);

function prioFor(v) { return v < 0.1 ? 3 : v < 0.2 ? 2 : 1; }

// a valid animal target for MILK/SHEAR (READY) or TREAT (SICK) in pen p
export function animalTargetOk(W, a, pen, flag) {
  return a >= 0 && a < W.animalCount && W.a_species[a] === pen &&
    (W.a_flags[a] & flag) !== 0 && (W.a_flags[a] & AFlag.HELD) === 0;
}

function generate(W) {
  const n = W.animalCount, fl = W.a_flags, sp = W.a_species;
  let need = false;
  for (let p = 0; p < PEN_COUNT; p++) if (W.pen_ready[p] > 0 || W.pen_sick[p] > 0) { need = true; break; }
  if (need) {
    candReady.fill(-1); candSick.fill(-1);
    for (let i = 0; i < n; i++) {
      const f = fl[i];
      if ((f & (AFlag.READY | AFlag.SICK)) === 0 || (f & AFlag.HELD)) continue;
      const s = sp[i];
      if ((f & AFlag.READY) && candReady[s] < 0) candReady[s] = i;
      if ((f & AFlag.SICK) && candSick[s] < 0) candSick[s] = i;
    }
  }
  for (let p = 0; p < PEN_COUNT; p++) {
    const food = W.pen_food[p], water = W.pen_water[p];
    if (food < 0.35) createTask(W, TaskType.FEED, p, -1, prioFor(food));
    if (water < 0.35) createTask(W, TaskType.WATER, p, -1, prioFor(water));
    const eggs = W.pen_eggs[p];
    if (PEN_EGGS[p] && eggs >= 4) createTask(W, TaskType.COLLECT_EGGS, p, -1, eggs >= 20 ? 3 : eggs >= 10 ? 2 : 1);
    if (need && W.pen_ready[p] >= 1 && candReady[p] >= 0) {
      if (PEN_TASK[p] >= 0) createTask(W, PEN_TASK[p], p, candReady[p], 1);
    }
    const man = W.pen_manure[p];
    if (man >= 5) createTask(W, TaskType.CLEAN, p, -1, man >= 15 ? 3 : man >= 10 ? 2 : 1);
    if (need && W.pen_sick[p] >= 1 && candSick[p] >= 0) createTask(W, TaskType.TREAT, p, candSick[p], 3);
  }
  // stale cancel + priority refresh for OPEN tasks
  for (let t = 0; t < W.taskHigh; t++) {
    if (!W.t_alive[t]) continue;
    W.t_time[t] += GEN_INTERVAL;
    if (W.t_state[t] !== TaskState.OPEN) continue;
    const p = W.t_pen[t];
    switch (W.t_type[t]) {
      case TaskType.FEED:
        if (W.pen_food[p] >= 0.6) cancelTask(W, t); else W.t_prio[t] = prioFor(W.pen_food[p]);
        break;
      case TaskType.WATER:
        if (W.pen_water[p] >= 0.6) cancelTask(W, t); else W.t_prio[t] = prioFor(W.pen_water[p]);
        break;
      case TaskType.COLLECT_EGGS:
        if (W.pen_eggs[p] < 1) cancelTask(W, t);
        break;
      case TaskType.CLEAN:
        if (W.pen_manure[p] < 1) cancelTask(W, t);
        break;
      case TaskType.MILK: case TaskType.SHEAR: {
        if (animalTargetOk(W, W.t_target[t], p, AFlag.READY)) break;
        if (need && candReady[p] >= 0) W.t_target[t] = candReady[p]; else cancelTask(W, t);
        break;
      }
      case TaskType.TREAT: {
        if (animalTargetOk(W, W.t_target[t], p, AFlag.SICK)) break;
        if (need && candSick[p] >= 0) W.t_target[t] = candSick[p]; else cancelTask(W, t);
        break;
      }
    }
  }
}

function claim(W) {
  const nf = W.farmerCount;
  offerLoaders(W);                          // idle farmers are offered to a truck waiting in the bay first (day or night)
  if (nf === 0 || isNight(W)) return;
  let no = 0;
  for (let t = 0; t < W.taskHigh; t++) {
    if (!W.t_alive[t] || W.t_state[t] !== TaskState.OPEN) continue;
    const bit = 1 << W.t_type[t], age = W.t_time[t], G = PENS[W.t_pen[t]].gateOut;
    openList[no] = t; cBit[no] = bit; cGX[no] = G.x; cGZ[no] = G.z;
    cHelp[no] = (bit & HELP_MASK) !== 0 && age >= HELP_AGE ? 1 : 0;
    cBase[no] = W.t_prio[t] + (age < 120 ? age / 120 : 1) + ((bit & HELP_MASK) ? 2.5 : 0);
    no++;
  }
  if (no === 0) return;
  // O(idle farmers x open tasks); open tasks <= PEN_COUNT x 7 (one per pen and type), so this is bounded (~28k cheap iterations at 200 farmers)
  for (let f = 0; f < nf && no > 0; f++) {
    if (W.f_task[f] >= 0 || W.f_job[f] >= 0) continue;
    const st = W.f_state[f];
    if (st !== FState.IDLE && st !== FState.WANDER && st !== FState.LEAN) continue;
    const ft = W.f_type[f] & 3, mask = TYPE_MASK[ft], first = TYPE_FIRST[ft];
    const fx = W.f_px[f], fz = W.f_pz[f];
    let bestS = -1e9, bestK = -1;
    for (let k = 0; k < no; k++) {
      const bit = cBit[k];
      if ((mask & bit) === 0 && cHelp[k] === 0) continue;
      const dx = cGX[k] - fx, dz = cGZ[k] - fz;
      const score = cBase[k] + ((first & bit) ? 0.5 : 0) - Math.sqrt(dx * dx + dz * dz) * (1 / 220);
      if (score > bestS) { bestS = score; bestK = k; }
    }
    if (bestK < 0) continue;
    const best = openList[bestK];
    W.t_state[best] = TaskState.CLAIMED; W.t_farmer[best] = f;
    W.f_task[f] = best; W.f_step[f] = 0; W.f_target[f] = -1;
    no--;
    openList[bestK] = openList[no]; cBit[bestK] = cBit[no]; cHelp[bestK] = cHelp[no]; cBase[bestK] = cBase[no]; cGX[bestK] = cGX[no]; cGZ[bestK] = cGZ[no];
  }
}

export function updateTasks(W, dt) {
  if (W._tkGen === undefined) { W._tkGen = 0; W._tkClaim = 0; }
  W._tkGen += dt; W._tkClaim += dt;
  if (W._tkGen >= GEN_INTERVAL) { W._tkGen -= GEN_INTERVAL; if (W._tkGen > GEN_INTERVAL) W._tkGen = 0; generate(W); }
  if (W._tkClaim >= CLAIM_INTERVAL) { W._tkClaim = 0; claim(W); }
}
