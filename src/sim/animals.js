// WP2 animal simulation. No DOM / WebGL. Runs under Node. No allocation in updateAnimals().
// Precondition: buildHash(W.hash, W.a_px, W.a_pz, W.animalCount) was called this tick.
//
// a_state meanings (for the renderer):
//  IDLE/PECK/SCRATCH/PREEN/REST/SLEEP/FREEZE/LAY/DUSTBATH/WALLOW/ROLL/DUNG/CLIMB/SICK : stationary (speed 0)
//  GRAZE/ROOT : creeping (speed ~0.15*walk), head down       WANDER/GOTO/FLOCK/SWIM : walking
//  HOP : rabbit hop (a_gait advances at 3 cycles/s regardless of speed; speed 0 = binky in place)
//  FLEE : run   TROT : horse trot (0.5*run)   DISPLAY : turkey strut (slow walk)
//  EAT/DRINK : stationary at trough, facing it    BUTT : goats face each other, partner in a_leader
//  HELD : untouched (WP3 owns it)   a_leader : duck/sheep leader (or goat BUTT partner), -1 none
import { SPECIES, PENS, PEN_COUNT, AState as A, AFlag, FeatureKind as K, ItemKind, WATER_Y, MAX_ANIMALS, blobPoint, inBlob, clampToBlob, blobDepth, WADE_K, SINK_CAP, FLOAT_LIFT } from '../config.js';
import { queryHash } from '../ecs/spatialHash.js';
import { spawnItem, terrainHeight, pushOutOfSolids, isNight } from '../ecs/world.js';

// ------------------------------------------------------------------ tuning
const HUNGER_RATE = 1 / 420, THIRST_RATE = 1 / 360, EAT_RATE = 0.25, NEED_THRESH = 0.6;
const GRAZE_RELIEF = 0.004;                  // hay species hunger relief while grazing (plan said .05; far too strong for feeder use)
const EGG_RATE = 0.15, MILK_RATE = 0.05, WOOL_RATE = 0.04;
const MANURE_EVERY = 8, MANURE_CAP = 40, EGG_CAP = 40, SICK_EVERY = 180, SICK_CAP = 20;
const TWO_PI = Math.PI * 2;
const BINKY = 64, EATHAY = 65, BROWSE = 66;  // pseudo choices

const SP = { CHICKEN: 0, DUCK: 1, TURKEY: 2, RABBIT: 3, GOAT: 4, SHEEP: 5, PIG: 6, COW: 7, HORSE: 8, LLAMA: 9 };

// ------------------------------------------------------------------ static tables (all per species / pen, built from SPECIES[s].beh flags; see config.js)
const NS = PEN_COUNT;
const WALK = new Float32Array(NS), RUN = new Float32Array(NS), RAD = new Float32Array(NS), HGT = new Float32Array(NS);
const TURN = new Float32Array(NS), WD_MIN = new Float32Array(NS), WD_MAX = new Float32Array(NS);
const DRAIN_MUL = new Float32Array(NS), THIRST_MUL = new Float32Array(NS), SCARE_R = new Float32Array(NS), FREEZE_R2 = new Float32Array(NS), FLEE_D = new Float32Array(NS);
const PROD_RATE = new Float32Array(NS), IS_LAYER = new Uint8Array(NS), IS_MW = new Uint8Array(NS), IS_HAY = new Uint8Array(NS);
const HAS_REST = new Uint8Array(NS), PANIC = new Uint8Array(NS), HERD = new Uint8Array(NS), FOLLOW = new Uint8Array(NS), NOON = new Uint8Array(NS), TROTS = new Uint8Array(NS);
const BUOY = new Uint8Array(NS), WADE = new Uint8Array(NS), WON = new Uint8Array(NS);   // WATER: buoyant swimmer / wader / either (runs the vertical water spring)
const BATH_ROLL = new Uint8Array(NS);   // 1: the species' bath feature is for ROLL (yak snow drift) rather than DUSTBATH
for (let s = 0; s < NS; s++) {
  const d = SPECIES[s], b = d.beh;
  WALK[s] = d.walk; RUN[s] = d.run; RAD[s] = d.radius; HGT[s] = d.height;
  IS_HAY[s] = d.diet === 'hay' ? 1 : 0;
  if (d.produce === ItemKind.EGG) { PROD_RATE[s] = EGG_RATE; IS_LAYER[s] = 1; }
  else if (d.produce === ItemKind.MILK) { PROD_RATE[s] = MILK_RATE; IS_MW[s] = 1; }
  else if (d.produce === ItemKind.WOOL) { PROD_RATE[s] = WOOL_RATE; IS_MW[s] = 1; }
  TURN[s] = b.turn || 5; WD_MIN[s] = b.wd ? b.wd[0] : 3; WD_MAX[s] = b.wd ? b.wd[1] : 8;
  DRAIN_MUL[s] = b.drain || 1; THIRST_MUL[s] = b.thirst || 1;
  SCARE_R[s] = b.scare || 1.5; FREEZE_R2[s] = (b.freeze || 0) * (b.freeze || 0); FLEE_D[s] = b.fleeD || 1;
  HAS_REST[s] = b.rest ? 1 : 0; PANIC[s] = b.panic ? 1 : 0; HERD[s] = b.herd ? 1 : 0; FOLLOW[s] = b.follow ? 1 : 0; NOON[s] = b.noon ? 1 : 0;
  BUOY[s] = b.buoy ? 1 : 0; WADE[s] = b.wade ? 1 : 0; WON[s] = BUOY[s] | WADE[s];
  TROTS[s] = b.trot ? 1 : 0; BATH_ROLL[s] = b.bath && b.bath.state === A.ROLL ? 1 : 0;
}
const K_FOOD = 0.2, K_WATER = 0.18;        // pen_food/pen_water drain = dt*K*DRAIN_MUL*(eaters/max(1,pen_count)); large grazers spend more time queueing/grazing than eating, so their eating fraction is lower: DRAIN_MUL compensates

// per-state movement: speed = WALK*WF + RUN*RF ; STOP2 = squared distance to target at which we stop
const WF = new Float32Array(32), RF = new Float32Array(32), STOP2 = new Float32Array(32).fill(0.0004);
WF[A.WANDER] = 1; WF[A.GOTO] = 1.5; WF[A.GRAZE] = 0.15; WF[A.ROOT] = 0.15; WF[A.FLOCK] = 1; WF[A.SWIM] = 1; WF[A.HOP] = 1;
WF[A.DISPLAY] = 0.35; WF[A.BUTT] = 0.35; RF[A.FLEE] = 1; RF[A.TROT] = 0.5;
STOP2[A.BUTT] = 1.2; STOP2[A.GOTO] = 0.01;

// choice tables: [state, weight] per species (daytime)
const TBL = [
  [[A.PECK, .35], [A.SCRATCH, .15], [A.WANDER, .25], [A.IDLE, .10], [A.DUSTBATH, .05], [A.PREEN, .05]],
  [[A.WANDER, .30], [A.SWIM, .30], [A.PECK, .15], [A.PREEN, .10], [A.IDLE, .15]],
  [[A.WANDER, .30], [A.PECK, .30], [A.DISPLAY, .15], [A.IDLE, .25]],
  [[A.HOP, .30], [A.GRAZE, .35], [A.FREEZE, .10], [A.REST, .15], [BINKY, .05]],
  [[BROWSE, .30], [A.CLIMB, .25], [A.BUTT, .10], [A.WANDER, .20], [A.REST, .15]],
  [[A.GRAZE, .50], [A.FLOCK, .15], [A.REST, .15], [A.WANDER, .10], [A.IDLE, .10]],
  [[A.ROOT, .30], [A.WALLOW, .25], [A.WANDER, .15], [A.REST, .20], [A.IDLE, .10]],
  [[A.GRAZE, .45], [A.REST, .25], [A.WANDER, .10], [A.IDLE, .10], [EATHAY, .10]],
  [[A.GRAZE, .40], [A.TROT, .10], [A.IDLE, .25], [A.ROLL, .03], [A.WANDER, .17]],
  [[A.GRAZE, .40], [A.IDLE, .20], [A.REST, .15], [A.DUNG, .05], [A.WANDER, .20]],
  // 10 donkey
  [[A.GRAZE, .40], [A.IDLE, .25], [A.WANDER, .20], [A.REST, .10], [A.ROLL, .05]],
  // 11 goose: waddles in leader-led groups, swims the stream
  [[A.WANDER, .30], [A.SWIM, .25], [A.PECK, .15], [A.PREEN, .12], [A.IDLE, .18]],
  // 12 alpaca
  [[A.GRAZE, .40], [A.IDLE, .20], [A.REST, .15], [A.WANDER, .15], [A.FLOCK, .10]],
  // 13 deer: grazes, freezes alert, drifts as a herd
  [[A.GRAZE, .42], [A.FREEZE, .10], [A.IDLE, .15], [A.WANDER, .15], [A.REST, .12], [A.FLOCK, .06]],
  // 14 ostrich
  [[A.PECK, .25], [A.WANDER, .25], [A.IDLE, .18], [A.DUSTBATH, .10], [A.DISPLAY, .10], [A.PREEN, .07], [A.SCRATCH, .05]],
  // 15 yak: rolls in the snow drift
  [[A.GRAZE, .42], [A.REST, .25], [A.IDLE, .15], [A.WANDER, .10], [A.ROLL, .05], [EATHAY, .03]],
  // 16 buffalo: wallows in the marsh mud
  [[A.GRAZE, .35], [A.WALLOW, .25], [A.REST, .18], [A.IDLE, .10], [A.WANDER, .07], [EATHAY, .05]],
  // 17 peacock: displays
  [[A.PECK, .28], [A.WANDER, .25], [A.DISPLAY, .20], [A.IDLE, .15], [A.PREEN, .12]],
  // 18 camel: rests a lot, cools off in the oasis now and then
  [[A.GRAZE, .32], [A.REST, .28], [A.IDLE, .15], [A.WANDER, .15], [A.WALLOW, .05], [EATHAY, .05]],
  // 19 capybara: soaks in the hot spring
  [[A.SWIM, .30], [A.GRAZE, .28], [A.REST, .17], [A.IDLE, .12], [A.WANDER, .13]],
];
const TS = [], TW = [], TTOT = new Float32Array(NS), TWATER = new Float32Array(NS);   // TWATER: summed weight of the SWIM / WALLOW entries (cool-down choices)
for (let s = 0; s < NS; s++) {
  TS.push(new Uint8Array(TBL[s].map(e => e[0]))); TW.push(new Float32Array(TBL[s].map(e => e[1])));
  TTOT[s] = TBL[s].reduce((a, e) => a + e[1], 0);
  TWATER[s] = TBL[s].reduce((a, e) => a + (e[0] === A.SWIM || e[0] === A.WALLOW ? e[1] : 0), 0);
}

