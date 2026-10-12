// ECS world: struct-of-arrays typed arrays + helpers. No DOM. Runs under Node.
import {
  MAX_ANIMALS, MAX_FARMERS, MAX_ITEMS, MAX_TASKS, ROUTE_MAX, SPECIES_COUNT, SPECIES, PENS, BUILDINGS,
  HASH_CELL, WORLD, PEN_COUNT, DAY_LENGTH_SEC, START_HOUR, AState, AFlag, FState, TaskType, TaskState,
  ItemKind, ItemState, FeatureKind, TASK_TYPE_COUNT, ITEM_KIND_COUNT,
} from '../config.js';
import { mulberry32 } from './rng.js';
import { createSpatialHash } from './spatialHash.js';
import { allocTrucks, releaseLoadJob } from '../sim/trucks.js';

const TWO_PI = Math.PI * 2;
const ANIMAL_F32 = ['a_px','a_py','a_pz','a_ppx','a_ppy','a_ppz','a_vx','a_vz','a_heading','a_pheading','a_speed',
  'a_tx','a_tz','a_stateTime','a_animT','a_gait','a_scale','a_hunger','a_thirst','a_energy','a_produce','a_health'];
const ANIMAL_U8 = ['a_species','a_state','a_next','a_flags','a_variant'];
// every animal array, for swap-remove
const ANIMAL_ALL = [...ANIMAL_F32, ...ANIMAL_U8, 'a_leader', 'a_heldBy', 'a_seed'];

export function createWorld({ seed = 1337 } = {}) {
  const W = { seed };
  const nA = MAX_ANIMALS, nF = MAX_FARMERS, nI = MAX_ITEMS, nT = MAX_TASKS;
  // animals
  for (const k of ANIMAL_U8) W[k] = new Uint8Array(nA);
  for (const k of ANIMAL_F32) W[k] = new Float32Array(nA);
  W.a_leader = new Int32Array(nA).fill(-1);
  W.a_heldBy = new Int16Array(nA).fill(-1);
  W.a_seed = new Uint32Array(nA);
  W.speciesCount = new Int32Array(SPECIES_COUNT);
  // farmers
  for (const k of ['f_type','f_state','f_step','f_carry','f_carryKind','f_routeLen','f_routePos']) W[k] = new Uint8Array(nF);
  W.f_carryKind.fill(255);
  W.f_pen = new Int8Array(nF).fill(-1);
  for (const k of ['f_px','f_pz','f_ppx','f_ppz','f_heading','f_pheading','f_speed','f_gait','f_animT','f_timer','f_tx','f_tz']) W[k] = new Float32Array(nF);
  W.f_job = new Int8Array(nF).fill(-1);          // truck being loaded by this farmer (-1 none); see sim/trucks.js offerLoaders / farmers.js stepLoad
  W.f_resv = new Uint8Array(nF); W.f_resvKind = new Uint8Array(nF); W.f_jobAge = new Float32Array(nF);
  W.f_task = new Int32Array(nF).fill(-1);
  W.f_target = new Int32Array(nF).fill(-1);
  W.f_route = new Float32Array(nF * ROUTE_MAX * 2);
  // items
  for (const k of ['i_alive','i_kind','i_state','i_slot']) W[k] = new Uint8Array(nI);
  for (const k of ['i_x','i_y','i_z','i_yaw','i_time']) W[k] = new Float32Array(nI);
  W.i_pen = new Int8Array(nI).fill(-1);
  W.i_carrier = new Int16Array(nI).fill(-1);
  W.itemCount = 0; W.itemHigh = 0;
  W._freeItems = new Int32Array(nI); W._freeItemN = 0;
  // tasks
  for (const k of ['t_alive','t_type','t_state','t_pen']) W[k] = new Uint8Array(nT);
  W.t_farmer = new Int16Array(nT).fill(-1);
  W.t_target = new Int32Array(nT).fill(-1);
  W.t_prio = new Float32Array(nT); W.t_time = new Float32Array(nT);
  W.taskCount = 0; W.taskHigh = 0;
  W._freeTasks = new Int32Array(nT); W._freeTaskN = 0;
  // pens
  for (const k of ['pen_food','pen_water','pen_dirt','pen_gateOpen','pen_gateTarget']) W[k] = new Float32Array(PEN_COUNT);
  for (const k of ['pen_count','pen_eggs','pen_manure','pen_ready','pen_sick','pen_taskMask']) W[k] = new Uint16Array(PEN_COUNT);
  W.pen_farmers = new Uint8Array(PEN_COUNT);
  // globals
  W.time = 0; W.hour = START_HOUR; W.day = 0; W.tick = 0;
  W.rand = mulberry32(seed);
  W.hash = createSpatialHash(HASH_CELL, WORLD.half, MAX_ANIMALS);
  W.animalCount = 0; W.farmerCount = 0;
  W.stats = {
    tasksCreated: new Uint32Array(TASK_TYPE_COUNT),
    tasksDone: new Uint32Array(TASK_TYPE_COUNT),
    tasksDonePen: new Uint32Array(PEN_COUNT * TASK_TYPE_COUNT),    // [pen * TASK_TYPE_COUNT + type]
    delivered: new Uint32Array(ITEM_KIND_COUNT),
  };
  allocTrucks(W);           // v_* truck arrays, W.truck scheduler state, stats.shipped / trucksVisited (see sim/trucks.js)
  return W;
}

