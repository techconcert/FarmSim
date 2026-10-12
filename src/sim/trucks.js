// Farm trucks: occasional pickup / van / milk-tanker visits. A truck enters from the east map edge along a dirt SERVICE LANE,
// reverses in to a gravel bay beside the storehouse (tail toward the door), is loaded (goods hop door -> bed), pulls out and leaves.
// Loading is done by FARMERS (see offerLoaders below + stepLoad in farmers.js): goods are carried door -> truck tail and the cargo count
// (v_loaded) grows when a farmer hands them over. If nobody comes (or loading stalls) the truck falls back to automatic 'ghost' loading
// (door -> bed hop, v_auto = 1, counted in W.stats.autoLoads) so a visit always completes.
// Data-oriented: typed arrays on W (v_*), no allocation in updateTrucks, no DOM / GL (runs under Node). Everything is dt-driven.
//
// Lane geometry (world metres, x east, z south; heading th: forward = (sin th, cos th)):
//   inbound  lane z = LANE.ZI (-19.5), westbound from x = XS (172, off-map) to X0 (129.5)
//   reverse  arc  R = 6.5, centre (X0, ZI + R); the truck backs along it and ends at BAY (136, -13) heading north (th = -pi), tail toward the
//            storehouse door (137, 0)
//   outbound arc  R2 = 10, centre (BAY.x + R2, BAY.z); ends on the eastbound lane z = LANE.ZO (-23) at x = 146, then east to XS.
// Vet shed (x 140..152, z -40..-28) and storehouse (x 140..156, z -10..10) are > 4 m from every swept footprint.
import { ItemKind, SIM_DT, FState, FarmerType } from '../config.js';

export const MAX_TRUCKS = 4, MAX_ACTIVE = 2;
export const TruckKind = { PICKUP: 0, VAN: 1, TANKER: 2 };
export const TruckState = { NONE: 0, APPROACH: 1, REVERSE: 2, LOADING: 3, PAUSE: 4, DEPART: 5 };
export const LANE = { XS: 172, X0: 129.5, ZI: -19.5, ZO: -23.0, R: 6.5, R2: 10.0, HOLD_X: 156 };
LANE.BAY = { x: LANE.X0 + LANE.R, z: LANE.ZI + LANE.R };
export const DOOR = { x: 137, z: 0 };                         // storehouse dropoff point (BUILDINGS.STOREHOUSE.door)
export const LANE_RECTS = [                                   // union polygon the truck CENTRES must stay inside
  { x0: 127, x1: 176, z0: -24.2, z1: -18.2 },
  { x0: 127, x1: 147.5, z0: -24.2, z1: -12.3 },
];
export function inLane(x, z) {
  for (let i = 0; i < LANE_RECTS.length; i++) { const r = LANE_RECTS[i]; if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) return true; }
  return false;
}
// per kind: half length (centre -> bumper), half width, cargo capacity (goods), max visible cargo slots
export const KIND = [
  { hl: 3.5, hw: 1.45, cap: 24, slots: 8 },
  { hl: 3.9, hw: 1.45, cap: 36, slots: 6 },
  { hl: 4.3, hw: 1.45, cap: 40, slots: 6 },
];
export const WHEEL_R = 0.62, WHEELBASE = 4.0;
export const FLIGHT = 1.1;                                    // seconds a goods item spends hopping door -> bed
export const LOAD_HELPERS = 4, NO_LOADER_S = 45, STALL_S = 40, MAX_LOAD_S = 200, COLLECTOR_ONLY_S = 10, DAY_FROM = 6.5, DAY_TO = 19.5;   // loader cap / timeouts / dispatch hours
export const PREEMPT_S = 12;                                  // no loader yet after this long -> pull a farmer that is only walking to a task (nothing in hands)
export const TRIP_CAP = [6, 4, 4];                            // max goods per farmer trip: EGG (4..6 by farmer), MILK, WOOL
export const STOCK_MIN = 8, STOCK_IDLE_MIN = 1, IDLE_SECONDS = 240, GAP_MIN = 75, GAP_RAND = 75;

