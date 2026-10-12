// Private geometry builders for the environment (WP5). Pure JS, no GL/DOM.
// Art direction: 'Farm Animals Pack' look -- chunky, ROUNDED, cartoony props in muted natural wood browns, dark roofs, plump smooth trees.
// Terrain (painted ground, hills, rocks, trees, tufts, lanes) lives in envTerrain.js.
// Everything is merged into a handful of static Geo objects:
//   ground  (terrain + skirt; never outlined)   hills (rounded mounds / mountains; big outline)       bldg   (buildings; thick outline)
//   props   (fences, troughs, crates ... ; thin outline)     scatter(grass tufts, flowers, pebbles; no outline)
//   trees   (plump blob canopies; outlined)
// Dynamic bits (trough fills, hay bales, glows) are only *described* here (ctx.troughs / ctx.bales / ctx.glows).
// Winding: every builder here emits CCW-outward faces (box/rbox/lathe/cyl/TB-with-hint), which the inverted-hull outline needs.
import { box, cyl, cone, blob, ell, lathe, rbox, rod, smoothen, merge } from './lowpoly.js';
import { PENS, BUILDINGS, ROAD, SPECIES, FeatureKind as K, WORLD_HALF, blobOutline } from '../config.js';
import { buildGround, buildHills, buildTrees, buildScatter, chunkyTree, goatRock, boulder } from './envTerrain.js';
import { mulberry32, hash01 } from '../ecs/rng.js';
import { paintBiomeGround, biomeFeature, buildTreeFeature } from './envBiomes.js';

// ------------------------------------------------------------------ small helpers
const rgb = h => [(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255];
export function shade(hex, f) {
  const r = Math.max(0, Math.min(255, Math.round((hex >> 16 & 255) * f)));
  const g = Math.max(0, Math.min(255, Math.round((hex >> 8 & 255) * f)));
  const b = Math.max(0, Math.min(255, Math.round((hex & 255) * f)));
  return (r << 16) | (g << 8) | b;
}
function mixHex(a, b, t) {
  const ar = a >> 16 & 255, ag = a >> 8 & 255, ab = a & 255, br = b >> 16 & 255, bg = b >> 8 & 255, bb = b & 255;
  return ((ar + (br - ar) * t) << 16) | ((ag + (bg - ag) * t) << 8) | (ab + (bb - ab) * t) | 0;
}
const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// Triangle collector with explicit normals. `hint` is a point inside a convex solid; winding/normal are flipped to face away from it.
class TB {
  constructor() { this.p = []; this.n = []; this.c = []; }
  tri(a, b, c, col, hint, nrm) {
    let ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    if (hint) {
      const dx = (a[0] + b[0] + c[0]) / 3 - hint[0], dy = (a[1] + b[1] + c[1]) / 3 - hint[1], dz = (a[2] + b[2] + c[2]) / 3 - hint[2];
      if (nx * dx + ny * dy + nz * dz < 0) { const t = b; b = c; c = t; nx = -nx; ny = -ny; nz = -nz; }
    }
    const k = Array.isArray(col) ? col : rgb(col);
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    const N = nrm || [nx, ny, nz];
    for (let i = 0; i < 3; i++) { this.n.push(N[0], N[1], N[2]); this.c.push(k[0], k[1], k[2]); }
  }
  quad(a, b, c, d, col, hint) { this.tri(a, b, c, col, hint); this.tri(a, c, d, col, hint); }
  geo() { return { pos: new Float32Array(this.p), nrm: new Float32Array(this.n), col: new Float32Array(this.c), count: this.p.length / 3 }; }
}

// Puffy sphere (clouds only): icosphere detail 1 (80 flat faces), colour lightens toward the top.
const _IP = (() => {
  const PHI = (1 + Math.sqrt(5)) / 2;
  const V = [[-1,PHI,0],[1,PHI,0],[-1,-PHI,0],[1,-PHI,0],[0,-1,PHI],[0,1,PHI],[0,-1,-PHI],[0,1,-PHI],[PHI,0,-1],[PHI,0,1],[-PHI,0,-1],[-PHI,0,1]]
    .map(v => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; });
  const F = [[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
  const mid = (a, b) => { const m = [a[0] + b[0], a[1] + b[1], a[2] + b[2]], l = Math.hypot(m[0], m[1], m[2]); return [m[0] / l, m[1] / l, m[2] / l]; };
  const out = [];
  for (const f of F) {
    const a = V[f[0]], b = V[f[1]], c = V[f[2]], ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    out.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
  }
  return out;
})();
function puff(r, hex, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, topLight = 0.16) {
  const tb = new TB(), hint = [x, y, z];
  for (const t of _IP) {
    const P = i => [t[i][0] * r * sx + x, t[i][1] * r * sy + y, t[i][2] * r * sz + z];
    const ny = (t[0][1] + t[1][1] + t[2][1]) / 3;
    tb.tri(P(0), P(1), P(2), shade(hex, 1 + topLight * ny * 1.6 - 0.04), hint);
  }
  return smoothen(tb.geo());
}

// Convex polygon profile (u,y), CCW, extruded along local z in [-len/2, len/2].
function prism(pts, len, hex, hexF = hex, hexB = hex) {
  const tb = new TB(), n = pts.length, hz = len / 2;
  let cu = 0, cy = 0;
  for (const p of pts) { cu += p[0]; cy += p[1]; }
  cu /= n; cy /= n;
  const hint = [cu, cy, 0];
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    tb.tri([cu, cy, hz], [p[0], p[1], hz], [q[0], q[1], hz], hexF, hint);
    tb.tri([cu, cy, -hz], [p[0], p[1], -hz], [q[0], q[1], -hz], hexB, hint);
    tb.quad([p[0], p[1], hz], [q[0], q[1], hz], [q[0], q[1], -hz], [p[0], p[1], -hz], hex, hint);
  }
  return tb.geo();
}
// rounded box (chamfered); falls back to a plain box for thin trim pieces. rotation as box()
function rb(w, h, d, hex, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, r) {
  const m = Math.min(w, h, d);
  if (m < 0.1) return box(w, h, d, hex, x, y, z, rx, ry, rz);
  return rbox(w, h, d, r !== undefined ? r : Math.min(0.14, m * 0.3), hex, x, y, z, rx, ry, rz);
}
// open hexagonal tube between two points (12 tris at seg 6) -- rounded rails / beams / poles
function tube(x0, y0, z0, x1, y1, z1, r, hex, seg = 6, r1 = r) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, L = Math.hypot(dx, dy, dz) || 1e-6, hl = L / 2;
  const rx = Math.acos(Math.max(-1, Math.min(1, dy / L))), ry = Math.atan2(dx, dz);
  return lathe([[r, -hl], [r1, hl]], seg, hex, 1, 1, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, rx, ry, 0);
}
// rounded post: open bottom, domed top (30 tris)
function pole(x, z, r, h, hex, hexTop = hex, seg = 6) {
  const g = lathe([[r, 0], [r, h - r * 0.8], [r * 0.7, h - r * 0.2], [0, h]], seg, hex, 1, 1, x, 0, z);
  return g;
}
// Roof slab along profile edge a->b, offset to the upward side (rounded slab).
function slab(ax, ay, bx, by, len, t, hex, ext = 0.25) {
  const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
  let nx = -dy / L, ny = dx / L;
  if (ny < 0) { nx = -nx; ny = -ny; }
  return rb(L + ext, t, len, hex, (ax + bx) / 2 + nx * t / 2, (ay + by) / 2 + ny * t / 2, 0, 0, 0, Math.atan2(dy, dx), 0.13);
}
// Transform a list of local geos into world (yaw about Y, then translate); in place on the merged result.
function place(list, x, y, z, yaw = 0) {
  const g = merge(list), c = Math.cos(yaw), s = Math.sin(yaw);
  for (let i = 0; i < g.count; i++) {
    const o = i * 3;
    const px = g.pos[o], pz = g.pos[o + 2];
    g.pos[o] = c * px + s * pz + x; g.pos[o + 1] += y; g.pos[o + 2] = -s * px + c * pz + z;
    const nx = g.nrm[o], nz = g.nrm[o + 2];
    g.nrm[o] = c * nx + s * nz; g.nrm[o + 2] = -s * nx + c * nz;
  }
  return g;
}
// local (lx,lz) -> world given placement
function loc(ox, oz, yaw, lx, lz) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [c * lx + s * lz + ox, -s * lx + c * lz + oz];
}

// ------------------------------------------------------------------ palette (muted, matte, natural)
const WOOD = 0xa07650, WOOD_D = 0x7a583a, WOOD_L = 0xb88e5e, WOOD_DD = 0x5c4330, TRIM = 0xd8c9a6, STRAW = 0xd4b868, DARK = 0x2e2520;
const ROOF_DK = 0x484954, ROOF_DK2 = 0x3c3d48;
const STRAP = 0x6a4a30, HAY_TAN = 0xc4a066, HAY_GRN = 0x93a83c, BURLAP = 0xd2b982;

