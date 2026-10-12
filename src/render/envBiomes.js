// Biome content for pens 10-19 (+ K.TREE for every pen): painted ground (skirt, water/sand/snow/mud blobs, flat decor)
// and the 3D feature builders (barrels, shade shed, reeds, stone wall, rock pile, salt lick, log, thicket, acacia, cattails,
// fountain, hedge, perch, palm, dune, bamboo, styled trees).  Pure JS, no GL/DOM.  Cartoony look: rounded, chunky, cel-shaded,
// outlined solids (ctx.S props / ctx.B buildings / ctx.R rocks / ctx.P plants / ctx.T trees), un-outlined flat decor (ground polys / ctx.small).
import { box, cyl, ell, lathe, rbox, rod, smoothen, merge } from './lowpoly.js';
import { PENS, FeatureKind as K, blobOutline, inBlob } from '../config.js';
import { mulberry32 } from '../ecs/rng.js';
import { mixHex, roundRect, wobble, blobPoly, ribbon, boulder } from './envTerrain.js';

const MEADOW_BASE = 0x679b4a;
const WOOD = 0xa07650, WOOD_D = 0x7a583a, WOOD_L = 0xb88e5e;
const BARK = 0x7a5538;
const STONE = [0x8f8d89, 0xa09d97, 0xb2aea6, 0x9a9184, 0xa8a090];
const shade = (hex, f) => (Math.min(255, (hex >> 16 & 255) * f) << 16) | (Math.min(255, (hex >> 8 & 255) * f) << 8) | Math.min(255, (hex & 255) * f) | 0;

// ------------------------------------------------------------------ tiny geometry helpers (self-contained)
const lump = (L, ax, ay, az, hex, x, y, z, seg = 7, rings = 3, yaw = 0) => L.push(smoothen(ell(ax, ay, az, hex, x, y, z, seg, rings, 0, yaw, 0)));
const pole = (x, z, r, h, hex, seg = 6) => lathe([[r, 0], [r, h - r * 0.8], [r * 0.7, h - r * 0.2], [0, h]], seg, hex, 1, 1, x, 0, z);
function tube(x0, y0, z0, x1, y1, z1, r, hex, seg = 6, r1 = r) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, L = Math.hypot(dx, dy, dz) || 1e-6, hl = L / 2;
  const rx = Math.acos(Math.max(-1, Math.min(1, dy / L))), ry = Math.atan2(dx, dz);
  return lathe([[r, -hl], [r1, hl]], seg, hex, 1, 1, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, rx, ry, 0);
}
const rb = (w, h, d, hex, x, y, z, rx = 0, ry = 0, rz = 0, r) => {
  const m = Math.min(w, h, d);
  return m < 0.1 ? box(w, h, d, hex, x, y, z, rx, ry, rz) : rbox(w, h, d, r !== undefined ? r : Math.min(0.14, m * 0.3), hex, x, y, z, rx, ry, rz);
};
// plump grass-blade / reed: tapering 3-sided lathe; returns the tip so seed heads can sit on it
function blade(L, x, z, h, w, hex, lean, yaw, y0 = 0) {
  L.push(smoothen(lathe([[w, 0], [w * 0.72, h * 0.55], [0, h]], 3, hex, 1, 1, x, y0, z, lean, yaw, 0)));
  return [x + Math.sin(yaw) * Math.sin(lean) * h, y0 + Math.cos(lean) * h, z + Math.cos(yaw) * Math.sin(lean) * h];
}
function tuft(L, rng, x, z, s, n, cols, leanMin = 0.25) {
  for (let i = 0; i < n; i++) {
    const a = i / n * 6.28 + rng() * 0.8, h = s * (0.5 + rng() * 0.5), w = s * 0.11;
    blade(L, x + Math.cos(a) * 0.07 * s, z + Math.sin(a) * 0.07 * s, h, w, cols[(rng() * cols.length) | 0], leanMin + rng() * 0.4, a + Math.PI / 2);
  }
}
function flower(L, rng, x, z, hex, h = 0.28, stem = 0x4e9a38, k = 1) {
  L.push(lathe([[0.03 * k, 0], [0.025 * k, h]], 3, stem, 1, 1, x, 0, z));
  L.push(smoothen(ell(0.15 * k, 0.11 * k, 0.15 * k, hex, x, h + 0.04, z, 6, 2)));
}
const pick = (rng, a) => a[(rng() * a.length) | 0];
const pebble = (L, rng, x, z, c0, c1) => { const s = 0.09 + rng() * 0.12; L.push(ell(s * 1.3, s * 0.55, s, mixHex(c0, c1, rng()), x, s * 0.2, z, 5, 2, 0, rng() * 6, 0)); };

// ------------------------------------------------------------------ pen-local free-space test (keeps decor off features and the gate approach)
function makeFree(P) {
  const feats = P.features.filter(f => f.kind !== K.SLEEP_AREA);
  return (x, z, m = 0) => {
    if (x < P.x0 + 1.8 + m || x > P.x1 - 1.8 - m || z < P.z0 + 1.8 + m || z > P.z1 - 1.8 - m) return false;
    if (Math.abs(x - P.cx) < 4 + m && Math.abs(z - P.gateEdgeZ) < 10) return false;
    for (const f of feats) {
      if (f.blob) { if (inBlob(f, x, z, -(m + 1.2))) return false; }
      else if (f.w > 0 && f.d > 0) { if (Math.abs(x - f.x) < f.w / 2 + 1 + m && Math.abs(z - f.z) < f.d / 2 + 1 + m) return false; }
      else if (f.r > 0) { if ((x - f.x) ** 2 + (z - f.z) ** 2 < (f.r + 1 + m) ** 2) return false; }
    }
    return true;
  };
}
function scatterIn(P, free, rng, n, fn, m = 0) {
  let c = 0;
  for (let t = 0; t < n * 40 && c < n; t++) {
    const x = P.x0 + 2 + rng() * (P.x1 - P.x0 - 4), z = P.z0 + 2 + rng() * (P.z1 - P.z0 - 4);
    if (!free(x, z, m)) continue;
    fn(x, z, c++);
  }
}

// ------------------------------------------------------------------ ground: blob layers (same fan path as the pond / mud pit) + decor
function paintBlob(gb, f, layers, n = 44) {
  for (const [s, y, hex] of layers) gb.fan(blobOutline(f, n, s), f.x, f.z, y, hex);
}
const glints = (gb, f, list, seed, y, hex) => { for (const [dx, dz, rx, rz, a] of list) gb.poly(blobPoly(f.x + dx, f.z + dz, rx, rz, seed + dx, 10, 0.1, a), y, hex); };

const LAYERS = {
  [K.SAND_BATH]: [[1.3, 0.024, 0xb59c68], [1.15, 0.0252, 0xcbb27a], [1.0, 0.0265, 0xd9c08a], [0.64, 0.0275, 0xe2cb98], [0.3, 0.0285, 0xcfb67e]],
  [K.SNOW_DRIFT]: [[1.22, 0.024, 0xbdd0e0], [1.1, 0.0252, 0xdde9f3], [1.0, 0.0265, 0xf4f9fc], [0.66, 0.0275, 0xffffff], [0.32, 0.0285, 0xdfebf5]],
  [K.OASIS]: [[1.55, 0.0235, 0x86b252], [1.4, 0.0242, 0xa9b560], [1.27, 0.0248, 0xd9c08a], [1.13, 0.0256, 0xc2ae74], [1.03, 0.047, 0x1f7f86], [1.0, 0.05, 0x5cc9c6],
    [0.8, 0.056, 0x43b8bf], [0.56, 0.062, 0x30a5b6], [0.3, 0.068, 0x2793ad]],
  [K.HOT_SPRING]: [[1.34, 0.0238, 0x4f9a56], [1.22, 0.0245, 0x9a9a88], [1.11, 0.0252, 0x7f8c88], [1.03, 0.047, 0x3f8d86], [1.0, 0.05, 0xa4dcd1],
    [0.8, 0.056, 0x8bd1c6], [0.55, 0.062, 0x73c3b8], [0.3, 0.068, 0x5eb4aa]],
  [K.MUD_PIT]: [[1.22, 0.0245, 0x7b7a48], [1.1, 0.0255, 0x5c5530], [1.0, 0.0265, 0x3f3a26], [0.68, 0.0275, 0x30291c]],
  [K.POND]: [[1.17, 0.024, 0x9c8a5c], [1.075, 0.026, 0x7d6e48], [1.03, 0.047, 0x2f6c8c], [1.0, 0.05, 0x72b4d6], [0.8, 0.056, 0x5aa0cc], [0.56, 0.062, 0x4688ba], [0.3, 0.068, 0x3c79ac]],
};

const patch = (gb, x, z, rx, rz, seed, y, hex, amp = 0.2, n = 12, rot = 0) => gb.poly(blobPoly(x, z, rx, rz, seed, n, amp, rot), y, hex);

