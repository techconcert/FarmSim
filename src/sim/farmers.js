// Farmer simulation: task scripts, idle behaviours, movement, gates. No DOM, no allocation in update.
//
// f_state (renderer contract):
//   IDLE(0)    standing still (idle or just finished a task)
//   MOVE(1)    walking a task route (carrying f_carry items if > 0)
//   PICKUP(2)  standing, picking something up (barn/well/vet shed/item/storehouse handoff)
//   WORK(3)    working; animation by t_type[f_task]: FEED/WATER pour, CLEAN shovel, MILK/SHEAR crouch, TREAT kneel
//   DROPOFF(4) standing, handing carried items over
//   WANDER(5)  walking with no task (idle stroll / walking to lean spot / walking to bed)
//   LEAN(6)    leaning on the fence, heading faces into the pen
//   REST(7)    sitting at the farmhouse bench (night)
// f_step (task script progress, internal): do not interpret except as below.
//   When f_task<0: f_step is the idle intent: 0 = stroll on road, 1 = going to lean, 2 = going to bed.
//   When f_task>=0 and state is WORK, f_step>0 always.
// f_carry = number of carried items, f_carryKind = ItemKind or 255. Carried items have i_carrier=f, i_slot.
// f_target (idle): pen being leaned on. f_target (task): item/animal index.
import {
  PENS, PEN_COUNT, BUILDINGS, FARMER_SPEED, FARMER_RADIUS, ROUTE_MAX, MAX_FARMERS,
  FState, TaskType, TaskState, ItemKind, ItemState, AState, AFlag, FeatureKind,
} from '../config.js';
import {
  penOf, pushOutOfSolids, spawnItem, despawnItem, setItemState, completeTask, cancelTask, createTask, isNight, terrainHeight,
} from '../ecs/world.js';
import { buildRoute } from './nav.js';
import { animalTargetOk } from './tasks.js';
import { DOOR, setPreemptHook, truckLoadable, loadNeed, reserveLoad, deliverLoad, releaseLoadJob, truckRear } from './trucks.js';

const TWO_PI = Math.PI * 2, PI = Math.PI;
const STRIDE = 1.4, TURN_RATE = 9, SEP_R = 0.7, GATE_RANGE = 3.5, GATE_SPEED = 3;
const MAX_EGGS = 12, MAX_MANURE = 6, JOB_MAX_S = 150;
const LOAD_ITEM = [ItemKind.EGG, ItemKind.MILK, ItemKind.WOOL];

const stuck = new Float32Array(MAX_FARMERS);
const arrTol = new Float32Array(MAX_FARMERS);
const oldX = new Float32Array(MAX_FARMERS), oldZ = new Float32Array(MAX_FARMERS);
const lookX = new Float32Array(MAX_FARMERS), lookZ = new Float32Array(MAX_FARMERS);
const lookOn = new Uint8Array(MAX_FARMERS);
const moving = new Uint8Array(MAX_FARMERS);
const slideT = new Float32Array(MAX_FARMERS), slideDir = new Int8Array(MAX_FARMERS);   // sidestep (seconds left, +-1) when blocked by a pen solid / wall
const _o = new Float32Array(2);
let ARRIVED = false;

// ------------------------------------------------------------------ helpers
function setState(W, f, s) {
  if (W.f_state[f] !== s) { W.f_state[f] = s; W.f_animT[f] = 0; }
}
function go(W, f, x, z, pen, tol, state, jit) {
  if (jit > 0) { x += (W.rand() * 2 - 1) * jit; z += (W.rand() * 2 - 1) * jit; }
  buildRoute(W, f, x, z, pen);
  arrTol[f] = tol; stuck[f] = 0; lookOn[f] = 0;
  setState(W, f, state);
}
function pause(W, f, state, secs, lx, lz) {
  setState(W, f, state);
  W.f_timer[f] = secs; W.f_speed[f] = 0;
  if (lx !== undefined) { lookX[f] = lx; lookZ[f] = lz; lookOn[f] = 1; } else lookOn[f] = 0;
}
function turnTo(W, f, target, dt) {
  let h = W.f_heading[f];
  let d = target - h;
  d -= Math.round(d / TWO_PI) * TWO_PI;
  const m = TURN_RATE * dt;
  h += d > m ? m : d < -m ? -m : d;
  if (h > PI) h -= TWO_PI; else if (h < -PI) h += TWO_PI;
  W.f_heading[f] = h;
}
function setItemSlotCarried(W, i, f, slot) { setItemState(W, i, ItemState.CARRIED, f, slot); }

