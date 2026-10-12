// Truck sim + renderer tests (Node): lane geometry, visit cycle, accounting, yielding, bay exclusion, 900 s with real farmers, mock-GL renderer.
import assert from 'node:assert/strict';
import { PENS, BUILDINGS, SIM_DT, ItemKind, ItemState, AFlag } from '../src/config.js';
import * as WM from '../src/ecs/world.js';
import { updateTasks } from '../src/sim/tasks.js';
import { updateFarmers } from '../src/sim/farmers.js';
import {
  updateTrucks, getTruckStats, spawnTruck, PATH_IN, PATH_OUT, LANE, KIND, MAX_TRUCKS, MAX_ACTIVE, TruckState, TruckKind, inLane, S_PARK,
} from '../src/sim/trucks.js';
import { createTruckRenderer } from '../src/render/trucks.js';
const { createWorld, setAnimalCount, setFarmerCount, initialSeed, snapshotPrev, advanceClock, spawnItem } = WM;

let n = 0; const T = (name, fn) => { fn(); console.log('  ok', name); n++; };
const ITEMS = [ItemKind.EGG, ItemKind.MILK, ItemKind.WOOL];

// footprint (oriented rectangle) helpers --------------------------------------------------------------------------------------------
function corners(W, i, out, margin = 0) {
  const k = KIND[W.v_kind[i]], h = W.v_h[i], x = W.v_x[i], z = W.v_z[i];
  const fx = Math.sin(h), fz = Math.cos(h), lx = Math.cos(h), lz = -Math.sin(h), hl = k.hl + margin, hw = k.hw + margin;
  let o = 0;
  for (const [a, b] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) { out[o++] = x + fx * hl * a + lx * hw * b; out[o++] = z + fz * hl * a + lz * hw * b; }
  return out;
}
const RECTS = [BUILDINGS.STOREHOUSE, BUILDINGS.VET_SHED, BUILDINGS.COMPOST, BUILDINGS.BARN, BUILDINGS.FARMHOUSE, ...PENS.map(p => ({ x0: p.x0, x1: p.x1, z0: p.z0, z1: p.z1 }))];
function hitsBuilding(c) {                          // polygon corners / edge samples vs axis-aligned rects
  for (const r of RECTS) {
    for (let e = 0; e < 4; e++) {
      const ax = c[e * 2], az = c[e * 2 + 1], bx = c[((e + 1) % 4) * 2], bz = c[((e + 1) % 4) * 2 + 1];
      for (let s = 0; s <= 8; s++) { const x = ax + (bx - ax) * s / 8, z = az + (bz - az) * s / 8; if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) return r; }
    }
  }
  return null;
}
function overlap(c1, c2) {                          // SAT on two convex quads
  for (const c of [c1, c2]) for (let e = 0; e < 4; e++) {
    const ax = c[e * 2], az = c[e * 2 + 1], bx = c[((e + 1) % 4) * 2], bz = c[((e + 1) % 4) * 2 + 1], nx = -(bz - az), nz = bx - ax;
    let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
    for (let k = 0; k < 4; k++) { const p = c1[k * 2] * nx + c1[k * 2 + 1] * nz, q = c2[k * 2] * nx + c2[k * 2 + 1] * nz; a0 = Math.min(a0, p); a1 = Math.max(a1, p); b0 = Math.min(b0, q); b1 = Math.max(b1, q); }
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
}

function makeMonitor() {
  const m = { maxSpeed: 0, nan: 0, maxActive: 0, outLane: 0, hitBuilding: null, overlaps: 0, maxJump: 0, states: new Set(), kinds: new Set(), c1: new Float64Array(8), c2: new Float64Array(8), bayDouble: 0, stillMax: 0 };
  const still = new Float64Array(MAX_TRUCKS);
  m.check = W => {
    let act = 0, bay = 0;
    for (let i = 0; i < MAX_TRUCKS; i++) {
      if (!W.v_active[i]) { still[i] = 0; continue; }
      act++; m.states.add(W.v_state[i]); m.kinds.add(W.v_kind[i]);
      const x = W.v_x[i], z = W.v_z[i], v = W.v_v[i], h = W.v_h[i];
      if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(v) || !Number.isFinite(h) || !Number.isFinite(W.v_wheel[i])) { m.nan++; continue; }
      m.maxSpeed = Math.max(m.maxSpeed, v);
      m.maxJump = Math.max(m.maxJump, Math.hypot(x - W.v_px[i], z - W.v_pz[i]));
      if (!inLane(x, z)) m.outLane++;
      const st = W.v_state[i];
      if (st === TruckState.REVERSE || st === TruckState.LOADING || st === TruckState.PAUSE) bay++;
      corners(W, i, m.c1);
      const hb = hitsBuilding(m.c1); if (hb && !m.hitBuilding) m.hitBuilding = hb;
      if (v < 0.05 && st !== TruckState.LOADING && st !== TruckState.PAUSE) still[i] += SIM_DT; else still[i] = 0;
      m.stillMax = Math.max(m.stillMax, still[i]);
      for (let j = i + 1; j < MAX_TRUCKS; j++) if (W.v_active[j]) { corners(W, j, m.c2); if (overlap(m.c1, m.c2)) m.overlaps++; }
    }
    if (act > m.maxActive) m.maxActive = act;
    if (bay > 1) m.bayDouble++;
  };
  return m;
}
function checkAccounting(W) {
  const d = W.stats.delivered, s = W.stats.shipped;
  for (const k of ITEMS) assert.ok(s[k] <= d[k], `shipped[${k}] ${s[k]} <= delivered ${d[k]}`);
  assert.equal(s[ItemKind.MANURE], 0, 'manure never shipped');
  for (let k = 0; k < 3; k++) assert.ok(W.truckStock[k] >= 0);
}
const run = (W, secs, mon, extra) => { for (let k = 0, N = Math.round(secs / SIM_DT); k < N; k++) { if (extra) extra(k); advanceClock(W, SIM_DT); updateTrucks(W, SIM_DT); if (mon) mon.check(W); } };

