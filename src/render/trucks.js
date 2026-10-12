// Truck renderer: chunky rounded cartoon farm trucks (pickup / box van / milk tanker), instanced like the animals and drawn with the shared
// cel shader + inverted-hull outlines (0.06-0.08 m). createTruckRenderer(G, W) -> { update(W, alpha), meshes, counts }.
// Reads the v_* arrays on W (src/sim/trucks.js). No allocation per frame; works with a mock G (createMesh/createStaticMesh/createShadowMesh).
// Models face local +Z, +X is the truck's left, origin on the ground in the middle of the chassis.
// Tinted body meshes are baked in neutral cream (P1) / darker cream (P2) so the per-truck instance tint is the paint colour; everything that must
// keep its own colour (glass, trim, bumpers, bed boards, hubs) lives in untinted accessory meshes. Headlamps / tail lamps are one tiny white
// mesh whose tint > 1 at night, exactly like the environment's window glows.
import { ell, rbox, rod, lathe, merge, smoothen, box } from './lowpoly.js';
import { MAX_TRUCKS, TruckKind, TruckState, WHEEL_R, LANE, DOOR, KIND, FLIGHT, PATH_IN, PATH_OUT } from '../sim/trucks.js';

const PI = Math.PI, HP = PI / 2;
const P1 = 0xf3eee2, P2 = 0xd3cab6;                                       // neutral paint (tinted per truck)
const GLASS = 0x2a2d36, TRIM = 0x4c4852, DARK = 0x35323a, CREAM = 0xdcd3bb, WOOD = 0xb08a58, TYRE = 0x2b2a2f, HUB = 0xe0d7bd, LUG = 0x6c6a72;
const OUT_BODY = 0.07, OUT_ACC = 0.04, OUT_WHEEL = 0.06, OUT_CARGO = 0.04;
// per-truck paint colours (muted barn red, mustard, faded blue, cream, sage, terracotta)
export const PAINT = [0xb6483a, 0xd4a640, 0x5d86a8, 0xe6d9b4, 0x7f9c67, 0xc9733c];
const PAINT_TINT = PAINT.map(h => [((h >> 16) & 255) / 255 / 0.94, ((h >> 8) & 255) / 255 / 0.94, (h & 255) / 255 / 0.94]);
export const GROUND = { rim: 0xb7a67e, body: 0xcdbd94, mid: 0xd6c8a2, rut: 0xa8966e, spot: 0xbcab83, spot2: 0xd9cca8 };

// superellipsoid with its long axis along Z: e1 = exponent along the axis (small = flat ends), e2 = cross-section (1 = ellipse, ~0.45 = rounded square)
const spow = (v, e) => (v < 0 ? -1 : 1) * Math.pow(Math.abs(v), e);
function sellipsoid(ax, ay, az, e1, e2, hex, x = 0, y = 0, z = 0, nu = 28, nv = 14) {
  const rgb = [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255], pts = [];
  for (let j = 0; j <= nv; j++) {
    const v = -HP + PI * j / nv, row = [];
    for (let i = 0; i <= nu; i++) {
      const u = -PI + 2 * PI * i / nu, cv = spow(Math.cos(v), e1);
      row.push([x + ax * cv * spow(Math.cos(u), e2), y + ay * cv * spow(Math.sin(u), e2), z + az * spow(Math.sin(v), e1)]);
    }
    pts.push(row);
  }
  const p = [], c = [], n = [];
  const T = (a, b, d) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz < 1e-12) return;
    const out = nx * ((a[0] + b[0] + d[0]) / 3 - x) + ny * ((a[1] + b[1] + d[1]) / 3 - y) + nz * ((a[2] + b[2] + d[2]) / 3 - z) >= 0;
    const q = out ? [a, b, d] : [a, d, b], l = Math.sqrt(nx * nx + ny * ny + nz * nz), k = out ? 1 / l : -1 / l;
    for (const t of q) { p.push(t[0], t[1], t[2]); c.push(rgb[0], rgb[1], rgb[2]); n.push(nx * k, ny * k, nz * k); }
  };
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { T(pts[j][i], pts[j][i + 1], pts[j + 1][i + 1]); T(pts[j][i], pts[j + 1][i + 1], pts[j + 1][i]); }
  return { pos: new Float32Array(p), nrm: new Float32Array(n), col: new Float32Array(c), count: p.length / 3 };
}

