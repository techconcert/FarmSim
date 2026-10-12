// Low-poly geometry builders. Pure JS (no DOM/GL).
// Geo = { pos:Float32Array, nrm:Float32Array, col:Float32Array, count }  (count = vertex count, non-indexed triangles, CCW front faces,
// flat normals per face, vertex colour = hex/255 per channel, no gamma).
//
// POSITIONING: box(), cyl(), cone(), blob() are all positioned by their CENTRE at (x,y,z):
//   box: spans y-h/2..y+h/2;  cyl: y-h/2..y+h/2 (top radius rt, bottom radius rb);  cone: base at y-h/2, apex at y+h/2;
//   blob: ellipsoid centred at (x,y,z).
// Optional rx,ry,rz rotate the primitive about its own centre (order Ry*Rx*Rz, radians) BEFORE translating to (x,y,z).
// quad(w,d,hex,x,y,z): horizontal (normal +Y) rectangle w along X, d along Z, centred at (x,y,z).
// merge(geos[]) concatenates.

class Builder {
  constructor() { this.p = []; this.c = []; }
}
function rotMat(rx, ry, rz) {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  // R = Ry * Rx * Rz (row-major 3x3)
  return [
    cy*cz + sy*sx*sz, -cy*sz + sy*sx*cz, sy*cx,
    cx*sz,            cx*cz,             -sx,
    -sy*cz + cy*sx*sz, sy*sz + cy*sx*cz, cy*cx,
  ];
}
function hexRGB(hex) { return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]; }

// transform helper bound to a primitive: local point -> world
function xform(x, y, z, rx, ry, rz) {
  const R = (rx || ry || rz) ? rotMat(rx, ry, rz) : null;
  return (px, py, pz) => R
    ? [R[0]*px + R[1]*py + R[2]*pz + x, R[3]*px + R[4]*py + R[5]*pz + y, R[6]*px + R[7]*py + R[8]*pz + z]
    : [px + x, py + y, pz + z];
}
function tri(B, a, b, c, rgb) {
  B.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  B.c.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
}
function finish(B) {
  const n = B.p.length / 3, pos = new Float32Array(B.p), col = new Float32Array(B.c), nrm = new Float32Array(B.p.length);
  for (let i = 0; i < n; i += 3) {
    const o = i * 3;
    const ux = pos[o+3]-pos[o], uy = pos[o+4]-pos[o+1], uz = pos[o+5]-pos[o+2];
    const vx = pos[o+6]-pos[o], vy = pos[o+7]-pos[o+1], vz = pos[o+8]-pos[o+2];
    let nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (let k = 0; k < 3; k++) { nrm[o+k*3] = nx; nrm[o+k*3+1] = ny; nrm[o+k*3+2] = nz; }
  }
  return { pos, nrm, col, count: n };
}
function quadTris(B, a, b, c, d, rgb) { tri(B, a, b, c, rgb); tri(B, a, c, d, rgb); }

export function box(w, h, d, hex, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const B = new Builder(), T = xform(x, y, z, rx, ry, rz), rgb = hexRGB(hex);
  const hw = w / 2, hh = h / 2, hd = d / 2;
  // faces: centre, u axis, v axis with u x v = outward normal
  const faces = [
    [[0,0,hd],[hw,0,0],[0,hh,0]],   // +Z
    [[0,0,-hd],[0,hh,0],[hw,0,0]],  // -Z
    [[hw,0,0],[0,hh,0],[0,0,hd]],   // +X
    [[-hw,0,0],[0,0,hd],[0,hh,0]],  // -X
    [[0,hh,0],[0,0,hd],[hw,0,0]],   // +Y
    [[0,-hh,0],[hw,0,0],[0,0,hd]],  // -Y
  ];
  for (const [c, u, v] of faces) {
    const P = (su, sv) => T(c[0]+u[0]*su+v[0]*sv, c[1]+u[1]*su+v[1]*sv, c[2]+u[2]*su+v[2]*sv);
    quadTris(B, P(-1,-1), P(1,-1), P(1,1), P(-1,1), rgb);
  }
  return finish(B);
}

