// WP5 Environment: static farm scenery + day/night cycle. createEnvironment(G, W) -> { update(W, dt), info }
// Draw calls: ground, hills (+outline), buildings, props, rocks, plants, trees (each +outline), scatter, trough fills, hay bales (+outline), glows (windows+lamps), clouds = 19.
// NOTE: hills/mountains sit at ~400-600 m; the camera far plane should be >= 900 for them to show (they fade into fog anyway).
import { box, rbox } from './lowpoly.js';
import { writeYPR } from './mat4.js';
import { buildAll, buildCloud, buildFeederBale } from './envBuild.js';
import { buildSteamPuff } from './envBiomes.js';

const ss = t => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const bell = (h, c, w) => { const d = Math.abs(h - c) / w; return d >= 1 ? 0 : 1 - d; };

// colour keys
const DAY = { sun: [0.86, 0.80, 0.64], sky: [0.50, 0.60, 0.80], gnd: [0.42, 0.40, 0.34], fog: [0.30, 0.50, 0.77] };   // fog/clear = mid-blue sky like the reference
const NIGHT = { sun: [0.16, 0.21, 0.40], sky: [0.26, 0.33, 0.56], gnd: [0.14, 0.16, 0.30], fog: [0.06, 0.09, 0.19] };
const WARM = { sun: [1.0, 0.58, 0.30], sky: [0.66, 0.52, 0.66], gnd: [0.42, 0.32, 0.28], fog: [0.98, 0.72, 0.54] };

