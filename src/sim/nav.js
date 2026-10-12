// Farmer route builder. Fence-free corridors only, no DOM, no allocation.
//   ROAD   z in [-8,8] (road + the gate strips in front of the inner pens), |x| <= 125
//   LANE_N z in [-72,-64] service lane in front of the north outer pens (10-14);  LANE_S z in [64,72] (pens 15-19)
//   CORRIDOR x = +-124 : the only N-S connection (road <-> lanes <-> lanes), 2 m outside the end fences (x=+-122)
//   YARD W/E |x| > 125 : yards behind the hubs (x=+-130, z=0)
// Inside pens, every segment that crosses a solid circle (trees, feeders, fountain, rocks...) inflated by 0.6 m gets a detour waypoint
// round it (max 2 nested levels), so farmers walk round trunks instead of grinding along them.
// Route: [leave start pen via its gate] -> [start yard hub] -> [corridor: (c, z_here) (c, z_target)] -> [dest yard hub] -> [dest gateOut, gateIn] -> dest.
import { PENS, PEN_COUNT, HUBS, ROUTE_MAX, WORLD } from '../config.js';
import { penOf } from '../ecs/world.js';

const YARD_X = 125, COR = WORLD.corridorX;
const R_ROAD = 0, R_LN = 1, R_LS = 2, R_COR = 3;       // R_COR: standing in a corridor (a task can be claimed mid-walk)