T('lane geometry: ends, parked pose, turning radius, no building / pen on any swept footprint', () => {
  const P = PATH_IN, Q = PATH_OUT;
  assert.ok(Math.abs(P.px[0] - LANE.XS) < 1e-3 && Math.abs(P.pz[0] - LANE.ZI) < 1e-3, 'spawns on the east edge lane');
  assert.ok(LANE.XS > 160, 'spawn is beyond the +160 map edge');
  assert.ok(Math.abs(Q.px[Q.n - 1] - LANE.XS) < 0.3 && Math.abs(Q.pz[Q.n - 1] - LANE.ZO) < 1e-3, 'leaves along the eastbound lane');
  const iPark = Math.round(S_PARK / 0.25);
  assert.ok(Math.abs(P.px[iPark] - LANE.BAY.x) < 0.02 && Math.abs(P.pz[iPark] - LANE.BAY.z) < 0.02, 'parked at the bay');
  assert.ok(Math.abs(Math.abs(P.ph[iPark]) - Math.PI) < 1e-3, 'parked heading north (tail toward the storehouse door)');
  assert.ok(Math.abs(Q.px[0] - LANE.BAY.x) < 0.02 && Math.abs(Q.pz[0] - LANE.BAY.z) < 0.02, 'outbound path starts at the bay');
  assert.ok(Math.abs(P.ph[iPark] - Q.ph[0]) < 1e-3, 'heading continuous at the bay');
  let kmax = 0;
  for (const path of [P, Q]) for (let i = 0; i < path.n; i++) {
    assert.ok(Number.isFinite(path.px[i]) && Number.isFinite(path.pz[i]) && Number.isFinite(path.ph[i]));
    if (i) assert.ok(Math.abs(path.ph[i] - path.ph[i - 1]) < 0.06, 'smooth heading');
    kmax = Math.max(kmax, Math.abs(path.pk[i]));
    if (path.px[i] < 172.01 && path.px[i] > -1) assert.ok(inLane(path.px[i], path.pz[i]), `path point inside the lane polygon (${path.px[i].toFixed(1)}, ${path.pz[i].toFixed(1)})`);
  }
  assert.ok(1 / kmax >= 6.3, `min turning radius ${(1 / kmax).toFixed(1)} m`);
  // swept footprints of every kind (sampled every 1 m along both paths) keep 1 m clear of every building and pen
  const W = createWorld({ seed: 1 }), c = new Float64Array(8);
  for (let kind = 0; kind < 3; kind++) {
    W.v_kind[0] = kind;
    for (const path of [P, Q]) for (let i = 0; i < path.n; i += 4) {
      W.v_x[0] = path.px[i]; W.v_z[0] = path.pz[i]; W.v_h[0] = path.ph[i];
      const hit = hitsBuilding(corners(W, 0, c, 1.0));
      assert.ok(!hit, `${JSON.stringify(hit)} kind ${kind} footprint at (${path.px[i].toFixed(1)}, ${path.pz[i].toFixed(1)}) overlaps a building`);
    }
  }
  // lane stays clear of the env gravel lane intersections? parked tail is > 1.5 m from the storehouse wall and the door is 9 m away
  assert.ok(BUILDINGS.STOREHOUSE.x0 - (LANE.BAY.x + KIND[0].hw) >= 1.5);
});

T('manual spawn: one inbound truck at a time, max 2 active', () => {
  const W = createWorld({ seed: 9 });
  assert.equal(spawnTruck(W, TruckKind.PICKUP), 0);
  assert.equal(spawnTruck(W, TruckKind.VAN), -1, 'second inbound refused while the first is still approaching');
  assert.equal(spawnTruck(W, 3), -1);
  assert.equal(getTruckStats(W).active, 1);
  assert.ok(MAX_ACTIVE <= 2);
});