// ------------------------------------------------------------------ terrain / pens
const ROCKS = PENS[4].features.filter(f => f.kind === FeatureKind.ROCK);
export function terrainHeight(x, z) {
  let h = 0;
  for (let i = 0; i < ROCKS.length; i++) {
    const r = ROCKS[i];
    const dx = x - r.x, dz = z - r.z;
    const v = r.h * (1 - Math.sqrt(dx * dx + dz * dz) / r.r);
    if (v > h) h = v;
  }
  return h;
}

// O(1): pen grid is 5 columns (pitch 50, width 44 from x=-122) x 4 rows (north inner / south inner / north outer / south outer; see config.js)
export function penOf(x, z) {
  const c = Math.floor((x + 122) * 0.02);
  if (c < 0 || c > 4 || x - (-122 + 50 * c) > 44) return -1;
  let row;
  if (z >= -64 && z <= -8) row = 0;
  else if (z >= 8 && z <= 64) row = 1;
  else if (z >= -128 && z <= -72) row = 2;
  else if (z >= 72 && z <= 128) row = 3;
  else return -1;
  return row * 5 + c;
}

export function clampToPen(p, x, z, margin, out) {
  const P = PENS[p];
  const lx = P.x0 + margin, hx = P.x1 - margin, lz = P.z0 + margin, hz = P.z1 - margin;
  out[0] = x < lx ? lx : x > hx ? hx : x;
  out[1] = z < lz ? lz : z > hz ? hz : z;
}

// Pushes circle (x,z,radius) out of pen p's solid features. out=[x,z]. Returns true if moved.
export function pushOutOfSolids(p, x, z, radius, out) {
  const sol = PENS[p].solids;
  let moved = false;
  for (let pass = 0; pass < 2; pass++) {
    let any = false;
    for (let i = 0; i < sol.length; i++) {
      const s = sol[i];
      if (s.r > 0) {
        const dx = x - s.x, dz = z - s.z, m = s.r + radius;
        const d2 = dx * dx + dz * dz;
        if (d2 < m * m) {
          const d = Math.sqrt(d2);
          if (d > 1e-6) { x = s.x + dx / d * m; z = s.z + dz / d * m; }
          else { x = s.x + m; }
          any = true;
        }
      } else {
        const hw = s.w * 0.5, hd = s.d * 0.5;
        const nx = Math.max(s.x - hw, Math.min(x, s.x + hw));
        const nz = Math.max(s.z - hd, Math.min(z, s.z + hd));
        const dx = x - nx, dz = z - nz, d2 = dx * dx + dz * dz;
        if (d2 < radius * radius) {
          if (d2 > 1e-10) {
            const d = Math.sqrt(d2);
            x = nx + dx / d * radius; z = nz + dz / d * radius;
          } else {
            // centre inside rect: exit via nearest face
            const ex = hw - Math.abs(x - s.x), ez = hd - Math.abs(z - s.z);
            if (ex < ez) x = (x >= s.x ? s.x + hw + radius : s.x - hw - radius);
            else z = (z >= s.z ? s.z + hd + radius : s.z - hd - radius);
          }
          any = true;
        }
      }
    }
    if (!any) break;
    moved = true;
  }
  out[0] = x; out[1] = z;
  return moved;
}