function giveItem(W, f, kind) {
  const i = spawnItem(W, kind, W.f_px[f], 1.0, W.f_pz[f], -1);
  if (i < 0) return -1;
  setItemSlotCarried(W, i, f, W.f_carry[f]);
  W.f_carry[f]++; W.f_carryKind[f] = kind;
  return i;
}
// despawn everything carried by f; optionally count as delivered
function dropCarried(W, f, deliver) {
  const hi = W.itemHigh;
  for (let i = 0; i < hi; i++) {
    if (!W.i_alive[i] || W.i_carrier[i] !== f || W.i_state[i] !== ItemState.CARRIED) continue;
    if (deliver) W.stats.delivered[W.i_kind[i]]++;
    despawnItem(W, i);
  }
  W.f_carry[f] = 0; W.f_carryKind[f] = 255;
}
function releaseReserved(W, f) {
  const hi = W.itemHigh;
  for (let i = 0; i < hi; i++) {
    if (W.i_alive[i] && W.i_carrier[i] === f && W.i_state[i] === ItemState.RESERVED) setItemState(W, i, ItemState.GROUND, -1, 0);
  }
}
function releaseAnimal(W, a, healed, produced) {
  W.a_flags[a] &= ~AFlag.HELD; W.a_heldBy[a] = -1;
  if (healed) { W.a_flags[a] &= ~AFlag.SICK; W.a_health[a] = 1; if (W.pen_sick[W.a_species[a]] > 0) W.pen_sick[W.a_species[a]]--; }
  if (produced) { W.a_flags[a] &= ~AFlag.READY; W.a_produce[a] = 0; if (W.pen_ready[W.a_species[a]] > 0) W.pen_ready[W.a_species[a]]--; }
  W.a_state[a] = AState.IDLE; W.a_next[a] = AState.IDLE; W.a_stateTime[a] = 1 + W.rand() * 2; W.a_animT[a] = 0;
}
function grabAnimal(W, f, a) {
  W.a_flags[a] |= AFlag.HELD; W.a_heldBy[a] = f; W.a_state[a] = AState.HELD;
  W.a_vx[a] = 0; W.a_vz[a] = 0; W.a_speed[a] = 0; W.a_stateTime[a] = 9999; W.a_animT[a] = 0;
}
// full reset to a clean idle farmer (task lost / cancelled)
function resetFarmer(W, f) {
  const n = W.animalCount;
  for (let a = 0; a < n; a++) {
    if (W.a_heldBy[a] === f) {
      if (W.a_flags[a] & AFlag.HELD) releaseAnimal(W, a, false, false); else W.a_heldBy[a] = -1;
    }
  }
  const hi = W.itemHigh;
  for (let i = 0; i < hi; i++) {
    if (!W.i_alive[i] || W.i_carrier[i] !== f) continue;
    if (W.i_state[i] === ItemState.CARRIED) despawnItem(W, i);
    else if (W.i_state[i] === ItemState.RESERVED) setItemState(W, i, ItemState.GROUND, -1, 0);
  }
  if (W.f_job[f] >= 0 || W.f_resv[f] > 0) releaseLoadJob(W, f);
  W.f_carry[f] = 0; W.f_carryKind[f] = 255; W.f_target[f] = -1; W.f_step[f] = 0; W.f_task[f] = -1;
  lookOn[f] = 0; W.f_timer[f] = 0.2 + W.rand();
  setState(W, f, FState.IDLE);
}
function finishTask(W, f, tk) {
  completeTask(W, tk);
  W.f_task[f] = -1; W.f_step[f] = 0; W.f_target[f] = -1;
  W.f_carry[f] = 0; W.f_carryKind[f] = 255;
  W.f_timer[f] = 0.3 + W.rand() * 1.2; lookOn[f] = 0;
  setState(W, f, FState.IDLE);
}
function abortTask(W, f, tk) {
  cancelTask(W, tk);
  resetFarmer(W, f);
}
function servicePoint(P, feat, out) {
  const off = feat.r > 0 ? feat.r + 0.7 : feat.d * 0.5 + 0.9;
  out[0] = feat.x; out[1] = feat.z - P.s * off;
}
function nearestGroundItem(W, f, kind, pen) {
  const hi = W.itemHigh, px = W.f_px[f], pz = W.f_pz[f];
  let best = -1, bd = 1e12;
  for (let i = 0; i < hi; i++) {
    if (!W.i_alive[i] || W.i_kind[i] !== kind || W.i_state[i] !== ItemState.GROUND || W.i_pen[i] !== pen) continue;
    const dx = W.i_x[i] - px, dz = W.i_z[i] - pz, d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
function pickAnimal(W, pen, flag, px, pz) {
  const n = W.animalCount;
  let best = -1, bd = 1e12;
  for (let a = 0; a < n; a++) {
    if (W.a_species[a] !== pen) continue;
    const fl = W.a_flags[a];
    if ((fl & flag) === 0 || (fl & AFlag.HELD)) continue;
    const dx = W.a_px[a] - px, dz = W.a_pz[a] - pz, d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = a; }
  }
  return best;
}

// ------------------------------------------------------------------ task scripts
// shared drop-off steps 20/21 (walk to dropoff already started by goDrop)
function goDrop(W, f, kind) {
  const B = kind === ItemKind.MANURE ? BUILDINGS.COMPOST.door : BUILDINGS.STOREHOUSE.door;
  go(W, f, B.x, B.z, -1, 0.5, FState.MOVE, 1.2);
  W.f_step[f] = 20;
}
function stepDrop(W, f, tk) {
  const s = W.f_step[f];
  if (s === 20) {
    if (ARRIVED) { pause(W, f, FState.DROPOFF, 1.0, W.f_tx[f], W.f_tz[f]); W.f_step[f] = 21; lookOn[f] = 0; }
  } else if (s === 21) {
    if (W.f_timer[f] <= 0) { dropCarried(W, f, true); finishTask(W, f, tk); }
  }
}

function stepSupply(W, f, tk) {
  const type = W.t_type[tk], pen = W.t_pen[tk], P = PENS[pen];
  const src = type === TaskType.WATER ? BUILDINGS.WELL.use : BUILDINGS.BARN.door;
  switch (W.f_step[f]) {
    case 0:
      go(W, f, src.x, src.z, -1, 0.5, FState.MOVE, 1.2); W.f_step[f] = 1; break;
    case 1:
      if (ARRIVED) { pause(W, f, FState.PICKUP, 1.2, src.x, src.z + 1); W.f_step[f] = 2; }
      break;
    case 2:
      if (W.f_timer[f] <= 0) {
        const kind = type === TaskType.WATER ? ItemKind.WATER : (P.feeder.r > 0 ? ItemKind.HAY : ItemKind.FEED);
        giveItem(W, f, kind);
        const feat = type === TaskType.WATER ? P.water : P.feeder;
        servicePoint(P, feat, _o);
        go(W, f, _o[0], _o[1], pen, 0.4, FState.MOVE, 0);
        W.f_step[f] = 3;
      }
      break;
    case 3:
      if (ARRIVED) {
        const feat = type === TaskType.WATER ? P.water : P.feeder;
        pause(W, f, FState.WORK, 2.5, feat.x, feat.z); W.f_step[f] = 4;
      }
      break;
    case 4:
      if (W.f_timer[f] <= 0) {
        dropCarried(W, f, false);
        if (type === TaskType.WATER) W.pen_water[pen] = 1; else W.pen_food[pen] = 1;
        const nt = nextSupplyTask(W, f, type, pen);
        if (nt >= 0) {
          // chain: take another open pen's task of the same kind without going back to the barn/well
          completeTask(W, tk);
          W.t_state[nt] = TaskState.CLAIMED; W.t_farmer[nt] = f; W.f_task[f] = nt;
          startDelivery(W, f, nt);
        } else finishTask(W, f, tk);
      }
      break;
  }
}
// nearest supply task of the same type needing the same item kind, close to farmer f: an OPEN task, or (batching) a
// not-yet-tasked pen whose level is already below 0.55 (a task is created for it on the spot)
function nextSupplyTask(W, f, type, pen) {
  if (isNight(W)) return -1;
  const hay = PENS[pen].feeder.r > 0, hi = W.taskHigh, fx = W.f_px[f], fz = W.f_pz[f];
  let best = -1, bd = 110 * 110, bestPen = -1;
  for (let t = 0; t < hi; t++) {
    if (!W.t_alive[t] || W.t_state[t] !== TaskState.OPEN || W.t_type[t] !== type) continue;
    const q = W.t_pen[t];
    if (q === pen || (type === TaskType.FEED && (PENS[q].feeder.r > 0) !== hay)) continue;
    const g = PENS[q].gateOut, dx = g.x - fx, dz = g.z - fz, d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = t; bestPen = -1; }
  }
  const lvl = type === TaskType.WATER ? W.pen_water : W.pen_food;
  for (let q = 0; q < PEN_COUNT; q++) {
    if (q === pen || lvl[q] >= 0.55 || (W.pen_taskMask[q] & (1 << type))) continue;
    if (type === TaskType.FEED && (PENS[q].feeder.r > 0) !== hay) continue;
    const g = PENS[q].gateOut, dx = g.x - fx, dz = g.z - fz, d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = -1; bestPen = q; }
  }
  if (bestPen >= 0) best = createTask(W, type, bestPen, -1, 1);
  return best;
}
function startDelivery(W, f, tk) {
  const type = W.t_type[tk], pen = W.t_pen[tk], P = PENS[pen];
  const kind = type === TaskType.WATER ? ItemKind.WATER : (P.feeder.r > 0 ? ItemKind.HAY : ItemKind.FEED);
  giveItem(W, f, kind);
  const feat = type === TaskType.WATER ? P.water : P.feeder;
  servicePoint(P, feat, _o);
  go(W, f, _o[0], _o[1], pen, 0.4, FState.MOVE, 0);
  W.f_step[f] = 3;
}

