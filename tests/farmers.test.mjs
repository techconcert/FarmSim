import assert from 'node:assert/strict';
import { PENS, PEN_COUNT, SPECIES, WORLD, BUILDINGS, ROUTE_MAX, SIM_DT, TaskType, TASK_TYPE_COUNT, ItemKind, ItemState, AFlag, AState, FState, FarmerType, MAX_ITEMS, MAX_ANIMALS, MAX_FARMERS, MAX_TASKS } from '../src/config.js';
import { updateAnimals } from '../src/sim/animals.js';
import { updateTrucks, PATH_IN, PATH_OUT, KIND as TRUCK_KIND } from '../src/sim/trucks.js';
import * as WM from '../src/ecs/world.js';
import { buildHash } from '../src/ecs/spatialHash.js';
import { updateTasks } from '../src/sim/tasks.js';
import { updateFarmers } from '../src/sim/farmers.js';
import { buildRoute } from '../src/sim/nav.js';
const { createWorld, setAnimalCount, setFarmerCount, initialSeed, snapshotPrev, advanceClock, spawnItem, penOf, recountPenItems } = WM;

let n = 0; const T = (name, fn) => { fn(); console.log('  ok', name); n++; };

T('nav routes', () => {
  const W = createWorld({ seed: 5 });
  setFarmerCount(W, 4);
  const R = (f) => Array.from(W.f_route.subarray(f * ROUTE_MAX * 2, f * ROUTE_MAX * 2 + W.f_routeLen[f] * 2));
  // farmhouse yard -> pen 0 interior: hub, gateOut, gateIn, dest
  W.f_px[0] = -137; W.f_pz[0] = -44;
  buildRoute(W, 0, -100, -30, 0);
  assert.deepEqual(R(0), [-130, 0, PENS[0].gateOut.x, PENS[0].gateOut.z, PENS[0].gateIn.x, PENS[0].gateIn.z, -100, -30]);
  // inside pen 0 -> pen 6 (south): gateIn, gateOut, gateOut6, gateIn6, dest
  W.f_px[1] = -100; W.f_pz[1] = -30;
  buildRoute(W, 1, -50, 30, 6);
  assert.equal(W.f_routeLen[1], 5);
  assert.equal(R(1)[1], PENS[0].gateIn.z);
  // pen -> east yard
  buildRoute(W, 1, 139, 23, -1);
  assert.deepEqual(R(1).slice(-4), [130, 0, 139, 23]);
  // west yard -> east yard
  W.f_px[2] = -137; W.f_pz[2] = 0;
  buildRoute(W, 2, 137, 0, -1);
  assert.deepEqual(R(2), [-130, 0, 130, 0, 137, 0]);
  // same pen direct
  W.f_px[3] = -100; W.f_pz[3] = -30;
  buildRoute(W, 3, -90, -40, 0);
  assert.equal(W.f_routeLen[3], 1);
});