const V_LANE = 6.5, V_REV = 2.4, V_ARC = 3.6, A_ACC = 1.8, A_BRAKE = 3.0, DS = 0.25, FARMER_AHEAD = 2.0;
const HP = Math.PI / 2;

// ---------------------------------------------------------------- paths (uniform arc length)
function buildPath(parts) {                                    // parts: [{n, fn(i/n) -> [x,z,th], len, dir, v}]
  let total = 0; for (const p of parts) total += Math.round(p.len / DS) * DS;
  const n = Math.round(total / DS) + 1;
  const px = new Float32Array(n), pz = new Float32Array(n), ph = new Float32Array(n), pd = new Int8Array(n), pv = new Float32Array(n), pk = new Float32Array(n);
  let o = 0, s0 = 0; const out = [0, 0, 0];
  const marks = [];
  for (const p of parts) {
    const m = Math.round(p.len / DS);
    for (let i = (o === 0 ? 0 : 1); i <= m; i++) {
      p.fn(i / m, out); px[o] = out[0]; pz[o] = out[1]; ph[o] = out[2]; pd[o] = p.dir; pv[o] = p.v; o++;
    }
    s0 += m * DS; marks.push(s0);
  }
  const N = o;
  for (let i = 0; i < N; i++) {                               // curvature for forward travel: dir * dth/ds
    const a = Math.max(0, i - 1), b = Math.min(N - 1, i + 1);
    pk[i] = pd[i] * (ph[b] - ph[a]) / (DS * (b - a));
  }
  return { px, pz, ph, pd, pv, pk, n: N, len: (N - 1) * DS, marks };
}
const { XS, X0, ZI, ZO, R, R2 } = LANE;
const BAYX = LANE.BAY.x, BAYZ = LANE.BAY.z;
export const PATH_IN = buildPath([
  { len: XS - X0, dir: 1, v: V_LANE, fn: (t, o) => { o[0] = XS - t * (XS - X0); o[1] = ZI; o[2] = -HP; } },
  { len: R * HP, dir: -1, v: V_REV, fn: (t, o) => { const f = t * HP; o[0] = X0 + R * Math.sin(f); o[1] = ZI + R * (1 - Math.cos(f)); o[2] = -HP - f; } },
]);
export const PATH_OUT = buildPath([
  { len: R2 * HP, dir: 1, v: V_ARC, fn: (t, o) => { const f = t * HP; o[0] = BAYX + R2 - R2 * Math.cos(f); o[1] = BAYZ - R2 * Math.sin(f); o[2] = -Math.PI - f; } },
  { len: XS - (BAYX + R2), dir: 1, v: V_LANE, fn: (t, o) => { o[0] = BAYX + R2 + t * (XS - BAYX - R2); o[1] = ZO; o[2] = -3 * HP; } },
]);
export const PATHS = [PATH_IN, PATH_OUT];
export const S_STOP = PATH_IN.marks[0];                        // end of the westbound run (truck stops here, then reverses)
export const S_PARK = PATH_IN.marks[1];                        // end of the reverse arc = parked in the bay
export const S_HOLD = XS - LANE.HOLD_X;                        // hold point while the bay is busy
export const S_ARC_END = PATH_OUT.marks[0];
const _o = new Float64Array(6);
export function pathAt(path, s, out) {                         // out = [x, z, heading, dir, vlimit, curvature]
  const P = path, u = Math.max(0, Math.min(P.n - 1.0001, s / DS)), i = u | 0, f = u - i;
  out[0] = P.px[i] + (P.px[i + 1] - P.px[i]) * f; out[1] = P.pz[i] + (P.pz[i + 1] - P.pz[i]) * f;
  out[2] = P.ph[i] + (P.ph[i + 1] - P.ph[i]) * f; out[3] = P.pd[f < 0.5 ? i : i + 1];
  out[4] = P.pv[f < 0.5 ? i : i + 1]; out[5] = P.pk[i] + (P.pk[i + 1] - P.pk[i]) * f;
  return out;
}

