import assert from 'node:assert/strict';
import { SPECIES, SPECIES_COUNT, Species, PENS, PEN_COUNT, WORLD, ItemKind, ItemState, TaskType, AFlag, AState, FeatureKind, MAX_ITEMS, MAX_TASKS, MAX_ANIMALS, MAX_FARMERS } from '../src/config.js';
import * as CFG from '../src/config.js';
import { mulberry32, hash01 } from '../src/ecs/rng.js';
import { createSpatialHash, buildHash, queryHash } from '../src/ecs/spatialHash.js';
import * as WM from '../src/ecs/world.js';
const { createWorld, setAnimalCount, setFarmerCount, spawnItem, despawnItem, setItemState, createTask, completeTask, cancelTask,
  despawnAnimal, penOf, pushOutOfSolids, clampToPen, terrainHeight, advanceClock, isNight, initialSeed, snapshotPrev, recountPenItems } = WM;
let n = 0; const ok = (name) => console.log('  ok', name), T = (name, fn) => { fn(); ok(name); n++; };

T('rng', () => {
  const a = mulberry32(5), b = mulberry32(5);
  for (let i = 0; i < 100; i++) { const x = a(); assert.equal(x, b()); assert.ok(x >= 0 && x < 1); }
  assert.equal(hash01(1, 2), hash01(1, 2)); assert.notEqual(hash01(1, 2), hash01(1, 3));
  const h = hash01(9, 9); assert.ok(h >= 0 && h < 1);
});

T('species table: 20 species, fixed ids/names, normalised shares', () => {
  assert.equal(SPECIES_COUNT, 20); assert.equal(SPECIES.length, 20); assert.equal(PEN_COUNT, 20);
  const names = ['chicken', 'duck', 'turkey', 'rabbit', 'goat', 'sheep', 'pig', 'cow', 'horse', 'llama', 'donkey', 'goose', 'alpaca', 'deer', 'ostrich', 'yak', 'buffalo', 'peacock', 'camel', 'capybara'];
  names.forEach((n, i) => { assert.equal(SPECIES[i].name, n); assert.equal(Species[n.toUpperCase()], i); });
  let tot = 0;
  for (const d of SPECIES) {
    tot += d.share; assert.ok(d.share > 0 && d.radius > 0 && d.walk > 0 && d.run >= d.walk && d.height > 0 && (d.legs === 2 || d.legs === 4));
    assert.ok(d.diet === 'grain' || d.diet === 'hay'); assert.ok(Number.isInteger(d.color) && Number.isInteger(d.color2)); assert.ok(d.beh && typeof d.beh === 'object');
  }
  assert.ok(Math.abs(tot - 1) < 1e-9, 'shares sum to 1');
  assert.ok(SPECIES[Species.CHICKEN].share > SPECIES[Species.COW].share * 4 && SPECIES[Species.DUCK].share > SPECIES[Species.HORSE].share * 3, 'small birds are more numerous');
  const prod = { goose: ItemKind.EGG, ostrich: ItemKind.EGG, peacock: ItemKind.EGG, yak: ItemKind.MILK, buffalo: ItemKind.MILK, alpaca: ItemKind.WOOL, deer: -1, camel: -1, capybara: -1, donkey: -1 };
  for (const [k, v] of Object.entries(prod)) assert.equal(SPECIES[Species[k.toUpperCase()]].produce, v, k + ' product');
  for (const k of ['camel', 'ostrich']) assert.ok(SPECIES[Species[k.toUpperCase()]].beh.thirst < 0.6, k + ' needs little water');
  assert.ok(SPECIES[Species.DEER].beh.scare > 3 && SPECIES[Species.DEER].run >= 7, 'deer shy + fast');
  assert.equal(SPECIES[Species.CAPYBARA].beh.swim, FeatureKind.HOT_SPRING); assert.equal(SPECIES[Species.BUFFALO].beh.wallow, FeatureKind.MUD_PIT);
  assert.equal(SPECIES[Species.GOOSE].beh.swim, FeatureKind.POND);
});