T('farmers simulate 480 s (fake animal side effects, 20 pens, 40 farmers)', () => {
  const W = createWorld({ seed: 11 });
  setAnimalCount(W, 3000);
  setFarmerCount(W, 40);
  initialSeed(W);
  const rand = W.rand;
  const eggPens = PENS.filter(P => SPECIES[P.id].produce === ItemKind.EGG).map(P => P.id);
  const prodPens = PENS.filter(P => SPECIES[P.id].produce === ItemKind.MILK || SPECIES[P.id].produce === ItemKind.WOOL).map(P => P.id);
  const done0 = W.stats.tasksDone.slice();
  const stuckT = new Float32Array(MAX_FARMERS);
  let maxStuck = 0, maxItems = 0, maxTasks = 0, ticks = 0, tickMs = 0;
  const idxBySpecies = Array.from({ length: 20 }, () => []);
  for (let i = 0; i < W.animalCount; i++) idxBySpecies[W.a_species[i]].push(i);
  const tmp = new Float32Array(2);
  const stateSeen = new Uint8Array(8);
  const total = Math.round(480 / SIM_DT);
  for (let k = 0; k < total; k++) {
    // --- fake animal side effects (no updateAnimals)
    for (let p = 0; p < 20; p++) {
      W.pen_food[p] = Math.max(0, W.pen_food[p] - SIM_DT * 0.007);
      W.pen_water[p] = Math.max(0, W.pen_water[p] - SIM_DT * 0.008);
    }
    if (k % 60 === 0) { // egg
      const p = eggPens[(rand() * eggPens.length) | 0], nest = PENS[p].nest;
      spawnItem(W, ItemKind.EGG, nest.x + (rand() - .5) * 3, 0.06, nest.z + (rand() - .5), p);
      spawnItem(W, ItemKind.EGG, nest.x + (rand() - .5) * 3, 0.06, nest.z + (rand() - .5), p);
    }
    if (k % 45 === 0) { // manure
      const p = (rand() * 20) | 0;
      WM.randomPointInPen(W, p, 1, tmp);
      spawnItem(W, ItemKind.MANURE, tmp[0], 0, tmp[1], p);
    }
    if (k % 150 === 10) { // ready animals
      const p = prodPens[(rand() * prodPens.length) | 0], l = idxBySpecies[p];
      const a = l[(rand() * l.length) | 0];
      W.a_flags[a] |= AFlag.READY; W.a_produce[a] = 1;
    }
    if (k % 200 === 20) { // sick animals
      const p = (rand() * 20) | 0, l = idxBySpecies[p];
      const a = l[(rand() * l.length) | 0];
      W.a_flags[a] |= AFlag.SICK; W.a_health[a] = 0.3; W.a_state[a] = AState.SICK;
    }
    W.pen_ready.fill(0); W.pen_sick.fill(0);
    for (let i = 0; i < W.animalCount; i++) {
      const fl = W.a_flags[i];
      if (fl & AFlag.READY) W.pen_ready[W.a_species[i]]++;
      if (fl & AFlag.SICK) W.pen_sick[W.a_species[i]]++;
    }
    // --- systems
    snapshotPrev(W); advanceClock(W, SIM_DT);
    const t0 = performance.now();
    updateTasks(W, SIM_DT);
    updateFarmers(W, SIM_DT);
    tickMs += performance.now() - t0; ticks++;
    // --- invariants
    for (let f = 0; f < W.farmerCount; f++) {
      assert.ok(Number.isFinite(W.f_px[f]) && Number.isFinite(W.f_pz[f]) && Number.isFinite(W.f_heading[f]), 'finite farmer');
      assert.ok(W.f_px[f] > WORLD.x0 && W.f_px[f] < WORLD.x1 && W.f_pz[f] > WORLD.z0 && W.f_pz[f] < WORLD.z1, 'in world');
      stateSeen[W.f_state[f]] = 1;
      if (W.f_state[f] === FState.MOVE && W.f_speed[f] < 0.05) stuckT[f] += SIM_DT; else stuckT[f] = 0;
      if (stuckT[f] > maxStuck) maxStuck = stuckT[f];
    }
    if (k % 30 === 0) {
      const carried = new Int32Array(MAX_FARMERS);
      for (let i = 0; i < W.itemHigh; i++) if (W.i_alive[i] && W.i_state[i] === ItemState.CARRIED) carried[W.i_carrier[i]]++;
      for (let f = 0; f < W.farmerCount; f++) assert.equal(carried[f], W.f_carry[f], `carry sync f${f}`);
      const e = W.pen_eggs.slice(), m = W.pen_manure.slice();
      recountPenItems(W);
      assert.deepEqual(Array.from(W.pen_eggs), Array.from(e)); assert.deepEqual(Array.from(W.pen_manure), Array.from(m));
    }
    if (W.itemCount > maxItems) maxItems = W.itemCount;
    if (W.taskCount > maxTasks) maxTasks = W.taskCount;
  }
  const done = W.stats.tasksDone, names = Object.keys(TaskType);
  console.log('   tasksDone', Array.from(done).join(','), 'created', Array.from(W.stats.tasksCreated).join(','),
    'delivered', Array.from(W.stats.delivered).join(','));
  console.log(`   maxStuck ${maxStuck.toFixed(1)}s maxItems ${maxItems} maxTasks ${maxTasks} avg ${(tickMs / ticks).toFixed(3)} ms/tick`,
    'states seen', Array.from(stateSeen).join(''));
  for (let t = 0; t < 7; t++) assert.ok(done[t] > done0[t], `task type ${names[t]} completed`);
  assert.ok(maxStuck < 30, 'no farmer stuck in MOVE');
  assert.ok(maxItems < 900, 'items bounded');
  assert.ok(W.stats.delivered[ItemKind.EGG] > 0 && W.stats.delivered[ItemKind.MANURE] > 0 && W.stats.delivered[ItemKind.MILK] + W.stats.delivered[ItemKind.WOOL] > 0);
  for (const s of [FState.MOVE, FState.PICKUP, FState.WORK, FState.DROPOFF, FState.WANDER, FState.IDLE]) assert.ok(stateSeen[s], 'state seen ' + s);
  // food/water stayed serviced
  assert.ok(done[TaskType.FEED] + done[TaskType.WATER] >= 10, 'supply throughput');
  // no animals left HELD forever
  let held = 0; for (let i = 0; i < W.animalCount; i++) if (W.a_flags[i] & AFlag.HELD) held++;
  assert.ok(held <= 40);
  assert.ok(tickMs / ticks < 2, 'farmer tick < 2ms');
  const penDone = p => { let c = 0; for (let t = 0; t < TASK_TYPE_COUNT; t++) c += W.stats.tasksDonePen[p * TASK_TYPE_COUNT + t]; return c; };
  let served = 0; for (let p = 0; p < 20; p++) if (penDone(p) > 0) served++;
  assert.ok(served >= 18, `chores done in ${served}/20 pens within 480 s`);
});