export function createEnvironment(G, W) {
  const built = buildAll();
  const { ctx } = built;

  const groundMesh = G.createStaticMesh(built.ground);
  const hillMesh = G.createStaticMesh(built.hills, { outline: 0.35, outlineColor: [0.12, 0.17, 0.17] });
  const bldgMesh = G.createStaticMesh(built.bldg, { outline: 0.08, outlineColor: [0.10, 0.075, 0.06] });
  const propMesh = G.createStaticMesh(built.props, { outline: 0.05, outlineColor: [0.10, 0.075, 0.06] });
  const OL = [0.10, 0.075, 0.06];
  const rockMesh = G.createStaticMesh(built.rocks, { outline: 0.07, outlineColor: OL });
  const plantMesh = G.createStaticMesh(built.plants, { outline: 0.035, outlineColor: [0.08, 0.10, 0.05] });
  const scatterMesh = G.createStaticMesh(built.scatter);
  const treeMesh = G.createStaticMesh(built.trees, { outline: 0.10, outlineColor: [0.08, 0.09, 0.05] });

  // trough fills (unit box with base at y=0; tint carries the colour): green feed / pale blue-white water
  const fillGeo = rbox(1, 1, 1, 0.06, 0xffffff, 0, 0.5, 0);
  const fills = G.createMesh(fillGeo, Math.max(1, ctx.troughs.length));
  fills.count = ctx.troughs.length;
  for (let i = 0; i < ctx.troughs.length; i++) {
    const t = ctx.troughs[i];
    if (t.kind === 'feed') { fills.tint[i * 3] = 0.60; fills.tint[i * 3 + 1] = 0.74; fills.tint[i * 3 + 2] = 0.22; }
    else { fills.tint[i * 3] = 0.72; fills.tint[i * 3 + 1] = 0.88; fills.tint[i * 3 + 2] = 0.96; }
  }
  // strapped round hay bales for the feeders (alternating tan / green; tint carries the hay colour)
  const bales = G.createMesh(buildFeederBale(), Math.max(1, ctx.bales.length), { outline: 0.05, outlineColor: [0.10, 0.075, 0.06] });
  bales.count = ctx.bales.length;
  for (let i = 0; i < ctx.bales.length; i++) {
    const green = ctx.bales[i].pen % 2 === 1;
    bales.tint[i * 3] = green ? 0.58 : 0.78; bales.tint[i * 3 + 1] = green ? 0.68 : 0.62; bales.tint[i * 3 + 2] = green ? 0.24 : 0.38;
  }

  // glowing windows and lamp bulbs
  const glows = G.createMesh(box(1, 1, 1, 0xffffff, 0, 0, 0), Math.max(1, ctx.glows.length));
  glows.count = ctx.glows.length;
  for (let i = 0; i < ctx.glows.length; i++) {
    const g = ctx.glows[i];
    writeYPR(glows.inst, i, g.x, g.y, g.z, g.yaw, 0, 0, g.w, g.h, g.d);
  }
  glows.upload();

  // hot-spring steam: a few soft white puffs per spring that rise, swell and fade (scale in/out) -- instanced, animated on the CPU, no allocations per frame
  const steam = built.steam || [];
  const steamMesh = G.createMesh(buildSteamPuff(), Math.max(1, steam.length));
  steamMesh.count = steam.length;
  let steamT = 0;

  // clouds
  const CLOUDS = 14;
  const cloudMesh = G.createMesh(buildCloud(), CLOUDS);
  cloudMesh.count = CLOUDS;
  const cx = new Float32Array(CLOUDS), cy = new Float32Array(CLOUDS), cz = new Float32Array(CLOUDS), cs = new Float32Array(CLOUDS), cv = new Float32Array(CLOUDS);
  for (let i = 0; i < CLOUDS; i++) {
    const a = i * 2.399, d = 300 + ((i * 97) % 260);
    cx[i] = Math.cos(a) * d; cz[i] = Math.sin(a) * d; cy[i] = 340 + (i * 37) % 60;
    cs[i] = 1.4 + ((i * 13) % 10) / 10; cv[i] = 1.2 + (i % 4) * 0.5;
  }

  G.fogNear = 380; G.fogFar = 1150;

  const env = { drawCalls: 20, buildMs: built.ctx.timeMs, treeCount: built.treeCount, triangles: 0, nightness: 0 };
  env.triangles = (built.ground.count + built.hills.count * 2 + built.bldg.count * 2 + built.props.count * 2 + built.scatter.count + built.rocks.count * 2 + built.plants.count * 2 + built.trees.count * 2) / 3;
  env.triangles += steam.length * (steamMesh.vertexCount || 0) / 3;

  function updateDynamic(W) {
    const pf = W && W.pen_food, pw = W && W.pen_water;
    for (let i = 0; i < ctx.troughs.length; i++) {
      const t = ctx.troughs[i];
      const lv = t.kind === 'feed' ? (pf ? pf[t.pen] : 0.6) : (pw ? pw[t.pen] : 0.6);
      writeYPR(fills.inst, i, t.x, t.y, t.z, 0, 0, 0, t.iw, Math.max(0.002, lv * 0.27), t.id);
    }
    fills.upload();
    for (let i = 0; i < ctx.bales.length; i++) {
      const b = ctx.bales[i];
      const lv = pf ? pf[b.pen] : 0.6;
      writeYPR(bales.inst, i, b.x, 0.08, b.z, 0, 0, 0, b.r, Math.max(0.03, lv * 1.05), b.r);
    }
    bales.upload();
  }

  function update(W, dt) {
    dt = dt || 0;
    const h = W && typeof W.hour === 'number' ? W.hour : 12;
    // night factor
    let n;
    if (h >= 21 || h < 5.5) n = 1;
    else if (h >= 17.5) n = ss((h - 17.5) / 3.5);
    else if (h < 7.5) n = 1 - ss((h - 5.5) / 2);
    else n = 0;
    const warm = Math.max(bell(h, 19.0, 2.2), bell(h, 6.4, 1.6)) * (1 - 0.35 * n);
    env.nightness = n;

    // sun / moon direction: one continuous arc, never below the horizon
    const a = (h - 6) / 12 * Math.PI;
    let dx = Math.cos(a), dy = 0.16 + 0.84 * Math.abs(Math.sin(a)), dz = 0.32;
    const l = Math.hypot(dx, dy, dz);
    G.sunDir[0] = dx / l; G.sunDir[1] = dy / l; G.sunDir[2] = dz / l;

    for (let k = 0; k < 3; k++) {
      const wm = warm * 0.75;
      let v = DAY.sun[k] + (NIGHT.sun[k] - DAY.sun[k]) * n; G.sunColor[k] = v + (WARM.sun[k] * (1 - 0.35 * n) - v) * wm;
      v = DAY.sky[k] + (NIGHT.sky[k] - DAY.sky[k]) * n; G.skyColor[k] = v + (WARM.sky[k] - v) * warm * 0.4;
      v = DAY.gnd[k] + (NIGHT.gnd[k] - DAY.gnd[k]) * n; G.groundColor[k] = v + (WARM.gnd[k] - v) * warm * 0.4;
      v = DAY.fog[k] + (NIGHT.fog[k] - DAY.fog[k]) * n; v = v + (WARM.fog[k] - v) * warm * 0.55;
      G.fogColor[k] = v; G.clearColor[k] = v;
    }

    // glow tint (windows warm at night, lamps brighter)
    for (let i = 0; i < ctx.glows.length; i++) {
      const g = ctx.glows[i], o = i * 3;
      if (g.kind === 0) { glows.tint[o] = 0.55 + 3.2 * n; glows.tint[o + 1] = 0.72 + 2.2 * n; glows.tint[o + 2] = 0.85 + 0.5 * n - 0.25 * n; }
      else { glows.tint[o] = 0.9 + 3.6 * n; glows.tint[o + 1] = 0.9 + 2.8 * n; glows.tint[o + 2] = 0.6 + 1.0 * n; }
    }
    glows.upload();

    // steam puffs
    if (steam.length) {
      steamT += dt;
      const tt = 1.15 + 1.7 * n;
      for (let i = 0; i < steam.length; i++) {
        const q = steam[i], ph = (steamT * 0.11 * q.sp + q.ph) % 1;
        const fade = Math.min(1, ph * 6) * Math.min(1, (1 - ph) * 3), sc = q.sc * (0.35 + ph * 1.0) * fade;
        writeYPR(steamMesh.inst, i, q.x + Math.sin(steamT * 0.5 + i * 1.7) * 0.5 * ph, 0.5 + ph * 3.4, q.z + Math.cos(steamT * 0.4 + i) * 0.4 * ph, i, 0, 0, sc, sc * 0.8, sc);
        const o = i * 3; steamMesh.tint[o] = tt; steamMesh.tint[o + 1] = tt; steamMesh.tint[o + 2] = tt;
      }
      steamMesh.upload();
    }
    // clouds drift
    for (let i = 0; i < CLOUDS; i++) {
      cx[i] += cv[i] * dt; if (cx[i] > 700) cx[i] = -700;
      writeYPR(cloudMesh.inst, i, cx[i], cy[i], cz[i], i * 0.7, 0, 0, cs[i], cs[i], cs[i]);
      const t = 1.6 - 1.15 * n, o = i * 3;
      cloudMesh.tint[o] = 1.0 * t; cloudMesh.tint[o + 1] = 1.0 * t; cloudMesh.tint[o + 2] = 1.0 * t;
    }
    cloudMesh.upload();
    updateDynamic(W);
  }
  update(W, 0);
  return { update, info: env };
}