// ------------------------------------------------------------------ context
export function createCtx() {
  return { S: [], B: [], R: [], T: [], P: [], small: [], steam: [], glows: [], troughs: [], bales: [], blockers: [], rng: mulberry32(20240611) };
}
// glow instance: kind 0 window pane, 1 lamp bulb. (x,y,z) centre, size (w,h,d) in local axes, yaw
function glow(ctx, x, y, z, w, h, d, yaw, kind = 0) { ctx.glows.push({ x, y, z, w, h, d, yaw, kind }); }
// framed window on a wall. Wall normal direction given by yaw of the pane's local +z.
function window_(ctx, S, x, y, z, w, h, yaw) {
  const L = [rb(w + 0.3, h + 0.3, 0.12, TRIM, 0, 0, 0, 0, 0, 0, 0.05), box(w + 0.36, 0.08, 0.2, TRIM, 0, -h / 2 - 0.18, 0.05), box(0.06, h, 0.1, TRIM, 0, 0, 0.06), box(w, 0.06, 0.1, TRIM, 0, 0, 0.06)];
  S.push(place(L, x, y, z, yaw));
  glow(ctx, x, y, z, w, h, 0.12, yaw, 0);
  const g = ctx.glows[ctx.glows.length - 1];
  g.x += Math.sin(yaw) * 0.07; g.z += Math.cos(yaw) * 0.07;
}
function blocker(ctx, x, z, hw, hd, r) { ctx.blockers.push({ x, z, hw, hd, r }); }

// ------------------------------------------------------------------ noise
function vnoise(x, z, seed) {
  const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash01(seed, xi * 7919 + zi * 104729), b = hash01(seed, (xi + 1) * 7919 + zi * 104729);
  const c = hash01(seed, xi * 7919 + (zi + 1) * 104729), d = hash01(seed, (xi + 1) * 7919 + (zi + 1) * 104729);
  return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sz;
}

// ------------------------------------------------------------------ fences (chunky two-rail, rounded posts + round rails)
const POST_C = 0x8a6440, RAIL_C = 0xb08458;
function fenceRun(S, ax, az, bx, bz) {
  const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(len / 3));
  for (let i = 0; i <= n; i++) {
    const x = ax + (bx - ax) * i / n, z = az + (bz - az) * i / n;
    S.push(pole(x, z, 0.23, 1.25, POST_C, POST_C, 5));
  }
  for (let i = 0; i < n; i++) {
    const x0 = ax + (bx - ax) * i / n, z0 = az + (bz - az) * i / n, x1 = ax + (bx - ax) * (i + 1) / n, z1 = az + (bz - az) * (i + 1) / n;
    S.push(tube(x0, 0.45, z0, x1, 0.45, z1, 0.115, RAIL_C, 5), tube(x0, 0.92, z0, x1, 0.92, z1, 0.115, shade(RAIL_C, 1.06), 5));
  }
}
const fenceX = (S, xa, xb, z) => fenceRun(S, xa, z, xb, z);
const fenceZ = (S, x, za, zb) => fenceRun(S, x, za, x, zb);

// ------------------------------------------------------------------ small decorative props
// strapped round hay bale lying on its side (axis along local X unless yawed). centre at (x, R, z)
function hayBale(hex, x, y, z, yaw = 0, R = 0.55, Lh = 1.2) {
  const h = Lh / 2, e = R * 0.15;
  const body = smoothen(lathe([[0, -h], [R - e, -h], [R, -h + e], [R, h - e], [R - e, h], [0, h]], 8, hex, 1, 1, x, y, z, 0, yaw, Math.PI / 2));
  const sg = [];
  for (const o of [-0.26, 0.26]) sg.push(lathe([[R + 0.035, o * Lh - 0.06], [R + 0.035, o * Lh + 0.06]], 8, STRAP, 1, 1, x, y, z, 0, yaw, Math.PI / 2));
  return merge([body, ...sg]);
}
function crate(S, x, y, z, yaw = 0, s = 1) {
  const L = [rb(0.9 * s, 0.8 * s, 0.9 * s, WOOD_L, 0, 0.4 * s, 0, 0, 0, 0, 0.07),
    rb(0.98 * s, 0.14 * s, 0.98 * s, WOOD_D, 0, 0.72 * s, 0, 0, 0, 0, 0.05), rb(0.98 * s, 0.14 * s, 0.98 * s, WOOD_D, 0, 0.1 * s, 0, 0, 0, 0, 0.05)];
  for (const sz of [-1, 1]) L.push(box(0.12 * s, 0.7 * s, 0.05 * s, WOOD_D, 0, 0.4 * s, sz * 0.47 * s), box(0.78 * s, 0.1 * s, 0.05 * s, WOOD_D, 0, 0.4 * s, sz * 0.47 * s, 0, 0, 0.7));
  S.push(place(L, x, y, z, yaw));
}
function barrel(S, x, z, hex = 0x3b3d4a, y = 0) {
  S.push(smoothen(lathe([[0.30, 0], [0.40, 0.12], [0.43, 0.45], [0.40, 0.78], [0.31, 0.9], [0, 0.9]], 8, hex, 1, 1, x, y, z)),
    lathe([[0.425, 0.2], [0.44, 0.24], [0.44, 0.3], [0.425, 0.33]], 8, 0x6a6c7c, 1, 1, x, y, z), lathe([[0.425, 0.6], [0.44, 0.64], [0.44, 0.7], [0.425, 0.73]], 8, 0x6a6c7c, 1, 1, x, y, z),
    cyl(0.22, 0.22, 0.04, 8, 0x585b6c, x, y + 0.9, z));
}
function sack(S, x, z, yaw = 0, y = 0) {
  S.push(smoothen(lathe([[0, 0], [0.3, 0.02], [0.4, 0.22], [0.37, 0.45], [0.2, 0.6], [0.24, 0.7], [0.16, 0.74], [0, 0.7]], 7, BURLAP, 1, 1, x, y, z, 0, yaw, 0)));
}
function bucket(S, x, z, hex = 0x8f98a2) {
  S.push(lathe([[0.2, 0], [0.26, 0.4], [0.275, 0.42]], 8, hex, 1, 1, x, 0, z), cyl(0.2, 0.2, 0.04, 8, hex, x, 0.02, z),
    tube(x - 0.26, 0.42, z, x, 0.74, z, 0.025, 0x555a60, 4), tube(x, 0.74, z, x + 0.26, 0.42, z, 0.025, 0x555a60, 4));
}
function scarecrow(S, x, z, yaw) {
  const L = [];
  const blue = 0x5b83ab, sleeve = 0xc08884, hatC = 0x9a6a3c;
  L.push(tube(0, 0, 0, 0, 2.0, 0, 0.075, WOOD_D, 5), tube(-1.0, 1.58, 0, 1.0, 1.58, 0, 0.065, WOOD_D, 5));
  L.push(smoothen(lathe([[0.3, 0.72], [0.4, 0.78], [0.38, 1.2], [0.3, 1.58], [0.0, 1.62]], 7, blue, 1, 0.8)));               // overalls
  L.push(box(0.36, 0.34, 0.06, 0x4a6e92, 0, 1.3, 0.3));                                                                          // bib
  for (const sx of [-1, 1]) {
    L.push(tube(sx * 0.3, 1.56, 0, sx * 0.88, 1.58, 0, 0.11, sleeve, 6, 0.09));
    L.push(cone(0.12, 0.34, 4, STRAW, sx * 1.02, 1.58, 0, 0, 0, sx * -1.57), cone(0.08, 0.26, 4, STRAW, sx * 0.99, 1.52, 0, 0, 0, sx * -2.2));
    L.push(cone(0.1, 0.4, 4, STRAW, sx * 0.2, 0.62, 0.0, 0, 0, sx * 0.2));
  }
  L.push(ell(0.26, 0.28, 0.25, BURLAP, 0, 1.88, 0, 7, 4));
  L.push(box(0.05, 0.05, 0.04, DARK, -0.09, 1.92, 0.24), box(0.05, 0.05, 0.04, DARK, 0.09, 1.92, 0.24), box(0.14, 0.03, 0.04, DARK, 0, 1.8, 0.25));
  L.push(lathe([[0, 2.0], [0.2, 2.01], [0.5, 2.07], [0.52, 2.1], [0.2, 2.13], [0, 2.14]].slice(0, 6), 8, hatC, 1, 1), lathe([[0.2, 2.1], [0.24, 2.3], [0, 2.37]], 8, shade(hatC, 0.9), 1, 1));
  S.push(place(L, x, 0, z, yaw));
}

