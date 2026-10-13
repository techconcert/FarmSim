// Unit renderer (WP4): animals, farmers, items, gates, blob shadows. See PLAN.md section 7.
// Pure data-in / instance-matrices-out: reads World typed arrays, writes M.inst/M.tint of instanced meshes, calls M.upload().
// No allocation per frame. Works with a mock G (createMesh/createShadowMesh returning plain typed arrays) for Node benchmarks.
import { MAX_TASKS, PENS, SPECIES, SIM_DT, WATER_Y, AState, FState, TaskType, ItemKind, ItemState, FeatureKind, FLOAT_LIFT, SINK_CAP } from '../config.js';
import { multiply } from './mat4.js';
import { ell, smoothen } from './lowpoly.js';
import {
  RIG, NSP, FAN_SPECIES, FARMER_RIG, buildAnimalGeos, buildLegGeo, buildLegFarGeo, buildBirdLegGeo, buildDuckLegGeo, buildFarmerGeos, buildFarmerFarGeos, buildItemGeos, buildGateGeo, ITEM_OUTLINE,
} from './rig.js';

// Render scalability (10,000 animals / 200 farmers)
//  * every instance buffer starts small and doubles (power of two) from the live counts: nothing is sized by MAX_ANIMALS
//  * per-instance sphere frustum test + distance tiers: NEAR (full body + head/accessories, outlined) within R.lodDist,
//    FAR (one static coarse mesh per species + simple legs, no outline) up to R.lodDist * R.blobK, BLOB (one shared 28-tri ellipsoid,
//    tinted to the species colour) beyond that, culled past the fog distance
//  * adaptive controller: if the last frame's triangle count (G.info.triangles) exceeds R.triBudget, R.lodDist shrinks smoothly (tiers
//    follow); when well below it recovers towards R.lodDefault
//  * draw calls scale with the species / variants actually visible (empty meshes are skipped by G.render), shadows are ONE instanced draw

const TWO_PI = Math.PI * 2, PI = Math.PI;
const IDT = 1 / SIM_DT, INV2PI = 1 / TWO_PI;
// fast sine (parabola + correction, |err| < 1.2e-3): visual-only, avoids ~100k Math.sin calls per frame
function fsin(x) {
  x -= TWO_PI * Math.floor((x + PI) * INV2PI);
  const a = x < 0 ? -x : x, y = x * (1.2732395447 - 0.4052847346 * a), b = y < 0 ? -y : y;
  return y * (0.775 + 0.225 * b);
}
function fcos(x) { return fsin(x + 1.5707963268); }
const A = AState, FS = FState;

// scratch (module level, never reallocated)
const BR = new Float64Array(9);          // current body rotation, columns x,y,z
const VP = new Float32Array(16);
const PL = new Float64Array(20);         // 5 frustum planes (a,b,c,d) normalised: L,R,B,T,N

function setBR(yaw, pitch, roll) {
  const c = fcos(yaw), s = fsin(yaw);
  if (pitch === 0 && roll === 0) {
    BR[0] = c; BR[1] = 0; BR[2] = -s; BR[3] = 0; BR[4] = 1; BR[5] = 0; BR[6] = s; BR[7] = 0; BR[8] = c;
    return;
  }
  const cp = fcos(pitch), sp = fsin(pitch), cr = fcos(roll), sr = fsin(roll);
  BR[0] = c * cr + s * sp * sr; BR[1] = cp * sr; BR[2] = -s * cr + c * sp * sr;
  BR[3] = -c * sr + s * sp * cr; BR[4] = cp * cr; BR[5] = s * sr + c * sp * cr;
  BR[6] = s * cp; BR[7] = -sp; BR[8] = c * cp;
}
// matrix from BR scaled
function putBody(arr, k, px, py, pz, sx, sy, sz) {
  const o = k * 16;
  arr[o] = BR[0] * sx; arr[o + 1] = BR[1] * sx; arr[o + 2] = BR[2] * sx; arr[o + 3] = 0;
  arr[o + 4] = BR[3] * sy; arr[o + 5] = BR[4] * sy; arr[o + 6] = BR[5] * sy; arr[o + 7] = 0;
  arr[o + 8] = BR[6] * sz; arr[o + 9] = BR[7] * sz; arr[o + 10] = BR[8] * sz; arr[o + 11] = 0;
  arr[o + 12] = px; arr[o + 13] = py; arr[o + 14] = pz; arr[o + 15] = 1;
}
// child = BR * Rx(a) at p, scale (w, l, w): used for hanging limbs (legs/arms hang along local -Y, scaled by l)
function putLimb(arr, k, px, py, pz, ca, sa, w, l) {
  const o = k * 16;
  arr[o] = BR[0] * w; arr[o + 1] = BR[1] * w; arr[o + 2] = BR[2] * w; arr[o + 3] = 0;
  arr[o + 4] = (BR[3] * ca + BR[6] * sa) * l; arr[o + 5] = (BR[4] * ca + BR[7] * sa) * l; arr[o + 6] = (BR[5] * ca + BR[8] * sa) * l; arr[o + 7] = 0;
  arr[o + 8] = (-BR[3] * sa + BR[6] * ca) * w; arr[o + 9] = (-BR[4] * sa + BR[7] * ca) * w; arr[o + 10] = (-BR[5] * sa + BR[8] * ca) * w; arr[o + 11] = 0;
  arr[o + 12] = px; arr[o + 13] = py; arr[o + 14] = pz; arr[o + 15] = 1;
}
// child = BR * Ry(hy) Rx(hp) Rz(hr), uniform scale u
function putHead(arr, k, px, py, pz, hy, hp, hr, u) {
  const o = k * 16;
  let c0x, c0y, c0z, c1x, c1y, c1z, c2x, c2y, c2z;
  const cp = fcos(hp), sp = fsin(hp);
  if (hy === 0 && hr === 0) {
    c0x = 1; c0y = 0; c0z = 0; c1x = 0; c1y = cp; c1z = sp; c2x = 0; c2y = -sp; c2z = cp;
  } else {
    const cy = fcos(hy), sy = fsin(hy), cr = fcos(hr), sr = fsin(hr);
    c0x = cy * cr + sy * sp * sr; c0y = cp * sr; c0z = -sy * cr + cy * sp * sr;
    c1x = -cy * sr + sy * sp * cr; c1y = cp * cr; c1z = sy * sr + cy * sp * cr;
    c2x = sy * cp; c2y = -sp; c2z = cy * cp;
  }
  const b0 = BR[0], b1 = BR[1], b2 = BR[2], b3 = BR[3], b4 = BR[4], b5 = BR[5], b6 = BR[6], b7 = BR[7], b8 = BR[8];
  arr[o] = (b0 * c0x + b3 * c0y + b6 * c0z) * u; arr[o + 1] = (b1 * c0x + b4 * c0y + b7 * c0z) * u; arr[o + 2] = (b2 * c0x + b5 * c0y + b8 * c0z) * u; arr[o + 3] = 0;
  arr[o + 4] = (b0 * c1x + b3 * c1y + b6 * c1z) * u; arr[o + 5] = (b1 * c1x + b4 * c1y + b7 * c1z) * u; arr[o + 6] = (b2 * c1x + b5 * c1y + b8 * c1z) * u; arr[o + 7] = 0;
  arr[o + 8] = (b0 * c2x + b3 * c2y + b6 * c2z) * u; arr[o + 9] = (b1 * c2x + b4 * c2y + b7 * c2z) * u; arr[o + 10] = (b2 * c2x + b5 * c2y + b8 * c2z) * u; arr[o + 11] = 0;
  arr[o + 12] = px; arr[o + 13] = py; arr[o + 14] = pz; arr[o + 15] = 1;
}
function copyMat(arr, k, from) {
  const o = k * 16, f = from * 16;
  for (let j = 0; j < 16; j++) arr[o + j] = arr[f + j];
}
// compact yaw-only instance (meshes created with { compact: true }): position, cos / sin of yaw, scale; see gl.js VS
function putYaw(arr, k, px, py, pz, c, s, sx, sy, sz) {
  const o = k * 8;
  arr[o] = px; arr[o + 1] = py; arr[o + 2] = pz; arr[o + 3] = c;
  arr[o + 4] = s; arr[o + 5] = sx; arr[o + 6] = sy; arr[o + 7] = sz;
}
function setTint(t, k, r, g, b) { const o = k * 3; t[o] = r; t[o + 1] = g; t[o + 2] = b; }

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// flattened variant tables (species x 8 slots x rgb): body tint, head tint (male / female), leg colour; VA = plain-mesh flag
const VT = new Float32Array(NSP * 8 * 3), VH = new Float32Array(NSP * 8 * 3), VHF = new Float32Array(NSP * 8 * 3), VL = new Float32Array(NSP * 8 * 3);
const VA = new Uint8Array(NSP * 8);
for (let s = 0; s < NSP; s++) {
  const vt = RIG[s].vt;
  for (let v = 0; v < 8; v++) {
    VA[s * 8 + v] = vt.alt[v];
    for (let c = 0; c < 3; c++) { const o = (s * 8 + v) * 3 + c; VT[o] = vt.body[v][c]; VH[o] = vt.head[v][c]; VHF[o] = vt.headF[v][c]; VL[o] = vt.leg[v][c]; }
  }
}

