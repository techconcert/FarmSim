// Counting-sort uniform grid, rebuilt each tick. No allocation in build/query.
export function createSpatialHash(cell, half, cap){
  const dim = Math.ceil((half * 2) / cell);
  return {
    cell, half, dim,
    cellStart: new Int32Array(dim * dim + 1),
    items: new Int32Array(cap),
    cellOf: new Int32Array(cap),
    _cnt: new Int32Array(dim * dim + 1),
  };
}
export function buildHash(H, px, pz, count){
  const { cell, half, dim, cellStart, items, cellOf, _cnt } = H;
  const n = dim * dim;
  _cnt.fill(0);
  const inv = 1 / cell, last = dim - 1;
  for(let i = 0; i < count; i++){
    let cx = ((px[i] + half) * inv) | 0, cz = ((pz[i] + half) * inv) | 0;
    if(cx < 0) cx = 0; else if(cx > last) cx = last;
    if(cz < 0) cz = 0; else if(cz > last) cz = last;
    const c = cz * dim + cx;
    cellOf[i] = c;
    _cnt[c + 1]++;
  }
  for(let c = 0; c < n; c++) _cnt[c + 1] += _cnt[c];
  for(let c = 0; c <= n; c++) cellStart[c] = _cnt[c];
  // reuse _cnt as write cursor
  for(let c = 0; c < n; c++) _cnt[c] = cellStart[c];
  for(let i = 0; i < count; i++) items[_cnt[cellOf[i]]++] = i;
}
export function queryHash(H, px, pz, x, z, r, out, maxOut){
  const { cell, half, dim, cellStart, items } = H;
  const inv = 1 / cell, last = dim - 1;
  let x0 = ((x - r + half) * inv) | 0, x1 = ((x + r + half) * inv) | 0;
  let z0 = ((z - r + half) * inv) | 0, z1 = ((z + r + half) * inv) | 0;
  if(x - r + half < 0) x0 = 0; if(z - r + half < 0) z0 = 0;
  if(x0 < 0) x0 = 0; if(z0 < 0) z0 = 0;
  if(x1 > last) x1 = last; if(z1 > last) z1 = last;
  const r2 = r * r;
  let n = 0;
  for(let cz = z0; cz <= z1; cz++){
    const row = cz * dim;
    for(let cx = x0; cx <= x1; cx++){
      const e = cellStart[row + cx + 1];
      for(let k = cellStart[row + cx]; k < e; k++){
        const i = items[k];
        const dx = px[i] - x, dz = pz[i] - z;
        if(dx * dx + dz * dz <= r2){
          if(n >= maxOut) return n;
          out[n++] = i;
        }
      }
    }
  }
  return n;
}