// pen geometry caches
const PX0 = new Float32Array(NS), PX1 = new Float32Array(NS), PZ0 = new Float32Array(NS), PZ1 = new Float32Array(NS);
const SW = PENS.map(P => P.swim), WL = PENS.map(P => P.wallow), BATH = PENS.map(P => P.bath), DUNGP = PENS.map(P => P.dungPile);   // per-pen blob / circle features (null = none)
// WATER: per-pen blob that carries the vertical water logic (swimmers' pond / spring, waders' mud pit / oasis; null = species never enters water), its bounding circle,
// and the drinkable water body of the pen (POND / stream / OASIS / HOT_SPRING; null = trough only)
const WB = PENS.map((P, p) => (WON[p] ? (P.swim || P.wallow) : null));
const DPOOL = PENS.map(P => P.pool);
const WCX = new Float32Array(NS), WCZ = new Float32Array(NS), WR2 = new Float32Array(NS);
for (let p = 0; p < NS; p++) if (WB[p]) { WCX[p] = WB[p].x; WCZ[p] = WB[p].z; WR2[p] = (WB[p].blob.rmax + 0.3) ** 2; }
// depth lookup grid per water blob (0.25 m cells over its bounding box, bilinear): O(1) and trig-free, same values as config.blobDepth (+-1 mm)
const DG_CELL = 0.25, DG_INV = 1 / DG_CELL;
const DG_N = new Int32Array(NS), DG_X0 = new Float32Array(NS), DG_Z0 = new Float32Array(NS), DG = [];
for (let p = 0; p < NS; p++) {
  DG.push(null);
  if (!WB[p]) continue;
  const f = WB[p], r = f.blob.rmax + 0.6, n = Math.ceil(2 * r * DG_INV) + 2;
  DG_N[p] = n; DG_X0[p] = f.x - r; DG_Z0[p] = f.z - r;
  const g = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) g[j * n + i] = blobDepth(f, DG_X0[p] + i * DG_CELL, DG_Z0[p] + j * DG_CELL);
  DG[p] = g;
}
function depthAt(p, x, z) {
  const n = DG_N[p], fx = (x - DG_X0[p]) * DG_INV, fz = (z - DG_Z0[p]) * DG_INV;
  let ix = fx | 0, iz = fz | 0;
  if (fx < 0 || fz < 0 || ix >= n - 1 || iz >= n - 1) return 0;
  const tx = fx - ix, tz = fz - iz, g = DG[p], o = iz * n + ix;
  if (g[o] === 0 || g[o + 1] === 0 || g[o + n] === 0 || g[o + n + 1] === 0) return 0;   // shoreline cell: dry (also stops the bilinear blur leaking outside the outline)
  return (g[o] * (1 - tx) + g[o + 1] * tx) * (1 - tz) + (g[o + n] * (1 - tx) + g[o + n + 1] * tx) * tz;
}
const WK = 36, WC = 12;                  // critically damped vertical spring: omega = 6 /s, damping 2*omega
const HALF_H = new Float32Array(NS); for (let s = 0; s < NS; s++) HALF_H[s] = SINK_CAP * SPECIES[s].height;   // hard cap on the sink (x a_scale)
const wTgt = new Float32Array(MAX_ANIMALS);   // cached target a_wy (recomputed on the animal's slow parity)
// cool-down bias towards midday: 0 outside 10:00-17:00, rising to 1 at 13:00, back to 0 at 17:00
function noonBell(h) { return h < 10 || h >= 17 ? 0 : h < 13 ? (h - 10) / 3 : (17 - h) * 0.25; }
const BURROWS = PENS[3].features.filter(f => f.kind === K.BURROW);
const ROCKS = PENS[4].features.filter(f => f.kind === K.ROCK);
const GOAT_BROWSE = PENS[4].features.filter(f => f.kind === K.BUSH || f.kind === K.HAY_FEEDER);
for (let p = 0; p < NS; p++) { PX0[p] = PENS[p].x0; PX1[p] = PENS[p].x1; PZ0[p] = PENS[p].z0; PZ1[p] = PENS[p].z1; }

// max error ~1e-5 rad; Math.atan2 was ~12% of the 10k-animal tick (headings need no more precision)
function atan2f(y, x) {
  const ax = x < 0 ? -x : x, ay = y < 0 ? -y : y;
  const mx = ax > ay ? ax : ay;
  if (mx === 0) return 0;
  const a = (ax > ay ? ay : ax) / mx, q = a * a;
  let r = (((-0.0464964749 * q + 0.15931422) * q - 0.327622764) * q * a + a);
  if (ay > ax) r = 1.57079637 - r;
  if (x < 0) r = 3.14159274 - r;
  return y < 0 ? -r : r;
}

// ------------------------------------------------------------------ module scratch (no per-tick allocation)
const _o = new Float32Array(2), _q = new Float64Array(4), _T = new Float64Array(2);   // _T: dt, 2*dt for slowStep   // _q: x, z, radius scratch for pushSolids (no boxed doubles across calls)
// flat per-pen solid tables (circle: r>0, else axis-aligned rect with half extents hw,hd)
const SOL0 = new Int32Array(NS + 1), SOLX = [], SOLZ = [], SOLR = [], SOLHW = [], SOLHD = [];
for (let p = 0; p < NS; p++) {
  SOL0[p] = SOLX.length;
  for (const f of PENS[p].solids) { SOLX.push(f.x); SOLZ.push(f.z); SOLR.push(f.r > 0 ? f.r : 0); SOLHW.push(f.w * 0.5); SOLHD.push(f.d * 0.5); }
}
SOL0[NS] = SOLX.length;
const S_X = Float64Array.from(SOLX), S_Z = Float64Array.from(SOLZ), S_R = Float64Array.from(SOLR), S_HW = Float64Array.from(SOLHW), S_HD = Float64Array.from(SOLHD);
// same maths as world.pushOutOfSolids(p, x, z, radius): reads/writes _q[0],_q[1] (radius in _q[2]); returns 1 if moved
function pushSolids(p) {
  let x = _q[0], z = _q[1];
  const radius = _q[2], k1 = SOL0[p + 1];
  let moved = 0;
  for (let pass = 0; pass < 2; pass++) {
    let any = 0;
    for (let k = SOL0[p]; k < k1; k++) {
      const sx = S_X[k], sz = S_Z[k], r = S_R[k];
      if (r > 0) {
        const dx = x - sx, dz = z - sz, m = r + radius;
        if (dx > m || dx < -m || dz > m || dz < -m) continue;
        const d2 = dx * dx + dz * dz;
        if (d2 < m * m) {
          const d = Math.sqrt(d2);
          if (d > 1e-6) { x = sx + dx / d * m; z = sz + dz / d * m; } else x = sx + m;
          any = 1;
        }
      } else {
        const hw = S_HW[k], hd = S_HD[k];
        if (x > sx + hw + radius || x < sx - hw - radius || z > sz + hd + radius || z < sz - hd - radius) continue;
        const nx = Math.max(sx - hw, Math.min(x, sx + hw)), nz = Math.max(sz - hd, Math.min(z, sz + hd));
        const dx = x - nx, dz = z - nz, d2 = dx * dx + dz * dz;
        if (d2 < radius * radius) {
          if (d2 > 1e-10) { const d = Math.sqrt(d2); x = nx + dx / d * radius; z = nz + dz / d * radius; }
          else {
            const ex = hw - Math.abs(x - sx), ez = hd - Math.abs(z - sz);
            if (ex < ez) x = (x >= sx ? sx + hw + radius : sx - hw - radius); else z = (z >= sz ? sz + hd + radius : sz - hd - radius);
          }
          any = 1;
        }
      }
    }
    if (!any) break;
    moved = 1;
  }
  _q[0] = x; _q[1] = z;
  return moved;
}

