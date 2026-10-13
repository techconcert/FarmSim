// Water depth + buoyancy + wading + drinking from water bodies (see config.js WATER block, sim/animals.js waterStep).
import assert from 'node:assert/strict';
import { SPECIES, PENS, AState as A, SIM_DT, FeatureKind as FK, blobPoint, inBlob, blobDepth, blobDepthT, isWaterKind, WADE_K, SINK_CAP, FLOAT_LIFT } from '../src/config.js';
import { createWorld, setAnimalCount, setFarmerCount, initialSeed, snapshotPrev, advanceClock, penOf } from '../src/ecs/world.js';
import { buildHash } from '../src/ecs/spatialHash.js';
import { updateAnimals } from '../src/sim/animals.js';
import { updateTasks } from '../src/sim/tasks.js';
import { updateFarmers } from '../src/sim/farmers.js';

let n = 0; const T = (name, fn) => { fn(); console.log('  ok', name); n++; };
const _o = new Float32Array(2);

T('depth profile: 0 at the shore, maxDepth at the centre, monotone along every radius; sand / snow are not water', () => {
  let blobs = 0;
  for (const P of PENS) for (const f of P.features) {
    if (!f.blob) continue;
    blobs++;
    const md = f.blob.maxDepth;
    if (f.kind === FK.SAND_BATH || f.kind === FK.SNOW_DRIFT) { assert.equal(md, 0); assert.equal(blobDepth(f, f.x, f.z), 0); continue; }
    assert.ok(md > 0 && md <= 1.1, 'maxDepth ' + md);
    assert.ok(Math.abs(blobDepth(f, f.x, f.z) - md) < 1e-9, 'centre = maxDepth');
    for (let k = 0; k < 48; k++) {
      const a = k * Math.PI / 24;
      blobPoint(f, a, 1, _o); assert.ok(blobDepth(f, _o[0], _o[1]) < 1e-3 * md + 1e-4, 'shore depth ~0');
      blobPoint(f, a, 1.2, _o); assert.equal(blobDepth(f, _o[0], _o[1]), 0, 'outside = 0');
      let prev = md + 1e-9;
      for (let j = 0; j <= 20; j++) {
        blobPoint(f, a, j / 20, _o);
        const d = blobDepth(f, _o[0], _o[1]); assert.ok(d <= prev + 1e-6, `monotone ${f.kind} a=${a} j=${j}`); prev = d;
        assert.ok(Math.abs(blobDepthT(f, _o[0], _o[1]) - j / 20) < 1e-3);
      }
    }
  }
  assert.ok(blobs >= 8);
  const want = { [FK.POND]: [1.1, 0.9], [FK.OASIS]: [1.0], [FK.HOT_SPRING]: [0.9], [FK.MUD_PIT]: [0.35] };
  for (const P of PENS) for (const f of P.features) if (f.blob && want[f.kind]) assert.ok(want[f.kind].includes(f.blob.maxDepth), 'maxDepth ' + f.kind);
  assert.ok(PENS[1].pool === PENS[1].swim && PENS[11].pool === PENS[11].swim && PENS[18].pool === PENS[18].wallow && PENS[19].pool === PENS[19].swim);
  assert.ok(PENS[6].pool === null && PENS[16].pool === null && PENS[14].pool === null && PENS[15].pool === null, 'mud / sand / snow are not drinkable');
});

T('species classification', () => {
  const buoy = SPECIES.map((d, i) => d.beh.buoy ? i : -1).filter(i => i >= 0), wade = SPECIES.map((d, i) => d.beh.wade ? i : -1).filter(i => i >= 0);
  assert.deepEqual(buoy, [1, 11, 19]); assert.deepEqual(wade, [6, 16, 18]);
});

