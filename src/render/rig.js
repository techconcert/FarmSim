// Unit rigs + procedural low-poly models (WP4). Pure JS: no DOM / WebGL (runs under Node for benchmarks).
//
// Style: "Farm Animals Pack - Stylized Low Poly": ROUNDED, CHUNKY, CARTOONY. Every animal is a few smooth plump blobs (egg-shaped
// ellipsoids + tapered rounded tubes) with SMOOTH vertex normals, so the matte cel bands curve across the forms. Heads are fused
// into the body mass, legs are short and thick, eyes are tiny dark squares. Only tiny details (beaks, horns, combs, eyes) are faceted.
// Colour lives in the vertex colours (patches are painted per triangle -> crisp faceted patch edges, no protruding geometry); the
// per-instance tint (a_variant) re-colours a species: tint = target colour / base colour (see variants()).
//
// Conventions
//  * Models face local +Z. Body meshes are modelled around their PIVOT = centre of the torso (y=0); the pivot stands rig.bodyY
//    above the ground. Legs hang from hip joints (LEG meshes are unit tubes y 0..-1 scaled per instance, so they are not part of
//    the body geometry). HEAD meshes have their origin at the neck joint (rig.neck, relative to the body pivot) so that rotating
//    the head about X (positive pitch = nose down) bends the whole neck+head.
//  * ACC meshes (eyes, beaks, combs, horns, nostrils...) ride on the head matrix with an UNTINTED colour (near LOD only).
//  * rig.bodyY = legLen + hipDrop: the hip joints sit hipDrop below the body pivot, INSIDE the belly, so short legs never gap.
//  * Heights are in metres at a_scale = 1. Every model is built twice: near LOD and far LOD (FAR=true: fewer segments, no ACC).
//  * All surfaces are CCW-outward (required by the inverted-hull outline pass): every triangle is oriented against its ring centre.
import { box, cyl, lathe, rod, rbox, merge, smoothen } from './lowpoly.js';
import { SPECIES, SPECIES_COUNT } from '../config.js';

// Species count the renderer is built for (contract: SPECIES_COUNT = 20). NEW_SP are fallbacks used only while config.js still lists 10.
export const NSP = 20;
const sp_ = (name, legs, radius, walk, run, height) => ({ name, legs, radius, walk, run, height });
const NEW_SP = [sp_('donkey', 4, .7, 1.2, 4.5, 1.2), sp_('goose', 2, .3, .6, 2.2, .6), sp_('alpaca', 4, .5, 1.0, 3.5, 1.1), sp_('deer', 4, .55, 1.3, 6, 1.1),
  sp_('ostrich', 2, .6, 1.2, 8, 2.0), sp_('yak', 4, .85, .7, 2.2, 1.4), sp_('buffalo', 4, 1.0, .8, 3, 1.5), sp_('peacock', 2, .4, .6, 2, .9),
  sp_('camel', 4, 1.0, 1.1, 4, 2.0), sp_('capybara', 4, .45, .6, 2.5, .5)];
const spc = i => SPECIES[i] || NEW_SP[i - 10];
export const SPECIES_NAMES = [];
for (let i = 0; i < NSP; i++) SPECIES_NAMES.push(spc(i).name);
export const FAN_SPECIES = [2, 17];   // species with a tail-fan mesh (ANIMAL_GEO[s].fan)
// maleAcc = 2: the male accessory shows on the plain (alt) mesh only (deer: adult stags, not the spotted fawn)
export const MALE_ACC_SPECIES = [13]; // species with a male-only head accessory mesh (antlers); ANIMAL_GEO[s].male

const HP = Math.PI / 2, TAU = Math.PI * 2;
let FAR = false;
let PLAIN = false;      // building the plain (un-patterned) alternative of a patterned species

