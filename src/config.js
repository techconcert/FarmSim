// Shared constants, species table, pens, buildings. No DOM / WebGL. Runs under Node.
// World: 5 x 4 pen grid (20 pens, each 44 x 56, column pitch 50, rows separated by 8 m service lanes) + ~30 m margin.
//   grid x -122..122, z -128..128; service lanes z -72..-64 (north) and 64..72 (south); farmer corridors at x = +-124.
export const WORLD={
  x0:-176, x1:176, z0:-160, z1:160, halfX:176, halfZ:160, half:176, margin:30,
  grid:{x0:-122,x1:122,z0:-128,z1:128},
  laneN:{z0:-72,z1:-64,zc:-68}, laneS:{z0:64,z1:72,zc:68}, corridorX:124,
};
export const WORLD_HALF=WORLD.half, HASH_CELL=2.0, PEN_COUNT=20;
export const MAX_ANIMALS=10000, DEFAULT_ANIMALS=3000, SLIDER_MAX_ANIMALS=10000;
export const MAX_FARMERS=200, DEFAULT_FARMERS=40, SLIDER_MAX_FARMERS=200, MAX_ITEMS=4096, MAX_TASKS=512;
export const SIM_DT=1/30, MAX_STEPS_PER_FRAME=8, DAY_LENGTH_SEC=600, START_HOUR=8;
export const WATER_Y=0.05, FARMER_SPEED=3.4, FARMER_RADIUS=0.35, ROUTE_MAX=12;
export const Species={CHICKEN:0,DUCK:1,TURKEY:2,RABBIT:3,GOAT:4,SHEEP:5,PIG:6,COW:7,HORSE:8,LLAMA:9,DONKEY:10,GOOSE:11,ALPACA:12,DEER:13,OSTRICH:14,YAK:15,BUFFALO:16,PEACOCK:17,CAMEL:18,CAPYBARA:19}; export const SPECIES_COUNT=20;
export const AState={IDLE:0,WANDER:1,GRAZE:2,PECK:3,SCRATCH:4,GOTO:5,EAT:6,DRINK:7,REST:8,SLEEP:9,FLOCK:10,SWIM:11,WALLOW:12,ROOT:13,HOP:14,FREEZE:15,FLEE:16,TROT:17,CLIMB:18,BUTT:19,DISPLAY:20,LAY:21,DUSTBATH:22,HELD:23,SICK:24,ROLL:25,DUNG:26,PREEN:27};
export const AFlag={SICK:1,HELD:2,READY:4};
export const FarmerType={FEEDER:0,COLLECTOR:1,CLEANER:2,VET:3};   // spawn type = i % 4
export const FState={IDLE:0,MOVE:1,PICKUP:2,WORK:3,DROPOFF:4,WANDER:5,LEAN:6,REST:7};
export const TaskType={FEED:0,WATER:1,COLLECT_EGGS:2,MILK:3,SHEAR:4,CLEAN:5,TREAT:6}; export const TASK_TYPE_COUNT=7;
export const TaskState={OPEN:0,CLAIMED:1};
export const FARMER_TASKS=[[0,1],[2,3,4],[5],[6,1]];   // per FarmerType; first = priority
export const ItemKind={EGG:0,MILK:1,WOOL:2,MANURE:3,FEED:4,HAY:5,WATER:6,MEDKIT:7}; export const ITEM_KIND_COUNT=8;
export const ItemState={GROUND:0,CARRIED:1,RESERVED:2};
export const FeatureKind={FEED_TROUGH:0,WATER_TROUGH:1,HAY_FEEDER:2,COOP:3,NEST:4,DUST_BATH:5,POND:6,DUCK_HOUSE:7,ROOST:8,SHELTER:9,HUTCH:10,BURROW:11,ROCK:12,BUSH:13,SHED:14,MUD_PIT:15,PIG_ARK:16,STABLE:17,DUNG_PILE:18,SLEEP_AREA:19,
  // pens 10-19 (biome set)
  BARREL_STACK:20,SHADE_SHED:21,REED_PATCH:22,STONE_WALL:23,ROCK_PILE:24,SALT_LICK:25,FALLEN_LOG:26,THICKET:27,ACACIA:28,SAND_BATH:29,
  SNOW_DRIFT:30,CATTAILS:31,FOUNTAIN:32,HEDGE:33,PERCH:34,OASIS:35,PALM:36,DUNE:37,HOT_SPRING:38,BAMBOO:39,
  // trees (solid circle, r = trunk collision radius, h = height, `style` = visual species; canopy is render-only)
  TREE:40};