// ---------------------------------------------------------------- geometry (each builder returns { body, acc })
function pickup() {
  const sm = [], acc = [];
  sm.push(ell(1.15, 0.55, 3.0, P1, 0, 1.0, 0.0, 14, 6));                      // plump belly / chassis
  sm.push(ell(1.05, 0.5, 1.15, P1, 0, 1.45, 2.2, 12, 6));                     // hood
  sm.push(ell(1.1, 0.82, 1.0, P1, 0, 1.92, 0.75, 14, 7));                     // cabin
  for (const s of [-1, 1]) {
    sm.push(ell(0.36, 0.52, 0.95, P2, s * 1.08, 1.0, 2.05, 9, 5), ell(0.36, 0.52, 0.95, P2, s * 1.08, 1.0, -1.75, 9, 5));   // wheel arches
    sm.push(ell(0.16, 0.45, 1.5, P1, s * 1.05, 1.66, -1.7, 8, 5));           // bed side walls
    sm.push(rod(s * 1.05, 2.06, -0.3, s * 1.05, 2.06, -3.05, 0.14, 0.14, P2, 6));
  }
  sm.push(ell(1.04, 0.4, 0.14, P1, 0, 1.68, -3.06, 10, 5), ell(1.0, 0.42, 0.14, P1, 0, 1.78, -0.4, 10, 5));      // tail gate, bed front
  sm.push(rod(-1.0, 2.1, -3.06, 1.0, 2.1, -3.06, 0.13, 0.13, P2, 6));
  const body = smoothen(merge(sm));
  acc.push(ell(0.98, 0.1, 1.5, WOOD, 0, 1.5, -1.7, 10, 3));                  // bed floor boards
  acc.push(ell(1.0, 0.3, 3.0, DARK, 0, 0.66, 0, 10, 3));                     // dark underside
  for (const s of [-1, 1]) {
    acc.push(rbox(0.12, 0.44, 0.52, 0.1, GLASS, s * 1.03, 2.08, 0.8));
    acc.push(rod(s * 1.02, 2.2, 1.6, s * 1.27, 2.3, 1.72, 0.05, 0.05, DARK, 5), ell(0.06, 0.18, 0.1, DARK, s * 1.29, 2.3, 1.73, 6, 3));
  }
  acc.push(rbox(0.96, 0.4, 0.14, 0.12, GLASS, 0, 2.12, 1.67, -0.3), rbox(0.7, 0.34, 0.12, 0.1, GLASS, 0, 2.12, -0.22, 0.22));
  acc.push(ell(0.58, 0.24, 0.1, TRIM, 0, 1.42, 3.32, 9, 4));
  acc.push(rod(-0.95, 0.88, 3.2, 0.95, 0.88, 3.2, 0.17, 0.17, CREAM, 6), rod(-0.95, 0.92, -3.15, 0.95, 0.92, -3.15, 0.16, 0.16, CREAM, 6));
  return { body, acc: smoothen(merge(acc)) };
}
function van() {
  const sm = [], acc = [];
  sm.push(ell(1.12, 1.0, 1.55, P1, 0, 1.72, 2.35, 14, 7));                    // plump cab-over nose
  sm.push(sellipsoid(1.22, 1.17, 2.4, 0.5, 0.42, P1, 0, 2.02, -1.5));        // pillowy rounded box
  sm.push(ell(1.2, 0.36, 3.9, P2, 0, 0.98, -0.3, 14, 5));                    // skirt
  for (const s of [-1, 1]) {
    sm.push(ell(0.38, 0.54, 1.0, P2, s * 1.1, 1.02, 2.35, 9, 5), ell(0.38, 0.54, 1.0, P2, s * 1.1, 1.02, -1.85, 9, 5));
    sm.push(ell(0.07, 0.3, 1.8, P2, s * 1.2, 2.0, -1.5, 6, 4));              // body stripe
  }
  const body = smoothen(merge(sm));
  for (const s of [-1, 1]) {
    acc.push(rbox(0.12, 0.5, 0.62, 0.1, GLASS, s * 1.0, 2.2, 2.25));
    acc.push(rod(s * 1.02, 2.2, 3.0, s * 1.3, 2.35, 3.15, 0.05, 0.05, DARK, 5), ell(0.06, 0.2, 0.1, DARK, s * 1.32, 2.35, 3.16, 6, 3));
    acc.push(ell(0.06, 0.4, 0.3, 0xf6e3a0, s * 1.23, 2.34, -1.6, 7, 4), ell(0.07, 0.2, 0.14, 0xe0a948, s * 1.25, 2.3, -1.6, 6, 3));   // egg emblem
  }
  acc.push(rbox(0.92, 0.5, 0.14, 0.12, GLASS, 0, 2.2, 3.5, -0.42));
  acc.push(ell(1.0, 0.3, 3.8, DARK, 0, 0.7, 0, 10, 3));
  acc.push(rbox(1.7, 1.55, 0.1, 0.25, DARK, 0, 1.98, -3.86));                 // open rear: goods vanish in here
  acc.push(rod(-0.95, 0.88, 3.85, 0.95, 0.88, 3.85, 0.17, 0.17, CREAM, 6), rod(-1.0, 0.92, -3.85, 1.0, 0.92, -3.85, 0.16, 0.16, CREAM, 6));
  acc.push(ell(0.6, 0.25, 0.1, TRIM, 0, 1.3, 3.84, 9, 4));
  return { body, acc: smoothen(merge(acc)) };
}
function tanker() {
  const sm = [], acc = [];
  const tankProf = [[0, -2.9], [0.55, -2.82], [0.95, -2.55], [1.12, -2.1], [1.18, -1.5], [1.18, 1.5], [1.12, 2.1], [0.95, 2.55], [0.55, 2.82], [0, 2.9]];
  sm.push(lathe(tankProf, 16, P1, 1, 1, 0, 2.2, -1.35, HP, 0, 0));          // rounded tank (axis along Z)
  sm.push(ell(1.15, 1.05, 1.35, P1, 0, 1.85, 2.85, 14, 7));                  // cab
  sm.push(ell(1.18, 0.4, 3.6, P2, 0, 1.02, 0.4, 12, 5));                     // chassis band
  for (const s of [-1, 1]) {
    sm.push(ell(0.38, 0.54, 0.95, P2, s * 1.1, 1.02, 2.8, 9, 5), ell(0.38, 0.54, 1.5, P2, s * 1.1, 1.02, -2.2, 9, 5));
  }
  sm.push(ell(0.46, 0.22, 0.46, P2, 0, 3.4, -1.1, 10, 4));                  // hatch
  sm.push(ell(0.55, 0.36, 0.3, P2, 0, 1.45, -4.1, 9, 4));                   // valve box
  const body = smoothen(merge(sm));
  for (const z of [-3.3, -1.35, 0.6]) acc.push(lathe([[1.16, -0.08], [1.23, -0.05], [1.23, 0.05], [1.16, 0.08]], 16, TRIM, 1, 1, 0, 2.2, z, HP, 0, 0));   // tank straps
  acc.push(ell(0.2, 0.12, 0.2, DARK, 0, 3.56, -1.1, 8, 3));
  acc.push(rod(-0.3, 1.4, -4.3, 0.3, 1.2, -4.4, 0.09, 0.09, DARK, 5), rod(-0.35, 1.1, -4.3, -0.5, 0.9, -4.1, 0.07, 0.07, DARK, 5));
  acc.push(rbox(0.36, 1.35, 0.12, 0.12, GLASS, 0, 2.1, -4.18));               // level gauge window
  for (const s of [-1, 1]) {
    acc.push(rbox(0.12, 0.5, 0.62, 0.1, GLASS, s * 1.04, 2.2, 2.75));
    acc.push(rod(s * 1.05, 2.1, 3.5, s * 1.32, 2.25, 3.62, 0.05, 0.05, DARK, 5), ell(0.06, 0.2, 0.1, DARK, s * 1.34, 2.25, 3.63, 6, 3));
    acc.push(rod(s * 1.15, 1.5, 1.35, s * 1.15, 3.5, 1.35, 0.09, 0.08, DARK, 5), ell(0.12, 0.08, 0.12, DARK, s * 1.15, 3.58, 1.35, 6, 3));   // exhaust stacks
  }
  acc.push(rbox(0.92, 0.5, 0.14, 0.12, GLASS, 0, 2.25, 3.98, -0.4));
  acc.push(ell(1.0, 0.3, 4.0, DARK, 0, 0.72, 0, 10, 3));
  acc.push(rod(-1.0, 0.9, 4.15, 1.0, 0.9, 4.15, 0.17, 0.17, CREAM, 6), rod(-1.0, 0.94, -4.2, 1.0, 0.94, -4.2, 0.16, 0.16, CREAM, 6));
  acc.push(ell(0.6, 0.25, 0.1, TRIM, 0, 1.35, 4.14, 9, 4));
  return { body, acc: smoothen(merge(acc)) };
}
// wheel with its axle along local X. thick dark tyre, lighter hubs with bolts, tread lugs (so the spin is readable)
function wheelGeo() {
  const sm = [], R = WHEEL_R;
  sm.push(lathe([[0, -0.27], [0.4, -0.27], [0.54, -0.23], [R, -0.12], [R, 0.12], [0.54, 0.23], [0.4, 0.27], [0, 0.27]], 12, TYRE, 1, 1, 0, 0, 0, 0, 0, HP, PI / 12));
  for (const s of [-1, 1]) {
    sm.push(lathe([[0, 0.25], [0.33, 0.25], [0.36, 0.3], [0.27, 0.34], [0, 0.35]].map(p => [p[0], p[1] * s]), 9, HUB, 1, 1, 0, 0, 0, 0, 0, HP));
    for (let k = 0; k < 4; k++) {
      const a = k / 4 * PI * 2 + 0.4;
      sm.push(ell(0.055, 0.055, 0.055, LUG, s * 0.335, Math.cos(a) * 0.19, Math.sin(a) * 0.19, 4, 2));
    }
  }
  const fl = [];
  for (let k = 0; k < 8; k++) {                                              // tread blocks: make the spin readable
    const a = k / 8 * PI * 2 + PI / 8;
    fl.push(box(0.36, 0.1, 0.14, 0x1b1b1f, 0, Math.cos(a) * (R + 0.005), Math.sin(a) * (R + 0.005), a));
  }
  return merge([smoothen(merge(sm)), merge(fl)]);
}
function lampGeo() { return smoothen(ell(1, 1, 1, 0xffffff, 0, 0, 0, 8, 4)); }
// goods crate: wood, with eggs and two milk bottles on top. origin at the bottom centre
function crateGeo() {
  const sm = [], fl = [];
  sm.push(smoothen(rbox(0.92, 0.52, 0.8, 0.14, 0xc9a06a, 0, 0.26, 0)));
  fl.push(rbox(0.96, 0.08, 0.84, 0.04, 0xa77f4e, 0, 0.48, 0));
  for (let k = 0; k < 4; k++) sm.push(ell(0.1, 0.13, 0.1, 0xf5ecd5, -0.28 + (k % 2) * 0.2, 0.6, -0.18 + ((k / 2) | 0) * 0.3, 7, 4));
  for (const s of [-1, 1]) {
    sm.push(rod(s * 0.26 + 0.14, 0.52, 0.2, s * 0.26 + 0.14, 0.88, 0.2, 0.1, 0.09, 0xf2f6f8, 6));
    sm.push(ell(0.08, 0.05, 0.08, 0x6aa5c8, s * 0.26 + 0.14, 0.92, 0.2, 6, 3));
  }
  return merge([smoothen(merge(sm)), merge(fl)]);
}
function baleGeo() {                                                         // round wool bale: puffs + twine
  const s = [ell(0.52, 0.44, 0.48, 0xf6f2e8, 0, 0.44, 0, 10, 6), ell(0.34, 0.3, 0.34, 0xece6d6, 0.2, 0.74, 0.08, 8, 5), ell(0.3, 0.26, 0.3, 0xf9f6ee, -0.2, 0.7, -0.1, 8, 5)];
  const t = [ell(0.55, 0.06, 0.5, 0xb9553f, 0, 0.5, 0, 10, 3)];
  return merge([smoothen(merge(s)), smoothen(merge(t))]);
}

