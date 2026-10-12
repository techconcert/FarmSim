// Stylised terrain builders for the environment (WP5): painted flat-colour ground with hard-edged organic patches,
// smooth cartoon hills, plump outlined boulders / trees / tufts, gravel lanes. Pure JS, no GL/DOM.
// Everything that is ground-level paint is a flat +Y polygon at a tiny y offset (layered, painter style); all offsets stay < 0.04
// so the animals' blob shadows (y = 0.04) are never hidden.
import { ell, lathe, smoothen, merge } from './lowpoly.js';
import { PENS, BUILDINGS, FeatureKind as K, WORLD, blobOutline } from '../config.js';
import { mulberry32, hash01 } from '../ecs/rng.js';

export const LANES_X = [-130, 130];
export const LANE_HW = 2.5, LANE_Z = 178, LANE_FADE_Z = 300;
export const APRONS = [{ x0: 127, x1: 140, z0: -7, z1: 7 }, { x0: 127, x1: 142, z0: 16, z1: 30 }, { x0: -140, x1: -127, z0: -7, z1: 7 }];

export const rgb = h => [(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255];
const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export function mixHex(a, b, t) {
  const ar = a >> 16 & 255, ag = a >> 8 & 255, ab = a & 255, br = b >> 16 & 255, bg = b >> 8 & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}
export function vnoise(x, z, seed) {
  const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const h = (i, j) => hash01(Math.imul(j, 0x27d4eb2d) ^ Math.imul(seed, 0x165667b1), i);
  const a = h(xi, zi), b = h(xi + 1, zi), c = h(xi, zi + 1), d = h(xi + 1, zi + 1);
  const t = a + (b - a) * sx, u = c + (d - c) * sx;
  return t + (u - t) * sz;
}
// two rotated octaves: rounder contours than plain value noise
export function fbm(x, z, seed) {
  const a = vnoise(x * 0.9 + z * 0.43, z * 0.9 - x * 0.43, seed), b = vnoise(x * 2.1 - z * 1.1 + 17.3, z * 2.1 + x * 1.1 - 5.1, seed + 1);
  return a * 0.7 + b * 0.3;
}

// ------------------------------------------------------------------ flat polygon collector (+Y normals)
export class GB {
  constructor() { this.p = []; this.c = []; }
  tri(ax, az, bx, bz, cx, cz, y, k) {
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    if (Math.abs(ny) < 1e-9) return;
    if (ny < 0) { const tx = bx, tz = bz; bx = cx; bz = cz; cx = tx; cz = tz; }
    this.p.push(ax, y, az, bx, y, bz, cx, y, cz);
    for (let i = 0; i < 3; i++) this.c.push(k[0], k[1], k[2]);
  }
  quad(x0, z0, x1, z1, y, k) { this.tri(x0, z0, x1, z0, x1, z1, y, k); this.tri(x0, z0, x1, z1, x0, z1, y, k); }
  // star-shaped polygon about its centroid (flat array x,z,x,z...)
  poly(pts, y, hex) {
    const k = rgb(hex), n = pts.length / 2;
    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += pts[i * 2]; cz += pts[i * 2 + 1]; }
    cx /= n; cz /= n;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; this.tri(cx, cz, pts[i * 2], pts[i * 2 + 1], pts[j * 2], pts[j * 2 + 1], y, k); }
  }
  // polygon fan about a given centre (pond / mud: outline is star-shaped about the feature centre)
  fan(pts, cx, cz, y, hex) {
    const k = rgb(hex), n = pts.length / 2;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; this.tri(cx, cz, pts[i * 2], pts[i * 2 + 1], pts[j * 2], pts[j * 2 + 1], y, k); }
  }
  // marching squares: fills { f(x,z) > thr } on the grid [X0,X1]x[Z0,Z1] with cell size cs; skip(cx,cz) drops whole cells
  contour(f, thr, X0, Z0, X1, Z1, cs, y, hex, skip) {
    const k = rgb(hex), nx = Math.round((X1 - X0) / cs), nz = Math.round((Z1 - Z0) / cs);
    let prev = new Float32Array(nx + 1), cur = new Float32Array(nx + 1);
    for (let i = 0; i <= nx; i++) prev[i] = f(X0 + i * cs, Z0);
    const px = [], pz = [], maxRun = Math.max(1, Math.round((cs >= 8 ? 48 : 24) / cs));   // vertex fog: keep quads small enough for the per-vertex distance fog to interpolate well
    for (let j = 0; j < nz; j++) {
      const z0 = Z0 + j * cs, z1 = z0 + cs;
      for (let i = 0; i <= nx; i++) cur[i] = f(X0 + i * cs, z1);
      let run = -1;
      for (let i = 0; i < nx; i++) {
        const x0 = X0 + i * cs, x1 = x0 + cs;
        const va = prev[i], vb = prev[i + 1], vc = cur[i + 1], vd = cur[i];
        const a = va > thr, b = vb > thr, c = vc > thr, d = vd > thr;
        const n = (a ? 1 : 0) + (b ? 1 : 0) + (c ? 1 : 0) + (d ? 1 : 0);
        const skipped = skip && skip(x0 + cs / 2, z0 + cs / 2);
        const full = n === 4 && !skipped;
        if (full) { if (run < 0) run = i; else if (i - run >= maxRun) { this.quad(X0 + run * cs, z0, x0, z1, y, k); run = i; } continue; }
        if (run >= 0) { this.quad(X0 + run * cs, z0, x0, z1, y, k); run = -1; }
        if (n === 0 || skipped) continue;
        px.length = 0; pz.length = 0;
        if (a) { px.push(x0); pz.push(z0); }
        if (a !== b) { const t = (thr - va) / (vb - va); px.push(x0 + t * cs); pz.push(z0); }
        if (b) { px.push(x1); pz.push(z0); }
        if (b !== c) { const t = (thr - vb) / (vc - vb); px.push(x1); pz.push(z0 + t * cs); }
        if (c) { px.push(x1); pz.push(z1); }
        if (c !== d) { const t = (thr - vc) / (vd - vc); px.push(x1 - t * cs); pz.push(z1); }
        if (d) { px.push(x0); pz.push(z1); }
        if (d !== a) { const t = (thr - vd) / (va - vd); px.push(x0); pz.push(z1 - t * cs); }
        const m = px.length;
        let cx = 0, cz = 0;
        for (let q = 0; q < m; q++) { cx += px[q]; cz += pz[q]; }
        cx /= m; cz /= m;
        for (let q = 0; q < m; q++) { const r = (q + 1) % m; this.tri(cx, cz, px[q], pz[q], px[r], pz[r], y, k); }
      }
      if (run >= 0) { this.quad(X0 + run * cs, z0, X1, z1, y, k); }
      const t = prev; prev = cur; cur = t;
    }
  }
  geo() { const n = this.p.length / 3, nrm = new Float32Array(this.p.length); for (let i = 0; i < n; i++) nrm[i * 3 + 1] = 1; return { pos: new Float32Array(this.p), nrm, col: new Float32Array(this.c), count: n }; }
}

// signed-field shapes (value > 0 inside, ~metres from the edge) so big painted areas go through marching squares on small cells
// (small triangles z-fight far less than long fans, and run merging keeps the triangle count low)
export const rrIn = (x, z, cx, cz, hx, hz, r) => { const qx = Math.abs(x - cx) - hx + r, qz = Math.abs(z - cz) - hz + r; return -(Math.min(Math.max(qx, qz), 0) + Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) - r); };
export const ellIn = (x, z, cx, cz, rx, rz, rot = 0) => { const dx = x - cx, dz = z - cz, c = Math.cos(rot), s = Math.sin(rot), u = dx * c + dz * s, v = -dx * s + dz * c; return Math.min(rx, rz) * (1 - Math.hypot(u / rx, v / rz)); };
const wobF = (x, z, seed, amp) => (fbm(x / 7, z / 7, seed) - 0.5) * 2 * amp;
export function paint(gb, f, thr, x0, z0, x1, z1, y, hex, cs = 1.5) {
  x0 = Math.floor(x0 / cs) * cs; z0 = Math.floor(z0 / cs) * cs; x1 = Math.ceil(x1 / cs) * cs; z1 = Math.ceil(z1 / cs) * cs;
  gb.contour(f, thr, x0, z0, x1, z1, cs, y, hex, null);
}