T('pens layout: 5 x 4 grid, 44 x 56 pens, 8 m service lanes, biomes + grounds', () => {
  assert.equal(PENS.length, 20);
  assert.equal(PENS[0].cx, -100); assert.equal(PENS[4].cx, 100); assert.equal(PENS[5].z0, 8);
  assert.equal(PENS[0].gateIn.z, -10.5); assert.equal(PENS[0].gateOut.z, -5.5);
  assert.equal(PENS[5].gateIn.z, 10.5); assert.equal(PENS[5].gateOut.z, 5.5);
  const rows = [[-64, -8, -8, -1], [8, 64, 8, 1], [-128, -72, -72, -1], [72, 128, 72, 1]];
  const biomes = ['coop', 'pond', 'roost', 'warren', 'crag', 'meadow', 'mudyard', 'pasture', 'paddock', 'highland', 'dry-corral', 'riverbank', 'alpine', 'forest', 'savanna', 'snow', 'marsh', 'garden', 'desert', 'tropical'];
  const grounds = new Set();
  for (const P of PENS) {
    const i = P.id % 5, r = rows[(P.id / 5) | 0];
    assert.equal(P.species, P.id); assert.equal(P.x0, -122 + 50 * i); assert.equal(P.x1 - P.x0, 44); assert.equal(P.z1 - P.z0, 56);
    assert.equal(P.z0, r[0]); assert.equal(P.z1, r[1]); assert.equal(P.gateEdgeZ, r[2]); assert.equal(P.s, r[3]);
    assert.equal(P.gateIn.x, P.cx); assert.equal(P.gateOut.x, P.cx);
    assert.equal(Math.abs(P.gateIn.z - P.gateEdgeZ), 2.5); assert.equal(Math.abs(P.gateOut.z - P.gateEdgeZ), 2.5); assert.equal(Math.sign(P.gateIn.z - P.gateEdgeZ), P.s);
    assert.equal(P.biome, biomes[P.id]);
    for (const k of ['base', 'light', 'dark']) assert.ok(Number.isInteger(P.ground[k]) && P.ground[k] >= 0 && P.ground[k] <= 0xffffff);
    grounds.add(P.ground.base);
    assert.ok(P.feeder && P.water && P.sleep);
    assert.equal(P.feeder.kind, SPECIES[P.species].diet === 'grain' ? FeatureKind.FEED_TROUGH : FeatureKind.HAY_FEEDER);
    for (const f of P.features) assert.equal(penOf(f.x, f.z), P.id, `feature ${f.kind} pen ${P.id}`);
    if (SPECIES[P.species].produce === ItemKind.EGG) assert.ok(P.nest, 'egg layers have a nest (pen ' + P.id + ')');
    if (SPECIES[P.species].beh.swim) assert.ok(P.swim && P.swim.blob); if (SPECIES[P.species].beh.wallow) assert.ok(P.wallow && P.wallow.blob);
    if (SPECIES[P.species].beh.bath) assert.ok(P.bath);
  }
  assert.equal(grounds.size, 11, 'pens 0-9 share the meadow, 10-19 each have their own ground');
  // lanes are exactly 8 m wide between the row pairs
  assert.equal(PENS[10].z1 - PENS[0].z0, -8); assert.equal(PENS[0].z0 - PENS[10].z1, 8); assert.equal(PENS[15].z0 - PENS[5].z1, 8);
  assert.ok(PENS[0].nest && PENS[1].nest && PENS[2].nest && !PENS[3].nest);
  // new-pen biome features (exact kinds per the contract)
  const K = FeatureKind, has = (p, ...ks) => { for (const k of ks) assert.ok(PENS[p].features.some(f => f.kind === k), `pen ${p} has feature ${k}`); };
  has(10, K.WATER_TROUGH, K.HAY_FEEDER, K.BARREL_STACK, K.SHADE_SHED); has(11, K.WATER_TROUGH, K.POND, K.REED_PATCH, K.NEST); has(12, K.WATER_TROUGH, K.HAY_FEEDER, K.STONE_WALL, K.ROCK_PILE);
  has(13, K.WATER_TROUGH, K.SALT_LICK, K.FALLEN_LOG, K.THICKET); has(14, K.WATER_TROUGH, K.FEED_TROUGH, K.ACACIA, K.SAND_BATH); has(15, K.WATER_TROUGH, K.HAY_FEEDER, K.SNOW_DRIFT, K.ROCK_PILE);
  has(16, K.WATER_TROUGH, K.HAY_FEEDER, K.MUD_PIT, K.CATTAILS); has(17, K.WATER_TROUGH, K.FEED_TROUGH, K.FOUNTAIN, K.HEDGE, K.PERCH); has(18, K.WATER_TROUGH, K.HAY_FEEDER, K.OASIS, K.PALM, K.DUNE);
  has(19, K.WATER_TROUGH, K.HAY_FEEDER, K.HOT_SPRING, K.BAMBOO);
  for (const [p, k] of [[13, K.THICKET], [14, K.ACACIA], [17, K.FOUNTAIN], [17, K.HEDGE], [18, K.PALM], [19, K.BAMBOO]]) assert.ok(PENS[p].features.filter(f => f.kind === k).every(f => f.solid), `solid ${k}`);
  assert.ok(PENS[17].features.find(f => f.kind === K.FOUNTAIN).r > 0, 'fountain is a solid circle');
  const kinds = Object.values(K); assert.equal(new Set(kinds).size, kinds.length, 'unique feature kind ids');
});