// ------------------------------------------------------------------ pen props
function trough(ctx, S, p, f, kind) {
  const x = f.x, z = f.z, w = f.w, d = f.d;
  const body = kind === 'feed' ? 0xa07650 : 0x8a7a68, dark = kind === 'feed' ? 0x6a4c34 : 0x5a5048;
  S.push(rb(w, 0.22, d, dark, x, 0.18, z, 0, 0, 0, 0.09));
  S.push(rb(w, 0.34, 0.14, body, x, 0.45, z - d / 2 + 0.07, 0, 0, 0, 0.06), rb(w, 0.34, 0.14, body, x, 0.45, z + d / 2 - 0.07, 0, 0, 0, 0.06));
  S.push(rb(0.14, 0.34, d - 0.2, body, x - w / 2 + 0.07, 0.45, z, 0, 0, 0, 0.06), rb(0.14, 0.34, d - 0.2, body, x + w / 2 - 0.07, 0.45, z, 0, 0, 0, 0.06));
  for (const sx of [-1, 1]) S.push(rb(0.3, 0.16, d * 0.7, dark, x + sx * (w / 2 - 0.45), 0.06, z, 0, 0, 0, 0.05));
  ctx.troughs.push({ pen: p, kind, x, z, iw: w - 0.3, id: d - 0.3, y: 0.3 });
  bucket(S, x + w / 2 + 0.55, z + (kind === 'feed' ? 0.15 : -0.15), kind === 'feed' ? 0x8a7a68 : 0x7d98b0);
}

function hayFeeder(ctx, S, p, f) {
  const r = f.r, n = 8;
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2;
    S.push(pole(f.x + Math.cos(a) * r, f.z + Math.sin(a) * r, 0.11, 1.25, WOOD_D));
  }
  for (const y of [0.35, 0.85]) for (let i = 0; i < n; i++) {
    const a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2;
    S.push(tube(f.x + Math.cos(a0) * r, y, f.z + Math.sin(a0) * r, f.x + Math.cos(a1) * r, y, f.z + Math.sin(a1) * r, 0.07, RAIL_C, 5));
  }
  S.push(lathe([[r * 1.02, 0], [r * 1.02, 0.07], [0, 0.07]], 12, 0x7a5e3c, 1, 1, f.x, 0, f.z));
  ctx.bales.push({ pen: p, x: f.x, z: f.z, r: r * 0.72 });
}

// plump bush: overlapping rounded lumps with smooth cel bands
function bush(S, x, z, r, rng) {
  const g = [0x5a9c48, 0x6aae52, 0x4c8c42];
  S.push(smoothen(ell(r * 0.85, r * 0.72, r * 0.85, g[0], x, r * 0.62, z, 8, 4)));
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * Math.PI * 2 + rng(), d = r * 0.6, s = r * (0.5 + rng() * 0.12);
    S.push(smoothen(ell(s, s * 0.8, s, g[(i + 1) % 3], x + Math.cos(a) * d, r * (0.36 + rng() * 0.2), z + Math.sin(a) * d, 7, 3)));
  }
  for (let i = 0; i < 5; i++) {
    const a = rng() * 6.28, d = r * (0.7 + rng() * 0.25);
    S.push(smoothen(ell(0.13, 0.12, 0.13, i % 2 ? 0xd96a6a : 0xe6cf6a, x + Math.cos(a) * d, r * (0.55 + rng() * 0.4), z + Math.sin(a) * d, 5, 2)));
  }
}

function strawPatch(S, x, z, w, d) {
  S.push(rb(w, 0.12, d, STRAW, x, 0.06, z, 0, 0, 0, 0.05));
  S.push(rb(w - 0.5, 0.1, 0.3, 0xb99c52, x, 0.14, z - d * 0.25, 0, 0, 0, 0.04), rb(w - 0.5, 0.1, 0.3, 0xb99c52, x, 0.14, z + d * 0.25, 0, 0, 0, 0.04));
}

// open-fronted shed with mono-pitch roof (high at the front); walls/roof go to B (outlined buildings), hay to S
function openShed(ctx, S, B, f, faceZ, wallHex, roofHex) {
  const { x, z, w, d, h } = f, hb = h - 0.8, yaw = faceZ > 0 ? -Math.PI / 2 : Math.PI / 2;
  const L = [];
  const prof = [[-d / 2, 0], [d / 2, 0], [d / 2, h * 0.8], [-d / 2, hb]];
  L.push(place([prism(prof, 0.3, wallHex)], 0, 0, w / 2 - 0.15, 0), place([prism(prof, 0.3, wallHex)], 0, 0, -w / 2 + 0.15, 0));
  L.push(rb(0.3, hb, w, shade(wallHex, 0.92), -d / 2 + 0.15, hb / 2, 0, 0, 0, 0, 0.1));
  L.push(slab(-d / 2 - 0.35, hb + 0.05, d / 2 + 0.7, h + 0.05, w + 1.5, 0.4, roofHex, 0.4));
  const posts = w > 9 ? 3 : 2;
  for (let i = 0; i < posts; i++) L.push(pole(d / 2 - 0.15, -w / 2 + 0.3 + i * (w - 0.6) / (posts - 1), 0.17, h + 0.02, WOOD_D));
  B.push(place(L, x, 0, z, yaw));
  S.push(rb(w - 0.6, 0.08, d - 0.7, STRAW, x, 0.04, z, 0, 0, 0, 0.03), rb(w - 1.6, 0.08, d - 1.6, 0xc4a85a, x, 0.1, z - faceZ * 0.2, 0, 0, 0, 0.03));
  S.push(hayBale(HAY_TAN, x - w / 2 + 1.4, 0.55, z - faceZ * (d / 2 - 1.0), 0.1), hayBale(HAY_GRN, x - w / 2 + 1.6, 1.65, z - faceZ * (d / 2 - 1.0), -0.1));
}

// chunky gabled building. Ridge along world X, door on the long wall facing +faceZ.
function gableBuilding(ctx, B, o) {
  const { x, z, w, d, eave, ridge, wall, roof, faceZ } = o;
  const yaw = faceZ > 0 ? -Math.PI / 2 : Math.PI / 2, hd = d / 2, rl = w + 1.4;
  const prof = [[-hd, 0], [hd, 0], [hd, eave], [0, ridge], [-hd, eave]];
  const L = [prism(prof, w, wall, shade(wall, 0.97), shade(wall, 0.97))];
  L.push(slab(hd, eave, 0, ridge, rl, 0.42, roof, 1.1), slab(0, ridge, -hd, eave, rl, 0.42, roof, 1.1));
  L.push(tube(0, ridge + 0.32, -rl / 2 + 0.1, 0, ridge + 0.32, rl / 2 - 0.1, 0.26, shade(roof, 0.82), 6));
  L.push(rb(d + 0.3, 0.3, w + 0.3, 0x8f8b82, 0, 0.15, 0, 0, 0, 0, 0.1));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) L.push(pole(sx * (hd + 0.02), sz * (w / 2 + 0.02), 0.15, eave + 0.1, o.cornerHex || WOOD_L));
  B.push(place(L, x, 0, z, yaw));
  const fz = z + faceZ * (hd + 0.04);
  for (const dr of o.doors || []) {
    B.push(rb(dr.w + 0.4, dr.h + 0.25, 0.14, TRIM, x + dr.x, (dr.h + 0.25) / 2, fz, 0, 0, 0, 0.05));
    B.push(rb(dr.w, dr.h, 0.16, dr.hex || WOOD_D, x + dr.x, dr.h / 2, fz + faceZ * 0.03, 0, 0, 0, 0.05));
    if (dr.half) B.push(rb(dr.w - 0.25, dr.h * 0.38, 0.18, DARK, x + dr.x, dr.h * 0.72, fz + faceZ * 0.05, 0, 0, 0, 0.05));
  }
  for (const wi of o.windows || []) window_(ctx, B, x + wi.x, wi.y, fz + faceZ * 0.03, wi.w, wi.h, faceZ > 0 ? 0 : Math.PI);
}

// arched (gambrel-like) profile: rounded quarter ellipses meeting at the ridge
function archProf(hw, eaveY, topY, n) {
  const R = [], Lf = [];
  for (let k = 0; k <= n; k++) { const t = k / n * Math.PI / 2; R.push([hw * Math.cos(t), eaveY + (topY - eaveY) * Math.sin(t)]); }
  for (let k = n - 1; k >= 0; k--) Lf.push([-R[k][0], R[k][1]]);
  return [[-hw, 0], [hw, 0], ...R, ...Lf];
}