// ------------------------------------------------------------------ shape helpers (flat arrays of x,z)
export function wobble(pts, seed, amp, freq = 0.35) {
  const n = pts.length / 2;
  let cx = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += pts[i * 2]; cz += pts[i * 2 + 1]; }
  cx /= n; cz /= n;
  const out = new Array(pts.length);
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], z = pts[i * 2 + 1], dx = x - cx, dz = z - cz, l = Math.hypot(dx, dz) || 1;
    const w = (vnoise(x * freq, z * freq, seed) - 0.5) * 2 * amp;
    out[i * 2] = x + dx / l * w; out[i * 2 + 1] = z + dz / l * w;
  }
  return out;
}
export function roundRect(x0, z0, x1, z1, rad, seg = 6, step = 3) {
  const P = [];
  const arc = (cx, cz, a0) => { for (let k = 0; k <= seg; k++) { const a = a0 + Math.PI / 2 * k / seg; P.push(cx + Math.cos(a) * rad, cz + Math.sin(a) * rad); } };
  const edge = (xa, za, xb, zb) => { const L = Math.hypot(xb - xa, zb - za), n = Math.max(1, Math.round(L / step)); for (let i = 1; i < n; i++) P.push(xa + (xb - xa) * i / n, za + (zb - za) * i / n); };
  arc(x1 - rad, z1 - rad, 0); edge(x1 - rad, z1, x0 + rad, z1);
  arc(x0 + rad, z1 - rad, Math.PI / 2); edge(x0, z1 - rad, x0, z0 + rad);
  arc(x0 + rad, z0 + rad, Math.PI); edge(x0 + rad, z0, x1 - rad, z0);
  arc(x1 - rad, z0 + rad, Math.PI * 1.5); edge(x1, z0 + rad, x1, z1 - rad);
  return P;
}
export function blobPoly(cx, cz, rx, rz, seed, n = 18, amp = 0.12, rot = 0) {
  const P = [], c = Math.cos(rot), s = Math.sin(rot);
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2, w = 1 + (hash01(seed, i) - 0.5) * 2 * amp * 0.5 + amp * 0.5 * Math.sin(a * 3 + seed) ;
    const u = Math.cos(a) * rx * w, v = Math.sin(a) * rz * w;
    P.push(cx + u * c - v * s, cz + u * s + v * c);
  }
  return P;
}
export function capsulePts(x0, z0, x1, z1, hw, n = 6) {
  const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz) || 1, ux = dx / L, uz = dz / L, px = -uz, pz = ux, a0 = Math.atan2(pz, px), P = [];
  for (let k = 0; k <= n; k++) { const a = a0 - Math.PI * k / n; P.push(x1 + Math.cos(a) * hw, z1 + Math.sin(a) * hw); }
  for (let k = 0; k <= n; k++) { const a = a0 - Math.PI - Math.PI * k / n; P.push(x0 + Math.cos(a) * hw, z0 + Math.sin(a) * hw); }
  return P;
}
// strip along x (or z when `alongZ`) with a wobbling centre line / half width; segments of `step`
export function ribbon(gb, a0, a1, cFn, hwFn, y, hex, alongZ = false, step = 2) {
  const k = rgb(hex), n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / step));
  let pa = a0, pc = cFn(pa), ph = hwFn(pa);
  for (let i = 1; i <= n; i++) {
    const a = a0 + (a1 - a0) * i / n, c = cFn(a), h = hwFn(a);
    if (h > 0.01 || ph > 0.01) {
      if (alongZ) { gb.tri(pc - ph, pa, pc + ph, pa, c + h, a, y, k); gb.tri(pc - ph, pa, c + h, a, c - h, a, y, k); }
      else { gb.tri(pa, pc - ph, pa, pc + ph, a, c + h, y, k); gb.tri(pa, pc - ph, a, c + h, a, c - h, y, k); }
    }
    pa = a; pc = c; ph = h;
  }
}

// ------------------------------------------------------------------ palettes (muted, natural)
const MEADOW = { base: 0x679b4a, l1: 0x76ab50, l2: 0x86b95a, dk: 0x588d44, yl: 0x93b45a };
// pens: base floor / light patch / lighter patch / dark patch, coarse patch scale
const PENPAL = [
  { base: 0xc2a46c, l1: 0xcdb27a, l2: 0xd8c08c, dk: 0xa98652, sc: 9, rim: 0x8c6c40 },    // chicken: scratched dirt
  { base: 0x5e964a, l1: 0x6aa452, l2: 0x78b25a, dk: 0x538a44, sc: 14, rim: 0x437236 },     // duck: lush
  { base: 0x8fa458, l1: 0x9db061, l2: 0xaabb6c, dk: 0x80964f, sc: 14, rim: 0x697c40 },     // turkey
  { base: 0x66a050, l1: 0x74ae58, l2: 0x84bc62, dk: 0x588f45, sc: 13, rim: 0x457838 },     // rabbit
  { base: 0x9a9a80, l1: 0xa9a98d, l2: 0xb8b69c, dk: 0x86925c, sc: 10, rim: 0x6e6e58 },     // goat: rocky scrub with olive patches
  { base: 0x6fa056, l1: 0x7cae5d, l2: 0x8bbc68, dk: 0x619548, sc: 14, rim: 0x4a7a3a },     // sheep
  { base: 0x9c7650, l1: 0xa98259, l2: 0xb48e63, dk: 0x7e5e3c, sc: 8, rim: 0x654a2e },      // pig: churned dirt
  { base: 0x6aa14f, l1: 0x78af57, l2: 0x88bd62, dk: 0x5c9645, sc: 14, rim: 0x477838 },     // cow
  { base: 0x7fa653, l1: 0x8db45b, l2: 0x9cc366, dk: 0x729a4c, sc: 14, rim: 0x57783a },     // horse
  { base: 0xaab165, l1: 0xb7bc72, l2: 0xc4c680, dk: 0x9b9e58, sc: 11, rim: 0x7c7e48 },     // llama: dry
];
// pens 10-19: floor palette derived from PENS[p].ground (config) so the ground tint follows the sim data; sc = patch scale
const PEN_SC = [9, 14, 14, 13, 10, 14, 8, 14, 14, 11, 7, 12, 10, 8, 9, 11, 7, 18, 9, 7];
function penPal(P) {
  if (P.id < 10) return PENPAL[P.id];
  const g = P.ground;
  return { base: g.base, l1: g.light, l2: mixHex(g.light, 0xffffff, 0.2), dk: g.dark, sc: PEN_SC[P.id], rim: mixHex(g.dark, 0x000000, 0.3) };
}
const ROAD_C = { rim: 0xa88a60, body: 0xc9aa7c, mid: 0xd4b98d, rut: 0xb8996c, spot: 0xd9c096 };
const GRAV = { rim: 0x978b72, body: 0xb8ab8e, mid: 0xc6baa0, rut: 0xa59a80, spot: 0xcfc4aa };
const YARD = { rim: 0xa38b64, body: 0xc4ad82, spot: 0xcfba90, dark: 0xb39c72 };
const PATH_C = { rim: 0xa88f64, body: 0xd0b486 };