export function cyl(rt, rb, h, seg, hex, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const B = new Builder(), T = xform(x, y, z, rx, ry, rz), rgb = hexRGB(hex);
  const hh = h / 2;
  for (let i = 0; i < seg; i++) {
    const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
    const s0 = Math.sin(a0), c0 = Math.cos(a0), s1 = Math.sin(a1), c1 = Math.cos(a1);
    const t0 = T(s0*rt, hh, c0*rt), t1 = T(s1*rt, hh, c1*rt), b0 = T(s0*rb, -hh, c0*rb), b1 = T(s1*rb, -hh, c1*rb);
    // outward-facing CCW (viewed from outside)
    if (rt > 0 && rb > 0) quadTris(B, b0, b1, t1, t0, rgb);
    else if (rt > 0) tri(B, b0, t1, t0, rgb);          // rb == 0 (inverted cone): apex at bottom
    else if (rb > 0) tri(B, b0, b1, T(0, hh, 0), rgb); // rt == 0: apex at top
    if (rt > 0) tri(B, T(0, hh, 0), t0, t1, rgb);      // top cap (+Y)
    if (rb > 0) tri(B, T(0, -hh, 0), b1, b0, rgb);     // bottom cap (-Y)
  }
  return finish(B);
}
export function cone(r, h, seg, hex, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  return cyl(0, r, h, seg, hex, x, y, z, rx, ry, rz);
}

// icosahedron, detail 0
const PHI = (1 + Math.sqrt(5)) / 2;
const ICO_V = [[-1,PHI,0],[1,PHI,0],[-1,-PHI,0],[1,-PHI,0],[0,-1,PHI],[0,1,PHI],[0,-1,-PHI],[0,1,-PHI],[PHI,0,-1],[PHI,0,1],[-PHI,0,-1],[-PHI,0,1]]
  .map(v => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0]/l, v[1]/l, v[2]/l]; });