function insideSolid(p, x, z, m) {
  const sol = PENS[p].solids;
  for (let i = 0; i < sol.length; i++) {
    const s = sol[i];
    if (s.r > 0) {
      const dx = x - s.x, dz = z - s.z, r = s.r + m;
      if (dx * dx + dz * dz < r * r) return true;
    } else if (Math.abs(x - s.x) < s.w * 0.5 + m && Math.abs(z - s.z) < s.d * 0.5 + m) return true;
  }
  return false;
}

// Random point in pen, `margin` from fences and solids.
export function randomPointInPen(W, p, margin, out) {
  const P = PENS[p], rand = W.rand;
  let x = P.cx, z = P.cz;
  for (let t = 0; t < 30; t++) {
    x = P.x0 + margin + rand() * (P.x1 - P.x0 - 2 * margin);
    z = P.z0 + margin + rand() * (P.z1 - P.z0 - 2 * margin);
    if (!insideSolid(p, x, z, margin)) break;
  }
  out[0] = x; out[1] = z;
}

const _p2 = new Float32Array(2);

// ------------------------------------------------------------------ clock
export function snapshotPrev(W) {
  const n = W.animalCount;
  const { a_px, a_py, a_pz, a_ppx, a_ppy, a_ppz, a_heading, a_pheading } = W;
  for (let i = 0; i < n; i++) {
    a_ppx[i] = a_px[i]; a_ppy[i] = a_py[i]; a_ppz[i] = a_pz[i]; a_pheading[i] = a_heading[i];
  }
  const m = W.farmerCount;
  const { f_px, f_pz, f_ppx, f_ppz, f_heading, f_pheading } = W;
  for (let i = 0; i < m; i++) {
    f_ppx[i] = f_px[i]; f_ppz[i] = f_pz[i]; f_pheading[i] = f_heading[i];
  }
}
// Advances time, hour, day and tick (tick++ happens here).
export function advanceClock(W, dt) {
  W.time += dt; W.tick++;
  const hrs = START_HOUR + W.time * 24 / DAY_LENGTH_SEC;
  W.hour = hrs % 24;
  W.day = Math.floor(hrs / 24);
}
export function isNight(W) { return W.hour >= 21 || W.hour < 5.5; }