// ------------------------------------------------------------------ geometry predicates shared with the other builders
export function penAt(x, z, n = PENS.length) {
  for (let p = 0; p < n; p++) { const P = PENS[p]; if (x > P.x0 && x < P.x1 && z > P.z0 && z < P.z1) return p; }
  return -1;
}
// the original 10-pen predicates (inner rows 0-9); the first scatter pass keeps using them verbatim so pens 0-9 and their surroundings
// are bit-identical to the 10-pen world; the new outer rows are then carved out by inNewZone()
export const penAtOld = (x, z) => penAt(x, z, 10);
// true where scatter (grass/rocks/trees) must stay out: road + curb, lanes, aprons, yards, gate paths
export function reserved(x, z, m = 0, nPens = PENS.length) {
  const ax = Math.abs(x), az = Math.abs(z);
  if (az < 6.6 + m && ax < 153) return true;
  for (const lx of LANES_X) if (Math.abs(x - lx) < LANE_HW + 1.5 + m && az < LANE_FADE_Z) return true;
  for (const a of APRONS) if (x > a.x0 - 2 - m && x < a.x1 + 2 + m && z > a.z0 - 2 - m && z < a.z1 + 2 + m) return true;
  if (ax > 124 && az < 62) return true;
  if (inTruckLane(x, z, 3 + m)) return true;
  for (let i = 0; i < nPens; i++) { const P = PENS[i]; if (Math.abs(x - P.cx) < 3.4 + m && (P.s < 0 ? (z < -4 && z > P.gateEdgeZ - 7) : (z > 4 && z < P.gateEdgeZ + 7))) return true; }
  return false;
}
// the part of the 20-pen world that did not exist in the 10-pen layout: outer pen rows + both east-west service lanes
export function inNewZone(x, z, m = 0) {
  const az = Math.abs(z);
  if (az > 64 - m && az < 72 + m && Math.abs(x) < 133) return true;
  if (az >= 72 && az < 128 + m && x > -122 - m && x < 122 + m) return true;     // outer pen rows incl. the gaps between them
  return false;
}
// truck service lane + bay (east edge): trees / props stay out
export const inTruckLane = (x, z, m = 0) => x > 122 - m && z > -34 - m && z < -6 + m;
// inside (or within m metres of) any pen rectangle
export const nearPen = (x, z, m = 0) => { for (let i = 0; i < PENS.length; i++) { const P = PENS[i]; if (x > P.x0 - m && x < P.x1 + m && z > P.z0 - m && z < P.z1 + m) return true; } return false; };