const ICO_F = [[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],
  [3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
export function blob(r, hex, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) {
  const B = new Builder(), rgb = hexRGB(hex);
  const P = i => [ICO_V[i][0]*r*sx + x, ICO_V[i][1]*r*sy + y, ICO_V[i][2]*r*sz + z];
  for (const f of ICO_F) tri(B, P(f[0]), P(f[1]), P(f[2]), rgb);
  return finish(B);
}

export function quad(w, d, hex, x = 0, y = 0, z = 0) {
  const B = new Builder(), rgb = hexRGB(hex), hw = w / 2, hd = d / 2;
  quadTris(B, [x-hw,y,z+hd], [x+hw,y,z+hd], [x+hw,y,z-hd], [x-hw,y,z-hd], rgb);
  return finish(B);
}

export function merge(geos) {
  let n = 0;
  for (const g of geos) n += g.count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of geos) {
    pos.set(g.pos.subarray(0, g.count * 3), o); nrm.set(g.nrm.subarray(0, g.count * 3), o); col.set(g.col.subarray(0, g.count * 3), o);
    o += g.count * 3;
  }
  return { pos, nrm, col, count: n };
}

// LOD helper: drops the smallest triangles (cumulative area <= frac of the total area) -- strips eyes, toes, comb tips etc.
export function stripSmall(g, frac) {
  const nt = g.count / 3 | 0, P = g.pos, ar = new Float32Array(nt);
  let tot = 0;
  for (let t = 0; t < nt; t++) {
    const i = t * 9, ux = P[i + 3] - P[i], uy = P[i + 4] - P[i + 1], uz = P[i + 5] - P[i + 2];
    const vx = P[i + 6] - P[i], vy = P[i + 7] - P[i + 1], vz = P[i + 8] - P[i + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    tot += ar[t] = Math.sqrt(cx * cx + cy * cy + cz * cz) * 0.5;
  }
  const order = Array.from(ar.keys()).sort((a, b) => ar[a] - ar[b]);
  const drop = new Uint8Array(nt);
  let acc = 0;
  for (const t of order) { if (acc + ar[t] > tot * frac) break; acc += ar[t]; drop[t] = 1; }
  let keep = 0; for (let t = 0; t < nt; t++) if (!drop[t]) keep++;
  const pos = new Float32Array(keep * 9), nrm = new Float32Array(keep * 9), col = new Float32Array(keep * 9);
  let o = 0;
  for (let t = 0; t < nt; t++) {
    if (drop[t]) continue;
    pos.set(g.pos.subarray(t * 9, t * 9 + 9), o); nrm.set(g.nrm.subarray(t * 9, t * 9 + 9), o); col.set(g.col.subarray(t * 9, t * 9 + 9), o);
    o += 9;
  }
  return { pos, nrm, col, count: keep * 3 };
}

// ---------------------------------------------------------------- rounded primitives (stylised look)
// All of these are CONVEX shapes: triangle winding is fixed automatically so normals point away from the shape centre
// (flat per-face normals are kept, facets stay visible). Positioned by centre like box()/blob().
function triO(B, a, b, c, ctr, rgb) {
  const ux = b[0]-a[0], uy = b[1]-a[1], uz = b[2]-a[2], vx = c[0]-a[0], vy = c[1]-a[1], vz = c[2]-a[2];
  const nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
  if (nx*nx + ny*ny + nz*nz < 1e-16) return;                       // degenerate
  const d = nx * ((a[0]+b[0]+c[0])/3 - ctr[0]) + ny * ((a[1]+b[1]+c[1])/3 - ctr[1]) + nz * ((a[2]+b[2]+c[2])/3 - ctr[2]);
  if (d < 0) tri(B, a, c, b, rgb); else tri(B, a, b, c, rgb);
}
// surface of revolution about local Y. prof = [[radius, y], ...] bottom -> top (radius 0 = pole). sx/sz stretch the cross-section.
export function lathe(prof, seg, hex, sx = 1, sz = 1, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, phase = 0) {
  const B = new Builder(), T = xform(x, y, z, rx, ry, rz), rgb = hexRGB(hex);
  let ym = 0; for (const p of prof) ym += p[1]; ym /= prof.length;
  const ctr = T(0, ym, 0), n = prof.length;
  const R = [];
  for (let k = 0; k < n; k++) {
    const ring = [];
    for (let i = 0; i < seg; i++) { const a = phase + i / seg * Math.PI * 2; ring.push(T(prof[k][0] * Math.sin(a) * sx, prof[k][1], prof[k][0] * Math.cos(a) * sz)); }
    R.push(ring);
  }
  for (let k = 0; k < n - 1; k++) {
    const r0 = prof[k][0], r1 = prof[k + 1][0];
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg, a = R[k][i], b = R[k][j], c = R[k + 1][j], d = R[k + 1][i];
      if (r0 > 0 && r1 > 0) { triO(B, a, b, c, ctr, rgb); triO(B, a, c, d, ctr, rgb); }
      else if (r0 > 0) triO(B, a, b, d, ctr, rgb);
      else if (r1 > 0) triO(B, a, c, d, ctr, rgb);
    }
  }
  return finish(B);
}
// chubby ellipsoid with semi-axes (ax,ay,az): UV sphere, `seg` columns x `rings` latitude bands (8x4 = 48 tris, 6x3 = 24, 6x2 = 12)
const _sph = {};
export function ell(ax, ay, az, hex, x = 0, y = 0, z = 0, seg = 8, rings = 4, rx = 0, ry = 0, rz = 0) {
  const key = seg + ',' + rings;
  let prof = _sph[key];
  if (!prof) {
    const hs = (rings & 1) ? 1.08 : 1;     // odd ring counts have no equator ring: widen slightly so the silhouette keeps its size
    prof = _sph[key] = [];
    for (let k = 0; k <= rings; k++) { const f = -Math.PI / 2 + Math.PI * k / rings; prof.push([Math.max(0, Math.cos(f)) * (k === 0 || k === rings ? 0 : hs), Math.sin(f)]); }
  }
  const p = prof.map(q => [q[0], q[1] * ay]);
  return lathe(p, seg, hex, ax, az, x, y, z, rx, ry, rz, Math.PI / seg);
}
// capsule along local Y: radius r, straight section length h (total h + 2r)
export function capsule(r, h, hex, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, seg = 6) {
  const c = r * 0.7071, hh = h / 2;
  return lathe([[0, -hh - r], [c, -hh - c], [r, -hh], [r, hh], [c, hh + c], [0, hh + r]], seg, hex, 1, 1, x, y, z, rx, ry, rz);
}
// rounded tapered rod from p0 (radius r0) to p1 (radius r1) with blunt round ends (24 tris at seg 6)
export function rod(x0, y0, z0, x1, y1, z1, r0, r1, hex, seg = 6) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, L = Math.hypot(dx, dy, dz) || 1e-6, hl = L / 2;
  const rx = Math.acos(Math.max(-1, Math.min(1, dy / L))), ry = Math.atan2(dx, dz);
  return lathe([[0, -hl - r0 * 0.55], [r0, -hl], [r1, hl], [0, hl + r1 * 0.55]], seg, hex, 1, 1, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, rx, ry, 0);
}
// chamfered ("rounded") box, corner radius r, 44 tris
export function rbox(w, h, d, r, hex, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const B = new Builder(), T = xform(x, y, z, rx, ry, rz), rgb = hexRGB(hex), ctr = T(0, 0, 0);
  const H = [w / 2, h / 2, d / 2];
  r = Math.min(r, H[0] * 0.98, H[1] * 0.98, H[2] * 0.98);
  const P = (a, b, c) => T(a, b, c);
  const S = [-1, 1];
  const q = (p0, p1, p2, p3) => { triO(B, p0, p1, p2, ctr, rgb); triO(B, p0, p2, p3, ctr, rgb); };
  for (const s of S) {
    // faces
    q(P(s*H[0], -(H[1]-r), -(H[2]-r)), P(s*H[0], (H[1]-r), -(H[2]-r)), P(s*H[0], (H[1]-r), (H[2]-r)), P(s*H[0], -(H[1]-r), (H[2]-r)));
    q(P(-(H[0]-r), s*H[1], -(H[2]-r)), P((H[0]-r), s*H[1], -(H[2]-r)), P((H[0]-r), s*H[1], (H[2]-r)), P(-(H[0]-r), s*H[1], (H[2]-r)));
    q(P(-(H[0]-r), -(H[1]-r), s*H[2]), P((H[0]-r), -(H[1]-r), s*H[2]), P((H[0]-r), (H[1]-r), s*H[2]), P(-(H[0]-r), (H[1]-r), s*H[2]));
    for (const t of S) {
      // edges (4 along each axis)
      q(P(-(H[0]-r), s*H[1], t*(H[2]-r)), P((H[0]-r), s*H[1], t*(H[2]-r)), P((H[0]-r), s*(H[1]-r), t*H[2]), P(-(H[0]-r), s*(H[1]-r), t*H[2]));
      q(P(s*H[0], -(H[1]-r), t*(H[2]-r)), P(s*H[0], (H[1]-r), t*(H[2]-r)), P(s*(H[0]-r), (H[1]-r), t*H[2]), P(s*(H[0]-r), -(H[1]-r), t*H[2]));
      q(P(s*H[0], t*(H[1]-r), -(H[2]-r)), P(s*H[0], t*(H[1]-r), (H[2]-r)), P(s*(H[0]-r), t*H[1], (H[2]-r)), P(s*(H[0]-r), t*H[1], -(H[2]-r)));
      for (const u of S) triO(B, P(s*H[0], t*(H[1]-r), u*(H[2]-r)), P(s*(H[0]-r), t*H[1], u*(H[2]-r)), P(s*(H[0]-r), t*(H[1]-r), u*H[2]), ctr, rgb);
    }
  }
  return finish(B);
}