const START_CAP = 64;      // initial instance capacity of every mesh (power of two; doubled on demand)
const strideOf = M => M.stride || 16;
const capOf = M => (M.capacity != null ? M.capacity : (M.inst.length / strideOf(M)) | 0);
// make room for instance index k (keeps the first `live` instances); real GL meshes grow their buffers, mock meshes just swap arrays
function ensure(M, k) {
  const cap = capOf(M);
  if (k < cap) return;
  let nc = cap < START_CAP ? START_CAP : cap;
  while (nc <= k) nc *= 2;
  if (M.grow) M.grow(nc, k);
  else {
    const st = strideOf(M), oi = M.inst, ot = M.tint; M.inst = new Float32Array(nc * st); M.tint = new Float32Array(nc * 3).fill(1);
    M.inst.set(oi.subarray(0, Math.min(oi.length, k * st))); M.tint.set(ot.subarray(0, Math.min(ot.length, k * 3))); M.capacity = nc;
  }
}
// water: per species buoyant (floats at the surface) / wader (sinks by a_wy, hard-capped at SINK_CAP x height) / mud wallow (lies down, mud tint)
const BUOYR = new Uint8Array(32), WADER = new Uint8Array(32), MUDW = new Uint8Array(32), HGTR = new Float32Array(32);
for (let s = 0; s < SPECIES.length; s++) {
  const b = SPECIES[s].beh; BUOYR[s] = b.buoy ? 1 : 0; WADER[s] = b.wade ? 1 : 0; HGTR[s] = SPECIES[s].height;
  MUDW[s] = b.wallow === FeatureKind.MUD_PIT ? 1 : 0;
}
const INV_LIFT = 1 / FLOAT_LIFT;
const WON_R = new Uint8Array(32); for (let s = 0; s < SPECIES.length; s++) WON_R[s] = BUOYR[s] | WADER[s];
// animal states that lay the body down (used by the blob tier, which skips the full pose machine)
const LIE_ST = new Uint8Array(32);
for (const st of [AState.REST, AState.SLEEP, AState.SICK, AState.LAY, AState.DUSTBATH, AState.WALLOW, AState.ROLL]) LIE_ST[st] = 1;