const K = FeatureKind, S = Species, I = ItemKind;
// SPECIES[s] = {name, legs, radius, walk, run, height, diet, produce, share, weight, color, color2, beh}
//   share  = weight / sum(weights): fraction of the herd (small birds are more numerous). Pen id == species id.
//   beh    = data-driven behaviour flags read by sim/animals.js (all optional, defaults below):
//     thirst  thirst-rate multiplier (camel .3, ostrich .5)         drain  pen food/water drain multiplier (big grazers eat longer)
//     turn    turn rate rad/s            wd      [min,max] wander distance (m)       rest  1 = can lie down to REST when tired
//     scare   farmer scare radius (m, default 1.5)                  freeze  farmers beyond this radius (but < scare) make it FREEZE, closer = FLEE (rabbit, deer)
//     fleeD   flee distance multiplier (deer 1.8)                   panic   1 = flee is contagious (sheep, alpaca, deer)
//     herd    1 = keeps near a leader (FLOCK state)                 follow  1 = WANDER behind a leader (duck, goose)
//     swim    FeatureKind of the blob it SWIMs in (POND)            wallow  FeatureKind of the blob it WALLOWs in (MUD_PIT / HOT_SPRING / OASIS)
//     noon    1 = wallows more around midday                       bath    {kind, state}: DUSTBATH / ROLL in that blob feature (chicken, ostrich, yak)
//     trot    1 = horse-style TROT laps that spread to neighbours
function sp(name,legs,radius,walk,run,height,diet,produce,weight,color,color2,beh){
  return {name,legs,radius,walk,run,height,diet,produce,weight,share:0,color,color2,beh:beh||{}};
}
export const SPECIES=[
  sp('chicken',2,.25,.6,2.0,.45,'grain',I.EGG,.20,0xf2efe6,0xc9402a,{drain:1,turn:9,wd:[2,5],bath:{kind:K.DUST_BATH,state:AState.DUSTBATH}}),
  sp('duck',2,.28,.5,1.5,.40,'grain',I.EGG,.10,0x8a6f3d,0xf0a020,{drain:1,turn:8,wd:[2,6],swim:K.POND,follow:1}),
  sp('turkey',2,.40,.7,2.5,.90,'grain',I.EGG,.045,0x5a3d26,0xc8283c,{drain:1,turn:6,wd:[2,6]}),
  sp('rabbit',4,.20,1.2,3.0,.30,'grain',-1,.10,0xb9a58c,0xf1e8dc,{drain:1,turn:10,wd:[2,5],rest:1,scare:6,freeze:1.5}),
  sp('goat',4,.45,.9,2.5,.80,'hay',I.MILK,.04,0xd8cdb8,0x6b4a2e,{drain:1,turn:6,wd:[4,10],rest:1}),
  sp('sheep',4,.50,.8,2.5,.90,'hay',I.WOOL,.05,0xf4f1ea,0x2e2a28,{drain:1.5,turn:5,wd:[4,10],rest:1,panic:1,herd:1}),
  sp('pig',4,.55,.7,2.0,.80,'grain',-1,.035,0xf0a9a0,0xc97b78,{drain:1.2,turn:5,wd:[3,8],rest:1,wallow:K.MUD_PIT,noon:1}),
  sp('cow',4,.90,.8,2.0,1.5,'hay',I.MILK,.025,0xf5f5f0,0x262626,{drain:2.2,turn:3,wd:[4,10],rest:1}),
  sp('horse',4,.90,1.4,6.0,1.6,'hay',-1,.02,0x7a4a28,0x2a1a10,{drain:1,turn:4,wd:[5,14],trot:1}),
  sp('llama',4,.70,1.1,3.0,1.8,'hay',I.WOOL,.03,0xdcc9a5,0x7a5f3c,{drain:1.2,turn:4,wd:[4,10],rest:1}),
  // ---- pens 10-19
  sp('donkey',4,.70,1.0,4.5,1.3,'hay',-1,.025,0x8d8479,0xe8dfd0,{drain:1.3,turn:4,wd:[5,12],rest:1,thirst:.8}),
  sp('goose',2,.32,.6,2.2,.60,'grain',I.EGG,.07,0xf3f1ea,0xf29a2e,{drain:1,turn:8,wd:[2,6],swim:K.POND,follow:1,thirst:1.1}),
  sp('alpaca',4,.55,1.0,3.5,1.5,'hay',I.WOOL,.035,0xd6b98f,0x8a6a45,{drain:1.2,turn:5,wd:[4,10],rest:1,panic:1,herd:1}),
  sp('deer',4,.60,1.1,8.0,1.2,'grain',-1,.03,0xa9743f,0xf0e4cf,{drain:1,turn:7,wd:[5,14],rest:1,scare:5,freeze:2.5,fleeD:1.8,panic:1,herd:1}),
  sp('ostrich',2,.60,1.2,8.0,2.1,'grain',I.EGG,.025,0x3b3a3a,0xe9d9c8,{drain:1,turn:6,wd:[4,12],thirst:.5,bath:{kind:K.SAND_BATH,state:AState.DUSTBATH}}),
  sp('yak',4,.95,.7,3.0,1.5,'hay',I.MILK,.02,0x3a2c25,0x8b7765,{drain:2.0,turn:3,wd:[4,10],rest:1,bath:{kind:K.SNOW_DRIFT,state:AState.ROLL}}),
  sp('buffalo',4,1.0,.8,5.0,1.6,'hay',I.MILK,.02,0x4a3a30,0x2a2220,{drain:2.2,turn:3,wd:[4,10],rest:1,thirst:1.2,wallow:K.MUD_PIT,noon:1}),
  sp('peacock',2,.35,.6,2.5,.90,'grain',I.EGG,.05,0x2a7f9e,0x3fa56b,{drain:1,turn:6,wd:[2,6],scare:2.2}),
  sp('camel',4,1.0,1.0,4.5,2.0,'hay',-1,.02,0xc9a56a,0x8a6b3f,{drain:1.8,turn:3,wd:[5,14],rest:1,thirst:.3,wallow:K.OASIS}),
  sp('capybara',4,.45,.8,3.0,.55,'hay',-1,.06,0x8c6a49,0xb89a78,{drain:1.1,turn:6,wd:[2,6],rest:1,thirst:1.3,wallow:K.HOT_SPRING}),
];
{ let tot = 0; for (const d of SPECIES) tot += d.weight; for (const d of SPECIES) d.share = d.weight / tot; }