// ---------------------------------------------------------------- state
export function allocTrucks(W) {
  const n = MAX_TRUCKS;
  W.v_active = new Uint8Array(n); W.v_kind = new Uint8Array(n); W.v_state = new Uint8Array(n); W.v_variant = new Uint8Array(n); W.v_path = new Uint8Array(n);
  W.v_slots = new Uint8Array(n);
  for (const k of ['v_s', 'v_x', 'v_z', 'v_px', 'v_pz', 'v_h', 'v_ph', 'v_v', 'v_dir', 'v_steer', 'v_acc', 'v_timer', 'v_loadDur', 'v_blocked', 'v_seed', 'v_age', 'v_brake']) W[k] = new Float32Array(n);
  W.v_wheel = new Float64Array(n); W.v_pwheel = new Float64Array(n);
  W.v_plan = new Uint16Array(n * 3); W.v_loaded = new Uint16Array(n * 3);      // per truck: EGG, MILK, WOOL
  W.v_carry = new Uint16Array(n * 3); W.v_base = new Uint16Array(n * 3);       // goods reserved by farmers heading to this truck / loaded when ghost loading began
  W.v_auto = new Uint8Array(n); W.v_began = new Uint8Array(n); W.v_dropA = new Uint8Array(n); W.v_dropB = new Uint8Array(n); W.v_dropAuto = new Uint8Array(n);
  W.v_autoT = new Float32Array(n); W.v_prog = new Float64Array(n); W.v_dropT = new Float64Array(n);
  W.truckRes = new Int32Array(3);                                                 // goods (per kind) reserved / carried by loaders, not yet shipped
  W.truck = { nextAt: 0, lastSpawn: 0, lastVisit: 0, lastKind: -1, init: false, active: 0, spawned: 0, loading: 0 };
  W.truckStock = new Int32Array(3);
  if (W.stats) { W.stats.shipped = new Uint32Array(8); W.stats.trucksVisited = 0; W.stats.trucksSpawned = 0; W.stats.farmerLoads = 0; W.stats.farmerLoadGoods = 0; W.stats.autoLoads = 0; }
}
export function ensureTrucks(W) { if (!W.v_active) allocTrucks(W); if (!W.stats.shipped) { W.stats.shipped = new Uint32Array(8); W.stats.trucksVisited = 0; W.stats.trucksSpawned = 0; W.stats.farmerLoads = 0; W.stats.farmerLoadGoods = 0; W.stats.autoLoads = 0; } return W.truck; }

export function stockOf(W, k) { const v = W.stats.delivered[k] - W.stats.shipped[k]; return v > 0 ? v : 0; }
function refreshStock(W) { const s = W.truckStock; s[0] = stockOf(W, ItemKind.EGG); s[1] = stockOf(W, ItemKind.MILK); s[2] = stockOf(W, ItemKind.WOOL); return s[0] + s[1] + s[2]; }
const ITEM = [ItemKind.EGG, ItemKind.MILK, ItemKind.WOOL];

function pickKind(W, T) {
  const st = W.truckStock, total = st[0] + st[1] + st[2];
  if (st[1] >= 4 && st[1] >= 0.55 * total) return TruckKind.TANKER;
  let a = TruckKind.PICKUP, b = TruckKind.VAN;
  if (total >= 20 && W.rand() < 0.6) { a = TruckKind.VAN; b = TruckKind.PICKUP; }
  if (T.lastKind === a && W.rand() < 0.85) return b;
  return W.rand() < 0.7 ? a : b;
}

