// Obstacle avoidance: trees in every pen (placement rules), animal steering around solids, farmer routes around circles, per-pen reachability.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { PENS, PEN_COUNT, SPECIES, FeatureKind as K, AState as A, FState, SIM_DT, FARMER_RADIUS, blobPoint, inBlob } from '../src/config.js';
import { createWorld, setAnimalCount, setFarmerCount, initialSeed, snapshotPrev, advanceClock, penOf, pushOutOfSolids } from '../src/ecs/world.js';
import { buildHash } from '../src/ecs/spatialHash.js';
import { updateAnimals } from '../src/sim/animals.js';
import { updateTasks } from '../src/sim/tasks.js';
import { updateFarmers } from '../src/sim/farmers.js';
import { buildRoute } from '../src/sim/nav.js';

let n = 0; const T = (name, fn) => { fn(); console.log('  ok', name); n++; };
const TREELIKE = [K.TREE, K.PALM, K.ACACIA, K.THICKET, K.BAMBOO];
const treesOf = P => P.features.filter(f => f.kind === K.TREE);
const solidTrees = P => P.features.filter(f => TREELIKE.includes(f.kind));
const rectGap = (f, x, z) => { const nx = Math.max(f.x - f.w / 2, Math.min(x, f.x + f.w / 2)), nz = Math.max(f.z - f.d / 2, Math.min(z, f.z + f.d / 2)); return Math.hypot(x - nx, z - nz); };
const _o = new Float32Array(2);
function blobGap(f, x, z) { let m = 1e9; for (let k = 0; k < 180; k++) { blobPoint(f, k * Math.PI / 90, 1, _o, 0); m = Math.min(m, Math.hypot(x - _o[0], z - _o[1])); } return inBlob(f, x, z, 0) ? -m : m; }

const STYLE_PEN = { 10: ['acacia'], 11: ['willow'], 12: ['pine'], 13: ['oak', 'pine'], 15: ['spruce'], 16: ['willow'], 17: ['orchard'] };
const WANT = [1, 2, 1, 2, 1, 2, 2, 3, 3, 2, 1, 2, 3, 4, 2, 3, 2, 3, 2, 3];   // tree-like solids per pen (K.TREE + existing PALM/ACACIA/THICKET/BAMBOO)

T('trees: every pen has trees of the right style/count, K.TREE is a solid circle with trunk radius 0.9-1.4', () => {
  assert.equal(K.TREE, 40);
  const kinds = Object.values(K); assert.equal(new Set(kinds).size, kinds.length);
  for (const P of PENS) {
    const ts = solidTrees(P);
    assert.ok(ts.length >= 1, `pen ${P.id} has a tree`);
    if (P.id < 10) assert.ok(treesOf(P).length >= 1 && treesOf(P).length <= 3 && treesOf(P).every(t => t.style === 'oak'), `pen ${P.id} oaks`);
    if (P.id === 0) assert.equal(treesOf(P).length, 1, 'coop pen stays sparse');
    assert.equal(ts.length, WANT[P.id], `pen ${P.id} tree total`);
    for (const t of treesOf(P)) {
      assert.ok(t.solid && t.r >= 0.9 && t.r <= 1.4 && t.h > 0 && typeof t.style === 'string', `pen ${P.id} tree fields`);
      assert.ok(['oak', 'willow', 'pine', 'spruce', 'acacia', 'orchard', 'palm'].includes(t.style));
    }
    if (STYLE_PEN[P.id]) for (const t of treesOf(P)) assert.ok(STYLE_PEN[P.id].includes(t.style), `pen ${P.id} style ${t.style}`);
  }
});