// ---------------------------------------------------------------- pens
function F(kind,lx,ld,w,d,r,h,solid,blobDef,style){ return {kind,lx,ld,w,d,r,h,solid:!!solid,blobDef,style}; }
// K.TREE: solid circle. style -> [trunk radius (collision), height]
const TREE_STYLES={oak:[1.3,7],willow:[1.4,7],pine:[1.0,9],spruce:[1.0,8],acacia:[1.1,5],orchard:[.9,4],palm:[.9,6]};
const T=(style,lx,ld)=>F(K.TREE,lx,ld,0,0,TREE_STYLES[style][0],TREE_STYLES[style][1],true,undefined,style);
// trees per pen (local lx, ld; deterministic). Placement rules: >=8 m from the gate line, >=3 m from fences, >=3 m (edge to edge) from troughs / feeders / solids,
// clear of nests, blobs, sleep areas, >=10 m apart. Pens 13 (2 thickets), 14 (2 acacia), 18 (2 palms), 19 (3 bamboo) count their existing solid trees towards the total.
const TREES=[
  [T('oak',9.5,19.5)],
  [T('oak',14.5,48),T('oak',-2,48.5)],
  [T('oak',-11,35)],
  [T('oak',-3,20.5),T('oak',13.5,18)],
  [T('oak',3,31.5)],
  [T('oak',9.5,19),T('oak',0,45)],
  [T('oak',-4.5,18.5),T('oak',-3,47)],
  [T('oak',-1,29),T('oak',14,18),T('oak',-4,43.5)],
  [T('oak',3,46.5),T('oak',-4,19),T('oak',12.5,30)],
  [T('oak',7.5,43),T('oak',-5,18)],
  [T('acacia',9.5,21.5)],
  [T('willow',0.5,48.5),T('willow',16.5,40.5)],
  [T('pine',-3,40),T('pine',13.5,29.5),T('pine',14,15.5)],
  [T('oak',-3.5,27),T('pine',12,18)],
  [],
  [T('spruce',-4,18.5),T('spruce',13.5,18),T('spruce',-15.5,24)],
  [T('willow',-3,19.5),T('willow',13,18)],
  [T('orchard',13.5,31),T('orchard',-10.5,35),T('orchard',15,18)],
  [],
  [],
];
// per-pen feature definitions in local coords (lx, ld = depth from gate edge)
const WATER_F=()=>F(K.WATER_TROUGH,8,6,3,1,0,.6,true);
const FEED_F=()=>F(K.FEED_TROUGH,-8,6,4,1,0,.6,true);
const STREAM_DEF={rx:16,rz:4.2,rot:8*Math.PI/180,harm:[[2,.03,.7],[3,.04,2.1],[5,.02,4.0]]};   // elongated goose stream (pen 11)
const FEATS=[
  [F(K.COOP,0,48,8,6,0,3.2,true),F(K.NEST,0,43.5,6,2,0,0,false),F(K.DUST_BATH,12,30,0,0,3,0,false),F(K.SLEEP_AREA,0,40,0,0,7,0,false)],
  [F(K.POND,3,27,0,0,11,0,false),F(K.DUCK_HOUSE,-15,50,6,4,0,2,true),F(K.NEST,-15,46.5,4,2,0,0,false),F(K.SLEEP_AREA,-12,44,0,0,5,0,false)],
  [F(K.ROOST,0,46,12,2,0,1.4,false),F(K.SHELTER,-14,50,8,6,0,2.6,true),F(K.NEST,-14,45.5,4,2,0,0,false),F(K.SLEEP_AREA,0,46,0,0,6,0,false)],
  [F(K.HUTCH,-12,50,10,3,0,1.4,true),F(K.BURROW,-10,30,0,0,1.4,0,false),F(K.BURROW,6,24,0,0,1.4,0,false),F(K.BURROW,14,40,0,0,1.4,0,false),F(K.BURROW,0,44,0,0,1.4,0,false),F(K.SLEEP_AREA,-12,45,0,0,5,0,false)],
  [F(K.HAY_FEEDER,-6,14,0,0,1.4,0,true),F(K.ROCK,-10,32,0,0,6,3,false),F(K.ROCK,9,42,0,0,5,2.5,false),F(K.ROCK,13,20,0,0,4,1.8,false),F(K.ROCK,-8,50,0,0,4,2.2,false),F(K.BUSH,-17,18,0,0,1.6,0,true),F(K.BUSH,17,50,0,0,1.6,0,true),F(K.SHED,16,30,6,5,0,2.4,true),F(K.SLEEP_AREA,16,37,0,0,4,0,false)],
  [F(K.HAY_FEEDER,0,30,0,0,1.4,0,true),F(K.SHELTER,14,50,10,5,0,2.4,true),F(K.SLEEP_AREA,14,44,0,0,6,0,false)],
  [F(K.MUD_PIT,7,31,0,0,8,0,false),F(K.PIG_ARK,-14,48,6,5,0,2,true),F(K.SLEEP_AREA,-14,42,0,0,5,0,false)],
  [F(K.HAY_FEEDER,-10,34,0,0,1.6,0,true),F(K.SHELTER,10,50,14,6,0,3.4,true),F(K.SLEEP_AREA,10,42,0,0,8,0,false)],
  [F(K.HAY_FEEDER,12,40,0,0,1.6,0,true),F(K.STABLE,-12,50,12,6,0,3.4,true),F(K.SLEEP_AREA,-12,42,0,0,7,0,false)],
  [F(K.HAY_FEEDER,0,36,0,0,1.4,0,true),F(K.DUNG_PILE,16,20,0,0,2,0,false),F(K.SHELTER,-14,50,8,5,0,2.6,true),F(K.SLEEP_AREA,-14,44,0,0,5,0,false)],
  // 10 donkey 'dry-corral' (hay): WATER_TROUGH + HAY_FEEDER, BARREL_STACK, SHADE_SHED
  [F(K.HAY_FEEDER,-10,30,0,0,1.6,0,true),F(K.BARREL_STACK,-17,16,3,3,0,1.4,true),F(K.SHADE_SHED,10,50,14,6,0,3,true),F(K.SLEEP_AREA,10,42,0,0,8,0,false)],
  // 11 goose 'riverbank' (grain -> FEED_TROUGH auto): WATER_TROUGH, POND (stream), REED_PATCH, NEST
  [F(K.POND,2,27,0,0,0,0,false,STREAM_DEF),F(K.REED_PATCH,-14,37,6,2.5,0,1.6,false),F(K.NEST,14,47,4,2,0,0,false),F(K.SLEEP_AREA,-10,47,0,0,5,0,false)],
  // 12 alpaca 'alpine' (hay): WATER_TROUGH + HAY_FEEDER, STONE_WALL, ROCK_PILE
  [F(K.HAY_FEEDER,0,30,0,0,1.4,0,true),F(K.STONE_WALL,-12,20,12,1.2,0,1,true),F(K.ROCK_PILE,14,40,0,0,2.4,1.6,true),F(K.SLEEP_AREA,-14,44,0,0,5,0,false)],
  // 13 deer 'forest' (grain -> FEED_TROUGH auto): WATER_TROUGH, SALT_LICK, FALLEN_LOG, THICKET (solid)
  [F(K.SALT_LICK,-14,22,0,0,.8,.6,true),F(K.FALLEN_LOG,10,26,7,1.2,0,.8,true),F(K.THICKET,15,42,0,0,3.2,2.2,true),F(K.THICKET,-15,50,0,0,3,2.2,true),F(K.SLEEP_AREA,0,44,0,0,6,0,false)],
  // 14 ostrich 'savanna' (grain -> FEED_TROUGH auto): WATER_TROUGH, FEED_TROUGH, ACACIA (solid), SAND_BATH (blob) (+ NEST for eggs)
  [F(K.ACACIA,-14,30,0,0,1.2,5,true),F(K.ACACIA,12,52,0,0,1.2,4.5,true),F(K.SAND_BATH,7,28,0,0,0,0,false),F(K.NEST,-12,47,6,2.5,0,0,false),F(K.SLEEP_AREA,-1,46,0,0,6,0,false)],
  // 15 yak 'snow' (hay): WATER_TROUGH + HAY_FEEDER, SNOW_DRIFT (blob), ROCK_PILE
  [F(K.HAY_FEEDER,-8,28,0,0,1.5,0,true),F(K.SNOW_DRIFT,10,34,0,0,0,0,false),F(K.ROCK_PILE,-16,50,0,0,3,2,true),F(K.SLEEP_AREA,-4,44,0,0,7,0,false)],
  // 16 buffalo 'marsh' (hay): WATER_TROUGH + HAY_FEEDER, MUD_PIT (blob wallow), CATTAILS
  [F(K.HAY_FEEDER,-12,24,0,0,1.6,0,true),F(K.MUD_PIT,7,34,0,0,0,0,false),F(K.CATTAILS,-14,50,8,2.5,0,1.8,false),F(K.SLEEP_AREA,-13,40,0,0,5,0,false)],
  // 17 peacock 'garden' (grain -> FEED_TROUGH auto): WATER_TROUGH, FEED_TROUGH, FOUNTAIN (solid circle), HEDGE (solid), PERCH (+ NEST for eggs)
  [F(K.FOUNTAIN,0,28,0,0,2.2,1.4,true),F(K.HEDGE,-12,18,10,1.4,0,1.5,true),F(K.HEDGE,13,42,10,1.4,0,1.5,true),F(K.PERCH,-5,51,10,1.2,0,1.6,false),F(K.NEST,15,50,4,2,0,0,false),F(K.SLEEP_AREA,-5,45,0,0,5,0,false)],
  // 18 camel 'desert' (hay): WATER_TROUGH + HAY_FEEDER, OASIS (blob water), PALM (solid), DUNE (flat decor)
  [F(K.HAY_FEEDER,12,20,0,0,1.6,0,true),F(K.OASIS,-6,32,0,0,0,0,false),F(K.PALM,4,44,0,0,.9,5,true),F(K.PALM,-16,46,0,0,.9,4.5,true),F(K.DUNE,13,36,14,8,0,.9,false),F(K.SLEEP_AREA,10,50,0,0,6,0,false)],
  // 19 capybara 'tropical' (hay): WATER_TROUGH + HAY_FEEDER, HOT_SPRING (blob water), BAMBOO (solid)
  [F(K.HAY_FEEDER,12,20,0,0,1.4,0,true),F(K.HOT_SPRING,-5,32,0,0,0,0,false),F(K.BAMBOO,15,40,0,0,1.5,6,true),F(K.BAMBOO,-17,19,0,0,1.4,6,true),F(K.BAMBOO,-15,50,0,0,1.5,6,true),F(K.SLEEP_AREA,9,49,0,0,6,0,false)],
];

