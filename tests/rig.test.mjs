// Model sanity: every smooth primitive is CCW-outward (positive signed volume, required by the inverted-hull outline pass),
// no NaNs, unit normals, and the near/far triangle budgets hold.
import assert from 'node:assert';
globalThis.__WINDCHK = [];
const { NSP, SPECIES_NAMES, FAN_SPECIES, buildFarmerFarGeos, buildAnimalGeos, buildLegGeo, buildBirdLegGeo, buildDuckLegGeo, buildLegFarGeo, buildFarmerGeos, buildItemGeos, RIG, ANIMAL_GEO } = await import('../src/render/rig.js');
buildAnimalGeos(); buildFarmerFarGeos(); buildLegGeo(); buildBirdLegGeo(); buildDuckLegGeo(); buildFarmerGeos(); buildItemGeos();
const vols = globalThis.__WINDCHK; globalThis.__WINDCHK = null;
const bad = vols.filter(v => !(v > 0));
assert.strictEqual(bad.length, 0, `${bad.length}/${vols.length} primitives are inside-out`);
console.log(`  ok ${vols.length} smooth primitives CCW-outward`);
const check = (name, g) => {
  assert.ok(g && g.count > 0 && g.count % 3 === 0, name + ' empty');
  for (let i = 0; i < g.count * 3; i++) assert.ok(Number.isFinite(g.pos[i]) && Number.isFinite(g.nrm[i]) && Number.isFinite(g.col[i]), name + ' NaN');
  for (let i = 0; i < g.count; i += 37) { const l = Math.hypot(g.nrm[i * 3], g.nrm[i * 3 + 1], g.nrm[i * 3 + 2]); assert.ok(Math.abs(l - 1) < 1e-3, name + ' normal'); }
};
const names = ['chicken', 'duck', 'turkey', 'rabbit', 'goat', 'sheep', 'pig', 'cow', 'horse', 'llama', 'donkey', 'goose', 'alpaca', 'deer', 'ostrich', 'yak', 'buffalo', 'peacock', 'camel', 'capybara'];
assert.strictEqual(NSP, 20); assert.deepStrictEqual(SPECIES_NAMES, names);
const over = [];
names.forEach((n, i) => {
  const g = ANIMAL_GEO[i];
  for (const k of ['body', 'head', 'acc', 'bodyF', 'headF', 'headA', 'whole']) check(n + '.' + k, g[k]);
  if (g.male) check(n + '.male', g.male);
  if (g.alt) for (const k of ['body', 'head', 'bodyF', 'headF', 'headA', 'whole']) check(n + '.alt.' + k, g.alt[k]);
  assert.strictEqual(g.headA.count, g.head.count + g.acc.count, n + ' headA');
  assert.ok(g.headA.fix && g.headA.fix.length === g.headA.count, n + ' fix attr');
  console.log(`   ${n.padEnd(9)} near ${(g.body.count + g.head.count) / 3} (+acc ${g.acc.count / 3}${g.male ? ' +male ' + g.male.count / 3 : ''}) far ${(g.bodyF.count + g.headF.count) / 3}${g.alt ? ' alt ' + (g.alt.body.count + g.alt.head.count) / 3 : ''}`);
  const near = (g.body.count + g.head.count) / 3, far = (g.bodyF.count + g.headF.count) / 3;
  if (!(near <= (n === 'cow' ? 1300 : 1000))) over.push(`${n} near ${near}`); if (!(far <= 300)) over.push(`${n} far ${far}`);
  assert.ok(RIG[i].graze >= 0.3 && RIG[i].vt.body.length === 8, n + ' rig');
});
for (const f of FAN_SPECIES) { check(names[f] + '.fan', ANIMAL_GEO[f].fan); check(names[f] + '.fanF', ANIMAL_GEO[f].fanF); } check('leg', buildLegGeo()); check('legF', buildLegFarGeo());
assert.deepStrictEqual(over, [], 'triangle budget exceeded: ' + over.join(', '));
console.log('  ok models finite, normalised, within triangle budget');
buildFarmerFarGeos().forEach((g, t) => { check('farmerFar' + t, g); assert.ok(g.count / 3 <= 400, 'far farmer tris'); });
ANIMAL_GEO.forEach((g, i) => { const b = RIG[i].blob, c = RIG[i].avg; assert.ok(b.every(Number.isFinite) && b[0] > 0 && b[1] > 0 && b[2] > 0 && c.every(Number.isFinite), names[i] + ' blob data'); });
console.log('  ok far farmers and blob-tier data');
console.log('rig tests passed');
