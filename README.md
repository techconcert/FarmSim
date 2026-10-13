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
Measured on 2026-10-13 in Chrome 155 on an Apple A18 Pro GPU (ANGLE Metal), 2008 × 1182 canvas at DPR 2, 60 Hz display,
adaptive LOD on. Harness: `stress/` (temporary). Full per-shot data: [`stress/results/2026-10-13-apple-a18pro-chrome.json`](stress/results/2026-10-13-apple-a18pro-chrome.json).

Each step changes the counts, waits 3 s, then measures four camera shots for 4 s each: **overview**, **close** (pen 1
close-up), **low** (whole farm at a shallow angle) and **orbit** (sweeping yaw). A step fails when any shot averages under
30 fps. Steps halve under 45 fps and bisect after the first failure.

| Ramp | Highest count at ≥ 30 fps | First count under 30 fps |
|---|---|---|
| Animals and farmers together (5 : 1) | **23,000 animals + 4,600 farmers** (30.6 fps) | 24,000 + 4,800 (27.4 fps) |
| Animals only (200 farmers) | **49,000 animals** (37.3 fps) | 50,000 (18.2 fps on the low shot) |
| Farmers only (10,000 animals) | **4,750 farmers** (32.6 fps) | 5,000 (25.0 fps) |

10,000 animals with 2,000 farmers holds 60 fps on every shot.

What limits it: **the simulation on the CPU, not the GPU.** Simulation time per frame on the worst shot rises from about
3 ms at 10k / 2k to 27 ms at 23k / 4.6k and 45 ms at 25k / 5k. Render CPU time stays at 2–10 ms, and triangles stay
between 2 and 3 million because the adaptive LOD pulls the detail distance in. Farmers cost several times more than animals,
and past about 5,000 farmers the cost runs away (6,000 farmers: 3 fps, over 300 ms of simulation per frame). The 50,000
animal failure came from one shot (18 fps on low; the other shots held 37–50 fps), so the animal-only limit is close to
50,000 rather than a hard wall. These are single runs on one machine.

<details><summary>Every step</summary>

fps per camera shot; sim, render and triangles are from the worst shot.

| Ramp | Animals | Farmers | overview | close | low | orbit | Sim ms | Render CPU ms | Triangles | Result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| combined | 10,000 | 2,000 | 60 | 60 | 60 | 60 | 3.43 | 2.41 | 2.29M | pass |
| combined | 20,000 | 4,000 | 41.7 | 53.2 | 46.5 | 42 | 17.93 | 4.6 | 2.53M | pass |
| combined | 23,000 | 4,600 | 30.6 | 38.3 | 34.2 | 32.4 | 26.67 | 4.4 | 2.82M | pass |
| combined | 24,000 | 4,800 | 27.4 | 37.5 | 27.9 | 30.4 | 31.6 | 4.45 | 2.90M | **< 30** |
| combined | 25,000 | 5,000 | 20.2 | 34.7 | 22.7 | 24.5 | 44.94 | 4.37 | 3.00M | **< 30** |
| animals | 10,000 | 200 | 60 | 60 | 60 | 60 | 3.09 | 3.76 | 1.94M | pass |
| animals | 20,000 | 200 | 60 | 60 | 60 | 60 | 3.31 | 3.04 | 2.14M | pass |
| animals | 30,000 | 200 | 59.7 | 60 | 60 | 58 | 7.84 | 6.79 | 2.37M | pass |
| animals | 40,000 | 200 | 48.2 | 58.5 | 44 | 48.5 | 13.74 | 7.96 | 2.50M | pass |
| animals | 45,000 | 200 | 41.7 | 47.3 | 39.7 | 43.5 | 16.59 | 7.79 | 2.72M | pass |
| animals | 48,000 | 200 | 39.5 | 52 | 37.3 | 43.5 | 18.23 | 8.24 | 2.86M | pass |
| animals | 49,000 | 200 | 38.6 | 51.5 | 37.7 | 37.3 | 18.42 | 7.02 | 2.30M | pass |
| animals | 50,000 | 200 | 36.7 | 49.5 | 18.2 | 37.1 | 44.07 | 10.32 | 2.95M | **< 30** |
| farmers | 10,000 | 2,000 | 60 | 60 | 60 | 60 | 6.71 | 4.09 | 2.15M | pass |
| farmers | 10,000 | 4,000 | 51.7 | 53.7 | 52.2 | 48.2 | 15.04 | 3.36 | 2.48M | pass |
| farmers | 10,000 | 4,500 | 47 | 37.2 | 36.2 | 34.2 | 25.35 | 3.21 | 2.54M | pass |
| farmers | 10,000 | 4,750 | 34.2 | 37.2 | 32.6 | 33 | 27.27 | 2.88 | 2.51M | pass |
| farmers | 10,000 | 5,000 | 36.7 | 25 | 34.7 | 38.7 | 37.25 | 2.07 | 2.50M | **< 30** |
| farmers | 10,000 | 6,000 | 3.7 | 3.6 | 3.1 | 3.1 | 316.64 | 3.45 | 2.81M | **< 30** |

</details>

## Known limits
- The shipped caps are 10,000 animals and 200 farmers. The stress test above lifts them for its own page only.
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