// ------------------------------------------------------------------ items
export function spawnItem(W, kind, x, y, z, pen) {
  let i;
  if (W._freeItemN > 0) i = W._freeItems[--W._freeItemN];
  else if (W.itemHigh < MAX_ITEMS) i = W.itemHigh++;
  else return -1;
  W.i_alive[i] = 1; W.i_kind[i] = kind; W.i_state[i] = ItemState.GROUND; W.i_slot[i] = 0;
  W.i_x[i] = x; W.i_y[i] = y; W.i_z[i] = z; W.i_yaw[i] = W.rand() * TWO_PI; W.i_time[i] = 0;
  W.i_pen[i] = pen; W.i_carrier[i] = -1;
  W.itemCount++;
  addPenItem(W, i, 1);
  return i;
}
// pen_eggs / pen_manure count items that are GROUND or RESERVED with pen>=0
function addPenItem(W, i, d) {
  const pen = W.i_pen[i];
  if (pen < 0 || W.i_state[i] === ItemState.CARRIED) return;
  const k = W.i_kind[i];
  if (k === ItemKind.EGG) W.pen_eggs[pen] = Math.max(0, W.pen_eggs[pen] + d);
  else if (k === ItemKind.MANURE) W.pen_manure[pen] = Math.max(0, W.pen_manure[pen] + d);
}
export function despawnItem(W, i) {
  if (!W.i_alive[i]) return;
  addPenItem(W, i, -1);
  W.i_alive[i] = 0; W.i_carrier[i] = -1;
  W._freeItems[W._freeItemN++] = i;
  W.itemCount--;
}
// Use this (instead of writing i_state directly) so pen_eggs/pen_manure stay correct.
export function setItemState(W, i, state, carrier = -1, slot = 0) {
  if (W.i_state[i] === state) { W.i_carrier[i] = carrier; W.i_slot[i] = slot; return; }
  addPenItem(W, i, -1);
  W.i_state[i] = state; W.i_carrier[i] = carrier; W.i_slot[i] = slot;
  addPenItem(W, i, 1);
}
// Recompute pen_eggs/pen_manure from scratch (safety net).
export function recountPenItems(W) {
  W.pen_eggs.fill(0); W.pen_manure.fill(0);
  for (let i = 0; i < W.itemHigh; i++) if (W.i_alive[i]) addPenItem(W, i, 1);
}

// ------------------------------------------------------------------ tasks
export function createTask(W, type, pen, target, prio) {
  if (W.pen_taskMask[pen] & (1 << type)) return -1;
  let t;
  if (W._freeTaskN > 0) t = W._freeTasks[--W._freeTaskN];
  else if (W.taskHigh < MAX_TASKS) t = W.taskHigh++;
  else return -1;
  W.t_alive[t] = 1; W.t_type[t] = type; W.t_state[t] = TaskState.OPEN; W.t_pen[t] = pen;
  W.t_farmer[t] = -1; W.t_target[t] = target; W.t_prio[t] = prio; W.t_time[t] = 0;
  W.pen_taskMask[pen] |= (1 << type);
  W.taskCount++;
  W.stats.tasksCreated[type]++;
  return t;
}
function freeTask(W, t) {
  if (!W.t_alive[t]) return;
  W.pen_taskMask[W.t_pen[t]] &= ~(1 << W.t_type[t]);
  W.t_alive[t] = 0;
  W._freeTasks[W._freeTaskN++] = t;
  W.taskCount--;
}
export function completeTask(W, t) {
  if (!W.t_alive[t]) return;
  W.stats.tasksDone[W.t_type[t]]++; W.stats.tasksDonePen[W.t_pen[t] * TASK_TYPE_COUNT + W.t_type[t]]++;
  const f = W.t_farmer[t];
  if (f >= 0 && W.f_task[f] === t) W.f_task[f] = -1;
  freeTask(W, t);
}
// Cancelling a CLAIMED task sets the claiming farmer's f_task=-1; the farmer script must notice and reset.
export function cancelTask(W, t) {
  if (!W.t_alive[t]) return;
  const f = W.t_farmer[t];
  if (f >= 0 && f < W.farmerCount && W.f_task[f] === t) W.f_task[f] = -1;
  freeTask(W, t);
}
function isAnimalTask(type) { return type === TaskType.MILK || type === TaskType.SHEAR || type === TaskType.TREAT; }

