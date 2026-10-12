// Raw WebGL2 renderer: instanced low-poly meshes + blob shadows. See PLAN.md section 2.
// Notes: back-face culling is OFF by default (G.cull = false) so mirrored (negative-scale) instances still render.
import { identity } from './mat4.js';

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec3 aCol;
layout(location=3) in vec4 aM0;
layout(location=4) in vec4 aM1;
layout(location=5) in vec4 aM2;
layout(location=6) in vec4 aM3;
layout(location=7) in vec3 aTint;
layout(location=9) in float aFix;       // 1 = vertex colour ignores the instance tint (accessories: eyes, horns, beaks)
uniform mat4 uView;
uniform mat4 uProj;
uniform vec3 uCam;
uniform float uFogNear;
uniform float uFogFar;
out vec3 vNrm;
out vec3 vCol;
out vec3 vWP;
out float vFog;
void main(){
  mat4 M = mat4(aM0, aM1, aM2, aM3);
  vec4 wp = M * vec4(aPos, 1.0);
  // inverse-transpose for R*S: R * S^-1 * n  == mat3(M) * (n / s^2)
  vec3 s2 = vec3(dot(aM0.xyz,aM0.xyz), dot(aM1.xyz,aM1.xyz), dot(aM2.xyz,aM2.xyz));
  vNrm = mat3(M) * (aNrm / max(s2, vec3(1e-8)));
  vCol = aCol * mix(aTint, vec3(1.0), aFix);
  vWP = wp.xyz;
  vFog = clamp((length(wp.xyz - uCam) - uFogNear) / max(uFogFar - uFogNear, 1e-3), 0.0, 1.0);
  gl_Position = uProj * uView * wp;
}`;
const FS = `#version 300 es
precision highp float;
in vec3 vNrm;
in vec3 vCol;
in vec3 vWP;
in float vFog;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uFogColor;
uniform vec3 uCam;
out vec4 outColor;
// Cel shading: 3 hard bands from sun N.L (shade / mid / lit), cool shade + warm lit, belly darkening, hemisphere fill.
// Knobs: T0/T1 band thresholds, SHADE/MID/LIT tints, BELLY strength. No saturation boost, no rim (matte, muted look).
void main(){
  vec3 n = normalize(vNrm);
  float ndl = dot(n, uSunDir);
  const float T0 = 0.18, T1 = 0.55, W = 0.02;
  float b1 = smoothstep(T0 - W, T0 + W, ndl);
  float b2 = smoothstep(T1 - W, T1 + W, ndl);
  vec3 alb = max(vCol, 0.0);
  vec3 hemi = mix(uGround, uSky, n.y * 0.5 + 0.5);
  hemi = hemi * 0.4 + 0.6 * (uGround + uSky) * 0.5;       // flat fill: no face is murky
  float sunAmt = clamp(dot(uSunColor, vec3(0.333)) * 2.0, 0.0, 1.0);
  vec3 cool = mix(vec3(1.0), vec3(0.88, 0.93, 1.06), sunAmt);
  vec3 warm = vec3(1.03, 1.0, 0.92);
  // tonal levels: shade 0.60 (cool) / mid 0.80 / lit 1.00 (warm); compressed toward flat at night so it stays readable
  float lv = mix(mix(0.60, 0.80, b1), 1.0, b2);
  lv = mix(lv, 1.0, 0.55 * (1.0 - sunAmt));
  vec3 tint = mix(cool, warm, b2 * b1) ;
  tint = mix(cool, vec3(1.0), b1);
  tint = mix(tint, warm, b2);
  vec3 light = hemi * 0.8 + uSunColor * 0.55;
  vec3 c = alb * light * lv * tint * 1.08;
  float belly = 1.0 - 0.40 * smoothstep(-0.20, -0.50, n.y);
  c *= belly;
  outColor = vec4(mix(c, uFogColor, vFog), 1.0);
}`;

// ---- outline (inverted hull): back faces of the mesh inflated along a smooth normal; flat colour + fog.
const OVS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=8) in vec3 aSN;
layout(location=3) in vec4 aM0;
layout(location=4) in vec4 aM1;
layout(location=5) in vec4 aM2;
layout(location=6) in vec4 aM3;
uniform mat4 uView;
uniform mat4 uProj;
uniform vec3 uCam;
uniform float uFogNear;
uniform float uFogFar;
uniform float uWidth;     // world metres at instance scale 1
uniform vec3 uPx;         // x: world->pixel scale (viewportH / (2*tan(fov/2))), y: min px, z: max px
out float vFog;
flat out float vMirror;
void main(){
  mat4 M = mat4(aM0, aM1, aM2, aM3);
  vec4 wp = M * vec4(aPos, 1.0);
  vec3 s2 = vec3(dot(aM0.xyz,aM0.xyz), dot(aM1.xyz,aM1.xyz), dot(aM2.xyz,aM2.xyz));
  vec3 dir = mat3(M) * (aSN / max(s2, vec3(1e-8)));
  float dl = length(dir);
  dir = dl > 1e-6 ? dir / dl : vec3(0.0);
  float sc = (sqrt(s2.x) + sqrt(s2.y) + sqrt(s2.z)) * 0.3333;
  vec4 vp = uView * wp;
  float pxW = max(-vp.z, 0.05) / uPx.x;                // world metres per pixel here
  float t = clamp(uWidth * sc, uPx.y * pxW, uPx.z * pxW);
  if (sc < 1e-4) t = 0.0;
  wp.xyz += dir * t;
  vMirror = dot(cross(aM0.xyz, aM1.xyz), aM2.xyz) < 0.0 ? 1.0 : 0.0;
  vFog = clamp((length(wp.xyz - uCam) - uFogNear) / max(uFogFar - uFogNear, 1e-3), 0.0, 1.0);
  gl_Position = uProj * uView * wp;
}`;
const OFS = `#version 300 es
precision highp float;
in float vFog;
flat in float vMirror;
uniform vec3 uColor;
uniform float uTone;
uniform vec3 uFogColor;
out vec4 outColor;
void main(){
  // keep only back faces of the source mesh (mirrored instances flip winding)
  if (gl_FrontFacing != (vMirror > 0.5)) discard;
  outColor = vec4(mix(uColor * uTone, uFogColor, vFog), 1.0);
}`;
const SVS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aLocal;
layout(location=1) in vec3 aInst;
uniform mat4 uView;
uniform mat4 uProj;
uniform vec3 uCam;
uniform float uFogNear;
uniform float uFogFar;
out vec2 vLocal;
out float vFog;
void main(){
  vec3 wp = vec3(aInst.x + aLocal.x * aInst.z, 0.04, aInst.y + aLocal.y * aInst.z);
  vLocal = aLocal;
  vFog = clamp((length(wp - uCam) - uFogNear) / max(uFogFar - uFogNear, 1e-3), 0.0, 1.0);
  gl_Position = uProj * uView * vec4(wp, 1.0);
}`;
const SFS = `#version 300 es
precision highp float;
in vec2 vLocal;
in float vFog;
out vec4 outColor;
void main(){
  float r = length(vLocal);
  float a = 0.42 * (1.0 - smoothstep(0.25, 1.0, r)) * (1.0 - vFog);
  outColor = vec4(0.03, 0.04, 0.02, a);
}`;

// per-vertex smooth normal: average of face normals over vertices sharing the same (quantised) position
function smoothNormals(geo) {
  const n = geo.count, P = geo.pos, N = geo.nrm, out = new Float32Array(n * 3), map = new Map(), Q = 1e4;
  const key = i => Math.round(P[i*3] * Q) + ',' + Math.round(P[i*3+1] * Q) + ',' + Math.round(P[i*3+2] * Q);
  const keys = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = keys[i] = key(i);
    let a = map.get(k);
    if (!a) map.set(k, a = [0, 0, 0]);
    // weight by triangle corner angle-ish: use face area (cross length) via triangle base
    const t = i - (i % 3), o = t * 3;
    const ux = P[o+3]-P[o], uy = P[o+4]-P[o+1], uz = P[o+5]-P[o+2], vx = P[o+6]-P[o], vy = P[o+7]-P[o+1], vz = P[o+8]-P[o+2];
    const w = Math.hypot(uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx) || 1e-9;
    a[0] += N[i*3] * w; a[1] += N[i*3+1] * w; a[2] += N[i*3+2] * w;
  }
  for (let i = 0; i < n; i++) {
    const a = map.get(keys[i]), l = Math.hypot(a[0], a[1], a[2]);
    if (l > 1e-9) { out[i*3] = a[0]/l; out[i*3+1] = a[1]/l; out[i*3+2] = a[2]/l; }
    else { out[i*3] = N[i*3]; out[i*3+1] = N[i*3+1]; out[i*3+2] = N[i*3+2]; }
  }
  if (geo.nol) for (let i = 0; i < n; i++) if (geo.nol[i]) { out[i*3] = 0; out[i*3+1] = 0; out[i*3+2] = 0; }   // decal vertices: no hull
  return out;
}
function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile error: ' + log);
  }
  return sh;
}
function program(gl, vs, fs, names) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program link error: ' + gl.getProgramInfoLog(p));
  const u = {};
  for (const n of names) u[n] = gl.getUniformLocation(p, n);
  return { p, u };
}

export function createGL(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true, powerPreference: 'high-performance' });
  if (!gl) throw new Error('WebGL2 not available');
  const main = program(gl, VS, FS, ['uView', 'uProj', 'uCam', 'uFogNear', 'uFogFar', 'uSunDir', 'uSunColor', 'uSky', 'uGround', 'uFogColor']);
  const outl = program(gl, OVS, OFS, ['uView', 'uProj', 'uCam', 'uFogNear', 'uFogFar', 'uWidth', 'uPx', 'uColor', 'uTone', 'uFogColor']);
  const shad = program(gl, SVS, SFS, ['uView', 'uProj', 'uCam', 'uFogNear', 'uFogFar']);

  const G = {
    gl, canvas, width: canvas.width, height: canvas.height,
    view: identity(new Float32Array(16)), proj: identity(new Float32Array(16)),
    camPos: new Float32Array([0, 50, 100]),
    sunDir: new Float32Array([0.42, 0.78, 0.46]),
    sunColor: new Float32Array([0.78, 0.72, 0.6]),
    skyColor: new Float32Array([0.5, 0.58, 0.72]),
    groundColor: new Float32Array([0.34, 0.32, 0.26]),
    fogColor: new Float32Array([0.72, 0.83, 0.93]),
    fogNear: 140, fogFar: 420,
    clearColor: new Float32Array([0.72, 0.83, 0.93]),
    cull: false,
    outlinePxMin: 1.2, outlinePxMax: 4.0,   // screen-space clamp of outline thickness (pixels)
    projScale: 0,                            // optional override: viewportH/(2*tan(fov/2)); default derived from G.proj
    info: { calls: 0, triangles: 0, instances: 0 },
    meshes: [], shadows: [],
  };
  { const l = Math.hypot(G.sunDir[0], G.sunDir[1], G.sunDir[2]); G.sunDir[0] /= l; G.sunDir[1] /= l; G.sunDir[2] /= l; }

  G.resize = function () {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.floor((canvas.clientWidth || canvas.width) * dpr));
    const h = Math.max(1, Math.floor((canvas.clientHeight || canvas.height) * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    G.width = canvas.width; G.height = canvas.height;
    return G;
  };

  G.createMesh = function (geo, capacity, opts) {
    capacity = Math.max(1, capacity | 0);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    // interleaved static geometry: pos(3) nrm(3) col(3) fix(1)
    const n = geo.count, data = new Float32Array(n * 10), fix = geo.fix;
    for (let i = 0; i < n; i++) {
      const o = i * 10, s = i * 3;
      data[o] = geo.pos[s]; data[o+1] = geo.pos[s+1]; data[o+2] = geo.pos[s+2];
      data[o+3] = geo.nrm[s]; data[o+4] = geo.nrm[s+1]; data[o+5] = geo.nrm[s+2];
      data[o+6] = geo.col[s]; data[o+7] = geo.col[s+1]; data[o+8] = geo.col[s+2];
      data[o+9] = fix ? fix[i] : 0;
    }
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    for (let k = 0; k < 3; k++) { gl.enableVertexAttribArray(k); gl.vertexAttribPointer(k, 3, gl.FLOAT, false, 40, k * 12); }
    gl.enableVertexAttribArray(9); gl.vertexAttribPointer(9, 1, gl.FLOAT, false, 40, 36);
    // instance matrices
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ARRAY_BUFFER, capacity * 64, gl.DYNAMIC_DRAW);
    for (let k = 0; k < 4; k++) {
      gl.enableVertexAttribArray(3 + k);
      gl.vertexAttribPointer(3 + k, 4, gl.FLOAT, false, 64, k * 16);
      gl.vertexAttribDivisor(3 + k, 1);
    }
    // instance tint
    const tbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, tbo);
    gl.bufferData(gl.ARRAY_BUFFER, capacity * 12, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(7);
    gl.vertexAttribPointer(7, 3, gl.FLOAT, false, 12, 0);
    gl.vertexAttribDivisor(7, 1);
    // smooth normals for the outline hull (only when requested)
    let sbo = null;
    const ow = opts && opts.outline ? (opts.outline === true ? 0.03 : Math.max(0, +opts.outline || 0)) : 0;
    if (ow > 0) {
      sbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, sbo);
      gl.bufferData(gl.ARRAY_BUFFER, smoothNormals(geo), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(8);
      gl.vertexAttribPointer(8, 3, gl.FLOAT, false, 12, 0);
    }
    gl.bindVertexArray(null);

    const M = {
      vao, vbo, ibo, tbo, sbo, capacity, vertexCount: n,
      outline: ow, outlineColor: (opts && opts.outlineColor) ? Float32Array.from(opts.outlineColor) : new Float32Array([0.09, 0.07, 0.06]),
      inst: new Float32Array(capacity * 16), tint: new Float32Array(capacity * 3).fill(1),
      count: 0, visible: true,
      // grow the instance capacity (callers pass a power of two); keeps the first `count` instances. The VAO keeps pointing at the same buffer objects.
      grow(newCap, live) {
        if (newCap <= M.capacity) return;
        const oi = M.inst, ot = M.tint, keep = Math.min(live == null ? M.count : live, M.capacity);
        M.inst = new Float32Array(newCap * 16); M.tint = new Float32Array(newCap * 3).fill(1);
        M.inst.set(oi.subarray(0, keep * 16)); M.tint.set(ot.subarray(0, keep * 3));
        gl.bindBuffer(gl.ARRAY_BUFFER, ibo); gl.bufferData(gl.ARRAY_BUFFER, newCap * 64, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, tbo); gl.bufferData(gl.ARRAY_BUFFER, newCap * 12, gl.DYNAMIC_DRAW);
        M.capacity = newCap;
      },
      upload() {
        const c = Math.min(M.count, M.capacity);
        if (c <= 0) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, ibo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, M.inst, 0, c * 16);
        gl.bindBuffer(gl.ARRAY_BUFFER, tbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, M.tint, 0, c * 3);
      },
    };
    for (let i = 0; i < capacity; i++) M.inst[i * 16] = M.inst[i * 16 + 5] = M.inst[i * 16 + 10] = M.inst[i * 16 + 15] = 1;
    G.meshes.push(M);
    return M;
  };

  G.createStaticMesh = function (geo, opts) {
    const M = G.createMesh(geo, 1, opts);
    identity(M.inst); M.count = 1; M.upload();
    return M;
  };

  // blob shadows: S.data = (x, z, radius) per instance
  const FAN = 16;
  const fan = new Float32Array(FAN * 3 * 2);
  for (let i = 0; i < FAN; i++) {
    const a0 = i / FAN * Math.PI * 2, a1 = (i + 1) / FAN * Math.PI * 2, o = i * 6;
    fan[o] = 0; fan[o+1] = 0;
    fan[o+2] = Math.sin(a0); fan[o+3] = Math.cos(a0);
    fan[o+4] = Math.sin(a1); fan[o+5] = Math.cos(a1);
  }
  const fanBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, fanBuf);
  gl.bufferData(gl.ARRAY_BUFFER, fan, gl.STATIC_DRAW);

  G.createShadowMesh = function (capacity) {
    capacity = Math.max(1, capacity | 0);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, fanBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    const dbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, dbo);
    gl.bufferData(gl.ARRAY_BUFFER, capacity * 12, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 12, 0); gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    const S = {
      vao, dbo, capacity, data: new Float32Array(capacity * 3), count: 0, visible: true,
      grow(newCap, live) {
        if (newCap <= S.capacity) return;
        const od = S.data, keep = Math.min(live == null ? S.count : live, S.capacity);
        S.data = new Float32Array(newCap * 3); S.data.set(od.subarray(0, keep * 3));
        gl.bindBuffer(gl.ARRAY_BUFFER, dbo); gl.bufferData(gl.ARRAY_BUFFER, newCap * 12, gl.DYNAMIC_DRAW);
        S.capacity = newCap;
      },
      upload() {
        const c = Math.min(S.count, S.capacity);
        if (c <= 0) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, dbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, S.data, 0, c * 3);
      },
    };
    G.shadows.push(S);
    return S;
  };

  G.render = function () {
    const info = G.info; info.calls = 0; info.triangles = 0; info.instances = 0;
    gl.viewport(0, 0, G.width, G.height);
    gl.clearColor(G.clearColor[0], G.clearColor[1], G.clearColor[2], 1);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    if (G.cull) { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); } else gl.disable(gl.CULL_FACE);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(main.p);
    let u = main.u;
    gl.uniformMatrix4fv(u.uView, false, G.view);
    gl.uniformMatrix4fv(u.uProj, false, G.proj);
    gl.uniform3fv(u.uCam, G.camPos);
    gl.uniform1f(u.uFogNear, G.fogNear); gl.uniform1f(u.uFogFar, G.fogFar);
    gl.uniform3fv(u.uSunDir, G.sunDir); gl.uniform3fv(u.uSunColor, G.sunColor);
    gl.uniform3fv(u.uSky, G.skyColor); gl.uniform3fv(u.uGround, G.groundColor);
    gl.uniform3fv(u.uFogColor, G.fogColor);
    gl.useProgram(outl.p);
    gl.uniformMatrix4fv(outl.u.uView, false, G.view);
    gl.uniformMatrix4fv(outl.u.uProj, false, G.proj);
    gl.uniform3fv(outl.u.uCam, G.camPos);
    gl.uniform1f(outl.u.uFogNear, G.fogNear); gl.uniform1f(outl.u.uFogFar, G.fogFar);
    gl.uniform3fv(outl.u.uFogColor, G.fogColor);
    gl.uniform3f(outl.u.uPx, G.projScale || (G.height * 0.5 * (G.proj[5] || 1)), G.outlinePxMin, G.outlinePxMax);
    { const lum = (G.skyColor[0] + G.skyColor[1] + G.skyColor[2] + G.groundColor[0] + G.groundColor[1] + G.groundColor[2]) / 6 + (G.sunColor[0] + G.sunColor[1] + G.sunColor[2]) / 3 * 0.5;
      gl.uniform1f(outl.u.uTone, Math.max(0.12, Math.min(1, lum * 2.2))); }   // outline darkens with the scene at night
    gl.useProgram(main.p);
    const ms = G.meshes;
    for (let i = 0; i < ms.length; i++) {
      const M = ms[i];
      if (!M.visible || M.count <= 0) continue;
      const c = M.count < M.capacity ? M.count : M.capacity;
      gl.bindVertexArray(M.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, M.vertexCount, c);
      info.calls++; info.instances += c; info.triangles += (M.vertexCount / 3 | 0) * c;
      if (M.outline > 0 && M.sbo) {
        gl.useProgram(outl.p);
        gl.disable(gl.CULL_FACE);   // back-face selection done in the fragment shader (gl_FrontFacing xor mirrored)
        gl.uniform1f(outl.u.uWidth, M.outline);
        gl.uniform3fv(outl.u.uColor, M.outlineColor);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, M.vertexCount, c);
        info.calls++; info.triangles += (M.vertexCount / 3 | 0) * c;
        gl.useProgram(main.p);
        if (G.cull) gl.enable(gl.CULL_FACE);
      }
    }

    if (G.shadows.length) {
      gl.useProgram(shad.p);
      u = shad.u;
      gl.uniformMatrix4fv(u.uView, false, G.view);
      gl.uniformMatrix4fv(u.uProj, false, G.proj);
      gl.uniform3fv(u.uCam, G.camPos);
      gl.uniform1f(u.uFogNear, G.fogNear); gl.uniform1f(u.uFogFar, G.fogFar);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      for (let i = 0; i < G.shadows.length; i++) {
        const S = G.shadows[i];
        if (!S.visible || S.count <= 0) continue;
        const c = S.count < S.capacity ? S.count : S.capacity;
        gl.bindVertexArray(S.vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, FAN * 3, c);
        info.calls++; info.instances += c; info.triangles += FAN * c;
      }
      gl.depthMask(true); gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
  };

  return G;
}