// obstacle proximity grid: per pen, 2 m cells holding (distance from the cell to the nearest solid's edge, minus the cell half-diagonal) in 0.25 m units (capped at 255).
// steer() is skipped for animals whose lookahead cannot reach any solid: most of a pen is open ground.
const OG_W = 22, OG_H = 28, OG_N = OG_W * OG_H;
const OBG = new Uint8Array(NS * OG_N);
for (let p = 0; p < NS; p++) {
  const P = PENS[p];
  for (let j = 0; j < OG_H; j++) for (let i = 0; i < OG_W; i++) {
    const x = P.x0 + (i + 0.5) * 2, z = P.z0 + (j + 0.5) * 2;
    let m = 255;
    for (const f of P.solids) {
      let d;
      if (f.r > 0) d = Math.hypot(x - f.x, z - f.z) - f.r;
      else { const nx = Math.max(f.x - f.w / 2, Math.min(x, f.x + f.w / 2)), nz = Math.max(f.z - f.d / 2, Math.min(z, f.z + f.d / 2)); d = Math.hypot(x - nx, z - nz); }
      d = (d - 1.5) * 4; if (d < m) m = d < 0 ? 0 : Math.floor(d);
    }
    OBG[p * OG_N + j * OG_W + i] = m;
  }
}

// ------------------------------------------------------------------ obstacle steering
// Bends the desired heading (ux,uz) around the nearest solid blocking the next `look` metres: circles by a tangent to the clearance ring
// (r + body + margin), rects by sliding along the blocking face of the inflated box. The orbit sense (+1 ccw / -1 cw) is remembered per animal
// (avoidO / avoidT) so the choice does not flip tick to tick. Result in _sd[0],_sd[1]; returns 1 if the heading was changed. No allocation.
const AV_MARGIN = 0.3, AV_HOLD = 1.5;
const avoidO = new Int8Array(MAX_ANIMALS), avoidT = new Float32Array(MAX_ANIMALS);
const _sd = new Float64Array(2);
const steerX = new Float32Array(MAX_ANIMALS), steerZ = new Float32Array(MAX_ANIMALS), steerOn = new Uint8Array(MAX_ANIMALS);   // bent heading cached between slow ticks
const stuckT = new Float32Array(MAX_ANIMALS), stuckX = new Float32Array(MAX_ANIMALS), stuckZ = new Float32Array(MAX_ANIMALS);   // seconds an animal that wants to walk has made no progress (jammed in a lane / by a crowd)
const STUCK_S = 5;
function steer(i, p, px, pz, ux, uz, dT, rad, look) {
  const k1 = SOL0[p + 1];
  const tgx = ux * dT, tgz = uz * dT;                                  // target point relative to us
  let bestA = 1e9, bk = -1, bR = 0, bnx = 0, bnz = 0;                 // nearest blocker: distance along heading (a), ring radius, rect face normal (out of the box)
  for (let k = SOL0[p]; k < k1; k++) {
    const sx = S_X[k] - px, sz = S_Z[k] - pz, r = S_R[k];
    if (r > 0) {
      const al = sx * ux + sz * uz;
      let R = r + rad + AV_MARGIN;
      if (al <= 0 || al > look + R) continue;                           // behind us / out of reach
      const lat = sx * uz - sz * ux;                                    // |lat| = distance of the centre from our line
      if (lat >= R || lat <= -R) continue;
      const tx = tgx - sx, tz = tgz - sz, td = Math.sqrt(tx * tx + tz * tz);
      if (td < R + 0.1) { R = td - 0.1; if (R < r + rad + 0.02) R = r + rad + 0.02; if (lat >= R || lat <= -R) continue; }   // target sits on this obstacle's edge (feeder, trunk): shrink the ring so the target stays outside it
      if (al - R > dT) continue;                                        // target is reached before the obstacle
      const a = al - R;
      if (a < bestA) { bestA = a; bk = k; bR = R; bnx = 0; bnz = 0; }
    } else {
      let g = rad + AV_MARGIN;
      const tdx = Math.abs(tgx - sx) - S_HW[k], tdz = Math.abs(tgz - sz) - S_HD[k], dm = tdx > tdz ? tdx : tdz;
      if (dm < g) { g = dm - 0.05; if (g < rad + 0.02) { if (dm < rad) continue; g = rad + 0.02; } }   // target at the rect's edge: shrink the margin, never avoid a box that already holds the target
      const hw = S_HW[k] + g, hd = S_HD[k] + g;
      let nx = 0, nz = 0, a = 0;
      if (sx > -hw && sx < hw && sz > -hd && sz < hd) {                 // inside the inflated box (hugging a face): only react when heading into it
        const ex = hw - Math.abs(sx), ez = hd - Math.abs(sz);
        if (ex < ez) nx = sx > 0 ? -1 : 1; else nz = sz > 0 ? -1 : 1;  // outward normal (box -> us)
        if (nx * ux + nz * uz > -0.05) continue;
      } else {                                                          // slab test of the ray against the inflated box
        let t0 = 0, t1 = look;
        if (ux > 1e-6 || ux < -1e-6) {
          const inv = 1 / ux; let lo = (sx - hw) * inv, hi = (sx + hw) * inv, nn = -1;
          if (lo > hi) { const t = lo; lo = hi; hi = t; nn = 1; }
          if (lo > t0) { t0 = lo; nx = nn; nz = 0; }
          if (hi < t1) t1 = hi;
        } else if (sx > hw || sx < -hw) continue;
        if (uz > 1e-6 || uz < -1e-6) {
          const inv = 1 / uz; let lo = (sz - hd) * inv, hi = (sz + hd) * inv, nn = -1;
          if (lo > hi) { const t = lo; lo = hi; hi = t; nn = 1; }
          if (lo > t0) { t0 = lo; nx = 0; nz = nn; }
          if (hi < t1) t1 = hi;
        } else if (sz > hd || sz < -hd) continue;
        if (t0 > t1 || (nx === 0 && nz === 0) || t0 >= dT) continue;
        a = t0;
      }
      if (a < bestA) { bestA = a; bk = k; bR = 0; bnx = nx; bnz = nz; }
    }
  }
  if (bk < 0) return 0;
  let o = avoidO[i];
  if (avoidT[i] <= 0) o = 0;
  if (bR > 0) {
    const sx = S_X[bk] - px, sz = S_Z[bk] - pz;
    const dc = Math.sqrt(sx * sx + sz * sz), ex = sx / dc, ez = sz / dc, pe = -ez * ux + ex * uz;   // pe = perp(e) . u, perp(e) = (-ez, ex)
    if (o === 0) o = pe < -0.05 ? 1 : pe > 0.05 ? -1 : ((i & 1) ? 1 : -1);
    if (dc > bR * 1.02) {
      const sn = bR / dc, cs = Math.sqrt(1 - sn * sn);
      _sd[0] = ex * cs + o * ez * sn; _sd[1] = ez * cs - o * ex * sn;      // e*cos - o*perp(e)*sin : tangent to the ring on side o
    } else {                                                            // on / inside the ring: slide along it, drifting slightly outward
      const tx = o * ez - ex * 0.35, tz = -o * ex - ez * 0.35, tl = Math.sqrt(tx * tx + tz * tz);
      _sd[0] = tx / tl; _sd[1] = tz / tl;
    }
  } else {
    if (o === 0) {
      const dotT = -bnz * ux + bnx * uz;                                 // side the target lies on (a glancing hit slides toward it)
      if (dotT > 0.2) o = 1; else if (dotT < -0.2) o = -1;
      else {                                                            // head-on: go round the nearer end of the face
        const lateral = -bnz * (px - S_X[bk]) + bnx * (pz - S_Z[bk]);
        o = lateral > 0.05 ? 1 : lateral < -0.05 ? -1 : (dotT > 0 ? 1 : -1);
      }
    }
    const tx = -o * bnz + bnx * 0.3, tz = o * bnx + bnz * 0.3, tl = Math.sqrt(tx * tx + tz * tz);   // along the face (sense o), drifting out
    _sd[0] = tx / tl; _sd[1] = tz / tl;
  }
  avoidO[i] = o; avoidT[i] = AV_HOLD;
  return 1;
}
const _nb = new Int32Array(16), _big = new Int32Array(512), _nb2 = new Int32Array(16);
const fleeCD = new Float32Array(MAX_ANIMALS);   // seconds before an animal can catch a flee panic from neighbours again
const scare = new Uint8Array(MAX_ANIMALS), sfx = new Float32Array(MAX_ANIMALS), sfz = new Float32Array(MAX_ANIMALS);
const tCnt = new Int32Array(NS), tReady = new Int32Array(NS), tSick = new Int32Array(NS), tEat = new Int32Array(NS), tDrink = new Int32Array(NS);
const invCnt = new Float32Array(NS), nearT = new Float32Array(MAX_ANIMALS);   // nearT: seconds loitering near a GOTO target

// per-tick cached references
let _W = null, _rand = null, _night = false, _tick = 0, _n = 0;
let a_px, a_py, a_pz, a_vx, a_vz, a_heading, a_speed, a_tx, a_tz, a_stateTime, a_animT, a_gait, a_scale, a_hunger, a_thirst,
  a_energy, a_produce, a_health, a_species, a_state, a_next, a_flags, a_variant, a_leader, a_heldBy, a_seed, a_wy, a_wvy, a_wdrink, hash;