export function createUnitRenderer(G, W) {
  const geos = buildAnimalGeos();
  const meshes = [];
  // outline: inverted-hull width in world metres at scale 1 (0 / undefined = none); far-LOD meshes are never outlined
  const mk = (geo, cap, ol) => { const m = G.createMesh(geo, cap || START_CAP, ol > 0 ? { outline: ol } : undefined); meshes.push(m); return m; };

  const LEG = mk(buildLegGeo(), START_CAP, 0.12);
  const BLEG = mk(buildBirdLegGeo()), DLEG = mk(buildDuckLegGeo());
  // per species: near body + head(with accessories), far whole, plain-variant alternatives, male-only accessory (antlers), tail fans
  const BODY = [], HEAD = [], MALE = [], WHOLE = [], BODYA = [], HEADA = [], WHOLEA = [], FANM = [], FANFM = [];
  for (let s = 0; s < NSP; s++) {
    const g = geos[s], ol = RIG[s].outline, a = g.alt;
    BODY.push(mk(g.body, 0, ol)); HEAD.push(mk(g.headA, 0, ol));
    MALE.push(g.male ? mk(g.male, 0, ol * 0.6) : null);
    WHOLE.push(mk(g.whole));
    BODYA.push(a ? mk(a.body, 0, ol) : null); HEADA.push(a ? mk(a.headA, 0, ol) : null); WHOLEA.push(a ? mk(a.whole) : null);
    FANM.push(g.fan ? mk(g.fan, 0, 0.035) : null); FANFM.push(g.fanF ? mk(g.fanF) : null);
  }
  const LEGF = mk(buildLegFarGeo());
  const BLOBG = smoothen(ell(1, 1, 1, 0xffffff, 0, 0, 0, 7, 3));
  const BLOB = G.createMesh(BLOBG, START_CAP, { compact: true }); meshes.push(BLOB);   // 8 floats per instance (yaw-only transform)
  const fg = buildFarmerGeos(), ffg = buildFarmerFarGeos();
  const FBODY = fg.bodies.map(g => mk(g, 0, 0.03));
  const FARM = fg.arms.map(g => mk(g, 0, 0.1));
  const FWHOLE = ffg.map(g => mk(g));
  const ig = buildItemGeos();
  const ITEM = ig.map((g, k) => mk(g, 0, ITEM_OUTLINE[k]));
  const GATE = mk(buildGateGeo(), PENS.length, 0.02);
  const SH = G.createShadowMesh(1024);

  // per-entity smoothing state (render only); grown on demand to the world's array capacity
  let smCap = 0, smLie = null, smHp = null, smHy = null, smFan = null;
  function growSm(n) {
    if (n <= smCap) return;
    const nc = Math.max(n, 1024);
    const f = (o) => { const a = new Float32Array(nc); if (o) a.set(o); return a; };
    smLie = f(smLie); smHp = f(smHp); smHy = f(smHy); smFan = f(smFan); smCap = nc;
  }
  let fCap = 0, fArmL = null, fArmR = null, fTorso = null, fSit = null;
  function growF(n) {
    if (n <= fCap) return;
    const nc = Math.max(n, 64), f = (o) => { const a = new Float32Array(nc); if (o) a.set(o); return a; };
    fArmL = f(fArmL); fArmR = f(fArmR); fTorso = f(fTorso); fSit = f(fSit); fCap = nc;
  }

  const RGS = RIG;
  const nBody = new Int32Array(NSP), nWhole = new Int32Array(NSP), nBodyA = new Int32Array(NSP), nWholeA = new Int32Array(NSP), nMale = new Int32Array(NSP), nFanA = new Int32Array(NSP), nFanFA = new Int32Array(NSP);
  const nItem = new Int32Array(8), nFB = new Int32Array(4), nFW = new Int32Array(4);
  const counts = { total: 0, meshes: meshes.length, animals: 0, farmers: 0, items: 0, culled: 0, shadows: 0, near: 0, far: 0, blob: 0, tris: 0, lodDist: 110 };

  const R = {
    meshes, hideGates: false, cull: true, lod: true, lodDist: 110, lodDefault: 110, lodMin: 25, blobK: 2.0, adaptive: true, triBudget: 2.5e6, callBudget: 120, shadowScale: 1.6, counts,
    update,
    getInstanceCounts() {
      let t = 0, tr = 0;
      for (let i = 0; i < meshes.length; i++) { const M = meshes[i]; t += M.count; tr += M.count * (M.vertexCount || 0) / 3 * (M.outline > 0 ? 2 : 1); }
      counts.total = t; counts.meshes = meshes.length; counts.tris = tr | 0; counts.lodDist = R.lodDist;
      return counts;
    },
  };

  let lastNow = 0, lastEst = 0;
  const hasPerf = typeof performance !== 'undefined' && typeof performance.now === 'function';

  function update(Wd, alpha) {
    const w = Wd || W;
    alpha = alpha < 0 ? 0 : alpha > 1 ? 1 : (alpha || 0);
    let dt = 1 / 60;
    if (hasPerf) { const now = performance.now(); if (lastNow) dt = clamp((now - lastNow) * 0.001, 0.001, 0.1); lastNow = now; }
    const kLie = 1 - Math.exp(-dt * 7), kHead = 1 - Math.exp(-dt * 16), kFarm = 1 - Math.exp(-dt * 10), kFan = 1 - Math.exp(-dt * 4);

    // ---- adaptive LOD distance: shrink smoothly while the last frame was over the triangle budget, recover when well below it
    if (R.adaptive && R.lod) {
      const tri = G.info && G.info.triangles > 0 ? G.info.triangles : lastEst;
      let over = tri / R.triBudget;
      if (G.info && G.info.calls > 0) { const co = G.info.calls / R.callBudget; if (co > over) over = co; }     // too many draw calls (many species near): pull the near tier in too
      if (over > 1) R.lodDist = Math.max(R.lodMin, R.lodDist * (1 - Math.min(0.5, (over - 1) * 0.8) * Math.min(1, dt * 3)));
      else if (over < 0.85 && R.lodDist < R.lodDefault) R.lodDist = Math.min(R.lodDefault, R.lodDist + 30 * dt);
    }

    // ---- frustum
    const doCull = R.cull;
    if (doCull) {
      multiply(VP, G.proj, G.view);
      const m = VP;
      for (let p = 0; p < 5; p++) {
        let a, b, c, d;
        // rows: r0=(m0,m4,m8,m12) r1=(m1,m5,m9,m13) r2=(m2,m6,m10,m14) r3=(m3,m7,m11,m15)
        switch (p) {
          case 0: a = m[3] + m[0]; b = m[7] + m[4]; c = m[11] + m[8]; d = m[15] + m[12]; break;
          case 1: a = m[3] - m[0]; b = m[7] - m[4]; c = m[11] - m[8]; d = m[15] - m[12]; break;
          case 2: a = m[3] + m[1]; b = m[7] + m[5]; c = m[11] + m[9]; d = m[15] + m[13]; break;
          case 3: a = m[3] - m[1]; b = m[7] - m[5]; c = m[11] - m[9]; d = m[15] - m[13]; break;
          default: a = m[3] + m[2]; b = m[7] + m[6]; c = m[11] + m[10]; d = m[15] + m[14];
        }
        const l = 1 / (Math.sqrt(a * a + b * b + c * c) || 1);
        PL[p * 4] = a * l; PL[p * 4 + 1] = b * l; PL[p * 4 + 2] = c * l; PL[p * 4 + 3] = d * l;
      }
    }
    const cam = G.camPos, camX = cam[0], camY = cam[1], camZ = cam[2];
    const fogFar = (G.fogFar || 1e9) + 6, fogFar2 = fogFar * fogFar;
    const lodD = R.lodDist, lod2 = R.lod ? lodD * lodD : 1e12, blobD = lodD * R.blobK, blob2 = R.lod ? blobD * blobD : 1e13;
    const shadowK = R.shadowScale;

    // gather arrays
    const a_species = w.a_species, a_state = w.a_state, a_flags = w.a_flags, a_variant = w.a_variant, a_seed = w.a_seed;
    const a_px = w.a_px, a_py = w.a_py, a_pz = w.a_pz, a_ppx = w.a_ppx, a_ppy = w.a_ppy, a_ppz = w.a_ppz, a_wy = w.a_wy, a_pwy = w.a_pwy;
    const a_heading = w.a_heading, a_pheading = w.a_pheading, a_animT = w.a_animT, a_gait = w.a_gait, a_scale = w.a_scale;
    let nSh = 0, nLeg = 0, nLegF = 0, nBLeg = 0, nDLeg = 0, nBlob = 0, culled = 0, cNear = 0, cFar = 0;
    nBody.fill(0); nWhole.fill(0); nBodyA.fill(0); nWholeA.fill(0); nMale.fill(0); nFanA.fill(0); nFanFA.fill(0);
    const n = w.animalCount;
    growSm(a_species.length);
    // shadows: one instanced draw whatever the species count
    if (n + w.farmerCount + 16 > capOf2(SH)) growSh(SH, n + w.farmerCount + 16);
    let sd = SH.data;

    for (let i = 0; i < n; i++) {
      const s = a_species[i];
      if (s >= NSP) continue;
      const rg = RGS[s];
      const px0 = a_ppx[i], pz0 = a_ppz[i], px1 = a_px[i], pz1 = a_pz[i];
      if (px1 !== px1 || pz1 !== pz1) continue;
      const x = px0 + (px1 - px0) * alpha, z = pz0 + (pz1 - pz0) * alpha;
      const py = a_ppy[i] + (a_py[i] - a_ppy[i]) * alpha;
      let sc = a_scale[i]; if (!(sc > 0)) sc = 1;
      // water: flo 0..1 = how much a buoyant animal floats; sink = metres a wader is sunk (<= SINK_CAP x height, hard clamp)
      let flo = 0, sink = 0, sinkCap = 0;
      if (WON_R[s] === 1) {
        const wy = a_pwy[i] + (a_wy[i] - a_pwy[i]) * alpha;
        if (BUOYR[s] === 1) { flo = wy * INV_LIFT; flo = flo < 0 ? 0 : flo > 1 ? 1 : flo; }
        else if (wy < 0) { sinkCap = SINK_CAP * HGTR[s] * sc; sink = -wy > sinkCap ? sinkCap : -wy; }
      }
      const rr = rg.cullR * sc;
      const ddx = x - camX, ddy = py + rg.bodyY - camY, ddz = z - camZ;
      const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
      if (d2 > fogFar2) { culled++; continue; }
      if (doCull) {
        const cy = py + rg.bodyY * sc;
        let out = false;
        for (let p = 0; p < 20; p += 4) {
          if (PL[p] * x + PL[p + 1] * cy + PL[p + 2] * z + PL[p + 3] < -rr) { out = true; break; }
        }
        if (out) { culled++; continue; }
      }
      const far = d2 > lod2;
      if (d2 > blob2) {
        // ---- BLOB tier: one shared ellipsoid tinted to the species colour (no pose machine, no legs, no head)
        const stB = a_state[i], lieB = LIE_ST[stB];
        smLie[i] = lieB; smHp[i] = 0; smHy[i] = 0;
        let dhB = a_heading[i] - a_pheading[i];
        dhB -= TWO_PI * Math.round(dhB / TWO_PI);
        const yB = a_pheading[i] + dhB * alpha, cB = fcos(yB), sB = fsin(yB);   // yaw-only body rotation (same as setBR(yB, 0, 0))
        const viB = ((a_variant[i] >> 1) & 7) + s * 8, viB3 = viB * 3, bl = rg.blob, ac = VA[viB] === 1 ? rg.avgAlt : rg.avg;
        let ypB = py + (rg.bodyY * (1 - lieB) + rg.lieY * lieB) * sc - sink * (1 - 0.5 * lieB);
        if (flo > 0) { const yw = WATER_Y + rg.swimY * 0.55 * sc; ypB += (yw - ypB) * flo; }
        const ox = bl[3] * sc, oy = bl[4] * sc, oz = bl[5] * sc;
        if (nBlob >= capOf(BLOB)) ensure(BLOB, nBlob);
        putYaw(BLOB.inst, nBlob, x + cB * ox + sB * oz, ypB + oy, z - sB * ox + cB * oz, cB, sB, bl[0] * sc, bl[1] * sc, bl[2] * sc);
        setTint(BLOB.tint, nBlob, ac[0] * VT[viB3], ac[1] * VT[viB3 + 1], ac[2] * VT[viB3 + 2]);
        nBlob++;
        if (flo < 0.3) { const o = nSh * 3; sd[o] = x; sd[o + 1] = z; sd[o + 2] = shadowK * rg.radius * sc * (sink > 0 ? 1 - 0.5 * sink / sinkCap : 1); nSh++; }
        continue;
      }
      if (far) cFar++; else cNear++;

      const st = a_state[i], fl = a_flags[i];
      const t = a_animT[i], ph0 = (a_seed[i] & 1023) * 0.0061359;
      const ddxp = px1 - px0, ddzp = pz1 - pz0;
      const v = Math.sqrt(ddxp * ddxp + ddzp * ddzp) * IDT;
      const moving = v > 0.05;
      let dh = a_heading[i] - a_pheading[i];
      dh -= TWO_PI * Math.round(dh / TWO_PI);
      let yaw = a_pheading[i] + dh * alpha;
      const gaitNow = a_gait[i] + (moving ? v * alpha * SIM_DT * rg.cpm : 0);
      const bird = rg.bird;

      // ---------------- pose targets
      let lieT = 0, foldT = -1, pitch = 0, roll = 0, yOff = 0, amp = 0, hpT = 0, hyT = 0, hrT = 0, fan = 0, sMul = 1, sY = 1;
      let k0 = 0, k1 = 0, swim = false, hop = false, mud = false, nolegs = false;
      const G_ = rg.graze;
      // walking amplitude from real speed
      if (moving) {
        const r = v / rg.walkV;
        amp = r < 1 ? 0.18 + 0.42 * r : Math.min(0.95, 0.6 + 0.14 * (r - 1));
      }
      let bob = amp > 0 ? 1 : 0;
      switch (st) {
        case A.GRAZE: case A.ROOT: case A.EAT: case A.DRINK: case A.PECK: {
          if (bird || st === A.PECK) {
            let pk;
            if (st === A.DRINK) { pk = fsin(2.6 * t + ph0) * 2.5; pk = pk < 0 ? 0 : pk > 1 ? 1 : pk; }
            else pk = Math.max(0, fsin((st === A.EAT ? 15 : st === A.PECK ? 12 : 8) * t + ph0));
            hpT = G_ * pk; pitch = rg.grazeBP * pk; yOff = -0.03 * pk;
            if (!bird) { pitch = 0.1 * pk; hpT = G_ * (0.85 + 0.15 * pk); }
          } else if (rg.hopper) {
            hpT = G_ * (0.75 + 0.25 * Math.abs(fsin(10 * t + ph0))); pitch = rg.grazeBP;
          } else if (st === A.ROOT) {
            hpT = G_ * (0.8 + 0.2 * fsin(8 * t + ph0)); pitch = rg.grazeBP + 0.04 * fsin(8 * t + ph0);
          } else if (st === A.DRINK) {
            hpT = G_ * 0.97; pitch = rg.grazeBP;
          } else {
            hpT = G_ * (0.9 + 0.1 * fsin(4 * t + ph0)); pitch = rg.grazeBP;
          }
          bob = 0;
          break;
        }
        case A.SCRATCH: {
          const kk = fsin(9 * t + ph0);
          k0 = 1.1 * (kk > 0 ? kk : 0); k1 = 1.1 * (kk < 0 ? -kk : 0);
          pitch = 0.22; hpT = G_ * (0.35 + 0.2 * fsin(9 * t)); yOff = -0.01; amp = 0; bob = 0;
          break;
        }
        case A.REST:
          lieT = 1; hpT = 0.08 + 0.07 * fsin(2 * t + ph0); hyT = 0.25 * fsin(0.4 * t + ph0); sY = 1 + 0.02 * fsin(2.2 * t + ph0); amp = 0; bob = 0; break;
        case A.SLEEP:
          lieT = 1; hpT = rg.sleepHead[0]; hyT = rg.sleepHead[1]; sY = 1 + 0.025 * fsin(1.6 * t + ph0); amp = 0; bob = 0; break;
        case A.SICK:
          lieT = 1; hpT = 0.85; hyT = 0.3; sY = 1 + 0.015 * fsin(1.1 * t); roll = 0.03 * fsin(27 * t + ph0); amp = 0; bob = 0; break;
        case A.LAY:
          lieT = 1; hpT = -0.1; roll = 0.035 * fsin(15 * t + ph0); amp = 0; bob = 0; break;
        case A.DUSTBATH:
          lieT = 1; roll = 0.32 * fsin(24 * t + ph0) + 0.4 * fsin(2.1 * t); yaw += 0.18 * fsin(11 * t); hpT = 0.3 * fsin(9 * t); yOff = 0.01; amp = 0; bob = 0; break;
        case A.WALLOW:
          if (MUDW[s] === 1) { lieT = 1; roll = 0.42 * fsin(1.7 * t + ph0); hpT = 0.25 * fsin(1.7 * t + 1); mud = true; }
          else { pitch = 0.03 * fsin(1.3 * t + ph0); roll = 0.03 * fsin(1.7 * t + ph0); hpT = G_ * 0.35 * (1 + fsin(0.9 * t + ph0)); }   // wading in clear water: stands, dips its head
          amp = 0; bob = 0; break;
        case A.ROLL:
          lieT = 1; foldT = 0.1; roll = 1.3 * fsin(2.2 * t + ph0); k0 = 0.7 * fsin(8 * t); k1 = -k0; hpT = 0.2 * fsin(4.4 * t); yOff = 0.0; amp = 0; bob = 0; break;
        case A.SWIM:
          swim = true; nolegs = true; pitch = 0.05 * fsin(2.6 * t + ph0); roll = 0.04 * fsin(1.9 * t + ph0); yOff = 0.012 * fsin(3.1 * t + ph0);
          hpT = 0.06 * fsin(2.6 * t + 1); amp = 0; bob = 0; break;
        case A.HOP:
          hop = true; if (!rg.hopper) hop = false;
          break;
        case A.FREEZE:
          amp = 0; bob = 0; hpT = -0.18; pitch = rg.hopper ? -0.14 : -0.04; roll = 0.012 * fsin(30 * t); break;
        case A.FLEE: case A.TROT:
          pitch = -0.04; hpT = st === A.TROT && !bird ? -0.12 + 0.05 * fsin(2 * TWO_PI * gaitNow) : 0.04 * fsin(2 * TWO_PI * gaitNow);
          if (moving) amp = Math.max(amp, 0.8);
          break;
        case A.CLIMB:
          if (moving) pitch = -0.22; hpT = -0.05; break;
        case A.BUTT: {
          const sb = fsin(3 * t + ph0);
          pitch = -0.5 * (sb > 0 ? sb : 0); hpT = 0.55 * (sb < 0 ? -sb : 0); yOff = 0; amp = 0; bob = 0;
          break;
        }
        case A.DISPLAY:
          fan = 1; sMul = 1.12; pitch = -0.1; hpT = -0.25; roll = 0.025 * fsin(26 * t); if (moving) amp *= 0.6; bob = 0.4; break;
        case A.HELD:
          amp = 0; bob = 0; hpT = 0.15; hyT = 0.5; break;
        case A.DUNG:
          pitch = -0.25; yOff = -rg.legLen * 0.22; hpT = -0.1; amp = 0; bob = 0; break;
        case A.PREEN:
          hyT = 2.2 + 0.3 * fsin(9 * t); hpT = 0.35; amp = 0; bob = 0; break;
        default:   // IDLE, WANDER, GOTO, FLOCK, unknown...
          if (!moving) {
            hpT = 0.05 * fsin(1.3 * t + ph0) + 0.03; hyT = 0.35 * fsin(0.55 * t + ph0 * 2); sY = 1 + 0.012 * fsin(2.2 * t + ph0);
            if (rg.headBob) { const bb = fsin(2.4 * t + ph0 * 3); hpT += rg.headBob * (bb > 0.6 ? bb : 0); hyT *= 0.6; }
            if (rg.fanIdle && fsin(0.21 * t + ph0 * 7) > 0.35) fan = 1;                  // peacock shows off its train now and then
          } else if (bird) hpT = 0.1 * fsin(2 * TWO_PI * gaitNow) + (rg.headBob ? rg.headBob * fsin(TWO_PI * gaitNow * 2) : 0);
          break;
      }
      if (rg.hopper && moving) hop = true;
      if (foldT < 0) foldT = lieT;
      // water: buoyant animals in the water (not only in SWIM) float with their legs tucked; waders get a slow +-1 deg sway while sunk
      if (flo > 0.8 && !swim) {
        swim = true; nolegs = true; yOff += 0.012 * fsin(3.1 * t + ph0); pitch += 0.05 * fsin(2.6 * t + ph0); roll += 0.04 * fsin(1.9 * t + ph0);
      }
      if (sink > 0.03 && !swim) { roll += 0.017 * fsin(1.1 * t + ph0 * 3); pitch += 0.012 * fsin(0.8 * t + ph0 * 2); yOff += 0.008 * fsin(1.7 * t + ph0); }
      if (st === A.HOP && rg.hopper && !moving) hop = true;

      // body modifiers for fan / sickness
      if (fan === 0) fan = 0.25;

      // ---------------- smoothing
      const lie = smLie[i] += (lieT - smLie[i]) * kLie;
      const hp = smHp[i] += (hpT - smHp[i]) * kHead;
      const hy = smHy[i] += (hyT - smHy[i]) * kHead;

      // ---------------- hop / bob
      let legA0 = 0, legA1 = 0, legB0 = 0, legB1 = 0;   // angles of legs 0..3 (fl, fr, rl, rr)
      let ph = TWO_PI * gaitNow;
      if (hop) {
        let hh;
        if (moving) { const hph = gaitNow * 0.35; hh = Math.abs(fsin(PI * hph)); legA0 = 0.65 * fsin(TWO_PI * hph); }
        else { hh = Math.abs(fsin(PI * 2.4 * t)); legA0 = 0.6 * fsin(TWO_PI * 1.2 * t); }
        yOff += 0.16 * hh;
        legA1 = legA0; legB0 = -legA0; legB1 = -legA0;   // paired: fronts together, rears together
        pitch += -0.25 * fcos(PI * (moving ? gaitNow * 0.35 : 2.4 * t)) * (moving ? 1 : 0.8);
      } else if (amp > 0 && !far) {
        const S = amp * fsin(ph) * rg.swing;
        legA0 = S; legA1 = -S; legB0 = -S; legB1 = S;
        if (bob) yOff += rg.legLen * 0.1 * Math.abs(fsin(ph)) * (amp > 0.7 ? 1.3 : 1);
      }
      legB0 += k0; legB1 += k1;
      if (bird) { legA0 += k0; legA1 += k1; }

      // body transform
      let u = sc * sMul;
      let ypiv;
      if (swim) ypiv = WATER_Y + rg.swimY * 0.55 * sc + yOff * sc;
      else {
        ypiv = py + ((rg.bodyY * (1 - lie) + rg.lieY * lie + yOff) * u) - sink * (1 - 0.5 * lie);
        if (flo > 0) ypiv += (WATER_Y + rg.swimY * 0.55 * sc - ypiv) * flo;   // wading out of the shallows: body settles onto the surface
      }
      setBR(yaw, pitch, roll);
      const vi = ((a_variant[i] >> 1) & 7) + s * 8, vi3 = vi * 3;
      const alt = VA[vi] === 1;
      let kb, B, H = null;
      if (far) {
        B = alt ? WHOLEA[s] : WHOLE[s]; kb = alt ? nWholeA[s]++ : nWhole[s]++;
        if (kb >= capOf(B)) ensure(B, kb);
      } else {
        B = alt ? BODYA[s] : BODY[s]; H = alt ? HEADA[s] : HEAD[s]; kb = alt ? nBodyA[s]++ : nBody[s]++;
        if (kb >= capOf(B)) { ensure(B, kb); ensure(H, kb); }
      }
      putBody(B.inst, kb, x, ypiv, z, u, u * sY, u);

      // tint
      let tr = VT[vi3], tg = VT[vi3 + 1], tb = VT[vi3 + 2];
      if ((fl & 1) || st === A.SICK) { tr *= 0.8; tg *= 0.88; tb *= 0.66; }
      if (mud) { tr *= 0.62; tg *= 0.5; tb *= 0.42; }
      setTint(B.tint, kb, tr, tg, tb);
      if (!far) {
        const HT = (a_variant[i] & 1) ? VH : VHF;
        let htr = HT[vi3], htg = HT[vi3 + 1], htb = HT[vi3 + 2];
        if ((fl & 1) || st === A.SICK) { htr *= 0.8; htg *= 0.88; htb *= 0.66; }
        if (mud) { htr *= 0.62; htg *= 0.5; htb *= 0.42; }
        setTint(H.tint, kb, htr, htg, htb);
        const nk = rg.neck;
        const nx = nk[0] * u, ny = nk[1] * u, nz = nk[2] * u;
        putHead(H.inst, kb, x + BR[0] * nx + BR[3] * ny + BR[6] * nz, ypiv + BR[1] * nx + BR[4] * ny + BR[7] * nz, z + BR[2] * nx + BR[5] * ny + BR[8] * nz, hy, hp, 0, u);
        if (rg.maleAcc && (a_variant[i] & 1) && (rg.maleAcc === 2 ? alt : !alt)) {          // stag antlers: ride on the head matrix
          const X = MALE[s], km = nMale[s]++;
          if (km >= capOf(X)) ensure(X, km);
          const ao = km * 16, ho = kb * 16, hi_ = H.inst, ai = X.inst;
          for (let q = 0; q < 16; q++) ai[ao + q] = hi_[ho + q];
        }
      }

      // tail fan (turkey, peacock cock): opens smoothly when displaying; folded it trails behind
      if (rg.fan && !alt) {
        const fo = (smFan[i] += ((fan > 0.9 ? 1 : 0) - smFan[i]) * kFan), e = fo * fo * (3 - 2 * fo);
        const fb = rg.fanBase, fy = fb[1] * u, fz = fb[2] * u, fd = rg.fanFold;
        const fpx = x + BR[3] * fy + BR[6] * fz, fpy = ypiv + BR[4] * fy + BR[7] * fz, fpz = z + BR[5] * fy + BR[8] * fz;
        const fp = fd[0] + (0.12 - fd[0]) * e, fsz = u * (fd[1] + (1 - fd[1]) * e);
        const FM = far ? FANFM[s] : FANM[s], kf = far ? nFanFA[s]++ : nFanA[s]++;
        if (kf >= capOf(FM)) ensure(FM, kf);
        putHead(FM.inst, kf, fpx, fpy, fpz, 0, fp, 0, fsz);
        setTint(FM.tint, kf, Math.pow(tr, 0.6), Math.pow(tg, 0.6), Math.pow(tb, 0.6));
      }

      // legs
      if (!nolegs && !(bird && far)) {   // far birds: legs are sub-pixel, skip
        const foldF = foldT;
        const lenE = rg.legLen * u * (1 - 0.78 * foldF);
        const hyE = rg.hipY * (1 - 0.9 * foldF) * u;
        let lr = VL[vi3], lg = VL[vi3 + 1], lb = VL[vi3 + 2];
        if ((fl & 1) || st === A.SICK) { lr *= 0.8; lg *= 0.9; lb *= 0.7; }
        if (mud) { lr *= 0.62; lg *= 0.5; lb *= 0.42; }
        const hips = rg.hips, nh = hips.length;
        let lastA = 1e9, lastC = 1, lastS = 0;
        const web = rg.webbed;
        const LM = bird ? (web ? DLEG : BLEG) : far ? LEGF : LEG;
        for (let j = 0; j < nh; j++) {
          const hxz = hips[j];
          const hx = hxz[0] * u, hz = hxz[1] * u;
          const wx = x + BR[0] * hx + BR[3] * hyE + BR[6] * hz, wy = ypiv + BR[1] * hx + BR[4] * hyE + BR[7] * hz, wz = z + BR[2] * hx + BR[5] * hyE + BR[8] * hz;
          let a;
          if (nh === 2) a = j === 0 ? legA0 : legA1;
          else a = j === 0 ? legA0 : j === 1 ? legA1 : j === 2 ? legB0 : legB1;
          let ca = 1, sa = 0;
          if (a !== 0) {
            if (a === -lastA) { ca = lastC; sa = -lastS; }
            else if (a === lastA) { ca = lastC; sa = lastS; }
            else { ca = fcos(a); sa = fsin(a); }
            lastA = a; lastC = ca; lastS = sa;
          }
          const lw = (nh === 4 && j >= 2 && rg.legW2 ? rg.legW2 : rg.legW) * u;
          let idx;
          if (bird) idx = web ? nDLeg++ : nBLeg++; else if (far) idx = nLegF++; else idx = nLeg++;
          if (idx >= capOf(LM)) ensure(LM, idx);
          putLimb(LM.inst, idx, wx, wy, wz, ca, sa, lw, lenE);
          setTint(LM.tint, idx, lr, lg, lb);
        }
      }

      // shadow
      if (!swim && flo < 0.3) {
        const o = nSh * 3; sd[o] = x; sd[o + 1] = z; sd[o + 2] = shadowK * rg.radius * sc * (lie > 0.5 ? 0.9 : 1) * (sink > 0 ? 1 - 0.5 * sink / sinkCap : 1); nSh++;
      }
    }
    for (let s = 0; s < NSP; s++) {
      BODY[s].count = nBody[s]; HEAD[s].count = nBody[s]; WHOLE[s].count = nWhole[s];
      if (MALE[s]) MALE[s].count = nMale[s];
      if (BODYA[s]) { BODYA[s].count = nBodyA[s]; HEADA[s].count = nBodyA[s]; WHOLEA[s].count = nWholeA[s]; }
      if (FANM[s]) { FANM[s].count = nFanA[s]; FANFM[s].count = nFanFA[s]; }
    }
    BLOB.count = nBlob;
    const animalsDrawn = n - culled;

    // ================================================================ farmers
    const nf = w.farmerCount;
    growF(w.f_type.length);
    nFB.fill(0); nFW.fill(0);
    const nArm = FARM_COUNTS; nArm[0] = nArm[1] = nArm[2] = nArm[3] = 0;
    const FR = FARMER_RIG;
    const f_type = w.f_type, f_state = w.f_state, f_px = w.f_px, f_pz = w.f_pz, f_ppx = w.f_ppx, f_ppz = w.f_ppz;
    const f_heading = w.f_heading, f_pheading = w.f_pheading, f_gait = w.f_gait, f_animT = w.f_animT, f_carry = w.f_carry, f_task = w.f_task;
    for (let f = 0; f < nf; f++) {
      let ty = f_type[f]; if (ty > 3) ty = 0;
      const px0 = f_ppx[f], pz0 = f_ppz[f], px1 = f_px[f], pz1 = f_pz[f];
      if (px1 !== px1 || pz1 !== pz1) continue;
      const x = px0 + (px1 - px0) * alpha, z = pz0 + (pz1 - pz0) * alpha;
      let dh = f_heading[f] - f_pheading[f];
      dh -= TWO_PI * Math.round(dh / TWO_PI);
      const yaw = f_pheading[f] + dh * alpha;
      const ddx = x - camX, ddz = z - camZ;
      if (ddx * ddx + ddz * ddz > fogFar2) continue;
      if (doCull) {
        let out = false;
        for (let p = 0; p < 20; p += 4) if (PL[p] * x + PL[p + 1] * 0.9 + PL[p + 2] * z + PL[p + 3] < -1.3) { out = true; break; }
        if (out) continue;
      }
      const st = f_state[f], t = f_animT[f], ph0 = f * 1.7;
      const dxp = px1 - px0, dzp = pz1 - pz0;
      const v = Math.sqrt(dxp * dxp + dzp * dzp) * IDT;
      const moving = v > 0.08;
      const carrying = f_carry[f] > 0;
      const gaitNow = f_gait[f] + (moving ? v * alpha * SIM_DT * FR.cpm : 0);
      const ph = TWO_PI * gaitNow;
      const ampF = moving ? Math.min(1.25, v / 2.2) : 0;
      if (ddx * ddx + ddz * ddz > lod2) {
        // far farmer: one coarse mesh (no arms / outline) + two simple legs
        const sitF = f_state[f] === FS.REST ? 1 : 0, hipF = FR.hipY * (1 - 0.46 * sitF);
        setBR(yaw, 0, 0);
        const kw = nFW[ty]++, FW = FWHOLE[ty];
        if (kw >= capOf(FW)) ensure(FW, kw);
        putBody(FW.inst, kw, x, hipF, z, 1, 1, 1);
        const tvF = 0.94 + 0.06 * fsin(f * 12.9898);
        setTint(FW.tint, kw, tvF, tvF, tvF);
        const prF = FR.looks[ty].pantsRGB, aF = moving ? 0.62 * ampF * fsin(ph) : 0;
        for (let side = 0; side < 2; side++) {
          const sg = side === 0 ? -1 : 1, aa = side === 0 ? aF : -aF, cA = fcos(aa), sA = fsin(aa);
          if (nLegF >= capOf(LEGF)) ensure(LEGF, nLegF);
          putLimb(LEGF.inst, nLegF, x + BR[0] * sg * FR.legX, hipF, z + BR[2] * sg * FR.legX, cA, sA, FR.legW, FR.legLen * (1 - 0.3 * sitF));
          setTint(LEGF.tint, nLegF, prF[0], prF[1], prF[2]); nLegF++;
        }
        { const o = nSh * 3; sd[o] = x; sd[o + 1] = z; sd[o + 2] = 0.9; nSh++; }
        continue;
      }
      let tt = 255; const tk = f_task[f]; if (tk >= 0 && tk < MAX_TASKS && w.t_alive[tk]) tt = w.t_type[tk];

      let torso = 0, aL = 0, aR = 0, sit = 0, lL = 0, lR = 0, bobY = 0, breathe = 0, torsoYaw = 0;
      switch (st) {
        case FS.PICKUP:
          torso = 0.28; aL = aR = -1.0 - 0.3 * Math.max(0, fsin(5 * t)); break;
        case FS.WORK:
          switch (tt) {
            case TaskType.FEED: case TaskType.WATER:
              torso = 0.3 + 0.1 * fsin(2 * t); aL = aR = -1.3 - 0.3 * fsin(3 * t); break;
            case TaskType.CLEAN:
              torso = 0.5 + 0.22 * fsin(4.5 * t); aL = -0.9 + 0.45 * fsin(4.5 * t); aR = aL - 0.1; lL = -0.25; lR = 0.25; break;
            case TaskType.MILK:
              sit = 0.75; torso = 0.28; aL = -1.0 + 0.5 * fsin(8 * t); aR = -1.0 - 0.5 * fsin(8 * t); break;
            case TaskType.SHEAR:
              sit = 0.6; torso = 0.5; aL = -1.1 + 0.55 * fsin(10 * t); aR = -1.1 + 0.55 * fsin(10 * t + 1.6); break;
            case TaskType.TREAT:
              sit = 0.7; torso = 0.18; aL = -1.1 + 0.15 * fsin(3 * t); aR = -1.0 - 0.15 * fsin(3 * t); break;
            case TaskType.COLLECT_EGGS:
              torso = 0.6; aL = aR = -0.45 - 0.35 * fsin(3 * t); break;
            default:
              torso = 0.2; aL = -1.0 + 0.3 * fsin(4 * t); aR = -1.0 - 0.3 * fsin(4 * t);
          }
          break;
        case FS.DROPOFF:
          torso = 0.12; aL = aR = -1.15 - 0.3 * fsin(6 * t); break;
        case FS.LEAN:
          torso = 0.24; aL = aR = -1.1; breathe = 1; break;
        case FS.REST:
          sit = 1; torso = 0.04; aL = aR = -0.5; breathe = 1; break;
        case FS.MOVE: case FS.WANDER: default:
          if (moving) {
            const S = fsin(ph) * ampF;
            lL = 0.62 * S; lR = -0.62 * S;
            if (carrying) { aL = aR = -1.15 + 0.04 * fsin(2 * ph); }
            else { aL = -0.5 * S; aR = 0.5 * S; }
            bobY = 0.03 * Math.abs(fcos(ph)) * ampF; torso = 0.05 * ampF;
          } else {
            aL = 0.05 * fsin(1.5 * t + ph0); aR = -aL; breathe = 1;
            if (carrying) aL = aR = -1.15;
          }
      }
      // smooth
      const sT = fTorso[f] += (torso - fTorso[f]) * kFarm, sL = fArmL[f] += (aL - fArmL[f]) * kFarm, sR = fArmR[f] += (aR - fArmR[f]) * kFarm, sSit = fSit[f] += (sit - fSit[f]) * kFarm;

      const hipY = FR.hipY * (1 - 0.46 * sSit) + bobY;
      setBR(yaw, sT, 0);
      const kb = nFB[ty]++;
      const FB = FBODY[ty];
      if (kb >= capOf(FB)) ensure(FB, kb);
      const by = breathe ? 1 + 0.008 * fsin(2.2 * t + ph0) : 1;
      putBody(FB.inst, kb, x, hipY, z, 1, by, 1);
      const look = FR.looks[ty];
      const tv = 0.94 + 0.06 * fsin(f * 12.9898);
      setTint(FB.tint, kb, tv, tv, tv);
      // arms (children of torso)
      const AM = FARM[ty];
      const sx = FR.shoulderX, sy = FR.shoulderY;
      for (let side = 0; side < 2; side++) {
        const sgn = side === 0 ? -1 : 1;
        const a = (side === 0 ? sL : sR) - sT;
        const ca = fcos(a), sa = fsin(a);
        const hx = sgn * sx;
        const wx = x + BR[0] * hx + BR[3] * sy, wy = hipY + BR[1] * hx + BR[4] * sy, wz = z + BR[2] * hx + BR[5] * sy;
        const ka = nArm[ty]++;
        if (ka >= capOf(AM)) ensure(AM, ka);
        putLimb(AM.inst, ka, wx, wy, wz, ca, sa, FR.armW, FR.armLen);
        setTint(AM.tint, ka, tv, tv, tv);
      }
      // legs (yaw-only frame)
      setBR(yaw, 0, 0);
      const legLenE = FR.legLen * (1 - 0.3 * sSit);
      const pr = look.pantsRGB;
      for (let side = 0; side < 2; side++) {
        const sgn = side === 0 ? -1 : 1;
        let a = side === 0 ? lL : lR;
        a = a * (1 - sSit) - 1.3 * sSit * (side === 0 ? 1 : 0.85);
        const ca = fcos(a), sa = fsin(a);
        const hx = sgn * FR.legX;
        const wx = x + BR[0] * hx, wy = hipY, wz = z + BR[2] * hx;
        if (nLeg >= capOf(LEG)) ensure(LEG, nLeg);
        putLimb(LEG.inst, nLeg, wx, wy, wz, ca, sa, FR.legW, legLenE);
        setTint(LEG.tint, nLeg, pr[0], pr[1], pr[2]);
        nLeg++;
      }
      { const o = nSh * 3; sd[o] = x; sd[o + 1] = z; sd[o + 2] = 0.9; nSh++; }
    }
    for (let t = 0; t < 4; t++) { FBODY[t].count = nFB[t]; FARM[t].count = nArm[t]; FWHOLE[t].count = nFW[t]; }
    LEG.count = nLeg; BLEG.count = nBLeg; DLEG.count = nDLeg; LEGF.count = nLegF;

    // ================================================================ items
    nItem.fill(0);
    const hi = w.itemHigh;
    const i_alive = w.i_alive, i_kind = w.i_kind, i_state = w.i_state, i_slot = w.i_slot, i_x = w.i_x, i_y = w.i_y, i_z = w.i_z, i_yaw = w.i_yaw, i_carrier = w.i_carrier;
    let nItems = 0;
    for (let i = 0; i < hi; i++) {
      if (!i_alive[i]) continue;
      const kind = i_kind[i];
      if (kind > 7) continue;
      let x, y, z, yaw, pitch = 0;
      if (i_state[i] === ItemState.CARRIED) {
        const f = i_carrier[i];
        if (f < 0 || f >= nf) continue;
        const px0 = f_ppx[f], pz0 = f_ppz[f];
        const fx = px0 + (f_px[f] - px0) * alpha, fz = pz0 + (f_pz[f] - pz0) * alpha;
        let dh = f_heading[f] - f_pheading[f];
        dh -= TWO_PI * Math.round(dh / TWO_PI);
        yaw = f_pheading[f] + dh * alpha;
        const sy = fsin(yaw), cy = fcos(yaw);
        const slot = i_slot[i];
        let fw = 0.5, up = 1.0, rt = 0;
        if (kind === ItemKind.EGG) { rt = ((slot % 3) - 1) * 0.07; up = 1.02 + (((slot / 3) | 0) % 4) * 0.07; fw = 0.42; }
        else if (kind === ItemKind.MANURE) { up = 0.96 + slot * 0.1; }
        else if (kind === ItemKind.WOOL) { up = 0.92 + ((slot / 2) | 0) * 0.22; rt = (slot % 2 - 0.5) * 0.24; }
        else if (kind === ItemKind.MILK) { up = 0.92 + ((slot / 2) | 0) * 0.2; rt = (slot % 2 - 0.5) * 0.24; }
        else if (kind === ItemKind.WATER || kind === ItemKind.FEED || kind === ItemKind.HAY || kind === ItemKind.MEDKIT) {
          up = 0.92;
          if (w.f_state[f] === FS.WORK) {
            const tk = f_task[f]; const tt = tk >= 0 && tk < MAX_TASKS && w.t_alive[tk] ? w.t_type[tk] : 255;
            if (tt === TaskType.FEED || tt === TaskType.WATER) pitch = 0.5 + 0.3 * fsin(3 * f_animT[f]);
          }
        }
        x = fx + sy * fw + cy * rt; z = fz + cy * fw - sy * rt; y = up * FARMER_RIG.carryK;
      } else {
        x = i_x[i]; y = i_y[i]; z = i_z[i]; yaw = i_yaw[i];
      }
      if (doCull) {
        let out = false;
        for (let p = 0; p < 20; p += 4) if (PL[p] * x + PL[p + 1] * (y + 0.2) + PL[p + 2] * z + PL[p + 3] < -0.7) { out = true; break; }
        if (out) continue;
      }
      const M_ = ITEM[kind], k = nItem[kind]++;
      if (k >= capOf(M_)) ensure(M_, k);
      writeItem(M_.inst, k, x, y, z, yaw, pitch);
      nItems++;
    }
    for (let k = 0; k < 8; k++) ITEM[k].count = nItem[k];

    // ================================================================ gates
    const gi = GATE.inst;
    for (let p = 0; p < PENS.length; p++) {
      const P = PENS[p];
      const open = clamp(w.pen_gateOpen[p] || 0, 0, 1);
      writeItem(gi, p, P.cx - 2, 0, P.gateEdgeZ, -P.s * open * (PI / 2), 0);
    }
    GATE.count = R.hideGates ? 0 : PENS.length;

    SH.count = nSh;
    let est = 0;
    for (let i = 0; i < meshes.length; i++) { const M = meshes[i]; M.upload(); if (M.vertexCount) est += M.count * (M.vertexCount / 3) * (M.outline > 0 ? 2 : 1); }
    SH.upload();
    lastEst = est + nSh * 16;

    counts.animals = animalsDrawn; counts.farmers = nf; counts.items = nItems; counts.culled = culled; counts.shadows = nSh;
    counts.near = cNear; counts.far = cFar; counts.blob = nBlob; counts.lodDist = R.lodDist;
  }

  return R;
}