T('night rest + lean + despawn robustness', () => {
  const W = createWorld({ seed: 3 });
  setAnimalCount(W, 300); setFarmerCount(W, 24); initialSeed(W);
  W.time = 13.5 * 600 / 24 - 0; // hour ~ 21.5 -> night
  advanceClock(W, 0);
  assert.ok(WM.isNight(W));
  for (let k = 0; k < 30 * 120; k++) { snapshotPrev(W); updateTasks(W, SIM_DT); updateFarmers(W, SIM_DT); W.hour = 23; }
  let rest = 0; for (let f = 0; f < 24; f++) if (W.f_state[f] === FState.REST) rest++;
  assert.ok(rest >= 20, `resting ${rest}`);
  // day: random despawns while working must not crash or leave dangling state
  W.hour = 9;
  for (let k = 0; k < 30 * 60; k++) {
    W.pen_food.fill(0.1); W.pen_water.fill(0.1);
    if (k % 200 === 100) { WM.despawnAnimal(W, (W.rand() * W.animalCount) | 0); setFarmerCount(W, 8 + ((W.rand() * 40) | 0)); }
    snapshotPrev(W); updateTasks(W, SIM_DT); updateFarmers(W, SIM_DT);
  }
  for (let f = 0; f < W.farmerCount; f++) assert.ok(Number.isFinite(W.f_px[f]));
});

