// Minimal stand-in for the ECS world (only the arrays the unit renderer reads), so renderer tests / benches / the lineup page do not depend on
// the sim data model (species count, MAX_* caps). Usage: const W = mockWorld(10000, 200); fillCrowd(W, ...)
export function mockWorld(nA = 0, nF = 0, nItems = 8) {
  const W = { animalCount: nA, farmerCount: nF, itemHigh: 0, itemCount: 0, time: 0 };
  for (const k of ['a_species', 'a_state', 'a_flags', 'a_variant']) W[k] = new Uint8Array(nA);
  for (const k of ['a_px', 'a_py', 'a_pz', 'a_ppx', 'a_ppy', 'a_ppz', 'a_heading', 'a_pheading', 'a_animT', 'a_gait', 'a_scale', 'a_stateTime', 'a_speed']) W[k] = new Float32Array(nA);
  W.a_seed = new Uint32Array(nA);
  for (const k of ['f_type', 'f_state', 'f_carry']) W[k] = new Uint8Array(nF);
  for (const k of ['f_px', 'f_pz', 'f_ppx', 'f_ppz', 'f_heading', 'f_pheading', 'f_gait', 'f_animT', 'f_timer', 'f_speed']) W[k] = new Float32Array(nF);
  W.f_task = new Int32Array(nF).fill(-1);
  W.t_alive = new Uint8Array(512); W.t_type = new Uint8Array(512);
  for (const k of ['i_alive', 'i_kind', 'i_state', 'i_slot']) W[k] = new Uint8Array(nItems);
  for (const k of ['i_x', 'i_y', 'i_z', 'i_yaw']) W[k] = new Float32Array(nItems);
  W.i_carrier = new Int16Array(nItems).fill(-1);
  W.pen_gateOpen = new Float32Array(10);
  return W;
}
// deterministic pseudo-random crowd spread over a square of half-size `half`, species mix uniform over `nsp`
export function fillCrowd(W, nsp = 20, half = 150, seed = 1) {
  let r = seed >>> 0; const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < W.animalCount; i++) {
    W.a_species[i] = i % nsp; W.a_state[i] = (rnd() * 28) | 0; W.a_variant[i] = (rnd() * 16) | 0; W.a_seed[i] = (rnd() * 4e9) >>> 0;
    W.a_px[i] = (rnd() * 2 - 1) * half; W.a_pz[i] = (rnd() * 2 - 1) * half; W.a_ppx[i] = W.a_px[i] - 0.02; W.a_ppz[i] = W.a_pz[i] - 0.01;
    W.a_heading[i] = W.a_pheading[i] = rnd() * 6.28; W.a_animT[i] = rnd() * 5; W.a_gait[i] = rnd() * 40; W.a_scale[i] = 0.9 + rnd() * 0.25;
  }
  for (let f = 0; f < W.farmerCount; f++) {
    W.f_type[f] = f & 3; W.f_state[f] = (rnd() * 8) | 0; W.f_px[f] = (rnd() * 2 - 1) * half; W.f_pz[f] = (rnd() * 2 - 1) * half; W.f_ppx[f] = W.f_px[f] - 0.03; W.f_ppz[f] = W.f_pz[f];
    W.f_heading[f] = W.f_pheading[f] = rnd() * 6.28; W.f_animT[f] = rnd() * 4; W.f_gait[f] = rnd() * 30; W.f_carry[f] = rnd() < 0.3 ? 1 : 0;
  }
}

// species-clustered farm layout (like the real pens): species s lives in its own square, 5 columns x 4 rows
export function fillPens(W, nsp = 20, seed = 1) {
  fillCrowd(W, nsp, 1, seed);
  let r = (seed * 7919) >>> 0; const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < W.animalCount; i++) {
    const s = W.a_species[i], cx = ((s % 5) - 2) * 62, cz = ((s / 5 | 0) - 1.5) * 62;
    W.a_px[i] = cx + (rnd() * 2 - 1) * 24; W.a_pz[i] = cz + (rnd() * 2 - 1) * 24; W.a_ppx[i] = W.a_px[i] - 0.02; W.a_ppz[i] = W.a_pz[i];
  }
}
export function spawnItem(W, kind, x, y, z, yaw = 0) {
  const i = W.itemHigh++; W.itemCount++;
  W.i_alive[i] = 1; W.i_kind[i] = kind; W.i_state[i] = 0; W.i_x[i] = x; W.i_y[i] = y; W.i_z[i] = z; W.i_yaw[i] = yaw; W.i_carrier[i] = -1;
  return i;
}