// ---------------------------------------------------------------- layout tables (local x, y, z)
const WHEELS = [
  [[1.18, 2.05, 1], [-1.18, 2.05, 1], [1.18, -1.75, 0], [-1.18, -1.75, 0]],
  [[1.2, 2.35, 1], [-1.2, 2.35, 1], [1.2, -1.85, 0], [-1.2, -1.85, 0]],
  [[1.2, 2.8, 1], [-1.2, 2.8, 1], [1.2, -1.5, 0], [-1.2, -1.5, 0], [1.2, -2.9, 0], [-1.2, -2.9, 0]],
];
// [x, y, z, sx, sy, sz, kind(0 head,1 tail,2 reverse)]
const LAMPS = [
  [[0.78, 1.42, 3.28, 0.26, 0.24, 0.14, 0], [-0.78, 1.42, 3.28, 0.26, 0.24, 0.14, 0], [0.98, 1.5, -3.1, 0.11, 0.2, 0.09, 1], [-0.98, 1.5, -3.1, 0.11, 0.2, 0.09, 1], [0.6, 1.2, -3.2, 0.09, 0.09, 0.07, 2], [-0.6, 1.2, -3.2, 0.09, 0.09, 0.07, 2]],
  [[0.8, 1.3, 3.84, 0.27, 0.24, 0.14, 0], [-0.8, 1.3, 3.84, 0.27, 0.24, 0.14, 0], [1.0, 1.35, -3.84, 0.12, 0.24, 0.09, 1], [-1.0, 1.35, -3.84, 0.12, 0.24, 0.09, 1], [0.6, 0.98, -3.9, 0.09, 0.09, 0.07, 2], [-0.6, 0.98, -3.9, 0.09, 0.09, 0.07, 2]],
  [[0.8, 1.4, 4.12, 0.27, 0.24, 0.14, 0], [-0.8, 1.4, 4.12, 0.27, 0.24, 0.14, 0], [0.9, 1.1, -4.2, 0.12, 0.2, 0.09, 1], [-0.9, 1.1, -4.2, 0.12, 0.2, 0.09, 1], [0.0, 0.9, -4.36, 0.1, 0.1, 0.07, 2], [0.0, 0.9, -4.36, 0.0, 0.0, 0.0, 2]],
];
// pickup bed slots (local): 6 lower + 2 stacked on top; fill order front -> back
const BED = [];
for (let r = 0; r < 3; r++) for (const c of [-0.52, 0.52]) BED.push([c, 1.58, -0.95 - r * 0.9]);
BED.push([-0.52, 2.1, -1.4], [0.52, 2.1, -1.4]);
const TARGET = [null, [0, 1.7, -3.7], [0, 3.7, -1.1]];                     // van: rear opening, tanker: roof hatch (goods vanish there)

