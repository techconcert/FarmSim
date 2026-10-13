# Low-Poly Farm: Architecture

Local web app: raw WebGL2, ES modules, no bundler and no runtime dependencies. Simulation data is kept in
struct-of-arrays typed arrays (DOTS-style). Systems loop over dense arrays, with no per-entity objects and no allocation
in hot loops. Rendering uses hardware-instanced draws (one draw per part type and LOD tier).

Scale: 20 species, up to 10,000 animals, up to 200 farmers, 20 pens, 4 farm trucks at most. Target: 60 fps on a
real GPU at the default load (3,000 animals, 40 farmers), with an adaptive detail budget at the maximum.

## 0. Ground rules
- `src/config.js`, `src/ecs/*`, `src/sim/*` do not touch the DOM or WebGL, so they run under Node for unit tests.
- Units: 1 unit = 1 m, y up, ground at y = 0. The world is `WORLD` (x ∈ [-176, 176], z ∈ [-160, 160]).
- Heading θ: forward = (sin θ, 0, cos θ), θ = atan2(vx, vz). Models face local +Z.
- Pen index equals species index.
- Animal indices are not stable: despawn swap-removes. Store ids, not indices, across ticks.
- Feature positions in `PENS` are world coordinates. Each pen's `solids` list is used for collision and steering.

## 1. Constants and data (`src/config.js`)
- `WORLD`, `PEN_COUNT = 20`, `SPECIES_COUNT = 20`, `MAX_ANIMALS = 10000`, `DEFAULT_ANIMALS = 3000`,
  `MAX_FARMERS = 200`, `DEFAULT_FARMERS = 40`, `MAX_ITEMS = 4096`, `MAX_TASKS = 512`.
- `SIM_DT = 1/30`, `MAX_STEPS_PER_FRAME = 8`, `DAY_LENGTH_SEC = 600`.
- `Species` enum (0–9 original, 10–19 donkey, goose, alpaca, deer, ostrich, yak, buffalo, peacock, camel, capybara).
- `SPECIES[s]`: `name, legs, radius, walk, run, height, diet ('grain' | 'hay'), produce (ItemKind | -1), share, color,
  color2, beh` (behaviour flags: thirst, drain, turn, wd, rest, scare, freeze, fleeD, panic, herd, follow, swim,
  wallow, noon, bath, trot). Shares are normalised, so small birds are more numerous.
- `FeatureKind` (ids 0–39 for the original and biome features, `TREE = 40` for solid trees with a `style`).
- `PENS[p]`: `id, species, row (0 north inner, 1 south inner, 2 north outer, 3 south outer), outer, x0, x1, z0, z1, cx,
  cz, s, gateEdgeZ, biome, ground {base, light, dark}, gateIn, gateOut, feeder, water, features, solids, nest, sleep,
  swim, wallow, bath, dungPile`.
- Pen grid: columns at x0 = -122 + 50·i (i = 0–4), width 44. Rows: north inner z ∈ [-64, -8], south inner z ∈ [8, 64],
  north outer z ∈ [-128, -72], south outer z ∈ [72, 128]. Service lanes at z ∈ [-72, -64] and [64, 72]. Corridors at
  x = ±124. Gate openings 4 m wide, centred on each column.
- `BLOB_DEFS` and `blobOutline`: the organic oval shape shared by the drawn pond, mud, sand, snow, oasis and hot-spring
  blobs, and by the simulation's inside/clamp tests.
- `HUBS` (x = ±130), `ROAD`, `BUILDINGS`: the yard, barn, silo, well, farmhouse, storehouse, compost and vet shed.

## 2. ECS world (`src/ecs/`)
- `rng.js`: seeded RNG. `spatialHash.js`: counting-sort grid, rebuilt each tick, `buildHash`, `queryHash`.
- `world.js`: `createWorld({seed})` returns a plain object of typed arrays sized to capacity.
  - Animals (dense `[0, animalCount)`): `a_species`, `a_state`, `a_variant` (bit 0 male, bits 1–3 colour slot),
    position, velocity, heading, speed, target, needs (hunger, thirst), state timers, flags.
  - Farmers (dense): `f_type` (feeder, collector, cleaner, vet), `f_state`, `f_step`, `f_carry`, `f_job`, route fields.
  - Items (sparse + free list): `i_alive`, `i_kind`, `i_state`, position, carrier.
  - Tasks (free list): `t_alive`, `t_type`, `t_state`, `t_pen`, `t_farmer`, `t_target`, `t_prio`.
  - Pens: `pen_food`, `pen_water`, `pen_dirt`, `pen_gateOpen`, `pen_gateTarget`, counts, `pen_taskMask`.
  - Globals: `time`, `hour`, `day`, `tick`, `animalCount`, `farmerCount`, `stats` (tasks created and done, delivered,
    truck and loader counts, `tasksDonePen`).
- `setAnimalCount`: keeps the species mix at the shares in `SPECIES`. `setFarmerCount`: spreads the four types evenly.