T('visit cycle for every kind: states in order, 8-12 s load, accounting, lane, no overlap', () => {
  for (let kind = 0; kind < 3; kind++) {
    const W = createWorld({ seed: 30 + kind }), mon = makeMonitor();
    W.stats.delivered[ItemKind.EGG] = 14; W.stats.delivered[ItemKind.MILK] = kind === 2 ? 40 : 6; W.stats.delivered[ItemKind.WOOL] = 9;
    W.truck.init = true; W.truck.nextAt = 1e9;
    const slot = spawnTruck(W, kind);
    assert.equal(slot, 0);
    const seq = []; let loadStart = -1, loadEnd = -1, prevLoaded = 0, mono = true, parkX = 0, parkZ = 0, maxV = 0, revMax = 0;
    for (let k = 0; k < 30 * 120; k++) {
      advanceClock(W, SIM_DT); updateTrucks(W, SIM_DT); mon.check(W);
      if (!W.v_active[slot]) break;
      const st = W.v_state[slot];
      if (seq[seq.length - 1] !== st) seq.push(st);
      maxV = Math.max(maxV, W.v_v[slot]);
      if (st === TruckState.REVERSE) revMax = Math.max(revMax, W.v_v[slot]);
      if (st === TruckState.LOADING) {
        if (loadStart < 0) { loadStart = W.time; parkX = W.v_x[slot]; parkZ = W.v_z[slot]; assert.equal(W.v_v[slot], 0); }
        const o = slot * 3, tot = W.v_loaded[o] + W.v_loaded[o + 1] + W.v_loaded[o + 2];
        if (tot < prevLoaded) mono = false; prevLoaded = tot;
      } else if (loadStart >= 0 && loadEnd < 0) loadEnd = W.time;
    }
    assert.deepEqual(seq, [TruckState.APPROACH, TruckState.REVERSE, TruckState.LOADING, TruckState.PAUSE, TruckState.DEPART], 'state order');
    assert.ok(!W.v_active[slot], 'despawned beyond the edge');
    assert.ok(Math.abs(parkX - LANE.BAY.x) < 0.02 && Math.abs(parkZ - LANE.BAY.z) < 0.02, 'parked at the bay');
    const dur = loadEnd - loadStart;
    assert.ok(dur >= 8 - 0.15 && dur <= 12 + 0.15, `load ${dur.toFixed(1)} s in 8..12`);
    assert.ok(mono && prevLoaded > 0);
    assert.ok(maxV >= 5 && maxV <= 7, `lane speed ${maxV.toFixed(2)} m/s in 5..7`);
    assert.ok(revMax <= 2.6, 'slow reversing');
    assert.equal(W.stats.trucksVisited, 1);
    checkAccounting(W);
    const sh = W.stats.shipped;
    if (kind === TruckKind.TANKER) { assert.ok(sh[ItemKind.MILK] > 0 && sh[ItemKind.MILK] <= KIND[2].cap, 'tanker ships milk only'); assert.equal(sh[ItemKind.EGG] + sh[ItemKind.WOOL], 0); }
    else { assert.ok(sh[0] + sh[1] + sh[2] === Math.min(KIND[kind].cap, 29), `${KIND[kind].cap}-good bed: shipped ${sh[0] + sh[1] + sh[2]}`); }
    assert.equal(mon.nan, 0); assert.equal(mon.outLane, 0, 'centre stays in the lane polygon');
    assert.equal(mon.hitBuilding, null, 'never touches a building or pen'); assert.ok(mon.maxJump < 0.3, 'no teleports');
    // stock decremented consistently
    const d = W.stats.delivered;
    assert.equal(W.truckStock[0], d[0] - sh[0]); assert.equal(W.truckStock[1], d[1] - sh[1]); assert.equal(W.truckStock[2], d[2] - sh[2]);
  }
});