const FARM_COUNTS = [0, 0, 0, 0];
const capOf2 = S => (S.capacity != null ? S.capacity : S.data.length / 3);
function growSh(S, need, live) {
  let nc = Math.max(capOf2(S), 1024); while (nc < need) nc *= 2;
  if (S.grow) S.grow(nc, live == null ? 0 : live);
  else { S.data = new Float32Array(nc * 3); S.capacity = nc; }
}

// yaw + pitch model matrix (unit scale)
function writeItem(arr, k, x, y, z, yaw, pitch) {
  const o = k * 16, c = fcos(yaw), s = fsin(yaw);
  if (pitch === 0) {
    arr[o] = c; arr[o + 1] = 0; arr[o + 2] = -s; arr[o + 3] = 0; arr[o + 4] = 0; arr[o + 5] = 1; arr[o + 6] = 0; arr[o + 7] = 0;
    arr[o + 8] = s; arr[o + 9] = 0; arr[o + 10] = c; arr[o + 11] = 0;
  } else {
    const cp = fcos(pitch), sp = fsin(pitch);
    arr[o] = c; arr[o + 1] = 0; arr[o + 2] = -s; arr[o + 3] = 0;
    arr[o + 4] = s * sp; arr[o + 5] = cp; arr[o + 6] = c * sp; arr[o + 7] = 0;
    arr[o + 8] = s * cp; arr[o + 9] = -sp; arr[o + 10] = c * cp; arr[o + 11] = 0;
  }
  arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1;
}