// ------------------------------------------------------------------ main builders
function buildBuildings(ctx) {
  const S = ctx.S, B = ctx.B;
  // ---- BARN (ridge along X, arched dark roof, gable faces +x)
  {
    const b = BUILDINGS.BARN, len = b.x1 - b.x0, ox = (b.x0 + b.x1) / 2, oz = (b.z0 + b.z1) / 2, yaw = Math.PI / 2;
    const WALL = 0x9a6b4a, WALL_D = 0x7e5338, hz = len / 2;
    const arch = archProf(10, 3.2, 7.0, 4);
    const L = [prism(arch, len, WALL, WALL, WALL)];
    const nA = arch.length;
    for (let i = 2; i < nA - 1; i++) { const a = arch[i], c = arch[i + 1]; L.push(slab(a[0], a[1], c[0], c[1], len + 2.4, 0.5, ROOF_DK, 0.7)); }
    L.push(tube(0, 7.55, -len / 2 - 1.0, 0, 7.55, len / 2 + 1.0, 0.3, ROOF_DK2, 6));
    L.push(rb(21, 0.3, len + 0.3, 0x8f8b82, 0, 0.15, 0, 0, 0, 0, 0.1));
    // corner posts
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) L.push(pole(sx * 10.02, sz * (hz + 0.02), 0.2, 3.5, WOOD_L));
    // front doors with trim braces
    for (const sx of [-1, 1]) {
      L.push(rb(2.7, 4.2, 0.16, WALL_D, sx * 1.4, 2.1, hz + 0.06, 0, 0, 0, 0.07));
      const ang = Math.atan2(2.7, 4.2);
      L.push(box(0.22, Math.hypot(2.7, 4.2) - 0.4, 0.14, TRIM, sx * 1.4, 2.1, hz + 0.16, 0, 0, sx * ang));
    }
    L.push(rb(5.9, 0.3, 0.2, TRIM, 0, 4.3, hz + 0.12, 0, 0, 0, 0.06), rb(0.3, 4.3, 0.2, TRIM, -2.95, 2.15, hz + 0.12, 0, 0, 0, 0.06), rb(0.3, 4.3, 0.2, TRIM, 2.95, 2.15, hz + 0.12, 0, 0, 0, 0.06), rb(0.22, 4.2, 0.2, TRIM, 0, 2.1, hz + 0.12, 0, 0, 0, 0.06));
    L.push(rb(2.0, 2.0, 0.14, WALL_D, 0, 5.3, hz + 0.06, 0, 0, 0, 0.06), rb(2.4, 0.22, 0.2, TRIM, 0, 6.38, hz + 0.12, 0, 0, 0, 0.05), rb(2.4, 0.22, 0.2, TRIM, 0, 4.22, hz + 0.12, 0, 0, 0, 0.05), rb(0.22, 2.2, 0.2, TRIM, -1.2, 5.3, hz + 0.12, 0, 0, 0, 0.05), rb(0.22, 2.2, 0.2, TRIM, 1.2, 5.3, hz + 0.12, 0, 0, 0, 0.05));
    L.push(rb(0.25, 0.25, 1.5, WOOD_D, 0, 6.75, hz + 0.75, 0, 0, 0, 0.08), tube(0, 6.4, hz + 1.4, 0, 6.7, hz + 1.4, 0.07, 0x333333, 5));
    // cupola + vane
    L.push(rb(1.6, 1.2, 1.6, TRIM, 0, 7.95, 0, 0, 0, 0, 0.18), cone(1.5, 1.2, 6, ROOF_DK, 0, 9.15, 0), tube(0, 9.5, 0, 0, 10.6, 0, 0.05, 0x2a2a2a, 4), box(0.9, 0.1, 0.07, 0x2a2a2a, 0, 10.7, 0), box(0.14, 0.4, 0.07, 0xa8483a, 0.42, 10.7, 0));
    // side-wall panels
    for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) {
      const zz = -len / 2 + 2.4 + i * (len - 4.8) / 2;
      L.push(rb(0.14, 1.7, 1.9, WALL_D, sx * 10.04, 1.9, zz, 0, 0, 0, 0.06), box(0.16, 2.0, 0.14, TRIM, sx * 10.1, 1.9, zz - 1.0), box(0.16, 2.0, 0.14, TRIM, sx * 10.1, 1.9, zz + 1.0));
    }
    B.push(place(L, ox, 0, oz, yaw));
    const [gx, gz] = loc(ox, oz, yaw, 0, hz + 0.1);
    glow(ctx, gx + 0.02, 5.3, gz, 1.6, 1.6, 0.05, Math.PI / 2, 0);
    // yard clutter by the barn front: strapped bales, crates, barrels
    S.push(hayBale(HAY_TAN, -138.7, 0.55, -8.2, 0.1), hayBale(HAY_GRN, -138.5, 0.55, -6.6, -0.05), hayBale(HAY_TAN, -138.6, 1.6, -7.4, 0.05));
    crate(S, -138.8, 0, 6.2, 0.1); crate(S, -138.7, 0, 7.3, -0.1); crate(S, -138.75, 0.8, 6.7, 0.3, 0.9);
    barrel(S, -139.2, 9.0); barrel(S, -138.3, 8.4); sack(S, -138.3, 5.6, 0.3); sack(S, -137.7, 5.1, 1.0);
    blocker(ctx, -148, 0, 9, 11, 0);
  }
  // ---- SILO (rounded, banded, dark dome)
  {
    const b = BUILDINGS.SILO, x = b.x, z = b.z, r = b.r;
    B.push(smoothen(lathe([[r, 0.0], [r, 14], [r * 0.98, 14.3]], 12, 0xcfc8b4, 1, 1, x, 0, z)), lathe([[r + 0.45, 0], [r + 0.45, 0.45], [r, 0.5]], 14, 0x8f8b82, 1, 1, x, 0, z));
    for (let y = 2; y < 14; y += 2.4) B.push(lathe([[r + 0.12, y - 0.1], [r + 0.12, y + 0.1]], 12, 0x9a9488, 1, 1, x, 0, z));
    B.push(smoothen(lathe([[r + 0.5, 14.0], [r + 0.4, 14.5], [r * 0.7, 16.0], [r * 0.3, 17.0], [0, 17.3]], 12, ROOF_DK, 1, 1, x, 0, z)), tube(x, 17.2, z, x, 18.2, z, 0.2, 0x555b60, 6));
    for (const sz of [-1, 1]) B.push(tube(x + r + 0.08, 0.2, z + sz * 0.32, x + r + 0.08, 13.0, z + sz * 0.32, 0.05, 0x5a5f64, 4));
    for (let y = 1; y < 13; y += 1) B.push(tube(x + r + 0.08, y, z - 0.32, x + r + 0.08, y, z + 0.32, 0.035, 0x5a5f64, 4));
    blocker(ctx, x, z, 0, 0, r + 0.8);
  }
  // ---- FARMHOUSE (ridge along Z, door on +x long wall)
  {
    const b = BUILDINGS.FARMHOUSE, ox = (b.x0 + b.x1) / 2, oz = (b.z0 + b.z1) / 2;
    const WALL = 0xd6c79f, ROOF = 0x9c5c44;
    const prof = [[-8, 0], [8, 0], [8, 3.2], [0, 6.2], [-8, 3.2]];
    const L = [prism(prof, 16, WALL, WALL, WALL)];
    L.push(slab(8, 3.2, 0, 6.2, 18.6, 0.5, ROOF, 1.3), slab(0, 6.2, -8, 3.2, 18.6, 0.5, ROOF, 1.3), tube(0, 6.55, -9.2, 0, 6.55, 9.2, 0.32, shade(ROOF, 0.8), 6));
    L.push(rb(16.3, 0.4, 16.3, 0x8f8b82, 0, 0.2, 0, 0, 0, 0, 0.12));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) L.push(pole(sx * 8.0, sz * 8.0, 0.25, 3.4, WOOD_L));
    L.push(rb(1.6, 3.4, 1.6, 0xa8644c, -2, 6.0, -3, 0, 0, 0, 0.14), rb(2.0, 0.4, 2.0, 0x7e4a3a, -2, 7.8, -3, 0, 0, 0, 0.12));
    for (const sz of [-1, 1]) {
      L.push(rb(1.2, 1.4, 0.14, TRIM, 0, 2.0, sz * 8.04, 0, 0, 0, 0.05), box(0.9, 1.1, 0.08, 0x8eb0c4, 0, 2.0, sz * 8.12));
      L.push(rb(1.1, 1.1, 0.14, TRIM, 0, 4.2, sz * 8.04, 0, 0, 0, 0.05), box(0.8, 0.8, 0.08, 0x8eb0c4, 0, 4.2, sz * 8.12));
    }
    B.push(place(L, ox, 0, oz, 0));
    const fx = b.x1 + 0.04;
    B.push(rb(0.14, 2.4, 1.6, TRIM, fx, 1.2, oz, 0, 0, 0, 0.05), rb(0.16, 2.1, 1.2, 0x4a6e52, fx + 0.04, 1.05, oz, 0, 0, 0, 0.05), blob(0.08, 0xc4a02a, fx + 0.14, 1.05, oz - 0.4));
    B.push(rb(3.2, 0.24, 5.4, 0x9a7a52, fx + 1.6, 0.25, oz, 0, 0, 0, 0.09));
    B.push(pole(fx + 3.0, oz - 2.5, 0.14, 2.8, WOOD_L), pole(fx + 3.0, oz + 2.5, 0.14, 2.8, WOOD_L));
    B.push(place([slab(0, 2.95, 3.4, 2.4, 6.2, 0.3, ROOF, 0.3)], fx - 0.1, 0, oz, 0));
    for (const wz of [-4.6, 4.6]) window_(ctx, B, fx + 0.02, 2.0, oz + wz, 1.3, 1.3, Math.PI / 2);
    for (const sz of [-6.2, 6.2]) {
      S.push(rb(0.7, 0.28, 3.2, WOOD_D, fx + 0.5, 0.14, oz + sz, 0, 0, 0, 0.1));
      for (let i = 0; i < 6; i++) S.push(blob(0.17, [0xd9779a, 0xe6cf6a, 0xf0ece0, 0xd98a56][i % 4], fx + 0.5, 0.38, oz + sz - 1.2 + i * 0.48));
    }
    // bench (night REST spot)
    S.push(rb(0.6, 0.12, 5.2, 0x9a6f3f, -134.5, 0.5, -44, 0, 0, 0, 0.05), rb(0.12, 0.7, 5.2, 0x9a6f3f, -134.0, 0.85, -44, 0, 0, 0, 0.05));
    for (const dz of [-2.4, 0, 2.4]) S.push(rb(0.5, 0.5, 0.14, 0x6a4a2a, -134.5, 0.25, -44 + dz, 0, 0, 0, 0.05));
    blocker(ctx, ox, oz, 9, 9, 0);
  }
  // ---- STOREHOUSE (ridge along X, gable faces -x)
  {
    const b = BUILDINGS.STOREHOUSE, ox = (b.x0 + b.x1) / 2, oz = 0, yaw = -Math.PI / 2, len = 16, hz = 8;
    const WALL = 0xa98657, ROOF = 0x4f6a58;
    const prof = [[-10, 0], [10, 0], [10, 3.6], [0, 6], [-10, 3.6]];
    const L = [prism(prof, len, WALL, WALL, WALL)];
    L.push(slab(10, 3.6, 0, 6, len + 2.4, 0.5, ROOF, 1.2), slab(0, 6, -10, 3.6, len + 2.4, 0.5, ROOF, 1.2), tube(0, 6.35, -len / 2 - 1.1, 0, 6.35, len / 2 + 1.1, 0.3, shade(ROOF, 0.8), 6));
    L.push(rb(20.3, 0.36, len + 0.3, 0x8f8b82, 0, 0.18, 0, 0, 0, 0, 0.12));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) L.push(pole(sx * 10.0, sz * (hz + 0.02), 0.22, 3.8, WOOD_L));
    L.push(rb(4.7, 3.6, 0.18, TRIM, 0, 1.8, hz + 0.05, 0, 0, 0, 0.06), rb(4.2, 3.3, 0.2, 0x6c7f86, 0, 1.65, hz + 0.1, 0, 0, 0, 0.06));
    for (let i = -6; i <= 6; i += 2) L.push(box(0.07, 3.3, 0.05, 0x55696f, i * 0.32, 1.65, hz + 0.22));
    L.push(rb(3.4, 0.9, 0.18, 0xe8dfc2, 0, 4.4, hz + 0.1, 0, 0, 0, 0.06), blob(0.26, 0xe0b23a, -0.8, 4.4, hz + 0.25, 1, 0.8, 0.3), blob(0.22, 0xf0f0e8, 0.2, 4.4, hz + 0.25, 0.8, 1, 0.3), box(0.4, 0.5, 0.1, 0x4a82b0, 1.0, 4.4, hz + 0.22));
    for (const sx of [-1, 1]) for (const zz of [-4.5, 0, 4.5]) L.push(rb(0.14, 1.1, 1.5, 0xaebfc4, sx * 10.05, 2.6, zz, 0, 0, 0, 0.05));
    B.push(place(L, ox, 0, oz, yaw));
    // crates, sacks and strapped bales by the door
    for (const [cz, n] of [[-6.2, 3], [6.5, 2]]) for (let i = 0; i < n; i++) crate(S, 138.8, i * 0.8, cz + (i % 2) * 0.12, 0.1 * i);
    S.push(hayBale(HAY_GRN, 138.9, 0.55, -9.0, 0.05), hayBale(HAY_TAN, 138.8, 0.55, 9.0, -0.05), hayBale(HAY_GRN, 138.85, 1.6, 9.0, 0.1));
    sack(S, 138.4, 11.2, 0.5); sack(S, 139.1, 11.9, 1.8); sack(S, 138.5, -11.0, 0.2); barrel(S, 139.0, -12.4); barrel(S, 139.2, 13.2);
    blocker(ctx, ox, 0, 9, 11, 0);
  }
  // ---- VET SHED
  {
    const b = BUILDINGS.VET_SHED, ox = (b.x0 + b.x1) / 2, oz = (b.z0 + b.z1) / 2, yaw = -Math.PI / 2, len = 12, hz = 6;
    const WALL = 0xdcd2ba, ROOF = 0x4f8a88;
    const prof = [[-6, 0], [6, 0], [6, 2.4], [0, 3.5], [-6, 2.4]];
    const L = [prism(prof, len, WALL, WALL, WALL)];
    L.push(slab(6, 2.4, 0, 3.5, len + 1.9, 0.42, ROOF, 0.9), slab(0, 3.5, -6, 2.4, len + 1.9, 0.42, ROOF, 0.9), tube(0, 3.8, -len / 2 - 0.9, 0, 3.8, len / 2 + 0.9, 0.26, shade(ROOF, 0.8), 6));
    L.push(rb(12.3, 0.3, len + 0.3, 0x8f8b82, 0, 0.15, 0, 0, 0, 0, 0.1));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) L.push(pole(sx * 6.0, sz * (hz + 0.02), 0.18, 2.5, WOOD_L));
    L.push(rb(2.1, 2.2, 0.16, TRIM, 0, 1.1, hz + 0.05, 0, 0, 0, 0.05), rb(1.7, 2.0, 0.16, 0x4a806a, 0, 1.0, hz + 0.1, 0, 0, 0, 0.05));
    L.push(rb(0.4, 1.2, 0.16, 0xb04a44, 0, 2.95, hz + 0.1, 0, 0, 0, 0.05), rb(1.2, 0.4, 0.16, 0xb04a44, 0, 2.95, hz + 0.1, 0, 0, 0, 0.05));
    B.push(place(L, ox, 0, oz, yaw));
    const fx = b.x0 - 0.06;
    window_(ctx, B, fx, 1.5, oz - 3.8, 1.2, 1.1, -Math.PI / 2);
    window_(ctx, B, fx, 1.5, oz + 3.8, 1.2, 1.1, -Math.PI / 2);
    S.push(rb(0.5, 0.5, 0.5, 0xb04a44, fx - 0.4, 0.25, oz + 4.8, 0, 0, 0, 0.1));
    blocker(ctx, ox, oz, 7, 7, 0);
  }
  // ---- COMPOST (open bin, opening toward -x)
  {
    const b = BUILDINGS.COMPOST, ox = (b.x0 + b.x1) / 2, oz = (b.z0 + b.z1) / 2;
    const W_ = 0x8a6b45;
    for (let i = 0; i < 3; i++) {
      const y = 0.22 + i * 0.36;
      S.push(rb(0.22, 0.32, b.z1 - b.z0, W_, b.x1 - 0.11, y, oz, 0, 0, 0, 0.08), rb(b.x1 - b.x0, 0.32, 0.22, W_, ox, y, b.z0 + 0.11, 0, 0, 0, 0.08), rb(b.x1 - b.x0, 0.32, 0.22, W_, ox, y, b.z1 - 0.11, 0, 0, 0, 0.08));
    }
    for (const [px, pz] of [[b.x1 - 0.12, b.z0 + 0.12], [b.x1 - 0.12, b.z1 - 0.12], [b.x0 + 0.12, b.z0 + 0.12], [b.x0 + 0.12, b.z1 - 0.12]]) S.push(pole(px, pz, 0.2, 1.3, 0x5d4630));
    S.push(rb(b.x1 - b.x0 - 0.5, 0.2, b.z1 - b.z0 - 0.5, 0x3d2a1c, ox, 0.1, oz, 0, 0, 0, 0.06));
    const rng = ctx.rng;
    for (let i = 0; i < 7; i++) { const s = 1.0 + rng() * 0.8; S.push(smoothen(ell(s * 1.1, s * 0.5, s, i % 3 ? 0x4a3322 : 0x5a4530, ox + 1.5 + (rng() - 0.3) * 5, 0.4, oz + (rng() - 0.5) * 6, 7, 3))); }
    for (let i = 0; i < 5; i++) S.push(blob(0.28, [0x7aa63e, 0xd9b84a, 0xb35a2a][i % 3], ox + (rng() - 0.3) * 6, 1.0 + rng() * 0.2, oz + (rng() - 0.5) * 6));
    S.push(tube(b.x0 - 0.5, 0.0, b.z0 + 1, b.x0 - 0.35, 2.0, b.z0 + 1, 0.05, WOOD_L, 5), box(0.5, 0.06, 0.06, 0x666666, b.x0 - 0.4, 1.95, b.z0 + 1));
    blocker(ctx, ox, oz, 6, 6, 0);
  }
  // ---- WELL
  {
    const b = BUILDINGS.WELL, x = b.x, z = b.z;
    B.push(smoothen(lathe([[1.25, 0], [1.35, 0.4], [1.3, 0.95], [1.38, 1.02], [1.38, 1.12], [0.95, 1.12]], 10, 0x9d9a90, 1, 1, x, 0, z)), cyl(0.95, 0.95, 0.04, 10, 0x1f3d58, x, 0.93, z));
    for (const sx of [-1, 1]) B.push(pole(x + sx * 1.05, z, 0.12, 2.8, WOOD_D));
    B.push(tube(x - 1.1, 2.3, z, x + 1.1, 2.3, z, 0.08, WOOD_L, 6), tube(x + 0.5, 2.3, z, x + 0.9, 2.3, z, 0.12, 0x888888, 6));
    B.push(place([slab(-1.5, 2.55, 0, 3.2, 2.8, 0.3, ROOF_DK, 0.5), slab(0, 3.2, 1.5, 2.55, 2.8, 0.3, ROOF_DK, 0.5), tube(0, 3.55, -1.3, 0, 3.55, 1.3, 0.14, ROOF_DK2, 5)], x, 0, z, 0));
    bucket(S, x + 0.2, z + 1.8, 0x8a7a68);
    blocker(ctx, x, z, 0, 0, 1.8);
  }
}