function skirt(gb, P, pal, rng) {
  const e = 2.7, mead = MEADOW_BASE;
  gb.poly(wobble(roundRect(P.x0 - e, P.z0 - e, P.x1 + e, P.z1 + e, 6, 6, 3), 700 + P.id, 0.5, 0.22), 0.0078, mixHex(pal.base, mead, 0.55));
  gb.poly(wobble(roundRect(P.x0 - 1.9, P.z0 - 1.9, P.x1 + 1.9, P.z1 + 1.9, 5, 6, 3), 730 + P.id, 0.35, 0.3), 0.0088, mixHex(pal.base, mead, 0.28));
  // irregular patches walking round the fence (cartoony torn edge)
  const W = P.x1 - P.x0 + 4, D = P.z1 - P.z0 + 4, per = 2 * (W + D);
  const cols = [mixHex(pal.light, mead, 0.3), mixHex(pal.dark, mead, 0.3), mixHex(pal.base, mead, 0.15)];
  for (let i = 0; i < 46; i++) {
    let u = (i + rng() * 0.8) / 46 * per, x, z;
    const off = 1.2 + rng() * 2.0;
    if (u < W) { x = P.x0 - 2 + u; z = P.z0 - off; } else if ((u -= W) < D) { x = P.x1 + off; z = P.z0 - 2 + u; }
    else if ((u -= D) < W) { x = P.x1 + 2 - u; z = P.z1 + off; } else { u -= W; x = P.x0 - off; z = P.z1 + 2 - u; }
    patch(gb, x, z, 1.3 + rng() * 1.8, 1.0 + rng() * 1.4, 800 + P.id * 50 + i, 0.0094, cols[i % 3], 0.3, 10, rng() * 3);
  }
}

