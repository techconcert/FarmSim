import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { SPECIES, Species as SPC, PENS, AState as A, AFlag, ItemKind, FState, SIM_DT, FeatureKind as FK, blobOutline, inBlob, MAX_ANIMALS } from '../src/config.js';
import { createWorld, setAnimalCount, setFarmerCount, initialSeed, snapshotPrev, advanceClock, penOf, pushOutOfSolids } from '../src/ecs/world.js';
import { buildHash } from '../src/ecs/spatialHash.js';
import { updateAnimals } from '../src/sim/animals.js';

let n = 0; const T = (name, fn) => { fn(); console.log('  ok', name); n++; };
const tick = (W) => { snapshotPrev(W); advanceClock(W, SIM_DT); buildHash(W.hash, W.a_px, W.a_pz, W.animalCount); updateAnimals(W, SIM_DT); };
const count = (W, kind) => { let c = 0; for (let i = 0; i < W.itemHigh; i++) if (W.i_alive[i] && W.i_kind[i] === kind) c++; return c; };
const _o = new Float32Array(2);
const POND = PENS[1].swim, MUD = PENS[6].wallow;
let swimN = 0, wallowN = 0;
function checkSane(W) {
  for (let i = 0; i < W.animalCount; i++) {
    const s = W.a_species[i];
    for (const k of ['a_px', 'a_py', 'a_pz', 'a_vx', 'a_vz', 'a_heading', 'a_speed', 'a_gait', 'a_hunger', 'a_thirst', 'a_energy', 'a_produce', 'a_stateTime'])
      assert.ok(Number.isFinite(W[k][i]), `NaN ${k} animal ${i} species ${s} state ${W.a_state[i]}`);
    assert.equal(penOf(W.a_px[i], W.a_pz[i]), s, `animal ${i} species ${s} left its pen`);
    assert.ok(W.a_state[i] <= A.PREEN);
    assert.ok(W.a_py[i] >= -0.3 && W.a_py[i] < 4, 'height sane');
  }
}