// ---------------------------------------------------------------- matrix helpers
const B = new Float64Array(9);                                              // body rotation: columns x, y, z
function setB(yaw, pitch, roll) {
  const c = Math.cos(yaw), s = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  B[0] = c * cr + s * sp * sr; B[1] = cp * sr; B[2] = -s * cr + c * sp * sr;
  B[3] = -c * sr + s * sp * cr; B[4] = cp * cr; B[5] = s * sr + c * sp * cr;
  B[6] = s * cp; B[7] = -sp; B[8] = c * cp;
}
function putB(Mh, k, px, py, pz, jit, sx, sy, sz) {
  const a = Mh.inst, o = k * 16, c = Math.cos(jit), s = Math.sin(jit);
  const x0 = B[0] * c - B[6] * s, x1 = B[1] * c - B[7] * s, x2 = B[2] * c - B[8] * s;
  const z0 = B[0] * s + B[6] * c, z1 = B[1] * s + B[7] * c, z2 = B[2] * s + B[8] * c;
  a[o] = x0 * sx; a[o + 1] = x1 * sx; a[o + 2] = x2 * sx; a[o + 3] = 0;
  a[o + 4] = B[3] * sy; a[o + 5] = B[4] * sy; a[o + 6] = B[5] * sy; a[o + 7] = 0;
  a[o + 8] = z0 * sz; a[o + 9] = z1 * sz; a[o + 10] = z2 * sz; a[o + 11] = 0;
  a[o + 12] = px; a[o + 13] = py; a[o + 14] = pz; a[o + 15] = 1;
}
function putWheel(Mh, k, px, py, pz, yaw, spin) {
  const a = Mh.inst, o = k * 16, c = Math.cos(yaw), s = Math.sin(yaw), cp = Math.cos(spin), sp = Math.sin(spin);
  a[o] = c; a[o + 1] = 0; a[o + 2] = -s; a[o + 3] = 0;
  a[o + 4] = s * sp; a[o + 5] = cp; a[o + 6] = c * sp; a[o + 7] = 0;
  a[o + 8] = s * cp; a[o + 9] = -sp; a[o + 10] = c * cp; a[o + 11] = 0;
  a[o + 12] = px; a[o + 13] = py; a[o + 14] = pz; a[o + 15] = 1;
}
function putFree(Mh, k, px, py, pz, yaw, sc) {
  const a = Mh.inst, o = k * 16, c = Math.cos(yaw), s = Math.sin(yaw);
  a[o] = c * sc; a[o + 1] = 0; a[o + 2] = -s * sc; a[o + 3] = 0;
  a[o + 4] = 0; a[o + 5] = sc; a[o + 6] = 0; a[o + 7] = 0;
  a[o + 8] = s * sc; a[o + 9] = 0; a[o + 10] = c * sc; a[o + 11] = 0;
  a[o + 12] = px; a[o + 13] = py; a[o + 14] = pz; a[o + 15] = 1;
}
function setTint(Mh, k, r, g, b) { const o = k * 3; Mh.tint[o] = r; Mh.tint[o + 1] = g; Mh.tint[o + 2] = b; }
const ss = t => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
function nightFactor(h) {                                                   // same curve as environment.js
  if (h >= 21 || h < 5.5) return 1;
  if (h >= 17.5) return ss((h - 17.5) / 3.5);
  if (h < 7.5) return 1 - ss((h - 5.5) / 2);
  return 0;
}