// Smooth-normal variant: returns a copy of geo whose per-vertex normals are the area-weighted average of the face normals of every
// vertex sharing the same (quantised) position, so cel bands curve across rounded forms. Positions/colours/winding are unchanged.
// Only use on convex-ish rounded shapes (ell/capsule/rod/lathe/blob, or merges of them); boxes keep their hard edges if left flat.
export function smoothen(geo) {
  const n = geo.count, P = geo.pos, N = geo.nrm, Q = 1e4, map = new Map(), keys = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = keys[i] = Math.round(P[i*3] * Q) + ',' + Math.round(P[i*3+1] * Q) + ',' + Math.round(P[i*3+2] * Q);
    let a = map.get(k); if (!a) map.set(k, a = [0, 0, 0]);
    const o = (i - i % 3) * 3;
    const ux = P[o+3]-P[o], uy = P[o+4]-P[o+1], uz = P[o+5]-P[o+2], vx = P[o+6]-P[o], vy = P[o+7]-P[o+1], vz = P[o+8]-P[o+2];
    const w = Math.hypot(uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx) || 1e-9;
    a[0] += N[i*3] * w; a[1] += N[i*3+1] * w; a[2] += N[i*3+2] * w;
  }
  const nrm = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = map.get(keys[i]), l = Math.hypot(a[0], a[1], a[2]);
    if (l > 1e-9) { nrm[i*3] = a[0]/l; nrm[i*3+1] = a[1]/l; nrm[i*3+2] = a[2]/l; } else { nrm[i*3] = N[i*3]; nrm[i*3+1] = N[i*3+1]; nrm[i*3+2] = N[i*3+2]; }
  }
  return { pos: geo.pos, nrm, col: geo.col, count: n };
}