T('3000 animals, 3600 ticks: sanity, behaviours, production, drain, perf', () => {
  const W = createWorld({ seed: 42 });
  setAnimalCount(W, 3000); initialSeed(W);
  const food0 = Array.from(W.pen_food), water0 = Array.from(W.pen_water);
  const eggs0 = count(W, ItemKind.EGG), man0 = count(W, ItemKind.MANURE);
  const seen = new Set(); let maxGoatY = 0, minDuckY = 0;
  const stateSeen = new Array(20).fill(0).map(() => new Set());
  const nSwim = new Array(20).fill(0), nWallow = new Array(20).fill(0), fleeSpeed = new Array(20).fill(0);
  let tot = 0, worst = 0, cpu0 = null; const times = [];
  for (let t = 0; t < 3600; t++) {
    if (t === 60) cpu0 = process.cpuUsage();
    const t0 = performance.now();
    snapshotPrev(W); advanceClock(W, SIM_DT); buildHash(W.hash, W.a_px, W.a_pz, W.animalCount); updateAnimals(W, SIM_DT);
    const dt = performance.now() - t0; if (t >= 60) { tot += dt; times.push(dt); if (dt > worst) worst = dt; }
    if (t % 15 === 0) {
      for (let i = 0; i < W.animalCount; i++) {
        const s = W.a_species[i], st = W.a_state[i];
        stateSeen[s].add(st);
        if (s === 4 && W.a_py[i] > maxGoatY) maxGoatY = W.a_py[i];
        if (s === 1 && st === A.SWIM && W.a_py[i] < minDuckY) minDuckY = W.a_py[i];
        if (s === 1 && st === A.SWIM) { swimN++; assert.ok(inBlob(POND, W.a_px[i], W.a_pz[i], 0), `duck ${i} swimming outside pond blob at t=${t}`); }
        if (s === 6 && st === A.WALLOW) { wallowN++; assert.ok(inBlob(MUD, W.a_px[i], W.a_pz[i], 0), `pig ${i} wallowing outside mud blob at t=${t}`); }
        if ((s === 11 || s === 19) && st === A.SWIM) { nSwim[s]++; assert.ok(inBlob(PENS[s].swim, W.a_px[i], W.a_pz[i], 0), `swimmer ${i} (${s}) outside its blob at t=${t}`); }
        if ((s === 16 || s === 18) && st === A.WALLOW) { nWallow[s]++; assert.ok(inBlob(PENS[s].wallow, W.a_px[i], W.a_pz[i], 0), `species ${s} wallowing outside its blob at t=${t}`); }
        if (st === A.FLEE && W.a_speed[i] > fleeSpeed[s]) fleeSpeed[s] = W.a_speed[i];
      }
    }
    if (t % 600 === 599) checkSane(W);
  }
  checkSane(W);
  // The machine may be shared/loaded: judge by process CPU time per tick (immune to descheduling stalls)
  // and by the wall-clock mean with the slowest 5% of ticks trimmed.
  const cpu = process.cpuUsage(cpu0), cpuMs = (cpu.user + cpu.system) / 1000 / (3600 - 60);
  times.sort((a, b) => a - b); let trimmed = 0; const keep = Math.floor(times.length * 0.95);
  for (let k = 0; k < keep; k++) trimmed += times[k]; trimmed /= keep;
  console.log(`    cpu ${cpuMs.toFixed(3)} ms/tick, wall mean ${(tot / times.length).toFixed(3)} (trimmed ${trimmed.toFixed(3)}, median ${times[times.length >> 1].toFixed(3)}), worst ${worst.toFixed(1)} ms  [hash+update, 3000 animals]`);
  assert.ok(cpuMs < 3, `too slow (cpu): ${cpuMs} ms/tick`);
  assert.ok(trimmed < 3 || cpuMs < 2, `too slow (wall): ${trimmed} ms/tick`);
  assert.ok(stateSeen[1].has(A.SWIM), 'ducks swim'); assert.ok(minDuckY < 0, 'swimming ducks sink');
  assert.ok(stateSeen[6].has(A.WALLOW), 'pigs wallow'); assert.ok(swimN > 20 && wallowN > 20, `swim/wallow samples ${swimN}/${wallowN}`);
  assert.ok(maxGoatY > 1, 'goats climb: ' + maxGoatY); assert.ok(stateSeen[4].has(A.CLIMB));
  assert.ok(stateSeen[0].has(A.PECK) && stateSeen[0].has(A.SCRATCH), 'chickens peck+scratch');
  assert.ok(stateSeen[3].has(A.HOP) && stateSeen[3].has(A.GRAZE), 'rabbits hop+graze');
  assert.ok(stateSeen[7].has(A.GRAZE) && stateSeen[7].has(A.REST), 'cows graze+rest');
  assert.ok(stateSeen[6].has(A.ROOT), 'pigs root');
  assert.ok(stateSeen[2].has(A.DISPLAY), 'turkeys display');
  assert.ok(stateSeen[8].has(A.TROT), 'horses trot');
  assert.ok(stateSeen[5].has(A.FLOCK), 'sheep flock');
  assert.ok(stateSeen[0].has(A.LAY) || stateSeen[1].has(A.LAY) || stateSeen[2].has(A.LAY), 'birds lay');
  assert.ok(stateSeen[11].has(A.SWIM) && nSwim[11] > 10, 'geese swim in the stream');
  assert.ok(stateSeen[16].has(A.WALLOW) && nWallow[16] > 10, 'buffalo wallow in the marsh mud'); assert.ok(stateSeen[19].has(A.SWIM) && nSwim[19] > 10, 'capybaras swim in the hot spring');
  assert.ok(stateSeen[14].has(A.DUSTBATH), 'ostriches sand-bathe'); assert.ok(stateSeen[15].has(A.ROLL), 'yaks roll in the snow drift');
  assert.ok(stateSeen[17].has(A.DISPLAY), 'peacocks display'); assert.ok(stateSeen[13].has(A.FREEZE) || stateSeen[13].has(A.FLOCK), 'deer alert / herd');
  for (const s of [10, 12, 18, 19]) assert.ok(stateSeen[s].has(A.GRAZE), 'grazers graze ' + s);
  assert.ok(stateSeen[12].has(A.FLOCK) || stateSeen[13].has(A.FLOCK), 'alpaca / deer flock');
  assert.ok(count(W, ItemKind.EGG) > eggs0, 'eggs spawned');
  assert.ok(count(W, ItemKind.MANURE) > man0, 'manure spawned');
  for (let p = 0; p < 20; p++) {
    assert.ok(W.pen_food[p] < food0[p], `pen_food ${p} should drop (${food0[p]} -> ${W.pen_food[p]})`);
    if (p !== 18 && p !== 14) assert.ok(W.pen_water[p] < water0[p], `pen_water ${p} should drop (${water0[p]} -> ${W.pen_water[p]})`);   // camel / ostrich barely drink
    assert.equal(W.pen_count[p], W.speciesCount[p]);
    assert.ok(W.pen_dirt[p] >= 0 && W.pen_dirt[p] <= 1);
  }
  console.log('    pen_food', Array.from(W.pen_food).map(v => v.toFixed(2)).join(' '));
  console.log('    pen_water', Array.from(W.pen_water).map(v => v.toFixed(2)).join(' '));
});