// per-pen label + ground palette (muted cartoon). Pens 0-9 keep the existing meadow.
const MEADOW={base:0x679b4a,light:0x76ab50,dark:0x588d44};
const BIOMES=['coop','pond','roost','warren','crag','meadow','mudyard','pasture','paddock','highland',
  'dry-corral','riverbank','alpine','forest','savanna','snow','marsh','garden','desert','tropical'];
const GROUNDS=[MEADOW,MEADOW,MEADOW,MEADOW,MEADOW,MEADOW,MEADOW,MEADOW,MEADOW,MEADOW,
  {base:0xc2a878,light:0xd0b98c,dark:0xb09866},   // 10 dry-corral: dusty tan
  {base:0x5fa84a,light:0x72ba55,dark:0x4c9440},   // 11 riverbank: lush green
  {base:0x76976c,light:0x8aa67c,dark:0x65845e},   // 12 alpine: cool green-grey
  {base:0x3f7a3c,light:0x4d8a45,dark:0x336a35},   // 13 forest: dark green
  {base:0xc8b45a,light:0xd8c46a,dark:0xb59f4c},   // 14 savanna: straw
  {base:0xe3ecf2,light:0xf2f7fa,dark:0xccd9e3},   // 15 snow: near-white blue-grey
  {base:0x76803f,light:0x88924c,dark:0x646e36},   // 16 marsh: olive
  {base:0x7ac84f,light:0x8bd75c,dark:0x68b444},   // 17 garden: bright green
  {base:0xe0c58a,light:0xecd5a0,dark:0xd0b378},   // 18 desert: sand
  {base:0x2f8a46,light:0x3da055,dark:0x257838},   // 19 tropical: deep green
];