// ------------------------------------------------------------------ ground
export function buildGround(ctx, extraPaint) {
  const gb = new GB(), stones = [], pebbles = [];
  const M = MEADOW;
  // base planes: inner painted disc of the world + far horizon quad
  const grid = (a, b, st, y, hex, skipInner) => { const k = rgb(hex); for (let z = a; z < b; z += st) for (let x = a; x < b; x += st) { if (skipInner && x >= -skipInner && x < skipInner && z >= -skipInner && z < skipInner) continue; gb.quad(x, z, x + st, z + st, y, k); } };
  const GO = Math.round(Math.max(WORLD.x1, WORLD.z1) * 2.73 / 24) * 24;
  grid(-GO, GO, 24, 0, M.base);
  grid(-1500, 1500, 100, -0.25, mixHex(M.base, 0x6f9a5a, 0.4), GO);

  // ---- meadow patches: nested hard-edged contours of smooth noise (dark patches, light patches, lighter cores, sun-bleached spots)
  const f1 = (x, z) => fbm(x / 40, z / 40, 101), f2 = (x, z) => fbm(x / 28 + 9, z / 28 - 4, 202), fd = (x, z) => fbm(x / 34 - 3, z / 34 + 8, 303), fy = (x, z) => fbm(x / 50 + 40, z / 50 + 11, 404);
  const inPen = (cx, cz) => { for (const P of PENS) if (cx > P.x0 && cx < P.x1 && cz > P.z0 && cz < P.z1) return true; return false; };
  const skipIn = (cx, cz) => inPen(cx, cz) || (Math.abs(cz) < 4 && Math.abs(cx) < 152);
  const IN = Math.ceil(Math.max(WORLD.x1, WORLD.z1) / 8) * 8, CSI = 2.5;
  const layers = [[fd, 0.585, M.dk, 0.002], [f1, 0.545, M.l1, 0.004], [f1, 0.655, M.l2, 0.006], [fy, 0.665, M.yl, 0.007]];
  for (const [f, t, c, y] of layers) gb.contour(f, t, -IN, -IN, IN, IN, CSI, y, c, skipIn);
  // outer ring (cheap, coarse): four strips around the inner square
  const OUT = Math.round(IN * 2.73 / 16) * 16, CSO = 16;
  const strips = [[-OUT, -OUT, OUT, -IN], [-OUT, IN, OUT, OUT], [-OUT, -IN, -IN, IN], [IN, -IN, OUT, IN]];
  for (const [x0, z0, x1, z1] of strips) for (const [f, t, c, y] of layers) gb.contour(f, t, x0, z0, x1, z1, CSO, y, c, null);

  // ---- yards (dirt pads around the barn / storehouse / sheds): overlapping blobs, rims first then bodies
  const yardBlobs = [
    [-147, 0, 21, 17, 1], [-148, -44, 15, 14, 2], [-147, -19, 11, 10, 3], [-137, 15, 8, 8, 4],
    [148, 0, 21, 17, 5], [147, 24, 13, 11, 6], [146, -34, 13, 10, 7],
  ];
  for (const b of yardBlobs) gb.poly(blobPoly(b[0], b[1], b[2] + 0.9, b[3] + 0.9, b[4] * 3, 22, 0.1), 0.010, YARD.rim);
  for (const b of yardBlobs) gb.poly(blobPoly(b[0], b[1], b[2], b[3], b[4] * 3, 22, 0.1), 0.013, YARD.body);
  for (const b of yardBlobs) {
    gb.poly(blobPoly(b[0] + 3, b[1] - 2, b[2] * 0.45, b[3] * 0.4, b[4] * 5, 14, 0.2), 0.016, YARD.spot);
    gb.poly(blobPoly(b[0] - 5, b[1] + 4, b[2] * 0.3, b[3] * 0.28, b[4] * 7, 12, 0.2), 0.016, YARD.dark);
  }

  // ---- pens: rounded floor with a darker rim line, patch contours in the pen palette
  for (const P of PENS) {
    const pal = penPal(P);
    const outer = wobble(roundRect(P.x0 - 1.15, P.z0 - 1.15, P.x1 + 1.15, P.z1 + 1.15, 4.6), 50 + P.id, 0.12);
    const inner = wobble(roundRect(P.x0 - 0.75, P.z0 - 0.75, P.x1 + 0.75, P.z1 + 0.75, 4.0), 60 + P.id, 0.1);
    gb.poly(outer, 0.010, pal.rim);
    gb.poly(inner, 0.013, pal.base);
    const s = pal.sc, id = P.id;
    const g1 = (x, z) => fbm(x / s + id * 7.3, z / s - id * 3.1, 500 + id), g2 = (x, z) => fbm(x / (s * 0.8) - id * 2.2, z / (s * 0.8) + id * 5.5, 600 + id), gd = (x, z) => fbm(x / (s * 1.1) + id * 4.7, z / (s * 1.1) + 13, 700 + id);
    gb.contour(gd, 0.60, P.x0, P.z0, P.x1, P.z1, 2, 0.016, pal.dk, null);
    gb.contour(g1, 0.55, P.x0, P.z0, P.x1, P.z1, 2, 0.017, pal.l1, null);
    gb.contour(g2, 0.64, P.x0, P.z0, P.x1, P.z1, 2, 0.018, pal.l2, null);
    // trampled earth in front of the gate
    gb.poly(blobPoly(P.cx, P.gateEdgeZ + P.s * 3.5, 6.2, 4.4, 80 + id, 18, 0.12), 0.019, PATH_C.rim);
    gb.poly(blobPoly(P.cx, P.gateEdgeZ + P.s * 3.5, 5.7, 3.9, 80 + id, 18, 0.12), 0.021, PATH_C.body);
    // gate path: road edge -> gate -> a few metres inside
    const zA = P.outer ? (P.s < 0 ? -68 : 68) : (P.s < 0 ? -4.2 : 4.2), zB = P.gateEdgeZ + P.s * 5.5;
    gb.poly(wobble(capsulePts(P.cx, zA, P.cx, zB, 2.55), 90 + id, 0.12), 0.0215, PATH_C.rim);
    gb.poly(wobble(capsulePts(P.cx, zA, P.cx, zB, 2.15), 90 + id, 0.12), 0.0235, PATH_C.body);
    // horse pen: sand riding track (closed ring strip)
    if (id === 8) {
      const ring = roundRect(P.x0 + 6, P.z0 + 6, P.x1 - 6, P.z1 - 6, 7.5, 8, 2.5), n = ring.length / 2;
      const strip = (hw, y, hex) => {
        const kc = rgb(hex);
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n, ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
          const pi = (i + n - 1) % n, nx = bx - ring[pi * 2], nz = bz - ring[pi * 2 + 1], l1 = Math.hypot(nx, nz) || 1;
          const qj = (j + 1) % n, mx = ring[qj * 2] - ax, mz = ring[qj * 2 + 1] - az, l2 = Math.hypot(mx, mz) || 1;
          const ox0 = -nz / l1 * hw, oz0 = nx / l1 * hw, ox1 = -mz / l2 * hw, oz1 = mx / l2 * hw;
          gb.tri(ax - ox0, az - oz0, ax + ox0, az + oz0, bx + ox1, bz + oz1, y, kc); gb.tri(ax - ox0, az - oz0, bx + ox1, bz + oz1, bx - ox1, bz - oz1, y, kc);
        }
      };
      strip(1.75, 0.0195, 0xa98f5e); strip(1.4, 0.0225, 0xcfb27c);
    }
  }
  // door paths in the yards (lane -> door)
  const dpath = (x0, z0, x1, z1) => { gb.poly(capsulePts(x0, z0, x1, z1, 1.45), 0.017, PATH_C.rim); gb.poly(capsulePts(x0, z0, x1, z1, 1.1), 0.0185, PATH_C.body); };
  dpath(-128, -44, -137, -44); dpath(-128, 12, -136, 12); dpath(128, -34, 137, -34);

  // ---- main road: worn shoulder, tan body, lighter crown, wheel ruts, scuffed spots
  const RX0 = -148, RX1 = 148;
  const n01 = (x, s) => vnoise(x * 0.09, s * 3.7, s);
  ribbon(gb, RX0, RX1, x => 0.25 * (n01(x, 5) - 0.5), x => 4.75 + 0.45 * n01(x, 11), 0.014, ROAD_C.rim);
  ribbon(gb, RX0, RX1, () => 0, x => 4.0 + 0.3 * n01(x, 6), 0.018, ROAD_C.body);
  ribbon(gb, RX0, RX1, x => 0.3 * (n01(x, 7) - 0.5), x => 2.35 + 0.35 * n01(x, 8), 0.022, ROAD_C.mid);
  for (const sz of [-1.35, 1.35]) ribbon(gb, RX0 + 3, RX1 - 3, x => sz + 0.12 * (n01(x, 9 + sz) - 0.5), x => 0.42 + 0.1 * n01(x, 10), 0.026, ROAD_C.rut);
  { const r = mulberry32(81); for (let i = 0; i < 70; i++) { const x = RX0 + r() * (RX1 - RX0), z = (r() - 0.5) * 6.4; gb.poly(blobPoly(x, z, 1.4 + r() * 2.2, 0.5 + r() * 0.5, 100 + i, 10, 0.2), 0.0245, i % 3 ? ROAD_C.spot : ROAD_C.rut); } }
  // curb stones (outlined rocks): along both road edges, leaving gaps at gate paths and the lane crossings
  {
    const r = mulberry32(8123);
    for (const sz of [-1, 1]) for (let x = RX0 + 2; x < RX1 - 1; x += 2.4 + r() * 0.9) {
      if (PENS.some(P => Math.abs(x - P.cx) < 3.2)) continue;
      if (LANES_X.some(lx => Math.abs(x - lx) < 3.4)) continue;
      const z = sz * (4.45 + 0.35 * n01(x, 11)) + (r() - 0.5) * 0.25, s = 0.3 + r() * 0.16;
      stones.push({ x, z, rx: s * 1.45, ry: s * 0.85, rz: s * 1.0, yaw: (r() - 0.5) * 0.6, t: r() });
    }
    for (let i = 0; i < 190; i++) { const x = RX0 + r() * (RX1 - RX0), z = (r() - 0.5) * 7.2; pebbles.push({ x, z, s: 0.1 + r() * 0.13, t: r() }); }
  }

  // ---- service lanes (gravel): rim, body, lighter crown, two rut bands; tapering away past +-LANE_Z so they fade into the distance
  for (const lx of LANES_X) {
    const cF = z => lx + 0.12 * (vnoise(z * 0.07, lx * 0.1, 17) - 0.5), tap = z => { const a = Math.abs(z); return a <= LANE_Z ? 1 : Math.max(0.0, 1 - (a - LANE_Z) / (LANE_FADE_Z - LANE_Z)); };
    for (const [za, zb] of [[4.0, LANE_FADE_Z], [-4.0, -LANE_FADE_Z]]) {
      const lo = Math.min(za, zb), hi = Math.max(za, zb);
      const hw = (z, e) => (LANE_HW + e) * (0.18 + 0.82 * tap(z)) + 0.06 * (vnoise(z * 0.1, lx, 19) - 0.5);
      ribbon(gb, lo, hi, cF, z => hw(z, 0.45), 0.015, GRAV.rim, true, 3);
      ribbon(gb, lo, hi, cF, z => hw(z, 0.0), 0.019, GRAV.body, true, 3);
      ribbon(gb, lo, hi, cF, z => hw(z, -1.0) * 0.9, 0.023, GRAV.mid, true, 3);
      for (const o of [-1.05, 1.05]) ribbon(gb, lo, hi, z => cF(z) + o * tap(z), z => 0.34 * tap(z) + 0.02, 0.027, GRAV.rut, true, 3);
    }
    const r = mulberry32(900 + lx);
    for (let i = 0; i < 90; i++) { const z = (r() * 2 - 1) * LANE_Z; if (Math.abs(z) < 4.5) continue; gb.poly(blobPoly(lx + (r() - 0.5) * 3.4, z, 0.8 + r() * 1.4, 0.5 + r() * 0.8, 120 + i, 9, 0.2), 0.025, i % 2 ? GRAV.spot : GRAV.rut); }
    for (const sx of [-1, 1]) for (let z = -LANE_Z; z < LANE_Z; z += 6.5 + r() * 4) {
      if (Math.abs(z) < 6) continue;
      const s = 0.26 + r() * 0.16;
      stones.push({ x: lx + sx * (LANE_HW + 0.45 + r() * 0.3), z, rx: s * 1.3, ry: s * 0.8, rz: s, yaw: r() * 3, t: r() });
    }
    for (let i = 0; i < 120; i++) { const z = (r() * 2 - 1) * LANE_Z; if (Math.abs(z) < 4.5) continue; pebbles.push({ x: lx + (r() - 0.5) * 4.4, z, s: 0.09 + r() * 0.12, t: r() }); }
  }
  // ---- east-west service lanes (z = +-68, between the inner and outer pen rows): same gravel as the N-S lanes, joined to them by round pads
  for (const zc of [-68, 68]) {
    const k = zc < 0 ? 0 : 1, X0 = -134, X1 = 134;
    const cF = x => zc + 0.12 * (vnoise(x * 0.07, zc * 0.1, 21) - 0.5), edge = x => 1 - ss(124, 134, Math.abs(x)) * 0.35;
    const hw = (x, e) => (4.05 + e) * edge(x) + 0.06 * (vnoise(x * 0.1, zc, 23) - 0.5);
    ribbon(gb, X0, X1, cF, x => hw(x, 0.1), 0.015, GRAV.rim, false, 3);
    ribbon(gb, X0, X1, cF, x => hw(x, -0.5), 0.019, GRAV.body, false, 3);
    ribbon(gb, X0, X1, cF, x => hw(x, -1.8) * 0.9, 0.023, GRAV.mid, false, 3);
    for (const o of [-1.05, 1.05]) ribbon(gb, X0, X1, x => cF(x) + o, () => 0.34, 0.027, GRAV.rut, false, 3);
    for (const lx of LANES_X) {            // junction pads where the lane meets the N-S service lane
      gb.poly(blobPoly(lx, zc, 5.2, 5.0, 300 + k * 7 + (lx > 0 ? 1 : 0), 20, 0.1), 0.0152, GRAV.rim);
      gb.poly(blobPoly(lx, zc, 4.7, 4.5, 300 + k * 7 + (lx > 0 ? 1 : 0), 20, 0.1), 0.0192, GRAV.body);
      gb.poly(blobPoly(lx + 0.3, zc, 2.6, 2.5, 310 + k, 14, 0.14), 0.0232, GRAV.mid);
    }
    const r = mulberry32(950 + k);
    for (let i = 0; i < 110; i++) { const x = (r() * 2 - 1) * 128; gb.poly(blobPoly(x, zc + (r() - 0.5) * 6.4, 0.8 + r() * 1.4, 0.5 + r() * 0.8, 400 + k * 200 + i, 9, 0.2), 0.025, i % 2 ? GRAV.spot : GRAV.rut); }
    for (let x = -126; x < 126; x += 8 + r() * 5) {      // verge stones on the gravel edge, leaving the gate crossings clear
      if (PENS.some(P => Math.abs(x - P.cx) < 4.2)) continue;
      const sz = r() < 0.5 ? -1 : 1, s2 = 0.24 + r() * 0.16;
      stones.push({ x, z: zc + sz * (3.5 + r() * 0.3), rx: s2 * 1.3, ry: s2 * 0.8, rz: s2, yaw: r() * 3, t: r() });
    }
    for (let i = 0; i < 150; i++) { const x = (r() * 2 - 1) * 128; pebbles.push({ x, z: zc + (r() - 0.5) * 6.6, s: 0.09 + r() * 0.12, t: r() }); }
  }
  // aprons (gravel pads): rounded rect with rim, lighter patches
  for (const a of APRONS) {
    const sd = a.x0 * 3 + a.z0;
    gb.poly(wobble(roundRect(a.x0 - 0.5, a.z0 - 0.5, a.x1 + 0.5, a.z1 + 0.5, 2.6, 5, 2.5), sd, 0.1), 0.0155, GRAV.rim);
    gb.poly(wobble(roundRect(a.x0, a.z0, a.x1, a.z1, 2.4, 5, 2.5), sd, 0.1), 0.0195, GRAV.body);
    const cx = (a.x0 + a.x1) / 2, cz = (a.z0 + a.z1) / 2;
    gb.poly(blobPoly(cx + 0.5, cz, (a.x1 - a.x0) * 0.32, (a.z1 - a.z0) * 0.3, sd + 3, 14, 0.15), 0.0235, GRAV.mid);
    gb.poly(blobPoly(cx - 2, cz + 1.5, 1.8, 1.0, sd + 5, 10, 0.2), 0.0255, GRAV.rut);
    const r = mulberry32(sd + 77);
    for (let i = 0; i < 20; i++) pebbles.push({ x: a.x0 + 0.6 + r() * (a.x1 - a.x0 - 1.2), z: a.z0 + 0.6 + r() * (a.z1 - a.z0 - 1.2), s: 0.09 + r() * 0.12, t: r() });
  }

  // ---- pond / mud pit / dust baths: organic polygons from the sim's own blob outlines
  for (const P of PENS) for (const f of P.features) {
    if (P.id >= 10) continue;                                // pens 10-19: painted by envBiomes.paintBiomeGround
    if (f.kind === K.POND && f.blob) {
      const o = (s) => blobOutline(f, 44, s);
      gb.fan(o(1.17), f.x, f.z, 0.024, 0xd9c88e);          // sand
      gb.fan(o(1.075), f.x, f.z, 0.026, 0xc2ae74);         // wet sand
      gb.fan(o(1.03), f.x, f.z, 0.047, 0x2f6c8c);          // dark rim line
      gb.fan(o(1.0), f.x, f.z, 0.05, 0x72b4d6);            // shallows
      gb.fan(o(0.80), f.x, f.z, 0.056, 0x5aa0cc);
      gb.fan(o(0.56), f.x, f.z, 0.062, 0x4688ba);          // deep
      gb.fan(o(0.30), f.x, f.z, 0.068, 0x3c79ac);
      for (const [dx, dz, rx, rz, a] of [[-3.5, -1.5, 2.6, 0.45, 0.2], [4.2, 2.5, 1.9, 0.4, -0.3], [-1, 3.4, 1.5, 0.35, 0.5]])
        gb.poly(blobPoly(f.x + dx, f.z + dz, rx, rz, 140 + dx, 10, 0.1, a), 0.074, 0x9fd0e6);   // glints
    } else if (f.kind === K.MUD_PIT && f.blob) {
      const o = (s) => blobOutline(f, 40, s);
      gb.fan(o(1.2), f.x, f.z, 0.0245, 0x8c6c4a);          // lighter dried edge
      gb.fan(o(1.1), f.x, f.z, 0.0255, 0x7a5a3c);
      gb.fan(o(1.0), f.x, f.z, 0.0265, 0x58402c);          // mud body
      gb.fan(o(0.68), f.x, f.z, 0.0275, 0x4a3322);         // wet dark core
      for (const [dx, dz, rx, rz, a] of [[-2.8, -1.2, 2.1, 0.7, 0.3], [2.6, 1.6, 1.5, 0.55, -0.4], [0.2, -2.3, 1.2, 0.4, 0.1]])
        gb.poly(blobPoly(f.x + dx, f.z + dz, rx, rz, 160 + dz, 12, 0.14, a), 0.0295, 0x74563c);   // puddle sheen
    } else if (f.kind === K.DUST_BATH) {
      gb.poly(blobPoly(f.x, f.z, f.r + 0.7, f.r + 0.55, 170 + P.id, 16, 0.1), 0.0245, 0x8e7852);
      gb.poly(blobPoly(f.x, f.z, f.r + 0.2, f.r + 0.1, 170 + P.id, 16, 0.1), 0.0265, 0xb49d78);
      gb.poly(blobPoly(f.x - 0.4, f.z + 0.3, f.r * 0.5, f.r * 0.4, 175 + P.id, 12, 0.15), 0.0285, 0xc6b08a);
    }
  }
  if (extraPaint) extraPaint(gb, stones, pebbles);
  return { ground: gb.geo(), stones, pebbles };
}