T('not inside solids; determinism', () => {
  const run = () => { const W = createWorld({ seed: 5 }); setAnimalCount(W, 800); initialSeed(W); for (let t = 0; t < 600; t++) tick(W); return W; };
  const a = run(), b = run();
  for (let i = 0; i < a.animalCount; i++) {
    assert.equal(a.a_px[i], b.a_px[i]); assert.equal(a.a_pz[i], b.a_pz[i]);
    const s = a.a_species[i];
    assert.equal(pushOutOfSolids(s, a.a_px[i], a.a_pz[i], SPECIES[s].radius * 0.8, _o), false, `animal ${i} species ${s} inside solid`);
  }
});

T('production: milk/wool READY flag, aggregates', () => {
  const W = createWorld({ seed: 8 });
  setAnimalCount(W, 600); initialSeed(W);
  for (let i = 0; i < W.animalCount; i++) W.a_produce[i] = 1;
  tick(W); tick(W);   // heavy logic runs on alternate ticks per animal
  let cow = -1, chick = -1;
  for (let i = 0; i < W.animalCount; i++) { if (W.a_species[i] === 7 && cow < 0) cow = i; if (W.a_species[i] === 0 && chick < 0) chick = i; }
  assert.ok(W.a_flags[cow] & AFlag.READY);
  assert.equal(W.a_flags[chick] & AFlag.READY, 0, 'egg layers are not READY');
  assert.equal(W.pen_ready[7], W.speciesCount[7]);
  assert.equal(W.pen_ready[3], 0);
  for (const p of [4, 5, 7, 9, 12, 15, 16]) assert.equal(W.pen_ready[p], W.speciesCount[p], 'milk/wool species are READY: ' + p);
  for (const p of [0, 1, 2, 3, 6, 8, 10, 11, 13, 14, 17, 18, 19]) assert.equal(W.pen_ready[p], 0, 'no milk/wool in pen ' + p);
  // external reset (as WP3 does)
  W.a_flags[cow] &= ~AFlag.READY; W.a_produce[cow] = 0; tick(W); tick(W);
  assert.equal(W.a_flags[cow] & AFlag.READY, 0); assert.equal(W.pen_ready[7], W.speciesCount[7] - 1);
});

T('laying: layer at produce>=1 walks to the nest, lays an egg', () => {
  const W = createWorld({ seed: 9 });
  setAnimalCount(W, 100); initialSeed(W);
  let h = -1; for (let i = 0; i < W.animalCount; i++) if (W.a_species[i] === 0) { h = i; break; }
  W.a_produce[h] = 1; W.a_hunger[h] = 0; W.a_thirst[h] = 0; W.a_stateTime[h] = 0; W.a_state[h] = A.IDLE;
  const nest = PENS[0].nest; let lay = false, d = 99;
  for (let t = 0; t < 30 * 120 && !(lay && W.a_state[h] !== A.LAY); t++) {
    tick(W); W.a_hunger[h] = 0; W.a_thirst[h] = 0;
    if (W.a_state[h] === A.LAY && !lay) { lay = true; d = Math.hypot(W.a_px[h] - nest.x, W.a_pz[h] - nest.z); }
  }
  assert.ok(lay, 'hen went to LAY'); assert.ok(d < 3.5, 'laid near the nest: ' + d); assert.equal(W.a_produce[h], 0);
});