function put(R, base, n, x, z) {
  if (n >= ROUTE_MAX) n = ROUTE_MAX - 1; // never overflow; last slot gets overwritten by dest
  R[base + n * 2] = x; R[base + n * 2 + 1] = z;
  return n + 1;
}
// per-pen solid circles inflated by DET_MARGIN (flat typed arrays, built once)
const DET_MARGIN = 0.6, DET_BULGE = 1.25;
const OB0 = new Int32Array(PEN_COUNT + 1), OBX = [], OBZ = [], OBR = [];
for (let p = 0; p < PEN_COUNT; p++) {
  OB0[p] = OBX.length;
  for (const f of PENS[p].solids) if (f.r > 0) { OBX.push(f.x); OBZ.push(f.z); OBR.push(f.r + DET_MARGIN); }
}
OB0[PEN_COUNT] = OBX.length;
const O_X = Float64Array.from(OBX), O_Z = Float64Array.from(OBZ), O_R = Float64Array.from(OBR);
// Appends the waypoints that take a straight walk A->B (both inside pen p) round the first blocking circle (B itself is not appended).
function detour(R, base, n, ax, az, bx, bz, p, depth, skip) {
  if (depth > 2 || p < 0) return n;
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  if (L2 < 0.25) return n;
  let bk = -1, bt = 2;
  for (let k = OB0[p]; k < OB0[p + 1]; k++) {
    if (k === skip) continue;
    const R2 = O_R[k], cx = O_X[k], cz = O_Z[k];
    if ((ax - cx) * (ax - cx) + (az - cz) * (az - cz) < R2 * R2 || (bx - cx) * (bx - cx) + (bz - cz) * (bz - cz) < R2 * R2) continue;   // an end sits at the obstacle (feeder, work spot): nothing to go round
    let t = ((cx - ax) * dx + (cz - az) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + dx * t - cx, qz = az + dz * t - cz;
    if (qx * qx + qz * qz < R2 * R2 && t < bt) { bt = t; bk = k; }
  }
  if (bk < 0) return n;
  const cx = O_X[bk], cz = O_Z[bk], Rb = O_R[bk] * DET_BULGE, P = PENS[p];
  let nx = ax + dx * bt - cx, nz = az + dz * bt - cz, nl = Math.sqrt(nx * nx + nz * nz);
  if (nl < 0.05) { const L = Math.sqrt(L2); nx = -dz / L; nz = dx / L; nl = 1; }
  nx /= nl; nz /= nl;
  let wx = cx + nx * Rb, wz = cz + nz * Rb;
  const m = 0.8;
  if (wx < P.x0 + m || wx > P.x1 - m || wz < P.z0 + m || wz > P.z1 - m) { wx = cx - nx * Rb; wz = cz - nz * Rb; }   // natural side leaves the pen: use the other one
  n = detour(R, base, n, ax, az, wx, wz, p, depth + 1, bk);
  n = put(R, base, n, wx, wz);
  return detour(R, base, n, wx, wz, bx, bz, p, depth + 1, bk);
}
function penRegion(p) { return p < 10 ? R_ROAD : p < 15 ? R_LN : R_LS; }
function pointRegion(x, z) {
  if (z >= -9 && z <= 9) return R_ROAD;
  if (Math.abs(Math.abs(x) - COR) < 1.6) return R_COR;
  return z < 0 ? R_LN : R_LS;
}
function yardSide(x) { return x > YARD_X ? 1 : x < -YARD_X ? -1 : 0; }

// Writes f_route/f_routeLen, resets f_routePos=0, sets f_tx/f_tz to first waypoint.
export function buildRoute(W, f, destX, destZ, destPen) {
  const R = W.f_route, base = f * ROUTE_MAX * 2;
  const sx = W.f_px[f], sz = W.f_pz[f];
  if (destPen === undefined) destPen = penOf(destX, destZ);
  const sp = penOf(sx, sz);
  let n = 0;
  const sameFence = sp >= 0 && destPen === sp;
  if (sp >= 0 && destPen !== sp) {                       // (1) leave current pen via its gate
    const P = PENS[sp];
    n = detour(R, base, n, sx, sz, P.gateIn.x, P.gateIn.z, sp, 0, -1);
    n = put(R, base, n, P.gateIn.x, P.gateIn.z);
    n = put(R, base, n, P.gateOut.x, P.gateOut.z);
  }
  if (!sameFence) {
    const yard = sp < 0 ? yardSide(sx) : 0;
    const destYard = destPen < 0 ? yardSide(destX) : 0;
    let cx = sx, cz = sz, rc;                            // where we are after (1) and the region it is in
    if (sp >= 0) { const G = PENS[sp].gateOut; cx = G.x; cz = G.z; rc = penRegion(sp); }
    else rc = pointRegion(sx, sz);
    if (yard !== 0 && destYard !== yard) {               // (2) leave yard via hub
      const H = yard < 0 ? HUBS.WEST : HUBS.EAST;
      n = put(R, base, n, H.x, H.z);
      cx = H.x; cz = H.z; rc = R_ROAD;
    }
    // target region + first waypoint inside it
    let rt, tx, tz;
    if (destPen >= 0) { const Q = PENS[destPen]; rt = penRegion(destPen); tx = Q.gateOut.x; tz = Q.gateOut.z; }
    else if (destYard !== 0) { rt = R_ROAD; tx = destYard * COR; tz = 0; }
    else { rt = pointRegion(destX, destZ); if (rt === R_COR) rt = destZ < 0 ? R_LN : R_LS; tx = destX; tz = destZ; }
    if (rc !== rt && !(yard !== 0 && destYard === yard)) {        // (3) change between road / lanes: through a corridor
      const side = rc === R_COR ? (cx < 0 ? -1 : 1) : destYard !== 0 ? destYard : yard !== 0 ? yard : (cx + tx < 0 ? -1 : 1);
      const c = side * COR;
      if (Math.abs(cx - c) > 0.5) n = put(R, base, n, c, cz);
      n = put(R, base, n, c, tz);
    }
    if (destPen < 0 && destYard !== 0 && destYard !== yard) {      // (4) enter destination yard via its hub
      const H = destYard < 0 ? HUBS.WEST : HUBS.EAST;
      n = put(R, base, n, H.x, H.z);
    }
    if (destPen >= 0) {                                  // (5) enter destination pen via its gate
      const Q = PENS[destPen];
      n = put(R, base, n, Q.gateOut.x, Q.gateOut.z);
      n = put(R, base, n, Q.gateIn.x, Q.gateIn.z);
      n = detour(R, base, n, Q.gateIn.x, Q.gateIn.z, destX, destZ, destPen, 0, -1);
    }
  } else if (sp >= 0) n = detour(R, base, n, sx, sz, destX, destZ, sp, 0, -1);
  n = put(R, base, n, destX, destZ);                      // (6)
  W.f_routeLen[f] = n; W.f_routePos[f] = 0;
  W.f_tx[f] = R[base]; W.f_tz[f] = R[base + 1];
  return n;
}