function initAn(W) {
  avoidT.fill(0); avoidO.fill(0); stuckT.fill(0); steerOn.fill(0); wTgt.fill(0);   // module-level scratch: a new world starts clean (determinism)
  W._an = { manT: new Float32Array(NS), manNext: new Float32Array(NS), sickT: new Float32Array(NS) };
  for (let p = 0; p < NS; p++) { W._an.manT[p] = W.rand() * MANURE_EVERY; W._an.manNext[p] = MANURE_EVERY * (0.6 + 0.8 * W.rand()); W._an.sickT[p] = W.rand() * SICK_EVERY * 0.5; }
}

// ------------------------------------------------------------------ helpers
function setTargetM(i, x, z, clr) {   // clr: clearance (m, beyond the body radius) kept from solids
  const s = a_species[i], m = RAD[s] + 0.4;
  if (x < PX0[s] + m) x = PX0[s] + m; else if (x > PX1[s] - m) x = PX1[s] - m;
  if (z < PZ0[s] + m) z = PZ0[s] + m; else if (z > PZ1[s] - m) z = PZ1[s] - m;
  pushOutOfSolids(s, x, z, RAD[s] + clr, _o);
  a_tx[i] = _o[0]; a_tz[i] = _o[1];
}
// roaming targets (wander / graze / flee / flock / hop) never lie inside a solid: pushed to its edge + 0.5 m
function setTarget(i, x, z) { setTargetM(i, x, z, 0.5); }
function gotoPoint(i, x, z, next) {
  setTargetM(i, x, z, 0.1);
  a_state[i] = A.GOTO; a_next[i] = next; a_stateTime[i] = 90; a_animT[i] = 0; nearT[i] = 0;
}
function gotoFeatureEdge(i, f, next) {
  const rad = RAD[a_species[i]], r = _rand();
  if (f.blob) gotoShore(i, f, next);
  else if (f.r > 0) { const a = r * TWO_PI, d = f.r + rad + 0.15; gotoPoint(i, f.x + Math.sin(a) * d, f.z + Math.cos(a) * d, next); }
  else { const side = _rand() < 0.5 ? -1 : 1; gotoPoint(i, f.x + (r - 0.5) * f.w * 0.8, f.z + side * (f.d * 0.5 + rad + 0.15), next); }
}
// organic blob features (pond / mud pit): random interior point (margin metres inside the outline), or a shore point
function blobInterior(f, margin, out) {
  const t = _rand() * TWO_PI, k = 0.15 + 0.85 * Math.sqrt(_rand());
  blobPoint(f, t, k, out, 0);
  if (!inBlob(f, out[0], out[1], margin)) clampToBlob(f, out[0], out[1], margin, out);
}
function gotoInBlob(i, f, next) {
  const s = a_species[i];
  blobInterior(f, RAD[s] + 0.9, _o);
  if (WADE[s] === 1) {   // waders pick spots shallower than ~their sink cap (they may still cross the deepest part briefly)
    const lim = HALF_H[s] * a_scale[i] * 0.9;
    for (let k = 0; k < 4 && blobDepth(f, _o[0], _o[1]) * WADE_K > lim; k++) blobInterior(f, RAD[s] + 0.9, _o);
  }
  gotoPoint(i, _o[0], _o[1], next);
}
// drinking at a water body: a point `inset` metres inside the shore (ankle-deep at the edge; buoyant species sometimes float out a little further)
function gotoPoolDrink(i, f) {
  const s = a_species[i], inset = BUOY[s] === 1 && _rand() < 0.5 ? 1.2 + _rand() * 1.5 : 0.3 + _rand() * 0.3;
  blobPoint(f, _rand() * TWO_PI, 1 - inset / f.blob.rmin, _o, 0);
  gotoPoint(i, _o[0], _o[1], A.DRINK);
  a_wdrink[i] = 1;
}
function startDrink(i) {
  const s = a_species[i], f = DPOOL[s], tr = PENS[s].water;
  a_wdrink[i] = 0;
  if (f !== null) {
    const px = a_px[i], pz = a_pz[i];
    // nearer source is more likely (P(pool) = dT / (dT + dP), clamped to 30..70 % so both are used: a big pond would otherwise take every drinker)
    const dT = Math.hypot(px - tr.x, pz - tr.z), dP = Math.max(0.5, Math.hypot(px - f.x, pz - f.z) - 0.5 * (f.blob.rmin + f.blob.rmax));
    let pp = dT / (dT + dP); pp = pp < 0.3 ? 0.3 : pp > 0.7 ? 0.7 : pp;
    if (_W.pen_water[s] <= 0.05 || _rand() < pp) { gotoPoolDrink(i, f); return; }
  }
  gotoFeatureEdge(i, tr, A.DRINK);
}
function gotoShore(i, f, next) {   // a point just outside the actual outline
  const rad = RAD[a_species[i]];
  blobPoint(f, _rand() * TWO_PI, 1 + (rad + 0.3) / f.blob.rmin, _o, 0);
  gotoPoint(i, _o[0], _o[1], next);
}
function gotoInCircle(i, f, frac, next) {
  if (f.blob) { gotoInBlob(i, f, next); return; }
  const a = _rand() * TWO_PI, d = Math.sqrt(_rand()) * f.r * frac;
  gotoPoint(i, f.x + Math.sin(a) * d, f.z + Math.cos(a) * d, next);
}
function goSleep(i) {
  const sp = a_species[i], f = PENS[sp].sleep;
  // grow the sleeping circle when the herd is too big to fit (avoids animals stacked on each other)
  const need = _W.pen_count[sp] * 0.8 * 4 * RAD[sp] * RAD[sp], rNeed = Math.sqrt(need / Math.PI);
  const a = _rand() * TWO_PI, d = Math.sqrt(_rand()) * Math.max(f.r * 0.85, rNeed);
  gotoPoint(i, f.x + Math.sin(a) * d, f.z + Math.cos(a) * d, A.SLEEP);
}
function wanderTarget(i) {
  const s = a_species[i], px = a_px[i], pz = a_pz[i];
  const ang = _rand() * TWO_PI, dist = WD_MIN[s] + _rand() * (WD_MAX[s] - WD_MIN[s]);
  const sn = Math.sin(ang) * dist, cs = Math.cos(ang) * dist, m = RAD[s] + 0.4;
  let x = px + sn, z = pz + cs;
  if (x < PX0[s] + m || x > PX1[s] - m) x = px - sn;
  if (z < PZ0[s] + m || z > PZ1[s] - m) z = pz - cs;
  setTarget(i, x, z);
}
function creepTarget(i) {
  const h = a_heading[i] + (_rand() - 0.5) * 1.6, d = 1.5 + _rand() * 2.5;
  let x = a_px[i] + Math.sin(h) * d, z = a_pz[i] + Math.cos(h) * d;
  const s = a_species[i], m = RAD[s] + 0.4;
  if (x < PX0[s] + m || x > PX1[s] - m) x = a_px[i] - Math.sin(h) * d;
  if (z < PZ0[s] + m || z > PZ1[s] - m) z = a_pz[i] - Math.cos(h) * d;
  setTarget(i, x, z);
}
function pondTarget(i) {
  blobInterior(SW[a_species[i]], RAD[a_species[i]] + 0.9, _o);
  a_tx[i] = _o[0]; a_tz[i] = _o[1];
}
function trotTarget(i) {
  const s = a_species[i], idx = a_next[i] & 3;
  const x = (idx === 0 || idx === 3) ? PX0[s] + 6 : PX1[s] - 6;
  const z = (idx === 0 || idx === 1) ? PZ0[s] + 6 : PZ1[s] - 6;
  pushOutOfSolids(s, x, z, RAD[s] + 1.5, _o);
  a_tx[i] = _o[0]; a_tz[i] = _o[1];
}
function startTrot(i) {
  const s = a_species[i], px = a_px[i], pz = a_pz[i];
  let best = 0, bd = 1e9;
  for (let c = 0; c < 4; c++) {
    const x = (c === 0 || c === 3) ? PX0[s] + 6 : PX1[s] - 6, z = (c === 0 || c === 1) ? PZ0[s] + 6 : PZ1[s] - 6;
    const d = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (d < bd) { bd = d; best = c; }
  }
  enter(i, A.TROT); a_next[i] = best; trotTarget(i);
}
function fleeFrom(i, fx, fz) {
  const s = a_species[i], px = a_px[i], pz = a_pz[i];
  enter(i, A.FLEE); fleeCD[i] = 12;
  if (s === SP.RABBIT) {
    let best = 0, bd = 1e9;
    for (let b = 0; b < BURROWS.length; b++) { const d = (BURROWS[b].x - px) ** 2 + (BURROWS[b].z - pz) ** 2; if (d < bd) { bd = d; best = b; } }
    a_tx[i] = BURROWS[best].x; a_tz[i] = BURROWS[best].z; a_stateTime[i] = 10;
    return;
  }
  let dx = px - fx, dz = pz - fz, d = Math.sqrt(dx * dx + dz * dz);
  if (d < 0.05) { const a = _rand() * TWO_PI; dx = Math.sin(a); dz = Math.cos(a); d = 1; }
  const dist = (7 + _rand() * 3) * FLEE_D[s];
  let x = px + dx / d * dist, z = pz + dz / d * dist;
  // if blocked by a fence, slide sideways instead of piling up on it
  const m = RAD[s] + 0.4;
  if (x < PX0[s] + m || x > PX1[s] - m) { z = pz + (dz >= 0 ? 1 : -1) * dist; x = px; }
  if (z < PZ0[s] + m || z > PZ1[s] - m) { x = px + (dx >= 0 ? 1 : -1) * dist; z = pz; }
  setTarget(i, x, z);
}
function findLeader(i, r) {
  const s = a_species[i];
  const c = queryHash(hash, a_px, a_pz, a_px[i], a_pz[i], r, _nb2, 16);
  for (let k = 0; k < c; k++) {
    const j = _nb2[k];
    if (j < i && a_species[j] === s && !(a_flags[j] & AFlag.HELD)) { a_leader[i] = j; return; }
  }
  a_leader[i] = -1;
}
function leaderOk(i) {
  const L = a_leader[i];
  if (L < 0) return false;
  if (L >= i || L >= _n || a_species[L] !== a_species[i]) { a_leader[i] = -1; return false; }
  return true;
}
function startFlock(i) {
  const s = a_species[i], px = a_px[i], pz = a_pz[i];
  const c = queryHash(hash, a_px, a_pz, px, pz, 8, _nb2, 16);
  let sx = 0, sz = 0, w = 0;
  for (let k = 0; k < c; k++) { const j = _nb2[k]; if (j !== i && a_species[j] === s) { sx += a_px[j]; sz += a_pz[j]; w++; } }
  if (leaderOk(i)) { const L = a_leader[i]; sx += a_px[L] * 2; sz += a_pz[L] * 2; w += 2; }
  enter(i, A.FLOCK);
  if (w > 0) setTarget(i, sx / w + (_rand() - 0.5) * 2, sz / w + (_rand() - 0.5) * 2);
  else wanderTarget(i);
}
function spawnManure(p, x, z) {
  if (_W.pen_manure[p] < MANURE_CAP) _spawn(_W, ItemKind.MANURE, x, p === SP.GOAT ? terrainHeight(x, z) : 0, z, p);
}