// Spawn a truck of `kind` (0 pickup, 1 van, 2 tanker) at the east edge. Returns the slot or -1. Ignores stock / cooldown (debug + dispatcher).
export function spawnTruck(W, kind) {
  const T = ensureTrucks(W);
  if (kind < 0 || kind > 2 || T.active >= MAX_ACTIVE) return -1;
  let slot = -1;
  for (let i = 0; i < MAX_TRUCKS; i++) {
    if (!W.v_active[i]) { if (slot < 0) slot = i; } else if (W.v_state[i] === TruckState.APPROACH) return -1;   // one inbound truck at a time
  }
  if (slot < 0) return -1;
  const i = slot;
  W.v_active[i] = 1; W.v_kind[i] = kind; W.v_state[i] = TruckState.APPROACH; W.v_path[i] = 0; W.v_variant[i] = (W.rand() * 6) | 0;
  W.v_s[i] = 0; W.v_v[i] = V_LANE * 0.9; W.v_dir[i] = 1; W.v_steer[i] = 0; W.v_acc[i] = 0; W.v_timer[i] = 0; W.v_blocked[i] = 0; W.v_age[i] = 0; W.v_brake[i] = 0;
  W.v_seed[i] = W.rand(); W.v_loadDur[i] = 8 + W.rand() * 4; W.v_slots[i] = 0;
  pathAt(PATH_IN, 0, _o);
  W.v_x[i] = W.v_px[i] = _o[0]; W.v_z[i] = W.v_pz[i] = _o[1]; W.v_h[i] = W.v_ph[i] = _o[2];
  W.v_wheel[i] = W.v_pwheel[i] = 0;
  for (let k = 0; k < 3; k++) { W.v_plan[i * 3 + k] = 0; W.v_loaded[i * 3 + k] = 0; W.v_carry[i * 3 + k] = 0; W.v_base[i * 3 + k] = 0; }
  W.v_auto[i] = 0; W.v_began[i] = 0; W.v_autoT[i] = 0; W.v_prog[i] = 0; W.v_dropT[i] = -1e9; W.v_dropA[i] = W.v_dropB[i] = 0; W.v_dropAuto[i] = 0;
  T.active++; T.spawned++; W.stats.trucksSpawned++; T.lastSpawn = W.time; T.lastKind = kind;
  return i;
}

function planLoad(W, i) {
  const kind = W.v_kind[i], cap = KIND[kind].cap, o = i * 3;
  const st = W.truckStock;
  refreshStock(W);
  for (let k = 0; k < 3; k++) { st[k] -= W.truckRes[k]; if (st[k] < 0) st[k] = 0; }
  let total = 0, want0 = st[0], want1 = st[1], want2 = st[2];
  if (kind === TruckKind.TANKER) { want0 = 0; want2 = 0; want1 = Math.min(want1, cap); }
  else {
    const all = want0 + want1 + want2;
    if (all > cap) {                                          // proportional share, rounding down, then top up
      const f = cap / all; want0 = Math.floor(want0 * f); want1 = Math.floor(want1 * f); want2 = Math.floor(want2 * f);
      let rest = cap - want0 - want1 - want2;
      while (rest > 0 && (want0 < st[0] || want1 < st[1] || want2 < st[2])) { if (want0 < st[0]) { want0++; rest--; } if (rest > 0 && want1 < st[1]) { want1++; rest--; } if (rest > 0 && want2 < st[2]) { want2++; rest--; } }
    }
  }
  W.v_plan[o] = want0; W.v_plan[o + 1] = want1; W.v_plan[o + 2] = want2; total = want0 + want1 + want2;
  W.v_loaded[o] = W.v_loaded[o + 1] = W.v_loaded[o + 2] = 0;
  const div = kind === TruckKind.PICKUP ? 3 : kind === TruckKind.VAN ? 4 : 6;
  let k = Math.ceil(total / div); if (k < 2) k = 2; if (k > KIND[kind].slots) k = KIND[kind].slots;
  W.v_slots[i] = total > 0 ? k : 0;
  if (total === 0) W.v_loadDur[i] = 1.5;
}