function stepGather(W, f, tk, kind, max) {
  const pen = W.t_pen[tk];
  switch (W.f_step[f]) {
    case 0: {
      if (W.f_carry[f] >= max) { goDrop(W, f, kind); break; }
      const i = nearestGroundItem(W, f, kind, pen);
      if (i < 0) { if (W.f_carry[f] > 0) goDrop(W, f, kind); else finishTask(W, f, tk); break; }
      setItemState(W, i, ItemState.RESERVED, f, 0);
      W.f_target[f] = i;
      go(W, f, W.i_x[i], W.i_z[i], pen, 0.4, FState.MOVE, 0);
      W.f_step[f] = 1;
      break;
    }
    case 1: {
      const i = W.f_target[f];
      if (i < 0 || !W.i_alive[i] || W.i_carrier[i] !== f) { W.f_step[f] = 0; break; }
      if (ARRIVED) { pause(W, f, FState.PICKUP, 0.4, W.i_x[i], W.i_z[i]); W.f_step[f] = 2; }
      break;
    }
    case 2:
      if (W.f_timer[f] <= 0) {
        const i = W.f_target[f];
        if (i >= 0 && W.i_alive[i] && W.i_carrier[i] === f && W.i_state[i] === ItemState.RESERVED) {
          setItemSlotCarried(W, i, f, W.f_carry[f]);
          W.f_carry[f]++; W.f_carryKind[f] = kind;
        }
        W.f_target[f] = -1; W.f_step[f] = 0;
      }
      break;
    default: stepDrop(W, f, tk);
  }
}