T('world bounds + corridors + feature layout: inside world, no overlaps, gate approach clear', () => {
  const g = WORLD.grid;
  for (const P of PENS) { assert.ok(P.x0 >= g.x0 && P.x1 <= g.x1 && P.z0 >= g.z0 && P.z1 <= g.z1); }
  assert.ok(WORLD.x0 <= g.x0 - 30 && WORLD.x1 >= g.x1 + 30 && WORLD.z0 <= g.z0 - 30 && WORLD.z1 >= g.z1 + 30, '>= 30 m margin around the grid');
  assert.equal(WORLD.laneN.z0, -72); assert.equal(WORLD.laneN.z1, -64); assert.equal(WORLD.laneS.z0, 64); assert.equal(WORLD.laneS.z1, 72);
  assert.ok(WORLD.corridorX > g.x1 + 1 && WORLD.corridorX < 125);
  for (const P of PENS) {
    const sol = P.features.filter(f => f.solid);
    // 1) nothing within the gate funnel (|x-cx|<=4, depth < 10) except the troughs
    for (const f of P.features) {
      if (f.kind === FeatureKind.WATER_TROUGH || f.kind === FeatureKind.FEED_TROUGH) continue;
      const ld = Math.abs(f.z - P.gateEdgeZ), ext = f.blob ? f.r : f.r > 0 ? f.r : Math.max(f.w, f.d) / 2;
      assert.ok(ld - ext > 8 || Math.abs(f.x - P.cx) - ext > 5 || f.kind === FeatureKind.SLEEP_AREA && ld > 8, `pen ${P.id} feature ${f.kind} blocks the gate funnel`);
    }
    // 2) features keep inside the fences (>=0.9 m, blobs >= 2 m) -- new pens only (0-9 are legacy layouts)
    for (const f of P.id < 10 ? [] : P.features) {
      const ex = f.blob ? f.blob.rmax : f.r > 0 ? f.r : f.w / 2, ez = f.blob ? f.blob.rmax : f.r > 0 ? f.r : f.d / 2;
      const m = f.blob ? 2 : (f.kind === FeatureKind.SLEEP_AREA ? -3 : 0.9);
      assert.ok(f.x - ex >= P.x0 + m - 1e-6 && f.x + ex <= P.x1 - m + 1e-6 && f.z - ez >= P.z0 + m - 1e-6 && f.z + ez <= P.z1 - m + 1e-6, `pen ${P.id} feature ${f.kind} too close to a fence`);
    }
    // 3) solids / blobs do not overlap each other (rects use half-diagonal-free exact test)
    const sh = f => ({ f, cx: f.x, cz: f.z, hw: f.w / 2, hd: f.d / 2, r: f.blob ? f.blob.rmax : f.r });
    const items = P.features.filter(f => f.solid || f.blob).map(sh);
    for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
      const A = items[a], B = items[b];
      const dist = (R, x, z) => R.r > 0 ? Math.hypot(x - R.cx, z - R.cz) - R.r : Math.hypot(x - Math.max(R.cx - R.hw, Math.min(x, R.cx + R.hw)), z - Math.max(R.cz - R.hd, Math.min(z, R.cz + R.hd)));
      // centre-to-shape distance both ways is a conservative separation check for these small layouts
      const gap = Math.min(dist(A, B.cx, B.cz) - (B.r > 0 ? B.r : Math.min(B.hw, B.hd)), dist(B, A.cx, A.cz) - (A.r > 0 ? A.r : Math.min(A.hw, A.hd)));
      assert.ok(gap > 0.2, `pen ${P.id}: features ${A.f.kind} and ${B.f.kind} overlap (gap ${gap.toFixed(2)})`);
    }
    // 4) sleeping area centre is on open ground (not in a solid or a blob)
    const sl = P.sleep, o = new Float32Array(2);
    assert.equal(pushOutOfSolids(P.id, sl.x, sl.z, 0.3, o), false, `pen ${P.id} sleep centre inside a solid`);
    for (const f of P.features) if (f.blob) assert.ok(!CFG.inBlob(f, sl.x, sl.z, -0.5), `pen ${P.id} sleep centre inside blob ${f.kind}`);
  }
});