// ---------------------------------------------------------------- farmer loading support
// point ~1.3 m behind the tail on the truck's axis (lat = sideways offset, + = truck-left); the truck is stationary while loading
export function truckRear(W, i, lat, out) {
  const h = W.v_h[i], d = KIND[W.v_kind[i]].hl + 1.3;
  out[0] = W.v_x[i] - Math.sin(h) * d + Math.cos(h) * lat; out[1] = W.v_z[i] - Math.cos(h) * d - Math.sin(h) * lat;
}
export function truckLoadable(W, i) { return i >= 0 && i < MAX_TRUCKS && W.v_active[i] === 1 && W.v_state[i] === TruckState.LOADING && W.v_auto[i] === 0; }
function sum3(a, o) { return a[o] + a[o + 1] + a[o + 2]; }
function shownSlots(W, i) {                                    // cargo slots that have landed on the bed (0..v_slots)
  const o = i * 3, tot = sum3(W.v_plan, o), ld = sum3(W.v_loaded, o), K = W.v_slots[i];
  if (tot <= 0 || K <= 0) return 0;
  return ld >= tot ? K : Math.floor(ld * K / tot);
}
// remaining need per kind (planned - loaded - already reserved), limited by free stock; returns the total
const _need = new Int32Array(3);
export function loadNeed(W, i, out = _need) {
  const o = i * 3; let t = 0;
  for (let k = 0; k < 3; k++) {
    let n = W.v_plan[o + k] - W.v_loaded[o + k] - W.v_carry[o + k];
    const free = stockOf(W, ITEM[k]) - W.truckRes[k];
    if (n > free) n = free;
    out[k] = n > 0 ? n : 0; t += out[k];
  }
  return t;
}
function addLoaded(W, i, k, n, auto) {
  const before = shownSlots(W, i);
  W.v_loaded[i * 3 + k] += n; W.stats.shipped[ITEM[k]] += n;
  const after = shownSlots(W, i);
  if (after > before) { W.v_dropA[i] = before; W.v_dropB[i] = after; W.v_dropT[i] = W.time; W.v_dropAuto[i] = auto ? 1 : 0; }
}
// farmer f (arrived at the storehouse door) reserves a load for truck i. Returns the item kind index (0 egg, 1 milk, 2 wool) or -1.
export function reserveLoad(W, i, f) {
  if (!truckLoadable(W, i) || loadNeed(W, i) <= 0) return -1;
  let k = 0, best = -1;
  for (let q = 0; q < 3; q++) if (_need[q] > best) { best = _need[q]; k = q; }
  const cap = k === 0 ? 4 + (f % 3) : TRIP_CAP[k];
  const n = best < cap ? best : cap;
  W.f_resv[f] = n; W.f_resvKind[f] = k;
  W.truckRes[k] += n; W.v_carry[i * 3 + k] += n; W.v_prog[i] = W.time;
  return k;
}
// farmer hands n goods of kind k to truck i. Reservation moves into the cargo count.
export function deliverLoad(W, i, f, k, n) {
  const r = W.f_resv[f];
  if (n > r) n = r;
  W.truckRes[k] -= r; W.v_carry[i * 3 + k] -= r; W.f_resv[f] = 0;
  if (n > 0) { addLoaded(W, i, k, n, false); W.stats.farmerLoads++; W.stats.farmerLoadGoods += n; }
  W.v_prog[i] = W.time;
}
// drop farmer f's loading job and give its reservation back (carried item despawn is the caller's / resetFarmer's business)
export function releaseLoadJob(W, f) {
  const j = W.f_job[f], r = W.f_resv[f];
  if (r > 0) {
    const k = W.f_resvKind[f];
    W.truckRes[k] = Math.max(0, W.truckRes[k] - r);
    if (j >= 0 && j < MAX_TRUCKS) W.v_carry[j * 3 + k] = Math.max(0, W.v_carry[j * 3 + k] - r);
  }
  W.f_resv[f] = 0; W.f_job[f] = -1; W.f_jobAge[f] = 0;
}
function jobCount(W, i, pending) {                              // farmers working on truck i (pending: only those without a reservation yet)
  let n = 0;
  for (let f = 0; f < W.farmerCount; f++) if (W.f_job[f] === i && (!pending || W.f_resv[f] === 0)) n++;
  return n;
}
// Called from tasks.js before task claiming: assign idle farmers to truck loading. Collectors first; anybody once the load has been
// open > COLLECTOR_ONLY_S or when no collector is free. At most LOAD_HELPERS per truck.
let preemptHook = null;
export function setPreemptHook(fn) { preemptHook = fn; }        // farmers.js: reopen the farmer's claimed task and reset it to idle
export function offerLoaders(W) {
  const nf = W.farmerCount;
  if (nf === 0 || !W.v_active) return;
  for (let i = 0; i < MAX_TRUCKS; i++) {
    if (!truckLoadable(W, i)) continue;
    const need = loadNeed(W, i);
    if (need <= 0) continue;
    const jobs = jobCount(W, i, false), pend = jobCount(W, i, true);
    let add = Math.ceil(need / 5) - pend;
    if (add > LOAD_HELPERS - jobs) add = LOAD_HELPERS - jobs;
    const open = W.v_timer[i];
    while (add-- > 0) {
      let bc = -1, bcd = 1e12, bo = -1, bod = 1e12;
      for (let f = 0; f < nf; f++) {
        if (W.f_task[f] >= 0 || W.f_job[f] >= 0) continue;
        const st = W.f_state[f];
        if (st !== FState.IDLE && st !== FState.WANDER && st !== FState.LEAN) continue;
        const dx = W.f_px[f] - DOOR.x, dz = W.f_pz[f] - DOOR.z, d = dx * dx + dz * dz;
        if ((W.f_type[f] & 3) === FarmerType.COLLECTOR) { if (d < bcd) { bcd = d; bc = f; } }
        else if (d < bod) { bod = d; bo = f; }
      }
      let pick = -1;
      if (bc >= 0 && (open <= COLLECTOR_ONLY_S || bo < 0 || Math.sqrt(bcd) <= Math.sqrt(bod) + 25)) pick = bc;   // a collector, unless (open > 10 s) a non-collector is much closer
      else pick = bo >= 0 ? bo : bc;
      if (pick < 0 && open > PREEMPT_S && preemptHook && jobCount(W, i, false) === 0) {      // everybody is busy: interrupt a farmer who is just walking to a task
        let bd = 1e12;
        for (let f = 0; f < nf; f++) {
          if (W.f_task[f] < 0 || W.f_job[f] >= 0 || W.f_state[f] !== FState.MOVE || W.f_carry[f] > 0) continue;
          const dx = W.f_px[f] - DOOR.x, dz = W.f_pz[f] - DOOR.z, d = dx * dx + dz * dz - (((W.f_type[f] & 3) === FarmerType.COLLECTOR) ? 625 : 0);
          if (d < bd) { bd = d; pick = f; }
        }
        if (pick >= 0) preemptHook(W, pick);
      }
      if (pick < 0) break;
      W.f_job[pick] = i; W.f_step[pick] = 0; W.f_target[pick] = -1; W.f_resv[pick] = 0; W.f_jobAge[pick] = 0;
      W.v_began[i] = 1; W.v_prog[i] = W.time;
    }
  }
}
function startAuto(W, i) {                                      // fall back to ghost loading for the rest of this visit
  for (let f = 0; f < W.farmerCount; f++) if (W.f_job[f] === i) releaseLoadJob(W, f);
  const o = i * 3;
  for (let k = 0; k < 3; k++) { W.v_carry[o + k] = 0; W.v_base[o + k] = W.v_loaded[o + k]; }
  const tot = sum3(W.v_plan, o), rem = tot > 0 ? (tot - sum3(W.v_loaded, o)) / tot : 0;
  W.v_auto[i] = 1; W.v_autoT[i] = 0;
  W.v_loadDur[i] = Math.max(3, W.v_loadDur[i] * (rem > 0 ? rem : 0));
  W.stats.autoLoads++;
}