// move toward animal, tracking it. returns 1 when grabbed, -1 invalid, 0 in progress
function approachAnimal(W, f, tk, flag, workSecs) {
  const a = W.f_target[f], pen = W.t_pen[tk];
  if (!animalTargetOk(W, a, pen, flag)) return -1;
  const len = W.f_routeLen[f];
  if (len > 0) {
    const k = f * ROUTE_MAX * 2 + (len - 1) * 2;
    W.f_route[k] = W.a_px[a]; W.f_route[k + 1] = W.a_pz[a];
    if (W.f_routePos[f] >= len - 1) { W.f_tx[f] = W.a_px[a]; W.f_tz[f] = W.a_pz[a]; }
  }
  if (ARRIVED) {
    grabAnimal(W, f, a);
    pause(W, f, FState.WORK, workSecs, W.a_px[a], W.a_pz[a]);
    return 1;
  }
  return 0;
}
function chooseAnimal(W, f, tk, flag) {
  const pen = W.t_pen[tk];
  let a = W.t_target[tk];
  if (!animalTargetOk(W, a, pen, flag)) a = pickAnimal(W, pen, flag, W.f_px[f], W.f_pz[f]);
  if (a < 0) return false;
  W.t_target[tk] = a; W.f_target[f] = a;
  go(W, f, W.a_px[a], W.a_pz[a], pen, 1.0, FState.MOVE, 0);
  return true;
}
// is the held animal still mine?
function holdOk(W, f) {
  const a = W.f_target[f];
  return a >= 0 && a < W.animalCount && W.a_heldBy[a] === f && (W.a_flags[a] & AFlag.HELD) !== 0;
}