// ---------------------------------------------------------------- smooth rounded solids
const hexRGB = h => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
function rotMat(rx, ry, rz) {            // R = Ry * Rx * Rz (same convention as lowpoly.js)
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  return [cy*cz + sy*sx*sz, -cy*sz + sy*sx*cz, sy*cx, cx*sz, cx*cz, -sx, -sy*cz + cy*sx*sz, sy*sz + cy*sx*cz, cy*cx];
}
// Surface through rings. ring = {c:[x,y,z] centre, u:[..], v:[..] semi-axis vectors, pole:bool}. T maps local -> model space.
// col(x,y,z) (model-space triangle centroid) -> hex paints the triangle. Output: flat geo -> smoothen() (welded smooth normals).
function surf(rings, seg, hex, col, T) {
  const nR = rings.length, P = [], C = [];
  for (let k = 0; k < nR; k++) {
    const r = rings[k], row = [];
    C.push(T(r.c));
    for (let i = 0; i < seg; i++) {
      const a = i / seg * TAU, ca = Math.cos(a), sa = Math.sin(a);
      row.push(T([r.c[0] + r.u[0]*ca + r.v[0]*sa, r.c[1] + r.u[1]*ca + r.v[1]*sa, r.c[2] + r.u[2]*ca + r.v[2]*sa]));
    }
    P.push(row);
  }
  const pos = [], colr = [], nrm = [], rgb0 = hexRGB(hex || 0xffffff);
  const emit = (a, b, c, ka, kb, kc, qc) => {
    const ux = b[0]-a[0], uy = b[1]-a[1], uz = b[2]-a[2], vx = c[0]-a[0], vy = c[1]-a[1], vz = c[2]-a[2];
    let nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
    const l = Math.hypot(nx, ny, nz); if (l < 1e-12) return;
    const gx = (a[0]+b[0]+c[0]) / 3, gy = (a[1]+b[1]+c[1]) / 3, gz = (a[2]+b[2]+c[2]) / 3;
    const ox = (C[ka][0]+C[kb][0]+C[kc][0]) / 3, oy = (C[ka][1]+C[kb][1]+C[kc][1]) / 3, oz = (C[ka][2]+C[kb][2]+C[kc][2]) / 3;
    if (nx * (gx - ox) + ny * (gy - oy) + nz * (gz - oz) < 0) { const t = b; b = c; c = t; nx = -nx; ny = -ny; nz = -nz; }
    const rgb = col ? hexRGB(col(qc ? qc[0] : gx, qc ? qc[1] : gy, qc ? qc[2] : gz)) : rgb0;   // painted per quad cell (both triangles share the colour: straight patch edges)
    for (const p of [a, b, c]) { pos.push(p[0], p[1], p[2]); colr.push(rgb[0], rgb[1], rgb[2]); nrm.push(nx / l, ny / l, nz / l); }
  };
  for (let k = 0; k < nR - 1; k++) {
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg, A = P[k][i], B = P[k][j], Cc = P[k + 1][j], D = P[k + 1][i];
      if (rings[k].pole) emit(A, Cc, D, k, k + 1, k + 1);
      else if (rings[k + 1].pole) emit(A, B, Cc, k, k, k + 1);
      else {
        const qc = [(A[0] + B[0] + Cc[0] + D[0]) / 4, (A[1] + B[1] + Cc[1] + D[1]) / 4, (A[2] + B[2] + Cc[2] + D[2]) / 4];
        emit(A, B, Cc, k, k, k + 1, qc); emit(A, Cc, D, k, k + 1, k + 1, qc);
      }
    }
  }
  if (globalThis.__WINDCHK) {   // test hook: signed volume (relative to the centroid) of every primitive; > 0 means CCW-outward
    let cx = 0, cy = 0, cz = 0; const n = pos.length / 3;
    for (let i = 0; i < n; i++) { cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2]; } cx /= n; cy /= n; cz /= n;
    let vol = 0;
    for (let i = 0; i < n; i += 3) {
      const o = i * 3, ax = pos[o] - cx, ay = pos[o + 1] - cy, az = pos[o + 2] - cz, bx = pos[o + 3] - cx, by = pos[o + 4] - cy, bz = pos[o + 5] - cz, qx = pos[o + 6] - cx, qy = pos[o + 7] - cy, qz = pos[o + 8] - cz;
      vol += ax * (by * qz - bz * qy) + ay * (bz * qx - bx * qz) + az * (bx * qy - by * qx);
    }
    globalThis.__WINDCHK.push(vol / 6);
  }
  return smoothen({ pos: new Float32Array(pos), nrm: new Float32Array(nrm), col: new Float32Array(colr), count: pos.length / 3 });
}
// detail d -> [near [seg,rings], far [seg,rings] | null]
// (far LOD: parts with d<=1 are dropped unless o.far is set)
const DETS = { 4: [[16, 9], [10, 5]], 3: [[14, 8], [9, 5]], 2: [[11, 6], [8, 4]], 1: [[8, 5], [6, 3]], 0: [[6, 4], [5, 3]], '-1': [[5, 3], null] };
function pick(d, o) {
  const t = DETS[d][FAR ? 1 : 0];
  if (!t || (FAR && d <= 1 && !(o && o.far)) || (FAR && o && o.nf)) return null;
  let seg = t[0], rings = t[1];
  if (o) { if (o.seg) seg = FAR ? Math.max(5, Math.round(o.seg * .6)) : o.seg; if (o.rings) rings = FAR ? Math.max(3, Math.round(o.rings * .55)) : o.rings; }
  return [seg, rings];
}
// puff: smooth egg-shaped ellipsoid, poles on the local Z axis (front/back). egg>0 = fatter toward the back; k<1 = fuller barrel
// (radius ~ sin^k); rot = [rx,ry,rz].
function P(d, hex, a, p, o = {}) {
  const sr = pick(d, o); if (!sr) return null;
  const [seg, n] = sr, egg = o.egg || 0, kk = o.k || 1, rings = [];
  for (let k = 0; k <= n; k++) {
    const th = Math.PI * k / n, pole = k === 0 || k === n, s = pole ? 0 : Math.pow(Math.sin(th), kk), z = Math.cos(th), f = 1 - egg * z;
    rings.push({ c: [0, 0, a[2] * z], u: [a[0] * s * f, 0, 0], v: [0, a[1] * s * f, 0], pole });
  }
  const R = o.rot ? rotMat(o.rot[0], o.rot[1], o.rot[2]) : null;
  const T = q => R ? [R[0]*q[0] + R[1]*q[1] + R[2]*q[2] + p[0], R[3]*q[0] + R[4]*q[1] + R[5]*q[2] + p[1], R[6]*q[0] + R[7]*q[1] + R[8]*q[2] + p[2]] : [q[0] + p[0], q[1] + p[1], q[2] + p[2]];
  return surf(rings, seg, hex, o.col, T);
}
// tube: smooth rounded tapered tube through nodes [x,y,z,r(,sx,sy)] with round caps. o: seg, cs (cap steps), open0/open1 (no cap),
// capK (cap length / radius), ref (frame hint), sx/sy (cross-section stretch), col.
function tube(nodes, hex, o = {}) {
  if (FAR && o.nf) return null;
  const seg = o.seg ? (FAR ? Math.max(5, Math.round(o.seg * .65)) : o.seg) : (FAR ? 6 : 8);
  const cs = o.cs != null ? (FAR ? Math.min(1, o.cs) : o.cs) : (FAR ? 1 : 2), capK = o.capK ?? .85, ref0 = o.ref || [0, 1, 0];
  const n = nodes.length, rings = [];
  const nrm3 = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const crs = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
  const info = nodes.map((q, i) => {
    const a = nodes[Math.max(0, i - 1)], b = nodes[Math.min(n - 1, i + 1)];
    const t = nrm3([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    let ref = ref0; if (Math.abs(t[0]*ref[0] + t[1]*ref[1] + t[2]*ref[2]) > .92) ref = Math.abs(t[2]) < .9 ? [0, 0, 1] : [1, 0, 0];
    const u = nrm3(crs(t, ref)), v = nrm3(crs(t, u));
    return { t, u, v, sx: q[4] ?? o.sx ?? 1, sy: q[5] ?? o.sy ?? 1 };
  });
  const ring = (i, s, r) => { const q = nodes[i], f = info[i]; return { c: [q[0] + f.t[0]*s, q[1] + f.t[1]*s, q[2] + f.t[2]*s], u: f.u.map(x => x * r * f.sx), v: f.v.map(x => x * r * f.sy), pole: r === 0 }; };
  if (!o.open0) {
    rings.push(ring(0, -nodes[0][3] * capK, 0));
    for (let j = 1; j <= cs; j++) { const ang = j / (cs + 1) * HP; rings.push(ring(0, -nodes[0][3] * capK * Math.cos(ang), nodes[0][3] * Math.sin(ang))); }
  }
  for (let i = 0; i < n; i++) rings.push(ring(i, 0, nodes[i][3]));
  if (!o.open1) {
    for (let j = cs; j >= 1; j--) { const ang = j / (cs + 1) * HP; rings.push(ring(n - 1, nodes[n - 1][3] * capK * Math.cos(ang), nodes[n - 1][3] * Math.sin(ang))); }
    rings.push(ring(n - 1, nodes[n - 1][3] * capK, 0));
  }
  return surf(rings, seg, hex, o.col, q => q);
}
const limb = (p0, p1, r0, r1, hex, o) => tube([[p0[0], p0[1], p0[2], r0], [p1[0], p1[1], p1[2], r1]], hex, o);
// painted spots: spots(base, [[cx,cy,cz, rx,ry,rz, hex], ...]) -> colour function (model space ellipsoid regions)
const spots = (base, list) => (x, y, z) => {
  for (const s of list) { const dx = (x - s[0]) / s[3], dy = (y - s[1]) / s[4], dz = (z - s[2]) / s[5]; if (dx*dx + dy*dy + dz*dz < 1) return s[6]; }
  return base;
};

// merge that carries the optional per-vertex attributes: nol (excluded from the outline hull) and fix (colour NOT multiplied by the instance tint)
function mergeX(list) {
  const parts = list.flat(Infinity).filter(Boolean), g = merge(parts);
  if (parts.some(p => p.nol || p.fix)) {
    for (const k of ['nol', 'fix']) {
      if (!parts.some(p => p[k])) continue;
      const a = new Float32Array(g.count); let o = 0;
      for (const p of parts) { if (p[k]) a.set(p[k].subarray(0, p.count), o); o += p.count; }
      g[k] = a;
    }
  }
  return g;
}
const M = (...parts) => mergeX(parts);
const withAttr = (g, k) => { if (g) g[k] = new Float32Array(g.count).fill(1); return g; };
const S2 = fn => [fn(1), fn(-1)];
const EYE = 0x1a1513;
// tiny square-ish dark eye on the side of a head (ACC only)
const eye = (side, x, y, z, s) => withAttr(box(s, s, s * .6, EYE, side * x, y, z, 0, side * .85, 0), 'nol');
const eyes = (x, y, z, s) => [eye(1, x, y, z, s), eye(-1, x, y, z, s)];
const NEARONLY = (...parts) => FAR ? null : M(...parts);

// ---------------------------------------------------------------- animal models
// Each builder returns {body, head, acc?, fan?}. Colours here are the BASE colours the variant tints are computed against.
const CH = { w: 0xf4f0e6, wing: 0xe4dfd0, tail: 0xdad3c0, red: 0xd2423a, beak: 0xe9b64a };
function chicken() {
  const body = M(
    P(3, CH.w, [.165, .155, .21], [0, 0, -.01], { egg: .26, k: .85 }),
    S2(x => P(1, CH.wing, [.052, .105, .15], [x * .148, 0, -.03], { rot: [0, 0, x * .14] })),
    [-1, 0, 1].map(k => P(0, k ? CH.wing : CH.tail, [.036, .108, .054], [k * .05, .12, -.208], { rot: [-.8, 0, k * .32] })),
  );
  const head = P(2, CH.w, [.09, .092, .098], [0, .055, .045]);
  const acc = NEARONLY(
    [P(0, CH.red, [.02, .034, .03], [0, .14, .09]), P(0, CH.red, [.022, .046, .034], [0, .15, .055]), P(0, CH.red, [.02, .034, .03], [0, .14, .02])],
    P(0, CH.red, [.024, .038, .022], [0, -.005, .125]),
    rod(0, .042, .105, 0, .032, .2, .036, .012, CH.beak, 4),
    eyes(.082, .08, .082, .02),
  );
  return { body, head, acc };
}

const DK = { chest: 0x80604a, back: 0x55525f, flank: 0xa9a5b4, rear: 0x3d3b47, wing: 0x7a6a58, green: 0x4a9a62, ring: 0xf4f2ea, bill: 0xe8b530,
  pBody: 0xd6c4a6, pWing: 0xc9b392, pHead: 0xd6c4a6 };
function duck() {
  const bcol = PLAIN ? null : (x, y, z) => (z < -.17 ? DK.rear : (z > .07 && y < .09) ? DK.chest : y > .075 ? DK.back : DK.flank);
  const body = M(
    P(3, PLAIN ? DK.pBody : DK.flank, [.165, .15, .225], [0, 0, 0], { egg: .1, k: .85, col: bcol }),
    S2(x => P(1, PLAIN ? DK.pWing : DK.wing, [.03, .08, .14], [x * .146, .025, -.045], { rot: [0, 0, x * .06] })),
    P(1, PLAIN ? DK.pWing : DK.rear, [.052, .048, .085], [0, .075, -.225], { rot: [-.6, 0, 0] }),
  );
  const head = M(
    P(2, PLAIN ? DK.pHead : DK.green, [.092, .09, .098], [0, .062, .05]),
    PLAIN ? null : P(0, DK.ring, [.088, .088, .032], [0, -.005, .035], { rot: [HP, 0, 0] }),
  );
  const acc = NEARONLY(P(1, DK.bill, [.052, .022, .078], [0, .045, .155]), eyes(.084, .09, .085, .02));
  return { body, head, acc };
}

const TK = { body: 0x8a6240, breast: 0xa57858, wing: 0x6d4b30, tail: 0x5e4129, head: 0xd6a99a, red: 0xcf3040, beak: 0xe6bb55,
  fanEdge: 0xb89268, fanMid: 0x96606a, fanIn: 0xc9b690, fanBase: 0x5e4129 };
function turkey() {
  const body = M(
    P(3, TK.body, [.25, .24, .31], [0, 0, 0], { egg: .3, col: (x, y, z) => (z > .08 && y < .0 && Math.abs(x) < .21 ? TK.breast : TK.body) }),
    S2(x => P(2, TK.wing, [.06, .15, .22], [x * .225, .02, -.04], { rot: [0, 0, x * .12] })),
    P(1, TK.tail, [.13, .1, .1], [0, .09, -.31], { rot: [-.4, 0, 0] }),
  );
  const head = M(
    tube([[0, -.02, -.04, .125], [0, .11, .04, .095], [0, .2, .085, .075]], TK.head, { open0: true, seg: 10, cs: 1 }),
    P(2, TK.head, [.09, .09, .105], [0, .275, .11]),
  );
  const acc = NEARONLY(
    P(0, TK.red, [.022, .045, .022], [0, .205, .165], { rot: [.2, 0, 0] }), P(0, TK.red, [.02, .05, .02], [0, .34, .18], { rot: [.3, 0, 0] }),
    rod(0, .262, .205, 0, .252, .29, .036, .013, TK.beak, 4),
    eyes(.088, .295, .125, .022),
  );
  // tail fan: origin at the fan base; concentric colour bands (outer tan, mauve, cream centre), thin rounded discs facing +Z
  const fan = M(
    P(3, TK.fanEdge, [.62, .6, .028], [0, .46, -.03], { seg: 18, rings: 4 }),
    P(3, TK.fanMid, [.5, .48, .028], [0, .45, 0], { seg: 18, rings: 4 }),
    P(3, TK.fanIn, [.33, .31, .028], [0, .43, .03], { seg: 16, rings: 4 }),
    P(2, TK.fanBase, [.14, .1, .06], [0, .0, 0]),
  );
  return { body, head, acc, fan };
}

const RB = { body: 0xd8c2a4, hau: 0xc8ae8c, light: 0xf6efe4, pink: 0xf0a3b2, ear: 0xd8c2a4 };
function rabbit() {
  const body = M(
    P(3, RB.body, [.12, .12, .15], [0, 0, 0], { egg: .22, seg: 12, rings: 7 }),
    S2(x => P(1, RB.hau, [.058, .09, .105], [x * .088, -.01, -.085], { rot: [0, 0, x * .1] })),
    P(1, RB.light, [.056, .056, .056], [0, .03, -.165]),
  );
  const head = M(
    P(2, RB.body, [.1, .095, .105], [0, .05, .05], { seg: 10, rings: 6 }),
    S2(x => P(0, RB.light, [.052, .046, .05], [x * .04, -.005, .115])),
    S2(x => P(0, RB.ear, [.042, .14, .024], [x * .05, .205, -.0], { rot: [-.22, 0, x * -.16], far: 1 })),
  );
  const acc = NEARONLY(
    P(-1, RB.pink, [.022, .018, .018], [0, .03, .17]),
    S2(x => P(-1, RB.pink, [.02, .09, .013], [x * .05, .205, .014], { rot: [-.22, 0, x * -.16] })),
    eyes(.088, .075, .09, .02),
  );
  return { body, head, acc };
}

const GT = { body: 0xe8dfca, patch: 0xb08458, muzzle: 0xf4ecdb, ear: 0xd6c8a8, beard: 0xb08458, horn: 0x8a6c4a, nose: 0x3b2e26 };
function goat() {
  const body = M(
    P(3, GT.body, [.205, .225, .33], [0, 0, 0], { egg: .08, k: .75 }),
    P(1, GT.body, [.05, .05, .09], [0, .17, -.32], { rot: [-.7, 0, 0] }),
  );
  const head = M(
    tube([[0, -.06, -.06, .13], [0, .05, .06, .115]], GT.body, { open0: true, seg: 10, cs: 1 }),
    P(2, GT.body, [.115, .12, .135], [0, .095, .12]),
    P(2, GT.muzzle, [.07, .065, .09], [0, .05, .245]),
    S2(x => P(1, GT.ear, [.08, .024, .05], [x * .135, .15, .07], { rot: [0, 0, x * .45] })),
    limb([0, .01, .22], [0, -.1, .2], .03, .018, GT.beard, { seg: 5, cs: 1, nf: true }),
  );
  const acc = NEARONLY(
    P(-1, GT.nose, [.032, .024, .018], [0, .06, .325]),
    S2(x => rod(x * .065, .2, .07, x * .09, .29, .0, .038, .014, GT.horn, 5)),
    eyes(.108, .125, .15, .022),
  );
  return { body, head, acc };
}

const SH = { wool: 0xf8f5ec, wool2: 0xe8e3d5, face: 0x39322f, ear: 0x39322f, nose: 0x1f1a19 };
function sheep() {
  const body = M(
    P(4, SH.wool, [.33, .3, .385], [0, 0, 0], { egg: .05, k: .66 }),
    P(1, SH.wool2, [.24, .13, .26], [0, .24, .03], { seg: 9, rings: 5 }),
    P(1, SH.wool, [.22, .2, .13], [0, .1, .32], { seg: 9, rings: 5 }),                       // shoulder / neck wool
    P(1, SH.wool2, [.22, .18, .14], [0, .09, -.33], { seg: 9, rings: 5 }),
  );
  const head = M(
    P(2, SH.face, [.105, .118, .14], [0, .05, .13]),
    S2(x => P(0, SH.ear, [.085, .03, .045], [x * .13, .11, .06], { rot: [0, 0, x * .6] })),
  );
  const acc = NEARONLY(
    P(-1, SH.nose, [.03, .022, .02], [0, .03, .27]),
    eyes(.098, .1, .19, .02),
  );
  return { body, head, acc };
}

const PG = { body: 0xe2a8a8, snout: 0xdb9494, ear: 0xd79090, nostril: 0x5a2a30, tail: 0xd79090 };
function pig() {
  const body = M(
    P(4, PG.body, [.35, .32, .46], [0, 0, 0], { egg: .1, k: .62 }),
    tube([[0, .18, -.42, .026], [0, .27, -.5, .022], [.05, .31, -.47, .02], [0, .33, -.42, .018]], PG.tail, { seg: 5, cs: 1, nf: true }),
  );
  const head = M(
    P(3, PG.body, [.21, .2, .22], [0, 0, .17]),
    P(2, PG.snout, [.125, .105, .06], [0, -.04, .39]),
    S2(x => P(1, PG.ear, [.095, .032, .085], [x * .15, .165, .1], { rot: [.5, x * .35, x * .75] })),
  );
  const acc = NEARONLY(
    S2(x => P(-1, PG.nostril, [.018, .03, .014], [x * .04, -.035, .45])),
    eyes(.15, .085, .22, .02),
  );
  return { body, head, acc };
}

const CW = { body: 0xf2efe8, patch: 0x2d2b31, pink: 0xeeaab0, horn: 0xcfc6ae, nostril: 0x7a3a46, tag: 0xe7c34b };
// Round, blotchy spots: flat dark ellipsoids sunk into the hide (their intersection with the body is a smooth round outline).
// at: model-space direction from the body centre. Returns a part (null when plain or far).
// Merge a normal part with "decal" parts whose vertices are excluded from the outline hull (geo.nol = 1 per vertex).
function noOutline(base, decals) {
  const g = mergeX([base, withAttr(decals, 'nol')]);
  if (!g.nol) g.nol = new Float32Array(g.count);
  return g;
}
const blotch = (hex, ex, c, at, r, asp, spin, sink = .028, sr = [10, 4], always = false) => {
  if ((PLAIN && !always) || FAR) return null;
  const l = Math.hypot(at[0], at[1], at[2]), d = at.map(v => v / l);
  const t = 1 / Math.sqrt((d[0] / ex[0]) ** 2 + (d[1] / ex[1]) ** 2 + (d[2] / ex[2]) ** 2) * 1.04;     // surface point (barrel is fuller than the ellipsoid)
  const n = [d[0] * t / ex[0] ** 2, d[1] * t / ex[1] ** 2, d[2] * t / ex[2] ** 2], nl = Math.hypot(n[0], n[1], n[2]), nn = n.map(v => v / nl);
  const pos = [c[0] + d[0] * t - nn[0] * sink, c[1] + d[1] * t - nn[1] * sink, c[2] + d[2] * t - nn[2] * sink];
  return P(2, hex, [r, r * asp, .05], pos, { rot: [Math.asin(-nn[1]), Math.atan2(nn[0], nn[2]), spin], seg: sr[0], rings: sr[1] });
};
function cow() {
  const BEX = [.44, .48, .74];
  const sp = [
    [.4, .22, .12, .22, .3, .34, CW.patch], [-.35, .1, -.3, .22, .32, .3, CW.patch], [.0, .42, -.12, .3, .16, .32, CW.patch],
    [-.3, .3, .36, .22, .2, .22, CW.patch], [.32, -.12, -.5, .2, .24, .2, CW.patch], [-.2, .0, .55, .15, .15, .18, CW.patch],
  ];
  const BL = (hex, at, r, asp, spin) => blotch(hex, BEX, [0, 0, 0], at, r, asp, spin);
  const body = noOutline(M(
    P(4, CW.body, [.44, .48, .74], [0, 0, 0], { egg: .1, k: .62, col: PLAIN || !FAR ? null : spots(CW.body, sp) }),
    P(1, CW.pink, [.12, .11, .14], [0, -.44, -.42]),
    limb([0, .3, -.78], [0, -.32, -.88], .035, .028, CW.body, { seg: 5, cs: 1, nf: true }), P(0, PLAIN ? CW.body : CW.patch, [.06, .12, .06], [0, -.4, -.88]),
  ), M(
    // blotches: big irregular flank patches, a back saddle, a rump patch (two overlapping blobs read as one organic shape)
    BL(CW.patch, [1, .35, .15], .26, .85, .4), BL(CW.patch, [1, .1, .38], .15, 1.1, 1.2),
    BL(CW.patch, [-1, .2, -.35], .28, .9, 2.1), BL(CW.patch, [-1, .0, -.6], .14, 1, .5),
    BL(CW.patch, [-.2, 1, -.15], .24, .7, .8), BL(CW.patch, [.35, .95, .3], .15, 1, 0),
  ));
  const HEX = [.31, .31, .34], HC = [0, .02, .32];
  const BH = (at, r, asp, spin) => blotch(CW.patch, HEX, HC, at, r, asp, spin, .02);
  const head = noOutline(M(
    tube([[0, -.05, -.12, .36], [0, .0, .14, .31]], CW.body, { open0: true, seg: 12, cs: 1 }),
    P(3, CW.body, [.31, .31, .34], [0, .02, .32], { col: PLAIN || !FAR ? null : spots(CW.body, [[0, .12, .3, .3, .16, .25, CW.patch], [.2, -.0, .3, .12, .24, .25, CW.patch], [-.2, -.0, .3, .12, .24, .25, CW.patch]]) }),
    S2(x => P(1, PLAIN ? CW.body : CW.patch, [.16, .045, .095], [x * .34, .13, .16], { rot: [0, 0, x * .3] })),
  ), M(
    BH([1, .55, .35], .13, 1.1, .3), BH([-.15, 1, .1], .1, 1.3, .9),
  ));
  const acc = NEARONLY(
    P(2, CW.pink, [.225, .165, .16], [0, -.11, .57]),
    S2(x => P(-1, CW.nostril, [.03, .036, .018], [x * .09, -.09, .72])),
    S2(x => rod(x * .21, .33, .16, x * .32, .42, .14, .065, .026, CW.horn, 5)),
    S2(x => box(.06, .07, .012, CW.tag, x * .43, .13, .16, 0, x * .5, x * .2)),
    eyes(.28, .12, .42, .037),
  );
  return { body, head, acc };
}

const HR = { body: 0xe9e5dc, mane: 0xd8c08a, nostril: 0x40302a, muzzle: 0xdcd0c0 };
function horse() {
  const body = M(
    P(4, HR.body, [.34, .38, .62], [0, 0, 0], { egg: .08, k: .66 }),
    tube([[0, .2, -.6, .09], [0, .1, -.78, .085], [0, -.12, -.9, .07], [0, -.4, -.93, .045]], HR.mane, { seg: 7, cs: 0, ref: [1, 0, 0] }),
    P(1, HR.mane, [.09, .1, .1], [0, .22, -.6], { far: 1 }),
  );
  const tilt = .5, hc = [0, .5, .34];
  const head = M(
    tube([[0, -.06, -.06, .29], [0, .18, .1, .23], [0, .34, .2, .19]], HR.body, { open0: true, seg: 12, cs: 1 }),
    P(3, HR.body, [.16, .17, .26], [hc[0], hc[1], hc[2]], { rot: [tilt, 0, 0], seg: 14, rings: 8 }),
    [0, 1, 2, 3].map(k => { const t = k / 3; return P(0, HR.mane, [.055, .1, .08], [0, -.0 + .42 * t + .08, -.08 + .3 * t - .1], { rot: [-.6, 0, 0], far: k === 1 }); }),
    S2(x => P(0, HR.body, [.052, .12, .035], [x * .085, hc[1] + .2, hc[2] - .06], { rot: [-.15, 0, x * .15] })),
    P(0, HR.mane, [.07, .07, .085], [0, hc[1] + .16, hc[2] + .06]),
  );
  const sa = Math.sin(tilt), ca = Math.cos(tilt);
  const acc = NEARONLY(
    P(2, HR.muzzle, [.105, .1, .11], [0, hc[1] - sa * .24, hc[2] + ca * .24], { rot: [tilt, 0, 0] }),
    S2(x => P(-1, HR.nostril, [.017, .024, .014], [x * .045, hc[1] - sa * .33, hc[2] + ca * .31 + .01])),
    eyes(.138, hc[1] + .06, hc[2] - .01, .032),
  );
  return { body, head, acc };
}

const LL = { wool: 0xf0e7d3, wool2: 0xe3d7bd, face: 0xb59d80, ear: 0xc9b392, nose: 0x3a2e26 };
function llama() {
  const body = M(
    P(4, LL.wool, [.37, .37, .54], [0, 0, 0], { egg: .06, k: .66 }),
    P(2, LL.wool2, [.27, .13, .3], [0, .27, .04], { seg: 10, rings: 6 }),
    P(1, LL.wool2, [.16, .15, .13], [0, .12, -.5], { seg: 8, rings: 5 }),
  );
  const head = M(
    tube([[0, -.04, -.02, .23], [0, .27, .06, .18], [0, .55, .1, .15]], LL.wool2, { open0: true, seg: 12, cs: 1 }),
    P(2, LL.wool, [.12, .13, .12], [0, .66, .1], { seg: 10, rings: 6 }),
    P(2, LL.face, [.125, .13, .16], [0, .78, .2], { rot: [.25, 0, 0] }),
    S2(x => P(1, LL.ear, [.045, .125, .028], [x * .08, .93, .15], { rot: [-.1, 0, x * .12], seg: 7, rings: 4 })),
  );
  const acc = NEARONLY(
    P(-1, LL.nose, [.036, .03, .02], [0, .75, .34]),
    eyes(.13, .82, .245, .03),
  );
  return { body, head, acc };
}

// ================================================================ NEW SPECIES (ids 10-19)
// cheap round decal (sunk flat ellipsoid, excluded from the outline hull by noOutline()); 8x3 ~ 32 tris
const SR = [7, 3];

const DN = { body: 0x8f8176, belly: 0xddd3c4, muzzle: 0xe6dccc, stripe: 0x453b34, mane: 0x4a403a, nostril: 0x3a302b };
function donkey() {
  const BEX = [.34, .37, .58];
  const BL = (hex, at, r, asp, spin, sink = .03) => blotch(hex, BEX, [0, 0, 0], at, r, asp, spin, sink, SR, true);
  const body = noOutline(M(
    P(3, DN.body, [.34, .37, .58], [0, 0, 0], { egg: .07, k: .68, seg: 14, rings: 8 }),
    tube([[0, .2, -.55, .04], [0, .06, -.64, .035], [0, -.15, -.67, .03]], DN.mane, { seg: 6, cs: 1, nf: true }),
    P(0, DN.mane, [.05, .09, .05], [0, -.25, -.67]),
  ), M(
    BL(DN.belly, [0, -1, .1], .22, 2.2, 0),
    BL(DN.stripe, [0, 1, -.05], .045, 7, 0, .035),
    BL(DN.stripe, [1, 1, .45], .05, 4.5, 0, .035), BL(DN.stripe, [-1, 1, .45], .05, 4.5, 0, .035),
  ));
  const tilt = .55, hc = [0, .36, .3], sa = Math.sin(tilt), ca = Math.cos(tilt);
  const head = M(
    tube([[0, -.04, -.05, .22], [0, .14, .1, .17], [0, .26, .18, .15]], DN.body, { open0: true, seg: 11, cs: 1 }),
    P(3, DN.body, [.14, .15, .24], hc, { rot: [tilt, 0, 0], seg: 12, rings: 7 }),
    P(2, DN.muzzle, [.105, .1, .115], [0, hc[1] - sa * .22, hc[2] + ca * .22], { rot: [tilt, 0, 0], seg: 9, rings: 5 }),
    [0, 1, 2].map(k => P(0, DN.mane, [.04, .08, .08], [0, .1 + k * .1, -.02 + k * .1], { rot: [-.5, 0, 0], far: k === 1 })),
    S2(x => P(1, DN.body, [.055, .21, .032], [x * .1, hc[1] + .25, hc[2] - .1], { rot: [-.2, 0, x * .4], seg: 7, rings: 4, far: 1 })),
  );
  const acc = NEARONLY(
    S2(x => P(-1, DN.nostril, [.02, .026, .016], [x * .05, hc[1] - sa * .31, hc[2] + ca * .31 + .01])),
    S2(x => P(-1, DN.muzzle, [.03, .12, .012], [x * .105 + x * .01, hc[1] + .25, hc[2] - .1 + .03], { rot: [-.2, 0, x * .4] })),
    eyes(.13, hc[1] + .06, hc[2] - .02, .03),
  );
  return { body, head, acc };
}

const GS = { w: 0xf2f0ea, wing: 0xe2dfd6, bill: 0xe8962a };
function goose() {
  const body = M(
    P(3, GS.w, [.2, .18, .3], [0, 0, 0], { egg: .18, k: .85 }),
    S2(x => P(1, GS.wing, [.04, .105, .2], [x * .185, .03, -.06], { rot: [0, 0, x * .05] })),
    P(1, GS.wing, [.07, .06, .12], [0, .09, -.3], { rot: [-.5, 0, 0] }),
  );
  const head = M(
    tube([[0, -.02, -.04, .115], [0, .09, .06, .085], [0, .22, .04, .066], [0, .34, 0, .06], [0, .44, .06, .058]], GS.w, { seg: 10, cs: 1, capK: .5, ref: [1, 0, 0] }),
    P(2, GS.w, [.07, .07, .105], [0, .51, .13], { seg: 10, rings: 6 }),
  );
  const acc = NEARONLY(
    rod(0, .495, .215, 0, .48, .32, .04, .026, GS.bill, 5),
    P(0, GS.bill, [.034, .024, .034], [0, .545, .2]),
    eyes(.062, .535, .15, .02),
  );
  return { body, head, acc };
}

const AL = { wool: 0xeadfc8, wool2: 0xdfd0b2, face: 0xd9c8a6, nose: 0x3a2e26 };
function alpaca() {
  const body = M(
    P(4, AL.wool, [.3, .3, .4], [0, 0, 0], { egg: .05, k: .62 }),
    P(2, AL.wool2, [.22, .14, .26], [0, .24, .02], { seg: 10, rings: 6 }),
    P(1, AL.wool, [.2, .17, .12], [0, .08, .37], { seg: 9, rings: 5 }),
    P(1, AL.wool2, [.2, .17, .13], [0, .06, -.37], { seg: 9, rings: 5 }),
    P(0, AL.wool2, [.06, .1, .06], [0, .12, -.46], { rot: [-.6, 0, 0] }),
  );
  const head = M(
    tube([[0, -.04, -.02, .19], [0, .2, .06, .15], [0, .4, .1, .13]], AL.wool2, { open0: true, seg: 11, cs: 1, ref: [1, 0, 0] }),
    P(2, AL.wool, [.14, .13, .13], [0, .53, .1], { seg: 10, rings: 6 }),                   // fluffy topknot
    P(2, AL.face, [.09, .1, .11], [0, .52, .21], { rot: [.35, 0, 0] }),
    P(1, AL.face, [.055, .05, .06], [0, .48, .3], { rot: [.35, 0, 0] }),
    S2(x => P(1, AL.face, [.035, .1, .025], [x * .065, .7, .09], { rot: [-.15, 0, x * .3], seg: 7, rings: 4 })),
  );
  const acc = NEARONLY(
    P(-1, AL.nose, [.028, .02, .016], [0, .475, .335]),
    eyes(.088, .56, .24, .026),
  );
  return { body, head, acc };
}

const DR = { body: 0xa87a52, belly: 0xeadfca, white: 0xf6eedf, nose: 0x2e2420, antler: 0xd6c4a0 };
function deer() {
  const BEX = [.24, .26, .42];
  const BL = (hex, at, r, asp, spin, sink = .02, always = false) => blotch(hex, BEX, [0, 0, 0], at, r, asp, spin, sink, SR, always);
  const FS = (PLAIN || FAR) ? [] : [   // fawn spots (round decals), scattered over the back and flanks
    [[.3, 1, .45], .04, 1.1, 0], [[-.3, 1, .15], .038, 1, 1], [[.25, 1, -.2], .04, 1.15, 2], [[-.2, 1, -.5], .036, 1, 0.5],
    [[1, .6, .5], .042, 1.1, .3], [[1, .5, -.05], .045, 1, 1], [[1, .45, -.55], .04, 1, 2],
    [[-1, .6, .4], .042, 1, 0], [[-1, .5, -.15], .045, 1.1, .5], [[-1, .45, -.6], .04, 1, 1],
  ];
  const body = noOutline(M(
    P(3, DR.body, [.24, .26, .42], [0, 0, 0], { egg: .1, k: .7, seg: 13, rings: 8, col: PLAIN || !FAR ? null : spots(DR.body, [[0, .24, .1, .1, .06, .3, DR.white], [.14, .1, -.1, .1, .07, .2, DR.white]]) }),
    P(1, DR.white, [.055, .09, .05], [0, .16, -.43], { rot: [-.35, 0, 0] }),
  ), M(
    BL(DR.belly, [0, -1, .1], .14, 2.4, 0, .02, true),
    BL(DR.white, [0, .4, -1], .11, 1.25, 0, -.03, true),
    FS.map(f => BL(DR.white, f[0], f[1], f[2], f[3], .012)),
  ));
  const tilt = .5, hc = [0, .4, .22], sa = Math.sin(tilt), ca = Math.cos(tilt);
  const head = M(
    tube([[0, -.03, -.04, .14], [0, .14, .06, .105], [0, .28, .14, .09]], DR.body, { open0: true, seg: 10, cs: 1 }),
    P(3, DR.body, [.09, .1, .15], hc, { rot: [tilt, 0, 0], seg: 10, rings: 6 }),
    P(1, DR.belly, [.06, .055, .07], [0, hc[1] - sa * .13, hc[2] + ca * .13], { rot: [tilt, 0, 0] }),
    S2(x => P(1, DR.body, [.045, .11, .025], [x * .09, hc[1] + .11, hc[2] - .1], { rot: [-.1, 0, x * .6], seg: 8, rings: 5, far: 1 })),
  );
  const acc = NEARONLY(
    P(-1, DR.nose, [.03, .026, .02], [0, hc[1] - sa * .2, hc[2] + ca * .2 + .015]),
    eyes(.085, hc[1] + .05, hc[2] + .03, .026),
  );
  // antlers (stags): thick rounded beams with two tines each; ride on the head matrix
  const ant = (x) => {
    const b = [x * .05, hc[1] + .09, hc[2] - .1];
    return [
      tube([[b[0], b[1], b[2], .022], [x * .09, b[1] + .16, b[2] - .06, .02], [x * .13, b[1] + .32, b[2] - .04, .017], [x * .12, b[1] + .45, b[2] + .04, .012]], DR.antler, { seg: 6, cs: 1 }),
      rod(x * .09, b[1] + .16, b[2] - .06, x * .1, b[1] + .27, b[2] + .1, .016, .01, DR.antler, 5),
      rod(x * .13, b[1] + .32, b[2] - .04, x * .2, b[1] + .42, b[2] - .1, .014, .009, DR.antler, 5),
    ];
  };
  const male = NEARONLY(S2(ant));
  return { body, head, acc, male };
}

const OS = { body: 0x2e2c30, plume: 0xf3efe6, neck: 0xd9b2a4, beak: 0xe8cfa0, thigh: 0xd8b6a8 };
function ostrich() {
  const bc = PLAIN ? 0x8a7a68 : OS.body, pc = PLAIN ? 0xa39380 : OS.plume, nc = PLAIN ? 0xc9b4a2 : OS.neck;
  const body = M(
    P(4, bc, [.4, .42, .5], [0, 0, -.02], { egg: .22, k: .8 }),
    S2(x => P(2, pc, [.07, .22, .34], [x * .36, .0, -.06], { rot: [0, 0, x * .12], seg: 9, rings: 5 })),                // wings
    S2(x => P(2, PLAIN ? bc : OS.thigh, [.13, .24, .2], [x * .17, -.3, -.04], { seg: 9, rings: 5 })),                    // fluffy thighs
    P(2, pc, [.22, .2, .2], [0, .24, -.5], { rot: [-.5, 0, 0], seg: 10, rings: 5 }),                                       // tail plume
    P(1, pc, [.14, .14, .14], [0, .18, -.62], { rot: [-.8, 0, 0], seg: 8, rings: 4 }),
  );
  const head = M(
    tube([[0, -.1, -.08, .15], [0, .25, .0, .085], [0, .65, .1, .065], [0, .95, .2, .055]], nc, { open0: true, seg: 9, cs: 1, ref: [1, 0, 0] }),
    P(2, nc, [.062, .058, .09], [0, 1.03, .27], { seg: 9, rings: 5 }),
  );
  const acc = NEARONLY(
    P(1, OS.beak, [.034, .02, .06], [0, 1.0, .37], { seg: 7, rings: 4 }),
    eyes(.055, 1.07, .25, .026),
  );
  return { body, head, acc };
}

const YK = { fur: 0x4b3a2a, fur2: 0x3e2f22, fur3: 0x584532, horn: 0xcfc4a8, nose: 0x6e5e50 };
function yak() {
  const body = M(
    P(3, YK.fur, [.46, .5, .7], [0, .02, 0], { egg: .06, k: .66, seg: 10, rings: 7 }),
    P(2, YK.fur3, [.3, .24, .34], [0, .5, .28], { seg: 8, rings: 5 }),                                                    // shoulder hump
    // shaggy fur skirt: long drapes hanging from the flanks, with ragged tufts along the hem
    S2(x => P(2, YK.fur2, [.17, .36, .46], [x * .4, -.28, .2], { rot: [0, 0, x * .12], seg: 8, rings: 4 })),
    S2(x => P(2, YK.fur3, [.16, .34, .4], [x * .41, -.3, -.28], { rot: [0, 0, x * .14], seg: 8, rings: 4 })),
    P(2, YK.fur2, [.3, .3, .2], [0, -.26, .6], { seg: 8, rings: 4, nf: true }), P(2, YK.fur2, [.28, .28, .2], [0, -.26, -.62], { seg: 8, rings: 4, nf: true }),
    [-.5, 0, .5].map(z => S2(x => P(-1, YK.fur, [.09, .15, .12], [x * .5, -.6, z], { rot: [0, 0, x * .2] }))),
    tube([[0, .25, -.66, .07], [0, -.0, -.78, .08], [0, -.35, -.8, .08]], YK.fur2, { seg: 6, cs: 1, nf: true }),
  );
  const head = M(
    tube([[0, -.02, -.1, .4], [0, -.1, .16, .3]], YK.fur, { open0: true, seg: 11, cs: 1 }),
    P(3, YK.fur3, [.26, .27, .34], [0, -.12, .4], { rot: [.12, 0, 0], seg: 10, rings: 6 }),
    P(2, YK.fur, [.3, .15, .2], [0, .13, .27], { seg: 7, rings: 4 }),                                                  // forelock
    P(2, YK.nose, [.14, .11, .13], [0, -.24, .7], { seg: 9, rings: 5 }),
    S2(x => P(0, YK.fur2, [.1, .05, .09], [x * .28, .0, .2], { rot: [0, 0, x * .5] })),
  );
  const horn = x => tube([[x * .2, .04, .3, .075], [x * .4, .06, .26, .06], [x * .55, .22, .24, .045], [x * .6, .44, .28, .02]], YK.horn, { seg: 6, cs: 1 });
  const acc = NEARONLY(
    S2(horn),
    S2(x => P(-1, 0x2a2018, [.03, .04, .02], [x * .07, -.25, .82])),
    eyes(.235, -.04, .52, .035),
  );
  return { body, head, acc };
}

const BF = { body: 0x4f4d4f, belly: 0x65625f, muzzle: 0x7d7874, horn: 0xcdc3ac, hornTip: 0x3b3430, nose: 0x2a2528 };
function buffalo() {
  const body = M(
    P(4, BF.body, [.5, .5, .78], [0, 0, 0], { egg: .08, k: .62 }),
    P(2, BF.body, [.3, .14, .3], [0, .44, .3], { seg: 10, rings: 5 }),
    tube([[0, .25, -.74, .06], [0, -.02, -.86, .05], [0, -.4, -.9, .04]], BF.body, { seg: 6, cs: 1, nf: true }),
    P(0, BF.hornTip, [.06, .1, .06], [0, -.45, -.9]),
  );
  const head = M(
    tube([[0, -.04, -.1, .36], [0, -.04, .16, .29]], BF.body, { open0: true, seg: 12, cs: 1 }),
    P(3, BF.body, [.25, .26, .33], [0, -.04, .36], { rot: [.14, 0, 0], seg: 12, rings: 7 }),
    P(2, BF.muzzle, [.19, .15, .15], [0, -.17, .62], { seg: 10, rings: 5 }),
    S2(x => P(1, BF.body, [.15, .05, .1], [x * .31, .08, .14], { rot: [0, 0, x * .25], seg: 8, rings: 4 })),
  );
  // big swept crescent horns: out, back, then curling up
  const horn = x => tube([[x * .2, .2, .2, .085], [x * .46, .22, .08, .075], [x * .72, .3, -.06, .06], [x * .88, .5, -.08, .042], [x * .84, .72, .02, .022]], BF.horn, { seg: 7, cs: 1 });
  const acc = NEARONLY(
    S2(horn),
    S2(x => P(-1, BF.nose, [.035, .05, .02], [x * .08, -.17, .76])),
    eyes(.23, .08, .44, .035),
  );
  return { body, head, acc };
}

const PC = { neck: 0x2f6fa8, neckD: 0x265c93, belly: 0x1f4a78, back: 0x3d8a60, wing: 0xb7915a, wingD: 0x8c6a3c, white: 0xf2efe6, beak: 0xd9c9a0,
  trainOut: 0x4a9566, trainMid: 0x3a8460, trainIn: 0x2a5f8a, gold: 0xd2a640, eye: 0x1f5fa8, tail: 0x3d7a58 };
function peacock() {
  const hen = PLAIN, hb = 0x8a6a4c, hn = 0x7a8a78;
  const body = M(
    P(3, hen ? hb : PC.neckD, [.17, .17, .26], [0, 0, 0], { egg: .25, col: hen ? null : (x, y, z) => (y < -.04 ? PC.belly : y > .06 && z < .06 ? PC.back : PC.neckD) }),
    S2(x => P(2, hen ? 0x9c7c5c : PC.wing, [.04, .12, .2], [x * .145, .02, -.06], { rot: [0, 0, x * .1], seg: 8, rings: 5 })),
    P(1, hen ? 0x7a5c40 : PC.tail, [.07, .06, .14], [0, .03, -.3], { rot: [-.3, 0, 0], seg: 8, rings: 4 }),
  );
  const head = M(
    tube([[0, -.02, -.04, .11], [0, .12, .05, .08], [0, .24, .1, .062]], hen ? hn : PC.neck, { open0: true, seg: 9, cs: 1, ref: [1, 0, 0] }),
    P(2, hen ? hn : PC.neck, [.066, .068, .085], [0, .3, .14], { seg: 9, rings: 5 }),
  );
  const acc = NEARONLY(
    rod(0, .29, .205, 0, .275, .27, .02, .012, PC.beak, 4),
    P(-1, PC.white, [.012, .018, .014], [.062, .325, .17]), P(-1, PC.white, [.012, .018, .014], [-.062, .325, .17]),
    [-1, 0, 1].map(k => [rod(k * .02, .36, .12, k * .06, .46, .1, .006, .004, hen ? 0x7a5c40 : 0x24507c, 3), P(-1, hen ? 0x7a5c40 : PC.eye, [.014, .014, .014], [k * .06, .465, .1])]),
    eyes(.056, .325, .15, .018),
  );
  // train (fan): origin at its base; a symmetric two-sided disc (the eyes show from front and back) with rings of round "eyes"
  let fan = null;
  if (!hen) {
    const eyeSet = [];
    const ring = (n, r, arc, cy) => {
      for (let k = 0; k < n; k++) {
        const a = (n === 1 ? 0 : (k / (n - 1) - .5) * 2 * arc), x = Math.sin(a) * r, y = cy + Math.cos(a) * r * .9;
        for (const f of [1, -1]) eyeSet.push(P(0, PC.gold, [.06, .07, .02], [x, y, f * .034], { seg: 7, rings: 3 }), P(-1, PC.eye, [.034, .042, .02], [x, y, f * .052], { seg: 6, rings: 3 }));
      }
    };
    ring(9, .53, 1.35, .6); ring(6, .36, 1.0, .6); ring(3, .2, .5, .6);
    fan = M(
      P(3, PC.trainOut, [.64, .64, .03], [0, .62, 0], { seg: 18, rings: 4 }),
      P(3, PC.trainMid, [.5, .5, .036], [0, .62, 0], { seg: 16, rings: 4 }),
      eyeSet,
      P(2, PC.trainIn, [.1, .13, .045], [0, .6, 0], { seg: 8, rings: 4 }),
      P(2, PC.wingD, [.14, .1, .06], [0, .0, 0]),
    );
  }
  return { body, head, acc, fan };
}

const CM = { body: 0xc9a46c, hump: 0xbf9a62, muzzle: 0xb8935c, nose: 0x4a3a2c, hair: 0x9c7a4a };
function camel() {
  const body = M(
    P(4, CM.body, [.4, .4, .62], [0, 0, 0], { egg: .08, k: .62 }),
    P(2, CM.hump, [.27, .3, .3], [0, .42, -.02], { seg: 11, rings: 6, rot: [-.1, 0, 0] }),
    P(1, CM.hair, [.2, .14, .16], [0, -.3, .5], { seg: 8, rings: 4 }),            // chest pad
    tube([[0, .2, -.6, .05], [0, .0, -.7, .05], [0, -.3, -.72, .04]], CM.hair, { seg: 6, cs: 1, nf: true }),
  );
  const head = M(
    tube([[0, -.05, -.06, .23], [0, .22, .02, .16], [0, .5, .14, .13], [0, .76, .2, .125]], CM.body, { open0: true, seg: 11, cs: 1, ref: [1, 0, 0] }),
    P(1, CM.hair, [.16, .14, .14], [0, .06, .04], { seg: 8, rings: 4 }),            // neck mane
    P(2, CM.body, [.14, .15, .19], [0, .9, .27], { rot: [.35, 0, 0], seg: 10, rings: 6 }),
    P(2, CM.muzzle, [.11, .09, .12], [0, .84, .44], { rot: [.35, 0, 0], seg: 9, rings: 5 }),
    S2(x => P(0, CM.body, [.04, .055, .03], [x * .11, 1.02, .2], { rot: [0, 0, x * .5] })),
  );
  const acc = NEARONLY(
    S2(x => P(-1, CM.nose, [.022, .028, .016], [x * .045, .84, .54])),
    eyes(.115, .94, .3, .032),
  );
  return { body, head, acc };
}

const CB = { body: 0x8f6a45, dark: 0x6f4f33, snout: 0x7a5538, nose: 0x2e2018, ear: 0x6f4f33 };
function capybara() {
  const body = M(
    P(4, CB.body, [.3, .29, .47], [0, 0, 0], { egg: .04, k: .55 }),
    P(1, CB.dark, [.05, .04, .04], [0, .0, -.48]),
  );
  const head = M(
    tube([[0, -.02, -.12, .26], [0, .0, .1, .21]], CB.body, { open0: true, seg: 11, cs: 1 }),
    P(3, CB.body, [.19, .2, .25], [0, .02, .2], { seg: 12, rings: 7 }),
    P(2, CB.snout, [.17, .17, .16], [0, -.03, .41], { seg: 10, rings: 6 }),
    S2(x => P(0, CB.ear, [.045, .055, .035], [x * .15, .18, .06], { rot: [0, 0, x * .5] })),
  );
  const acc = NEARONLY(
    S2(x => P(-1, CB.nose, [.027, .032, .016], [x * .065, .0, .565])),
    P(-1, CB.nose, [.1, .03, .02], [0, -.1, .55]),
    eyes(.17, .1, .26, .03),
  );
  return { body, head, acc };
}

const BUILD = [chicken, duck, turkey, rabbit, goat, sheep, pig, cow, horse, llama, donkey, goose, alpaca, deer, ostrich, yak, buffalo, peacock, camel, capybara];
const HAS_ALT = [false, true, false, false, false, false, false, true, false, false, false, false, false, true, true, false, false, true, false, false];   // species with a plain (un-patterned) variant mesh

// ---------------------------------------------------------------- RIG data
// Colour variants: tint = target / base. Per species: base colours (body mesh / head mesh / plain body / plain head), then variants.
const hx = hexRGB;
const tintOf = (t, b) => { const T = hx(t), B = hx(b); return [Math.min(4, T[0] / B[0]), Math.min(4, T[1] / B[1]), Math.min(4, T[2] / B[2])]; };
// VAR[s] = { base:{b,h,pb,ph}, v:[{b,h,hm,hf,l,alt}] } ; b/h/l hex targets; hm/hf = male/female head target; l = leg colour; alt = plain mesh
const VAR = [
  { base: { b: CH.w, h: CH.w }, v: [
    { b: 0xf6f2e8, l: 0x39332f }, { b: 0x8e9094, l: 0x2c2827 }, { b: 0xb06a38, l: 0x4a3a2c }, { b: 0x2e2d33, l: 0x1c1a1a }] },
  { base: { b: DK.flank, h: DK.green, pb: DK.pBody, ph: DK.pHead }, v: [
    { b: DK.flank, h: DK.green, hf: 0x9a7c5c, l: 0xe0a02c }, { b: 0x84634a, h: 0x84634a, l: 0xdc9a2a, alt: 1 }, { b: 0xfaf8f2, h: 0xfaf8f2, l: 0xe8a830, alt: 1 }] },
  { base: { b: TK.body, h: TK.head }, v: [
    { b: TK.body, h: 0xd6a99a, hm: 0xd98a80, l: 0xb08a80 }, { b: 0x34323a, h: 0x8e92a8, hm: 0x9a8aa0, l: 0x5a4a50 }, { b: 0x9a8a78, h: 0xd2b2a8, hm: 0xd6948a, l: 0xb69a90 }] },
  { base: { b: RB.body, h: RB.body }, v: [
    { b: 0xd8c2a4, l: 0xd0b898 }, { b: 0xf8f4ee, l: 0xeadfd2 }, { b: 0x8c8884, l: 0x7a7672 }, { b: 0x9a7452, l: 0x8a6444 }] },
  { base: { b: GT.body, h: GT.body }, v: [
    { b: 0xe8dfca, l: 0x6a5846 }, { b: 0xb78c60, l: 0x4a3a2c }, { b: 0x3a3532, l: 0x2a2624 }, { b: 0xd2c6b0, l: 0x7a6a58 }] },
  { base: { b: SH.wool, h: SH.face }, v: [
    { b: 0xf8f5ec, h: 0x39322f, l: 0x3c3532 }, { b: 0x2f2d31, h: 0xa88a6a, l: 0xa88a6a }, { b: 0x7e5a3c, h: 0x3b302a, l: 0x3b302a }] },
  { base: { b: PG.body, h: PG.body }, v: [
    { b: 0x8a8c96, l: 0x6e7078 }, { b: 0x383840, l: 0x2c2c34 }, { b: 0xe2a8a8, l: 0xd48f94 }] },
  { base: { b: CW.body, h: CW.body, pb: CW.body, ph: CW.body }, v: [
    { b: CW.body, l: 0xe8e4dc }, { b: 0xbaa78b, l: 0xcdbfa4, alt: 1 }, { b: 0xf8f6f0, l: 0xece8e0, alt: 1 }] },
  { base: { b: HR.body, h: HR.body }, v: [
    { b: 0x9a7452, l: 0x8a6444 }, { b: 0x34343c, l: 0x2e2e34 }, { b: 0xf8f5ee, l: 0xe6e2da }] },
  { base: { b: LL.wool, h: LL.wool }, v: [
    { b: 0xb87a3e, l: 0x8a7458 }, { b: 0x2f2d33, l: 0x5a5458 }, { b: 0xf8f1e2, l: 0xb59d80 }] },
  // 10 donkey
  { base: { b: DN.body, h: DN.body }, v: [{ b: DN.body, l: 0x5a4a40 }, { b: 0x6c5848, l: 0x4a3a30 }, { b: 0xb4aca4, l: 0x7a6e66 }, { b: 0x4e443e, l: 0x3a322c }] },
  // 11 goose
  { base: { b: GS.w, h: GS.w }, v: [{ b: 0xf6f4ee, l: 0xe8962a }, { b: 0xa59c8e, l: 0xd98a2a }, { b: 0x8c7660, l: 0xd98a2a }] },
  // 12 alpaca
  { base: { b: AL.wool, h: AL.wool }, v: [{ b: AL.wool, l: 0xa89478 }, { b: 0x8d6c4c, l: 0x6a5038 }, { b: 0xf8f4ea, l: 0xc8b89c }, { b: 0x5e4e44, l: 0x3e332d }] },
  // 13 deer: base = spotted fawn mesh, alt = plain adult
  { base: { b: DR.body, h: DR.body, pb: DR.body, ph: DR.body }, v: [{ b: DR.body, l: 0x9a7452, alt: 1 }, { b: 0x8f6644, l: 0x7a5a3c, alt: 1 }, { b: 0xb98a5c, l: 0xa88058 }, { b: 0xb98a5c, l: 0xa88058, alt: 1 }] },
  // 14 ostrich: base = black/white male mesh, alt = grey-brown female mesh
  { base: { b: OS.body, h: OS.neck, pb: 0x8a7a68, ph: 0xc9b4a2 }, v: [{ b: OS.body, h: 0xdcae9e, hm: 0xe0a090, l: 0xd8a898 }, { b: 0x8a7a68, h: 0xc9b4a2, l: 0xc4a898, alt: 1 }, { b: 0x9c8a74, h: 0xd2bca8, l: 0xcdb0a0, alt: 1 }] },
  // 15 yak
  { base: { b: YK.fur, h: YK.fur }, v: [{ b: YK.fur, l: 0x3a2c20 }, { b: 0x2c2622, l: 0x221c18 }, { b: 0x9c7a50, l: 0x6a5038 }, { b: 0xcdbf9f, l: 0x8a7a62 }] },
  // 16 buffalo
  { base: { b: BF.body, h: BF.body }, v: [{ b: BF.body, l: 0x3a3636 }, { b: 0x6a6868, l: 0x4a4848 }, { b: 0x5a4234, l: 0x3e3028 }, { b: 0xb0aaa0, l: 0x7a746c }] },
  // 17 peacock: base = blue peacock (with train), alt = brown peahen
  { base: { b: PC.neckD, h: PC.neck, pb: 0x8a6a4c, ph: 0x7a8a78 }, v: [{ b: PC.neckD, h: PC.neck, l: 0x7a6a5c }, { b: 0x3a7a5a, h: 0x4a8a62, l: 0x7a6a5c }, { b: 0x8a6a4c, h: 0x7a8a78, l: 0x8a7a68, alt: 1 }, { b: 0x9c7c5c, h: 0x8a9684, l: 0x8a7a68, alt: 1 }] },
  // 18 camel
  { base: { b: CM.body, h: CM.body }, v: [{ b: CM.body, l: 0xa8885a }, { b: 0x7a5a3a, l: 0x6a4e34 }, { b: 0xe2cfa6, l: 0xc4ae84 }, { b: 0xa89478, l: 0x8a7656 }] },
  // 19 capybara
  { base: { b: CB.body, h: CB.body }, v: [{ b: CB.body, l: 0x5a3e28 }, { b: 0x6f5238, l: 0x4a3220 }, { b: 0xb08a58, l: 0x7a5a38 }, { b: 0x8a7a68, l: 0x5a4a3a }] },
];
// species colour-variant mix over the 8 slots (slot = (a_variant >> 1) & 7)
const SLOTS = [
  [0, 1, 2, 3, 0, 2, 1, 3], [0, 1, 2, 0, 1, 0, 2, 1], [0, 1, 2, 0, 0, 1, 2, 0], [0, 1, 2, 3, 0, 1, 2, 3],
  [0, 1, 2, 3, 0, 1, 3, 0], [0, 0, 1, 2, 0, 0, 1, 2], [0, 1, 2, 0, 1, 2, 2, 0], [0, 1, 2, 0, 0, 1, 2, 0],
  [0, 1, 2, 0, 1, 0, 2, 1], [0, 1, 2, 0, 1, 2, 0, 2],
  [0, 1, 2, 0, 3, 0, 1, 2], [0, 0, 1, 2, 0, 0, 1, 0], [0, 1, 2, 3, 0, 2, 1, 3], [0, 1, 0, 3, 0, 2, 1, 0],
  [0, 1, 1, 0, 1, 2, 0, 1], [0, 1, 2, 3, 0, 1, 0, 2], [0, 1, 2, 3, 0, 1, 0, 2], [0, 0, 2, 1, 0, 3, 0, 2],
  [0, 1, 2, 3, 0, 1, 2, 0], [0, 1, 2, 3, 0, 1, 2, 0],
];
function variants(s) {
  const D = VAR[s], bs = D.base, out = { body: [], head: [], headF: [], leg: [], alt: [] };
  for (let slot = 0; slot < 8; slot++) {
    const v = D.v[SLOTS[s][slot] % D.v.length], alt = !!v.alt && HAS_ALT[s];
    const bb = alt ? (bs.pb ?? bs.b) : bs.b, hb = alt ? (bs.ph ?? bs.h) : bs.h;
    out.body.push(tintOf(v.b, bb));
    const h = v.h ?? v.b;
    out.head.push(tintOf(v.hm ?? h, hb)); out.headF.push(tintOf(v.hf ?? h, hb));
    out.leg.push(hx(v.l ?? v.b)); out.alt.push(alt ? 1 : 0);
  }
  return out;
}

function rigData() {
  const R = [];
  // bodyY = legLen + hipDrop (hip joints sit hipDrop below the pivot, inside the belly)
  const def = (i, o) => {
    if (o.hipDrop != null) o.bodyY = o.legLen + o.hipDrop;
    R[i] = Object.assign({ name: spc(i).name, legs: spc(i).legs, radius: spc(i).radius, fan: FAN_SPECIES.includes(i), maleAcc: MALE_ACC_SPECIES.includes(i) ? 2 : 0, headBob: 0, swing: 1, fanBase: [0, .1, -.28], fanFold: [-1.2, .34], vt: variants(i), bird: false, hopper: false, legW2: 0, grazeBP: .1, sleepHead: [.9, .5], graze: 0, webbed: false,
      outline: .03, hasAlt: HAS_ALT[i] }, o);
  };
  //            hipDrop legLen legW   hips [x,z]                 neck               lieY cullR
  def(0, { hipDrop: .12, lieY: .13, legLen: .09, legW: .042, hips: [[-.06, .0], [.06, .0]], neck: [0, .07, .12], cullR: .6, bird: true, grazeBP: .7, sleepHead: [.3, 2.9], swimY: .12, outline: .02 });
  def(1, { hipDrop: .11, lieY: .12, legLen: .08, legW: .046, hips: [[-.065, -.02], [.065, -.02]], neck: [0, .08, .17], cullR: .6, bird: true, webbed: true, grazeBP: .5, sleepHead: [.2, 2.9], swimY: .13, outline: .02 });
  def(2, { hipDrop: .17, lieY: .22, legLen: .24, legW: .095, hips: [[-.11, -.02], [.11, -.02]], neck: [0, .14, .26], cullR: 1.0, bird: true, grazeBP: .5, sleepHead: [.5, 2.6], swimY: .22, outline: .035 });
  def(3, { hipDrop: .09, lieY: .11, legLen: .065, legW: .052, legW2: .07, hips: [[-.065, .075], [.065, .075], [-.09, -.085], [.09, -.085]], neck: [0, .05, .13], cullR: .5, hopper: true, grazeBP: .18, sleepHead: [.7, .6], swimY: .11, outline: .02 });
  def(4, { hipDrop: .16, lieY: .22, legLen: .24, legW: .105, hips: [[-.11, .21], [.11, .21], [-.11, -.21], [.11, -.21]], neck: [0, .1, .27], cullR: 1.0, grazeBP: .12, sleepHead: [.8, .7], swimY: .22, outline: .035 });
  def(5, { hipDrop: .17, lieY: .24, legLen: .22, legW: .13, hips: [[-.14, .2], [.14, .2], [-.14, -.2], [.14, -.2]], neck: [0, .06, .3], cullR: 1.0, grazeBP: .12, sleepHead: [.9, .6], swimY: .24, outline: .035 });
  def(6, { hipDrop: .2, lieY: .26, legLen: .16, legW: .18, hips: [[-.15, .27], [.15, .27], [-.15, -.27], [.15, -.27]], neck: [0, .03, .3], cullR: 1.1, grazeBP: .1, sleepHead: [.5, .5], swimY: .24, outline: .035 });
  def(7, { hipDrop: .3, lieY: .42, legLen: .4, legW: .3, hips: [[-.22, .46], [.22, .46], [-.22, -.46], [.22, -.46]], neck: [0, .12, .6], cullR: 1.8, grazeBP: .1, sleepHead: [.7, .6], swimY: .37, outline: .05 });
  def(8, { hipDrop: .26, lieY: .38, legLen: .5, legW: .23, hips: [[-.2, .42], [.2, .42], [-.2, -.4], [.2, -.4]], neck: [0, .2, .5], cullR: 1.9, grazeBP: .1, sleepHead: [.6, .4], swimY: .35, outline: .05 });
  def(9, { hipDrop: .27, lieY: .33, legLen: .46, legW: .17, hips: [[-.18, .3], [.18, .3], [-.18, -.3], [.18, -.3]], neck: [0, .22, .42], cullR: 1.7, grazeBP: .1, sleepHead: [.8, .5], swimY: .33, outline: .04 });
  const q4 = (x, z, z2 = z) => [[-x, z], [x, z], [-x, -z2], [x, -z2]];
  def(10, { hipDrop: .25, lieY: .36, legLen: .44, legW: .18, hips: q4(.19, .38, .36), neck: [0, .18, .42], cullR: 1.7, grazeBP: .2, grazeMax: 1.7, sleepHead: [.6, .4], swimY: .33, outline: .05, swing: .9 });
  def(11, { hipDrop: .1, lieY: .15, legLen: .14, legW: .055, hips: [[-.075, -.02], [.075, -.02]], neck: [0, .1, .22], cullR: .9, bird: true, webbed: true, grazeBP: .5, sleepHead: [.2, 2.9], swimY: .17, outline: .025 });
  def(12, { hipDrop: .2, lieY: .3, legLen: .4, legW: .12, hips: q4(.14, .24), neck: [0, .12, .34], cullR: 1.5, grazeBP: .25, grazeMax: 1.75, sleepHead: [.8, .5], swimY: .28, outline: .035 });
  def(13, { hipDrop: .2, lieY: .3, legLen: .46, legW: .13, hips: q4(.11, .3), neck: [0, .14, .34], cullR: 1.5, grazeBP: .25, grazeMax: 1.75, sleepHead: [.8, .5], swimY: .3, outline: .035, swing: .8 });
  def(14, { hipDrop: .3, lieY: .45, legLen: .95, legW: .115, hips: [[-.13, -.03], [.13, -.03]], neck: [0, .28, .4], cullR: 2.2, bird: true, grazeBP: .55, grazeMax: 1.95, sleepHead: [.4, 2.7], swimY: .5, outline: .05, headBob: .14, swing: .8 });
  def(15, { hipDrop: .3, lieY: .45, legLen: .36, legW: .22, hips: q4(.25, .45), neck: [0, .15, .62], cullR: 1.9, grazeBP: .1, sleepHead: [.7, .6], swimY: .4, outline: .05 });
  def(16, { hipDrop: .28, lieY: .45, legLen: .5, legW: .21, hips: q4(.25, .5), neck: [0, .05, .7], cullR: 2.0, grazeBP: .1, sleepHead: [.7, .6], swimY: .42, outline: .05 });
  def(17, { hipDrop: .12, lieY: .2, legLen: .3, legW: .06, hips: [[-.07, -.02], [.07, -.02]], neck: [0, .1, .2], cullR: 1.4, bird: true, grazeBP: .5, sleepHead: [.4, 2.7], swimY: .22, outline: .03, fanBase: [0, .1, -.28], fanFold: [-1.4, .45], fanIdle: true });
  def(18, { hipDrop: .3, lieY: .5, legLen: .85, legW: .2, hips: q4(.2, .42), neck: [0, .25, .55], cullR: 2.6, grazeBP: .35, grazeMax: 1.9, sleepHead: [.95, .5], swimY: .55, outline: .05, swing: .7 });
  def(19, { hipDrop: .13, lieY: .24, legLen: .16, legW: .14, hips: q4(.13, .28), neck: [0, .03, .36], cullR: 1.0, grazeBP: .12, sleepHead: [.5, .5], swimY: .26, outline: .035 });
  return R;
}

export const RIG = rigData();
export const ANIMAL_GEO = [];   // [{body, head, acc?, fan?, alt?:{body,head,bodyF,headF}, bodyF, headF, fanF?}]   (…F = far-LOD variants)
let _built = false;
function bounds(g) {
  const b = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9], p = g.pos;
  for (let i = 0; i < g.count; i++) for (let k = 0; k < 3; k++) { const v = p[i * 3 + k]; if (v < b[k]) b[k] = v; if (v > b[k + 3]) b[k + 3] = v; }
  return b;
}
function meanCol(g) {
  const c = g.col, o = [0, 0, 0]; const n = g.count || 1;
  for (let i = 0; i < g.count; i++) { o[0] += c[i * 3]; o[1] += c[i * 3 + 1]; o[2] += c[i * 3 + 2]; }
  return [o[0] / n, o[1] / n, o[2] / n];
}
// far-LOD whole animal: far body + far head translated to the neck joint (neutral pose)
function wholeFar(body, head, nk) {
  const h = { pos: new Float32Array(head.pos), nrm: head.nrm, col: head.col, count: head.count };
  for (let i = 0; i < h.count; i++) { h.pos[i * 3] += nk[0]; h.pos[i * 3 + 1] += nk[1]; h.pos[i * 3 + 2] += nk[2]; }
  return mergeX([body, h]);
}

// lowest world-y reached by the head mesh for head pitch hp (+ body pitch bp about the pivot)
function headMinY(rig, head, hp, bp, lieDrop) {
  const pos = head.pos, n = head.count;
  const ch = Math.cos(hp), sh = Math.sin(hp), cb = Math.cos(bp), sb = Math.sin(bp);
  let miny = 1e9;
  for (let i = 0; i < n; i++) {
    const y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const yy = y * ch - z * sh, zz = y * sh + z * ch;
    const by = rig.neck[1] + yy, bz = rig.neck[2] + zz;
    const wy = by * cb - bz * sb;
    if (wy < miny) miny = wy;
  }
  return rig.bodyY - lieDrop + miny;
}

export function buildAnimalGeos() {
  if (_built) return ANIMAL_GEO;
  _built = true;
  for (let s = 0; s < NSP; s++) {
    PLAIN = false; FAR = false;
    const g = BUILD[s]();
    FAR = true;
    const f = BUILD[s]();
    g.bodyF = f.body; g.headF = f.head; if (f.fan) g.fanF = f.fan;
    const nk = RIG[s].neck;
    g.whole = wholeFar(f.body, f.head, nk);                 // far LOD: one static mesh (body + head at the neutral pose), one draw
    g.headA = mergeX([g.head, withAttr(g.acc, 'fix')]);     // near LOD: head + accessories in ONE mesh (acc vertices carry fix=1: not tinted)
    if (g.male) withAttr(g.male, 'fix');
    if (HAS_ALT[s]) {
      PLAIN = true; FAR = false;
      const a = BUILD[s](); FAR = true; const af = BUILD[s]();
      g.alt = { body: a.body, head: a.head, bodyF: af.body, headF: af.head, headA: mergeX([a.head, withAttr(a.acc, 'fix')]), whole: wholeFar(af.body, af.head, nk), hasFan: !!a.fan };
    }
    FAR = false; PLAIN = false;
    ANIMAL_GEO[s] = g;
    const r = RIG[s];
    r.hipY = r.legLen - r.bodyY;
    r.cpm = 1 / (1.2 * spc(s).height);          // gait cycles per metre (PLAN: stride ~ 0.6*height*2)
    r.walkV = spc(s).walk; r.runV = spc(s).run;
    // solve head pitch that brings the lowest head vertex (head + accessories) to just above ground
    const hm = g.acc ? merge([g.head, g.acc]) : g.head;
    const gmax = r.grazeMax || 1.45;
    let best = gmax;
    for (let k = 0; k <= 60; k++) {
      const hp = 0.3 + k * (gmax - 0.3) / 60;
      if (headMinY(r, hm, hp, r.grazeBP, 0) <= 0.02) { best = hp; break; }
    }
    r.graze = best;
    // blob tier (very distant): ellipsoid fitted to the far mesh bounds; colour = mean vertex colour
    const wg = g.whole, bb = bounds(wg);
    const yLo = -r.bodyY, yHi = bb[4];                   // ground (legs are not in the mesh) up to the top of the head
    r.blob = [Math.max((bb[3] - bb[0]) * .5, .1) * .85, (yHi - yLo) * .5 * .9, (bb[5] - bb[2]) * .5 * .85, (bb[3] + bb[0]) * .5, (yHi + yLo) * .5, (bb[5] + bb[2]) * .5];
    r.avg = meanCol(wg); r.avgAlt = g.alt ? meanCol(g.alt.whole) : r.avg;
  }
  return ANIMAL_GEO;
}

// ---------------------------------------------------------------- leg meshes (unit: hangs from y=0 to y=-1, width 1 = radius .5)
// stout tapered rounded leg + dark rounded hoof/shoe (tint gives the leg colour; shared by animals and farmers)
export function buildLegGeo() {
  FAR = false;
  return tube([[0, 0, 0, .5], [0, -.5, 0, .46], [0, -.84, 0, .42], [0, -.97, 0, .5]], 0xffffff,
    { seg: 8, cs: 0, capK: .16, ref: [0, 0, 1], col: (x, y) => (y < -.86 ? 0x4b4852 : 0xffffff) });
}
// near bird leg: thin leg + three claw toes (clawed foot) ; duck: thin leg + flat webbed paddle foot
function birdLeg(webbed) {
  FAR = false;
  const leg = tube([[0, 0, 0, .5], [0, -.95, 0, .4]], 0xffffff, { seg: 6, cs: 1, capK: .3, open1: true, ref: [0, 0, 1] });
  if (webbed) return M(leg, P(1, 0xffffff, [1.35, .12, 1.7], [0, -.97, .75], { seg: 7, rings: 3 }));
  return M(leg, [-.55, 0, .55].map(a => rod(0, -.95, 0, Math.sin(a) * 1.2, -.97, Math.cos(a) * 1.9 + .3, .38, .16, 0xffffff, 4)));
}
export function buildBirdLegGeo() { return birdLeg(false); }
export function buildDuckLegGeo() { return birdLeg(true); }
export function buildLegFarGeo() { return lathe([[.5, 0], [.42, -.95]], 4, 0xffffff); }

// ---------------------------------------------------------------- farmers
// Per FarmerType look. Torso mesh origin = hip joint (0,0,0), +Y up, +Z front. Arms: unit mesh hanging from shoulder.
// Chunky cartoon proportions: huge round head, barrel torso, stout limbs, big hat. ~1.6 m with hat.
export const FARMER_RIG = {
  hipY: .56, legLen: .56, legW: .24, legX: .13, armLen: .5, armW: .15, shoulderX: .3, shoulderY: .46,
  cpm: 1 / 1.1, height: 1.6, carryK: .78,
  looks: [
    { name: 'feeder',    shirt: 0xc8574a, pants: 0x4a6fa5, hat: 0xdcc27c, skin: 0xeab998 },
    { name: 'collector', shirt: 0xeee9da, pants: 0x86654a, hat: 0x4d9158, skin: 0xcf9870 },
    { name: 'cleaner',   shirt: 0x8d979b, pants: 0x5f7a40, hat: 0xe6bd3a, skin: 0xf0c8a8 },
    { name: 'vet',       shirt: 0xf6f6f2, pants: 0x3e9ca2, hat: 0x3e9ca2, skin: 0x95623f },
  ],
};
const hex2rgb = h => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
FARMER_RIG.looks.forEach(l => { l.pantsRGB = hex2rgb(l.pants); });
const shade = (h, f) => { const c = hex2rgb(h).map(v => Math.min(255, Math.round(v * f * 255))); return (c[0] << 16) | (c[1] << 8) | c[2]; };

function farmerGeo(t, far = false) {
  FAR = far;
  const L = FARMER_RIG.looks[t], skin = L.skin, hair = [0x6b4a2c, 0x2e211a, 0xc9954a, 0x232226][t];
  const sk2 = shade(skin, .86);
  const vest = [0x4a6fa5, 0x4d9158, 0xe8872a, 0xf6f6f2][t];
  // torso colouring: shirt, with per-type overalls / vest / coat
  const tcol = (x, y, z) => {
    if (t === 0) return (y < .27 || (z > .08 && Math.abs(x) < .15 && y < .5)) ? L.pants : L.shirt;
    if (t === 1) return (Math.abs(x) > .11 && z > -.05) ? vest : L.shirt;
    if (t === 2) return (Math.abs(x) > .1 || z < -.1) ? vest : L.shirt;
    return L.shirt;
  };
  const parts = [
    P(2, t === 3 ? 0xf6f6f2 : L.pants, [.27, .22, .2], [0, .03, 0], { rot: [HP, 0, 0] }),
    P(3, L.shirt, [.31, .245, .31], [0, .31, 0], { rot: [HP, 0, 0], col: tcol, seg: 14, rings: 8 }),
  ];
  if (t === 0) parts.push(S2(x => tube([[x * .17, .52, .12, .028], [x * .12, .66, .02, .028]], L.pants, { seg: 5, cs: 1 })),
    P(-1, 0xe8d27a, [.03, .03, .018], [-.13, .44, .24]), P(-1, 0xe8d27a, [.03, .03, .018], [.13, .44, .24]));
  if (t === 2) parts.push(P(2, 0xe8e8e0, [.315, .25, .036], [0, .24, 0], { rot: [HP, 0, 0], seg: 14, rings: 4 }));
  if (t === 3 && !FAR) parts.push(box(.1, .028, .012, 0xd04040, .12, .46, .235), box(.028, .1, .012, 0xd04040, .12, .46, .235));
  const hp = [
    P(3, skin, [.26, .25, .25], [0, .87, .01], { seg: 15, rings: 8 }),                             // big round head
    P(0, sk2, [.045, .04, .04], [0, .82, .225]),                                                      // nose
    FAR ? null : S2(x => box(.05, .055, .03, 0x201a17, x * .09, .885, .2, 0, x * .3, 0)),            // small square eyes
    S2(x => P(-1, sk2, [.04, .06, .04], [x * .225, .86, 0])),                                         // ears
    FAR ? null : box(.07, .014, .02, 0x7a3b30, 0, .76, .218),                                         // mouth
    P(1, hair, [.235, .2, .225], [0, .915, -.04], { seg: 10, rings: 6 }),                             // hair (under hat)
  ];
  if (t === 0) hp.push(P(2, L.hat, [.5, .5, .045], [0, .985, .0], { rot: [HP, 0, 0], seg: 16, rings: 4 }), P(2, L.hat, [.25, .25, .2], [0, 1.07, 0], { rot: [HP, 0, 0], seg: 14, rings: 7 }), (FAR ? null : cyl(.255, .262, .06, 12, 0xb8453a, 0, 1.03, 0)));
  else if (t === 1) hp.push(P(2, L.hat, [.25, .245, .19], [0, 1.03, -.01], { rot: [HP, 0, 0], seg: 14, rings: 7 }), P(1, shade(L.hat, .8), [.17, .028, .15], [0, .97, .24], { rot: [.1, 0, 0], seg: 10, rings: 4 }), P(-1, 0xeee9da, [.035, .035, .035], [0, 1.2, 0]));
  else if (t === 2) hp.push(P(3, L.hat, [.255, .255, .22], [0, 1.0, -.005], { rot: [HP, 0, 0], seg: 14, rings: 8 }), P(1, L.hat, [.31, .31, .03], [0, .955, .02], { rot: [HP, 0, 0], seg: 14, rings: 4 }), P(1, shade(L.hat, .85), [.04, .2, .07], [0, 1.1, .0], { rot: [HP, 0, 0] }));
  else hp.push(P(2, L.hat, [.255, .25, .17], [0, 1.0, -.01], { rot: [HP, 0, 0], seg: 14, rings: 7 }), P(1, 0xf6f6f2, [.075, .055, .02], [0, 1.0, .25], { seg: 8, rings: 4 }), FAR ? null : box(.07, .018, .012, 0xd04040, 0, 1.0, .272), FAR ? null : box(.018, .07, .012, 0xd04040, 0, 1.0, .272));
  return M(parts, hp);
}
function armGeo(t) {
  FAR = false;
  const L = FARMER_RIG.looks[t], A = FARMER_RIG.armLen, W = FARMER_RIG.armW;
  const sl = t !== 2 ? .78 : .46;                                     // cleaner: short sleeves
  const sleeve = t === 3 ? 0xf6f6f2 : t === 2 ? 0x8d979b : L.shirt;
  const capK = .3, rr = W * .55;                                       // round caps despite the non-uniform (W, A, W) instance scale
  const col = (x, y, z) => (y > -sl ? sleeve : L.skin);
  return M(
    tube([[0, 0, 0, .58], [0, -.5, 0, .52], [0, -.9, 0, .46]], sleeve, { seg: 8, cs: 1, capK, open1: true, ref: [0, 0, 1], col }),
    P(2, L.skin, [.58, rr / A, .58], [0, -.94, 0], { seg: 9, rings: 6 }),
  );
}
// far-LOD farmers: torso + head + hat as one coarse mesh (no arms / legs / face boxes), never outlined
export function buildFarmerFarGeos() {
  const out = [];
  for (let t = 0; t < 4; t++) out.push(farmerGeo(t, true));
  FAR = false;
  return out;
}
export function buildFarmerGeos() {
  const bodies = [], arms = [];
  for (let t = 0; t < 4; t++) { bodies.push(farmerGeo(t)); arms.push(armGeo(t)); }
  return { bodies, arms };
}

// ---------------------------------------------------------------- items (origin = bottom centre; ItemKind order)
export function buildItemGeos() {
  FAR = false;
  const g = [];
  // 0 EGG
  g[0] = P(1, 0xf2e8d2, [.04, .04, .053], [0, .052, 0], { rot: [HP, 0, 0], egg: -.12, seg: 7, rings: 5 });
  // 1 MILK can
  g[1] = M(
    lathe([[0, 0], [.15, 0], [.18, .07], [.18, .34], [.13, .42], [.09, .45], [0, .45]], 10, 0xcdd7e0),
    lathe([[.186, .15], [.186, .23]], 10, 0xc8574a),
    lathe([[0, .45], [.1, .45], [.1, .52], [0, .52]], 10, 0x8d9aa8),
    S2(x => P(0, 0x8d9aa8, [.04, .05, .09], [x * .2, .27, 0], { rot: [HP, 0, 0] })));
  // 2 WOOL bundle
  g[2] = M(
    P(2, 0xf8f3e8, [.27, .17, .21], [0, .17, 0]), P(1, 0xece6d8, [.16, .11, .13], [.1, .27, .04]), P(1, 0xf8f3e8, [.15, .11, .13], [-.11, .23, -.06]),
    P(1, 0xece6d8, [.17, .1, .11], [0, .1, .13]), rbox(.56, .03, .07, .012, 0xc08a4a, 0, .17, 0), rbox(.07, .03, .44, .012, 0xc08a4a, 0, .17, 0));
  // 3 MANURE (soft-serve swirl)
  g[3] = M(
    P(2, 0x7a4e2b, [.23, .21, .08], [0, .065, 0], { rot: [HP, 0, 0] }), P(1, 0x6d4423, [.17, .16, .075], [0, .14, 0], { rot: [HP, 0, 0] }),
    P(1, 0x7a4e2b, [.11, .1, .065], [0, .2, 0], { rot: [HP, 0, 0] }), P(0, 0x6d4423, [.05, .05, .05], [0, .255, 0]));
  // 4 FEED sack
  g[4] = M(
    P(3, 0xd6b078, [.2, .13, .24], [0, .22, 0], { rot: [HP, 0, 0], seg: 12, rings: 7 }), P(1, 0xd6b078, [.12, .08, .08], [0, .46, 0]),
    cyl(.07, .08, .03, 8, 0xb8453a, 0, .42, 0), box(.2, .16, .012, 0xf2e8ce, 0, .25, .118), box(.2, .045, .014, 0x4fa043, 0, .25, .12));
  // 5 HAY bale
  g[5] = M(
    rbox(.66, .4, .44, .09, 0xe3bc54, 0, .2, 0), S2(x => rbox(.04, .41, .45, .02, 0xa88435, x * .17, .2, 0)),
    P(1, 0xf2d97e, [.12, .05, .09], [-.15, .4, -.08]), P(1, 0xf2d97e, [.13, .05, .08], [.12, .4, .1]));
  // 6 WATER bucket
  g[6] = M(
    lathe([[0, 0], [.13, 0], [.17, .27], [0, .27]], 10, 0x7b93aa), lathe([[.175, .24], [.185, .275]], 10, 0x5a7088), cyl(.165, .165, .012, 10, 0x58a8e0, 0, .262, 0),
    rod(-.18, .27, 0, -.1, .42, 0, .018, .018, 0x4a525c, 5), rod(-.1, .42, 0, .1, .42, 0, .018, .018, 0x4a525c, 5), rod(.1, .42, 0, .18, .27, 0, .018, .018, 0x4a525c, 5));
  // 7 MEDKIT
  g[7] = M(
    rbox(.34, .24, .14, .06, 0xf8f8f6, 0, .12, 0), box(.15, .045, .006, 0xd04040, 0, .13, .072), box(.045, .15, .006, 0xd04040, 0, .13, .072),
    box(.15, .045, .006, 0xd04040, 0, .13, -.072), box(.045, .15, .006, 0xd04040, 0, .13, -.072),
    rbox(.16, .05, .05, .02, 0x8d9aa8, 0, .26, 0), rbox(.35, .02, .15, .008, 0xd0d6dc, 0, .235, 0));
  return g;
}
export const ITEM_OUTLINE = [0, .012, .014, .014, .014, .014, .012, .012];

// ---------------------------------------------------------------- gate leaf (hinge at origin, leaf along +X, 4 m wide)
export function buildGateGeo() {
  const wood = 0x9a6b3c, light = 0xb88650, dark = 0x6e4a28;
  return M(
    box(.14, 1.3, .14, dark, 0, .65, 0), box(.14, 1.3, .14, dark, 4.0, .65, 0),
    box(3.9, .1, .06, wood, 2.0, 1.1, 0), box(3.9, .1, .06, wood, 2.0, .82, 0), box(3.9, .1, .06, wood, 2.0, .54, 0), box(3.9, .1, .06, wood, 2.0, .26, 0),
    rod(.1, .28, 0, 3.9, 1.08, 0, .045, .045, light, 4),
    box(.1, .1, .1, 0x555555, 3.85, .82, 0.03));
}

export function getAnimalVariantTint(species, variant) {
  return RIG[species].vt.body[(variant >> 1) & 7];
}