T('dispatch rules: thresholds, random 75-150 s gap, idle rule, kind selection, no teleport on pause-sized dt', () => {
  // below threshold: no visit before the 240 s idle rule
  const W = createWorld({ seed: 4 });
  W.stats.delivered[ItemKind.EGG] = 3;
  let first = -1;
  run(W, 400, null, () => { if (first < 0 && W.v_active[0]) first = W.time; });
  assert.ok(first >= 239 && first < 245, `idle rule dispatches at ~240 s (${first.toFixed(1)})`);
  // at threshold: first truck inside 75..150 s
  const W2 = createWorld({ seed: 5 });
  W2.stats.delivered[ItemKind.EGG] = 8;
  let t2 = -1; run(W2, 200, null, () => { if (t2 < 0 && W2.v_active[0]) t2 = W2.time; });
  assert.ok(t2 >= 74.9 && t2 <= 150.5, `threshold dispatch in 75..150 s (${t2.toFixed(1)})`);
  // milk-heavy stock -> tanker
  const W3 = createWorld({ seed: 6 });
  W3.stats.delivered[ItemKind.MILK] = 20; W3.stats.delivered[ItemKind.EGG] = 3;
  run(W3, 160);
  assert.ok(W3.v_active[0] || W3.stats.trucksSpawned > 0); assert.equal(W3.v_kind[0], TruckKind.TANKER);
  // eggs / wool -> pickup or van, varies over visits
  const W4 = createWorld({ seed: 7 }), kinds = new Set();
  run(W4, 1500, null, k => { if (k % 60 === 0) { W4.stats.delivered[ItemKind.EGG] += 5; W4.stats.delivered[ItemKind.WOOL] += 3; } for (let i = 0; i < MAX_TRUCKS; i++) if (W4.v_active[i]) kinds.add(W4.v_kind[i]); });
  assert.ok(kinds.has(TruckKind.PICKUP) && kinds.has(TruckKind.VAN) && !kinds.has(TruckKind.TANKER), `kinds ${[...kinds]}`);
  assert.ok(W4.stats.trucksVisited >= 5, `visits ${W4.stats.trucksVisited}`);
});

T('yields to a farmer in the way, then continues; ignores farmers behind', () => {
  const W = createWorld({ seed: 8 });
  W.stats.delivered[ItemKind.EGG] = 20; W.truck.init = true; W.truck.nextAt = 1e9;
  setFarmerCount(W, 1);
  spawnTruck(W, TruckKind.PICKUP);
  W.f_px[0] = 140; W.f_pz[0] = LANE.ZI;                  // standing in the inbound lane ahead
  run(W, 12);
  assert.equal(W.v_state[0], TruckState.APPROACH);
  assert.ok(W.v_v[0] < 0.05, 'stopped for the farmer');
  const lead = W.v_x[0] - KIND[0].hl;
  assert.ok(lead >= 140 + 0.9 && lead <= 140 + 4.5, `stopped ${(lead - 140).toFixed(2)} m short of the farmer`);
  W.f_px[0] = 140; W.f_pz[0] = LANE.ZI + 6;               // walked off the lane
  run(W, 4);
  assert.ok(W.v_x[0] < 138, 'moves on once the way is clear');
  W.f_px[0] = W.v_x[0] + 20; W.f_pz[0] = LANE.ZI;          // farmer behind the truck's direction of travel does not matter
  const x0 = W.v_x[0]; run(W, 1);
  assert.ok(W.v_x[0] !== x0 || W.v_state[0] !== TruckState.APPROACH);
});

T('two trucks: second holds until the bay manoeuvre is finished; footprints never overlap', () => {
  const W = createWorld({ seed: 12 }), mon = makeMonitor();
  W.stats.delivered[ItemKind.EGG] = 30; W.stats.delivered[ItemKind.WOOL] = 30; W.truck.init = true; W.truck.nextAt = 1e9;
  spawnTruck(W, TruckKind.PICKUP);
  let second = -1, holdSeen = false, secondDepart = -1;
  for (let k = 0; k < 30 * 150; k++) {
    advanceClock(W, SIM_DT); updateTrucks(W, SIM_DT); mon.check(W);
    if (second < 0 && W.v_state[0] === TruckState.REVERSE) second = spawnTruck(W, TruckKind.VAN);
    if (second >= 0 && W.v_active[second] && W.v_active[0] && W.v_state[second] === TruckState.APPROACH && W.v_v[second] < 0.05 && W.v_x[second] > 154 && W.v_x[second] < 157) holdSeen = true;
    if (second >= 0 && W.v_active[second] && W.v_state[second] === TruckState.DEPART && secondDepart < 0) secondDepart = W.time;
  }
  assert.ok(second > 0, 'second truck spawned'); assert.ok(holdSeen, 'second truck waited at the hold point');
  assert.ok(secondDepart > 0, 'second truck was served');
  assert.equal(W.stats.trucksVisited, 2); assert.equal(mon.bayDouble, 0, 'never two trucks in the bay manoeuvre');
  assert.equal(mon.overlaps, 0, 'no footprint overlap'); assert.equal(mon.outLane, 0); assert.equal(mon.hitBuilding, null); assert.ok(mon.maxActive <= 2);
  checkAccounting(W);
});