// ---------------------------------------------------------------- service lane ground (static flat mesh, painter style)
function tri(P, C, ax, az, bx, bz, cx, cz, y, k) {
  const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
  if (Math.abs(ny) < 1e-9) return;
  if (ny < 0) { const tx = bx, tz = bz; bx = cx; bz = cz; cx = tx; cz = tz; }
  P.push(ax, y, az, bx, y, bz, cx, y, cz);
  for (let i = 0; i < 3; i++) C.push(k[0], k[1], k[2]);
}
const rgbOf = h => [(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255];
function hash(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
function vn(x, seed) { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return hash(i + seed * 31.7) * (1 - u) + hash(i + 1 + seed * 31.7) * u; }
export function buildLane() {
  const P = [], C = [];
  const ribbonX = (xa, xb, zc, hw0, wob, y, hex, seed) => {                   // horizontal ribbon along x with wobbly edges
    const k = rgbOf(hex), n = Math.max(2, Math.round((xb - xa) / 1.5));
    let px = 0, pt = 0, pb = 0;
    for (let i = 0; i <= n; i++) {
      const x = xa + (xb - xa) * i / n, t = zc + (vn(x * 0.35, seed) - 0.5) * wob - hw0 - (vn(x * 0.5, seed + 3) - 0.5) * wob, b = zc + hw0 + (vn(x * 0.4, seed + 7) - 0.5) * wob;
      if (i) { tri(P, C, px, pt, x, t, x, b, y, k); tri(P, C, px, pt, x, b, px, pb, y, k); }
      px = x; pt = t; pb = b;
    }
  };
  const roundRect = (x0, z0, x1, z1, r, seg, wob, seed) => {                  // polygon pts for a wobbly rounded rect
    const pts = [], cs = [[x1 - r, z0 + r, -HP], [x1 - r, z1 - r, 0], [x0 + r, z1 - r, HP], [x0 + r, z0 + r, PI]];
    let i = 0;
    for (const [cx, cz, a0] of cs) for (let k = 0; k <= seg; k++, i++) {
      const a = a0 + HP * k / seg, w = 1 + (hash(i * 3.7 + seed) - 0.5) * wob;
      pts.push(cx + Math.sin(a) * r * w, cz - Math.cos(a) * r * w);
    }
    return pts;
  };
  const poly = (pts, y, hex) => {
    const k = rgbOf(hex), n = pts.length / 2; let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += pts[i * 2]; cz += pts[i * 2 + 1]; }
    cx /= n; cz /= n;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; tri(P, C, cx, cz, pts[i * 2], pts[i * 2 + 1], pts[j * 2], pts[j * 2 + 1], y, k); }
  };
  const blob = (cx, cz, rx, rz, seed, y, hex) => {
    const pts = []; for (let i = 0; i < 9; i++) { const a = i / 9 * PI * 2, w = 0.75 + hash(seed + i) * 0.5; pts.push(cx + Math.cos(a) * rx * w, cz + Math.sin(a) * rz * w); }
    poly(pts, y, hex);
  };
  const ZC = -21.25, XE = 176, XW = 127;
  // rim (wider, darker), then body, then lighter crown
  ribbonX(XW + 1.5, XE, ZC, 4.45, 0.5, 0.029, GROUND.rim, 1);
  poly(roundRect(XW - 1.0, -26.4, 149.4, -7.4, 3.2, 5, 0.15, 5), 0.029, GROUND.rim);
  ribbonX(XW + 1.5, XE, ZC, 3.9, 0.35, 0.031, GROUND.body, 2);
  poly(roundRect(XW - 0.2, -25.8, 148.6, -8.0, 2.8, 5, 0.12, 9), 0.031, GROUND.body);
  ribbonX(XW + 4, XE, ZC, 2.2, 0.5, 0.033, GROUND.mid, 3);
  poly(roundRect(131.5, -20.5, 142.5, -9.6, 2.2, 5, 0.15, 11), 0.033, GROUND.mid);
  // wheel ruts: follow the actual tracks of the inbound and outbound paths
  const rutK = rgbOf(GROUND.rut);
  for (const path of [PATH_IN, PATH_OUT]) for (const side of [-1, 1]) {
    let px = 0, pz = 0, first = true; const step = Math.round(1.0 / 0.25);
    for (let i = 0; i < path.n; i += step) {
      const th = path.ph[i], ox = Math.cos(th) * 1.18 * side, oz = -Math.sin(th) * 1.18 * side;
      const x = path.px[i] + ox, z = path.pz[i] + oz;
      if (!first && x < 176) {
        const dx = x - px, dz = z - pz, l = Math.hypot(dx, dz) || 1, nx = -dz / l * 0.2, nz = dx / l * 0.2;
        if (x > XW - 3) { tri(P, C, px - nx, pz - nz, px + nx, pz + nz, x + nx, z + nz, 0.0345, rutK); tri(P, C, px - nx, pz - nz, x + nx, z + nz, x - nx, z - nz, 0.0345, rutK); }
      }
      px = x; pz = z; first = false;
    }
  }
  // gravel speckle and a few pale patches near the edges
  for (let i = 0; i < 110; i++) {
    const x = XW + 2 + hash(i * 1.37) * 46, z = -25.0 + hash(i * 2.11 + 5) * 17;
    if (z > -17.4 && (x > 150 || x < 128.5)) continue;
    blob(x, z, 0.25 + hash(i + 40) * 0.5, 0.2 + hash(i + 80) * 0.4, i * 7.3, 0.0355, i % 3 ? GROUND.spot : GROUND.spot2);
  }
  const n = P.length / 3, pos = new Float32Array(P), col = new Float32Array(C), nrm = new Float32Array(P.length);
  for (let i = 0; i < n; i++) nrm[i * 3 + 1] = 1;
  return { pos, nrm, col, count: n };
}