T('trees: placement rules (gate >= 8 m, fences >= 3 m, clear of features / blobs / sleep, >= 10 m apart)', () => {
  for (const P of PENS) {
    const ts = solidTrees(P);
    for (const t of ts) {
      const isNew = t.kind === K.TREE, r = t.r || 1;
      if (isNew) {
        assert.ok(Math.abs(t.z - P.gateEdgeZ) >= 8 + r, `pen ${P.id} tree (${t.x},${t.z}) too close to the gate line`);
        assert.ok(Math.hypot(t.x - P.gateIn.x, t.z - P.gateIn.z) >= 8 && Math.hypot(t.x - P.gateOut.x, t.z - P.gateOut.z) >= 8);
        assert.ok(t.x - r - P.x0 >= 3 && P.x1 - t.x - r >= 3, `pen ${P.id} tree too close to a side fence`);
        const far = P.s > 0 ? P.z1 - t.z : t.z - P.z0; assert.ok(far - r >= 3, `pen ${P.id} tree too close to the back fence`);
        for (const f of P.features) {
          if (f === t) continue;
          let g;
          if (f.kind === K.TREE || TREELIKE.includes(f.kind)) { assert.ok(Math.hypot(f.x - t.x, f.z - t.z) >= 10, `pen ${P.id}: trees ${f.kind}/${t.kind} closer than 10 m`); continue; }
          if (f.blob) { g = blobGap(f, t.x, t.z) - r; assert.ok(g >= 2, `pen ${P.id}: tree near blob ${f.kind} (gap ${g.toFixed(1)})`); assert.ok(Math.hypot(f.x - t.x, f.z - t.z) - f.r - r > 0.2); continue; }
          if (f.kind === K.SLEEP_AREA) { g = Math.hypot(f.x - t.x, f.z - t.z) - f.r - r; assert.ok(g >= 1, `pen ${P.id}: tree in sleep area (gap ${g.toFixed(1)})`); continue; }
          if (f.r > 0) g = Math.hypot(f.x - t.x, f.z - t.z) - f.r - r; else g = rectGap(f, t.x, t.z) - r;
          const need = f.solid || f.kind === K.NEST || f.kind === K.FEED_TROUGH || f.kind === K.WATER_TROUGH ? 3 : 1.5;
          assert.ok(g >= need, `pen ${P.id}: tree (${t.x},${t.z}) only ${g.toFixed(1)} m from feature ${f.kind}`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------- reachability
const RAD = p => SPECIES[p].radius;
function blocked(P, x, z, rad) {   // inside a solid inflated by rad
  for (const f of P.solids) {
    if (f.r > 0) { if (Math.hypot(x - f.x, z - f.z) < f.r + rad) return true; }
    else if (rectGap(f, x, z) < rad) return true;
  }
  return false;
}
T('reachability: on a 0.5 m grid per pen (body-radius inflated) every feeder / trough / nest / sleep / blob / bath target is reachable from the gate', () => {
  const CELL = 0.5;
  for (const P of PENS) {
    const rad = RAD(P.id), m = rad + 0.4;
    const nx = Math.floor((P.x1 - P.x0) / CELL), nz = Math.floor((P.z1 - P.z0) / CELL);
    const free = new Uint8Array(nx * nz), seen = new Uint8Array(nx * nz);
    const cx = i => P.x0 + (i + 0.5) * CELL, cz = j => P.z0 + (j + 0.5) * CELL;
    let nfree = 0;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const x = cx(i), z = cz(j);
      if (x < P.x0 + m || x > P.x1 - m || z < P.z0 + m || z > P.z1 - m) continue;
      if (!blocked(P, x, z, rad)) { free[j * nx + i] = 1; nfree++; }
    }
    // flood fill (8-connected, no corner cutting) from the cell nearest the gate-in point
    const si = Math.min(nx - 1, Math.max(0, Math.floor((P.gateIn.x - P.x0) / CELL))), sj = Math.min(nz - 1, Math.max(0, Math.floor((P.gateIn.z - P.z0) / CELL)));
    assert.ok(free[sj * nx + si], `pen ${P.id}: gate-in cell is free`);
    const q = [sj * nx + si]; seen[q[0]] = 1; let reach = 0;
    for (let h = 0; h < q.length; h++) {
      const c = q[h], ci = c % nx, cj = (c / nx) | 0; reach++;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const a = ci + di, b = cj + dj; if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
        const k = b * nx + a; if (seen[k] || !free[k]) continue;
        if (di && dj && (!free[cj * nx + a] || !free[b * nx + ci])) continue;
        seen[k] = 1; q.push(k);
      }
    }
    assert.ok(reach >= 0.98 * nfree, `pen ${P.id}: ${(100 * reach / nfree).toFixed(1)}% of walkable cells reachable (no trapped pockets)`);
    const near = (pred, label) => {   // some reachable cell satisfying pred
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) if (seen[j * nx + i] && pred(cx(i), cz(j))) return;
      assert.fail(`pen ${P.id} (${SPECIES[P.id].name}): ${label} unreachable`);
    };
    const edge = (f, label) => near((x, z) => (f.r > 0 ? Math.hypot(x - f.x, z - f.z) - f.r : rectGap(f, x, z)) < rad + 1.2, label);
    edge(P.feeder, 'feeder'); edge(P.water, 'water trough');
    if (P.nest) near((x, z) => Math.abs(x - P.nest.x) <= P.nest.w / 2 + 1 && Math.abs(z - P.nest.z) <= P.nest.d / 2 + 1, 'nest');
    near((x, z) => Math.hypot(x - P.sleep.x, z - P.sleep.z) < P.sleep.r * 0.85, 'sleep area');
    for (const b of [P.swim, P.wallow, P.bath]) if (b) near((x, z) => b.blob ? inBlob(b, x, z, rad + 0.2) : Math.hypot(x - b.x, z - b.z) < b.r, `blob/bath feature ${b.kind}`);
    if (P.dungPile) near((x, z) => Math.hypot(x - P.dungPile.x, z - P.dungPile.z) < P.dungPile.r, 'dung pile');
    for (const f of P.features) if (f.kind === K.BURROW || f.kind === K.ROCK) near((x, z) => Math.hypot(x - f.x, z - f.z) < f.r + 1.5, `feature ${f.kind}`);
    for (const t of treesOf(P)) near((x, z) => Math.hypot(x - t.x, z - t.z) < t.r + rad + 1.5, 'tree surroundings');
  }
});

// ---------------------------------------------------------------------------------------------------------------- farmer routes
T('nav: in-pen routes detour round tree circles (clearance >= trunk + farmer radius), within the route cap', () => {
  const W = createWorld({ seed: 11 }); setFarmerCount(W, 2);
  const f = 0; let tested = 0, detoured = 0;
  const clear = (P, x, z) => { let c = 1e9; for (const s of P.solids) if (s.r > 0) c = Math.min(c, Math.hypot(x - s.x, z - s.z) - s.r); return c; };
  for (const P of PENS) for (const t of treesOf(P)) for (let k = 0; k < 8; k++) for (const d of [4, 7]) {
    const a = k * Math.PI / 4 + 0.3, ax = t.x + Math.sin(a) * d, az = t.z + Math.cos(a) * d, bx = t.x - Math.sin(a) * d, bz = t.z - Math.cos(a) * d;
    const inside = (x, z) => x > P.x0 + 1 && x < P.x1 - 1 && z > P.z0 + 1 && z < P.z1 - 1 && !blocked(P, x, z, 1.2);
    if (!inside(ax, az) || !inside(bx, bz)) continue;
    W.f_px[f] = ax; W.f_pz[f] = az;
    const len = buildRoute(W, f, bx, bz, P.id);
    assert.ok(len >= 1 && len <= 5, `route length ${len}`);
    if (len > 1) detoured++;
    let px = ax, pz = az; tested++;
    for (let w = 0; w < len; w++) {
      const tx = W.f_route[w * 2], tz = W.f_route[w * 2 + 1];
      const L = Math.hypot(tx - px, tz - pz), steps = Math.max(1, Math.ceil(L / 0.1));
      for (let i = 0; i <= steps; i++) {
        const x = px + (tx - px) * i / steps, z = pz + (tz - pz) * i / steps;
        assert.ok(penOf(x, z) === P.id, 'route stays in the pen');
        const c = Math.hypot(x - t.x, z - t.z) - t.r;
        assert.ok(c >= FARMER_RADIUS - 1e-6, `pen ${P.id} tree (${t.x},${t.z}): route passes ${c.toFixed(2)} m from the trunk (angle ${k}, d ${d})`);
      }
      px = tx; pz = tz;
    }
  }
  assert.ok(tested >= 100 && detoured >= 100, `tested ${tested}, detoured ${detoured}`);
  // no detour when the way is clear; endpoints at a feeder (inside the inflated circle) get no detour either
  const P = PENS[12], fe = P.feeder;
  W.f_px[f] = fe.x + 5; W.f_pz[f] = fe.z + 0.5; assert.equal(buildRoute(W, f, fe.x + 2.2, fe.z + 0.2, 12), 1);
});

// ---------------------------------------------------------------------------------------------------------------- lone animal steering
function oneTick(W) { snapshotPrev(W); advanceClock(W, SIM_DT); buildHash(W.hash, W.a_px, W.a_pz, W.animalCount); updateAnimals(W, SIM_DT); }
T('steering: a lone animal walking across a pen goes round each tree (never touches the push-out radius) and reaches the far side', () => {
  const W = createWorld({ seed: 21 }); setAnimalCount(W, 40); initialSeed(W);
  let tested = 0, worstTouch = 1e9;
  for (const P of PENS) for (const t of treesOf(P)) for (let k = 0; k < 6; k++) {
    const rad = RAD(P.id), d = t.r + rad + 4.5, a = k * Math.PI / 3 + 0.17;
    const ax = t.x + Math.sin(a) * d, az = t.z + Math.cos(a) * d, bx = t.x - Math.sin(a) * d, bz = t.z - Math.cos(a) * d;
    const ok = (x, z) => x > P.x0 + rad + 1 && x < P.x1 - rad - 1 && z > P.z0 + rad + 1 && z < P.z1 - rad - 1 && !blocked(P, x, z, rad + 1.2);
    // every other solid must stay clear of the straight line a->b
    let clearLine = true;
    for (let i = 0; i <= 40; i++) { const x = ax + (bx - ax) * i / 40, z = az + (bz - az) * i / 40; for (const s of P.solids) if (s !== t) { const g = s.r > 0 ? Math.hypot(x - s.x, z - s.z) - s.r : rectGap(s, x, z); if (g < rad + 1.5) clearLine = false; } }
    if (!ok(ax, az) || !ok(bx, bz) || !clearLine) continue;
    W.animalCount = 1; W.time = 0;
    W.a_species[0] = P.id; W.a_px[0] = ax; W.a_pz[0] = az; W.a_ppx[0] = ax; W.a_ppz[0] = az; W.a_vx[0] = 0; W.a_vz[0] = 0; W.a_speed[0] = 0; W.a_flags[0] = 0;
    W.a_state[0] = A.GOTO; W.a_next[0] = A.IDLE; W.a_tx[0] = bx; W.a_tz[0] = bz; W.a_stateTime[0] = 80; W.a_hunger[0] = 0; W.a_thirst[0] = 0; W.a_energy[0] = 1; W.a_produce[0] = 0;
    let minD = 1e9, reached = false;
    for (let i = 0; i < 90 * 30 && !reached; i++) {
      W.a_produce[0] = 0; if (W._an) W._an.sickT.fill(0); oneTick(W);   // a lone animal would otherwise lay / milk-ready at once (per-pen share = 1)
      if (W.a_state[0] !== A.GOTO && W.a_state[0] !== A.IDLE) break;
      minD = Math.min(minD, Math.hypot(W.a_px[0] - t.x, W.a_pz[0] - t.z) - t.r - rad);
      if ((W.a_px[0] - t.x) * (bx - ax) + (W.a_pz[0] - t.z) * (bz - az) > 1.0 * d * 2) reached = true;   // past the trunk (GOTO accepts a widening ring around its target, so the exact target is not demanded)
    }
    assert.ok(reached, `state ${W.a_state[0]} at (${W.a_px[0].toFixed(1)},${W.a_pz[0].toFixed(1)}) target (${bx.toFixed(1)},${bz.toFixed(1)}) pen ${P.id} species ${SPECIES[P.id].name} did not get round tree (${t.x},${t.z}) from angle ${k}`);
    assert.ok(minD > 0.05, `pen ${P.id} ${SPECIES[P.id].name}: touched the trunk (gap ${minD.toFixed(2)})`);
    worstTouch = Math.min(worstTouch, minD); tested++;
  }
  assert.ok(tested >= 60, `tested ${tested}`);
  console.log(`    ${tested} crossings, min body-to-trunk gap ${worstTouch.toFixed(2)} m`);
});

// ---------------------------------------------------------------------------------------------------------------- full sim
T('300 s, 3000 animals / 40 farmers: nobody inside a solid, no animal stuck near an obstacle, farmers never inside trees', () => {
  const W = createWorld({ seed: +process.env.OBS_SEED || 77 });
  setAnimalCount(W, 3000); setFarmerCount(W, 40); initialSeed(W);
  const N = W.animalCount, nf = W.farmerCount;
  const ax = new Float32Array(N), az = new Float32Array(N), still = new Float32Array(N);
  for (let i = 0; i < N; i++) { ax[i] = W.a_px[i]; az[i] = W.a_pz[i]; }
  const wants = new Uint8Array(32); for (const st of [A.WANDER, A.GOTO, A.FLEE, A.TROT, A.FLOCK, A.SWIM]) wants[st] = 1;
  let samples = 0, viol = 0, bodyTouch = 0, fViol = 0, fSamples = 0, stuckNear = 0, stuckTree = 0, stuckAny = 0, maxStill = 0; const stuckLog = [];
  const nearSolid = (P, x, z, rad, m) => { for (const s of P.solids) { const g = s.r > 0 ? Math.hypot(x - s.x, z - s.z) - s.r : rectGap(s, x, z); if (g < rad + m) return true; } return false; };
  const total = Math.round(300 / SIM_DT);
  for (let k = 0; k < total; k++) {
    snapshotPrev(W); advanceClock(W, SIM_DT); buildHash(W.hash, W.a_px, W.a_pz, W.animalCount);
    updateAnimals(W, SIM_DT); updateTasks(W, SIM_DT); updateFarmers(W, SIM_DT);
    for (let i = 0; i < N; i++) {
      const p = W.a_species[i], P = PENS[p], x = W.a_px[i], z = W.a_pz[i], rad = SPECIES[p].radius;
      samples++;
      for (const s of P.solids) {
        if (s.r > 0) { const dd = Math.hypot(x - s.x, z - s.z); if (dd < s.r - 0.02) viol++; else if (dd < s.r + rad - 0.05) bodyTouch++; }
        else if (Math.abs(x - s.x) < s.w / 2 - 0.02 && Math.abs(z - s.z) < s.d / 2 - 0.02) viol++;
      }
    }
    for (let f = 0; f < nf; f++) {
      const p = penOf(W.f_px[f], W.f_pz[f]); if (p < 0) continue; fSamples++;
      for (const s of PENS[p].solids) if (s.r > 0 && Math.hypot(W.f_px[f] - s.x, W.f_pz[f] - s.z) < s.r) fViol++;
    }
    if (k % 15 === 14) {   // stuck detector at 0.5 s resolution
      for (let i = 0; i < N; i++) {
        const st = W.a_state[i], x = W.a_px[i], z = W.a_pz[i];
        const want = wants[st] && Math.hypot(W.a_tx[i] - x, W.a_tz[i] - z) > 3 && !(W.a_flags[i] & 3);
        if (!want || Math.hypot(x - ax[i], z - az[i]) > 0.2) { ax[i] = x; az[i] = z; still[i] = 0; continue; }
        still[i] += 0.5;
        if (still[i] > maxStill) maxStill = still[i];
        if (still[i] === 25.5) {   // counted once per episode
          stuckAny++;
          const p = W.a_species[i];
          for (const t of solidTrees(PENS[p])) if (Math.hypot(x - t.x, z - t.z) - t.r < SPECIES[p].radius + 2.5) { stuckTree++; break; }
          if (nearSolid(PENS[p], x, z, SPECIES[p].radius, 2.5)) { stuckNear++; if (stuckLog.length < 6) stuckLog.push(`animal ${i} pen ${p} state ${st} at (${x.toFixed(1)},${z.toFixed(1)}) -> (${W.a_tx[i].toFixed(1)},${W.a_tz[i].toFixed(1)}) t=${(k * SIM_DT).toFixed(0)}`); }
        }
      }
    }
  }
  console.log(`    ${samples} animal samples: inside-solid ${viol} (${(100 * viol / samples).toFixed(5)}%), body overlapping a solid ${bodyTouch}; stuck >25 s: ${stuckAny} (near a solid: ${stuckNear}, near a tree: ${stuckTree}), longest still ${maxStill.toFixed(1)} s; farmer samples in pens ${fSamples}, inside tree/circle ${fViol}`);
  if (stuckLog.length) console.log('    ' + stuckLog.join('\n    '));
  assert.ok(viol <= samples * 0.0001, `animals inside solids: ${viol}/${samples}`);
  assert.equal(stuckTree, 0, 'animals stuck near trees');
  assert.ok(stuckNear <= 3, `animals stuck near obstacles: ${stuckNear} (a crowd wedged at a trough can still hold a sheep for a while; before steering + jam rescue this was ~50-70 per run)`);
  assert.equal(fViol, 0, 'farmers inside circular solids');
  assert.ok(W.stats.tasksDone.reduce((a, b) => a + b, 0) > 20, 'farmers still work');
});
console.log(`obstacle tests passed (${n})`);