// ---------------------------------------------------------------- organic blobs (pond / mud pit / sand bath / snow drift / oasis / hot spring)
// Polar outline r(t) in the blob's own rotated frame: ellipse(rx along +u, rz along +v) * (1 + sum amp*cos(k*t+phase)).
// Frame axes in world (x,z): u=(cos rot, sin rot), v=(-sin rot, cos rot).  Deterministic (constants, no RNG).
const D2R=Math.PI/180;
const BLOB_DEFS={
  [K.POND]:{rx:15,rz:9.5,rot:25*D2R,harm:[[2,.04,.7],[3,.05,2.1],[5,.025,4.0]]},
  [K.MUD_PIT]:{rx:11,rz:7,rot:-20*D2R,harm:[[2,.05,1.9],[3,.04,.4],[5,.02,3.3]]},
  [K.SAND_BATH]:{rx:6.5,rz:4.8,rot:10*D2R,harm:[[2,.05,1.2],[3,.05,3.0],[5,.02,.8]]},
  [K.SNOW_DRIFT]:{rx:8.5,rz:5.5,rot:15*D2R,harm:[[2,.05,2.6],[3,.06,.9],[5,.03,4.4]]},
  [K.OASIS]:{rx:9,rz:6.5,rot:15*D2R,harm:[[2,.04,.3],[3,.05,1.6],[5,.025,2.9]]},
  [K.HOT_SPRING]:{rx:9.5,rz:6,rot:-10*D2R,harm:[[2,.05,2.2],[3,.04,3.7],[5,.02,1.1]]},
};
function blobR(b,t){
  const c=Math.cos(t), s=Math.sin(t);
  let w=1; const h=b.harm;
  for(let i=0;i<h.length;i++) w+=h[i][1]*Math.cos(h[i][0]*t+h[i][2]);
  return b.rx*b.rz/Math.sqrt(b.rz*b.rz*c*c+b.rx*b.rx*s*s)*w;
}
function initBlob(f,def){
  const b={rx:def.rx,rz:def.rz,rot:def.rot,harm:def.harm,cr:Math.cos(def.rot),sr:Math.sin(def.rot),rmax:0,rmin:1e9};
  for(let k=0;k<720;k++){ const r=blobR(b,k*Math.PI/360); if(r>b.rmax) b.rmax=r; if(r<b.rmin) b.rmin=r; }
  f.blob=b; f.r=Math.ceil(b.rmax*10)/10;
}
// Writes the blob boundary point at frame angle t (radius scaled by `scale`) into out[o],out[o+1].
export function blobPoint(f,t,scale,out,o=0){
  const b=f.blob, r=blobR(b,t)*scale, u=Math.cos(t)*r, v=Math.sin(t)*r;
  out[o]=f.x+u*b.cr-v*b.sr; out[o+1]=f.z+u*b.sr+v*b.cr;
}
// n outline points (x,z interleaved), CCW seen from above (+y up, x right, z toward viewer => frame angle decreases).
export function blobOutline(f,n,scale=1){
  const out=new Float32Array(2*n);
  for(let k=0;k<n;k++) blobPoint(f,-k*(2*Math.PI/n),scale,out,2*k);
  return out;
}
// true if (x,z) is inside the blob shrunk (radially) by `margin` metres.
export function inBlob(f,x,z,margin=0){
  const b=f.blob, dx=x-f.x, dz=z-f.z;
  const u=dx*b.cr+dz*b.sr, v=-dx*b.sr+dz*b.cr;
  return Math.sqrt(u*u+v*v)<=blobR(b,Math.atan2(v,u))-margin;
}
// Pulls (x,z) inside the blob (shrunk by margin) if outside; writes result to out[0..1]. Returns true if moved.
export function clampToBlob(f,x,z,margin,out){
  const b=f.blob, dx=x-f.x, dz=z-f.z;
  const u=dx*b.cr+dz*b.sr, v=-dx*b.sr+dz*b.cr, rho=Math.sqrt(u*u+v*v);
  const lim=blobR(b,Math.atan2(v,u))-margin;
  if(rho<=lim){ out[0]=x; out[1]=z; return false; }
  const k=lim>0?lim/rho:0;
  out[0]=f.x+(u*b.cr-v*b.sr)*k; out[1]=f.z+(u*b.sr+v*b.cr)*k; return true;
}