// ------------------------------------------------------------------ hills: smooth rounded domes with hard colour bands, fading blue with distance
function dome(cx, cz, R, H, bands, rng, segs, ups) {
  const p1 = rng() * 6.28, p2 = rng() * 6.28, a1 = 0.14 + rng() * 0.1, a2 = 0.07 + rng() * 0.05;
  const rr = a => R * (1 + a1 * Math.sin(2 * a + p1) + a2 * Math.sin(3 * a + p2));
  const hgt = (u, a) => H * Math.pow(Math.max(0, 1 - u * u), 1.1) * (1 + 0.1 * Math.sin(a * 2 + p2));
  const rows = ups.length;
  const V = (k, j) => { const a = j / segs * Math.PI * 2, u = ups[k], r = rr(a) * u; return [cx + Math.cos(a) * r, k === rows - 1 ? -4 : hgt(u, a) - 0.5, cz + Math.sin(a) * r]; };
  const P = [], C = [];
  const push = (a, b, c, col) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    if ((uz * vx - ux * vz) < 0) { const t = b; b = c; c = t; }     // face up
    P.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) C.push(col[0], col[1], col[2]);
  };
  for (let k = 0; k < rows - 1; k++) {
    const col = bands[Math.min(bands.length - 1, k)];
    for (let j = 0; j < segs; j++) {
      const j2 = (j + 1) % segs, a = V(k, j), b = V(k, j2), c = V(k + 1, j2), d = V(k + 1, j);
      if (k === 0) push(a, c, d, col); else { push(a, b, c, col); push(a, c, d, col); }
    }
  }
  const n = P.length / 3, nrm = new Float32Array(n * 3);
  const g = { pos: new Float32Array(P), nrm, col: new Float32Array(C), count: n };
  // flat normals first, then smooth them
  for (let i = 0; i < n; i += 3) {
    const o = i * 3, ux = g.pos[o + 3] - g.pos[o], uy = g.pos[o + 4] - g.pos[o + 1], uz = g.pos[o + 5] - g.pos[o + 2], vx = g.pos[o + 6] - g.pos[o], vy = g.pos[o + 7] - g.pos[o + 1], vz = g.pos[o + 8] - g.pos[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
    for (let k = 0; k < 3; k++) { nrm[o + k * 3] = nx / l; nrm[o + k * 3 + 1] = ny / l; nrm[o + k * 3 + 2] = nz / l; }
  }
  return smoothen(g);
}
export function buildHills() {
  const rng = mulberry32(777), L = [], HS = Math.max(WORLD.x1, WORLD.z1) / 160;   // hills ring sits beyond the pen grid + margin, scaled to the world
  const G0 = [0x68a053, 0x78b25c], G1 = [0x5b9a5e, 0x6aa86a], B0 = [0x5c9170, 0x6aa081, 0x7fb090], B1 = [0x6f8fae, 0x7f9fc0, 0x93b0cf];
  const jit = (hex, r) => { const f = 0.94 + r() * 0.12, c = v => Math.min(255, v * f) | 0; return rgb((c(hex >> 16 & 255) << 16) | (c(hex >> 8 & 255) << 8) | c(hex & 255)); };
  const ups = [0, 0.3, 0.55, 0.76, 0.92, 1.0, 1.08];
  // ring A: close rolling hills (greens)
  for (let i = 0; i < 26; i++) {
    const a = i / 26 * Math.PI * 2 + rng() * 0.2, d = (372 + rng() * 90) * HS, R = (55 + rng() * 45) * HS, H = 16 + rng() * 18;
    const g = i % 2 ? G0 : G1, c0 = jit(g[0], rng), c1 = jit(g[1], rng), band = i % 5 === 2;
    L.push(dome(Math.cos(a) * d, Math.sin(a) * d, R, H, band ? [c1, c1, c0, c0, c0, c0] : [c1, c1, c1, c0, c0, c0], rng, 14, ups));
  }
  // ring B: taller, bluer-green hills behind them
  for (let i = 0; i < 20; i++) {
    const a = i / 20 * Math.PI * 2 + 0.12 + rng() * 0.25, d = (492 + rng() * 80) * HS, R = (80 + rng() * 55) * HS, H = 32 + rng() * 30;
    const c = [B0[2], B0[1], B0[0]].map(h => jit(h, rng));
    L.push(dome(Math.cos(a) * d, Math.sin(a) * d, R, H, [c[0], c[0], c[1], c[1], c[2], c[2]], rng, 14, ups));
  }
  // ring C: big blue rounded mountains on the horizon
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2 + 0.3 + rng() * 0.2, d = 700 + rng() * 80, R = 170 + rng() * 80, H = 90 + rng() * 110;
    const c = [B1[2], B1[1], B1[0]].map(h => jit(h, rng));
    L.push(dome(Math.cos(a) * d, Math.sin(a) * d, R, H, [c[0], c[0], c[1], c[1], c[2], c[2]], rng, 14, ups));
  }
  return merge(L);
}