T('penOf O(1) grid == brute force', () => {
  const brute = (x, z) => { for (const P of PENS) if (x >= P.x0 && x <= P.x1 && z >= P.z0 && z <= P.z1) return P.id; return -1; };
  const rnd = mulberry32(77);
  for (let k = 0; k < 20000; k++) {
    const x = (rnd() * 2 - 1) * 180, z = (rnd() * 2 - 1) * 170;
    assert.equal(penOf(x, z), brute(x, z), `penOf(${x},${z})`);
  }
  for (const P of PENS) for (const x of [P.x0, P.x1, P.x0 - 1e-6, P.x1 + 1e-6, P.cx]) for (const z of [P.z0, P.z1, P.z0 - 1e-6, P.z1 + 1e-6, P.cz]) assert.equal(penOf(x, z), brute(x, z));
  assert.equal(penOf(0, -68), -1); assert.equal(penOf(0, 68), -1); assert.equal(penOf(-124, 0), -1);
});

T('spawn 10000 then reduce to 1000', () => {
  const W = createWorld({ seed: 7 });
  setAnimalCount(W, 10000);
  assert.equal(W.animalCount, 10000);
  const chk = (total) => {
    let sum = 0;
    for (let s = 0; s < 20; s++) {
      sum += W.speciesCount[s];
      assert.ok(Math.abs(W.speciesCount[s] - SPECIES[s].share * total) <= 1.0001, `species ${s}: ${W.speciesCount[s]} vs ${SPECIES[s].share * total}`);
    }
    assert.equal(sum, total);
    const cnt = new Int32Array(20);
    for (let i = 0; i < W.animalCount; i++) {
      const s = W.a_species[i]; cnt[s]++;
      assert.equal(penOf(W.a_px[i], W.a_pz[i]), s, 'in own pen');
      assert.ok(Number.isFinite(W.a_px[i]) && Number.isFinite(W.a_pz[i]));
      const out = new Float32Array(2);
      assert.equal(pushOutOfSolids(s, W.a_px[i], W.a_pz[i], SPECIES[s].radius, out), false, 'not in solid');
    }
    for (let s = 0; s < 20; s++) { assert.equal(cnt[s], W.speciesCount[s]); assert.equal(W.pen_count[s], cnt[s]); }
  };
  chk(10000);
  setAnimalCount(W, 1000);
  assert.equal(W.animalCount, 1000);
  chk(1000);
  setAnimalCount(W, 2000); chk(2000);
  setAnimalCount(W, 0); assert.equal(W.animalCount, 0);
});