// ---- per-biome flat decor. e: { gb, P, pal, rng, free, small, plants, ctx }
const DECOR = {
  'dry-corral'(e) {
    const { gb, P, rng, free, small, plants } = e;
    scatterIn(P, free, rng, 26, (x, z, i) => patch(gb, x, z, 1.4 + rng() * 2.2, 1.0 + rng() * 1.6, 900 + i, 0.020, i % 3 ? 0xdbc89b : 0xcdb687, 0.25, 12, rng() * 3));
    scatterIn(P, free, rng, 16, (x, z, i) => { patch(gb, x, z, 1.2 + rng(), 0.8 + rng() * 0.7, 940 + i, 0.0205, 0xa98f5f, 0.25, 10, rng() * 3); patch(gb, x + 0.3, z - 0.2, 0.6 + rng() * 0.5, 0.4 + rng() * 0.4, 960 + i, 0.0215, 0xb89e6c, 0.25, 8, rng() * 3); });
    scatterIn(P, free, rng, 70, (x, z) => pebble(small, rng, x, z, 0x8a8272, 0xbdb39c));
    scatterIn(P, free, rng, 22, (x, z) => tuft(small, rng, x, z, 0.8 + rng() * 0.5, 4, [0xb8a458, 0xa89040, 0xc4b068]));
    scatterIn(P, free, rng, 3, (x, z) => { for (let k = 0; k < 4; k++) lump(small, 0.4, 0.22, 0.3, 0xe6dcc4, x + k * 0.5, 0.15, z + Math.sin(k * 2) * 0.3, 6, 2, rng() * 3); }, 1);   // bleached bones
  },
  riverbank(e) {
    const { gb, P, rng, free, small, plants } = e;
    const st = P.features.find(f => f.kind === K.POND);
    if (st) {   // the stream trickles out of both ends in a wiggly tapering creek (flat paint, same palette as the pond)
      for (const sg of [-1, 1]) {
        const ex = st.x + sg * st.blob.rx * 0.93, ez = st.z + sg * st.blob.rx * 0.93 * Math.sin(st.blob.rot), len = 5.5 + (sg > 0 ? 0 : 1), ph = sg * 1.3;
        const cF = t => ez + sg * t * Math.sin(st.blob.rot) + Math.sin(t * 0.7 + ph) * 0.9 * Math.min(1, t / 2), hw = (k, t) => Math.max(0.01, (1.7 * k) * (1 - t / (len + 0.5)) + 0.0);
        const X0 = Math.min(ex, ex + sg * len), X1 = Math.max(ex, ex + sg * len), cx = x => cF(Math.abs(x - ex)), hx = (k, x) => hw(k, Math.abs(x - ex));
        ribbon(gb, X0, X1, cx, x => hx(1.35, x), 0.0235, 0x7d6e48, false, 1.5);
        ribbon(gb, X0, X1, cx, x => hx(1.0, x), 0.047, 0x2f6c8c, false, 1.5);
        ribbon(gb, X0, X1, cx, x => hx(0.86, x), 0.05, 0x72b4d6, false, 1.5);
        ribbon(gb, X0, X1, cx, x => hx(0.42, x), 0.056, 0x5aa0cc, false, 1.5);
      }
    }
    scatterIn(P, free, rng, 18, (x, z, i) => { patch(gb, x, z, 2 + rng() * 2.4, 1.4 + rng() * 1.6, 900 + i, 0.020, 0x3f8a3c, 0.25, 12, rng() * 3); patch(gb, x + 0.4, z, 1 + rng(), 0.7 + rng() * 0.7, 930 + i, 0.0212, 0x5ab24a, 0.25, 10, rng() * 3); });
    scatterIn(P, free, rng, 12, (x, z, i) => patch(gb, x, z, 1.5 + rng() * 2, 1 + rng() * 1.2, 970 + i, 0.0205, 0x7bc656, 0.25, 10, rng() * 3));
    scatterIn(P, free, rng, 46, (x, z) => tuft(plants, rng, x, z, 0.85 + rng() * 0.5, 4, [0x5cb04a, 0x4c9c3e, 0x6cbc52]));
    scatterIn(P, free, rng, 34, (x, z) => flower(small, rng, x, z, pick(rng, [0xf0ece0, 0xf0dc6a, 0xd9779a, 0xb7a0e0])));
    scatterIn(P, free, rng, 20, (x, z) => pebble(small, rng, x, z, 0xa09a88, 0xd8d2c0));
  },
  alpine(e) {
    const { gb, P, rng, free, small, plants } = e;
    scatterIn(P, free, rng, 15, (x, z, i) => {
      const rx = 1.2 + rng() * 1.8, rz = 0.9 + rng() * 1.3, rot = rng() * 3;
      patch(gb, x, z, rx + 0.2, rz + 0.2, 900 + i, 0.020, 0x7c807a, 0.18, 9, rot);
      patch(gb, x, z, rx, rz, 900 + i, 0.0212, pick(rng, [0xa2a69f, 0xb0b4ad, 0x9ca09a]), 0.18, 9, rot);
      patch(gb, x - rx * 0.2, z + rz * 0.15, rx * 0.5, rz * 0.45, 920 + i, 0.0222, 0xbcc0b8, 0.2, 8, rot);
    });
    scatterIn(P, free, rng, 10, (x, z, i) => patch(gb, x, z, 2 + rng() * 2, 1.4 + rng() * 1.6, 990 + i, 0.0195, 0x5f7f5a, 0.25, 11, rng() * 3));
    scatterIn(P, free, rng, 56, (x, z) => { const c = pick(rng, [0xb08ad0, 0xf0ece0, 0xf0dc6a, 0x8fb0e0]); const n = 2 + ((rng() * 3) | 0); for (let k = 0; k < n; k++) flower(small, rng, x + (rng() - 0.5) * 0.8, z + (rng() - 0.5) * 0.8, c, 0.22 + rng() * 0.1, 0x5f8a50); });
    scatterIn(P, free, rng, 34, (x, z) => tuft(plants, rng, x, z, 0.7 + rng() * 0.4, 4, [0x6f9a6a, 0x5c8a60, 0x7caa74]));
    scatterIn(P, free, rng, 36, (x, z) => pebble(small, rng, x, z, 0x8a8d88, 0xc4c6c0));
  },
  forest(e) {
    const { gb, P, rng, free, small, plants } = e;
    const lit = [0x6e5a34, 0x7c6a3c, 0x887444, 0x8e6a38, 0x5e4c2c];
    scatterIn(P, free, rng, 34, (x, z, i) => { patch(gb, x, z, 1.6 + rng() * 2.4, 1.1 + rng() * 1.6, 900 + i, 0.020 + (i % 3) * 0.0004, lit[i % 5], 0.3, 12, rng() * 3); patch(gb, x + 0.5, z - 0.3, 0.7 + rng(), 0.5 + rng() * 0.6, 950 + i, 0.0215, pick(rng, lit), 0.3, 9, rng() * 3); });
    scatterIn(P, free, rng, 12, (x, z, i) => patch(gb, x, z, 2 + rng() * 2, 1.5 + rng() * 1.5, 990 + i, 0.0196, 0x2f5a30, 0.25, 11, rng() * 3));
    scatterIn(P, free, rng, 30, (x, z) => {   // fern: 7 arching fronds
      const hex = pick(rng, [0x3a7a3e, 0x4e9648, 0x2f6a38]);
      for (let k = 0; k < 7; k++) blade(plants, x, z, 0.8 + rng() * 0.3, 0.1, hex, 0.9 + rng() * 0.3, k / 7 * 6.28 + rng() * 0.4);
    });
    scatterIn(P, free, rng, 12, (x, z) => { lump(small, 0.07, 0.14, 0.07, 0xe8dfc8, x, 0.1, z, 5, 2); lump(small, 0.2, 0.1, 0.2, pick(rng, [0xc84a3a, 0xb8763a, 0xe0c060]), x, 0.24, z, 6, 2); });
    scatterIn(P, free, rng, 30, (x, z) => pebble(small, rng, x, z, 0x6a6660, 0x9a9690));
    scatterIn(P, free, rng, 7, (x, z) => {   // stumps with pale cut tops + moss
      const r = 0.38 + rng() * 0.2, h = 0.4 + rng() * 0.25;
      plants.push(smoothen(lathe([[r * 1.25, 0], [r, h * 0.3], [r * 0.92, h], [0, h + 0.04]], 7, 0x6a4a30, 1, 1, x, 0, z)));
      lump(plants, r * 0.82, 0.05, r * 0.82, 0xd0aa70, x, h + 0.03, z, 7, 2);
      if (rng() < 0.6) lump(plants, r * 0.5, 0.1, r * 0.4, 0x5f8f48, x + r * 0.7, 0.1, z + r * 0.3, 6, 2);
    }, 1);
    scatterIn(P, free, rng, 6, (x, z) => { const s = 0.5 + rng() * 0.5; lump(plants, s, s * 0.7, s, 0x7a7d78, x, s * 0.35, z, 7, 3); lump(plants, s * 0.7, s * 0.3, s * 0.7, 0x5f8f48, x, s * 0.7, z, 7, 2); }, 1);   // mossy rocks
    scatterIn(P, free, rng, 40, (x, z) => tuft(plants, rng, x, z, 0.8 + rng() * 0.5, 4, [0x2f6a35, 0x3b7a3a, 0x4b8c42]));
  },
  savanna(e) {
    const { gb, P, rng, free, small, plants } = e;
    scatterIn(P, free, rng, 16, (x, z, i) => patch(gb, x, z, 2 + rng() * 2.8, 1.4 + rng() * 2, 900 + i, 0.020, 0xb59a48, 0.25, 12, rng() * 3));
    scatterIn(P, free, rng, 9, (x, z, i) => patch(gb, x, z, 1.6 + rng() * 2, 1.2 + rng() * 1.4, 940 + i, 0.0205, 0xbd8c58, 0.25, 11, rng() * 3));
    scatterIn(P, free, rng, 16, (x, z, i) => patch(gb, x, z, 2 + rng() * 2.4, 1.3 + rng() * 1.6, 970 + i, 0.0212, 0xe0cc72, 0.25, 12, rng() * 3));
    scatterIn(P, free, rng, 100, (x, z) => tuft(small, rng, x, z, 1.1 + rng() * 0.8, 5, [0xe0c860, 0xd0b04c, 0xeed474, 0xd9b84e], 0.15));
    scatterIn(P, free, rng, 3, (x, z) => { lump(plants, 0.9, 0.9, 0.9, 0xa4784c, x, 0.5, z, 7, 3); lump(plants, 0.6, 0.8, 0.6, 0xb08458, x + 0.1, 1.15, z, 6, 3); lump(plants, 0.32, 0.5, 0.32, 0xbc9064, x, 1.7, z, 6, 3); }, 1);   // termite mounds
    scatterIn(P, free, rng, 26, (x, z) => pebble(small, rng, x, z, 0x9a8c6c, 0xc8b890));
  },
  snow(e) {
    const { gb, P, rng, free, small } = e;
    scatterIn(P, free, rng, 18, (x, z, i) => {
      const rx = 2 + rng() * 2.8, rz = 1.4 + rng() * 1.8, rot = rng() * 3;
      patch(gb, x + 0.5, z + 0.35, rx * 1.06, rz * 1.06, 900 + i, 0.0195, 0xc8d9e8, 0.2, 12, rot);   // blue shade side
      patch(gb, x, z, rx, rz, 900 + i, 0.0208, 0xffffff, 0.2, 12, rot);
    });
    scatterIn(P, free, rng, 4, (x, z, i) => { patch(gb, x, z, 2.4 + rng(), 1.5 + rng(), 980 + i, 0.0212, 0xa9d6ea, 0.12, 12, rng() * 3); patch(gb, x - 0.4, z + 0.3, 1.2, 0.7, 990 + i, 0.0222, 0xcfeaf6, 0.12, 10, rng() * 3); });
    for (let t = 0; t < 2; t++) {   // two wandering footprint trails
      let x = P.x0 + 6 + rng() * 10, z = P.z0 + 8 + rng() * 14, a = rng() * 6.28;
      for (let k = 0; k < 16; k++) {
        a += (rng() - 0.5) * 0.5; x += Math.cos(a) * 0.9; z += Math.sin(a) * 0.9;
        if (!free(x, z, 0.5)) break;
        const side = k % 2 ? 1 : -1;
        patch(gb, x - Math.sin(a) * side * 0.28, z + Math.cos(a) * side * 0.28, 0.2, 0.13, 1000 + t * 40 + k, 0.026, 0x9db3c8, 0.1, 6, -a);
      }
    }
    scatterIn(P, free, rng, 22, (x, z) => tuft(small, rng, x, z, 0.55 + rng() * 0.3, 3, [0xa89a58, 0x9a8c50, 0xb8aa64]));
    scatterIn(P, free, rng, 26, (x, z) => pebble(small, rng, x, z, 0x5c6470, 0x8a929e));
  },
  marsh(e) {
    const { gb, P, rng, free, small, plants } = e;
    scatterIn(P, free, rng, 18, (x, z, i) => { patch(gb, x, z, 2 + rng() * 2.6, 1.4 + rng() * 1.8, 900 + i, 0.020, 0x4d4a2c, 0.28, 12, rng() * 3); patch(gb, x + 0.3, z, 1 + rng() * 1.2, 0.7 + rng() * 0.9, 930 + i, 0.0212, 0x3d3a22, 0.28, 10, rng() * 3); });
    scatterIn(P, free, rng, 12, (x, z, i) => patch(gb, x, z, 2 + rng() * 2, 1.4 + rng() * 1.4, 960 + i, 0.0196, 0x8a9448, 0.25, 11, rng() * 3));
    scatterIn(P, free, rng, 9, (x, z, i) => {                      // murky puddles
      const rx = 1.3 + rng() * 1.6, rz = 0.8 + rng() * 0.9, rot = rng() * 3;
      patch(gb, x, z, rx + 0.3, rz + 0.3, 1000 + i, 0.0285, 0x3a4636, 0.15, 12, rot);
      patch(gb, x, z, rx, rz, 1000 + i, 0.030, 0x6f9ea0, 0.15, 12, rot);
      patch(gb, x - rx * 0.2, z - rz * 0.15, rx * 0.55, rz * 0.4, 1020 + i, 0.0312, 0xa6d0d0, 0.2, 9, rot);
    }, 0.5);
    scatterIn(P, free, rng, 46, (x, z) => tuft(plants, rng, x, z, 0.9 + rng() * 0.5, 4, [0x6a7a34, 0x7a8a3e, 0x5a6a2e]));
    scatterIn(P, free, rng, 14, (x, z) => lump(small, 0.55 + rng() * 0.4, 0.14, 0.45 + rng() * 0.3, 0x6a8a3a, x, 0.06, z, 6, 2, rng() * 3));
  },
  garden(e) {
    const { gb, P, rng, free, small, plants, ctx } = e;
    // paved approach gate -> fountain + a plaza ring, cream stone with darker rim
    const fo = P.features.find(f => f.kind === K.FOUNTAIN);
    if (fo) {
      const zA = P.gateEdgeZ + P.s * 3, zB = fo.z;
      const rect = (hw, y, hex) => gb.poly(roundRect(P.cx - hw, Math.min(zA, zB), P.cx + hw, Math.max(zA, zB), 0.8, 4, 2), y, hex);
      rect(1.9, 0.0205, 0xb6aa8c); rect(1.55, 0.0215, 0xddd2b8);
      gb.poly(blobPoly(fo.x, fo.z, 4.9, 4.9, 1100, 24, 0.04), 0.0207, 0xb6aa8c); gb.poly(blobPoly(fo.x, fo.z, 4.5, 4.5, 1100, 24, 0.04), 0.0217, 0xddd2b8);
      gb.poly(blobPoly(fo.x, fo.z, 3.2, 3.2, 1101, 20, 0.03), 0.0222, 0xe8dfc8);
      for (let k = 0; k < 10; k++) { const a = k / 10 * 6.28; patch(gb, fo.x + Math.cos(a) * 3.9, fo.z + Math.sin(a) * 3.9, 0.55, 0.4, 1110 + k, 0.0228, 0xc9bea2, 0.15, 6, a); }
      for (let k = 0; k < 5; k++) patch(gb, P.cx + (rng() - 0.5) * 1.6, zA + (zB - zA) * (k + 0.5) / 5, 0.5, 0.35, 1130 + k, 0.0228, 0xc9bea2, 0.15, 6, rng() * 3);
    }
    // flower beds with low rounded hedge borders
    const palette = [[0xe58aa8, 0xf0ece0], [0xf0dc6a, 0xe69a50], [0xb08ad0, 0xf0ece0], [0xd9567a, 0xf0dc6a]];
    scatterIn(P, (x, z, m) => free(x, z, m) && Math.abs(x - P.cx) > 5.5, rng, 4, (x, z, i) => {
      const bw = 7.2, bd = 2.6;
      gb.poly(roundRect(x - bw / 2 - 0.5, z - bd / 2 - 0.5, x + bw / 2 + 0.5, z + bd / 2 + 0.5, 0.9, 4, 2), 0.0205, 0x4e3422);
      gb.poly(roundRect(x - bw / 2, z - bd / 2, x + bw / 2, z + bd / 2, 0.7, 4, 2), 0.0216, 0x6e4a30);
      const cols = palette[i % 4];
      for (let a = 0; a < 10; a++) for (let b = 0; b < 4; b++) {
        const fx = x - bw / 2 + 0.5 + a * (bw - 1) / 9 + (rng() - 0.5) * 0.15, fz = z - bd / 2 + 0.45 + b * (bd - 0.9) / 3 + (rng() - 0.5) * 0.15;
        flower(small, rng, fx, fz, cols[(a + b) & 1], 0.34 + rng() * 0.1, 0x4e9a38, 1.55);
      }
      for (const sz of [-1, 1]) plants.push(smoothen(rb(bw + 1.2, 0.5, 0.5, i % 2 ? 0x4f9a40 : 0x5aa646, x, 0.25, z + sz * (bd / 2 + 0.55), 0, 0, 0, 0.22)));
      for (const sx of [-1, 1]) plants.push(smoothen(rb(0.5, 0.5, bd + 0.6, i % 2 ? 0x4f9a40 : 0x5aa646, x + sx * (bw / 2 + 0.55), 0.25, z, 0, 0, 0, 0.22)));
      ctx.blockers.push({ x, z, hw: bw / 2 + 1, hd: bd / 2 + 1, r: 0 });
    }, 4);
    scatterIn(P, free, rng, 26, (x, z) => flower(small, rng, x, z, pick(rng, [0xf0ece0, 0xf0dc6a, 0xd9779a, 0xb08ad0, 0xe69a50]), 0.3, 0x4e9a38, 1.4));
    scatterIn(P, free, rng, 4, (x, z) => { plants.push(pole(x, z, 0.1, 0.8, WOOD_D, 5)); lump(plants, 0.55, 0.55, 0.55, 0x4f9a40, x, 1.2, z, 7, 3); lump(plants, 0.35, 0.35, 0.35, 0x5aa646, x, 1.75, z, 6, 3); }, 2);   // topiary
  },
  desert(e) {
    const { gb, P, rng, free, small, plants } = e;
    scatterIn(P, free, rng, 12, (x, z, i) => patch(gb, x, z, 3 + rng() * 2.4, 2 + rng() * 1.6, 900 + i, 0.020, 0xf0e0b0, 0.25, 12, rng() * 3));
    scatterIn(P, free, rng, 7, (x, z, i) => patch(gb, x, z, 2.2 + rng() * 2, 1.4 + rng() * 1.4, 950 + i, 0.0205, 0xd2a866, 0.25, 11, rng() * 3));
    // wind ripples: wavy dark strips with a pale crest line, running along x
    for (let i = 0; i < 22; i++) {
      const x0 = P.x0 + 3 + rng() * (P.x1 - P.x0 - 22), len = 10 + rng() * 12, z0 = P.z0 + 3 + rng() * (P.z1 - P.z0 - 6), ph = rng() * 6, k = 0.18 + rng() * 0.12, am = 0.5 + rng() * 0.7;
      const cF = x => z0 + am * Math.sin(x * k + ph), hwF = x => 0.15 * Math.sin(Math.PI * Math.min(1, Math.max(0, (x - x0) / len))) + 0.01;
      if (!free(x0 + len / 2, z0, 0.5) || !free(x0 + 2, z0, 0.5) || !free(x0 + len - 2, z0, 0.5)) continue;
      ribbon(gb, x0, x0 + len, cF, hwF, 0.0205, 0xcdb176, false, 2);
      ribbon(gb, x0, x0 + len, x => cF(x) + 0.17, x => hwF(x) * 0.55, 0.0212, 0xf2e3b8, false, 2);
    }
    scatterIn(P, free, rng, 44, (x, z) => pebble(small, rng, x, z, 0xb09a74, 0xd8c098));
    scatterIn(P, free, rng, 4, (x, z) => {   // chunky round cactus
      const g = pick(rng, [0x5f9a4e, 0x6aa656]);
      lump(plants, 0.5, 1.05, 0.5, g, x, 1.0, z, 7, 3);
      lump(plants, 0.26, 0.55, 0.26, g, x + 0.62, 1.1, z, 6, 3); lump(plants, 0.3, 0.22, 0.26, g, x + 0.4, 0.78, z, 6, 2);
      lump(plants, 0.24, 0.45, 0.24, g, x - 0.58, 1.25, z, 6, 3); lump(plants, 0.3, 0.2, 0.24, g, x - 0.4, 0.95, z, 6, 2);
      plants.push(smoothen(ell(0.13, 0.1, 0.13, 0xe87a9a, x, 2.05, z, 5, 2)));
    }, 1.5);
    scatterIn(P, free, rng, 9, (x, z) => { const s = 0.5 + rng() * 0.3; lump(plants, s, s * 0.55, s, 0x8a8a54, x, s * 0.4, z, 7, 3); lump(plants, s * 0.6, s * 0.45, s * 0.6, 0xa09a62, x + s * 0.5, s * 0.3, z + s * 0.2, 6, 2); });
  },
  tropical(e) {
    const { gb, P, rng, free, small, plants } = e;
    scatterIn(P, free, rng, 16, (x, z, i) => patch(gb, x, z, 2 + rng() * 2.6, 1.4 + rng() * 1.8, 900 + i, 0.020, 0x1f6e3a, 0.25, 12, rng() * 3));
    scatterIn(P, free, rng, 12, (x, z, i) => patch(gb, x, z, 2 + rng() * 2, 1.4 + rng() * 1.4, 940 + i, 0.0205, 0x4fb060, 0.25, 11, rng() * 3));
    scatterIn(P, free, rng, 6, (x, z, i) => patch(gb, x, z, 1.4 + rng() * 1.4, 1 + rng() * 1.2, 980 + i, 0.0212, 0x8ac46a, 0.25, 10, rng() * 3));
    scatterIn(P, free, rng, 10, (x, z) => {   // big-leaf plants: 5 broad leaves arching outwards
      const cols = [0x2a7a3e, 0x3a9450, 0x1f6a38];
      for (let k = 0; k < 5; k++) {
        const th = k / 5 * 6.28 + rng() * 0.5, tilt = 0.5 + rng() * 0.3, len = 1.2 + rng() * 0.4;
        plants.push(smoothen(ell(len, 0.06, 0.5, cols[k % 3], x + Math.cos(th) * len * Math.cos(tilt), 0.25 + len * Math.sin(tilt), z + Math.sin(th) * len * Math.cos(tilt), 6, 2, 0, -th, tilt)));
      }
      lump(plants, 0.18, 0.3, 0.18, 0x5a8a3a, x, 0.28, z, 5, 2);
    }, 1);
    scatterIn(P, free, rng, 28, (x, z) => {   // orchids
      const c = pick(rng, [0xe07aa8, 0xa86ac8, 0xf0ece0, 0xf0a0c0]);
      small.push(lathe([[0.03, 0], [0.025, 0.4]], 3, 0x4e9a38, 1, 1, x, 0, z));
      for (let k = 0; k < 3; k++) small.push(smoothen(ell(0.11, 0.08, 0.11, c, x + (k - 1) * 0.1, 0.4 - k * 0.06, z + (k % 2) * 0.06, 5, 2)));
    });
    scatterIn(P, free, rng, 12, (x, z) => { const hex = pick(rng, [0x2f7a3e, 0x3f9a4c]); for (let k = 0; k < 7; k++) blade(plants, x, z, 0.8 + rng() * 0.3, 0.1, hex, 0.9 + rng() * 0.3, k / 7 * 6.28 + rng() * 0.4); });
    scatterIn(P, free, rng, 8, (x, z) => { plants.push(smoothen(ell(0.2, 0.15, 0.2, 0xd9344a, x, 0.5, z, 6, 2))); plants.push(lathe([[0.04, 0], [0.03, 0.5]], 3, 0x3a7a3a, 1, 1, x, 0, z)); });   // hibiscus
  },
};