function lamps(ctx) {
  const S = ctx.S;
  for (let x = -126; x <= 126; x += 21) {
    if (Math.abs(x) < 20) continue;
    const z = -5.0;
    S.push(pole(x, z, 0.12, 3.2, 0x3d3a38), tube(x, 3.2, z, x, 3.2, z + 0.15, 0.06, 0x3d3a38, 5), cone(0.38, 0.28, 6, 0x3d3a38, x, 3.55, z));
    glow(ctx, x, 3.27, z, 0.3, 0.3, 0.3, 0, 1);
  }
}

// chicken coop: brown box, big tan roof with soft overhang, pop door + cleated ramp, nest boxes on the side
function coop(ctx, S, B, f, faceZ) {
  const { x, z } = f;
  gableBuilding(ctx, B, { x, z, w: f.w, d: f.d, eave: 2.3, ridge: 3.5, wall: 0x93694a, roof: 0xb48a5e, faceZ, cornerHex: WOOD_L,
    doors: [{ x: -1.4, w: 1.1, h: 1.9, hex: 0x6c4630 }], windows: [{ x: 1.4, y: 1.7, w: 1.2, h: 0.9 }] });
  B.push(rb(0.9, 0.9, 0.14, DARK, x + 2.6, 0.95, z + faceZ * (f.d / 2 + 0.05), 0, 0, 0, 0.12));
  B.push(rb(0.9, 0.12, 2.8, 0xa07a4c, x + 2.6, 0.5, z + faceZ * (f.d / 2 + 1.2), faceZ * 0.38, 0, 0, 0.05));
  for (let i = 0; i < 4; i++) S.push(rb(0.9, 0.08, 0.1, 0x5a3a1c, x + 2.6, 0.38 + i * 0.1 + 0.1, z + faceZ * (f.d / 2 + 0.55 + i * 0.5), 0, 0, 0, 0.03));
  for (let i = 0; i < 3; i++) B.push(rb(1.0, 0.8, 0.9, WOOD_L, x - f.w / 2 - 0.55, 0.9, z + (i - 1) * 1.1, 0, 0, 0, 0.12), rb(1.2, 0.12, 1.1, 0x6a4a2a, x - f.w / 2 - 0.6, 1.36, z + (i - 1) * 1.1, 0, 0, 0, 0.05));
  blocker(ctx, x, z, f.w / 2 + 2, f.d / 2 + 2.5, 0);
}

