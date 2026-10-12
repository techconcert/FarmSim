// Deterministic RNG helpers (no allocation).
export function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Stateless hash -> [0,1)
export function hash01(seed, n){
  let h = (Math.imul((seed|0) ^ 0x9E3779B9, 0x85EBCA6B) + Math.imul((n|0) + 0x7F4A7C15, 0xC2B2AE35)) | 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