export const PENS=[];
// Grid: 5 columns (i = p % 5, x0 = -122 + 50 i) x 4 rows. Every pen is 44 wide x 56 deep; its gate (4 m wide, centred on cx) faces a lane:
//   pens 0-4   north inner  z -64..-8   gate edge z=-8   (faces the road)            s=-1
//   pens 5-9   south inner  z   8..64   gate edge z= 8   (faces the road)            s=+1
//   pens 10-14 north outer  z -128..-72 gate edge z=-72  (faces the north service lane z -72..-64)  s=-1
//   pens 15-19 south outer  z  72..128  gate edge z= 72  (faces the south service lane z  64..72)   s=+1
// s = direction from the gate edge into the pen. gateIn/gateOut are 2.5 m either side of the gate edge.
for(let p=0;p<PEN_COUNT;p++){
  const i=p%5, row=(p/5)|0;                       // row 0 north inner, 1 south inner, 2 north outer, 3 south outer
  const north=row===0||row===2, outer=row>=2;
  const x0=-122+50*i, x1=x0+44, cx=x0+22;
  const s=north?-1:1;
  const gateEdgeZ=outer?(north?-72:72):(north?-8:8);
  const z0=north?gateEdgeZ-56:gateEdgeZ, z1=north?gateEdgeZ:gateEdgeZ+56;
  const species=p;
  const grain=SPECIES[species].diet==='grain';
  const defs=[];
  if(grain) defs.push(FEED_F());
  defs.push(WATER_F());
  for(const f of FEATS[p]) defs.push(f);
  for(const f of TREES[p]) defs.push(f);
  const features=[];
  for(const d of defs){
    const ft={kind:d.kind,x:cx+d.lx,z:gateEdgeZ+s*d.ld,w:d.w,d:d.d,r:d.r,h:d.h,solid:d.solid};
    if(d.style) ft.style=d.style;
    if(d.blobDef||BLOB_DEFS[d.kind]) initBlob(ft,d.blobDef||BLOB_DEFS[d.kind]);
    features.push(ft);
  }
  const find=k=>features.find(f=>f.kind===k)||null;
  const feeder=grain?find(K.FEED_TROUGH):find(K.HAY_FEEDER);
  const gnd=GROUNDS[p];
  PENS.push({
    id:p,species,row,outer,x0,x1,z0,z1,cx,cz:(z0+z1)/2,s,gateEdgeZ,
    biome:BIOMES[p], ground:{base:gnd.base,light:gnd.light,dark:gnd.dark},
    gateIn:{x:cx,z:gateEdgeZ+s*2.5},
    gateOut:{x:cx,z:gateEdgeZ-s*2.5},
    feeder,water:find(K.WATER_TROUGH),features,
    solids:features.filter(f=>f.solid),
    nest:find(K.NEST),sleep:find(K.SLEEP_AREA),
    swim:SPECIES[species].beh.swim!==undefined?find(SPECIES[species].beh.swim):null,       // blob this species SWIMs in
    wallow:SPECIES[species].beh.wallow!==undefined?find(SPECIES[species].beh.wallow):null,  // blob this species WALLOWs in
    bath:SPECIES[species].beh.bath?find(SPECIES[species].beh.bath.kind):null,               // dust / sand / snow bath feature
    dungPile:find(K.DUNG_PILE),
  });
}