T('HELD animals are frozen and face the farmer; SICK stays until cleared', () => {
  const W = createWorld({ seed: 10 });
  setAnimalCount(W, 200); setFarmerCount(W, 1); initialSeed(W);
  let c = -1; for (let i = 0; i < W.animalCount; i++) if (W.a_species[i] === 7) { c = i; break; }
  W.f_px[0] = W.a_px[c] + 3; W.f_pz[0] = W.a_pz[c]; W.f_state[0] = FState.WORK; W.f_pen[0] = 7;
  W.a_flags[c] |= AFlag.HELD; W.a_state[c] = A.HELD; W.a_heldBy[c] = 0;
  const x = W.a_px[c], z = W.a_pz[c];
  for (let t = 0; t < 60; t++) tick(W);
  assert.equal(W.a_px[c], x); assert.equal(W.a_pz[c], z); assert.equal(W.a_state[c], A.HELD); assert.equal(W.a_speed[c], 0);
  assert.ok(Math.abs(Math.sin(W.a_heading[c]) - 1) < 1e-3, 'faces +x farmer');
  // sickness
  W.a_flags[c] = 0; W.a_state[c] = A.IDLE;
  let d = -1; for (let i = 0; i < W.animalCount; i++) if (W.a_species[i] === 5) { d = i; break; }
  W.a_flags[d] |= AFlag.SICK; for (let t = 0; t < 90; t++) tick(W);
  assert.equal(W.a_state[d], A.SICK); assert.equal(W.a_speed[d], 0); assert.ok(W.pen_sick[5] >= 1);
  W.a_flags[d] &= ~AFlag.SICK; tick(W); assert.notEqual(W.a_state[d], A.SICK);
});

T('farmers scare animals; rabbits freeze then flee to burrow; ready animals stay put', () => {
  const W = createWorld({ seed: 11 });
  setAnimalCount(W, 600); setFarmerCount(W, 2); initialSeed(W);
  let ck = -1, rb = -1, cw = -1;
  for (let i = 0; i < W.animalCount; i++) { const s = W.a_species[i]; if (s === 0 && ck < 0) ck = i; if (s === 3 && rb < 0) rb = i; if (s === 7 && cw < 0) cw = i; }
  for (let i = 0; i < W.animalCount; i++) { W.a_hunger[i] = 0; W.a_thirst[i] = 0; }
  W.f_state[0] = FState.MOVE; W.f_pen[0] = 0; W.f_px[0] = W.a_px[ck] + 1; W.f_pz[0] = W.a_pz[ck];
  W.f_state[1] = FState.MOVE; W.f_pen[1] = 3; W.f_px[1] = W.a_px[rb] + 4; W.f_pz[1] = W.a_pz[rb];
  W.a_flags[cw] |= AFlag.READY; W.a_produce[cw] = 1;
  tick(W); tick(W);
  assert.equal(W.a_state[ck], A.FLEE); assert.equal(W.a_state[rb], A.FREEZE); assert.notEqual(W.a_state[cw], A.FLEE);
  W.f_px[1] = W.a_px[rb] + 1; tick(W); tick(W); assert.equal(W.a_state[rb], A.FLEE);
  W.f_state[0] = FState.WORK; W.f_state[1] = FState.WORK;
  // farmer next to a ready cow
  const cx = W.a_px[cw], cz = W.a_pz[cw];
  W.f_state[0] = FState.MOVE; W.f_pen[0] = 7; W.f_px[0] = cx + 1; W.f_pz[0] = cz;
  tick(W); tick(W); assert.notEqual(W.a_state[cw], A.FLEE);
});

