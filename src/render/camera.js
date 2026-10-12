// Orbit camera: left-drag orbit, right/middle-drag or WASD/arrows pan, wheel/pinch zoom. Writes G.view/G.proj/G.camPos.
import { perspective, lookAt } from './mat4.js';
import { WORLD } from '../config.js';

const HOME = { yaw: 0.6, pitch: 0.75, dist: 190, tx: 0, tz: 0 };
const MIN_D = 10, MAX_D = 350, MIN_P = 0.12, MAX_P = 1.5, LIMX = WORLD.x1 - 6, LIMZ = WORLD.z1 - 6;

export function createOrbit(canvas, G) {
  const cam = {
    target: new Float32Array([0, 0, 0]), distance: HOME.dist,
    yaw: HOME.yaw, pitch: HOME.pitch,
    update, reset, set,
  };
  let yaw = cam.yaw, pitch = cam.pitch, dist = cam.distance, tx = 0, tz = 0;       // smoothed
  let gYaw = yaw, gPitch = pitch, gDist = dist, gTx = 0, gTz = 0;                  // goals
  const keys = Object.create(null);
  const ptrs = new Map();
  let pinchD = 0, pinchX = 0, pinchY = 0;

  function reset() { gYaw = HOME.yaw; gPitch = HOME.pitch; gDist = HOME.dist; gTx = HOME.tx; gTz = HOME.tz; }
  // QA/automation: jump the camera (no smoothing)
  function set(y, p, d, x, z) {
    gYaw = yaw = y; gPitch = pitch = p; gDist = dist = d; gTx = tx = x; gTz = tz = z; clampGoals();
    gYaw = yaw; gPitch = pitch = gPitch; gDist = dist = gDist; gTx = tx = gTx; gTz = tz = gTz;
  }
  function clampGoals() {
    gPitch = Math.min(MAX_P, Math.max(MIN_P, gPitch));
    gDist = Math.min(MAX_D, Math.max(MIN_D, gDist));
    gTx = Math.min(LIMX, Math.max(-LIMX, gTx)); gTz = Math.min(LIMZ, Math.max(-LIMZ, gTz));
  }
  function pan(dx, dz) { // dx right, dz forward in screen-ground space
    const s = Math.sin(gYaw), c = Math.cos(gYaw);
    // camera looks along -(sin yaw, cos yaw) horizontally: forward = (-s,-c), right = (c,-s)
    gTx += dx * c - dz * s; gTz += -dx * s - dz * c;
  }

  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('pointerdown', e => {
    canvas.focus && canvas.focus();
    canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, btn: e.button, shift: e.shiftKey });
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinchD = Math.hypot(a.x - b.x, a.y - b.y); pinchX = (a.x + b.x) / 2; pinchY = (a.y + b.y) / 2; }
  });
  const end = e => { ptrs.delete(e.pointerId); };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointermove', e => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 1) {
      if (p.btn === 0 && !p.shift) { gYaw -= dx * 0.006; gPitch += dy * 0.005; }
      else { const k = gDist * 0.0016; pan(-dx * k, dy * k); }
    } else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (pinchD > 0 && d > 0) gDist *= pinchD / d;
      const k = gDist * 0.0016; pan(-(mx - pinchX) * k, (my - pinchY) * k);
      pinchD = d; pinchX = mx; pinchY = my;
    }
    clampGoals();
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    gDist *= Math.exp(Math.max(-300, Math.min(300, e.deltaY)) * 0.0012);
    clampGoals();
  }, { passive: false });
  const isField = e => e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox';
  window.addEventListener('keydown', e => { if (!isField(e)) keys[e.code] = true; });
  window.addEventListener('keyup', e => { keys[e.code] = false; });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

  function update(dt) {
    if (dt > 0.1) dt = 0.1;
    const spd = gDist * 0.9 * dt * (keys.ShiftLeft || keys.ShiftRight ? 2.5 : 1);
    let fx = 0, fz = 0;
    if (keys.KeyW || keys.ArrowUp) fz += 1;
    if (keys.KeyS || keys.ArrowDown) fz -= 1;
    if (keys.KeyD || keys.ArrowRight) fx += 1;
    if (keys.KeyA || keys.ArrowLeft) fx -= 1;
    if (fx || fz) pan(fx * spd, fz * spd);
    if (keys.KeyQ) gYaw += dt * 1.5;
    if (keys.KeyE) gYaw -= dt * 1.5;
    clampGoals();
    const k = 1 - Math.exp(-dt * 12);
    yaw += (gYaw - yaw) * k; pitch += (gPitch - pitch) * k; dist += (gDist - dist) * k;
    tx += (gTx - tx) * k; tz += (gTz - tz) * k;
    cam.yaw = yaw; cam.pitch = pitch; cam.distance = dist; cam.target[0] = tx; cam.target[2] = tz;
    const cp = Math.cos(pitch);
    const ex = tx + Math.sin(yaw) * cp * dist, ey = Math.max(1.5, Math.sin(pitch) * dist), ez = tz + Math.cos(yaw) * cp * dist;
    const aspect = G.width / Math.max(1, G.height);
    perspective(G.proj, 0.9, aspect, Math.max(0.5, dist * 0.02), 900);
    lookAt(G.view, ex, ey, ez, tx, 0, tz);
    G.camPos[0] = ex; G.camPos[1] = ey; G.camPos[2] = ez;
  }
  canvas.tabIndex = 0;
  update(0);
  return cam;
}
