// Column-major 4x4 matrix helpers on Float32Array(16). `out` variants never allocate.
export function identity(out) {
  out[0]=1;out[1]=0;out[2]=0;out[3]=0;out[4]=0;out[5]=1;out[6]=0;out[7]=0;
  out[8]=0;out[9]=0;out[10]=1;out[11]=0;out[12]=0;out[13]=0;out[14]=0;out[15]=1;
  return out;
}
export function perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  out[0]=f/aspect;out[1]=0;out[2]=0;out[3]=0;
  out[4]=0;out[5]=f;out[6]=0;out[7]=0;
  out[8]=0;out[9]=0;out[10]=(far+near)*nf;out[11]=-1;
  out[12]=0;out[13]=0;out[14]=2*far*near*nf;out[15]=0;
  return out;
}
export function lookAt(out, ex, ey, ez, tx, ty, tz) {
  let zx = ex - tx, zy = ey - ty, zz = ez - tz;
  let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  // x = up(0,1,0) × z
  let xx = zz, xy = 0, xz = -zx;
  l = Math.hypot(xx, xz);
  if (l < 1e-6) { xx = 1; xz = 0; } else { xx /= l; xz /= l; }
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out[0]=xx;out[1]=yx;out[2]=zx;out[3]=0;
  out[4]=xy;out[5]=yy;out[6]=zy;out[7]=0;
  out[8]=xz;out[9]=yz;out[10]=zz;out[11]=0;
  out[12]=-(xx*ex+xy*ey+xz*ez);
  out[13]=-(yx*ex+yy*ey+yz*ez);
  out[14]=-(zx*ex+zy*ey+zz*ez);
  out[15]=1;
  return out;
}
// out = a * b  (safe if out aliases a or b)
export function multiply(out, a, b) {
  const a00=a[0],a01=a[1],a02=a[2],a03=a[3],a10=a[4],a11=a[5],a12=a[6],a13=a[7];
  const a20=a[8],a21=a[9],a22=a[10],a23=a[11],a30=a[12],a31=a[13],a32=a[14],a33=a[15];
  let b0=b[0],b1=b[1],b2=b[2],b3=b[3];
  out[0]=b0*a00+b1*a10+b2*a20+b3*a30; out[1]=b0*a01+b1*a11+b2*a21+b3*a31;
  out[2]=b0*a02+b1*a12+b2*a22+b3*a32; out[3]=b0*a03+b1*a13+b2*a23+b3*a33;
  b0=b[4];b1=b[5];b2=b[6];b3=b[7];
  out[4]=b0*a00+b1*a10+b2*a20+b3*a30; out[5]=b0*a01+b1*a11+b2*a21+b3*a31;
  out[6]=b0*a02+b1*a12+b2*a22+b3*a32; out[7]=b0*a03+b1*a13+b2*a23+b3*a33;
  b0=b[8];b1=b[9];b2=b[10];b3=b[11];
  out[8]=b0*a00+b1*a10+b2*a20+b3*a30; out[9]=b0*a01+b1*a11+b2*a21+b3*a31;
  out[10]=b0*a02+b1*a12+b2*a22+b3*a32; out[11]=b0*a03+b1*a13+b2*a23+b3*a33;
  b0=b[12];b1=b[13];b2=b[14];b3=b[15];
  out[12]=b0*a00+b1*a10+b2*a20+b3*a30; out[13]=b0*a01+b1*a11+b2*a21+b3*a31;
  out[14]=b0*a02+b1*a12+b2*a22+b3*a32; out[15]=b0*a03+b1*a13+b2*a23+b3*a33;
  return out;
}
// Writes a model matrix at arr[i*16 ..]: M = T(x,y,z) * Ry(yaw) * Rx(pitch) * Rz(roll) * S(sx,sy,sz).
// Ry(yaw) maps local +Z to (sin yaw, 0, cos yaw). Scale applies in local space (columns scaled).
export function writeYPR(arr, i, x, y, z, yaw, pitch, roll, sx, sy, sz) {
  const o = i * 16;
  const c = Math.cos(yaw), s = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  arr[o]   = (c*cr + s*sp*sr) * sx; arr[o+1] = cp*sr * sx;        arr[o+2]  = (-s*cr + c*sp*sr) * sx; arr[o+3]  = 0;
  arr[o+4] = (-c*sr + s*sp*cr) * sy; arr[o+5] = cp*cr * sy;       arr[o+6]  = (s*sr + c*sp*cr) * sy;  arr[o+7]  = 0;
  arr[o+8] = s*cp * sz;             arr[o+9] = -sp * sz;          arr[o+10] = c*cp * sz;              arr[o+11] = 0;
  arr[o+12] = x; arr[o+13] = y; arr[o+14] = z; arr[o+15] = 1;
}