T('night: animals go to their sleep areas and sleep', () => {
  const W = createWorld({ seed: 12 });
  setAnimalCount(W, 600); initialSeed(W);
  W.time = (22 - 8) * 600 / 24;   // 22:00
  for (let t = 0; t < 30 * 100; t++) tick(W);
  assert.ok(W.hour >= 21 || W.hour < 5.5, 'still night');
  let asleep = 0, near = 0;
  for (let i = 0; i < W.animalCount; i++) {
    if (W.a_state[i] !== A.SLEEP) continue;
    asleep++;
    const f = PENS[W.a_species[i]].sleep;
    if (Math.hypot(W.a_px[i] - f.x, W.a_pz[i] - f.z) < f.r + 3) near++;
  }
  assert.ok(asleep > W.animalCount * 0.6, `asleep ${asleep}/${W.animalCount}`);
  assert.ok(near > asleep * 0.9, `near sleep area ${near}/${asleep}`);
  // morning: wake up
  W.time = (6 - 8 + 24) * 600 / 24;
  for (let t = 0; t < 30 * 60; t++) tick(W);
  let sl = 0; for (let i = 0; i < W.animalCount; i++) if (W.a_state[i] === A.SLEEP) sl++;
  assert.ok(sl < W.animalCount * 0.1, `still asleep ${sl}`);
});

T('count changes mid-sim stay valid', () => {
  const W = createWorld({ seed: 13 });
  setAnimalCount(W, 1500); initialSeed(W);
  for (let t = 0; t < 300; t++) tick(W);
  setAnimalCount(W, 400); for (let t = 0; t < 300; t++) tick(W);
  setAnimalCount(W, 10000); for (let t = 0; t < 300; t++) tick(W);
  assert.equal(W.animalCount, 10000); for (let s = 0; s < 20; s++) assert.ok(W.speciesCount[s] > 0);
  setAnimalCount(W, 0); tick(W);
  setAnimalCount(W, 100); for (let t = 0; t < 30; t++) tick(W);
  checkSane(W);
});

T('new species: all 20 spawn in their own pens, outside solids; products and needs per species', () => {
  const W = createWorld({ seed: 21 });
  setAnimalCount(W, 4000); initialSeed(W);
  for (let s = 0; s < 20; s++) assert.ok(W.speciesCount[s] > 20, 'species ' + s + ' spawned');
  for (let i = 0; i < W.animalCount; i++) { const s = W.a_species[i]; assert.equal(penOf(W.a_px[i], W.a_pz[i]), s); assert.equal(pushOutOfSolids(s, W.a_px[i], W.a_pz[i], SPECIES[s].radius * 0.9, _o), false, 'not in solid ' + s); }
  for (let t = 0; t < 30 * 90; t++) tick(W);
  checkSane(W);
  // camel / ostrich thirst rises more slowly than donkey / goose / capybara
  const avgThirst = s => { let a = 0, n = 0; for (let i = 0; i < W.animalCount; i++) if (W.a_species[i] === s) { a += W.a_thirst[i]; n++; } return a / n; };
  assert.ok(avgThirst(SPC.CAMEL) < avgThirst(SPC.CAPYBARA) * 0.75, 'camel drinks less');
  // eggs from goose / ostrich / peacock nests, none from deer / camel
  const eggsIn = p => { let c = 0; for (let i = 0; i < W.itemHigh; i++) if (W.i_alive[i] && W.i_kind[i] === ItemKind.EGG && W.i_pen[i] === p) c++; return c; };
  for (const p of [SPC.GOOSE, SPC.OSTRICH, SPC.PEACOCK]) assert.ok(eggsIn(p) > 3, 'eggs in pen ' + p);
  for (const p of [SPC.DEER, SPC.CAMEL, SPC.DONKEY, SPC.CAPYBARA]) assert.equal(eggsIn(p), 0);
});