// ------------------------------------------------------------------ ground entry point (called from envTerrain.buildGround's extraPaint hook)
export function paintBiomeGround(ctx, gb) {
  for (const P of PENS) {
    const g = P.ground, pal = { base: g.base, light: g.light, dark: g.dark }, rng = mulberry32(5100 + P.id * 31);
    if (P.id >= 10) {
      skirt(gb, P, pal, rng);
      for (const f of P.features) {
        if (f.blob && LAYERS[f.kind]) {
          paintBlob(gb, f, LAYERS[f.kind], f.kind === K.POND ? 64 : 44);
          if (f.kind === K.POND) glints(gb, f, [[-3.5, -1.2, 2.6, 0.4, 0.2], [4.2, 1.5, 1.9, 0.35, -0.2], [-9, 1.6, 1.8, 0.3, 0.1], [8.4, -1.4, 1.5, 0.3, 0.3]], 140, 0.074, 0x9fd0e6);
          else if (f.kind === K.OASIS) glints(gb, f, [[-2.4, -1.2, 2.0, 0.4, 0.2], [2.6, 1.8, 1.5, 0.35, -0.3]], 150, 0.074, 0xb4f0ee);
          else if (f.kind === K.HOT_SPRING) glints(gb, f, [[-2.4, -0.8, 1.8, 0.4, 0.2], [2.2, 1.6, 1.4, 0.35, -0.3]], 160, 0.074, 0xeafaf6);
          else if (f.kind === K.MUD_PIT) glints(gb, f, [[-2.8, -1.2, 2.1, 0.6, 0.3], [2.6, 1.6, 1.5, 0.5, -0.4], [0.2, -2.3, 1.2, 0.4, 0.1]], 170, 0.0295, 0x5f6a46);
          else if (f.kind === K.SNOW_DRIFT) glints(gb, f, [[-2.4, 1.2, 1.8, 0.7, 0.3], [2.8, -1.4, 1.4, 0.55, -0.2]], 180, 0.0295, 0xd2e2f0);
          else if (f.kind === K.SAND_BATH) glints(gb, f, [[-1.4, 0.6, 1.6, 0.35, 0.2], [1.6, -0.8, 1.2, 0.3, -0.3]], 190, 0.0295, 0xc4aa72);
        } else if (f.kind === K.SHADE_SHED) {
          gb.poly(roundRect(f.x - f.w / 2 - 0.4, f.z - f.d / 2 - 0.4, f.x + f.w / 2 + 0.4, f.z + f.d / 2 + 0.4, 1.6, 5, 2), 0.0215, mixHex(pal.base, 0x2a2010, 0.2));
          gb.poly(roundRect(f.x - f.w / 2 + 0.6, f.z - f.d / 2 + 0.6, f.x + f.w / 2 - 0.6, f.z + f.d / 2 - 0.6, 1.2, 5, 2), 0.0225, mixHex(pal.base, 0x2a2010, 0.3));
        } else if (f.kind === K.REED_PATCH || f.kind === K.CATTAILS) {
          patch(gb, f.x, f.z, f.w * 0.7, f.d * 1.1, 1200 + P.id, 0.0205, f.kind === K.CATTAILS ? 0x4d4a2c : 0x3f8a3c, 0.25, 14);
        } else if (f.kind === K.DUNE) {
          patch(gb, f.x + 1.5, f.z + 0.6, f.w * 0.55, f.d * 0.55, 1300, 0.0205, mixHex(pal.dark, 0x000000, 0.1), 0.15, 16);
        }
      }
      const fn = DECOR[P.biome];
      if (fn) fn({ gb, P, pal, rng, free: makeFree(P), small: ctx.small, plants: ctx.P, ctx });
    }
    // soft contact shade under every solid tree (all pens)
    for (const f of P.features) if (f.kind === K.TREE) {
      const cr = (f.h || 6) * 0.42;
      patch(gb, f.x + 0.3, f.z + 0.2, cr, cr * 0.9, 1400 + f.x * 3 + f.z, 0.0225, mixHex(pal.base, 0x10200a, 0.2), 0.18, 16);
    }
  }
}