function stepProduce(W, f, tk) {
  const type = W.t_type[tk], flag = AFlag.READY;
  const kind = type === TaskType.MILK ? ItemKind.MILK : ItemKind.WOOL;
  switch (W.f_step[f]) {
    case 0:
      if (!chooseAnimal(W, f, tk, flag)) { abortTask(W, f, tk); break; }
      W.f_step[f] = 1; break;
    case 1: {
      const r = approachAnimal(W, f, tk, flag, 4.0);
      if (r < 0) W.f_step[f] = 0; else if (r > 0) W.f_step[f] = 2;
      break;
    }
    case 2:
      if (!holdOk(W, f)) { W.f_step[f] = 0; W.f_target[f] = -1; setState(W, f, FState.IDLE); break; }
      if (W.f_timer[f] <= 0) {
        releaseAnimal(W, W.f_target[f], false, true);
        W.f_target[f] = -1;
        giveItem(W, f, kind);
        goDrop(W, f, kind);
      }
      break;
    default: stepDrop(W, f, tk);
  }
}

function stepTreat(W, f, tk) {
  const door = BUILDINGS.VET_SHED.door, pen = W.t_pen[tk];
  switch (W.f_step[f]) {
    case 0:
      go(W, f, door.x, door.z, -1, 0.5, FState.MOVE, 1.2); W.f_step[f] = 1; break;
    case 1:
      if (ARRIVED) { pause(W, f, FState.PICKUP, 1.0, door.x + 1, door.z); W.f_step[f] = 2; }
      break;
    case 2:
      if (W.f_timer[f] <= 0) { giveItem(W, f, ItemKind.MEDKIT); W.f_step[f] = 3; }
      break;
    case 3:
      if (!chooseAnimal(W, f, tk, AFlag.SICK)) { abortTask(W, f, tk); break; }
      W.f_step[f] = 4; break;
    case 4: {
      const r = approachAnimal(W, f, tk, AFlag.SICK, 3.0);
      if (r < 0) W.f_step[f] = 3; else if (r > 0) W.f_step[f] = 5;
      break;
    }
    case 5:
      if (!holdOk(W, f)) { W.f_step[f] = 3; W.f_target[f] = -1; setState(W, f, FState.IDLE); break; }
      if (W.f_timer[f] <= 0) {
        releaseAnimal(W, W.f_target[f], true, false);
        dropCarried(W, f, false);
        finishTask(W, f, tk);
      }
      break;
  }
}

function runTask(W, f, tk) {
  switch (W.t_type[tk]) {
    case TaskType.FEED: case TaskType.WATER: stepSupply(W, f, tk); break;
    case TaskType.COLLECT_EGGS: stepGather(W, f, tk, ItemKind.EGG, MAX_EGGS); break;
    case TaskType.CLEAN: stepGather(W, f, tk, ItemKind.MANURE, MAX_MANURE); break;
    case TaskType.MILK: case TaskType.SHEAR: stepProduce(W, f, tk); break;
    case TaskType.TREAT: stepTreat(W, f, tk); break;
  }
}