## 3. Simulation (`src/sim/`)
- `animals.js` `updateAnimals(W, dt)`:
  - Needs (hunger, thirst) drain over time. At thresholds, animals seek a feeder, water, a bath, a wallow, a sleep area
    or a nest, or wander, graze, peck or rest, weighted by species and time of day.
  - Movement: desired velocity toward the target, with separation from nearby animals, and steering around solids.
    Circle solids bend the heading tangentially. Rectangles are slid along. A jam-rescue flips the avoid side when an
    animal is blocked for 5 s.
  - Hard push-out from solids and pen clamp act as a safety net.
  - Water: each water blob (pond, stream, oasis, hot spring; mud is shallow) has a bowl depth profile,
    `maxDepth × (1 − t²)` with t the normalised distance to the centre along the blob's own outline, so depth is 0 at
    the shore and greatest at the centre. Buoyant species (`beh.buoy`: duck, goose, capybara) float at the surface.
    Wading species (`beh.wade`: pig, buffalo, camel) sink with a critically damped spring toward
    `−min(depth × 0.9, 0.5 × height)`, so they sink gradually toward the middle and never deeper than mid-height. They
    also slow down in deep water. `a_wy` / `a_pwy` carry the vertical offset to the renderer. Hot hours (10:00–17:00,
    peaking at 13:00) raise the chance of cooling off in the water. Animals can drink at a trough or at the shore of
    a pond, stream, oasis or hot spring, which does not drain the pen's trough stock.
  - Production (eggs, milk, wool), manure and sickness are per pen.
- `tasks.js` `updateTasks(W, dt)`: generates tasks every 0.5 s (feed, water, collect eggs, milk, shear, clean, treat)
  with mask deduplication, then lets idle farmers claim them every 0.1 s. Loading jobs for trucks are offered here too.
- `farmers.js` `updateFarmers(W, dt)`: runs each farmer's task script (move, pick up, work, drop off), wandering, leaning
  at gates and resting. Farmers route around trees and solids. Loading scripts walk the storehouse door to the truck tail.
- `nav.js` `buildRoute(W, f, x, z, pen)`: road → hub → service lane → gate → pen destination. Adds detour waypoints
  (up to two nested levels) around any solid circle a segment crosses, with a 0.6 m clearance.
- `trucks.js`: four visit kinds (pickup, van, tanker). Trucks drive in the east lane, reverse into the bay and load
  from farmers. They depart once full, or after a fallback timer, when they fall back to the automatic load.
  Trucks dispatch only between 06:30 and 19:30. Manual `spawnTruck` ignores this.

## 4. Rendering (`src/render/`)
- `gl.js`: `createGL(canvas) → G`. Instanced meshes (`createMesh`, `createStaticMesh`, `createShadowMesh`) with per-instance
  mat4 and tint. The cel shader uses three bands from the sun's N·L and a warm/cool palette.
  Outlines are an inverted-hull back-face pass. Width is in world metres, clamped to 1.2–4 px on screen. Buffers grow
  by doubling. Vertices flagged `nol` are excluded from the hull, which is how round decal spots avoid outline rings.
- `rig.js`: builds every animal and farmer mesh from ellipsoids, swept tubes and rods, with smooth normals. Spots,
  stripes and patches are round decals sunk into the hide (`blotch`, `noOutline`), never painted cells. Each species
  has near (body, head, accessories), far (one coarse mesh) and optional alt (plain variant) meshes.
  `NSP = 20`, `SPECIES_NAMES`, and `RIG[s]` (graze pitch, neck, legs, radius, outline width).
- `units.js`: animals, farmers, items, gates (all 20 pens), and shadows. Three tiers by distance:
  near (outlined) within `lodDist`, far (no outline) out to `lodDist × blobK`, and a shared 28-triangle blob beyond that.
  Culling uses per-instance sphere tests against the frustum, plus fog distance. An adaptive controller shrinks
  `lodDist` (to a 25 m floor) when triangles pass 2.5 M or draw calls pass 120, and recovers towards 110 m.
- `environment.js`, `envBuild.js`, `envTerrain.js`, `envBiomes.js`: static world. Ground and hills follow `WORLD`.
  Pens get fences, gates (animated for all 20), biome ground skirts and decor, and biome features (blobs, sheds, rocks,
  palms, acacias, bamboo, fountains, steam). Trees draw by `style` at their feature position. Static geometry is merged
  per material and outline. About 600k triangles, about 20 draw calls.
- `trucks.js`: cartoon trucks, the gravel lane, lights, and cargo that follows the loaded counts.
- `camera.js`: orbit camera with pan limits from `WORLD`.

## 5. Interface and QA
- `index.html`, `styles.css`, `src/main.js`: canvas, HUD and boot. A boot error shows an on-screen panel with the stack.
- `src/ui/hud.js`: stats panel and sliders (animals 0–10,000, farmers 0–200).
- `src/qa.js`: `window.__farm` hooks (see README).
- Tests: `tests/*.test.mjs` (unit, under Node), `tests/smoke.mjs` (headless Chromium + SwiftShader, default load,
  checks for NaN, errors, task completion, truck visits and farmer loads), `tests/bench.mjs` (sim tick timing).

## 6. Known limits
- Real-GPU frame rate at 10,000 animals and 200 farmers is unverified. Headless SwiftShader numbers are not representative.
- Sim tick at 10,000 / 200 averages about 3.4 ms in Node, with occasional V8 deopt spikes of up to about 18 ms.
- The yak and palm fronds are the weakest visual assets. Willow was reworked to round lobes in the latest pass.
- Integration risks: stale animal indices after count changes; heading convention mismatch; forgetting to upload
  instance buffers (`M.upload()`); arrays sized to capacity but only the live count drawn.