// ------------------------------------------------------------------ feature builders (3D)
function barrelWood(S, x, z, hex, y = 0) {
  S.push(smoothen(lathe([[0.30, 0], [0.40, 0.12], [0.43, 0.45], [0.40, 0.78], [0.31, 0.9], [0, 0.9]], 8, hex, 1, 1, x, y, z)),
    lathe([[0.425, 0.2], [0.44, 0.24], [0.44, 0.3], [0.425, 0.33]], 8, 0x4d4f5a, 1, 1, x, y, z), lathe([[0.425, 0.6], [0.44, 0.64], [0.44, 0.7], [0.425, 0.73]], 8, 0x4d4f5a, 1, 1, x, y, z),
    cyl(0.24, 0.24, 0.04, 8, shade(hex, 1.18), x, y + 0.9, z));
}

function reedTuft(L, rng, f, n, cols, headHex, headEvery, tall) {
  for (let i = 0; i < n; i++) {
    const a = rng() * 6.28, d = Math.sqrt(rng()), x = f.x + Math.cos(a) * d * f.w / 2, z = f.z + Math.sin(a) * d * f.d / 2;
    const h = f.h * (0.55 + rng() * 0.5), lean = 0.06 + rng() * 0.2, yaw = rng() * 6.28;
    const tip = blade(L, x, z, h, tall ? 0.07 : 0.09, cols[(rng() * cols.length) | 0], lean, yaw);
    if (i % headEvery === 0) L.push(smoothen(ell(tall ? 0.09 : 0.08, tall ? 0.26 : 0.24, tall ? 0.09 : 0.08, headHex, tip[0], tip[1] - (tall ? 0.22 : 0.12), tip[2], 5, 3)));
  }
}