// a farmer who is only walking to a task (empty hands) is pulled off it: the task is reopened for somebody else
setPreemptHook((W, f) => {
  const tk = W.f_task[f];
  if (tk >= 0 && W.t_alive[tk]) { W.t_state[tk] = TaskState.OPEN; W.t_farmer[tk] = -1; }
  resetFarmer(W, f);
});

// ------------------------------------------------------------------ truck loading job (f_job >= 0, f_task < 0)
// f_step: 0 walk to the storehouse door, 1 arrived -> reserve + PICKUP, 2 picked up -> walk to the truck's tail, 3 arrived -> DROPOFF, 4 handed over -> loop
function endJob(W, f) {
  dropCarried(W, f, false);
  releaseLoadJob(W, f);
  W.f_step[f] = 0; W.f_target[f] = -1; W.f_timer[f] = 0.3 + W.rand() * 1.2; lookOn[f] = 0;
  setState(W, f, FState.IDLE);
}
function stepLoad(W, f) {
  const j = W.f_job[f];
  if (!truckLoadable(W, j) || W.f_jobAge[f] > JOB_MAX_S) { endJob(W, f); return; }
  switch (W.f_step[f]) {
    case 0:
      if (loadNeed(W, j) <= 0) { endJob(W, f); break; }
      go(W, f, DOOR.x, DOOR.z, -1, 0.5, FState.MOVE, 1.0); W.f_step[f] = 1; break;
    case 1:
      if (ARRIVED) {
        if (reserveLoad(W, j, f) < 0) { endJob(W, f); break; }
        pause(W, f, FState.PICKUP, 1.2, DOOR.x + 3, DOOR.z); W.f_step[f] = 2;
      }
      break;
    case 2:
      if (W.f_timer[f] <= 0) {
        const k = W.f_resvKind[f], want = W.f_resv[f];
        let got = 0;
        for (; got < want; got++) if (giveItem(W, f, LOAD_ITEM[k]) < 0) break;
        if (got < want) { const r = W.f_resv[f] - got; W.truckRes[k] = Math.max(0, W.truckRes[k] - r); W.v_carry[j * 3 + k] = Math.max(0, W.v_carry[j * 3 + k] - r); W.f_resv[f] = got; }
        if (got === 0) { endJob(W, f); break; }
        truckRear(W, j, ((f % 3) - 1) * 0.75, _o);
        go(W, f, _o[0], _o[1], -1, 0.4, FState.MOVE, 0); W.f_step[f] = 3;
      }
      break;
    case 3:
      if (ARRIVED) { pause(W, f, FState.DROPOFF, 1.0, W.v_x[j], W.v_z[j]); W.f_step[f] = 4; }
      break;
    case 4:
      if (W.f_timer[f] <= 0) {
        const n = W.f_carry[f], k = W.f_resvKind[f];
        dropCarried(W, f, false);
        deliverLoad(W, j, f, k, n);
        W.f_step[f] = 0; lookOn[f] = 0;
        setState(W, f, FState.IDLE); W.f_timer[f] = 0;
      }
      break;
  }
}

// ------------------------------------------------------------------ idle behaviour
function idleThink(W, f) {
  const rand = W.rand;
  if (isNight(W)) {
    go(W, f, -137 + rand() * 4, -48 + rand() * 8, -1, 0.5, FState.WANDER, 0);
    W.f_step[f] = 2; return;
  }
  const r = rand();
  if (r < 0.4) {
    go(W, f, (rand() * 2 - 1) * 115, (rand() * 2 - 1) * 3, -1, 0.6, FState.WANDER, 0);
    W.f_step[f] = 0;
  } else if (r < 0.8) {
    const p = (rand() * PEN_COUNT) | 0, P = PENS[p];
    const sx = rand() < 0.5 ? -1 : 1;
    go(W, f, P.cx + sx * (2.4 + rand() * 1.4), P.gateEdgeZ - P.s * 1.3, -1, 0.4, FState.WANDER, 0);
    W.f_step[f] = 1; W.f_target[f] = p;
  } else {
    pause(W, f, FState.IDLE, 2 + rand() * 4);
    W.f_step[f] = 0;
  }
}
function idleArrived(W, f) {
  const rand = W.rand, step = W.f_step[f];
  if (step === 1) {
    const p = W.f_target[f], P = PENS[p >= 0 && p < PEN_COUNT ? p : 0];
    pause(W, f, FState.LEAN, 8 + rand() * 12, W.f_px[f], W.f_pz[f] + P.s * 5);
    W.f_heading[f] = P.s > 0 ? 0 : PI;
  } else if (step === 2 && isNight(W)) {
    pause(W, f, FState.REST, 0);
  } else {
    pause(W, f, FState.IDLE, 1.5 + rand() * 3.5);
  }
  W.f_step[f] = 0;
}