// ------------------------------------------------------------------ rocks: plump stacked smooth boulders (outlined mesh)
const ROCK_TONES = [0x8f8d89, 0xa09d97, 0xb2aea6, 0x9a9184, 0xa8a090];
export function boulder(L, x, z, r, rng, yaw = 0) {
  const t = ROCK_TONES, c0 = t[(rng() * 5) | 0], c1 = t[(rng() * 5) | 0];
  const seg = r > 0.9 ? 8 : 7, rings = r > 0.9 ? 4 : 3;
  const y0 = r * 0.42;
  L.push(smoothen(ell(r * 1.05, r * 0.7, r * 0.92, mixHex(c0, 0x6a6762, 0.35), x, y0, z, seg, rings, 0, yaw, 0)));
  const n = r > 0.8 ? 2 : (rng() < 0.5 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const a = rng() * 6.28, d = r * (0.35 + rng() * 0.3), s = r * (0.55 - i * 0.12 + rng() * 0.1);
    L.push(smoothen(ell(s * 1.05, s * 0.75, s, i ? c1 : mixHex(c1, 0xffffff, 0.12), x + Math.cos(a) * d, y0 + r * (0.45 - i * 0.12), z + Math.sin(a) * d, 7, 3, 0, rng() * 3, 0)));
  }
}
// goat-pen rock: lumps fitted so every vertex stays at or below the sim's cone y = h (1 - rho / R)  (world.js terrainHeight)
export function goatRock(L, f, rng) {
  const cone_ = (px, pz) => Math.max(0, f.h * (1 - Math.hypot(px - f.x, pz - f.z) / f.r));
  const T = ROCK_TONES;
  const defs = [  // [dx, dz (fractions of R), a (frac of R), b (frac of h), y0 (frac of h), tone]
    [0, 0, 0.98, 0.34, 0.0, 0], [0.12, -0.06, 0.74, 0.5, 0.1, 1], [-0.06, 0.1, 0.5, 0.52, 0.34, 2], [0.0, 0.0, 0.3, 0.42, 0.56, 3],
    [0.55, 0.2, 0.4, 0.3, 0.0, 1], [-0.5, -0.3, 0.38, 0.28, 0.0, 0],
  ];
  for (const d of defs) {
    let a = d[2] * f.r, b = d[3] * f.h, y0 = d[4] * f.h;
    const cx = f.x + d[0] * f.r, cz = f.z + d[1] * f.r, yaw = rng() * 3;
    let g = null;
    for (let it = 0; it < 40; it++) {
      g = ell(a, b, a * (0.9 + rng() * 0.0), T[d[5]], cx, y0, cz, 8, 4, 0, yaw, 0);
      let worst = 0;
      for (let i = 0; i < g.count; i++) { const v = g.pos[i * 3 + 1] - cone_(g.pos[i * 3], g.pos[i * 3 + 2]); if (v > worst) worst = v; }
      if (worst <= 0.002) break;
      b *= 0.94; y0 *= 0.94; a *= 0.985;
    }
    L.push(smoothen(g));
  }
}