const B_ = {
  [K.BARREL_STACK](c, P, f, rng) {
    const S = c.S, W = [0x8c5e3a, 0x7a5230, 0x9a6c44, 0x6e4a2c];
    let i = 0;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) barrelWood(S, f.x + sx * 0.78, f.z + sz * 0.78, W[i++ & 3]);
    barrelWood(S, f.x, f.z, W[1], 0.86);
    barrelWood(S, f.x + 1.4 * (rng() < 0.5 ? -1 : 1), f.z + 0.2, W[2], 0);
    c.blockers.push({ x: f.x, z: f.z, hw: 0, hd: 0, r: 2.8 });
  },
  [K.SHADE_SHED](c, P, f) {
    const B = c.B, { x, z, w, d, h } = f;
    const px = [-w / 2 + 0.7, 0, w / 2 - 0.7];
    for (const sx of px) for (const sz of [-1, 1]) B.push(pole(x + sx, z + sz * (d / 2 - 0.6), 0.2, h, WOOD_D, 6));
    for (const sz of [-1, 1]) B.push(tube(x - w / 2 + 0.2, h - 0.12, z + sz * (d / 2 - 0.6), x + w / 2 - 0.2, h - 0.12, z + sz * (d / 2 - 0.6), 0.14, WOOD, 6));
    for (const sx of px) B.push(tube(x + sx, h - 0.2, z - d / 2 + 0.4, x + sx, h - 0.2, z + d / 2 - 0.4, 0.12, WOOD_L, 6));
    B.push(rb(w + 1.4, 0.34, d + 1.4, 0xb18a52, x, h + 0.14, z, 0, 0, 0, 0.14));
    B.push(rb(w + 0.6, 0.26, d + 0.6, 0xc9a766, x, h + 0.44, z, 0, 0, 0, 0.12));
    B.push(rb(w - 1.2, 0.2, d - 0.8, 0xd8b878, x, h + 0.66, z, 0, 0, 0, 0.1));
    for (let i = 0; i < 6; i++) B.push(rb(w * 0.14, 0.06, 0.12, 0x8e6a3a, x - w / 2 + 0.8 + i * (w - 1.6) / 5, h + 0.62, z + (i % 2 ? 0.8 : -0.8), 0, 0.2, 0, 0.03));   // lashings
    barrelWood(c.S, x - w / 2 + 1.5, z + 1.0, 0x6a4a2c); barrelWood(c.S, x - w / 2 + 1.5, z - 0.4, 0x7a5230);   // working shed: barrels in the shade
    c.blockers.push({ x, z, hw: w / 2 + 0.8, hd: d / 2 + 0.8, r: 0 });
  },
  [K.REED_PATCH](c, P, f, rng) { reedTuft(c.P, rng, f, 30, [0x6aa845, 0x56933e, 0x7dba4e, 0x8aa84a], 0x9a8a5c, 3); },
  [K.CATTAILS](c, P, f, rng) { reedTuft(c.P, rng, f, 26, [0x6a7a34, 0x58682c, 0x7a8a3e], 0x6a4326, 1, true); },
  [K.STONE_WALL](c, P, f, rng) {
    const R = c.R, n = Math.max(2, Math.round(f.w / 1.15)), sp = (f.w - 1.2) / (n - 1), az = f.d * 0.46;
    for (let i = 0; i < n; i++) {
      const x = f.x - f.w / 2 + 0.6 + i * sp, hex = mixHex(STONE[(rng() * 5) | 0], 0x6a6762, 0.3);
      lump(R, 0.66, 0.34, az * (0.95 + rng() * 0.1), hex, x + (rng() - 0.5) * 0.1, 0.3, f.z + (rng() - 0.5) * 0.1, 7, 3, (rng() - 0.5) * 0.3);
    }
    for (let i = 0; i < n - 1; i++) {
      const x = f.x - f.w / 2 + 0.6 + (i + 0.5) * sp, hex = STONE[(rng() * 5) | 0];
      lump(R, 0.62, 0.31, az * 0.9, hex, x + (rng() - 0.5) * 0.1, 0.74, f.z + (rng() - 0.5) * 0.1, 7, 3, (rng() - 0.5) * 0.3);
    }
    for (let i = 0; i < Math.round(n / 2.5); i++) {   // cap stones + moss
      const x = f.x - f.w / 2 + 1.2 + rng() * (f.w - 2.4);
      lump(R, 0.45, 0.22, az * 0.7, STONE[(rng() * 5) | 0], x, 1.02, f.z, 6, 2, rng() * 3);
      lump(R, 0.4, 0.1, az * 0.65, 0x6f9a4e, x + (rng() - 0.5) * 0.4, 1.17, f.z, 6, 2, rng() * 3);
    }
    c.blockers.push({ x: f.x, z: f.z, hw: f.w / 2 + 0.3, hd: f.d / 2 + 0.3, r: 0 });
  },
  [K.ROCK_PILE](c, P, f, rng) {
    const snow = P.biome === 'snow';
    boulder(c.R, f.x, f.z, f.r * 0.5, rng, rng() * 3);
    for (let i = 0; i < 4; i++) { const a = i / 4 * 6.28 + rng() * 0.6, d = f.r * 0.62; boulder(c.R, f.x + Math.cos(a) * d, f.z + Math.sin(a) * d, f.r * (0.3 + rng() * 0.1), rng, rng() * 3); }
    if (snow) {
      lump(c.R, f.r * 0.5, f.r * 0.14, f.r * 0.45, 0xeef5fa, f.x, f.r * 0.5 * 1.08 + f.r * 0.1, f.z, 8, 3);
      for (let i = 0; i < 5; i++) { const a = i / 5 * 6.28 + 0.5; lump(c.P, f.r * 0.45, f.r * 0.1, f.r * 0.32, 0xf2f8fc, f.x + Math.cos(a) * f.r * 0.95, 0.12, f.z + Math.sin(a) * f.r * 0.95, 7, 2, a); }
    }
    c.blockers.push({ x: f.x, z: f.z, hw: 0, hd: 0, r: f.r + 0.8 });
  },
  [K.SALT_LICK](c, P, f) {
    const S = c.S;
    S.push(rb(1.7, 0.14, 1.7, WOOD_D, f.x, 0.07, f.z, 0, 0.4, 0, 0.05));
    S.push(smoothen(rb(0.95, 0.62, 0.95, 0xece0d6, f.x, 0.45, f.z, 0, 0.3, 0, 0.24)));
    S.push(smoothen(ell(0.34, 0.1, 0.34, 0xd6c4b8, f.x, 0.77, f.z, 6, 2)));
    S.push(smoothen(ell(0.2, 0.17, 0.2, 0xf4ece4, f.x + 0.9, 0.17, f.z + 0.3, 5, 2)), smoothen(ell(0.16, 0.14, 0.16, 0xf4ece4, f.x - 0.8, 0.14, f.z - 0.5, 5, 2)));
  },
  [K.FALLEN_LOG](c, P, f, rng) {
    const S = c.S, r = Math.min(f.d * 0.46, 0.55), y = r * 0.95, hl = f.w / 2;
    S.push(smoothen(lathe([[r * 0.9, -hl], [r, -hl + 0.35], [r * 1.04, 0], [r, hl - 0.35], [r * 0.85, hl]], 8, 0x6a4a30, 1, 1, f.x, y, f.z, 0, 0, Math.PI / 2)));
    for (const sx of [-1, 1]) S.push(smoothen(ell(0.12, r * 0.86, r * 0.86, 0xd0aa70, f.x + sx * (hl - 0.06), y, f.z, 8, 4)));
    S.push(rod(f.x + 1.2, y + r * 0.7, f.z, f.x + 1.9, y + 1.0, f.z + 0.35, 0.14, 0.08, 0x6a4a30, 5));
    S.push(rod(f.x - 1.6, y + r * 0.7, f.z, f.x - 2.2, y + 0.95, f.z - 0.4, 0.13, 0.08, 0x6a4a30, 5));
    for (let i = 0; i < 3; i++) lump(S, 0.5 + rng() * 0.4, 0.14, 0.34, 0x5f8f48, f.x - hl * 0.6 + i * hl * 0.7 + rng() * 0.4, y + r * 0.93, f.z, 6, 2, rng() * 3);
    for (let i = 0; i < 3; i++) { const mx = f.x + hl * 0.45 + i * 0.35, mz = f.z + r + 0.1 + (i % 2) * 0.15; lump(S, 0.05, 0.12, 0.05, 0xe8dfc8, mx, 0.1, mz, 5, 2); lump(S, 0.16, 0.09, 0.16, 0xc84a3a, mx, 0.22, mz, 6, 2); }
    c.blockers.push({ x: f.x, z: f.z, hw: f.w / 2 + 0.3, hd: f.d / 2 + 0.3, r: 0 });
  },
  [K.THICKET](c, P, f, rng) {
    const Pl = c.P, R = f.r, H = f.h, col = [0x3b7a3a, 0x4b8c42, 0x2f6a35, 0x5a9a46];
    lump(Pl, R * 0.82, H * 0.4, R * 0.82, col[0], f.x, H * 0.38, f.z, 8, 3, rng() * 3);
    for (let i = 0; i < 6; i++) { const a = i / 6 * 6.28 + rng() * 0.4, d = R * 0.58; lump(Pl, R * 0.5, H * 0.3, R * 0.5, col[(i + 1) % 3], f.x + Math.cos(a) * d, H * (0.26 + rng() * 0.08), f.z + Math.sin(a) * d, 7, 3, rng() * 3); }
    lump(Pl, R * 0.55, H * 0.26, R * 0.55, col[3], f.x + (rng() - 0.5) * 0.5, H * 0.66, f.z + (rng() - 0.5) * 0.5, 7, 3);
    for (let i = 0; i < 8; i++) { const a = rng() * 6.28, d = R * (0.6 + rng() * 0.35), y = H * (0.3 + rng() * 0.35); lump(Pl, 0.13, 0.13, 0.13, i % 3 ? 0xc9473a : 0x6a3f7a, f.x + Math.cos(a) * d, y, f.z + Math.sin(a) * d, 5, 2); }
    c.blockers.push({ x: f.x, z: f.z, hw: 0, hd: 0, r: R + 0.5 });
  },
  [K.ACACIA](c, P, f, rng) { acacia(c.T, f.x, f.z, f.r, f.h, rng); c.blockers.push({ x: f.x, z: f.z, hw: 0, hd: 0, r: f.r + 1.5 }); },
  [K.FOUNTAIN](c, P, f) {
    const S = c.S, R = f.r, x = f.x, z = f.z, st = 0xc9c0ae, stL = 0xdcd3bf, wat = 0x7fc8dc;
    S.push(smoothen(lathe([[R * 0.93, 0], [R, 0.06], [R, 0.46], [R * 0.9, 0.56], [R * 0.78, 0.5]], 12, st, 1, 1, x, 0, z)));
    S.push(cyl(R * 0.8, R * 0.8, 0.06, 12, wat, x, 0.44, z));
    S.push(smoothen(lathe([[0.55, 0.3], [0.4, 0.7], [0.4, 1.0], [0.55, 1.1]], 8, stL, 1, 1, x, 0, z)));
    S.push(smoothen(lathe([[0.3, 1.0], [1.1, 1.14], [1.2, 1.3], [1.0, 1.4]], 10, st, 1, 1, x, 0, z)));
    S.push(cyl(0.92, 0.92, 0.06, 10, wat, x, 1.36, z));
    S.push(smoothen(ell(0.24, 0.32, 0.24, stL, x, 1.6, z, 6, 3)));
    S.push(rod(x, 1.7, z, x, 2.35, z, 0.1, 0.05, 0xc4ebf4, 5), smoothen(ell(0.22, 0.17, 0.22, 0xdff4fa, x, 2.42, z, 5, 2)));
    for (let k = 0; k < 4; k++) { const a = k / 4 * 6.28 + 0.4; S.push(rod(x, 2.3, z, x + Math.cos(a) * 0.7, 1.52, z + Math.sin(a) * 0.7, 0.05, 0.035, 0xc4ebf4, 4)); }
    c.blockers.push({ x, z, hw: 0, hd: 0, r: R + 1.2 });
  },
  [K.HEDGE](c, P, f, rng) {
    const Pl = c.P, n = Math.max(2, Math.round(f.w / 2)), seg = f.w / n, g = [0x4f9a40, 0x5aa646, 0x469038];
    for (let i = 0; i < n; i++) Pl.push(smoothen(rb(seg * 1.04, f.h, f.d, g[i % 3], f.x - f.w / 2 + seg * (i + 0.5), f.h / 2, f.z, 0, 0, 0, Math.min(0.5, f.d * 0.36))));
    for (let i = 0; i < 7; i++) lump(Pl, 0.1, 0.1, 0.1, pick(rng, [0xe58aa8, 0xf0ece0, 0xf0dc6a]), f.x - f.w / 2 + 0.6 + rng() * (f.w - 1.2), 0.5 + rng() * (f.h - 0.7), f.z + (rng() < 0.5 ? -1 : 1) * (f.d / 2 + 0.01), 5, 2);
    c.blockers.push({ x: f.x, z: f.z, hw: f.w / 2 + 0.3, hd: f.d / 2 + 0.3, r: 0 });
  },
  [K.PERCH](c, P, f) {
    const S = c.S, n = 4, h = f.h;
    for (let i = 0; i < n; i++) {
      const px = f.x - f.w / 2 + 0.4 + i * (f.w - 0.8) / (n - 1);
      S.push(pole(px, f.z, 0.12, h, WOOD_D, 5), tube(px, h * 0.55, f.z - 0.5, px, h * 0.82, f.z, 0.06, WOOD_D, 4), tube(px, h * 0.55, f.z + 0.5, px, h * 0.82, f.z, 0.06, WOOD_D, 4));
    }
    S.push(tube(f.x - f.w / 2, h * 0.98, f.z, f.x + f.w / 2, h * 0.98, f.z, 0.1, WOOD_L, 6));
    S.push(tube(f.x - f.w / 2 + 0.4, h * 0.55, f.z - 0.5, f.x + f.w / 2 - 0.4, h * 0.55, f.z - 0.5, 0.075, 0x8f6e46, 5));
    S.push(smoothen(ell(0.17, 0.17, 0.17, 0xb2644a, f.x - f.w / 2, h * 0.98, f.z, 5, 2)), smoothen(ell(0.17, 0.17, 0.17, 0xb2644a, f.x + f.w / 2, h * 0.98, f.z, 5, 2)));
  },
  [K.PALM](c, P, f, rng) { palm(c.T, f.x, f.z, f.r, f.h, rng); c.blockers.push({ x: f.x, z: f.z, hw: 0, hd: 0, r: f.r + 1.5 }); },
  [K.DUNE](c, P, f) {
    const L = c.small, ay = Math.min(f.h || 0.9, 0.9) * 0.42, ax = f.w * 0.5, az = f.d * 0.5;
    L.push(smoothen(ell(ax, ay, az, 0xe0c58a, f.x, 0, f.z, 16, 4, 0, 0.1, 0)));
    L.push(smoothen(ell(ax * 0.62, ay * 0.82, az * 0.55, 0xecd5a0, f.x - ax * 0.12, ay * 0.35, f.z - az * 0.1, 12, 4, 0, 0.1, 0)));
    L.push(smoothen(ell(ax * 0.35, ay * 0.5, az * 0.4, 0xe0c58a, f.x + ax * 0.6, 0, f.z + az * 0.45, 10, 4, 0, 0.3, 0)));
  },
  [K.BAMBOO](c, P, f, rng) {
    const Pl = c.P, R = f.r, H = f.h, cols = [0x86b24e, 0x6f9e42, 0x95bd58];
    for (let i = 0; i < 9; i++) {
      const a = rng() * 6.28, d = Math.sqrt(rng()) * R * 0.85, bx = f.x + Math.cos(a) * d, bz = f.z + Math.sin(a) * d;
      const hh = H * (0.78 + rng() * 0.32), lean = 0.04 + rng() * 0.1, tx = bx + Math.cos(a) * lean * hh, tz = bz + Math.sin(a) * lean * hh, r0 = 0.11 + rng() * 0.05;
      Pl.push(rod(bx, 0.05, bz, tx, hh, tz, r0, r0 * 0.7, cols[i % 3], 5));
      for (const t of [0.34, 0.68]) { const nx = bx + (tx - bx) * t, nz = bz + (tz - bz) * t; Pl.push(smoothen(ell(r0 * 1.45, 0.045, r0 * 1.45, 0x5a8a38, nx, hh * t, nz, 5, 2))); }
      for (let k = 0; k < 3; k++) { const th = rng() * 6.28; Pl.push(smoothen(ell(0.65, 0.05, 0.17, pick(rng, [0x3a8a46, 0x4a9a52, 0x62aa5a]), tx + Math.cos(th) * 0.55, hh - 0.1 - k * 0.12, tz + Math.sin(th) * 0.55, 5, 2, 0, -th, -0.4))); }
    }
    c.blockers.push({ x: f.x, z: f.z, hw: 0, hd: 0, r: R + 1 });
  },
};