// ------------------------------------------------------------------ pens
function buildPens(ctx) {
  const S = ctx.S, B = ctx.B, rng = ctx.rng;
  for (const P of PENS) {
    const faceZ = -P.s, gx = P.cx;
    // fences
    fenceZ(S, P.x0, P.z0, P.z1); fenceZ(S, P.x1, P.z0, P.z1);
    const far = P.s < 0 ? P.z0 : P.z1;
    fenceX(S, P.x0, P.x1, far);
    fenceX(S, P.x0, gx - 2, P.gateEdgeZ); fenceX(S, gx + 2, P.x1, P.gateEdgeZ);
    // chunky gate posts with round caps (animated double gate hangs between them)
    for (const sx of [-2, 2]) S.push(pole(gx + sx, P.gateEdgeZ, 0.3, 1.55, 0x80583a), smoothen(ell(0.36, 0.3, 0.36, 0xb2644a, gx + sx, 1.7, P.gateEdgeZ, 6, 3)));
    // sign post
    const sp = SPECIES[P.species], sx = gx + 3.6, sz = P.gateEdgeZ - P.s * 1.4;
    S.push(pole(sx, sz, 0.09, 1.9, WOOD_D), rb(1.5, 0.8, 0.12, 0xe4dcc4, sx, 1.9, sz, 0, 0, 0, 0.06), rb(1.5, 0.28, 0.14, sp.color2 ? shade(sp.color2, 0.85) : 0x884422, sx, 2.16, sz, 0, 0, 0, 0.06), smoothen(ell(0.2, 0.2, 0.1, sp.color, sx, 1.78, sz - P.s * 0.08, 6, 3)));
    // pen decor: a crate/sack stack and a strapped bale tucked into the gate-side corners (clear of every sleep / feature area)
    {
      const dz = P.gateEdgeZ + P.s * 2.4, ex = P.x0 + 2.2, wx = P.x1 - 2.2;
      crate(S, ex, 0, dz, 0.2); crate(S, ex + 1.1, 0, dz + P.s * 0.2, -0.1); crate(S, ex + 0.5, 0.8, dz + P.s * 0.1, 0.4, 0.9); sack(S, ex + 2.2, dz, 0.6); sack(S, ex + 2.9, dz + P.s * 0.4, 1.4);
      S.push(hayBale(P.id % 2 ? HAY_TAN : HAY_GRN, wx, 0.55, dz, P.id * 0.3), hayBale(P.id % 2 ? HAY_GRN : HAY_TAN, wx - 1.3, 0.55, dz + P.s * 0.3, -P.id * 0.2 + 0.5));
    }
    // features
    for (const f of P.features) {
      const x = f.x, z = f.z;
      switch (f.kind) {
        case K.FEED_TROUGH: trough(ctx, S, P.id, f, 'feed'); break;
        case K.WATER_TROUGH: trough(ctx, S, P.id, f, 'water'); break;
        case K.HAY_FEEDER: hayFeeder(ctx, S, P.id, f); break;
        case K.COOP: coop(ctx, S, B, f, faceZ); break;
        case K.NEST: strawPatch(S, x, z, f.w, f.d); break;
        case K.DUST_BATH:
          for (let i = 0; i < 8; i++) { const a = i / 8 * 6.28 + rng() * 0.3; boulder(ctx.R, x + Math.cos(a) * (f.r + 0.6), z + Math.sin(a) * (f.r + 0.6), 0.28 + rng() * 0.14, rng, rng() * 3); }
          blocker(ctx, x, z, 0, 0, f.r + 0.5); break;
        case K.POND: {
          // the water / sand / dark rim polygons are painted in envTerrain from the sim's blob outline; here: pads, reeds and shore stones follow the same outline
          const ol = blobOutline(f, 44, 1), nO = 44;
          const at = (k, sc) => [f.x + (ol[k * 2] - f.x) * sc, f.z + (ol[k * 2 + 1] - f.z) * sc];
          for (let i = 0; i < 9; i++) {
            const [px, pz] = at((rng() * nO) | 0, 0.2 + rng() * 0.62), r = 0.55 + rng() * 0.3;
            S.push(smoothen(lathe([[0, 0.085], [r, 0.082], [r * 1.02, 0.07]], 9, 0x4f9e4e, 1, 1, px, 0, pz, 0, rng() * 3, 0)));
            if (i % 3 === 0) S.push(smoothen(ell(0.16, 0.12, 0.16, 0xf0b6c8, px + 0.1, 0.17, pz, 5, 2)));
          }
          for (let i = 0; i < 16; i++) {
            const k = (i / 16 * nO + rng() * 1.5) | 0, [px, pz] = at(k % nO, 1.06 + rng() * 0.12), h = 0.9 + rng() * 0.7;
            S.push(smoothen(lathe([[0.11, 0], [0.085, h * 0.6], [0, h]], 4, 0x5a9a44, 1, 1, px, 0, pz, 0.12, rng() * 6, 0)), smoothen(lathe([[0.09, 0], [0.065, h * 0.7], [0, h * 0.85]], 4, 0x6aac4c, 1, 1, px + 0.22, 0, pz + 0.1, -0.1, rng() * 6, 0)));
            if (i % 3 === 0) S.push(tube(px, 0, pz, px, h + 0.2, pz, 0.06, 0x7a4a2a, 5), smoothen(ell(0.1, 0.22, 0.1, 0x6a4326, px, h + 0.25, pz, 5, 3)));
          }
          for (let i = 0; i < 8; i++) { const [px, pz] = at((((i / 8 * nO) + rng() * 3) | 0) % nO, 1.2 + rng() * 0.05); boulder(ctx.R, px, pz, 0.45 + rng() * 0.4, rng, rng() * 3); }
          blocker(ctx, x, z, 0, 0, f.r + 1.5); break;
        }
        case K.DUCK_HOUSE:
          gableBuilding(ctx, B, { x, z, w: f.w, d: f.d, eave: 1.4, ridge: 2.1, wall: 0x9c7a52, roof: 0x6a8ca2, faceZ, cornerHex: WOOD_L,
            doors: [{ x: 1.0, w: 0.9, h: 1.0, hex: 0x4a3a2a }] });
          B.push(rb(0.9, 0.12, 2.0, 0xa07a4c, x + 1.0, 0.25, z + faceZ * (f.d / 2 + 1.0), faceZ * 0.25, 0, 0, 0.05));
          blocker(ctx, x, z, f.w / 2 + 1, f.d / 2 + 2, 0); break;
        case K.ROOST: {
          const n = 4;
          for (let i = 0; i < n; i++) {
            const px = x - f.w / 2 + 0.3 + i * (f.w - 0.6) / (n - 1);
            S.push(pole(px, z - 0.55, 0.1, f.h, WOOD_D), pole(px, z + 0.55, 0.1, f.h * 0.7, WOOD_D), tube(px, f.h * 0.98, z - 0.55, px, f.h * 0.72, z + 0.55, 0.07, WOOD_D, 5));
          }
          S.push(tube(x - f.w / 2, f.h, z - 0.55, x + f.w / 2, f.h, z - 0.55, 0.1, 0x8f6e46, 6), tube(x - f.w / 2, f.h * 0.7, z + 0.55, x + f.w / 2, f.h * 0.7, z + 0.55, 0.1, 0x8f6e46, 6));
          S.push(rb(f.w, 0.08, 1.8, 0xc4a85a, x, 0.04, z, 0, 0, 0, 0.03));
          break;
        }
        case K.SHELTER: {
          const wallC = P.id === 7 ? 0x9a6b4a : P.id === 2 ? 0xa88a5c : 0x9c7248;
          const roofC = P.id === 7 ? ROOF_DK : P.id === 5 ? 0x587a62 : P.id === 9 ? 0xa65e44 : 0x6e5a4a;
          openShed(ctx, S, B, f, faceZ, wallC, roofC); blocker(ctx, x, z, f.w / 2 + 0.5, f.d / 2 + 0.5, 0); break;
        }
        case K.HUTCH: {
          const n = 4, cw = f.w / n, legH = 0.45, bodyH = 0.75;
          for (let i = 0; i <= n; i++) S.push(pole(x - f.w / 2 + 0.1 + i * (f.w - 0.2) / n, z - f.d / 2 + 0.17, 0.09, legH, WOOD_D), pole(x - f.w / 2 + 0.1 + i * (f.w - 0.2) / n, z + f.d / 2 - 0.17, 0.09, legH, WOOD_D));
          B.push(rb(f.w, bodyH, f.d, 0xae8856, x, legH + bodyH / 2, z, 0, 0, 0, 0.1));
          const fz = z + faceZ * (f.d / 2 + 0.03);
          for (let i = 0; i < n; i++) {
            const cx = x - f.w / 2 + cw * (i + 0.5);
            B.push(rb(cw - 0.3, bodyH - 0.2, 0.1, 0x3a3a3a, cx, legH + bodyH / 2, fz, 0, 0, 0, 0.05), box(cw - 0.5, bodyH - 0.4, 0.07, 0x8c8c86, cx, legH + bodyH / 2, fz + faceZ * 0.03), box(cw - 0.25, 0.1, 0.1, TRIM, cx, legH + bodyH - 0.08, fz));
            B.push(blob(0.06, 0xc4a02a, cx + cw * 0.3, legH + bodyH / 2, fz + faceZ * 0.07));
          }
          const hy = legH + bodyH;
          B.push(place([slab(-f.d / 2 - 0.2, 0.0, f.d / 2 + 0.3, 0.3, f.w + 0.6, 0.2, 0x587a4a, 0.1)], x, hy + 0.0, z, faceZ > 0 ? -Math.PI / 2 : Math.PI / 2));
          S.push(rb(f.w - 0.4, 0.08, 1.2, STRAW, x, 0.04, z + faceZ * (f.d / 2 + 0.9), 0, 0, 0, 0.03));
          blocker(ctx, x, z, f.w / 2 + 0.5, f.d / 2 + 1.5, 0); break;
        }
        case K.BURROW: {
          S.push(smoothen(ell(f.r, f.r * 0.4, f.r, 0x7e5e3c, x, 0.0, z, 8, 4)), smoothen(ell(f.r * 0.55, f.r * 0.25, f.r * 0.55, 0x8d6c45, x - 0.3, 0.12, z + 0.2, 7, 3)));
          S.push(smoothen(ell(0.5, 0.38, 0.3, 0x120d09, x, 0.18, z + faceZ * 0.95, 7, 3)));
          for (let i = 0; i < 4; i++) { const a = rng() * 6.28; S.push(cone(0.06, 0.4, 3, 0x6a9a44, x + Math.cos(a) * 1.5, 0.2, z + Math.sin(a) * 1.5)); }
          blocker(ctx, x, z, 0, 0, f.r + 0.3); break;
        }
        case K.ROCK: {
          goatRock(ctx.R, f, rng);
          blocker(ctx, x, z, 0, 0, f.r + 0.3); break;
        }
        case K.BUSH: bush(S, x, z, f.r, rng); blocker(ctx, x, z, 0, 0, f.r + 0.3); break;
        case K.SHED:
          gableBuilding(ctx, B, { x, z, w: f.w, d: f.d, eave: 1.8, ridge: f.h, wall: 0xa27a4c, roof: 0x5e5f6c, faceZ, cornerHex: WOOD_L,
            doors: [{ x: 0, w: 1.8, h: 1.9, hex: 0x5a3f27, half: true }] });
          blocker(ctx, x, z, f.w / 2 + 0.5, f.d / 2 + 0.5, 0); break;
        case K.MUD_PIT: {
          // mud body / rim / puddles are painted in envTerrain from the blob outline; a few stones + a dried clod ring here
          const ol = blobOutline(f, 40, 1.22);
          for (let i = 0; i < 5; i++) { const k = (i * 8 + ((rng() * 5) | 0)) % 40; boulder(ctx.R, ol[k * 2] * 0.96 + f.x * 0.04, ol[k * 2 + 1] * 0.96 + f.z * 0.04, 0.3 + rng() * 0.2, rng, rng() * 3); }
          blocker(ctx, x, z, 0, 0, f.r + 1); break;
        }
        case K.PIG_ARK: {
          const pts = [];
          for (let k = 0; k <= 10; k++) { const a = k / 10 * Math.PI; pts.push([Math.cos(a) * f.w / 2, Math.sin(a) * f.h]); }
          const L = [prism(pts, f.d, 0x8ba397, 0x8ba397, 0x8ba397)];
          for (let i = 0; i < 5; i++) {
            const q = pts.map(p => [p[0] * 1.04, p[1] * 1.04]);
            L.push(place([prism(q, 0.2, 0x6f877e)], 0, 0, -f.d / 2 + 0.3 + i * (f.d - 0.6) / 4, 0));
          }
          B.push(place(L, x, 0, z, 0));
          const q = pts.map(p => [p[0] * 0.62, p[1] * 0.72]);
          B.push(place([prism(q, 0.12, 0x1d1510)], x, 0, z + faceZ * (f.d / 2 + 0.02), 0));
          S.push(rb(f.w - 0.2, 0.08, 2.4, STRAW, x, 0.04, z + faceZ * (f.d / 2 + 1.2), 0, 0, 0, 0.03));
          blocker(ctx, x, z, f.w / 2 + 0.5, f.d / 2 + 0.5, 0); break;
        }
        case K.STABLE:
          gableBuilding(ctx, B, { x, z, w: f.w, d: f.d, eave: 2.6, ridge: f.h, wall: 0x93653f, roof: 0x5e5f6c, faceZ, cornerHex: WOOD_L,
            doors: [{ x: -3.2, w: 1.6, h: 2.3, hex: 0x5a3622, half: true }, { x: 0, w: 1.6, h: 2.3, hex: 0x5a3622, half: true }, { x: 3.2, w: 1.6, h: 2.3, hex: 0x5a3622, half: true }],
            windows: [{ x: -1.6, y: 2.2, w: 0.6, h: 0.6 }, { x: 1.6, y: 2.2, w: 0.6, h: 0.6 }] });
          B.push(rb(f.w + 0.2, 0.22, 0.18, TRIM, x, 2.65, z + faceZ * (f.d / 2 + 0.08), 0, 0, 0, 0.06));
          glow(ctx, x, 2.9, z + faceZ * (f.d / 2 + 0.2), 0.25, 0.25, 0.25, 0, 1);
          blocker(ctx, x, z, f.w / 2 + 0.5, f.d / 2 + 0.5, 0); break;
        case K.DUNG_PILE:
          for (let i = 0; i < 6; i++) { const a = rng() * 6.28, d = rng() * f.r * 0.7, s = 0.5 + rng() * 0.4; S.push(smoothen(ell(s, s * 0.62, s, i % 2 ? 0x4e3926 : 0x5e4632, x + Math.cos(a) * d, 0.26, z + Math.sin(a) * d, 7, 3))); }
          blocker(ctx, x, z, 0, 0, f.r + 0.5); break;
        case K.TREE: buildTreeFeature(ctx, P, f, rng); break;
        default: biomeFeature(ctx, P, f, rng); break;
      }
    }
  }
}

