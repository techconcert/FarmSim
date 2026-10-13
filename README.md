# FarmSim

**A living low-poly farm, rendered in raw WebGL2 with zero dependencies.**
Twenty animal species in twenty fenced pens, up to 10,000 animals and 200 farmers doing their own chores, trucks that
arrive, get loaded by the farmers and leave, all in a cel-shaded, inked cartoon style.

![The farm overview](docs/screenshots/overview.png)

Dedicated to the public domain under [CC0 1.0](LICENSE).

## Quick start
```
python3 serve.py            # http://localhost:8080/  (no-cache dev server; use this, not http.server)
npm run test:unit           # simulation, ECS, farmer, obstacle, rig and truck tests (Node, no browser)
npm run test:e2e            # headless Chromium smoke test (Playwright + SwiftShader)
npm run bench               # simulation tick timing at 2k / 5k / 10k animals
```
No install step, no bundler, no runtime dependencies. Node is only needed for the tests.

## What it is
FarmSim is a technical demo of a data-oriented farm simulation with a hand-written renderer. Animals have needs and
choose what to do: they graze, peck, wallow, bathe, sleep and flee. Farmers work through tasks (feed, water, collect eggs
and milk, shear, clean, treat sick animals) and carry goods to trucks. Trucks visit the farm on a schedule and leave with
their cargo. Day turns to night, and the lighting, outlines and fog follow.

| Pen | Species | Biome |
|---|---|---|
| 1 | chicken | coop |
| 2 | duck | pond |
| 3 | turkey | roost |
| 4 | rabbit | warren |
| 5 | goat | crag |
| 6 | sheep | meadow |
| 7 | pig | mud yard |
| 8 | cow | pasture |
| 9 | horse | paddock |
| 10 | llama | highland |
| 11 | donkey | dry corral |
| 12 | goose | riverbank |
| 13 | alpaca | alpine |
| 14 | deer | forest |
| 15 | ostrich | savanna |
| 16 | yak | snow |
| 17 | buffalo | marsh |
| 18 | peacock | garden |
| 19 | camel | desert |
| 20 | capybara | tropical |

Pens are numbered 1–20 here (pen index 0–19 in the code). They sit on a 5 × 4 grid with service lanes between rows. Each biome has its own ground, decor and features. A few trees
stand in most pens, and the animals and farmers route around them.

## Showcase

| | |
|---|---|
| ![Riverbank pen with a stream and goose pond](docs/screenshots/riverbank-pond.png) | ![Forest pen with thicket, logs and deer](docs/screenshots/forest-pen.png) |
| Riverbank: a stream-shaped pond, reeds and geese that follow the flock | Forest: round-crowned oaks and pines, logs, and deer that scare and freeze |
| ![Desert pen with an oasis, palms and dunes](docs/screenshots/desert-oasis.png) | ![Willow trees in the riverbank and marsh pens](docs/screenshots/willow-trees.png) |
| Desert: an oasis with a reed fringe, palms and a camel herd | Willows: domed crowns over soft, rounded skirts |

## Technical highlights
- **Scale.** 20 species, up to 10,000 animals and 200 farmers. The default load is 3,000 animals and 40 farmers.
- **Simulation without a renderer.** The sim (`src/config.js`, `src/ecs/`, `src/sim/`) has no DOM or WebGL and runs under
  Node. It can be tested and benchmarked on its own. Measured in Node at 10,000 animals and 200 farmers: about 3.4 ms
  average per 1/30 s tick, with occasional garbage-collection spikes.
- **Data-oriented ECS.** Struct-of-arrays typed arrays for animals, farmers, items, tasks and pens. Dense arrays, no
  per-entity objects, and no allocation in the hot loops. A counting-sort spatial hash, rebuilt every tick, gives
  neighbour queries.
