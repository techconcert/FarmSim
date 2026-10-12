# Design Language: Low-Poly Farm

The look is **rounded, chunky, cartoony**: plump forms, hard-edged cel shading, thick inked outlines and a muted natural
palette. Everything in the world should read as made by the same hand. Animals must be round and plump, never blocky.

## 1. Shape
- **Round over boxy.** Animals are smooth blobs built from ellipsoids, capsules and tapered rounded limbs. Avoid sharp
  boxes or hard facets on bodies, heads, limbs, trees, bushes, rocks and hills.
- **Big heads, short stout legs, tiny features.** Eyes are small dark squares or discs with a white highlight. Beaks,
  combs, horns, hooves, antlers and claws are the only faceted details.
- **Spots and patches are round.** Coats (cow, donkey stripe, fawn spots, yak and buffalo markings) are flat ellipsoids
  sunk into the hide. Their edges are smooth curves. Never paint patches per cell, which leaves square steps.
- **Props and buildings are chunky and rounded:** rounded fence posts and rails, plump hay bales, soft roof overhangs,
  rounded boulders and round-crowned trees.
- **Vehicles follow the animals:** trucks use smoothed ellipsoid cabs and rounded rods, never a hard box.

## 2. Shading (shared shader, `src/render/gl.js`)
- **Hard cel bands.** Diffuse light is quantised into three flat bands (shade, mid, lit) with narrow edges. Band
  boundaries curve across smooth surfaces because the animals use smooth vertex normals.
- **Warm lit, cool shade.** Lit bands are warm (1.0), mid bands 0.8, shade bands a cool darker tint (about 0.6).
- **Darker undersides.** Surfaces facing down take up to 40% belly darkening.
- **No saturation boost, no rim light.** The look is matte and muted. No gloss or specular highlights.
- **Night still reads.** Night uses shared scene uniforms (`sunColor`, `skyColor`, `groundColor`, `fogColor`,
  `clearColor`). Outlines darken with scene brightness (floor 0.12). Warm glows (windows, headlamps, hot-spring steam)
  use tint above 1.

## 3. Outlines (inverted-hull pass)
- Thick dark ink around every solid object, drawn by a back-face hull pass that offsets along smooth normals.
- Width is in world metres, clamped on screen to **1.2–4 px** so distant crowds don't blob up.
- Colour is near-black with a warm or cool tint: `1a1310` for buildings and props, `141708` for trees, `141a0d` for
  plants, `1f2b2b` for hills.
- **Exclusions:** ground, flat scatter, pebbles, flowers, sand and snow patches, and flat decals have **no outline**.
  Their edges come from colour contrast alone. Decal spots on animals are excluded from the hull (their vertices carry
  `nol`), so they have no ring around them.

| Element | Outline width (m) |
|---|---|
| Small animals (chicken, duck, rabbit, goose) | 0.02–0.03 |
| Medium animals (turkey, goat, sheep, pig, llama, alpaca, donkey, capybara, peacock) | 0.035 |
| Large animals (cow, horse, deer, camel, ostrich, yak, buffalo) | 0.05 |
| Farmers | 0.03 |
| Buildings | 0.08 |
| Props, fences, troughs, hay bales, features (stone walls, sheds, fountains, perches) | 0.05 |
| Rocks and boulders | 0.07 |
| Trucks (bodies / cargo / accessories / wheels) | 0.07 / 0.04 / 0.04 / 0.06 |
| Trees (all styles) | 0.10 |
| Plants, bushes, hedges, reeds, bamboo | 0.035 |
| Hills and mountains | 0.35 |

## 4. Palette (muted, natural)
**Ground and terrain**
- Meadow: base `679b4a`, light `76ab50` / `86b95a`, dark `588d44`, yellow-green `93b45a`.
- Road: rim `a88a60`, body `c9aa7c`, mid `d4b98d`, ruts `b8996c`. Gravel lanes: rim `978b72`, body `b8ab8e`, mid `c6baa0`.
- Yard: rim `a38b64`, body `c4ad82`. Path: rim `a88f64`, body `d0b486`.