const SW = [1, 11, 19], WD = [6, 16, 18], DRK = [1, 11, 18, 19];
T('600 s, 3000 animals, 40 farmers: buoyant float, waders sink <= 0.5 x height, no sink outside blobs, drinking at water bodies', () => {
  const W = createWorld({ seed: 77 });
  setAnimalCount(W, 3000); setFarmerCount(W, 40); initialSeed(W);
  const N = W.animalCount;
  const tick = () => { snapshotPrev(W); advanceClock(W, SIM_DT); buildHash(W.hash, W.a_px, W.a_pz, W.animalCount); updateAnimals(W, SIM_DT); updateTasks(W, SIM_DT); updateFarmers(W, SIM_DT); };
  const maxFloat = new Float32Array(20), minFloat = new Float32Array(20), maxFrac = new Float32Array(20), maxOverCap = new Float32Array(20);
  const outsideN = new Int32Array(N), nDrink = new Int32Array(20), nDrinkAt = new Int32Array(20), nTroughDrink = new Int32Array(20), nInWater = new Int32Array(20);
  const minPen = new Float32Array(20).fill(1);
  let maxOutsideWy = 0, wadeSlow = 0, swimmerSamples = 0, bobMax = 0, minWater = 1, waterTasks0 = 0, maxThirst = 0;
  const wt = () => W.stats.tasksDone[1];
  for (let t = 0; t < 600 / SIM_DT; t++) {
    tick();
    if (t % 5 !== 0) continue;
    for (let i = 0; i < N; i++) {
      const s = W.a_species[i], wy = W.a_wy[i];
      assert.ok(Number.isFinite(wy) && Number.isFinite(W.a_wvy[i]) && Number.isFinite(W.a_pwy[i]), 'finite wy');
      const x = W.a_px[i], z = W.a_pz[i];
      if (s !== 1 && s !== 11 && s !== 19 && s !== 6 && s !== 16 && s !== 18) { assert.equal(wy, 0, 'non-water species never offset ' + s); continue; }
      const f = PENS[s].swim || PENS[s].wallow, inside = inBlob(f, x, z, 0);
      if (SW.includes(s)) {
        if (wy > maxFloat[s]) maxFloat[s] = wy; if (wy < minFloat[s]) minFloat[s] = wy;
        assert.ok(wy >= -0.05 && wy <= FLOAT_LIFT + 1e-6, `buoyant ${s} a_wy ${wy}`);
        if (inside && W.a_state[i] === A.SWIM) swimmerSamples++;
      } else {
        const cap = SINK_CAP * SPECIES[s].height * W.a_scale[i];
        assert.ok(-wy <= cap + 0.02 && wy <= 1e-6, `wader ${s} sink ${-wy} cap ${cap}`);
        const fr = -wy / cap; if (fr > maxFrac[s]) maxFrac[s] = fr; if (-wy - cap > maxOverCap[s]) maxOverCap[s] = -wy - cap;
        if (wy < -0.05) nInWater[s]++;
      }
      // sunk / floating only inside blobs: outside for >= 3 s => back at 0
      if (inside) outsideN[i] = 0; else outsideN[i]++;
      if (outsideN[i] * 5 * SIM_DT >= 3) { const a = Math.abs(wy); if (a > maxOutsideWy) maxOutsideWy = a; }
      const st = W.a_state[i];
      if (st === A.DRINK && W.a_wdrink[i] === 1) { nDrink[s]++; if (inBlob(PENS[s].pool, x, z, -3.5)) nDrinkAt[s]++; }
      else if (st === A.DRINK) nTroughDrink[s]++;
      if (W.a_thirst[i] > maxThirst) maxThirst = W.a_thirst[i];
    }
    for (let p = 0; p < 20; p++) { if (W.pen_water[p] < minWater) minWater = W.pen_water[p]; if (W.pen_water[p] < minPen[p]) minPen[p] = W.pen_water[p]; }
  }
  console.log('    float lift max', SW.map(s => `${SPECIES[s].name} ${maxFloat[s].toFixed(3)}`).join(', '));
  console.log('    wader max sink / cap', WD.map(s => `${SPECIES[s].name} ${maxFrac[s].toFixed(2)} (samples sunk>5cm ${nInWater[s]})`).join(', '));
  console.log('    water-body drinkers (samples)', DRK.map(s => `${SPECIES[s].name} ${nDrink[s]} (at blob ${nDrinkAt[s]}, trough ${nTroughDrink[s]})`).join(', '), ' swimmers', swimmerSamples, ' max |wy| >3 s outside', maxOutsideWy.toFixed(4), ' min pen_water', minWater.toFixed(3), ' water chores', wt());
  for (const s of SW) assert.ok(maxFloat[s] > 0.005, SPECIES[s].name + ' floats at least once');
  for (const s of WD) { assert.ok(maxFrac[s] > 0.1, SPECIES[s].name + ' sinks > 0.1 x cap at least once: ' + maxFrac[s]); assert.ok(maxOverCap[s] <= 0.02, 'cap'); }
  assert.ok(maxOutsideWy < 0.005, 'wy returns to 0 within 3 s of leaving the blob: ' + maxOutsideWy);
  for (const s of DRK) { assert.ok(nDrink[s] > 0, SPECIES[s].name + ' drinks from its water body'); assert.ok(nDrinkAt[s] >= nDrink[s] * 0.8, SPECIES[s].name + ' stands at the blob'); }
  for (const s of [1, 11]) assert.ok(nTroughDrink[s] > 0, SPECIES[s].name + ' still uses the trough too');
  for (let i = 0; i < N; i++) { assert.equal(penOf(W.a_px[i], W.a_pz[i]), W.a_species[i], 'in pen'); assert.ok(Number.isFinite(W.a_px[i] + W.a_pz[i] + W.a_thirst[i])); }
  assert.ok(maxThirst <= 1, 'thirst bounded');
  const mt = new Float32Array(20), cn = new Int32Array(20); for (let i = 0; i < N; i++) { mt[W.a_species[i]] += W.a_thirst[i]; cn[W.a_species[i]]++; }
  console.log('    mean thirst at end', Array.from(mt).map((v, s) => (v / cn[s]).toFixed(2)).join(' '), '\n    min pen_water', Array.from(minPen).map(v => v.toFixed(2)).join(' '));
  for (const s of DRK) assert.ok(mt[s] / cn[s] < 0.95, SPECIES[s].name + ' mean thirst bounded');
  for (let p = 0; p < 20; p++) if (p !== 14 && p !== 18) assert.ok(W.pen_water[p] < 1, 'trough in use');
  assert.ok(wt() > 0, 'water chores still run');
});
console.log(`water tests passed (${n})`);