- **Steering around the world.** Animals look ahead, bend their heading around circular obstacles, and slide along
  rectangles. A jam rescue flips the avoid side when an animal is blocked. Farmers' routes detour around trunks with a
  clearance margin. A flood-fill test checks that every feeder, trough and nest in every pen is reachable.
- **Hand-written WebGL2 renderer.** Instanced meshes, one draw per part type, LOD and culling. Instance buffers grow by
  doubling, so buffers are sized to live counts rather than the maximum.
- **Cel shading and inked outlines.** Three shading bands from the sun's N·L, warm light and cool shadow, and an
  inverted-hull outline pass with a width clamped to 1.2–4 px on screen so crowds stay readable.
- **Water with depth.** Each pond, stream, oasis and spring is a bowl: shallow at the shore, deepest at the centre.
  Ducks, geese and capybaras are buoyant and float on the surface. Pigs, buffalo and camels wade and sink gradually
  toward the middle, never deeper than mid-body, and slow down as they go. Animals also drink from the shore.
- **Round decals.** Spots and patches are flat ellipsoids sunk into the surface and excluded from the outline. No
  stair-stepped patterns.
- **Three LOD tiers and an adaptive budget.** Near, far (one coarse mesh per species) and a shared blob beyond that.
  If the frame exceeds 2.5 M triangles or 120 draw calls, the near-detail distance shrinks smoothly, then recovers.
- **Boot diagnostics.** A failed start shows the stack trace on screen instead of a blank page.

## Best practices
- **Separation of concerns.** Pure simulation modules, a renderer that reads them, and an orchestrator (`src/main.js`)
  that wires them together. Each module owns its files.
- **Zero allocation in hot loops.** Scratch typed arrays are module-level. Systems cache arrays in locals.
- **Seeded randomness.** Worlds are reproducible from a seed, which makes failures repeatable in tests.
- **Test at three levels.** Unit tests on the simulation under Node (world, animals, farmers, obstacles, rig, trucks);
  a headless browser smoke test on the real app with no console errors allowed; and a benchmark that tracks tick cost.
- **One design language, written down.** `DESIGN_LANGUAGE.md` holds the palette, outline widths, decal rules and
  performance budgets, so new assets stay consistent.
- **Honest performance notes.** Measured numbers are labelled with where they were measured.
- **Dev server with no-cache headers.** Module edits are picked up on refresh without stale mixes of old and new files.

## Stress test results
Measured in Chrome 155 on an Apple A18 Pro (ANGLE Metal), 2008 × 1182 canvas at DPR 2, 60 Hz display, adaptive LOD on, with
the same harness settings for both runs. Run it yourself with `python3 stress/serve.py` and open
`http://localhost:8090/stress/?autostart=1` (keep the tab visible). Full data:
[before](stress/results/2026-10-13-apple-a18pro-chrome-before.json) and [after](stress/results/2026-10-13-apple-a18pro-chrome-after.json) (copied over from the test machine; the
headline numbers were checked against the original file).

Each step changes the counts, waits 3 s, then measures four camera shots for 4 s each: **overview**, **close** (pen 1
close-up), **low** (whole farm at a shallow angle) and **orbit** (sweeping yaw). A step fails when any shot averages under
30 fps. Steps halve under 45 fps and bisect after the first failure.

**Before** is the original code. **After** adds the four merged optimizations: the farmer separation grid, compact far-tier
instances, the simulation in a Web Worker, and the animal update split by pen across threads (4 threads on this machine).

| Ramp | Before: highest count at ≥ 30 fps | After: highest count at ≥ 30 fps | Gain |
|---|---|---|---|
| Animals and farmers together (5 : 1) | 23,000 animals + 4,600 farmers | **60,000 animals + 12,000 farmers** | 2.6× |
| Animals only (200 farmers) | 49,000 animals | **109,000 animals** | 2.2× |
| Farmers only (10,000 animals) | 4,750 farmers | **19,500 farmers** | 4.1× |