// loading invariants: reservations are consistent, carried items match f_carry, stock never negative
function loadInvariants(W) {
  const res = [0, 0, 0], car = [0, 0, 0];
  for (let f = 0; f < W.farmerCount; f++) if (W.f_resv[f] > 0) res[W.f_resvKind[f]] += W.f_resv[f];
  for (let i = 0; i < MAX_TRUCKS; i++) for (let k = 0; k < 3; k++) car[k] += W.v_carry[i * 3 + k];
  for (let k = 0; k < 3; k++) {
    assert.equal(W.truckRes[k], res[k], `truckRes[${k}] ${W.truckRes[k]} == sum f_resv ${res[k]}`);
    assert.equal(car[k], res[k], `v_carry[${k}] ${car[k]} == sum f_resv ${res[k]}`);
    assert.ok(W.stats.delivered[ITEMS[k]] - W.stats.shipped[ITEMS[k]] - W.truckRes[k] >= 0, 'delivered - shipped - reserved >= 0');
  }
  let carried = 0, held = 0;
  for (let i = 0; i < W.itemHigh; i++) if (W.i_alive[i] && W.i_state[i] === ItemState.CARRIED) { carried++; assert.ok(W.i_carrier[i] < W.farmerCount, 'carrier alive'); }
  for (let f = 0; f < W.farmerCount; f++) held += W.f_carry[f];
  assert.equal(carried, held, 'carried items == sum f_carry');
}
const farmTick = W => { snapshotPrev(W); advanceClock(W, SIM_DT); updateTasks(W, SIM_DT); updateFarmers(W, SIM_DT); updateTrucks(W, SIM_DT); };

T('farmers load the truck: door -> tail, carried goods, count grows on hand-over, departs after loaded', () => {
  for (const kind of [TruckKind.PICKUP, TruckKind.VAN, TruckKind.TANKER]) {
    const W = createWorld({ seed: 70 + kind }), mon = makeMonitor();
    setAnimalCount(W, 0); setFarmerCount(W, 8); initialSeed(W);
    W.stats.delivered[ItemKind.EGG] = kind === TruckKind.TANKER ? 0 : 20; W.stats.delivered[ItemKind.MILK] = kind === TruckKind.TANKER ? 40 : 4; W.stats.delivered[ItemKind.WOOL] = kind === TruckKind.TANKER ? 0 : 6;
    W.truck.init = true; W.truck.nextAt = 1e9;
    for (let f = 0; f < 8; f++) { W.f_px[f] = W.f_ppx[f] = 120 + f * 2; W.f_pz[f] = W.f_ppz[f] = 2; }
    const slot = spawnTruck(W, kind);
    let sawCarry = 0, maxHelpers = 0, loadStart = -1, finished = false, collectorFirst = false, maxCarryGoods = 0;
    for (let k = 0; k < 30 * 240 && !finished; k++) {
      farmTick(W); mon.check(W); if (k % 15 === 0) loadInvariants(W);
      const st = W.v_state[slot];
      if (st === TruckState.LOADING) {
        if (loadStart < 0) loadStart = W.time;
        let helpers = 0;
        for (let f = 0; f < W.farmerCount; f++) if (W.f_job[f] === slot) {
          helpers++;
          if (W.f_carry[f] > 0) { sawCarry++; maxCarryGoods = Math.max(maxCarryGoods, W.f_carry[f]); assert.equal(W.f_carryKind[f], ITEMS[W.f_resvKind[f]]); if (kind === TruckKind.TANKER) assert.equal(W.f_carryKind[f], ItemKind.MILK); }
          if (helpers === 1 && (W.f_type[f] & 3) === 1) collectorFirst = true;
        }
        maxHelpers = Math.max(maxHelpers, helpers);
      }
      if (st === TruckState.PAUSE && !finished) {
        finished = true;
        const o = slot * 3;
        assert.ok(W.v_loaded[o] === W.v_plan[o] && W.v_loaded[o + 1] === W.v_plan[o + 1] && W.v_loaded[o + 2] === W.v_plan[o + 2], 'leaves only after the planned cargo is aboard');
        assert.equal(W.v_carry[o] + W.v_carry[o + 1] + W.v_carry[o + 2], 0, 'nobody still carrying toward it');
      }
    }
    assert.ok(finished, 'visit completed'); run(W, 0);
    assert.equal(W.stats.autoLoads, 0, 'no ghost loading in the normal case');
    assert.ok(W.stats.farmerLoads >= 2 && W.stats.farmerLoadGoods > 0, `farmer hand-overs ${W.stats.farmerLoads}`);
    assert.equal(W.stats.farmerLoadGoods, W.stats.shipped[0] + W.stats.shipped[1] + W.stats.shipped[2], 'every shipped good was handed over by a farmer');
    assert.ok(sawCarry > 30, 'goods visibly carried'); assert.ok(maxHelpers >= 1 && maxHelpers <= 4, `helpers ${maxHelpers} <= 4`);
    assert.ok(maxCarryGoods >= 4 && maxCarryGoods <= 6, `trip size ${maxCarryGoods}`);
    assert.equal(W.itemCount, W.itemCount); for (let f = 0; f < 8; f++) assert.equal(W.f_resv[f], 0);
    checkAccounting(W); loadInvariants(W);
    assert.equal(mon.nan, 0);
    console.log(`   kind ${kind}: loaded in ${(W.time - loadStart).toFixed(0)} s, ${W.stats.farmerLoads} hand-overs, helpers ${maxHelpers}`);
  }
});