// scarecrows along the road verge, tucked between road and pen fences (clear of gate paths, lamps and hubs)
function decorRoad(ctx) {
  const S = ctx.S;
  scarecrow(S, -74, 6.0, 0.3); scarecrow(S, 28, -6.2, -0.5); scarecrow(S, 82, 6.0, 0.9);
  for (const [x, z] of [[-74, 4.9], [28, -4.9], [82, 4.9]]) { S.push(smoothen(ell(0.5, 0.3, 0.5, 0x8d6c45, x + 0.9, 0.2, z + (z > 0 ? 1.4 : -1.4), 7, 3))); }
  // lonely crates / barrels at the pen-corner road ends
  crate(ctx.S, -118.5, 0, 6.2, 0.3); crate(ctx.S, 112.0, 0, -6.2, -0.2); barrel(ctx.S, 112.2, -5.0); barrel(ctx.S, -119.4, 5.0);
  ctx.S.push(hayBale(HAY_GRN, 117.5, 0.55, 5.8, 0.4));
}

export function buildCloud() {
  const L = [0xffffff, 0xf6f9ff, 0xe9f1fb];
  const rng = mulberry32(5), g = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const t = (i - (n - 1) / 2) / ((n - 1) / 2), r = 8 + (1 - Math.abs(t)) * 7 + rng() * 3;
    g.push(puff(r, L[i % 3], t * 24, (1 - Math.abs(t)) * 6 + rng() * 1.5, (rng() - 0.5) * 6, 1.1, 0.78, 1, 0.1));
  }
  g.push(puff(9, L[1], -8, 12, 2, 1, 0.7, 1, 0.1), puff(8, L[0], 7, 13, -2, 1, 0.7, 1, 0.1));
  return merge(g);
}