// ---------------------------------------------------------------- yard
export const ROAD={x0:-150,x1:150,z0:-4,z1:4};
export const HUBS={WEST:{x:-130,z:0},EAST:{x:130,z:0}};
function R(name,x0,x1,z0,z1,h,pt){ return {name,kind:'rect',x0,x1,z0,z1,x:(x0+x1)/2,z:(z0+z1)/2,r:0,h,...pt}; }
function C(name,x,z,r,h,pt){ return {name,kind:'circle',x,z,r,x0:x-r,x1:x+r,z0:z-r,z1:z+r,h,...pt}; }
export const BUILDINGS={
  BARN:R('BARN',-156,-140,-10,10,7,{door:{x:-137,z:0}}),
  SILO:C('SILO',-148,-18,4,14,{}),
  WELL:C('WELL',-136,16,1.2,1.5,{use:{x:-136,z:12}}),
  FARMHOUSE:R('FARMHOUSE',-156,-140,-52,-36,6,{door:{x:-137,z:-44}}),
  STOREHOUSE:R('STOREHOUSE',140,156,-10,10,6,{door:{x:137,z:0}}),
  COMPOST:R('COMPOST',142,152,18,28,1.2,{door:{x:139,z:23}}),
  VET_SHED:R('VET_SHED',140,152,-40,-28,3.5,{door:{x:137,z:-34}}),
};