T('loading fallbacks: no farmers -> immediate ghost load; farmers unable to come -> ghost load after ~45 s; autoLoads logged', () => {
  const W0 = createWorld({ seed: 80 });
  W0.stats.delivered[ItemKind.EGG] = 20; W0.truck.init = true; W0.truck.nextAt = 1e9; spawnTruck(W0, TruckKind.PICKUP);
  run(W0, 80); assert.equal(W0.stats.trucksVisited, 1); assert.equal(W0.stats.autoLoads, 1); assert.equal(W0.stats.farmerLoads, 0);
  // farmers all busy (fake task) -> nobody starts within 45 s
  const W = createWorld({ seed: 81 });
  setAnimalCount(W, 0); setFarmerCount(W, 3);
  W.stats.delivered[ItemKind.EGG] = 20; W.truck.init = true; W.truck.nextAt = 1e9; spawnTruck(W, TruckKind.PICKUP);
  let parked = -1, autoAt = -1;
  for (let k = 0; k < 30 * 200; k++) {
    advanceClock(W, SIM_DT); updateTasks(W, SIM_DT);
    for (let f = 0; f < 3; f++) { W.f_state[f] = 3; W.f_task[f] = -1; }            // pretend WORK: never idle -> never offered
    updateTrucks(W, SIM_DT);
    if (parked < 0 && W.v_state[0] === TruckState.LOADING) parked = W.time;
    if (autoAt < 0 && W.v_auto[0]) autoAt = W.time;
  }
  assert.ok(autoAt - parked >= 44.9 && autoAt - parked <= 46, `ghost load started ${(autoAt - parked).toFixed(1)} s after parking`);
  assert.equal(W.stats.autoLoads, 1); assert.equal(W.stats.trucksVisited, 1);
  assert.equal(W.stats.shipped[0], 20);
});

T('despawning farmers mid-load releases reservations and carried goods; the visit still completes', () => {
  for (const variant of ['top', 'all']) {
    const W = createWorld({ seed: 90 }), items0 = W.itemCount;
    setAnimalCount(W, 0); setFarmerCount(W, 8);
    W.stats.delivered[ItemKind.EGG] = 24; W.truck.init = true; W.truck.nextAt = 1e9;
    for (let f = 0; f < 8; f++) { W.f_px[f] = W.f_ppx[f] = 125 + f; W.f_pz[f] = W.f_ppz[f] = 1; }
    spawnTruck(W, TruckKind.PICKUP);
    let cut = false;
    for (let k = 0; k < 30 * 300; k++) {
      farmTick(W);
      if (!cut) {
        let f = -1; for (let q = 0; q < W.farmerCount; q++) if (W.f_carry[q] > 0 && W.f_resv[q] > 0) { f = q; break; }
        if (f >= 0) {
          cut = true;
          const before = W.truckRes[0]; assert.ok(before > 0);
          setFarmerCount(W, variant === 'all' ? 0 : f);       // removes the carrying farmer and everyone above it
          loadInvariants(W);
          assert.equal(W.itemCount - items0 >= 0, true);
          for (let i = 0; i < W.itemHigh; i++) if (W.i_alive[i] && W.i_state[i] === ItemState.CARRIED) assert.ok(W.i_carrier[i] < W.farmerCount);
        }
      }
      if (k % 30 === 0) loadInvariants(W);
    }
    assert.ok(cut, 'a loader was removed mid-job');
    assert.equal(W.stats.trucksVisited, 1, 'visit completes'); assert.equal(W.stats.shipped[0], 24);
    for (let k = 0; k < 3; k++) assert.equal(W.truckRes[k], 0);
    let carried = 0; for (let i = 0; i < W.itemHigh; i++) if (W.i_alive[i] && W.i_state[i] === ItemState.CARRIED && W.i_kind[i] <= 2) carried++;
    assert.equal(carried, 0, 'no leaked carried items');
    if (variant === 'all') assert.equal(W.stats.autoLoads, 1, 'no farmers left -> ghost load');
  }
});