// ---------------------------------------------------------------------------------------------------------------- nav geometry
const RECT_B = [BUILDINGS.BARN, BUILDINGS.FARMHOUSE, BUILDINGS.STOREHOUSE, BUILDINGS.VET_SHED, BUILDINGS.COMPOST];
function checkRoute(W, f, sx, sz, dx, dz, label) {
  W.f_px[f] = sx; W.f_pz[f] = sz;
  const dp = penOf(dx, dz), sp = penOf(sx, sz);
  const len = buildRoute(W, f, dx, dz, dp);
  assert.ok(len >= 1 && len <= ROUTE_MAX, `${label}: route length ${len}`);
  const R = W.f_route, base = f * ROUTE_MAX * 2;
  assert.ok(Math.abs(R[base + (len - 1) * 2] - dx) < 1e-4 && Math.abs(R[base + (len - 1) * 2 + 1] - dz) < 1e-4);
  let px = sx, pz = sz, prevPen = sp;
  for (let k = 0; k < len; k++) {
    const tx = R[base + k * 2], tz = R[base + k * 2 + 1];
    assert.ok(Number.isFinite(tx) && Number.isFinite(tz));
    assert.ok(tx > WORLD.x0 && tx < WORLD.x1 && tz > WORLD.z0 && tz < WORLD.z1, `${label}: waypoint ${k} in world`);
    const L = Math.hypot(tx - px, tz - pz), steps = Math.max(1, Math.ceil(L / 0.4));
    for (let q = 1; q <= steps; q++) {
      const x = px + (tx - px) * q / steps, z = pz + (tz - pz) * q / steps, p = penOf(x, z);
      if (p !== prevPen) {   // fence crossing: only through the 4 m gate of the pen being left / entered
        const pp = p >= 0 ? p : prevPen;
        assert.ok(pp === sp || pp === dp, `${label}: crosses the fence of foreign pen ${pp} at (${x.toFixed(1)},${z.toFixed(1)})`);
        assert.ok(Math.abs(x - PENS[pp].cx) <= 2.05, `${label}: fence crossing of pen ${pp} outside the gate (x ${x.toFixed(1)})`);
      }
      if (p >= 0) assert.ok(p === sp || p === dp, `${label}: walks through foreign pen ${p}`);
      prevPen = p;
      for (const B of RECT_B) assert.ok(!(x > B.x0 + 0.1 && x < B.x1 - 0.1 && z > B.z0 + 0.1 && z < B.z1 - 0.1), `${label}: walks through building ${B.name}`);
      assert.ok(x < 150 && x > -150 || Math.abs(z) < 60, `${label}: stays off the truck lane / map edge (${x.toFixed(0)},${z.toFixed(0)})`);
    }
    px = tx; pz = tz;
  }
}
T('nav: every gate of all 20 pens reachable from every start type; routes never cross a fence outside a gate', () => {
  const W = createWorld({ seed: 6 });
  setFarmerCount(W, 4);
  const starts = [];
  starts.push(['farmhouse door', BUILDINGS.FARMHOUSE.door.x, BUILDINGS.FARMHOUSE.door.z], ['barn door', -137, 0], ['well', -136, 12], ['storehouse', 137, 0], ['compost', 139, 23], ['vet shed', 137, -34],
    ['road W', -60, 1], ['road E', 90, -2], ['hub W', -130, 0], ['hub E', 130, 0]);
  for (const P of PENS) {
    starts.push([`lean spot ${P.id}`, P.cx + 3, P.gateEdgeZ - P.s * 1.3], [`pen ${P.id} interior`, P.cx + 6, P.cz + 3], [`pen ${P.id} gateOut`, P.gateOut.x, P.gateOut.z]);
  }
  const dests = [];
  for (const P of PENS) dests.push([`pen ${P.id} interior`, P.cx - 5, P.cz], [`pen ${P.id} feeder service`, P.cx - 8, P.gateEdgeZ + P.s * 6], [`lean ${P.id}`, P.cx - 3, P.gateEdgeZ - P.s * 1.3]);
  dests.push(['barn', -137, 0], ['well', -136, 12], ['storehouse', 137, 0], ['compost', 139, 23], ['vet', 137, -34], ['farmhouse', -137, -44], ['road stroll', 40, -2]);
  let routes = 0;
  for (const st of starts) for (const d of dests) { checkRoute(W, 0, st[1], st[2], d[1], d[2], `${st[0]} -> ${d[0]}`); routes++; }
  assert.ok(routes > 2000);
  // spot-check the exact shape of a few routes
  const R = f => Array.from(W.f_route.subarray(f * ROUTE_MAX * 2, f * ROUTE_MAX * 2 + W.f_routeLen[f] * 2));
  W.f_px[0] = -137; W.f_pz[0] = -44;
  buildRoute(W, 0, PENS[12].cx, PENS[12].gateOut.z - 1, 12);       // farmhouse -> north outer pen 12: hub W, corridor x=-124, lane, gate
  const r = R(0);
  assert.deepEqual(r.slice(0, 2), [-130, 0]); assert.ok(r.includes(-124)); assert.equal(r[r.length - 2], PENS[12].cx); assert.ok(Math.abs(r[r.length - 3] - PENS[12].gateIn.z) < 1e-6);
  W.f_px[1] = PENS[14].cx; W.f_pz[1] = PENS[14].cz;                // north outer pen -> south outer pen: gateIn, gateOut, corridor E (nearer), gateOut, gateIn
  buildRoute(W, 1, PENS[19].cx, PENS[19].cz, 19);
  const r1 = R(1); assert.equal(r1.length / 2, 7); assert.deepEqual(r1.slice(0, 4), [PENS[14].cx, PENS[14].gateIn.z, PENS[14].cx, PENS[14].gateOut.z]); assert.equal(r1[4], 124);
});