function enter(i, st) {
  const r = _rand();
  a_state[i] = st; a_animT[i] = 0; nearT[i] = 0;
  let d;
  switch (st) {
    case A.IDLE: d = 1.5 + r * 3.5; break;
    case A.PECK: d = 2 + r * 4; break;
    case A.SCRATCH: d = 1.5 + r * 2; break;
    case A.PREEN: d = 3 + r * 4; break;
    case A.EAT: d = Math.max(1.5, a_hunger[i] / EAT_RATE + 0.3); break;
    case A.DRINK: d = Math.max(1.5, a_thirst[i] / EAT_RATE + 0.3); break;
    case A.REST: d = 8 + r * 17; break;
    case A.SLEEP: d = _night ? 150 + r * 150 : 3 + r * 8; break;
    case A.FREEZE: d = 2 + r * 3; break;
    case A.LAY: d = 4 + r * 4; break;
    case A.DUSTBATH: d = 6 + r * 6; break;
    case A.WALLOW: d = 15 + r * 45; break;
    case A.DISPLAY: d = 6 + r * 6; wanderTarget(i); break;
    case A.ROLL: d = 3 + r * 2; break;
    case A.DUNG: d = 3; break;
    case A.CLIMB: d = 5 + r * 10; break;
    case A.BUTT: d = 3 + r * 3; break;
    case A.GRAZE: d = 6 + r * 10; creepTarget(i); break;
    case A.ROOT: d = 5 + r * 8; creepTarget(i); break;
    case A.WANDER: d = 60; wanderTarget(i); break;
    case A.HOP: {
      d = 0.5 + r; const a = _rand() * TWO_PI; setTarget(i, a_px[i] + Math.sin(a) * 3, a_pz[i] + Math.cos(a) * 3); break;
    }
    case A.SWIM: d = 15 + r * 45; pondTarget(i); break;
    case A.FLOCK: d = 3 + r * 3; break;
    case A.TROT: d = 10 + r * 10; break;
    case A.FLEE: d = 2 + r * 1.5; break;
    case A.SICK: d = 1e9; break;
    default: d = 2;
  }
  a_stateTime[i] = d;
}

function startChoice(i, c) {
  const s = a_species[i];
  switch (c) {
    case A.DUSTBATH: gotoInCircle(i, BATH[s], 0.6, A.DUSTBATH); break;
    case A.WALLOW: gotoInCircle(i, WL[s], 0.7, A.WALLOW); break;
    case A.SWIM: gotoInCircle(i, SW[s], 0.75, A.SWIM); break;
    case A.ROLL: if (BATH_ROLL[s]) gotoInCircle(i, BATH[s], 0.7, A.ROLL); else enter(i, A.ROLL); break;
    case A.CLIMB: {
      const rk = ROCKS[(_rand() * ROCKS.length) | 0];
      gotoPoint(i, rk.x + (_rand() - 0.5), rk.z + (_rand() - 0.5), A.CLIMB); break;
    }
    case A.BUTT: {
      const px = a_px[i], pz = a_pz[i];
      const cnt = queryHash(hash, a_px, a_pz, px, pz, 3, _nb2, 16);
      for (let k = 0; k < cnt; k++) {
        const j = _nb2[k];
        if (j === i || a_species[j] !== s) continue;
        const sj = a_state[j];
        if (a_flags[j] & (AFlag.HELD | AFlag.SICK)) continue;
        if (sj !== A.IDLE && sj !== A.GRAZE && sj !== A.REST && sj !== A.WANDER) continue;
        enter(i, A.BUTT); a_leader[i] = j;
        enter(j, A.BUTT); a_leader[j] = i; a_stateTime[j] = a_stateTime[i];
        return;
      }
      enter(i, A.WANDER); break;
    }
    case A.TROT: startTrot(i); break;
    case A.FLOCK: startFlock(i); break;
    case A.DISPLAY:
      if (a_variant[i] & 1) enter(i, A.DISPLAY); else enter(i, A.IDLE); break;
    case A.DUNG: if (DUNGP[s]) gotoInCircle(i, DUNGP[s], 0.5, A.DUNG); else enter(i, A.DUNG); break;
    case BINKY:
      enter(i, A.HOP); a_stateTime[i] = 0.5 + _rand(); a_tx[i] = a_px[i]; a_tz[i] = a_pz[i]; break;
    case BROWSE:
      gotoFeatureEdge(i, GOAT_BROWSE[(_rand() * GOAT_BROWSE.length) | 0], A.GRAZE); break;
    case EATHAY:
      if (_W.pen_food[s] > 0.05) gotoFeatureEdge(i, PENS[s].feeder, A.EAT); else enter(i, A.GRAZE);
      break;
    case A.WANDER:
      enter(i, A.WANDER);
      if (FOLLOW[s] && _rand() < 0.7) {
        if (!leaderOk(i)) findLeader(i, 8);
        if (a_leader[i] >= 0) a_stateTime[i] = 6 + _rand() * 8;
      }
      break;
    default: enter(i, c);
  }
}

function layEgg(i) {
  const s = a_species[i];
  _spawn(_W, ItemKind.EGG, a_px[i] + (_rand() - 0.5) * 0.4, 0.06, a_pz[i] + (_rand() - 0.5) * 0.4, s);
  a_produce[i] = 0;
}

// called when a state ends (stateTime<=0) or a GOTO is abandoned
function decide(i) {
  const s = a_species[i], st = a_state[i], W = _W;
  // exit actions
  if (st === A.LAY) layEgg(i);
  else if (st === A.DUNG) spawnManure(s, a_px[i], a_pz[i]);
  else if (st === A.BUTT) a_leader[i] = -1;
  if (a_flags[i] & AFlag.SICK) { enter(i, A.SICK); return; }
  if (_night) {
    if (st === A.SLEEP) enter(i, A.SLEEP); else goSleep(i);
    return;
  }
  const hot = a_hunger[i] > NEED_THRESH && W.pen_food[s] > 0.05, thirsty = a_thirst[i] > NEED_THRESH && (W.pen_water[s] > 0.05 || DPOOL[s] !== null);
  if (hot || thirsty) {
    if (thirsty && (!hot || a_thirst[i] > a_hunger[i])) startDrink(i);
    else gotoFeatureEdge(i, PENS[s].feeder, A.EAT);
    return;
  }
  if (IS_LAYER[s] && a_produce[i] >= 1 && W.pen_eggs[s] < EGG_CAP) {
    const nest = PENS[s].nest;
    gotoPoint(i, nest.x + (_rand() - 0.5) * nest.w * 0.8, nest.z + (_rand() - 0.5) * nest.d * 0.6, A.LAY);
    return;
  }
  if (st === A.SCRATCH) { enter(i, A.PECK); return; }
  if (a_energy[i] < 0.2 && HAS_REST[s]) { enter(i, A.REST); return; }
  const ts = TS[s], tw = TW[s];
  let tot = TTOT[s];
  const bell = NOON[s] === 1 ? noonBell(W.hour) : 0, wBoost = 1 + 1.5 * bell;   // cool-down: SWIM / WALLOW weight x(1..2.5) peaking at 13:00
  if (bell > 0) tot += TWATER[s] * 1.5 * bell;
  let r = _rand() * tot, c = ts[ts.length - 1];
  for (let k = 0; k < ts.length; k++) {
    let w = tw[k];
    if (bell > 0 && (ts[k] === A.WALLOW || ts[k] === A.SWIM)) w *= wBoost;
    r -= w;
    if (r <= 0) { c = ts[k]; break; }
  }
  startChoice(i, c);
}