// ---- trees
const CANOPY = [[0x4c8a3e, 0x6aa84c, 0x80bb58], [0x55933f, 0x72b04e, 0x88c25a], [0x488344, 0x619f50, 0x78b55a], [0x5a9a42, 0x78b654, 0x92c85f]];
const PINE = [[0x3d7746, 0x4b8750, 0x5c9a5c], [0x44804a, 0x54905a, 0x66a366]];
const SPRUCE = [0x2f6b4a, 0x3b7a55, 0x468a5e, 0x2a5e44];
const trunkP = (L, x, z, r0, r1, h, hex, y = 0) => L.push(smoothen(lathe([[r0 * 1.18, y], [r0, y + h * 0.1], [(r0 + r1) / 2, y + h * 0.5], [r1, y + h]], 6, hex, 1, 1, x, 0, z)));
const tier = (L, x, y, z, R, h, hex, rng, seg = 7) => L.push(smoothen(lathe([[0, 0], [R, 0], [R * 0.84, h * 0.34], [R * 0.46, h * 0.78], [0, h]], seg, hex, 1, 1, x, y, z, 0, rng() * 3, 0)));

function acacia(L, x, z, r, h, rng) {
  const s = h / 5;
  trunkP(L, x, z, r * 0.95, r * 0.55, h * 0.5, 0x7a5a3c);
  L.push(rod(x, h * 0.46, z, x - 1.3 * s, h * 0.86, z + 0.3 * s, r * 0.5, r * 0.34, 0x7a5a3c, 5), rod(x, h * 0.46, z, x + 1.2 * s, h * 0.88, z - 0.3 * s, r * 0.46, r * 0.32, 0x7a5a3c, 5));
  lump(L, 3.7 * s, 0.7 * s, 3.2 * s, 0x5f8a3a, x, h + 0.1 * s, z, 9, 3, rng() * 3);
  lump(L, 3.0 * s, 0.55 * s, 2.6 * s, 0x7da342, x - 0.2 * s, h + 0.55 * s, z, 9, 3, rng() * 3);
  lump(L, 1.9 * s, 0.5 * s, 1.7 * s, 0x6a9340, x + 2.0 * s, h - 0.05 * s, z + 0.8 * s, 7, 3);
  lump(L, 1.7 * s, 0.45 * s, 1.5 * s, 0x6a9340, x - 2.0 * s, h - 0.1 * s, z - 0.7 * s, 7, 3);
}
function palm(L, x, z, r, h, rng) {
  const ang = rng() * 6.28, bend = h * 0.2, dx = Math.cos(ang), dz = Math.sin(ang);
  const pt = t => [x + dx * bend * t * t, h * t, z + dz * bend * t * t];
  const rr = t => r * (1 - 0.5 * t);
  let p0 = pt(0);
  for (let k = 1; k <= 3; k++) { const p1 = pt(k / 3); L.push(rod(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], rr((k - 1) / 3), rr(k / 3), k % 2 ? 0x8a6a48 : 0x7a5a3c, 6)); p0 = p1; }
  const top = pt(1), fr = [0x2f8f4a, 0x3da055, 0x4aa85a];
  for (let i = 0; i < 7; i++) {
    const th = i / 7 * 6.28 + rng() * 0.3, up = 0.35 + (i % 2) * 0.2, len = 1.7, c = Math.cos(up), sn = Math.sin(up);
    L.push(smoothen(ell(len, 0.08, 0.45, fr[i % 3], top[0] + Math.cos(th) * len * c, top[1] + 0.15 + len * sn, top[2] + Math.sin(th) * len * c, 6, 2, 0, -th, up)));
    const ox = top[0] + Math.cos(th) * len * 2 * c, oy = top[1] + 0.15 + len * 2 * sn, oz = top[2] + Math.sin(th) * len * 2 * c;
    L.push(smoothen(ell(len * 0.8, 0.07, 0.36, fr[(i + 1) % 3], ox + Math.cos(th) * len * 0.7, oy - len * 0.55, oz + Math.sin(th) * len * 0.7, 5, 2, 0, -th, -0.7)));
  }
  for (let i = 0; i < 3; i++) { const a = i / 3 * 6.28; L.push(smoothen(ell(0.2, 0.2, 0.2, 0x6a4a28, top[0] + Math.cos(a) * 0.3, top[1] - 0.15, top[2] + Math.sin(a) * 0.3, 5, 2))); }
}
export function buildTreeFeature(c, P, f, rng) {
  const L = c.T, x = f.x, z = f.z, r = f.r, h = f.h || 6, st = f.style || 'oak';
  const pal = CANOPY[(rng() * CANOPY.length) | 0];
  switch (st) {
    case 'pine': {
      const pp = PINE[(rng() * 2) | 0], tiers = 4, s = h / 9;
      trunkP(L, x, z, r, r * 0.45, h * 0.6, BARK);
      for (let i = 0; i < tiers; i++) tier(L, x, h * 0.2 + i * 1.75 * s, z, (3.1 - i * 0.7) * s, 2.7 * s, pp[i % 3], rng);
      break;
    }
    case 'spruce': {
      const s = h / 8, snow = P.biome === 'snow', tiers = 5;
      trunkP(L, x, z, r, r * 0.45, h * 0.5, 0x5c4228);
      for (let i = 0; i < tiers; i++) {
        const R = (2.6 - i * 0.42) * s, hh = 2.3 * s, y = h * 0.16 + i * 1.4 * s;
        tier(L, x, y, z, R, hh, SPRUCE[i % 4], rng, 7);
        if (snow) L.push(smoothen(lathe([[R * 0.66 * 1.07, hh * 0.55], [R * 0.46 * 1.07, hh * 0.78], [0, hh + 0.05]], 7, 0xeaf2f8, 1, 1, x, y, z)));
      }
      break;
    }
    case 'willow': {   // weeping willow: domed crown over a stepped, bell-shaped skirt with soft rounded hanging lobes (no spikes)
      const s = h / 7, cy = h * 0.66, dark = 0x6f9f4c, mid = 0x84b058, lite = 0x9bc064;
      trunkP(L, x, z, r, r * 0.6, h * 0.46, 0x6e5a40);
      lump(L, 2.5 * s, 1.5 * s, 2.5 * s, lite, x, cy + 0.9 * s, z, 9, 4, rng() * 3);            // dome
      lump(L, 3.5 * s, 1.1 * s, 3.5 * s, mid, x, cy - 0.1 * s, z, 10, 3, rng() * 3);             // upper skirt
      lump(L, 3.9 * s, 0.95 * s, 3.9 * s, dark, x, cy - 1.0 * s, z, 10, 3, rng() * 3);           // lower skirt, widest
      const n = 9, a0 = rng() * 6.28;
      for (let i = 0; i < n; i++) {                                                               // rounded hanging lobes around the rim
        const a = a0 + i / n * 6.28 + (rng() - 0.5) * 0.25, d = (3.55 + rng() * 0.3) * s;
        lump(L, 0.85 * s, 1.2 * s, 0.85 * s, i % 2 ? lite : mid, x + Math.cos(a) * d, cy - 1.9 * s, z + Math.sin(a) * d, 6, 3, rng() * 3);
      }
      break;
    }
    case 'orchard': {
      const s = h / 4, cy = h * 0.72;
      trunkP(L, x, z, r, r * 0.65, h * 0.42, BARK);
      lump(L, 2.3 * s, 1.7 * s, 2.3 * s, pal[0], x, cy, z, 8, 3, rng() * 3);
      lump(L, 1.6 * s, 1.3 * s, 1.6 * s, pal[1], x + 0.5 * s, cy + 0.9 * s, z - 0.3 * s, 7, 3);
      for (let i = 0; i < 9; i++) { const a = rng() * 6.28, up = (rng() - 0.2) * 1.0, ca = Math.cos(up); L.push(smoothen(ell(0.17, 0.17, 0.17, i % 2 ? 0xd0453a : 0xe6b83c, x + Math.cos(a) * 2.2 * s * ca, cy + Math.sin(up) * 1.7 * s, z + Math.sin(a) * 2.2 * s * ca, 5, 2))); }
      break;
    }
    case 'acacia': acacia(L, x, z, r, h, rng); break;
    case 'palm': palm(L, x, z, r, h, rng); break;
    case 'birch': {
      const s = h / 7;
      trunkP(L, x, z, r * 0.8, r * 0.55, h * 0.55, 0xe0dac8);
      lump(L, 2.0 * s, 2.5 * s, 2.0 * s, 0x88b04a, x, h * 0.7, z, 7, 3, rng() * 3); lump(L, 1.4 * s, 1.5 * s, 1.4 * s, 0xa0c457, x, h * 0.9, z, 6, 3);
      break;
    }
    default: {   // oak: thick chunky trunk, big round crown of 4-5 overlapping lumps
      const s = h / 7, cy = h * 0.62;
      trunkP(L, x, z, r, r * 0.66, h * 0.42, BARK);
      lump(L, 3.2 * s, 2.5 * s, 3.2 * s, pal[0], x, cy, z, 8, 3, rng() * 3);
      const n = 3, a0 = rng() * 6.28;
      for (let i = 0; i < n; i++) { const a = a0 + i * 6.28 / n + (rng() - 0.5) * 0.5, d = 2.2 * s; lump(L, 2.0 * s, 1.7 * s, 2.0 * s, i % 2 ? pal[1] : pal[0], x + Math.cos(a) * d, cy - 0.3 * s + (rng() - 0.5) * 0.4, z + Math.sin(a) * d, 7, 3, rng() * 3); }
      lump(L, 2.1 * s, 1.7 * s, 2.1 * s, pal[2], x + (rng() - 0.5) * 0.5, cy + 1.7 * s, z + (rng() - 0.5) * 0.5, 7, 3);
    }
  }
  c.blockers.push({ x, z, hw: 0, hd: 0, r: r + 1.5 });
}