function dispatch(W, T) {
  const t = W.time;
  if (!T.init) { T.init = true; T.nextAt = t + GAP_MIN + W.rand() * GAP_RAND; T.lastVisit = t; }
  const total = refreshStock(W);
  if (T.active >= MAX_ACTIVE || t < T.nextAt) return;
  if (W.hour < DAY_FROM || W.hour >= DAY_TO) return;                   // trucks only come during the day
  if (!((total >= STOCK_MIN) || (total >= STOCK_IDLE_MIN && t - T.lastVisit >= IDLE_SECONDS))) return;
  if (spawnTruck(W, pickKind(W, T)) >= 0) T.nextAt = t + GAP_MIN + W.rand() * GAP_RAND;
}

function bayBusy(W, self) {                                   // another truck inside the bay manoeuvre
  for (let j = 0; j < MAX_TRUCKS; j++) {
    if (j === self || !W.v_active[j]) continue;
    const st = W.v_state[j];
    if (st === TruckState.REVERSE || st === TruckState.LOADING || st === TruckState.PAUSE) return true;
    if (st === TruckState.DEPART && W.v_s[j] < S_ARC_END + 6) return true;
  }
  return false;
}

// true when a farmer stands within FARMER_AHEAD metres of the leading edge (in the direction of travel), inside the body width
function farmerAhead(W, i, dir, v) {
  const n = W.farmerCount; if (n === 0) return false;
  const kd = KIND[W.v_kind[i]], h = W.v_h[i], x = W.v_x[i], z = W.v_z[i];
  const mx = Math.sin(h) * dir, mz = Math.cos(h) * dir, lim = kd.hl + FARMER_AHEAD + v * v / (2 * A_BRAKE * 1.4), lw = kd.hw + 0.7;
  const fx = W.f_px, fz = W.f_pz;
  for (let f = 0; f < n; f++) {
    const dx = fx[f] - x, dz = fz[f] - z;
    if (dx > 12 || dx < -12 || dz > 12 || dz < -12) continue;
    const a = dx * mx + dz * mz;
    if (a < -1 || a > lim) continue;
    const l = dx * mz - dz * mx;
    if (l < lw && l > -lw) return true;
  }
  return false;
}