10,000 animals with 2,000 farmers still holds 60 fps on every shot, and so do 40,000 animals alone and 10,000 animals with
6,000 farmers (that last load ran at 3 fps before).

What limits it now: no single wall. With simulation off the main thread, the frame time is the slower of simulation and
rendering. Near the limits the worker needs 20–35 ms of simulation per frame, and render CPU time reaches 20–30 ms on the
wide shots with 5–6 million triangles. Most shots near the limit sit at a steady 30 fps (every other vsync), so the last
step that fails usually drops to 26–29 fps rather than collapsing. Before, farmers past about 5,000 sent the
simulation over 300 ms per frame. Now the farmer ramp degrades smoothly to 19,750. These are single runs on one machine.

<details><summary>Every step (after)</summary>

fps per camera shot; sim (worker time per frame), render CPU and triangles are from the worst shot.

| Ramp | Animals | Farmers | overview | close | low | orbit | Sim ms | Render CPU ms | Triangles | Result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| combined | 10,000 | 2,000 | 60 | 60 | 60 | 60 | 2.44 | 3.91 | 2.30M | pass |
| combined | 20,000 | 4,000 | 60 | 59.7 | 60 | 60 | 4.58 | 2.89 | 2.38M | pass |
| combined | 30,000 | 6,000 | 49.5 | 60 | 54 | 52.5 | 7.32 | 6.75 | 3.46M | pass |
| combined | 40,000 | 8,000 | 38.3 | 60 | 40.2 | 40.1 | 9.1 | 7.25 | 4.39M | pass |
| combined | 45,000 | 9,000 | 36.1 | 60 | 37.5 | 38.7 | 15.1 | 9.26 | 4.84M | pass |
| combined | 48,000 | 9,600 | 35.3 | 60 | 35.2 | 37.2 | 11.51 | 10.06 | 5.41M | pass |
| combined | 50,000 | 10,000 | 34 | 60 | 34.1 | 36.7 | 14.55 | 10.23 | 5.20M | pass |
| combined | 51,000 | 10,200 | 33.2 | 60 | 33.6 | 36.7 | 15.82 | 10.36 | 5.29M | pass |
| combined | 52,000 | 10,400 | 32.9 | 60 | 32.9 | 36.2 | 15.71 | 10.54 | 5.34M | pass |
| combined | 53,000 | 10,600 | 32.2 | 60 | 33.2 | 35.5 | 17.47 | 10.23 | 5.46M | pass |
| combined | 54,000 | 10,800 | 32.4 | 60 | 33.7 | 35.3 | 17.43 | 26.25 | 5.58M | pass |
| combined | 55,000 | 11,000 | 32.4 | 42.5 | 34.8 | 35.1 | 18.55 | 22.66 | 5.72M | pass |
| combined | 56,000 | 11,200 | 32.5 | 38 | 35 | 35.1 | 20.69 | 21.24 | 5.85M | pass |
| combined | 57,000 | 11,400 | 32.7 | 35.3 | 34.6 | 34.6 | 20.96 | 21.85 | 5.95M | pass |
| combined | 58,000 | 11,600 | 32.2 | 33.6 | 34 | 34.4 | 20.56 | 30.44 | 6.05M | pass |
| combined | 59,000 | 11,800 | 31.9 | 32.7 | 33.5 | 33.7 | 20.64 | 30.77 | 6.15M | pass |
| combined | 60,000 | 12,000 | 31.1 | 32.4 | 33.2 | 33.5 | 20.65 | 31.5 | 6.25M | pass |
| combined | 61,000 | 12,200 | 30.5 | 27.9 | 32.7 | 32.7 | 25.95 | 8.96 | 5.72M | **< 30** |
| animals | 10,000 | 200 | 60 | 60 | 60 | 60 | 2.44 | 4.26 | 1.96M | pass |
| animals | 20,000 | 200 | 60 | 60 | 60 | 59.7 | 3.55 | 5.73 | 2.44M | pass |
| animals | 30,000 | 200 | 60 | 60 | 60 | 60 | 5.05 | 5.52 | 2.15M | pass |
| animals | 40,000 | 200 | 60 | 60 | 60 | 60 | 7.97 | 7.46 | 2.39M | pass |
| animals | 50,000 | 200 | 56.2 | 60 | 56.7 | 60 | 10.3 | 9.43 | 2.75M | pass |
| animals | 60,000 | 200 | 49.2 | 60 | 50 | 57.2 | 13.2 | 11.26 | 3.12M | pass |
| animals | 70,000 | 200 | 38.2 | 60 | 40.5 | 50.2 | 11.33 | 10.3 | 3.51M | pass |
| animals | 75,000 | 200 | 38.2 | 60 | 39 | 44.7 | 13.25 | 10.72 | 3.69M | pass |
| animals | 78,000 | 200 | 39 | 60 | 38.5 | 42.7 | 14.21 | 12.49 | 4.22M | pass |
| animals | 80,000 | 200 | 38.5 | 60 | 38.1 | 41.8 | 15.16 | 12.96 | 4.31M | pass |
| animals | 81,000 | 200 | 38.1 | 60 | 37.5 | 41.7 | 16.05 | 13.35 | 4.36M | pass |
| animals | 82,000 | 200 | 38 | 60 | 37.2 | 41 | 16.9 | 13.76 | 4.41M | pass |
| animals | 83,000 | 200 | 36 | 60 | 35.7 | 37.7 | 26.85 | 14.16 | 4.44M | pass |
| animals | 84,000 | 200 | 33.7 | 60 | 35.8 | 39.7 | 26.02 | 11.85 | 4.03M | pass |
| animals | 85,000 | 200 | 37 | 60 | 36 | 39.8 | 20.74 | 21.1 | 4.53M | pass |
| animals | 86,000 | 200 | 36.7 | 60 | 35.8 | 39.8 | 19.96 | 17.83 | 4.56M | pass |
| animals | 87,000 | 200 | 36.5 | 60 | 36.1 | 40.2 | 18.8 | 18.64 | 4.58M | pass |
| animals | 88,000 | 200 | 36.7 | 60 | 36.6 | 40.2 | 18.14 | 19.52 | 4.62M | pass |
| animals | 89,000 | 200 | 36.5 | 60 | 35.7 | 39.2 | 19.64 | 19.31 | 4.66M | pass |
| animals | 90,000 | 200 | 36.2 | 60 | 35.6 | 39.7 | 19.53 | 20.24 | 4.71M | pass |
| animals | 91,000 | 200 | 36.2 | 60 | 36 | 39.3 | 19.93 | 20.92 | 4.75M | pass |
| animals | 92,000 | 200 | 35.8 | 60 | 35.2 | 38.8 | 22.99 | 22.29 | 4.79M | pass |
| animals | 93,000 | 200 | 35.6 | 60 | 35.5 | 38.7 | 20.35 | 21.5 | 4.83M | pass |
| animals | 94,000 | 200 | 35.3 | 60 | 34.7 | 37.3 | 23.2 | 24.44 | 4.88M | pass |
| animals | 95,000 | 200 | 34.1 | 60 | 33.5 | 36.7 | 28.2 | 24.57 | 4.95M | pass |
| animals | 96,000 | 200 | 33.5 | 60 | 33.5 | 36.3 | 24.7 | 21.02 | 4.48M | pass |
| animals | 97,000 | 200 | 32.8 | 60 | 33.5 | 36 | 27.68 | 20.89 | 4.53M | pass |
| animals | 98,000 | 200 | 33 | 60 | 31.1 | 35 | 28.46 | 21.56 | 5.10M | pass |
| animals | 99,000 | 200 | 31.2 | 60 | 32.4 | 34.5 | 28.13 | 18.49 | 4.59M | pass |
| animals | 100,000 | 200 | 31.7 | 60 | 32.6 | 35.3 | 31.01 | 21.3 | 4.61M | pass |
| animals | 101,000 | 200 | 32.1 | 60 | 32.5 | 38.3 | 29.69 | 19.38 | 4.66M | pass |
| animals | 102,000 | 200 | 33.7 | 60 | 36.1 | 37.2 | 27.28 | 18.12 | 4.69M | pass |
| animals | 103,000 | 200 | 36 | 60 | 33 | 35.8 | 31.67 | 29.93 | 5.28M | pass |
| animals | 104,000 | 200 | 33.4 | 60 | 32.7 | 35.2 | 29.46 | 30.16 | 5.33M | pass |
| animals | 105,000 | 200 | 32.2 | 60 | 32 | 34 | 31.78 | 30.69 | 5.37M | pass |
| animals | 106,000 | 200 | 31.2 | 60 | 32 | 34.5 | 29.33 | 20.79 | 4.85M | pass |
| animals | 107,000 | 200 | 30.7 | 60 | 31.4 | 34.1 | 30.02 | 20.1 | 4.90M | pass |
| animals | 108,000 | 200 | 30.1 | 59.5 | 36.5 | 38 | 25.45 | 21.69 | 4.93M | pass |
| animals | 109,000 | 200 | 32.2 | 58.7 | 31.6 | 33.4 | 51.19 | 31.24 | 5.54M | pass |
| animals | 110,000 | 200 | 29.4 | 60 | 31.2 | 33.4 | 27.1 | 19.39 | 4.99M | **< 30** |
| farmers | 10,000 | 2,000 | 60 | 60 | 60 | 60 | 3.13 | 4.27 | 2.14M | pass |
| farmers | 10,000 | 4,000 | 60 | 60 | 60 | 59.5 | 4.52 | 4.57 | 2.52M | pass |
| farmers | 10,000 | 6,000 | 60 | 60 | 60 | 60 | 4.07 | 4.23 | 2.78M | pass |
| farmers | 10,000 | 8,000 | 53 | 60 | 59.5 | 56.5 | 6.8 | 4.55 | 3.32M | pass |
| farmers | 10,000 | 10,000 | 47.7 | 50.5 | 52.5 | 48.7 | 6.12 | 4.3 | 3.84M | pass |
| farmers | 10,000 | 12,000 | 43.7 | 41.7 | 47.7 | 43.8 | 7.38 | 4.16 | 3.65M | pass |
| farmers | 10,000 | 13,000 | 42 | 39.2 | 46 | 42.2 | 7.99 | 4.33 | 3.99M | pass |
| farmers | 10,000 | 13,500 | 41.2 | 38.1 | 45.7 | 41.7 | 8.16 | 4.54 | 4.16M | pass |
| farmers | 10,000 | 13,750 | 40.7 | 37.6 | 45 | 41.2 | 8.23 | 4.84 | 4.19M | pass |
| farmers | 10,000 | 14,000 | 40.2 | 37.2 | 44.2 | 40.6 | 8.4 | 5.39 | 4.22M | pass |
| farmers | 10,000 | 14,250 | 39.2 | 36.7 | 41 | 38.5 | 17.27 | 3.09 | 4.91M | pass |
| farmers | 10,000 | 14,500 | 37.2 | 60 | 39.2 | 36.3 | 9.8 | 5.53 | 4.83M | pass |
| farmers | 10,000 | 14,750 | 35.1 | 60 | 37.2 | 34 | 10.94 | 5.89 | 4.75M | pass |
| farmers | 10,000 | 15,000 | 34.3 | 60 | 36.3 | 37.5 | 9.62 | 6.4 | 5.23M | pass |
| farmers | 10,000 | 15,250 | 34.5 | 60 | 36.5 | 39 | 9.16 | 6.7 | 5.11M | pass |
| farmers | 10,000 | 15,500 | 35.5 | 60 | 36.3 | 38.8 | 8.69 | 5.99 | 4.93M | pass |
| farmers | 10,000 | 15,750 | 34.7 | 60 | 35.7 | 38 | 9.03 | 6.71 | 5.07M | pass |
| farmers | 10,000 | 16,000 | 34.2 | 60 | 35.4 | 37.2 | 9.46 | 6.53 | 5.25M | pass |
| farmers | 10,000 | 16,250 | 34.1 | 60 | 35.6 | 37 | 9.22 | 6.56 | 5.30M | pass |
| farmers | 10,000 | 16,500 | 34 | 60 | 35.2 | 36.7 | 9.09 | 6.55 | 5.35M | pass |
| farmers | 10,000 | 16,750 | 33.6 | 60 | 34.8 | 36.5 | 9.59 | 6.54 | 5.43M | pass |
| farmers | 10,000 | 17,000 | 33.5 | 60 | 34.6 | 36.5 | 9.81 | 6.7 | 5.48M | pass |
| farmers | 10,000 | 17,250 | 33.1 | 60 | 34.1 | 36.2 | 9.91 | 6.89 | 5.54M | pass |
| farmers | 10,000 | 17,500 | 32.7 | 60 | 34 | 35.8 | 10.24 | 6.93 | 5.62M | pass |
| farmers | 10,000 | 17,750 | 32.4 | 60 | 33.9 | 35.8 | 10.64 | 6.98 | 5.68M | pass |
| farmers | 10,000 | 18,000 | 31.9 | 60 | 33.5 | 34.2 | 10.81 | 7.05 | 5.76M | pass |
| farmers | 10,000 | 18,250 | 31.9 | 60 | 33.2 | 34.2 | 11.7 | 7.24 | 5.89M | pass |
| farmers | 10,000 | 18,500 | 32.7 | 60 | 33.5 | 34.1 | 12.64 | 23.14 | 6.05M | pass |
| farmers | 10,000 | 18,750 | 33.2 | 41.2 | 35.8 | 34.6 | 16.03 | 22.9 | 6.18M | pass |
| farmers | 10,000 | 19,000 | 33.5 | 35.7 | 35.5 | 34.6 | 16.16 | 20.69 | 6.26M | pass |
| farmers | 10,000 | 19,250 | 33.9 | 32.6 | 35.3 | 34.6 | 17.31 | 6.39 | 5.03M | pass |
| farmers | 10,000 | 19,500 | 33.2 | 30.5 | 34.8 | 34 | 16.15 | 6.07 | 5.31M | pass |
| farmers | 10,000 | 19,750 | 33.1 | 26.2 | 35.1 | 33.7 | 17.19 | 6.17 | 5.83M | **< 30** |

</details>

## Known limits
- The shipped caps are 10,000 animals and 200 farmers. The stress harness lifts them for its own page only.
  Headless SwiftShader runs are not representative of a real GPU.
- The yak and palm fronds are the weakest visual assets.
- Trucks, cargo and loading work, but the economy is deliberately simple.

## Documentation
- [PLAN.md](PLAN.md): architecture, data layout and module responsibilities.
- [DESIGN_LANGUAGE.md](DESIGN_LANGUAGE.md): look, outlines, palette, biomes and performance budgets.

## Layout
```
src/config.js        constants, species, pens, features, biome palettes
src/ecs/             typed-array world, RNG, spatial hash          (no DOM, no WebGL)
src/sim/             animals, tasks, farmers, navigation, trucks   (no DOM, no WebGL)
src/render/          GL engine, rigs, unit and environment renderers, trucks, camera
src/ui/hud.js        overlay            src/qa.js  automation hooks
tests/               unit, smoke and benchmark scripts
debug/               pages for inspecting the species lineup and environment
```

## Credits
Built as a technical demonstration. All code and assets are released under CC0 1.0 (see [LICENSE](LICENSE)).