// ------------------------------------------------------------------ trees: thick short trunk + overlapping smooth plump canopy blobs (two greens), rounded stacked-cone pines
const CANOPY = [[0x4c8a3e, 0x6aa84c, 0x80bb58], [0x55933f, 0x72b04e, 0x88c25a], [0x488344, 0x619f50, 0x78b55a], [0x5a9a42, 0x78b654, 0x92c85f]];
const PINE = [[0x3d7746, 0x4b8750, 0x5c9a5c], [0x44804a, 0x54905a, 0x66a366]];
const BARK = 0x7a5538, BIRCH = 0xe0dac8;
function trunk(L, x, z, r0, r1, h, hex) { L.push(smoothen(lathe([[r0, 0], [r1, h]], 6, hex, 1, 1, x, 0, z))); }
function blobAt(L, ax, ay, az, hex, x, y, z, seg = 7, rings = 3, yaw = 0) { L.push(smoothen(ell(ax, ay, az, hex, x, y, z, Math.min(seg, 6), rings, 0, yaw, 0))); }
// kind: 0 round, 1 tall oval, 2 pine, 3 yellow-green round, 4 birch, 5 fruit tree. lo: far-ring variant (fewer / smaller parts)
export function chunkyTree(L, x, z, s, rng, kind, lo) {
  const pal = CANOPY[(rng() * CANOPY.length) | 0];
  if (kind === 2) {
    const pp = PINE[(rng() * 2) | 0], tiers = lo ? 2 : 3, base = 1.1 * s;
    trunk(L, x, z, 0.4 * s, 0.3 * s, base + 0.8 * s, BARK);
    for (let i = 0; i < tiers; i++) {
      const R = (2.1 - i * 0.55) * s, h = 1.7 * s, y = base + i * 1.15 * s, seg = lo ? 6 : 7;
      L.push(smoothen(lathe([[0, 0], [R, 0], [R * 0.84, h * 0.34], [R * 0.46, h * 0.78], [0, h]], seg, pp[i], 1, 1, x, y, z, 0, rng() * 3, 0)));
    }
    return;
  }
  const bark = kind === 4 ? BIRCH : BARK, th = (kind === 4 ? 2.4 : kind === 1 ? 1.8 : 1.6) * s;
  trunk(L, x, z, (kind === 4 ? 0.3 : 0.42) * s, (kind === 4 ? 0.22 : 0.32) * s, th + 0.6 * s, bark);
  let c = pal;
  if (kind === 3) c = [0x7da34a, 0x95b855, 0xaccb62]; else if (kind === 4) c = [0x88b04a, 0xa0c457, 0xb6d466];
  const cy = th + 1.1 * s;
  if (kind === 1) {   // tall stacked oval
    blobAt(L, 1.9 * s, 1.5 * s, 1.9 * s, c[0], x, cy, z, 7, 3, rng() * 3);
    blobAt(L, 1.55 * s, 1.35 * s, 1.55 * s, c[1], x + (rng() - 0.5) * 0.4 * s, cy + 1.7 * s, z + (rng() - 0.5) * 0.4 * s, 7, 3);
    if (!lo) blobAt(L, 1.05 * s, 1.0 * s, 1.05 * s, c[2], x + (rng() - 0.5) * 0.3 * s, cy + 3.0 * s, z, 6, 3);
    return;
  }
  const R = (kind === 4 ? 1.7 : 2.2) * s;
  blobAt(L, R, R * 0.82, R, c[0], x, cy + 0.3 * s, z, 8, 3, rng() * 3);
  const n = lo ? 0 : (kind === 4 ? 1 : 1 + ((rng() * 2.2) | 0)), a0 = rng() * 6.28;
  for (let i = 0; i < n; i++) {
    const a = a0 + i * (6.28 / n) + (rng() - 0.5) * 0.5, d = R * 0.72, r = R * (0.58 + rng() * 0.12);
    blobAt(L, r, r * 0.85, r, i % 2 ? c[1] : c[0], x + Math.cos(a) * d, cy + (rng() - 0.3) * 0.6 * s, z + Math.sin(a) * d, 7, 3, rng() * 3);
  }
  blobAt(L, R * 0.72, R * 0.62, R * 0.72, c[2], x + (rng() - 0.5) * 0.5 * s, cy + R * 0.72, z + (rng() - 0.5) * 0.5 * s, 7, 3);
  if (kind === 5 && !lo) for (let i = 0; i < 4; i++) { const a = rng() * 6.28, dd = R * (0.8 + rng() * 0.2); blobAt(L, 0.17 * s, 0.17 * s, 0.17 * s, 0xc9473a, x + Math.cos(a) * dd, cy + (rng() - 0.2) * s, z + Math.sin(a) * dd, 5, 2); }
}

export function buildTrees(ctx) {
  const rng = mulberry32(31337), near = [], far = [], placed = [];
  const okRule = (x, z) => Math.abs(z) >= 76 || (Math.abs(x) >= 128 && Math.abs(z) >= 60);
  const inBuilding = (x, z) => {
    for (const k in BUILDINGS) {
      const b = BUILDINGS[k], m = 5;
      if (b.kind === 'rect') { if (x > b.x0 - m && x < b.x1 + m && z > b.z0 - m && z < b.z1 + m) return true; }
      else if ((x - b.x) ** 2 + (z - b.z) ** 2 < (b.r + m) ** 2) return true;
    }
    return false;
  };
  // >= 7 m clear of the service lanes (any z, they fade out far beyond the world) and aprons
  const laneClear = (x, z) => {
    for (const lx of LANES_X) if (Math.abs(x - lx) < 7.5) return false;
    for (const a of APRONS) if (x > a.x0 - 5 && x < a.x1 + 5 && z > a.z0 - 5 && z < a.z1 + 5) return false;
    return true;
  };
  const blockedByProps = (x, z) => ctx ? ctx.blockers.some(b => b.r > 0 ? (x - b.x) ** 2 + (z - b.z) ** 2 < (b.r + 1.5) ** 2 : Math.abs(x - b.x) < b.hw + 2 && Math.abs(z - b.z) < b.hd + 2) : false;
  const nearT = (x, z, d) => { for (let i = 0; i < placed.length; i += 2) { const dx = x - placed[i], dz = z - placed[i + 1]; if (dx * dx + dz * dz < d * d) return true; } return false; };
  const clumps = [];
  for (let i = 0; i < 16; i++) {
    let x, z, t = 0;
    do { x = (rng() * 2 - 1) * (WORLD.x1 - 12); z = (rng() * 2 - 1) * (WORLD.z1 - 12); t++; } while ((!okRule(x, z) || !laneClear(x, z) || nearPen(x, z, 8)) && t < 200);
    clumps.push([x, z, 8 + rng() * 14]);
  }
  const kindOf = () => { const r = rng(); return r < 0.34 ? 0 : r < 0.5 ? 1 : r < 0.74 ? 2 : r < 0.84 ? 3 : r < 0.92 ? 4 : 5; };
  let count = 0, guard = 0;
  while (count < 300 && guard++ < 30000) {
    let x, z;
    if (rng() < 0.62) { const c = clumps[(rng() * clumps.length) | 0]; const a = rng() * 6.28, d = Math.sqrt(rng()) * c[2]; x = c[0] + Math.cos(a) * d; z = c[1] + Math.sin(a) * d; }
    else { x = (rng() * 2 - 1) * (WORLD.x1 - 8); z = (rng() * 2 - 1) * (WORLD.z1 - 8); }
    if (Math.abs(x) > WORLD.x1 - 8 || Math.abs(z) > WORLD.z1 - 8 || !okRule(x, z) || !laneClear(x, z) || nearPen(x, z, 3.5) || inTruckLane(x, z, 6) || inBuilding(x, z) || blockedByProps(x, z) || nearT(x, z, 5.4)) continue;
    chunkyTree(near, x, z, 0.8 + rng() * 0.5, rng, kindOf(), false); placed.push(x, z); count++;
  }
  // far forest ring just beyond the world edge (cheap variants), also thick enough to hide the world edge behind the lanes' fade
  for (let i = 0; i < 130; i++) {
    const a = rng() * 6.28, d = 160 + rng() * 170, x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (Math.abs(x) < WORLD.x1 - 2 && Math.abs(z) < WORLD.z1 - 2) continue;
    if (!laneClear(x, z) || inTruckLane(x, z, 8) || nearT(x, z, 6)) continue;
    chunkyTree(far, x, z, 1.1 + rng() * 0.8, rng, rng() < 0.55 ? 0 : 2, true); placed.push(x, z);
  }
  return { geo: merge([...near, ...far]), count };
}