T('spatial hash == brute force', () => {
  const W = createWorld({ seed: 3 });
  setAnimalCount(W, 3000);
  buildHash(W.hash, W.a_px, W.a_pz, W.animalCount);
  const out = new Int32Array(4000), rnd = mulberry32(11);
  for (let q = 0; q < 200; q++) {
    const x = (rnd() * 2 - 1) * 170, z = (rnd() * 2 - 1) * 170, r = 0.5 + rnd() * 6;
    const got = queryHash(W.hash, W.a_px, W.a_pz, x, z, r, out, 4000);
    const g = Array.from(out.subarray(0, got)).sort((a, b) => a - b);
    const exp = [];
    for (let i = 0; i < W.animalCount; i++) { const dx = W.a_px[i] - x, dz = W.a_pz[i] - z; if (dx * dx + dz * dz <= r * r) exp.push(i); }
    assert.deepEqual(g, exp);
  }
  // maxOut cap
  assert.equal(queryHash(W.hash, W.a_px, W.a_pz, -100, 40, 30, out, 5) <= 5, true);
  // standalone with edge clamp
  const H = createSpatialHash(2, 160, 4), px = new Float32Array([-200, 0, 170, 159.9]), pz = new Float32Array([0, 0, 0, 159.9]);
  buildHash(H, px, pz, 4);
  const o = new Int32Array(8);
  assert.equal(queryHash(H, px, pz, 0, 0, 1, o, 8), 1);
  assert.equal(queryHash(H, px, pz, 159.9, 159.9, 1, o, 8), 1);
});

T('task dedupe mask + free list', () => {
  const W = createWorld();
  const t = createTask(W, TaskType.FEED, 2, -1, 2);
  assert.ok(t >= 0); assert.equal(W.pen_taskMask[2], 1 << TaskType.FEED);
  assert.equal(createTask(W, TaskType.FEED, 2, -1, 2), -1);
  const t2 = createTask(W, TaskType.WATER, 2, -1, 1); assert.ok(t2 >= 0 && t2 !== t);
  assert.ok(createTask(W, TaskType.FEED, 3, -1, 1) >= 0);
  assert.equal(W.stats.tasksCreated[TaskType.FEED], 2);
  assert.equal(W.taskCount, 3);
  completeTask(W, t);
  assert.equal(W.pen_taskMask[2], 1 << TaskType.WATER); assert.equal(W.stats.tasksDone[TaskType.FEED], 1);
  const t3 = createTask(W, TaskType.FEED, 2, -1, 1); assert.equal(t3, t);
  cancelTask(W, t3); assert.equal(W.pen_taskMask[2], 1 << TaskType.WATER);
  assert.equal(W.stats.tasksDone[TaskType.FEED], 1);
  cancelTask(W, t3); // double cancel harmless
  assert.equal(W.taskCount, 2);
  for (let i = 0; i < MAX_TASKS + 5; i++) createTask(W, i % 7, i % 20, -1, 1);
  assert.ok(W.taskCount <= MAX_TASKS);
});

T('items + pen aggregates', () => {
  const W = createWorld();
  const e = spawnItem(W, ItemKind.EGG, 0, 0, 0, 0), m = spawnItem(W, ItemKind.MANURE, 0, 0, 0, 0);
  spawnItem(W, ItemKind.EGG, 0, 0, 0, -1);
  assert.equal(W.pen_eggs[0], 1); assert.equal(W.pen_manure[0], 1); assert.equal(W.itemCount, 3);
  setItemState(W, e, ItemState.RESERVED, 0); assert.equal(W.pen_eggs[0], 1);
  setItemState(W, e, ItemState.CARRIED, 0, 3); assert.equal(W.pen_eggs[0], 0);
  despawnItem(W, e); assert.equal(W.pen_eggs[0], 0); assert.equal(W.itemCount, 2);
  despawnItem(W, m); despawnItem(W, m); assert.equal(W.pen_manure[0], 0); assert.equal(W.itemCount, 1);
  const r = spawnItem(W, ItemKind.EGG, 1, 1, 1, 1); assert.ok(W.i_alive[r]);
  recountPenItems(W); assert.equal(W.pen_eggs[1], 1);
  for (let i = 0; i < MAX_ITEMS + 10; i++) spawnItem(W, ItemKind.MANURE, 0, 0, 0, 2);
  assert.equal(W.itemCount, MAX_ITEMS); assert.equal(spawnItem(W, 0, 0, 0, 0, 0), -1);
});