// ------------------------------------------------------------------ movement
function follow(W, f, dt) {
  const len = W.f_routeLen[f];
  let pos = W.f_routePos[f];
  if (pos >= len) { W.f_speed[f] = 0; return true; }
  const R = W.f_route, base = f * ROUTE_MAX * 2;
  const px = W.f_px[f], pz = W.f_pz[f];
  let tx = R[base + pos * 2], tz = R[base + pos * 2 + 1];
  let dx = tx - px, dz = tz - pz, d = Math.sqrt(dx * dx + dz * dz);
  const last = pos >= len - 1;
  const st = stuck[f];
  const tol = last ? arrTol[f] : 0.5;
  if (d <= tol || (last && st > 1.5 && d < 2.2) || st > 5) {
    pos++; stuck[f] = 0;
    W.f_routePos[f] = pos;
    if (pos >= len) { W.f_speed[f] = 0; return true; }
    tx = R[base + pos * 2]; tz = R[base + pos * 2 + 1];
    W.f_tx[f] = tx; W.f_tz[f] = tz;
    dx = tx - px; dz = tz - pz; d = Math.sqrt(dx * dx + dz * dz);
  }
  if (d > 1e-5) {
    const spd = FARMER_SPEED * (W.f_carry[f] > 0 ? 0.92 : 1);
    const stp = Math.min(spd * dt, d);
    let ux = dx / d, uz = dz / d;
    if (slideT[f] > 0) {                                  // blocked head-on by a wall / feature: walk ~65 degrees off-axis for a moment so the collision slides us round it
      slideT[f] -= dt;
      const sn = 0.9 * slideDir[f], cs = 0.436, nx = ux * cs - uz * sn, nz = ux * sn + uz * cs;
      ux = nx; uz = nz;
    }
    W.f_px[f] = px + ux * stp; W.f_pz[f] = pz + uz * stp;
    turnTo(W, f, Math.atan2(ux, uz), dt);
    moving[f] = 1;
  }
  return false;
}