// ------------------------------------------------------------------ animals
export function spawnAnimal(W, species) {
  if (W.animalCount >= MAX_ANIMALS) return -1;
  const i = W.animalCount++, rand = W.rand, sp = SPECIES[species];
  randomPointInPen(W, species, sp.radius + 0.4, _p2);
  W.a_species[i] = species; W.a_state[i] = AState.IDLE; W.a_next[i] = AState.IDLE; W.a_flags[i] = 0;
  W.a_variant[i] = (rand() < 0.5 ? 1 : 0) | (((rand() * 8) | 0) << 1);
  W.a_px[i] = W.a_ppx[i] = _p2[0]; W.a_pz[i] = W.a_ppz[i] = _p2[1];
  W.a_py[i] = W.a_ppy[i] = species === 4 ? terrainHeight(_p2[0], _p2[1]) : 0;
  W.a_vx[i] = 0; W.a_vz[i] = 0; W.a_speed[i] = 0;
  W.a_heading[i] = W.a_pheading[i] = (rand() * 2 - 1) * Math.PI;
  W.a_tx[i] = _p2[0]; W.a_tz[i] = _p2[1];
  W.a_stateTime[i] = 0.5 + rand() * 2.5; W.a_animT[i] = 0; W.a_gait[i] = rand();
  W.a_scale[i] = 0.85 + rand() * 0.3;
  W.a_hunger[i] = rand() * 0.5; W.a_thirst[i] = rand() * 0.5; W.a_energy[i] = 0.5 + rand() * 0.5;
  W.a_produce[i] = rand(); W.a_health[i] = 1;
  W.a_leader[i] = -1; W.a_heldBy[i] = -1; W.a_seed[i] = (rand() * 4294967296) >>> 0;
  W.speciesCount[species]++; W.pen_count[species]++;
  return i;
}

export function despawnAnimal(W, idx) {
  const n = W.animalCount;
  if (idx < 0 || idx >= n) return;
  const last = n - 1, sp = W.a_species[idx];
  // tasks: cancel those targeting idx, retarget those pointing at `last`
  for (let t = 0; t < W.taskHigh; t++) {
    if (!W.t_alive[t] || !isAnimalTask(W.t_type[t])) continue;
    if (W.t_target[t] === idx) cancelTask(W, t);
    else if (W.t_target[t] === last) W.t_target[t] = idx;
  }
  for (let f = 0; f < W.farmerCount; f++) {
    const t = W.f_task[f];
    if (t < 0 || !isAnimalTask(W.t_type[t])) { continue; }
    if (W.f_target[f] === idx) W.f_target[f] = -1;
    else if (W.f_target[f] === last) W.f_target[f] = idx;
  }
  // leader refs
  const lead = W.a_leader;
  for (let i = 0; i < n; i++) {
    if (lead[i] === idx) lead[i] = -1;
    else if (lead[i] === last) lead[i] = idx;
  }
  if (idx !== last) {
    for (let k = 0; k < ANIMAL_ALL.length; k++) { const a = W[ANIMAL_ALL[k]]; a[idx] = a[last]; }
    if (lead[idx] === idx) lead[idx] = -1;
  }
  W.animalCount = last;
  W.speciesCount[sp]--; W.pen_count[sp] = Math.max(0, W.pen_count[sp] - 1);
}

export function setAnimalCount(W, n) {
  n = Math.max(0, Math.min(MAX_ANIMALS, n | 0));
  const sc = W.speciesCount;
  while (W.animalCount < n) {
    const total = W.animalCount + 1;
    let best = 0, bestV = -Infinity;
    for (let s = 0; s < SPECIES_COUNT; s++) {
      const v = SPECIES[s].share * total - sc[s];
      if (v > bestV) { bestV = v; best = s; }
    }
    spawnAnimal(W, best);
  }
  while (W.animalCount > n) {
    const total = W.animalCount;
    let worst = 0, worstV = -Infinity;
    for (let s = 0; s < SPECIES_COUNT; s++) {
      const v = sc[s] - SPECIES[s].share * total;
      if (v > worstV) { worstV = v; worst = s; }
    }
    let idx = W.animalCount - 1;
    while (idx >= 0 && W.a_species[idx] !== worst) idx--;
    despawnAnimal(W, idx >= 0 ? idx : W.animalCount - 1);
  }
}