T('despawnAnimal fixes task targets and leaders', () => {
  const W = createWorld({ seed: 9 });
  setAnimalCount(W, 100);
  // find two cows (species 7)
  const cows = []; for (let i = 0; i < W.animalCount; i++) if (W.a_species[i] === 7) cows.push(i);
  const last = W.animalCount - 1;
  const goats = []; for (let i = 0; i < W.animalCount; i++) if (W.a_species[i] === 4) goats.push(i);
  const tCow = createTask(W, TaskType.MILK, 7, cows[0], 1);
  const tGoat = createTask(W, TaskType.MILK, 4, goats[goats.length - 1], 1);
  W.a_leader[0] = last;
  const lastSp = W.a_species[last], lastX = W.a_px[last];
  W.a_flags[cows[0]] |= AFlag.READY;
  despawnAnimal(W, cows[0]);
  assert.equal(W.t_alive[tCow], 0); assert.equal(W.pen_taskMask[7] & (1 << TaskType.MILK), 0);
  assert.equal(W.animalCount, 99);
  if (goats[goats.length - 1] === last) assert.equal(W.t_target[tGoat], cows[0]);
  if (cows[0] !== last) { assert.equal(W.a_px[cows[0]], lastX); assert.equal(W.a_leader[0], cows[0]); }
  assert.equal(W.speciesCount[lastSp] + W.speciesCount.reduce((a, b) => a + b, 0) - W.speciesCount[lastSp], 99);
});

T('farmers', () => {
  const W = createWorld({ seed: 2 });
  setFarmerCount(W, 24);
  assert.equal(W.farmerCount, 24);
  for (let i = 0; i < 24; i++) { assert.equal(W.f_type[i], i % 4); assert.ok(Math.abs(W.f_px[i] + 137) <= 3.001); assert.equal(W.f_carryKind[i], 255); }
  const t = createTask(W, TaskType.FEED, 0, -1, 1);
  W.t_state[t] = 1; W.t_farmer[t] = 23; W.f_task[23] = t;
  const it = spawnItem(W, ItemKind.FEED, 0, 1, 0, -1); setItemState(W, it, ItemState.CARRIED, 23, 0);
  const egg = spawnItem(W, ItemKind.EGG, 0, 0, 0, 0); setItemState(W, egg, ItemState.RESERVED, 23, 0);
  assert.equal(W.pen_eggs[0], 1);
  setFarmerCount(W, 20);
  assert.equal(W.farmerCount, 20);
  assert.equal(W.t_state[t], 0); assert.equal(W.t_farmer[t], -1);
  assert.equal(W.i_alive[it], 0); assert.equal(W.i_state[egg], ItemState.GROUND);
  assert.equal(WM.despawnFarmer(W, 3), false);
  setFarmerCount(W, 999); assert.equal(W.farmerCount, 200); assert.equal(MAX_FARMERS, 200);
  for (let i = 0; i < 200; i++) { assert.equal(W.f_type[i], i % 4); assert.equal(penOf(W.f_px[i], W.f_pz[i]), -1, 'farmers spawn outside pens'); assert.ok(W.f_px[i] < -125 && W.f_px[i] > -145); }
  const tc = [0, 0, 0, 0]; for (let i = 0; i < 200; i++) tc[W.f_type[i]]++; assert.deepEqual(tc, [50, 50, 50, 50], 'farmer types evenly distributed');
});

T('geometry helpers', () => {
  const out = new Float32Array(2);
  // goat rock mound
  assert.equal(terrainHeight(0, 0), 0);
  const rk = PENS[4].features.find(f => f.kind === FeatureKind.ROCK);
  assert.ok(Math.abs(terrainHeight(rk.x, rk.z) - rk.h) < 1e-5);
  // push out of coop (pen 0)
  const coop = PENS[0].features.find(f => f.kind === FeatureKind.COOP);
  assert.equal(pushOutOfSolids(0, coop.x, coop.z, 0.3, out), true);
  assert.equal(pushOutOfSolids(0, out[0], out[1], 0.3 - 1e-3, new Float32Array(2)), false);
  assert.equal(pushOutOfSolids(0, coop.x + coop.w / 2 + 0.1, coop.z, 0.3, out), true);
  assert.ok(out[0] >= coop.x + coop.w / 2 + 0.3 - 1e-4);
  // circle solid
  const hf = PENS[5].feeder; assert.equal(pushOutOfSolids(5, hf.x + 0.1, hf.z, 0.5, out), true);
  assert.ok(Math.hypot(out[0] - hf.x, out[1] - hf.z) >= hf.r + 0.5 - 1e-4);
  clampToPen(0, 999, -999, 0.5, out);
  assert.equal(out[0], PENS[0].x1 - 0.5); assert.equal(out[1], PENS[0].z0 + 0.5);
  assert.equal(penOf(0, 0), -1); assert.equal(penOf(-100, -30), 0); assert.equal(penOf(100, 30), 9);
});

