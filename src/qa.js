// QA hook: window.__farm. Stats are updated in place (no per-frame allocation).
import { SPECIES_COUNT, SIM_DT, WORLD, START_HOUR, DAY_LENGTH_SEC } from './config.js';
import { penOf } from './ecs/world.js';
import { getTruckStats, spawnTruck } from './sim/trucks.js';

export function installQA(ctx) {
  const { W, G } = ctx;
  const stats = {
    fps: 0, frameMs: 0, frames: 0, simTime: 0, hour: 0, day: 0, animals: 0, farmers: 0, items: 0, tasksOpen: 0,
    tasksCreated: new Array(7).fill(0), tasksDone: new Array(7).fill(0), delivered: new Array(8).fill(0),
    speciesCounts: new Array(SPECIES_COUNT).fill(0), farmerStates: new Array(8).fill(0), farmerTypes: new Array(4).fill(0),
    trucks: 0, trucksVisited: 0, farmerLoads: 0, farmerLoadGoods: 0, autoLoads: 0, loaders: 0, shipped: new Array(8).fill(0), truckStock: new Array(3).fill(0), drawCalls: 0, triangles: 0, instances: 0, animalsOutOfPen: 0, nanCount: 0,
  };
  const farm = {
    ready: false, error: null, errors: [], stats, W, G,
    getStats() { refresh(true); return JSON.parse(JSON.stringify(stats)); },
    setAnimalCount(n) { ctx.setAnimalCount(n); refresh(true); },
    setFarmerCount(n) { ctx.setFarmerCount(n); refresh(true); },
    setSpeed(x) { ctx.setSpeed(x); },
    pause() { ctx.setPaused(true); },
    resume() { ctx.setPaused(false); },
    setCamera(yaw, pitch, dist, tx, tz) { ctx.orbit.set(yaw, pitch, dist, tx, tz); },
    setHour(h) { W.time = (W.day * 24 + ((h - START_HOUR + 24) % 24)) * DAY_LENGTH_SEC / 24; W.hour = h; },
    spawnTruck(type) { return spawnTruck(W, type | 0); },   // 0 pickup, 1 van, 2 milk tanker (debug: ignores stock / cooldown)
    stepSim(seconds) { const n = Math.round(seconds / SIM_DT); for (let i = 0; i < n; i++) ctx.tick(); refresh(true); return n; },
  };
  let lastHeavy = 0;
  function heavy() {
    let oop = 0, nan = 0;
    const n = W.animalCount, px = W.a_px, pz = W.a_pz, py = W.a_py, sp = W.a_species;
    for (let i = 0; i < n; i++) {
      const x = px[i], z = pz[i], y = py[i];
      if (x !== x || z !== z || y !== y || x - x !== 0 || z - z !== 0) { nan++; continue; }
      if (penOf(x, z) !== sp[i]) oop++;
    }
    const m = W.farmerCount;
    for (let i = 0; i < m; i++) { const x = W.f_px[i], z = W.f_pz[i]; if (x !== x || z !== z || x < WORLD.x0 - 5 || x > WORLD.x1 + 5 || z < WORLD.z0 - 5 || z > WORLD.z1 + 5) nan++; }
    stats.animalsOutOfPen = oop; stats.nanCount = nan;
  }
  function refresh(force) {
    const now = performance.now();
    stats.simTime = W.time; stats.hour = W.hour; stats.day = W.day;
    stats.animals = W.animalCount; stats.farmers = W.farmerCount; stats.items = W.itemCount;
    stats.drawCalls = G.info.calls; stats.triangles = G.info.triangles; stats.instances = G.info.instances;
    const st = W.stats;
    for (let i = 0; i < 7; i++) { stats.tasksCreated[i] = st.tasksCreated[i]; stats.tasksDone[i] = st.tasksDone[i]; }
    for (let i = 0; i < 8; i++) stats.delivered[i] = st.delivered[i];
    const ts = getTruckStats(W);
    stats.trucks = ts.active; stats.trucksVisited = ts.visits;
    stats.farmerLoads = ts.farmerLoads; stats.farmerLoadGoods = ts.farmerLoadGoods; stats.autoLoads = ts.autoLoads; stats.loaders = ts.loaders;
    for (let i = 0; i < 8; i++) stats.shipped[i] = ts.shipped[i];
    for (let i = 0; i < 3; i++) stats.truckStock[i] = ts.stock[i];
    for (let i = 0; i < SPECIES_COUNT; i++) stats.speciesCounts[i] = W.speciesCount[i];
    stats.farmerStates.fill(0); stats.farmerTypes.fill(0);
    for (let i = 0; i < W.farmerCount; i++) { stats.farmerStates[W.f_state[i]]++; stats.farmerTypes[W.f_type[i]]++; }
    let open = 0; const hi = W.taskHigh;
    for (let i = 0; i < hi; i++) if (W.t_alive[i] && W.t_state[i] === 0) open++;
    stats.tasksOpen = open;
    if (force || now - lastHeavy > 1000) { lastHeavy = now; heavy(); }
  }
  farm.refresh = refresh;
  window.__farm = farm;
  return farm;
}