function blobClamp(s, st) {   // keeps swimmers / wallowers inside their blob (reads / writes _q[0],_q[1])
  clampToBlob(st === A.SWIM ? SW[s] : WL[s], _q[0], _q[1], RAD[s] + 0.1, _o);
  _q[0] = _o[0]; _q[1] = _o[1];
}
function heldStep(i) {   // held by a farmer: freeze in place and face the farmer
  const dt = _T[0], fh = a_heldBy[i];
  a_vx[i] = 0; a_vz[i] = 0; a_speed[i] = 0;
  if (fh >= 0 && fh < _W.farmerCount) {
    const tgt = Math.atan2(_W.f_px[fh] - a_px[i], _W.f_pz[fh] - a_pz[i]);
    let d = tgt - a_heading[i]; d -= TWO_PI * Math.round(d / TWO_PI);
    const mx = 8 * dt; a_heading[i] += d > mx ? mx : d < -mx ? -mx : d;
  }
}

// Heavy per-animal logic (needs, production, interrupts, state machine). Called once per animal every other tick, as its own function so
// the first execution of a rare branch (deopt) only recompiles this function, not the whole 10k-animal loop. Returns the new state.
function slowStep(i, s, st, fl, tick, night) {
  const dt = _T[0], dt2 = _T[1], rand = _rand, W = _W, n = _n, f_px = W.f_px, f_pz = W.f_pz;
    if (st === A.HELD) { enter(i, A.IDLE); st = A.IDLE; }
    if (fl & AFlag.SICK) { if (st !== A.SICK) { enter(i, A.SICK); st = A.SICK; } }
    else if (st === A.SICK) { enter(i, A.IDLE); a_stateTime[i] = 1; st = A.IDLE; }

    // ---- needs, energy, health
    let hunger = a_hunger[i] + dt2 * HUNGER_RATE, thirst = a_thirst[i] + dt2 * (THIRST_RATE * THIRST_MUL[s]);
    let energy = a_energy[i];
    if (st === A.REST || st === A.SLEEP) { energy += dt2 / 45; if (energy > 1) energy = 1; }
    else { energy -= dt2 / 900; if (energy < 0) energy = 0; }
    a_stateTime[i] -= dt2;

    // ---- continuous per-state effects (eaters/drinkers count 2: this animal is processed every other tick)
    if (st === A.EAT) {
      if (W.pen_food[s] > 0.001) { hunger -= EAT_RATE * dt2; tEat[s] += 2; if (hunger <= 0.02) { hunger = hunger < 0 ? 0 : hunger; a_stateTime[i] = 0; } }
      else a_stateTime[i] = 0;
    } else if (st === A.DRINK) {
      if (W.a_wdrink[i] === 1) { thirst -= EAT_RATE * dt2; if (thirst <= 0.02) { thirst = thirst < 0 ? 0 : thirst; a_stateTime[i] = 0; } }   // water body: infinite, does not drain the trough stock
      else if (W.pen_water[s] > 0.001) { thirst -= EAT_RATE * dt2; tDrink[s] += 2; if (thirst <= 0.02) { thirst = thirst < 0 ? 0 : thirst; a_stateTime[i] = 0; } }
      else a_stateTime[i] = 0;
    } else if (st === A.GRAZE && IS_HAY[s]) hunger -= GRAZE_RELIEF * dt2;
    if (hunger > 1) hunger = 1; else if (hunger < 0) hunger = 0;
    if (thirst > 1) thirst = 1; else if (thirst < 0) thirst = 0;
    a_hunger[i] = hunger; a_thirst[i] = thirst; a_energy[i] = energy;
    if (st !== A.SICK && a_health[i] < 1) { const h = a_health[i] + dt2 * 0.01; a_health[i] = h > 1 ? 1 : h; }

    // ---- production
    const pr = PROD_RATE[s];
    if (pr > 0 && st !== A.SICK) {
      let pv = a_produce[i] + dt2 * pr * invCnt[s];
      if (pv >= 1) { pv = 1; if (IS_MW[s]) { if (!(fl & AFlag.READY)) { fl |= AFlag.READY; a_flags[i] = fl; tReady[s]++; } } }
      else if (IS_MW[s] && (fl & AFlag.READY)) { fl &= ~AFlag.READY; a_flags[i] = fl; tReady[s]--; }
      a_produce[i] = pv;
    }

    // ---- interrupts
    if (st !== A.SICK) {
      const sc = scare[i];
      if (fleeCD[i] > 0) fleeCD[i] -= dt2;
      if (sc !== 0 && st !== A.FLEE && !(fl & AFlag.READY)) {
        if (sc === 1) { fleeFrom(i, sfx[i], sfz[i]); st = A.FLEE; }
        else if (st !== A.FREEZE) { enter(i, A.FREEZE); st = A.FREEZE; }
        else if (a_stateTime[i] < 1) a_stateTime[i] = 1;
      } else if (night && st !== A.SLEEP && st !== A.FLEE && st !== A.LAY && !(st === A.GOTO && a_next[i] === A.SLEEP) && rand() < dt2 * 0.1) {
        goSleep(i); st = A.GOTO;
      } else if (!night && st === A.SLEEP) {
        a_stateTime[i] -= dt2 * 20;
      } else if (((i + tick) & 3) === 0) {
        if (PANIC[s] === 1) {
          if (!(fl & AFlag.READY) && st !== A.FLEE && fleeCD[i] <= 0) {
            const c = queryHash(hash, a_px, a_pz, a_px[i], a_pz[i], 3, _nb, 8);
            for (let k = 0; k < c; k++) { const j = _nb[k]; if (j !== i && a_state[j] === A.FLEE) { fleeFrom(i, a_px[j], a_pz[j]); st = A.FLEE; break; } }
          }
        } else if (TROTS[s] === 1 && (st === A.IDLE || st === A.GRAZE || st === A.WANDER) && !night) {
          const c = queryHash(hash, a_px, a_pz, a_px[i], a_pz[i], 5, _nb, 8);
          for (let k = 0; k < c; k++) { const j = _nb[k]; if (j !== i && a_state[j] === A.TROT) { if (rand() < 0.5) { startTrot(i); st = A.TROT; } break; } }
        }
      }
      if (HERD[s] === 1 && (st === A.GRAZE || st === A.IDLE || st === A.REST || st === A.WANDER) && ((i + tick) & 7) === 2) {
        if (!leaderOk(i)) findLeader(i, 10);
        if (a_leader[i] >= 0) {
          const L = a_leader[i], dx = a_px[L] - a_px[i], dz = a_pz[L] - a_pz[i];
          if (dx * dx + dz * dz > 36) { startFlock(i); st = A.FLOCK; }
        }
      }
    }

    // ---- state transitions (arrival / expiry)
    {
      const px = a_px[i], pz = a_pz[i];
      const ex = a_tx[i] - px, ez = a_tz[i] - pz, d2 = ex * ex + ez * ez;
      switch (st) {
        case A.GOTO: {
          let tol = 0.4 + 0.5 * RAD[s];
          if (d2 < 36) {   // crowd at a trough/nest: the longer we loiter nearby, the wider the accepted ring (up to ~3 m)
            const jm = nearT[i] + dt2; nearT[i] = jm;
            tol += jm * 0.35 < 3 ? jm * 0.35 : 3;
          }
          if (d2 < tol * tol && (a_next[i] === A.SWIM ? inBlob(SW[s], px, pz, RAD[s] + 0.2) : a_next[i] === A.WALLOW ? inBlob(WL[s], px, pz, RAD[s] + 0.2) : true)) { enter(i, a_next[i]); st = a_state[i]; }
          else if (a_stateTime[i] <= 0) { decide(i); st = a_state[i]; }
          break;
        }
        case A.WANDER:
          if (FOLLOW[s] === 1 && a_leader[i] >= 0 && leaderOk(i)) {
            const L = a_leader[i], h = a_heading[L];
            a_tx[i] = a_px[L] - Math.sin(h) * 0.9; a_tz[i] = a_pz[L] - Math.cos(h) * 0.9;
            if (a_stateTime[i] <= 0) { a_leader[i] = -1; decide(i); st = a_state[i]; }
          } else if (d2 < 0.16 || a_stateTime[i] <= 0) { decide(i); st = a_state[i]; }
          break;
        case A.GRAZE: case A.ROOT:
          if (a_stateTime[i] <= 0) { decide(i); st = a_state[i]; }
          else if (d2 < 0.09) creepTarget(i);
          break;
        case A.FLEE:
          if (s === SP.RABBIT && d2 < 0.36) { enter(i, A.FREEZE); st = A.FREEZE; }
          else if (a_stateTime[i] <= 0 || d2 < 0.25) { decide(i); st = a_state[i]; }
          break;
        case A.TROT:
          if (a_stateTime[i] <= 0) { decide(i); st = a_state[i]; }
          else if (d2 < 2.25) { a_next[i] = (a_next[i] + 1) & 3; trotTarget(i); }
          break;
        case A.SWIM:
          if (a_stateTime[i] <= 0) { decide(i); st = a_state[i]; }
          else if (d2 < 0.25) pondTarget(i);
          break;
        case A.DISPLAY:
          if (a_stateTime[i] <= 0) { decide(i); st = a_state[i]; }
          else if (d2 < 0.25) wanderTarget(i);
          break;
        case A.FLOCK: case A.HOP:
          if (a_stateTime[i] <= 0 || (st === A.FLOCK && d2 < 0.25)) { decide(i); st = a_state[i]; }
          break;
        case A.BUTT: {
          const L = a_leader[i];
          if (L >= 0 && L < n && a_state[L] === A.BUTT) { a_tx[i] = a_px[L]; a_tz[i] = a_pz[L]; } else a_stateTime[i] = 0;
          if (a_stateTime[i] <= 0) { decide(i); st = a_state[i]; }
          break;
        }
        case A.SICK: break;
        default:
          if (a_stateTime[i] <= 0) { decide(i); st = a_state[i]; }
      }
    }
    // ---- jam rescue: wants to walk but has not got anywhere for STUCK_S (dead-end lane behind a shelter, queue, crowd; speed alone is no good, jostling moves it back and forth):
    //      flip the avoid side and wander towards the pen centre
    {
      const px = a_px[i], pz = a_pz[i];
      if ((WF[st] > 0 || RF[st] > 0) && st !== A.GRAZE && st !== A.ROOT && st !== A.HOP && st !== A.BUTT && (a_tx[i] - px) ** 2 + (a_tz[i] - pz) ** 2 > 9) {
        if ((px - stuckX[i]) ** 2 + (pz - stuckZ[i]) ** 2 > 0.36) { stuckX[i] = px; stuckZ[i] = pz; stuckT[i] = 0; }
        else if ((stuckT[i] += dt2) > STUCK_S) {
          stuckT[i] = 0; avoidO[i] = -avoidO[i]; avoidT[i] = 3;
          const P = PENS[s];
          enter(i, A.WANDER); a_stateTime[i] = 8 + rand() * 6;
          setTarget(i, P.cx + (rand() - 0.5) * 20, P.cz + (rand() - 0.5) * 24);
          st = A.WANDER;
        }
      } else { stuckT[i] = 0; stuckX[i] = px; stuckZ[i] = pz; }
    }
  return st;
}