T('clock + seed + snapshot', () => {
  const W = createWorld();
  assert.equal(W.hour, 8);
  advanceClock(W, 300); assert.ok(Math.abs(W.hour - 20) < 1e-9);
  advanceClock(W, 25); assert.ok(isNight(W) === (W.hour >= 21 || W.hour < 5.5));
  W.hour = 22; assert.ok(isNight(W)); W.hour = 3; assert.ok(isNight(W)); W.hour = 12; assert.ok(!isNight(W));
  advanceClock(W, 600); assert.equal(W.day, 1);
  assert.equal(W.tick, 3);
  setAnimalCount(W, 50); setFarmerCount(W, 4);
  W.a_px[0] = 5; W.f_px[0] = 6; snapshotPrev(W);
  assert.equal(W.a_ppx[0], 5); assert.equal(W.f_ppx[0], 6);
  initialSeed(W);
  for (let p = 0; p < 20; p++) { assert.ok(W.pen_food[p] >= 0.3 && W.pen_food[p] <= 0.9); assert.ok(W.pen_manure[p] >= 3 && W.pen_manure[p] <= 8); }
  for (let p = 0; p < 20; p++) { if (SPECIES[p].produce === ItemKind.EGG) assert.ok(W.pen_eggs[p] >= 3 && W.pen_eggs[p] <= 6, 'eggs pen ' + p); else assert.equal(W.pen_eggs[p], 0); }
});

T("config blob helpers", () => {
  const C = CFG;
  const blobKinds = [FeatureKind.POND, FeatureKind.MUD_PIT, FeatureKind.SAND_BATH, FeatureKind.SNOW_DRIFT, FeatureKind.OASIS, FeatureKind.HOT_SPRING];
  for (const f of PENS.flatMap(p => p.features).filter(x => x.blob)) {
    assert.ok(blobKinds.includes(f.kind));
    assert.ok(f.blob.rx > f.blob.rz && f.r > f.blob.rx * 0.97, 'blob params + bounding r');
    const a = C.blobOutline(f, 32), b = C.blobOutline(f, 32);
    assert.deepEqual(Array.from(a), Array.from(b));   // deterministic
    const h = C.blobOutline(f, 32, 0.5);
    for (let i = 0; i < 32; i++) { assert.ok(Math.abs(h[2 * i] - (f.x + (a[2 * i] - f.x) * 0.5)) < 1e-3); assert.ok(Math.abs(h[2 * i + 1] - (f.z + (a[2 * i + 1] - f.z) * 0.5)) < 1e-3); }
    assert.ok(C.inBlob(f, f.x, f.z, 0) && !C.inBlob(f, f.x + f.r + 1, f.z, 0) && !C.inBlob(f, f.x, f.z, f.r));
    const o = new Float32Array(2);
    assert.equal(C.clampToBlob(f, f.x + 40, f.z - 30, 0.5, o), true);
    assert.ok(C.inBlob(f, o[0], o[1], 0.4));
    assert.equal(C.clampToBlob(f, f.x, f.z, 0.5, o), false);
  }
  for (const k of blobKinds) assert.ok(PENS.some(p => p.features.some(f => f.kind === k)), 'blob kind used ' + k);
  const pond = PENS[1].features.find(x => x.kind === FeatureKind.POND);
  assert.ok(pond.blob.rx / pond.blob.rz > 1.3 && pond.blob.rx / pond.blob.rz < 2);
  const stream = PENS[11].features.find(x => x.kind === FeatureKind.POND);
  assert.ok(stream.blob.rx / stream.blob.rz > 3, 'goose stream is elongated');
});

console.log(`world tests passed (${n})`);
