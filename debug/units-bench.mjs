// Node micro-benchmark of the unit pose-writing path (no GL, independent of the sim): node debug/units-bench.mjs [animals] [farmers]
import { mockWorld, fillCrowd, fillPens } from './mockworld.mjs';
import { createUnitRenderer } from '../src/render/units.js';
import { NSP } from '../src/render/rig.js';
import { perspective, lookAt, identity } from '../src/render/mat4.js';
const nA = +(process.argv[2] || 10000), nF = +(process.argv[3] || 200);
const mk = (cap, g) => ({ inst: new Float32Array(cap * 16), tint: new Float32Array(cap * 3).fill(1), capacity: cap, count: 0, vertexCount: g.count, upload() {} });
const G = { view: identity(new Float32Array(16)), proj: identity(new Float32Array(16)), camPos: new Float32Array(3), fogFar: 420, info: { triangles: 0, calls: 0 },
  createMesh: (g, cap, o) => Object.assign(mk(cap, g), { outline: o && o.outline || 0 }), createShadowMesh: cap => ({ data: new Float32Array(cap * 3), capacity: cap, count: 0, upload() {} }) };
const W = mockWorld(nA, nF); fillCrowd(W, NSP, 150, 7);   // layout 1: species uniformly mixed over the whole area (worst case for draw calls)
const R = createUnitRenderer(G, W);
R.adaptive = false;
function bench(label, cx, cy, cz, tx, ty, tz, setup) {
  perspective(G.proj, 0.8, 16 / 9, 0.1, 800); lookAt(G.view, cx, cy, cz, tx, ty, tz); G.camPos.set([cx, cy, cz]);
  if (setup) setup();
  for (let i = 0; i < 20; i++) R.update(W, 0.5);
  const N = 100, t0 = performance.now();
  for (let i = 0; i < N; i++) R.update(W, (i % 10) / 10);
  const ms = (performance.now() - t0) / N, c = R.getInstanceCounts();
  let draws = 0; for (const m of R.meshes) if (m.count > 0) draws += m.outline > 0 ? 2 : 1;
  console.log(`${label.padEnd(36)} ${ms.toFixed(2).padStart(6)} ms  near=${String(c.near).padStart(5)} far=${String(c.far).padStart(5)} blob=${String(c.blob).padStart(5)} culled=${String(c.culled).padStart(5)} draws~${draws + 1} tris~${(c.tris / 1e6).toFixed(2)}M lodDist=${R.lodDist.toFixed(0)}`);
}
console.log(`animals=${W.animalCount} farmers=${W.farmerCount} species=${NSP}   (draws~ = non-empty meshes, outline pass counted; tris~ = this renderer's own count, excl. environment)`);
for (const layout of ['mixed', 'pens']) {
  if (layout === 'pens') fillPens(W, NSP, 7);
  console.log(`--- layout: ${layout === 'mixed' ? 'all species mixed everywhere' : 'species in their own pens (5x4 grid)'}`);
  R.adaptive = false; R.cull = true; R.lod = true; R.lodDist = 110;
  bench('overview (all in view), tiers+cull', 0, 250, 150, 0, 0, 0);
  bench('overview, cull off', 0, 250, 150, 0, 0, 0, () => { R.cull = false; });
  R.cull = true;
  bench('low oblique, whole farm in view', 0, 60, 200, 0, 0, 0);
  bench('zoomed on one pen', 0, 40, 90, 0, 0, 30);
  bench('worst case: LOD off, no cull', 0, 250, 150, 0, 0, 0, () => { R.lod = false; R.cull = false; });
  bench('LOD off, zoomed cull', 0, 40, 90, 0, 0, 30, () => { R.lod = false; R.cull = true; });
  R.lod = true;
}
// adaptive controller: pretend the GPU frame is over budget, then well below it
R.adaptive = true; R.lodDist = 110;
for (let i = 0; i < 90; i++) { G.info.triangles = 4e6; R.update(W, 0.5); }
console.log(`adaptive: after 90 over-budget frames lodDist=${R.lodDist.toFixed(1)} (min ${R.lodMin})`);
for (let i = 0; i < 400; i++) { G.info.triangles = 5e5; R.update(W, 0.5); }
console.log(`adaptive: after 400 under-budget frames lodDist=${R.lodDist.toFixed(1)} (default ${R.lodDefault})`);