// ---------------------------------------------------------------- update (once per sim tick, after farmers)
export function updateTrucks(W, dt = SIM_DT) {
  const T = ensureTrucks(W);
  dispatch(W, T);
  let loading = 0;
  for (let i = 0; i < MAX_TRUCKS; i++) {
    if (!W.v_active[i]) continue;
    W.v_px[i] = W.v_x[i]; W.v_pz[i] = W.v_z[i]; W.v_ph[i] = W.v_h[i]; W.v_pwheel[i] = W.v_wheel[i];
    W.v_age[i] += dt;
    let st = W.v_state[i], v = W.v_v[i], s = W.v_s[i];
    const kd = KIND[W.v_kind[i]];

    if (st === TruckState.LOADING) {
      loading++;
      W.v_timer[i] += dt; v = 0; W.v_acc[i] *= 0.8;
      const o = i * 3, planT = sum3(W.v_plan, o);
      let done = false;
      if (planT === 0) done = W.v_timer[i] >= W.v_loadDur[i];
      else if (W.v_auto[i]) {
        W.v_autoT[i] += dt;
        const u = Math.min(1, W.v_autoT[i] / W.v_loadDur[i]);
        for (let k = 0; k < 3; k++) {
          const want = W.v_base[o + k] + Math.floor((W.v_plan[o + k] - W.v_base[o + k]) * u + (u >= 1 ? 0.5 : 0));
          if (want > W.v_loaded[o + k]) addLoaded(W, i, k, want - W.v_loaded[o + k], true);
        }
        done = u >= 1;
      } else if (sum3(W.v_loaded, o) >= planT) done = true;
      else {
        if (jobCount(W, i, false) > 0) W.v_prog[i] = W.time;
        if (W.farmerCount === 0 || (!W.v_began[i] && W.v_timer[i] > NO_LOADER_S) || (W.v_began[i] && W.time - W.v_prog[i] > STALL_S) || W.v_timer[i] > MAX_LOAD_S) startAuto(W, i);
      }
      if (done) {
        W.stats.trucksVisited++; T.lastVisit = W.time;
        st = W.v_state[i] = TruckState.PAUSE; W.v_timer[i] = 0;
      }
    } else if (st === TruckState.PAUSE) {
      W.v_timer[i] += dt; v = 0;
      if (W.v_timer[i] >= 1.6) { st = W.v_state[i] = TruckState.DEPART; W.v_path[i] = 1; s = 0; W.v_timer[i] = 0; }
    } else {
      // ---- driving states (APPROACH / REVERSE / DEPART): speed-profile along the path
      const path = PATHS[W.v_path[i]];
      pathAt(path, s, _o);
      let vd = _o[4];
      let dir = _o[3];
      if (st === TruckState.APPROACH) {
        let sStop = S_STOP;
        if (s <= S_HOLD + 0.3 && bayBusy(W, i)) sStop = S_HOLD;
        const rem = sStop - s, vs = Math.sqrt(2 * A_BRAKE * 0.8 * (rem > 0 ? rem : 0)) + (rem > 0.05 ? 0.2 : 0);
        if (vs < vd) vd = vs;
        if (rem < 0.04 && v < 0.2) {
          v = 0; s = sStop; vd = 0;
          if (sStop === S_STOP) { W.v_timer[i] += dt; if (W.v_timer[i] > 0.9) { st = W.v_state[i] = TruckState.REVERSE; W.v_timer[i] = 0; } }
        }
      } else if (st === TruckState.REVERSE) {
        const rem = S_PARK - s, vs = Math.sqrt(2 * A_BRAKE * 0.5 * (rem > 0 ? rem : 0)) + 0.18;
        if (vs < vd) vd = vs;
      }
      // follow the vehicle ahead on the same path
      for (let j = 0; j < MAX_TRUCKS; j++) {
        if (j === i || !W.v_active[j] || W.v_path[j] !== W.v_path[i] || W.v_s[j] <= s) continue;
        const gap = W.v_s[j] - s - KIND[W.v_kind[j]].hl - kd.hl - 2.5;
        const va = gap > 0 ? Math.sqrt(2 * A_BRAKE * 0.7 * gap) : 0;
        if (va < vd) vd = va;
      }
      // yield to farmers in the way
      let blocked = false;
      if (v > 0.01 || vd > 0.01) {
        if (W.v_blocked[i] < 25 && farmerAhead(W, i, dir, v)) { blocked = true; vd = 0; }
      }
      W.v_blocked[i] = blocked ? W.v_blocked[i] + dt : Math.max(0, W.v_blocked[i] - dt * 2);
      let nv;
      const bk = blocked ? A_BRAKE * 1.6 : A_BRAKE;
      if (vd > v) { nv = v + A_ACC * dt; if (nv > vd) nv = vd; } else { nv = v - bk * dt; if (nv < vd) nv = vd; }
      if (nv < 0) nv = 0;
      let ns = s + (v + nv) * 0.5 * dt;
      W.v_acc[i] += (((nv - v) / dt) - W.v_acc[i]) * 0.12;
      v = nv;
      if (st === TruckState.REVERSE && (S_PARK - ns < 0.03 || (S_PARK - ns < 0.25 && v < 0.3))) {
        ns = S_PARK; v = 0; st = W.v_state[i] = TruckState.LOADING; W.v_timer[i] = 0;
        planLoad(W, i);
      }
      s = ns;
      pathAt(path, s, _o);
      W.v_x[i] = _o[0]; W.v_z[i] = _o[1]; W.v_h[i] = _o[2]; W.v_dir[i] = _o[3];
      const steer = Math.atan(WHEELBASE * _o[5]);
      W.v_steer[i] = steer > 0.6 ? 0.6 : steer < -0.6 ? -0.6 : steer;
      W.v_wheel[i] += _o[3] * (v * dt) / WHEEL_R;
      if (st === TruckState.DEPART && s >= path.len - 0.02) {              // off the map: despawn
        W.v_active[i] = 0; W.v_state[i] = TruckState.NONE; T.active--; continue;
      }
    }
    W.v_v[i] = v; W.v_s[i] = s;
    if (v < 0.05) W.v_steer[i] *= 0.9;
    W.v_brake[i] = v < 0.05 ? 1 : (W.v_acc[i] < -0.4 ? 1 : 0);
  }
  T.loading = loading;
  // goods item hopping: nothing to simulate (renderer derives it from state + timer)
}

export function getTruckStats(W) {
  const T = ensureTrucks(W);
  refreshStock(W);
  let loaders = 0; for (let f = 0; f < W.farmerCount; f++) if (W.f_job[f] >= 0) loaders++;
  return { active: T.active, loading: T.loading, visits: W.stats.trucksVisited, spawned: W.stats.trucksSpawned, shipped: W.stats.shipped, stock: W.truckStock,
    farmerLoads: W.stats.farmerLoads, farmerLoadGoods: W.stats.farmerLoadGoods, autoLoads: W.stats.autoLoads, loaders };
}