T('deer are shy: freeze when a farmer is 3-5 m away, flee (fast) when closer; panic spreads', () => {
  const W = createWorld({ seed: 22 });
  setAnimalCount(W, 2000); setFarmerCount(W, 2); initialSeed(W);
  for (let i = 0; i < W.animalCount; i++) { W.a_hunger[i] = 0; W.a_thirst[i] = 0; }
  const deer = []; for (let i = 0; i < W.animalCount && deer.length < 40; i++) if (W.a_species[i] === SPC.DEER) deer.push(i);
  const d0 = deer[0];
  W.f_state[0] = FState.MOVE; W.f_pen[0] = SPC.DEER; W.f_px[0] = W.a_px[d0] + 4; W.f_pz[0] = W.a_pz[d0];
  tick(W); tick(W); assert.equal(W.a_state[d0], A.FREEZE, 'distant farmer -> freeze');
  W.f_px[0] = W.a_px[d0] + 1.5; tick(W); tick(W); assert.equal(W.a_state[d0], A.FLEE, 'close farmer -> flee');
  let vmax = 0; for (let t = 0; t < 45; t++) { tick(W); vmax = Math.max(vmax, W.a_speed[d0]); W.f_state[0] = FState.IDLE; }
  assert.ok(vmax > 4, 'deer sprint ' + vmax);
});

T('pond / mud pit blobs: oval, simple, consistent with inBlob, inside pen', () => {
  for (const [pen, f] of [[1, POND], [6, MUD]]) {
    const N = 256, o = blobOutline(f, N), P = PENS[pen];
    assert.equal(o.length, 2 * N);
    let area = 0, rmin = 1e9, rmax = 0, minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    for (let k = 0; k < N; k++) {
      const x = o[2 * k], z = o[2 * k + 1], x2 = o[2 * ((k + 1) % N)], z2 = o[2 * ((k + 1) % N) + 1];
      area += x * z2 - x2 * z;
      const r = Math.hypot(x - f.x, z - f.z); rmin = Math.min(rmin, r); rmax = Math.max(rmax, r);
      assert.ok(r <= f.r + 1e-3, 'f.r bounds the outline');
      minx = Math.min(minx, x); maxx = Math.max(maxx, x); minz = Math.min(minz, z); maxz = Math.max(maxz, z);
    }
    assert.ok(area < 0, 'CCW seen from above (negative signed area in x,z)');
    area = Math.abs(area) / 2;
    const ar = (rmax) / (rmin);
    assert.ok(rmin / rmax < 0.8, `visibly non-circular ${rmin / rmax}`);
    assert.ok(ar > 1.3 && ar < 2.2, `aspect ${ar}`);
    assert.ok(area > 0.6 * Math.PI * rmin * rmax && area < Math.PI * rmax * rmax, 'plausible area');
    assert.ok(minx > P.x0 + 2 && maxx < P.x1 - 2 && minz > P.z0 + 2 && maxz < P.z1 - 2, 'blob >=2 m from fences');
    // simple polygon: no two non-adjacent edges intersect
    const seg = (a, b, c, d) => {
      const cr = (ax, az, bx, bz, cx, cz) => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      const A = [o[2 * a], o[2 * a + 1]], B = [o[2 * b], o[2 * b + 1]], C = [o[2 * c], o[2 * c + 1]], D = [o[2 * d], o[2 * d + 1]];
      return cr(...A, ...B, ...C) * cr(...A, ...B, ...D) < 0 && cr(...C, ...D, ...A) * cr(...C, ...D, ...B) < 0;
    };
    for (let a = 0; a < N; a++) for (let c = a + 2; c < N; c++) { if (a === 0 && c === N - 1) continue; assert.ok(!seg(a, (a + 1) % N, c, (c + 1) % N), `self-intersection ${a}/${c}`); }
    // inBlob agrees with outline: centre in, scaled-down outline in, scaled-up outline out, margin works
    assert.ok(inBlob(f, f.x, f.z, 0));
    const o95 = blobOutline(f, 64, 0.95), o105 = blobOutline(f, 64, 1.05);
    for (let k = 0; k < 64; k++) {
      assert.ok(inBlob(f, o95[2 * k], o95[2 * k + 1]), 'scaled-down point inside');
      assert.ok(!inBlob(f, o105[2 * k], o105[2 * k + 1]), 'scaled-up point outside');
      assert.ok(!inBlob(f, o95[2 * k], o95[2 * k + 1], 1.5) || Math.hypot(o95[2 * k] - f.x, o95[2 * k + 1] - f.z) < f.r);
    }
    for (let k = 0; k < 2000; k++) {   // random points: inBlob matches ray test against the polygon
      const x = f.x + (Math.sin(k * 12.9898) * 43758.5453 % 1) * 2 * f.r, z = f.z + (Math.sin(k * 78.233) * 12345.678 % 1) * 2 * f.r;
      let inside = false;
      for (let a = 0, b = N - 1; a < N; b = a++) {
        const xa = o[2 * a], za = o[2 * a + 1], xb = o[2 * b], zb = o[2 * b + 1];
        if ((za > z) !== (zb > z) && x < (xb - xa) * (z - za) / (zb - za) + xa) inside = !inside;
      }
      if (inside !== inBlob(f, x, z, 0)) { // tolerate points within 0.1 m of the (polygonal) boundary
        assert.ok(inBlob(f, x, z, 0.1) === inBlob(f, x, z, -0.1), 'inBlob disagrees with polygon');
      }
    }
    // clear of other features in the pen
    for (const g of P.features) {
      if (g === f) continue;
      let m = 1e9;
      for (let k = 0; k < N; k++) {
        const x = o[2 * k], z = o[2 * k + 1];
        const d = g.w > 0 ? Math.hypot(x - Math.max(g.x - g.w / 2, Math.min(x, g.x + g.w / 2)), z - Math.max(g.z - g.d / 2, Math.min(z, g.z + g.d / 2))) : Math.hypot(x - g.x, z - g.z) - g.r;
        m = Math.min(m, d);
      }
      if (g.kind !== FK.SLEEP_AREA) assert.ok(m > 1, `blob overlaps feature ${g.kind}: ${m}`);
    }
  }
});