// ------------------------------------------------------------------ farmers
export function spawnFarmer(W, type) {
  if (W.farmerCount >= MAX_FARMERS) return -1;
  const i = W.farmerCount++, rand = W.rand;
  const door = BUILDINGS.FARMHOUSE.door;
  // first 24 farmers appear around the farmhouse door; the rest are scattered over the open yard between farmhouse and pen 0 (x -139..-127, z -60..-30)
  const x = i < 24 ? door.x + (rand() * 2 - 1) * 3 : -139 + rand() * 12, z = i < 24 ? door.z + (rand() * 2 - 1) * 3 : -60 + rand() * 30;
  W.f_type[i] = type; W.f_state[i] = FState.IDLE; W.f_step[i] = 0; W.f_carry[i] = 0; W.f_carryKind[i] = 255;
  W.f_routeLen[i] = 0; W.f_routePos[i] = 0; W.f_pen[i] = -1;
  W.f_px[i] = W.f_ppx[i] = x; W.f_pz[i] = W.f_ppz[i] = z;
  W.f_heading[i] = W.f_pheading[i] = (rand() * 2 - 1) * Math.PI;
  W.f_speed[i] = 0; W.f_gait[i] = 0; W.f_animT[i] = 0; W.f_timer[i] = 0.5 + rand() * 2;
  W.f_tx[i] = x; W.f_tz[i] = z; W.f_task[i] = -1; W.f_target[i] = -1;
  W.f_job[i] = -1; W.f_resv[i] = 0; W.f_jobAge[i] = 0;
  return i;
}
// Only the top farmer can be removed (returns false otherwise).
export function despawnFarmer(W, idx) {
  if (idx !== W.farmerCount - 1 || idx < 0) return false;
  if (W.f_job[idx] >= 0 || W.f_resv[idx] > 0) releaseLoadJob(W, idx);      // give truck-loading reservations back (carried items are despawned below)
  for (let t = 0; t < W.taskHigh; t++) {
    if (W.t_alive[t] && W.t_farmer[t] === idx) { W.t_state[t] = TaskState.OPEN; W.t_farmer[t] = -1; }
  }
  for (let i = 0; i < W.itemHigh; i++) {
    if (!W.i_alive[i] || W.i_carrier[i] !== idx) continue;
    if (W.i_state[i] === ItemState.CARRIED) despawnItem(W, i);
    else if (W.i_state[i] === ItemState.RESERVED) setItemState(W, i, ItemState.GROUND, -1, 0);
  }
  for (let a = 0; a < W.animalCount; a++) {
    if (W.a_heldBy[a] === idx) {
      W.a_heldBy[a] = -1;
      if (W.a_flags[a] & AFlag.HELD) { W.a_flags[a] &= ~AFlag.HELD; W.a_state[a] = AState.IDLE; W.a_stateTime[a] = 1; }
    }
  }
  W.f_task[idx] = -1; W.f_target[idx] = -1; W.f_carry[idx] = 0; W.f_carryKind[idx] = 255;
  W.farmerCount--;
  return true;
}
export function setFarmerCount(W, n) {
  n = Math.max(0, Math.min(MAX_FARMERS, n | 0));
  while (W.farmerCount < n) spawnFarmer(W, W.farmerCount % 4);
  while (W.farmerCount > n) despawnFarmer(W, W.farmerCount - 1);
}

// ------------------------------------------------------------------ seeding
export function initialSeed(W) {
  const rand = W.rand;
  for (let p = 0; p < PEN_COUNT; p++) {
    W.pen_food[p] = 0.3 + rand() * 0.6;
    W.pen_water[p] = 0.3 + rand() * 0.6;
    const P = PENS[p];
    if (P.nest && SPECIES[p].produce === ItemKind.EGG) {
      const n = 3 + ((rand() * 4) | 0);
      for (let k = 0; k < n; k++) {
        spawnItem(W, ItemKind.EGG, P.nest.x + (rand() * 2 - 1) * P.nest.w * 0.4, 0.06,
          P.nest.z + (rand() * 2 - 1) * P.nest.d * 0.4, p);
      }
    }
    const m = 3 + ((rand() * 6) | 0);
    for (let k = 0; k < m; k++) {
      randomPointInPen(W, p, 1, _p2);
      spawnItem(W, ItemKind.MANURE, _p2[0], terrainHeight(_p2[0], _p2[1]), _p2[1], p);
    }
  }
}