// ------------------------------------------------------------------ scatter: boulders, tufts, flowers, bushes, pebbles
export function buildScatter(ctx, stones, pebbles) {
  const rng = mulberry32(4242);
  const R = [], plants = [], small = [];
  const free = (x, z, m = 0) => !reserved(x, z, m) && !(ctx && ctx.blockers.some(b => b.r > 0 ? (x - b.x) ** 2 + (z - b.z) ** 2 < (b.r + 0.4) ** 2 : Math.abs(x - b.x) < b.hw + 0.4 && Math.abs(z - b.z) < b.hd + 0.4));
  const T = ROCK_TONES;
  // road / lane curb stones
  for (const s of stones) {
    const c = T[(s.t * 5) | 0];
    R.push(smoothen(ell(s.rx, s.ry, s.rz, c, s.x, s.ry * 0.55, s.z, 6, 2, 0, s.yaw, 0)));
  }
  // boulder clusters: around the yard / road verges / hill foot, never in pens / on roads / lanes
  const placedRock = [];
  const addCluster = (x, z, big) => {
    const n = big ? 3 : 1 + ((rng() * 2) | 0);
    for (let i = 0; i < n; i++) {
      const px = x + (i ? (rng() - 0.5) * 3.4 : 0), pz = z + (i ? (rng() - 0.5) * 3.4 : 0), r = big ? 1.1 + rng() * 1.1 - i * 0.25 : 0.55 + rng() * 0.6;
      boulder(R, px, pz, r, rng, rng() * 3);
    }
    placedRock.push([x, z]);
    if (ctx) ctx.blockers.push({ x, z, hw: 0, hd: 0, r: big ? 3.4 : 1.8 });
  };
  let guard = 0, nb = 0;
  while (nb < 46 && guard++ < 4000) {
    const far = nb >= 28, x = (rng() * 2 - 1) * (far ? 330 : 168), z = (rng() * 2 - 1) * (far ? 330 : 168);
    if (!far && Math.abs(x) < 168 && Math.abs(z) < 168 && penAt(x, z) >= 0) continue;
    if (penAt(x, z) >= 0 || penAt(x + 3, z + 3) >= 0 || penAt(x - 3, z - 3) >= 0 || penAt(x + 3, z - 3) >= 0 || penAt(x - 3, z + 3) >= 0) continue;
    if (Math.abs(z) < 11 && Math.abs(x) < 160) continue;
    if (!free(x, z, 5)) continue;
    if (Math.abs(x) < 165 && Math.abs(z) < 165 && Math.abs(z) < 62 && Math.abs(x) > 120) continue;
    if (placedRock.some(p => (p[0] - x) ** 2 + (p[1] - z) ** 2 < 100)) continue;
    addCluster(x, z, nb % 3 === 0); nb++;
  }
  // tufts: chunky 3-5 plump blades in two tones. big ones are outlined ('plants'), small ones are plain
  const cA = [0x6fa843, 0x7fb84c], cB = [0x5c9a3e, 0x6aa845];
  const blade = (L, x, z, h, w, hex, lean, yaw) => L.push(smoothen(lathe([[w, 0], [w * 0.72, h * 0.55], [0, h]], 3, hex, 1, 1, x, 0, z, lean, yaw, 0)));
  const tuft = (L, x, z, s, nb2) => {
    for (let i = 0; i < nb2; i++) {
      const a = i / nb2 * 6.28 + rng() * 0.8, h = s * (0.5 + rng() * 0.45), w = s * 0.11;
      blade(L, x + Math.cos(a) * 0.07 * s, z + Math.sin(a) * 0.07 * s, h, w, (i % 2 ? cA : cB)[(rng() * 2) | 0], 0.25 + rng() * 0.4, a + Math.PI / 2);
    }
  };
  let nbig = 0, nsm = 0;
  guard = 0;
  while ((nbig < 240 || nsm < 420) && guard++ < 12000) {
    const x = (rng() * 2 - 1) * (WORLD.x1 - 8), z = (rng() * 2 - 1) * (WORLD.z1 - 2);
    if (!free(x, z)) continue;
    const p = penAt(x, z);
    if (p >= 10) continue;                                   // biome pens carry their own decor
    if ((p === 0 || p === 6 || p === 4) && rng() < 0.75) continue;
    if (rng() < 0.37 && nbig < 240) { tuft(plants, x, z, 0.75 + rng() * 0.5, 3 + ((rng() * 2.2) | 0)); nbig++; }
    else if (nsm < 420) { tuft(small, x, z, 0.5 + rng() * 0.4, 3); nsm++; }
  }
  // tuft rings by the big props
  for (const [x, z] of [[-139.5, -9.8], [-139.3, 10.4], [139.4, -11.6], [139.6, 11.8]]) for (let k = 0; k < 2; k++) tuft(plants, x + (rng() - 0.5) * 1.6, z + (rng() - 0.5) * 1.2, 0.9, 4);
  // flowers: stem + rounded bloom
  const flowers = [0xf0dc6a, 0xf0ece0, 0xd9779a, 0xb08ad0, 0xe69a50];
  let nf = 0; guard = 0;
  while (nf < 170 && guard++ < 6000) {
    const x = (rng() * 2 - 1) * (WORLD.x1 - 8), z = (rng() * 2 - 1) * (WORLD.z1 - 2);
    if (vnoise(x * 0.04, z * 0.04, 61) < 0.5 || !free(x, z) || penAt(x, z) >= 10) continue;
    small.push(lathe([[0.03, 0], [0.025, 0.26]], 3, 0x4e9a38, 1, 1, x, 0, z));
    small.push(smoothen(ell(0.15, 0.11, 0.15, flowers[(rng() * flowers.length) | 0], x, 0.31, z, 6, 2)));
    nf++;
  }
  // free bushes (rounded, outlined)
  let nbu = 0; guard = 0;
  while (nbu < 34 && guard++ < 5000) {
    const x = (rng() * 2 - 1) * (WORLD.x1 - 4), z = (rng() * 2 - 1) * (WORLD.z1 - 2);
    if (!free(x, z, 3) || penAt(x, z) >= 0 || Math.abs(z) < 12) continue;
    if (!(Math.abs(z) >= 62 || Math.abs(x) >= 124)) continue;
    const r = 0.9 + rng() * 0.8, g = [0x56953f, 0x6aab4c, 0x4a8a3e];
    plants.push(smoothen(ell(r * 0.95, r * 0.78, r * 0.95, g[0], x, r * 0.55, z, 7, 3)));
    plants.push(smoothen(ell(r * 0.62, r * 0.55, r * 0.62, g[1], x + r * 0.55, r * 0.48, z + r * 0.25, 7, 3)));
    plants.push(smoothen(ell(r * 0.55, r * 0.5, r * 0.55, g[2], x - r * 0.5, r * 0.42, z - r * 0.3, 6, 3)));
    if (rng() < 0.6) plants.push(smoothen(ell(0.12, 0.12, 0.12, rng() < 0.5 ? 0xd96a6a : 0xe6cf6a, x + (rng() - 0.5) * r, r * 0.95, z + r * 0.5, 5, 2)));
    nbu++;
  }
  // pebbles on road / lanes / aprons: small flat rounded stones
  for (const p of pebbles) small.push(ell(p.s * 1.3, p.s * 0.55, p.s, mixHex(0x9a9288, 0xd0c8b8, p.t), p.x, p.s * 0.2, p.z, 5, 2, 0, p.t * 6, 0));
  return { R: merge(R.concat(ctx ? ctx.R : [])), plants: merge(plants.concat(ctx ? ctx.P : [])), small: merge(small.concat(ctx ? ctx.small : [])) };
}