// ------------------------------------------------------------------ water: vertical spring (a_wy)
// Waders: target = -min(depth * WADE_K, SINK_CAP * height * scale); buoyant: +FLOAT_LIFT once the water is deeper than 5 cm. Target evaluated on the slow parity and only
// for animals inside the blob's bounding circle; the critically damped spring (omega 6/s) runs every tick for animals that are not at rest at 0. Hard-clamped to the cap.
function waterStep(i, s, px, pz, slow, dt) {
  let tgt = wTgt[i];
  if (slow) {
    tgt = 0;
    const dx = px - WCX[s], dz = pz - WCZ[s];
    if (dx * dx + dz * dz < WR2[s]) {
      const d = depthAt(s, px, pz);
      if (d > 0) {
        if (BUOY[s] === 1) tgt = d >= 0.05 ? FLOAT_LIFT : d * (FLOAT_LIFT * 20);
        else { const cap = HALF_H[s] * a_scale[i]; let sk = d * WADE_K; if (sk > cap) sk = cap; tgt = -sk; }
      }
    }
    wTgt[i] = tgt;
  }
  const wy0 = a_wy[i]; let v = a_wvy[i];
  if (tgt === 0 && wy0 === 0 && v === 0) return;
  v += (WK * (tgt - wy0) - WC * v) * dt;
  let wy = wy0 + v * dt;
  const lo = BUOY[s] === 1 ? 0 : -HALF_H[s] * a_scale[i], hi = BUOY[s] === 1 ? FLOAT_LIFT : 0;
  if (wy < lo) { wy = lo; if (v < 0) v = 0; } else if (wy > hi) { wy = hi; if (v > 0) v = 0; }
  if (tgt === 0 && wy < 1e-4 && wy > -1e-4 && v < 1e-3 && v > -1e-3) { wy = 0; v = 0; }
  a_wy[i] = wy; a_wvy[i] = v;
}

// ------------------------------------------------------------------ main update
// One tick of every animal. The work is split so the per-animal loop can also run in parallel threads, each owning a set of
// species (= pens; animals never leave their pen): animalsStep runs the loop for the species in `mask` (null = all) and
// animalsEnd folds the per-species tallies into the pen aggregates (manure, sickness, food / water drain) on one thread.
export function updateAnimals(W, dt) {
  if (!W._an) initAn(W);
  animalsStep(W, dt, null);
  animalsEnd(W, dt);
}

// per-species tallies of the last animalsStep (parallel runs merge the other threads' species into these before animalsEnd)
export const animalTallies = { tCnt, tReady, tSick, tEat, tDrink };
// item spawns from the per-animal loop (eggs, manure) go through this; a parallel worker defers them to the coordinating thread
let _spawn = spawnItem;
export function setItemSpawner(fn) { _spawn = fn || spawnItem; }
export function initAnimalsState(W) { if (!W._an) initAn(W); }