// returns true when the feature kind is handled here
export function biomeFeature(c, P, f, rng) {
  const fn = B_[f.kind];
  if (fn) { fn(c, P, f, rng); return true; }
  if (f.kind === K.OASIS) {   // reed / papyrus fringe + shore stones; the palms are separate features
    const ol = blobOutline(f, 44, 1), nO = 44;
    for (let i = 0; i < 22; i++) {
      const k = ((i / 22 * nO) + rng() * 1.6) | 0, sc = 1.12 + rng() * 0.2, px = f.x + (ol[(k % nO) * 2] - f.x) * sc, pz = f.z + (ol[(k % nO) * 2 + 1] - f.z) * sc;
      const cols = [0x4f9a44, 0x5aa84c, 0x6cbc54];
      for (let q = 0; q < 3; q++) blade(c.P, px + (rng() - 0.5) * 0.5, pz + (rng() - 0.5) * 0.5, 1.2 + rng() * 0.9, 0.1, cols[q % 3], 0.1 + rng() * 0.25, rng() * 6.28);
      if (i % 4 === 0) { const t = blade(c.P, px, pz, 1.8, 0.07, 0x5aa84c, 0.2, rng() * 6); lump(c.P, 0.1, 0.1, 0.1, 0xe8e0c0, t[0], t[1], t[2], 5, 2); }
    }
    for (let i = 0; i < 7; i++) { const k = ((i / 7 * nO) + rng() * 3) | 0, sc = 1.22 + rng() * 0.06; boulder(c.R, f.x + (ol[(k % nO) * 2] - f.x) * sc, f.z + (ol[(k % nO) * 2 + 1] - f.z) * sc, 0.28 + rng() * 0.2, rng, rng() * 3); }
    c.blockers.push({ x: f.x, z: f.z, hw: 0, hd: 0, r: f.r + 1.5 });
    return true;
  }
  if (f.kind === K.HOT_SPRING) {
    const ol = blobOutline(f, 44, 1), nO = 44;
    for (let i = 0; i < 14; i++) { const k = ((i / 14 * nO) + rng() * 2) | 0, sc = 1.1 + rng() * 0.07; boulder(c.R, f.x + (ol[(k % nO) * 2] - f.x) * sc, f.z + (ol[(k % nO) * 2 + 1] - f.z) * sc, 0.38 + rng() * 0.3, rng, rng() * 3); }
    for (let i = 0; i < 8; i++) c.steam.push({ x: f.x + (rng() - 0.5) * f.blob.rmin * 0.9, z: f.z + (rng() - 0.5) * f.blob.rmin * 0.6, ph: i / 8, sp: 0.8 + rng() * 0.4, sc: 0.8 + rng() * 0.5 });
    c.blockers.push({ x: f.x, z: f.z, hw: 0, hd: 0, r: f.r + 1.5 });
    return true;
  }
  if (f.kind === K.SNOW_DRIFT) {
    const ol = blobOutline(f, 40, 1), nO = 40;
    for (let i = 0; i < 6; i++) { const k = ((i / 6 * nO) + rng() * 3) | 0, sc = 1.0 + rng() * 0.12; lump(c.small, 0.9 + rng() * 0.6, 0.28, 0.7 + rng() * 0.4, 0xf6fafd, f.x + (ol[(k % nO) * 2] - f.x) * sc, 0.0, f.z + (ol[(k % nO) * 2 + 1] - f.z) * sc, 12, 4, rng() * 3); }
    lump(c.small, f.blob.rmin * 0.7, 0.3, f.blob.rmin * 0.5, 0xffffff, f.x, 0, f.z, 14, 4, -f.blob.rot);
    c.blockers.push({ x: f.x, z: f.z, hw: 0, hd: 0, r: f.r + 1 });
    return true;
  }
  if (f.kind === K.SAND_BATH) {
    const ol = blobOutline(f, 36, 1), nO = 36;
    for (let i = 0; i < 9; i++) { const k = ((i / 9 * nO) + rng() * 2) | 0, sc = 1.18 + rng() * 0.15; pebble(c.small, rng, f.x + (ol[(k % nO) * 2] - f.x) * sc, f.z + (ol[(k % nO) * 2 + 1] - f.z) * sc, 0xa8946a, 0xd8c498); }
    c.blockers.push({ x: f.x, z: f.z, hw: 0, hd: 0, r: f.r + 1 });
    return true;
  }
  return false;
}

// 1 steam puff: soft white lumpy ball (instanced + animated by environment.js)
export function buildSteamPuff() {
  return merge([smoothen(ell(1, 0.8, 1, 0xffffff, 0, 0, 0, 7, 4)), smoothen(ell(0.7, 0.6, 0.7, 0xf4fbfa, 0.55, 0.2, 0.1, 6, 3)), smoothen(ell(0.6, 0.55, 0.6, 0xf4fbfa, -0.5, 0.15, -0.2, 6, 3))]);
}