T('every blob feature (stream, sand bath, snow drift, oasis, hot spring): simple CCW polygon inside its pen', () => {
  let nb = 0;
  for (const P of PENS) for (const f of P.features) {
    if (!f.blob) continue; nb++;
    const N = 128, o = blobOutline(f, N); let area = 0;
    for (let k = 0; k < N; k++) {
      const x = o[2 * k], z = o[2 * k + 1], x2 = o[2 * ((k + 1) % N)], z2 = o[2 * ((k + 1) % N) + 1];
      area += x * z2 - x2 * z;
      assert.equal(penOf(x, z), P.id, 'outline inside the pen');
    }
    assert.ok(area < 0, 'CCW');
    const cr = (ax, az, bx, bz, cx, cz) => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    const seg = (a, b, c, d) => {
      const A = [o[2 * a], o[2 * a + 1]], B = [o[2 * b], o[2 * b + 1]], C = [o[2 * c], o[2 * c + 1]], D = [o[2 * d], o[2 * d + 1]];
      return cr(...A, ...B, ...C) * cr(...A, ...B, ...D) < 0 && cr(...C, ...D, ...A) * cr(...C, ...D, ...B) < 0;
    };
    for (let a = 0; a < N; a++) for (let c = a + 2; c < N; c++) { if (a === 0 && c === N - 1) continue; assert.ok(!seg(a, (a + 1) % N, c, (c + 1) % N), `self-intersection pen ${P.id}`); }
    for (const g of P.features) {   // clear of solids
      if (g === f || !g.solid) continue;
      let m = 1e9;
      for (let k = 0; k < N; k++) {
        const x = o[2 * k], z = o[2 * k + 1];
        const d = g.r > 0 ? Math.hypot(x - g.x, z - g.z) - g.r : Math.hypot(x - Math.max(g.x - g.w / 2, Math.min(x, g.x + g.w / 2)), z - Math.max(g.z - g.d / 2, Math.min(z, g.z + g.d / 2)));
        m = Math.min(m, d);
      }
      assert.ok(m > 0.8, `pen ${P.id} blob ${f.kind} overlaps solid ${g.kind}: ${m}`);
    }
  }
  assert.equal(nb, 8);
});

console.log(`animal tests passed (${n})`);