T('corridors keep clear of the truck lane (x ~ 172) and every swept truck footprint', () => {
  let minX = 1e9;
  for (const path of [PATH_IN, PATH_OUT]) for (let i = 0; i < path.n; i++) for (const k of TRUCK_KIND) {
    const h = path.ph[i], fx = Math.sin(h), fz = Math.cos(h), rx = Math.cos(h), rz = -Math.sin(h);
    for (const a of [-k.hl, k.hl]) for (const b of [-k.hw, k.hw]) minX = Math.min(minX, path.px[i] + fx * a + rx * b);
  }
  assert.ok(minX - WORLD.corridorX >= 1.0, `east corridor clearance to trucks ${(minX - WORLD.corridorX).toFixed(2)} m`);
  assert.ok(WORLD.corridorX - PENS[4].x1 >= 2, 'corridor 2 m outside the end fences');
  const W = createWorld({ seed: 3 }); setFarmerCount(W, 1);
  let maxX = 0;
  for (const P of PENS) for (const dest of [[137, 0], [-137, 0], [P.cx, P.cz]]) { checkRoute(W, 0, P.cx, P.cz, dest[0], dest[1], 'x'); for (let k = 0; k < W.f_routeLen[0]; k++) { const x = W.f_route[k * 2], z = W.f_route[k * 2 + 1]; if (Math.abs(z) > 9 && Math.abs(x) < 135) maxX = Math.max(maxX, Math.abs(x)); } }
  assert.ok(maxX <= WORLD.corridorX + 1e-3, 'no off-road waypoint outside the corridor / lanes (' + maxX + ')');
});

// ---------------------------------------------------------------------------------------------------------------- full sim (real animals)
function fullTick(W) {
  snapshotPrev(W); advanceClock(W, SIM_DT); buildHash(W.hash, W.a_px, W.a_pz, W.animalCount);
  updateAnimals(W, SIM_DT); updateTasks(W, SIM_DT); updateFarmers(W, SIM_DT); updateTrucks(W, SIM_DT);
}
function checkWorld(W, label) {
  for (let i = 0; i < W.animalCount; i++) {
    const s = W.a_species[i];
    assert.ok(Number.isFinite(W.a_px[i]) && Number.isFinite(W.a_pz[i]) && Number.isFinite(W.a_py[i]) && Number.isFinite(W.a_heading[i]) && Number.isFinite(W.a_speed[i]), `${label}: NaN animal ${i}`);
    assert.equal(penOf(W.a_px[i], W.a_pz[i]), s, `${label}: animal ${i} (species ${s}) left its pen`);
    if (W.a_state[i] === AState.SWIM) assert.ok(WM_inBlob(PENS[s].swim, W.a_px[i], W.a_pz[i]), `${label}: swimmer outside its blob`);
    if (W.a_state[i] === AState.WALLOW) assert.ok(WM_inBlob(PENS[s].wallow, W.a_px[i], W.a_pz[i]), `${label}: wallower outside its blob`);
  }
  for (let f = 0; f < W.farmerCount; f++) assert.ok(Number.isFinite(W.f_px[f]) && Number.isFinite(W.f_pz[f]) && Number.isFinite(W.f_heading[f]) && W.f_px[f] > WORLD.x0 && W.f_px[f] < WORLD.x1 && W.f_pz[f] > WORLD.z0 && W.f_pz[f] < WORLD.z1, `${label}: farmer ${f}`);
  for (const k of ['pen_food', 'pen_water', 'pen_dirt']) for (let p = 0; p < 20; p++) assert.ok(W[k][p] >= 0 && W[k][p] <= 1.0001, `${label}: ${k}[${p}] = ${W[k][p]}`);
}
import { inBlob as WM_inBlob } from '../src/config.js';