T('farmers load the trucks (900 s with the real farmer sim): real hand-overs, no ghost loads, no leaks, no stuck loaders, lane', () => {
  const W = createWorld({ seed: 11 });
  setAnimalCount(W, 600); setFarmerCount(W, 24); initialSeed(W);
  const rand = W.rand, tmp = new Float32Array(2), mon = makeMonitor();
  const idx = Array.from({ length: 20 }, () => []);
  for (let i = 0; i < W.animalCount; i++) idx[W.a_species[i]].push(i);
  const total = Math.round(900 / SIM_DT);
  let firstVisitAt = -1, maxStock = 0, maxItems = 0, maxMove = 0, departEarly = 0, jobSeen = 0;
  const moveT = new Float64Array(64), prevState = new Uint8Array(MAX_TRUCKS);
  for (let k = 0; k < total; k++) {
    for (let p = 0; p < 20; p++) { W.pen_food[p] = Math.max(0.3, W.pen_food[p] - SIM_DT * 0.007); W.pen_water[p] = Math.max(0.3, W.pen_water[p] - SIM_DT * 0.008); }
    if (k % 40 === 0) { const p = [0, 1, 2, 11, 14, 17][(rand() * 6) | 0], nest = PENS[p].nest; spawnItem(W, ItemKind.EGG, nest.x + (rand() - .5) * 3, 0.06, nest.z + (rand() - .5), p); }
    if (k % 35 === 0) { const p = (rand() * 20) | 0; WM.randomPointInPen(W, p, 1, tmp); spawnItem(W, ItemKind.MANURE, tmp[0], 0, tmp[1], p); }
    if (k % 90 === 10) { const p = [4, 5, 7, 9, 12, 15, 16][(rand() * 7) | 0], l = idx[p], a = l[(rand() * l.length) | 0]; W.a_flags[a] |= AFlag.READY; W.a_produce[a] = 1; }
    W.pen_ready.fill(0);
    for (let i = 0; i < W.animalCount; i++) if (W.a_flags[i] & AFlag.READY) W.pen_ready[W.a_species[i]]++;
    snapshotPrev(W); advanceClock(W, SIM_DT);
    updateTasks(W, SIM_DT); updateFarmers(W, SIM_DT); updateTrucks(W, SIM_DT);
    mon.check(W);
    if (k % 10 === 0) loadInvariants(W);
    maxItems = Math.max(maxItems, W.itemCount);
    for (let f = 0; f < W.farmerCount; f++) {
      if (W.f_state[f] === 1 && W.f_speed[f] < 0.05) moveT[f] += SIM_DT; else moveT[f] = 0;
      if (moveT[f] > maxMove) maxMove = moveT[f];
      if (W.f_job[f] >= 0) jobSeen++;
    }
    for (let i = 0; i < MAX_TRUCKS; i++) {                                     // departure only after the planned cargo is aboard, or after a logged ghost load
      const st = W.v_active[i] ? W.v_state[i] : 0;
      if (st === TruckState.PAUSE && prevState[i] === TruckState.LOADING) {
        const o = i * 3;
        if (W.v_loaded[o] !== W.v_plan[o] || W.v_loaded[o + 1] !== W.v_plan[o + 1] || W.v_loaded[o + 2] !== W.v_plan[o + 2]) departEarly++;
        if (!W.v_auto[i] && W.v_carry[o] + W.v_carry[o + 1] + W.v_carry[o + 2] !== 0) departEarly++;
      }
      prevState[i] = st;
    }
    if (firstVisitAt < 0 && W.stats.trucksVisited > 0) firstVisitAt = W.time;
    maxStock = Math.max(maxStock, W.truckStock[0] + W.truckStock[1] + W.truckStock[2]);
    if (k % 300 === 0) checkAccounting(W);
  }
  checkAccounting(W);
  const s = getTruckStats(W), d = W.stats.delivered, sh = W.stats.shipped;
  console.log(`   delivered ${Array.from(d)} shipped ${Array.from(sh)} visits ${s.visits} spawned ${s.spawned} first visit @ ${firstVisitAt.toFixed(0)} s maxStock ${maxStock} kinds ${[...mon.kinds]}`);
  console.log(`   farmerLoads ${W.stats.farmerLoads} goods ${W.stats.farmerLoadGoods} autoLoads ${W.stats.autoLoads} maxItems ${maxItems} maxMoveStuck ${maxMove.toFixed(1)} s`);
  assert.ok(W.stats.farmerLoads > 0, 'farmers delivered goods to trucks'); assert.equal(W.stats.autoLoads, 0, 'no ghost loading in the normal case');
  assert.equal(W.stats.farmerLoadGoods, sh[0] + sh[1] + sh[2], 'all shipped goods were hand-delivered');
  assert.equal(departEarly, 0, 'trucks leave only fully loaded'); assert.ok(jobSeen > 0);
  assert.ok(maxItems < 1800, `item count bounded (${maxItems})`); assert.ok(maxMove < 30, `no farmer stuck in MOVE (${maxMove.toFixed(1)} s)`);
  assert.ok(s.visits >= 2, `visits >= 2 (${s.visits})`);
  assert.ok(firstVisitAt > 0 && firstVisitAt <= 400, `first visit by 400 s (${firstVisitAt.toFixed(0)})`);
  assert.ok(sh[0] + sh[1] + sh[2] > 0 && s.spawned >= s.visits && s.spawned - s.visits <= MAX_ACTIVE);
  assert.equal(mon.nan, 0); assert.equal(mon.outLane, 0, 'lane polygon'); assert.equal(mon.hitBuilding, null);
  assert.ok(mon.maxSpeed <= 7, `max speed ${mon.maxSpeed.toFixed(2)}`); assert.ok(mon.maxActive <= 2); assert.equal(mon.overlaps, 0); assert.equal(mon.bayDouble, 0);
  assert.ok(mon.stillMax < 40, `no truck stuck (${mon.stillMax.toFixed(1)} s still)`);
  // everything delivered is shipped within reason (no unbounded pile-up)
  assert.ok(maxStock < 120, `stock stays bounded (${maxStock})`);
});