// dynamic hay-bale mesh for the round feeders: squat rounded cylinder, base at y=0, r=1, h=1, brown straps (tint gives hay colour)
export function buildFeederBale() {
  const body = smoothen(lathe([[0, 0], [0.86, 0], [1, 0.12], [1, 0.88], [0.86, 1], [0, 1]], 10, 0xffffff));
  const st = [];
  for (const y of [0.28, 0.72]) st.push(lathe([[1.035, y - 0.06], [1.035, y + 0.06]], 10, 0x8a6a4a));
  return merge([body, ...st]);
}

// ---- debug: reference-style props lineup (floating at y=1000 so it can be photographed against the sky). Returns {props,bldg,scatter,trees}
export function buildLineup() {
  const ctx = createCtx(), S = [], B = [], rng = mulberry32(99);
  const Y = 1000; let x = -42;
  const nx = (dx = 5) => (x += dx);
  coop(ctx, S, B, { x: nx(0), z: 0, w: 8, d: 6 }, 1);
  gableBuilding(ctx, B, { x: nx(11), z: 0, w: 6, d: 5, eave: 1.8, ridge: 2.9, wall: 0xa27a4c, roof: 0x5e5f6c, faceZ: 1, cornerHex: WOOD_L, doors: [{ x: 0, w: 1.8, h: 1.9, hex: 0x5a3f27, half: true }] });
  fenceRun(S, nx(8), 0, x + 5, 0); x += 5;
  { const t = { x: nx(7), z: 0, w: 4, d: 1 }; const c2 = { troughs: [] }; trough(c2, S, 0, t, 'feed');
    S.push(rb(t.w - 0.3, 0.26, t.d - 0.3, 0x99b838, t.x, 0.43, t.z, 0, 0, 0, 0.05)); }
  { const t = { x: nx(6), z: 0, w: 4, d: 1 }; const c2 = { troughs: [] }; trough(c2, S, 0, t, 'water');
    S.push(rb(t.w - 0.3, 0.26, t.d - 0.3, 0xcfe6f2, t.x, 0.43, t.z, 0, 0, 0, 0.05)); }
  nx(5); sack(S, x, 0); nx(1.6); S.push(hayBale(HAY_GRN, nx(2.5), 0.55, 0, 0.1)); S.push(hayBale(HAY_TAN, nx(3), 0.55, 0, -0.1));
  nx(3); crate(S, x, 0, 0, 0.2); crate(S, nx(1.6), 0, 0, -0.3, 0.8); barrel(S, nx(1.6), 0); bucket(S, nx(1.4), 0);
  scarecrow(S, nx(2.6), 0, 0);
  const TL = [], RL = [];
  chunkyTree(TL, nx(5), 0, 1.0, rng, 0, false); chunkyTree(TL, nx(8), 0, 1.0, rng, 2, false); chunkyTree(TL, nx(8), 0, 1.0, rng, 4, false); chunkyTree(TL, nx(8), 0, 1.0, rng, 1, false);
  boulder(RL, nx(7), 0, 1.4, rng, 0.3); boulder(RL, nx(5), 0, 0.7, rng, 1);
  // feeder bale on its ring
  hayFeeder({ bales: [] }, S, 0, { x: nx(5), z: 0, r: 1.4 }); S.push(hayBale(HAY_TAN, x, 0.55, 0, 0));
  const lift = g => { const o = place([g], 0, Y, 0, 0); return o; };
  return { props: lift(merge(S)), bldg: lift(merge(B)), scatter: lift(merge(RL)), trees: lift(merge(TL)), Y };
}

export function buildAll() {
  const ctx = createCtx();
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  buildBuildings(ctx);
  lamps(ctx);
  buildPens(ctx);
  decorRoad(ctx);
  const gr = buildGround(ctx, (gb, stones, pebbles) => paintBiomeGround(ctx, gb, stones, pebbles));
  const ground = gr.ground, hills = buildHills();
  const sc = buildScatter(ctx, gr.stones, gr.pebbles);   // rocks (incl. pen rocks in ctx.R), outlined plants, plain small scatter
  const props = merge(ctx.S), bldg = merge(ctx.B);
  const trees = buildTrees(ctx);
  if (ctx.T.length) trees.geo = merge([trees.geo, ...ctx.T]);
  ctx.timeMs = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
  return { ctx, ground, hills, bldg, props, rocks: sc.R, plants: sc.plants, scatter: sc.small, trees: trees.geo, treeCount: trees.count + ctx.T.length, steam: ctx.steam };
}