T('600 s, 3000 animals / 40 farmers (everything real): chores done in all 20 pens, fences respected, no NaN', () => {
  const W = createWorld({ seed: 99 });
  setAnimalCount(W, 3000); setFarmerCount(W, 40); initialSeed(W);
  const prevPen = new Int8Array(40).fill(-1); const stuckT = new Float32Array(40);
  let maxStuck = 0, maxItems = 0, maxTasks = 0, t0 = performance.now();
  const total = Math.round(600 / SIM_DT);
  for (let k = 0; k < total; k++) {
    fullTick(W);
    for (let f = 0; f < 40; f++) {   // farmers enter / leave pens through gates only
      const p = penOf(W.f_px[f], W.f_pz[f]);
      if (p !== prevPen[f] && k > 0) {
        const q = p >= 0 ? p : prevPen[f];
        assert.ok(Math.abs(W.f_px[f] - PENS[q].cx) < 3.2 && Math.abs(W.f_pz[f] - PENS[q].gateEdgeZ) < 1.5, `farmer ${f} crossed pen ${q} fence at (${W.f_px[f].toFixed(1)},${W.f_pz[f].toFixed(1)}) t=${k * SIM_DT}`);
      }
      prevPen[f] = p;
      if (W.f_state[f] === FState.MOVE && W.f_speed[f] < 0.05) stuckT[f] += SIM_DT; else stuckT[f] = 0;
      if (stuckT[f] > maxStuck) maxStuck = stuckT[f];
    }
    if (k % 300 === 299) checkWorld(W, 't=' + (k * SIM_DT).toFixed(0));
    if (W.itemCount > maxItems) maxItems = W.itemCount;
    if (W.taskCount > maxTasks) maxTasks = W.taskCount;
  }
  const ms = performance.now() - t0;
  const pd = (p, t) => W.stats.tasksDonePen[p * TASK_TYPE_COUNT + t];
  const row = []; for (let p = 0; p < 20; p++) { let c = 0; for (let t = 0; t < TASK_TYPE_COUNT; t++) c += pd(p, t); row.push(c); }
  console.log(`   ${(ms / total).toFixed(2)} ms/tick (whole sim)  tasksDone/pen ${row.join(',')}  total ${Array.from(W.stats.tasksDone).join(',')} maxStuck ${maxStuck.toFixed(1)}s maxItems ${maxItems} maxTasks ${maxTasks}`);
  for (let p = 0; p < 20; p++) {
    assert.ok(row[p] > 0, `pen ${p} (${SPECIES[p].name}) had no chore done`);
    assert.ok(pd(p, TaskType.FEED) + pd(p, TaskType.WATER) > 0, `pen ${p}: fed or watered`);
  }
  // product chores: each product kind served in several pens, most producing pens served at least once
  const prodDone = { [ItemKind.EGG]: 0, [ItemKind.MILK]: 0, [ItemKind.WOOL]: 0 }; let producers = 0;
  for (let p = 0; p < 20; p++) {
    const pr = SPECIES[p].produce; if (pr < 0) continue; producers++;
    const t = pr === ItemKind.EGG ? TaskType.COLLECT_EGGS : pr === ItemKind.MILK ? TaskType.MILK : TaskType.SHEAR;
    if (pd(p, t) > 0) prodDone[pr]++;
  }
  assert.equal(producers, 13);
  assert.ok(prodDone[ItemKind.EGG] >= 4 && prodDone[ItemKind.MILK] >= 3 && prodDone[ItemKind.WOOL] >= 2, 'product chores per kind ' + JSON.stringify(prodDone));
  assert.ok(prodDone[0] + prodDone[1] + prodDone[2] >= 10, 'producing pens served: ' + (prodDone[0] + prodDone[1] + prodDone[2]) + '/13');
  let cleaned = 0; for (let p = 0; p < 20; p++) if (pd(p, TaskType.CLEAN) > 0) cleaned++;
  assert.ok(cleaned >= 14, `pens cleaned: ${cleaned}/20`);
  assert.ok(maxStuck < 30, 'no farmer stuck'); assert.ok(maxItems < MAX_ITEMS * 0.6, 'items bounded'); assert.ok(W.stats.delivered[ItemKind.EGG] > 0 && W.stats.delivered[ItemKind.MANURE] > 0);
  for (let t = 0; t < TASK_TYPE_COUNT; t++) assert.ok(W.stats.tasksDone[t] > 0, 'task type ' + t);
  checkWorld(W, 'end');
});