// ---------------------------------------------------------------- renderer
export function createTruckRenderer(G, W) {
  const meshes = [];
  const mk = (geo, cap, ol) => { const m = G.createMesh(geo, cap, ol > 0 ? { outline: ol } : undefined); m.count = 0; meshes.push(m); return m; };
  const kinds = [pickup(), van(), tanker()];
  const BODY = kinds.map(k => mk(k.body, MAX_TRUCKS, OUT_BODY));
  const ACC = kinds.map(k => mk(k.acc, MAX_TRUCKS, OUT_ACC));
  const WHL = mk(wheelGeo(), MAX_TRUCKS * 6, OUT_WHEEL);
  const LMP = mk(lampGeo(), MAX_TRUCKS * 8 + 8, 0);
  const CRATE = mk(crateGeo(), 40, OUT_CARGO), BALE = mk(baleGeo(), 40, OUT_CARGO);
  const SH = G.createShadowMesh(MAX_TRUCKS * 4);
  const lane = G.createStaticMesh(buildLane());
  const laneTris = lane.vertexCount ? lane.vertexCount / 3 : 0;
  const counts = { trucks: 0, wheels: 0, cargo: 0, lamps: 0 };
  const R = { meshes, counts, shadows: SH, lane, update, laneTris };
  const _l = new Float64Array(3);
  function loc(x, y, z, bx, by, bz) {                                        // body-local -> world (uses B)
    _l[0] = bx + B[0] * x + B[3] * y + B[6] * z; _l[1] = by + B[1] * x + B[4] * y + B[7] * z; _l[2] = bz + B[2] * x + B[5] * y + B[8] * z;
  }

  function update(Wd, alpha) {
    const w = Wd || W;
    alpha = alpha < 0 ? 0 : alpha > 1 ? 1 : (alpha || 0);
    for (let i = 0; i < meshes.length; i++) meshes[i].count = 0;
    SH.count = 0;
    let nW = 0, nL = 0, nC = 0, nB = 0;
    if (w.v_active) {
      const night = nightFactor(typeof w.hour === 'number' ? w.hour : 12), sd = SH.data;
      for (let i = 0; i < MAX_TRUCKS; i++) {
        if (!w.v_active[i]) continue;
        const kind = w.v_kind[i], st = w.v_state[i];
        const x = w.v_px[i] + (w.v_x[i] - w.v_px[i]) * alpha, z = w.v_pz[i] + (w.v_z[i] - w.v_pz[i]) * alpha;
        let dh = w.v_h[i] - w.v_ph[i]; dh -= 2 * PI * Math.round(dh / (2 * PI));
        const yaw = w.v_ph[i] + dh * alpha;
        if (!(x === x) || !(z === z)) continue;
        const spin = w.v_pwheel[i] + (w.v_wheel[i] - w.v_pwheel[i]) * alpha;
        const v = w.v_v[i], acc = w.v_acc[i], seed = w.v_seed[i] * 6.283, steer = w.v_steer[i], dir = w.v_dir[i];
        const moveK = v > 3 ? 1 : v / 3, tm = w.time || 0;
        let bob = (0.012 * Math.sin(w.v_s[i] * 2.7 + seed) + 0.006 * Math.sin(w.v_s[i] * 6.1)) * moveK;
        if (v < 0.1 && st !== TruckState.PAUSE) bob += 0.005 * Math.sin(tm * 52 + seed);
        const pitch = Math.max(-0.045, Math.min(0.045, -0.014 * acc * dir));
        const roll = Math.max(-0.04, Math.min(0.04, -steer * v * 0.02));
        const yb = 0.04 + bob;
        setB(yaw, pitch, roll);
        const pt = PAINT_TINT[w.v_variant[i] % PAINT_TINT.length];
        const bm = BODY[kind], am = ACC[kind];
        putB(bm, bm.count, x, yb, z, 0, 1, 1, 1); setTint(bm, bm.count, pt[0], pt[1], pt[2]); bm.count++;
        putB(am, am.count, x, yb, z, 0, 1, 1, 1); am.count++;
        // wheels stay on the ground; front wheels steer
        const WL = WHEELS[kind];
        for (let k = 0; k < WL.length; k++) {
          const wx = WL[k][0], wz = WL[k][1];
          putWheel(WHL, nW, x + B[0] * wx + B[6] * wz, WHEEL_R, z + B[2] * wx + B[8] * wz, yaw + (WL[k][2] ? steer : 0), spin);
          setTint(WHL, nW, 1, 1, 1); nW++;
        }
        // lamps: head (dim cream by day, glowing at night), tail (red, bright when braking), reverse (white while backing)
        const LS = LAMPS[kind], braking = w.v_brake[i] > 0, reversing = dir < 0 && v > 0.05;
        for (let k = 0; k < LS.length; k++) {
          const L = LS[k]; if (L[3] <= 0) continue;
          if (L[6] === 2 && !reversing) continue;
          loc(L[0], L[1], L[2], x, yb, z);
          putB(LMP, nL, _l[0], _l[1], _l[2], 0, L[3], L[4], L[5]);
          if (L[6] === 0) { const g = 0.55 + night * 3.2; setTint(LMP, nL, 1.0 * g + 0.2, 0.8 * g + 0.2, 0.42 * g); }
          else if (L[6] === 1) { const g = (braking ? 1.6 : 0.8) + night * (braking ? 2.4 : 1.1); setTint(LMP, nL, 0.8 * g, 0.12 * g, 0.1 * g); }
          else { const g = 0.9 + night * 2.2; setTint(LMP, nL, g, g, 0.9 * g); }
          nL++;
        }
        // cargo: driven by the loaded counts (farmers hand goods over at the tail; ghost loading hops them from the door). The slots that
        // landed with the latest hand-over fly in on a short arc (from the loader's hands, or from the door when auto-loading).
        const K = w.v_slots[i], o = i * 3;
        const total = w.v_plan[o] + w.v_plan[o + 1] + w.v_plan[o + 2], loaded = w.v_loaded[o] + w.v_loaded[o + 1] + w.v_loaded[o + 2];
        const shown = total > 0 && K > 0 ? (loaded >= total ? K : Math.floor(loaded * K / total)) : 0;
        if (shown > 0) {
          const eggs = w.v_plan[o], milk = w.v_plan[o + 1];
          const auto = w.v_dropAuto[i] === 1, fdur = auto ? FLIGHT : 0.5, dA = w.v_dropA[i], dB = w.v_dropB[i];
          const el = (typeof w.time === 'number' ? w.time : 0) - w.v_dropT[i] + alpha * (1 / 30);
          for (let k = 0; k < shown; k++) {
            const frac = (k + 0.5) / K * total;
            const isWool = frac >= eggs + milk;                           // order: eggs, milk crates, wool
            const Mh = isWool ? BALE : CRATE, idx = isWool ? nB : nC;
            let gx, gy, gz;
            const sl = kind === TruckKind.PICKUP ? BED[k] : TARGET[kind];
            let tau = 1;
            if (k >= dA && k < dB) tau = (el - (k - dA) * 0.12) / fdur;
            if (tau < 0) continue;                                        // not thrown yet
            if (tau >= 1) {
              if (kind !== TruckKind.PICKUP) continue;                    // vanished into the van / tanker
              loc(sl[0], sl[1], sl[2], x, yb, z); gx = _l[0]; gy = _l[1]; gz = _l[2];
              putB(Mh, idx, gx, gy, gz, ((k * 7) % 5 - 2) * 0.05, 1, 1, 1);
            } else {
              loc(sl[0], sl[1], sl[2], x, yb, z);
              const e = tau, tx = _l[0], ty = _l[1], tz = _l[2];
              let sx, sy, sz, hgt;
              if (auto) { sx = DOOR.x; sy = 1.0; sz = DOOR.z; hgt = 2.4 + 0.4 * (k % 3); }
              else { loc(0, 1.3, -KIND[kind].hl - 1.0, x, yb, z); sx = _l[0]; sy = _l[1]; sz = _l[2]; hgt = 0.9; }
              gx = sx + (tx - sx) * e; gz = sz + (tz - sz) * e; gy = sy + (ty - sy) * e + Math.sin(e * PI) * hgt;
              putFree(Mh, idx, gx, gy, gz, e * 6 + k, 1);
            }
            setTint(Mh, idx, 0.95 + ((k * 13 + 5) % 7) * 0.014, 0.95 + ((k * 13 + 5) % 7) * 0.012, 0.95);
            if (isWool) nB++; else nC++;
          }
        }
        // tanker: milk level in the rear gauge
        if (kind === TruckKind.TANKER) {
          const lv = total > 0 ? ss(loaded / total) : 0;
          if (lv > 0.02) {
            loc(0, 1.5 + 0.6 * lv, -4.27, x, yb, z);
            putB(LMP, nL, _l[0], _l[1], _l[2], 0, 0.12, 0.62 * lv, 0.05);
            setTint(LMP, nL, 0.95, 0.97, 1.0); nL++;
          }
        }
        // shadow: overlapping blobs along the body
        const fx = Math.sin(yaw), fz = Math.cos(yaw), hl = KIND[kind].hl, nb = kind === TruckKind.TANKER ? 4 : 3, si = SH.count * 3;
        for (let k = 0; k < nb; k++) { const d = (k / (nb - 1) * 2 - 1) * (hl - 1.6); sd[si + k * 3] = x + fx * d; sd[si + k * 3 + 1] = z + fz * d; sd[si + k * 3 + 2] = 2.05; }
        SH.count += nb;
      }
    }
    CRATE.count = nC; BALE.count = nB; WHL.count = nW; LMP.count = nL;
    counts.trucks = BODY[0].count + BODY[1].count + BODY[2].count; counts.wheels = nW; counts.cargo = nC + nB; counts.lamps = nL;
    for (let i = 0; i < meshes.length; i++) meshes[i].upload();
    SH.upload();
  }
  return R;
}