export function updateFarmers(W, dt) {
  const nf = W.farmerCount;
  const night = isNight(W);
  const { f_px, f_pz, f_state, f_task, f_timer, f_speed, f_gait, f_animT, f_pen } = W;

  for (let f = 0; f < nf; f++) {
    oldX[f] = f_px[f]; oldZ[f] = f_pz[f]; moving[f] = 0;
    let st = f_state[f];
    let tk = f_task[f];
    // validate task ownership
    if (tk >= 0 && (!W.t_alive[tk] || W.t_farmer[tk] !== f)) { f_task[f] = -1; tk = -1; resetFarmer(W, f); st = f_state[f]; }
    else if (tk < 0 && W.f_job[f] < 0 && (st === FState.MOVE || st === FState.PICKUP || st === FState.WORK || st === FState.DROPOFF)) {
      resetFarmer(W, f); st = f_state[f];
    }
    f_animT[f] += dt;
    if (W.f_job[f] >= 0) W.f_jobAge[f] += dt;
    // timers
    if (st !== FState.MOVE && st !== FState.WANDER && st !== FState.REST) f_timer[f] -= dt;

    ARRIVED = false;
    if (st === FState.MOVE || st === FState.WANDER) ARRIVED = follow(W, f, dt);
    else { f_speed[f] = 0; }

    if (tk >= 0) {
      runTask(W, f, tk);
    } else if (W.f_job[f] >= 0) {
      stepLoad(W, f);
    } else {
      st = f_state[f];
      if (st === FState.WANDER) { if (ARRIVED) idleArrived(W, f); }
      else if (st === FState.IDLE) { if (f_timer[f] <= 0) idleThink(W, f); }
      else if (st === FState.LEAN) { if (f_timer[f] <= 0 || night) { pause(W, f, FState.IDLE, 0.5 + W.rand() * 2); } }
      else if (st === FState.REST) { if (!night) pause(W, f, FState.IDLE, W.rand() * 8); }
    }
    // face look target when stationary
    st = f_state[f];
    if (!moving[f] && lookOn[f] && st !== FState.LEAN) {
      turnTo(W, f, Math.atan2(lookX[f] - f_px[f], lookZ[f] - f_pz[f]), dt);
    }
  }

  // separation O(n^2)
  const m2 = SEP_R * SEP_R;
  for (let i = 0; i < nf; i++) {
    for (let j = i + 1; j < nf; j++) {
      let dx = f_px[j] - f_px[i], dz = f_pz[j] - f_pz[i];
      const d2 = dx * dx + dz * dz;
      if (d2 >= m2) continue;
      let d = Math.sqrt(d2);
      if (d < 1e-4) { dx = 1; dz = 0; d = 1; }
      const push = (SEP_R - d) * 0.5 * 0.5 / d;   // half the overlap each, softened
      f_px[i] -= dx * push; f_pz[i] -= dz * push;
      f_px[j] += dx * push; f_pz[j] += dz * push;
    }
  }

  // collisions, pen tracking, stuck, speed, gait
  W.pen_farmers.fill(0);
  for (let f = 0; f < nf; f++) {
    let x = f_px[f], z = f_pz[f];
    const p = penOf(x, z);
    f_pen[f] = p;
    if (p >= 0) {
      const P = PENS[p];
      pushOutOfSolids(p, x, z, FARMER_RADIUS, _o); x = _o[0]; z = _o[1];
      const m = 0.3;
      if (x < P.x0 + m) x = P.x0 + m; else if (x > P.x1 - m) x = P.x1 - m;
      if (P.s < 0) { // north pen: gate edge is z1
        if (z < P.z0 + m) z = P.z0 + m;
        if (z > P.z1 - m && Math.abs(x - P.cx) > 2.2) z = P.z1 - m;
      } else {
        if (z > P.z1 - m) z = P.z1 - m;
        if (z < P.z0 + m && Math.abs(x - P.cx) > 2.2) z = P.z0 + m;
      }
      f_px[f] = x; f_pz[f] = z;
      if (W.pen_farmers[p] < 255) W.pen_farmers[p]++;
    }
    const mdx = x - oldX[f], mdz = z - oldZ[f];
    const moved = Math.sqrt(mdx * mdx + mdz * mdz);
    const intended = FARMER_SPEED * dt * 0.9;
    const mv = moving[f] ? 1 : 0;
    stuck[f] = mv * (stuck[f] + dt) * (moved < 0.25 * intended ? 1 : 0);
    if (mv) {   // branch-free: keeps type feedback warm (rare-branch deopts cost whole ticks)
      if (stuck[f] > 0.35 && slideT[f] <= 0 && p >= 0) { slideT[f] = 0.9; slideDir[f] = W.rand() < 0.5 ? 1 : -1; }
      f_speed[f] = moved / dt;
      let g = f_gait[f] + moved / STRIDE;
      f_gait[f] = g - Math.floor(g);
    } else {
      f_speed[f] = 0;
    }
  }

  // gates
  const gt = W.pen_gateTarget, go_ = W.pen_gateOpen;
  for (let p = 0; p < PEN_COUNT; p++) {
    const P = PENS[p];
    let t = 0;
    for (let f = 0; f < nf; f++) {
      const dx = f_px[f] - P.cx, dz = f_pz[f] - P.gateEdgeZ;
      if (dx * dx + dz * dz < GATE_RANGE * GATE_RANGE) { t = 1; break; }
    }
    gt[p] = t;
    const o = go_[p], step = GATE_SPEED * dt;
    go_[p] = o < t ? Math.min(t, o + step) : Math.max(t, o - step);
  }
}