T('stress: setAnimalCount(10000) + setFarmerCount(200), 120 s: no NaN, no leaks, tick cost', () => {
  const W = createWorld({ seed: 123 });
  setAnimalCount(W, 3000); setFarmerCount(W, 40); initialSeed(W);
  for (let k = 0; k < 30 * 20; k++) fullTick(W);
  setAnimalCount(W, 10000); setFarmerCount(W, 200);
  assert.equal(W.animalCount, 10000); assert.equal(W.farmerCount, 200);
  const tc = [0, 0, 0, 0]; for (let f = 0; f < 200; f++) tc[W.f_type[f]]++; assert.deepEqual(tc, [50, 50, 50, 50]);
  let ms = 0, worst = 0, maxItems = 0, cpu0 = process.cpuUsage();
  const total = Math.round(120 / SIM_DT);
  for (let k = 0; k < total; k++) {
    const t0 = performance.now(); fullTick(W); const d = performance.now() - t0; ms += d; if (d > worst) worst = d;
    if (W.itemCount > maxItems) maxItems = W.itemCount;
    if (k % 600 === 599) checkWorld(W, 'stress t=' + (k * SIM_DT).toFixed(0));
  }
  const cpu = process.cpuUsage(cpu0), cpuMs = (cpu.user + cpu.system) / 1000 / total;
  console.log(`   10000 animals / 200 farmers: ${(ms / total).toFixed(2)} ms/tick wall, ${cpuMs.toFixed(2)} ms/tick cpu, worst ${worst.toFixed(1)} ms, maxItems ${maxItems}`);
  checkWorld(W, 'stress end');
  assert.ok(cpuMs < 8, 'tick cost sane: ' + cpuMs);
  // leaks: item bookkeeping consistent, carried items belong to farmers, tasks bounded
  const e = W.pen_eggs.slice(), m = W.pen_manure.slice(); recountPenItems(W);
  assert.deepEqual(Array.from(W.pen_eggs), Array.from(e)); assert.deepEqual(Array.from(W.pen_manure), Array.from(m));
  const carried = new Int32Array(MAX_FARMERS); let alive = 0;
  for (let i = 0; i < W.itemHigh; i++) if (W.i_alive[i]) { alive++; if (W.i_state[i] === ItemState.CARRIED) carried[W.i_carrier[i]]++; }
  assert.equal(alive, W.itemCount); for (let f = 0; f < 200; f++) assert.equal(carried[f], W.f_carry[f], 'carry sync ' + f);
  let tasks = 0; for (let t = 0; t < W.taskHigh; t++) if (W.t_alive[t]) tasks++;
  assert.equal(tasks, W.taskCount); assert.ok(W.taskCount <= PEN_COUNT * TASK_TYPE_COUNT);
  let held = 0; for (let i = 0; i < W.animalCount; i++) if (W.a_flags[i] & AFlag.HELD) held++;
  assert.ok(held <= 200, 'held animals bounded ' + held);
  // shrink back: everything released cleanly
  setFarmerCount(W, 40); setAnimalCount(W, 3000);
  for (let k = 0; k < 30 * 30; k++) fullTick(W);
  checkWorld(W, 'after shrink');
  held = 0; for (let i = 0; i < W.animalCount; i++) if (W.a_flags[i] & AFlag.HELD) held++;
  assert.ok(held <= 40, 'held after shrink ' + held);
});

console.log(`farmer tests passed (${n})`);