T('renderer (mock GL): finite instance data, draw budget, CCW-outward models, loaded cargo, tint palette', () => {
  const made = [];
  const mkMesh = (geo, cap, opts, isStatic) => {
    let vol = 0;
    for (let i = 0; i < geo.count; i += 3) {
      const a = i * 3, p = geo.pos;
      vol += (p[a] * (p[a + 4] * p[a + 8] - p[a + 5] * p[a + 7]) - p[a + 1] * (p[a + 3] * p[a + 8] - p[a + 5] * p[a + 6]) + p[a + 2] * (p[a + 3] * p[a + 7] - p[a + 4] * p[a + 6])) / 6;
      for (let k = 0; k < 9; k++) assert.ok(Number.isFinite(p[a + k]) && Number.isFinite(geo.nrm[a + k]) && Number.isFinite(geo.col[a + k]), 'finite geometry');
    }
    const M = { geo, capacity: cap, vol, isStatic, vertexCount: geo.count, tris: geo.count / 3, outline: opts && opts.outline || 0, inst: new Float32Array(cap * 16), tint: new Float32Array(cap * 3), count: 0, uploads: 0, upload() { M.uploads++; } };
    made.push(M); return M;
  };
  const G = {
    createMesh: (geo, cap, opts) => mkMesh(geo, cap, opts, false), createStaticMesh: (geo, opts) => { const m = mkMesh(geo, 1, opts, true); m.count = 1; return m; },
    createShadowMesh(cap) { const S = { data: new Float32Array(cap * 3), capacity: cap, count: 0, upload() {} }; return S; },
  };
  const W = createWorld({ seed: 2 });
  const R = createTruckRenderer(G, W);
  let tris = 0, ol = 0, dyn = 0;
  for (const M of R.meshes) {
    if (M.isStatic) continue;
    dyn++;
    assert.ok(M.vol > 0, 'positive signed volume (CCW outward) ' + M.vol); tris += M.tris * (M.outline > 0 ? 2 : 1); ol += M.outline > 0 ? 1 : 0;
    if (M.outline > 0) assert.ok(M.outline >= 0.04 && M.outline <= 0.08, 'outline width ' + M.outline);
  }
  console.log(`   dynamic meshes ${dyn} (outlined ${ol}), tris/instance-set ${tris}, lane tris ${R.lane.tris}`);
  W.stats.delivered[ItemKind.EGG] = 40; W.stats.delivered[ItemKind.MILK] = 30; W.stats.delivered[ItemKind.WOOL] = 20; W.truck.init = true; W.truck.nextAt = 1e9;
  R.update(W, 0.5); assert.equal(R.counts.trucks, 0);
  W.hour = 22;
  let maxCalls = 0, sawCargo = 0, maxInst = 0, glow = 0, second = false;
  for (let kind = 0; kind < 3; kind++) {
    spawnTruck(W, kind);
    for (let k = 0; k < 30 * 70; k++) {
      advanceClock(W, SIM_DT); W.hour = 22; updateTrucks(W, SIM_DT);
      if (!second && W.v_state[0] === TruckState.REVERSE) { second = true; }
      if (k % 5 === 0) {
        R.update(W, (k % 5) / 5);
        let calls = 0, inst = 0;
        for (const M of R.meshes) {
          if (M.isStatic) continue;
          assert.ok(M.count <= M.capacity, 'capacity respected');
          if (M.count > 0) calls += M.outline > 0 ? 2 : 1;
          inst += M.count;
          for (let i = 0; i < M.count * 16; i++) assert.ok(Number.isFinite(M.inst[i]), 'finite instance matrix');
          for (let i = 0; i < M.count * 3; i++) assert.ok(Number.isFinite(M.tint[i]) && M.tint[i] >= 0);
        }
        assert.ok(R.shadows.count <= R.shadows.capacity);
        calls += R.shadows.count > 0 ? 1 : 0; maxCalls = Math.max(maxCalls, calls); maxInst = Math.max(maxInst, inst);
        if (R.counts.cargo > 0) sawCargo++;
        const lamps = R.meshes.find(M => M.capacity === MAX_TRUCKS * 8 + 8);
        for (let i = 0; i < lamps.count; i++) if (lamps.tint[i * 3] > 2) glow++;
      }
    }
    assert.equal(getTruckStats(W).active, 0);
  }
  console.log(`   max added draw calls ${maxCalls}, cargo frames ${sawCargo}, glowing lamp samples ${glow}`);
  assert.ok(maxCalls <= 16 && sawCargo > 20 && glow > 0, 'budget, cargo and night glow');
});

console.log(`truck tests passed (${n})`);