export function animalsStep(W, dt, mask) {
  const n = W.animalCount;
  _W = W; _rand = W.rand; _n = n; _tick = W.tick; _night = isNight(W);
  a_px = W.a_px; a_py = W.a_py; a_pz = W.a_pz; a_vx = W.a_vx; a_vz = W.a_vz; a_heading = W.a_heading; a_speed = W.a_speed;
  a_tx = W.a_tx; a_tz = W.a_tz; a_stateTime = W.a_stateTime; a_animT = W.a_animT; a_gait = W.a_gait; a_scale = W.a_scale;
  a_hunger = W.a_hunger; a_thirst = W.a_thirst; a_energy = W.a_energy; a_produce = W.a_produce; a_health = W.a_health;
  a_species = W.a_species; a_state = W.a_state; a_next = W.a_next; a_flags = W.a_flags; a_variant = W.a_variant;
  a_leader = W.a_leader; a_heldBy = W.a_heldBy; a_seed = W.a_seed; hash = W.hash; a_wy = W.a_wy; a_wvy = W.a_wvy; a_wdrink = W.a_wdrink;
  const rand = _rand, tick = _tick, night = _night;
  const f_px = W.f_px, f_pz = W.f_pz;

  tCnt.fill(0); tReady.fill(0); tSick.fill(0); tEat.fill(0); tDrink.fill(0);
  for (let p = 0; p < NS; p++) invCnt[p] = 1 / Math.max(1, W.pen_count[p]);

  // --- farmer proximity pass: mark animals to be scared by walking farmers
  scare.fill(0, 0, n);
  for (let f = 0; f < W.farmerCount; f++) {
    const fs = W.f_state[f];
    if (fs !== 1 && fs !== 5) continue;       // FState.MOVE / WANDER only
    const p = W.f_pen[f];
    if (p < 0 || (mask !== null && mask[p] === 0)) continue;
    const fx = f_px[f], fz = f_pz[f], r = SCARE_R[p], fr2 = FREEZE_R2[p];
    const c = queryHash(hash, a_px, a_pz, fx, fz, r, _big, 512);
    for (let k = 0; k < c; k++) {
      const j = _big[k];
      if (a_species[j] !== p) continue;
      const dx = a_px[j] - fx, dz = a_pz[j] - fz;
      const lvl = (fr2 > 0 && dx * dx + dz * dz > fr2) ? 2 : 1;
      if (scare[j] === 0 || lvl < scare[j]) { scare[j] = lvl; sfx[j] = fx; sfz[j] = fz; }
    }
  }

  // Time slicing: every animal runs the cheap integration (movement, gait, heading, animT) each tick, but the heavy logic
  // (needs, production, interrupts, state machine, separation) only on its own parity ("slow" ticks, dt2 = 2*dt).
  const dt2 = dt * 2; _T[0] = dt; _T[1] = dt2;
  const hCS = hash.cellStart, hIt = hash.items, hDim = hash.dim, hLast = hDim - 1, hInv = 1 / hash.cell, hHalf = hash.half;
  for (let i = 0; i < n; i++) {
    const s = a_species[i];
    if (mask !== null && mask[s] === 0) continue;   // another thread's species
    let fl = a_flags[i];
    tCnt[s]++;
    if (fl & AFlag.READY) tReady[s]++;
    if (fl & AFlag.SICK) tSick[s]++;

    // ---- held by a farmer: freeze in place, face the farmer, leave everything else alone
    if (fl & AFlag.HELD) { heldStep(i); continue; }
    let st = a_state[i];
    const slow = ((i + tick) & 1) === 0;
    a_animT[i] += dt;

    if (slow) st = slowStep(i, s, st, fl, tick, night);

    // ---- movement (every tick)
    let px = a_px[i], pz = a_pz[i], vx = a_vx[i], vz = a_vz[i];
    const wf = WF[st], rf = RF[st];
    const stationary = wf === 0 && rf === 0;
    let moved = false;
    if (stationary && vx === 0 && vz === 0) {
      // early-out: resting / pecking / sleeping animals with no velocity do no integration at all
    } else {
      const sv = 0.88 + ((a_seed[i] >>> 3) & 15) * 0.016;
      let sp = (WALK[s] * wf + RUN[s] * rf) * sv;
      if (WADE[s] === 1) { const w = a_wy[i]; if (w < 0) sp *= 1 + 0.45 * w / (HALF_H[s] * a_scale[i]); }   // wading: up to -45% when sunk to the cap
      let dvx = 0, dvz = 0;
      if (sp > 0) {
        const ex = a_tx[i] - px, ez = a_tz[i] - pz, d2 = ex * ex + ez * ez;
        if (d2 > STOP2[st]) {
          const d = Math.sqrt(d2), slowD = sp * 0.5;
          const k = d < slowD ? d / slowD : 1;
          let ux = ex / d, uz = ez / d;
          if (slow) {   // obstacle steering is time-sliced like the rest of the heavy logic: computed on the animal's slow parity, the bent heading is reused on the tick in between
            if (avoidT[i] > 0) avoidT[i] -= dt2;
            const look = sp * 0.8 + RAD[s] + 0.5;
            let gi = ((px - PX0[s]) * 0.5) | 0, gj = ((pz - PZ0[s]) * 0.5) | 0;
            if (gi < 0) gi = 0; else if (gi >= OG_W) gi = OG_W - 1; if (gj < 0) gj = 0; else if (gj >= OG_H) gj = OG_H - 1;
            if (OBG[s * OG_N + gj * OG_W + gi] * 0.25 <= look + 0.4 && steer(i, s, px, pz, ux, uz, d, RAD[s], look)) { steerX[i] = _sd[0]; steerZ[i] = _sd[1]; steerOn[i] = 1; } else steerOn[i] = 0;
          }
          if (steerOn[i] === 1) { ux = steerX[i]; uz = steerZ[i]; }
          dvx = ux * sp * k; dvz = uz * sp * k;
        }
      }
      const ak = Math.min(1, dt * (rf > 0 ? 10 : 7));
      vx += (dvx - vx) * ak; vz += (dvz - vz) * ak;
      if (sp === 0 && vx * vx + vz * vz < 1e-4) { vx = 0; vz = 0; }
      moved = vx * vx + vz * vz > 1e-6;
      if (moved) { px += vx * dt; pz += vz * dt; }
      a_vx[i] = vx; a_vz[i] = vz;
    }
    const px0 = a_px[i], pz0 = a_pz[i];
    // separation: moving animals every other tick (their slow parity), stationary ones only every 8th tick (resolves spawn overlaps)
    if ((moved ? slow : ((i + tick) & 7) === 0) && st !== A.SICK) {
      const rr = RAD[s] * 2, minD2 = rr * rr;
      let cx0 = ((px - rr + hHalf) * hInv) | 0, cx1 = ((px + rr + hHalf) * hInv) | 0, cz0 = ((pz - rr + hHalf) * hInv) | 0, cz1 = ((pz + rr + hHalf) * hInv) | 0;
      if (cx0 < 0) cx0 = 0; if (cz0 < 0) cz0 = 0; if (cx1 > hLast) cx1 = hLast; if (cz1 > hLast) cz1 = hLast;
      let sx = 0, sz = 0, cnt = 0;
      sepLoop:
      for (let cz = cz0; cz <= cz1; cz++) {
        const row = cz * hDim;
        for (let cx = cx0; cx <= cx1; cx++) {
          const e = hCS[row + cx + 1];
          for (let k = hCS[row + cx]; k < e; k++) {
            const j = hIt[k];
            if (j === i) continue;
            const dx = px - a_px[j], dz = pz - a_pz[j], q = dx * dx + dz * dz;
            if (q < minD2) {
              if (q > 1e-8) { const d = Math.sqrt(q), push = rr - d; sx += dx / d * push; sz += dz / d * push; }
              else sx += (i > j ? 0.05 : -0.05);
              if (++cnt >= 6) break sepLoop;
            }
          }
        }
      }
      if (cnt > 0) { px += sx * 0.5; pz += sz * 0.5; moved = true; }
    }
    if (moved) {
      _q[0] = px; _q[1] = pz; _q[2] = RAD[s];
      let ci = ((px - PX0[s]) * 0.5) | 0, cj = ((pz - PZ0[s]) * 0.5) | 0;   // open ground (nearest solid is farther than the body radius): nothing to push out of
      if (ci < 0) ci = 0; else if (ci >= OG_W) ci = OG_W - 1; if (cj < 0) cj = 0; else if (cj >= OG_H) cj = OG_H - 1;
      if (OBG[s * OG_N + cj * OG_W + ci] * 0.25 <= RAD[s] + 0.05) pushSolids(s);
      if (st === A.SWIM || st === A.WALLOW) blobClamp(s, st);
      px = _q[0]; pz = _q[1];
      const m = RAD[s] + 0.4;
      if (px < PX0[s] + m) px = PX0[s] + m; else if (px > PX1[s] - m) px = PX1[s] - m;
      if (pz < PZ0[s] + m) pz = PZ0[s] + m; else if (pz > PZ1[s] - m) pz = PZ1[s] - m;
      a_px[i] = px; a_pz[i] = pz;
    }
    // a_speed = actual (smoothed) displacement speed, so crowds jostling in place don't animate as running
    let spd = a_speed[i];
    if (moved || spd !== 0) {
      const ddx = px - px0, ddz = pz - pz0;
      spd = spd * 0.5 + 0.5 * Math.sqrt(ddx * ddx + ddz * ddz) / dt;
      if (spd < 0.01) spd = 0;
      a_speed[i] = spd;
    }

    // heading
    if (spd > 0.08 || st === A.EAT || st === A.DRINK || st === A.BUTT) {
      let tgtH = a_heading[i], turn = false;
      if (spd > 0.08) { tgtH = atan2f(a_vx[i], a_vz[i]); turn = true; }
      else if (st === A.EAT || st === A.DRINK) {
        const f = st === A.EAT ? PENS[s].feeder : a_wdrink[i] === 1 ? DPOOL[s] : PENS[s].water;
        tgtH = Math.atan2(f.x - px, f.z - pz); turn = true;
      } else {
        const L = a_leader[i];
        if (L >= 0 && L < n) { tgtH = Math.atan2(a_px[L] - px, a_pz[L] - pz); turn = true; }
      }
      if (turn) {
        let d = tgtH - a_heading[i]; if (d > Math.PI) d -= TWO_PI; else if (d < -Math.PI) d += TWO_PI;
        const mx = TURN[s] * dt;
        let h = a_heading[i] + (d > mx ? mx : d < -mx ? -mx : d);
        if (h > Math.PI) h -= TWO_PI; else if (h < -Math.PI) h += TWO_PI;
        a_heading[i] = h;
      }
    }

    // gait + height
    if (st === A.HOP) a_gait[i] += dt * 3;
    else if (spd > 0.02) a_gait[i] += spd * dt / (1.2 * HGT[s] * a_scale[i]);
    const ty = s === SP.GOAT ? terrainHeight(px, pz) : (st === A.SWIM ? WATER_Y - 0.15 : 0);
    const py = a_py[i];
    if (py !== ty) a_py[i] = py + (ty - py) * Math.min(1, dt * 10);
    if (WON[s] === 1 && (slow || a_wy[i] !== 0 || a_wvy[i] !== 0)) waterStep(i, s, px, pz, slow, dt);
  }
}

export function animalsEnd(W, dt) {
  const n = W.animalCount, an = W._an, rand = W.rand;
  _W = W; _rand = rand;
  // ---- pen aggregates + resource drain + manure + sickness
  for (let p = 0; p < NS; p++) {
    const cnt = tCnt[p];
    W.pen_count[p] = cnt; W.pen_ready[p] = tReady[p] < 0 ? 0 : tReady[p]; W.pen_sick[p] = tSick[p];
    W.pen_dirt[p] = Math.min(1, W.pen_manure[p] / 30);
    const frac = 1 / Math.max(1, cnt);
    if (tEat[p] > 0) { const v = W.pen_food[p] - dt * K_FOOD * DRAIN_MUL[p] * tEat[p] * frac; W.pen_food[p] = v < 0 ? 0 : v; }
    if (tDrink[p] > 0) { const v = W.pen_water[p] - dt * K_WATER * DRAIN_MUL[p] * tDrink[p] * frac; W.pen_water[p] = v < 0 ? 0 : v; }
    if (cnt === 0) continue;
    // manure: ~1 per MANURE_EVERY s at a random animal of this pen
    an.manT[p] += dt;
    if (an.manT[p] >= an.manNext[p]) {
      an.manT[p] = 0; an.manNext[p] = MANURE_EVERY * (0.6 + 0.8 * rand());
      for (let t = 0; t < 8; t++) {
        const j = (rand() * n) | 0;
        if (a_species[j] === p) { spawnManure(p, a_px[j], a_pz[j]); break; }
      }
    }
    // sickness: ~1 per SICK_EVERY s, faster when dirty
    an.sickT[p] += dt * (1 + 2 * Math.min(1, W.pen_manure[p] / 30));
    if (an.sickT[p] >= SICK_EVERY) {
      an.sickT[p] = 0;
      if (W.pen_sick[p] < SICK_CAP) {
        for (let t = 0; t < 8; t++) {
          const j = (rand() * n) | 0;
          if (a_species[j] === p && !(a_flags[j] & (AFlag.SICK | AFlag.HELD))) {
            a_flags[j] |= AFlag.SICK; a_health[j] = 0.3; enter(j, A.SICK); W.pen_sick[p]++;
            break;
          }
        }
      }
    }
  }
}