**Biome ground** (per pen, from `PENS[p].ground`; each pen also has a skirt outside the fence and its own decor)
| Pen | Biome | Ground (base / light / dark) | Decor |
|---|---|---|---|
| 10 | dry corral | `c8a972` dusty tan | dust patches, pebbles, barrels |
| 11 | riverbank | lush green with wet dark patches | reeds, stream blob, creek tails |
| 12 | alpine | cool green with grey rock slabs | flowers, rocks, pines |
| 13 | forest | dark green | leaf litter, ferns, logs, thicket |
| 14 | savanna | straw yellow | golden tufts, acacia |
| 15 | snow | white-blue drifts | footprint dots, spruce with snow caps |
| 16 | marsh | olive with dark mud and puddles | cattails |
| 17 | garden | bright green | flower beds, hedge borders, fountain |
| 18 | desert | sand | ripples, dunes, oasis |
| 19 | tropical | deep green | big leaves, orchids, bamboo, hot spring |
| 0–9 | farm pens | meadow (unchanged) | existing features |

**Plants and trees**
- Oak canopies: greens in the `4c8a3e` / `6aa84c` / `80bb58` family. Birch: `88b04a` / `a0c457` / `b6d466`.
- Pine and spruce: `3d7746` / `4b8750` / `5c9a5c`. Willow: `6f9f4c` / `84b058` / `9bc064`.
- Orchard fruit: red `d0453a` and yellow `e6b83c` dots. Palm fronds: `2f8f4a` / `3da055` / `4aa85a`.
- Trunks: bark `7a5538`, birch `e0dac8`.
- Tufts: `6fa843` / `7fb84c`. Bushes: `56953f` / `6aab4c`. Reeds and bamboo: `4f9a44` / `5aa84c` / `6cbc54`.
- Flowers: `f0dc6a`, `f0ece0`, `d9779a`, `b08ad0`, `e69a50`.

**Rock, water and hills**
- Boulders: `8f8d89`, `a09d97`, `b2aea6`, with a darker lower lump `6a6762`.
- Blobs (shared organic outline): pond and oasis water turquoise / blue; hot spring pale teal with rim stones; mud dark
  olive or brown; sand `d9c08a`; snow white-blue.
- Hills (near): `68a053` / `5b9a5e`. Hills (far): `5c9170`. Mountains (horizon): `6f8fae` / `93b0cf`.

**Trucks (instance tint)**
- Barn red `b6483a`, mustard `d4a640`, faded blue `5d86a8`, cream `e6d9b4`, sage `7f9c67`, terracotta `c9733c`.
- Windows `2a2d36`, trim `4c4852`, tyres `2b2a2f`, hubs `e0d7bd`.

**Animal variants** follow real breeds where possible. Each species has a fixed set of colour slots (see `VAR` and `SLOTS` in `src/render/rig.js`), and `a_variant` picks one of eight slots per animal. Bit 0 is male, which drives head tint and deer antlers. Ostrich and peacock differences are slot-driven, so they do not depend on sex.

## 5. Form and layout
- **Organic water and mud.** Ponds, mud pits, oases and hot springs are irregular ovals (wobbled, rotated, stretched),
  not circles. The drawn shape and the sim's blob collision share one definition (`BLOB_DEFS` in `config.js`).
- **Trees in pens.** Pens have a small number of trees (1–4), placed off gates, feeders and troughs and at least 10 m
  apart. Animals and farmers steer around trunks. Trees are a realistic part of the pen, not a border.
- **Clear lanes.** Trucks use a dedicated gravel service lane east of the buildings, clear of pens and farmer routes.
  Service lanes between pen rows keep farmer traffic away from animals.
- **Density.** Crowds are readable at the default camera: about 3,000 animals and 40 farmers. At 10,000 animals and
  200 farmers the renderer lowers detail distance to hold the budget.

## 6. Do / don't
- Do keep every new object **rounded, outlined and cel-banded**, except flat ground, sand, snow and decals.
- Do match outline width to the object's size (see table).
- Do use round decal ellipsoids for spots and patches, sunk into the surface, excluded from the outline.
- Don't add gloss, specular highlights, or saturated neon colours.
- Don't add hard geometric boxes to organic things (animals, trees, bushes, rocks, hills, hedges).
- Don't outline the ground or flat decals.
- Don't paint patterns per mesh cell; they show stair-stepped edges.

## 7. Performance budget
- Animal near body + head: about 500–1000 triangles (cow up to 1300). Far LOD: about 150–300 triangles.
  Shared blob: 28 triangles.
- Trees: about 130–250 triangles each, outlined.
- Static environment (all 20 pens, hills, roads): about 600k triangles including outlines, about 20 draw calls.
- Whole scene at the default camera: 1M triangles or less. The adaptive controller targets 2.5M triangles and 120 draw
  calls at most.
- Keep draw calls per species to the visible variants, not the species count. Shadows are one instanced draw.
