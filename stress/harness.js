// STRESS HARNESS (temporary). Ramps animal / farmer counts, drives the camera through fixed shots, measures frame
// rate on the real browser + GPU, and keeps going until the frame rate drops below the target (default 30 fps).
// Results: on-screen table, window.__stress.result, a JSON download, and a POST to /__stress_result when the page is
// served by stress/serve.py (that server writes stress/results/<run>.json).
//
// URL params (all optional):
//   phases=combined,animals,farmers   which ramps to run, in order
//   ratio=5         combined ramp: animals per farmer (10k animals : 2k farmers)
//   a0=10000 f0=2000                   start counts
//   aStep=10000 fStep=2000             coarse increments (halved once fps < near)
//   aRes=1000 fRes=250                 bisection resolution once a step fails
//   fixedF=200 fixedA=10000            the held count in the single-axis ramps
//   target=30 near=45                  fail threshold / "getting close" threshold (fps)
//   warm=3 settle=1.5 measure=4        seconds: after a count change / after a camera move / measured per shot
//   cams=overview,close,low,orbit      camera shots measured at every step (worst shot decides pass/fail)
//   lod=on|off      adaptive LOD (on = what a player gets)
//   maxSteps=40     safety stop per phase
//   autostart=1     start without clicking
const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) ? +q.get(k) : d);
const P = {
  phases: (q.get('phases') || 'combined,animals,farmers').split(',').filter(Boolean),
  ratio: num('ratio', 5),
  a0: num('a0', 10000), f0: num('f0', 2000), aStep: num('aStep', 10000), fStep: num('fStep', 2000),
  aRes: num('aRes', 1000), fRes: num('fRes', 250), fixedF: num('fixedF', 200), fixedA: num('fixedA', 10000),
  target: num('target', 30), near: num('near', 45),
  warm: num('warm', 3), settle: num('settle', 1.5), measure: num('measure', 4),
  cams: (q.get('cams') || 'overview,close,low,orbit').split(',').filter(Boolean),
  lod: q.get('lod') !== 'off', maxSteps: num('maxSteps', 40), autostart: q.get('autostart') === '1',
  capA: window.__FARM_CAPS.animals, capF: window.__FARM_CAPS.farmers,
};
// yaw, pitch, dist, target x, target z. close = pen 1 (chickens); low = whole farm at a shallow angle (most units in view).
const CAMS = {
  overview: { set: [0.6, 0.75, 190, 0, 0] },
  close: { set: [0.6, 0.6, 40, -100, -36] },
  low: { set: [0.6, 0.25, 240, 0, 0] },
  orbit: { set: [0, 0.5, 130, 0, 0], orbit: 0.6 },   // yaw sweeps at 0.6 rad/s while measuring
};

const box = document.getElementById('stress');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const state = { running: false, log: [], rows: [], result: null };
window.__stress = state;

function log(msg) { state.log.push(`[${(performance.now() / 1000).toFixed(1)}s] ${msg}`); render(msg); }

async function waitReady() {
  while (!(window.__farm && window.__farm.ready)) await sleep(100);
  if (window.__farm.error) throw new Error(window.__farm.error);
}

// Sample frames for `sec` seconds; optional per-frame camera hook. Pauses the clock while the tab is hidden.
function sample(sec, onFrame) {
  return new Promise(resolve => {
    const farm = window.__farm, s = farm.stats;
    const dts = [], sim = [], ren = [], steps = [];
    let tris = 0, calls = 0, lod = 0, n = 0, last = 0, elapsed = 0, hiddenGaps = 0;
    function f(now) {
      if (last) {
        const dt = now - last;
        if (document.hidden || dt > 1000) hiddenGaps++;
        else {
          elapsed += dt; dts.push(dt); sim.push(s.simMs || 0); ren.push(s.renderMs || 0); steps.push(s.simSteps || 0);
          tris += s.triangles; calls += s.drawCalls; lod += farm.units ? farm.units.lodDist : 0; n++;
        }
      }
      last = now;
      if (onFrame) onFrame(elapsed / 1000);
      if (elapsed >= sec * 1000) {
        const sorted = dts.slice().sort((a, b) => a - b), pct = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
        const avg = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
        const worst1 = sorted.slice(Math.floor(sorted.length * 0.99));
        resolve({
          fps: +(1000 * n / elapsed).toFixed(1),
          medianFps: +(1000 / pct(0.5)).toFixed(1),
          low1Fps: +(1000 / avg(worst1)).toFixed(1),
          frameMsP50: +pct(0.5).toFixed(2), frameMsP95: +pct(0.95).toFixed(2),
          simMs: +avg(sim).toFixed(2), renderCpuMs: +avg(ren).toFixed(2), simStepsPerFrame: +avg(steps).toFixed(2),
          triangles: Math.round(tris / n), drawCalls: Math.round(calls / n), lodDist: +(lod / n).toFixed(1),
          frames: n, hiddenGaps,
        });
      } else requestAnimationFrame(f);
    }
    requestAnimationFrame(f);
  });
}

async function measureStep(animals, farmers) {
  const farm = window.__farm;
  farm.setAnimalCount(animals); farm.setFarmerCount(farmers);
  const got = farm.getStats();
  await sleep(P.warm * 1000);
  const shots = {};
  for (const name of P.cams) {
    const c = CAMS[name]; if (!c) continue;
    farm.setCamera(...c.set);
    await sleep(P.settle * 1000);
    const y0 = c.set[0];
    shots[name] = await sample(P.measure, c.orbit ? t => farm.setCamera(y0 + t * c.orbit, c.set[1], c.set[2], c.set[3], c.set[4]) : null);
  }
  let worst = null;
  for (const k in shots) if (!worst || shots[k].fps < shots[worst].fps) worst = k;
  const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
  return { animals: got.animals, farmers: got.farmers, requested: { animals, farmers }, worstCam: worst, worstFps: shots[worst].fps, pass: shots[worst].fps >= P.target, heapMB: mem, shots };
}

// One phase: coarse ramp (step halves once fps < near), then bisect between the last pass and the first fail.
async function runPhase(name) {
  const at = {
    combined: x => [x, Math.round(x / P.ratio)],
    animals: x => [x, P.fixedF],
    farmers: x => [P.fixedA, x],
  }[name];
  if (!at) { log(`unknown phase ${name}`); return null; }
  const isF = name === 'farmers';
  let x = isF ? P.f0 : P.a0, step = isF ? P.fStep : P.aStep;
  const res = isF ? P.fRes : P.aRes, cap = isF ? P.capF : P.capA;
  const rows = [];
  let pass = null, fail = null, n = 0;
  const run = async (v, kind) => {
    const [a, f] = at(v);
    log(`${name}: ${a} animals / ${f} farmers (${kind})`);
    const r = await measureStep(a, f);
    r.phase = name; r.kind = kind; r.x = v;
    rows.push(r); state.rows.push(r); render();
    return r;
  };
  while (n++ < P.maxSteps && x <= cap) {
    const r = await run(x, 'ramp');
    if (!r.pass) { fail = x; break; }
    pass = x;
    if (r.worstFps < P.near && step > res) step = Math.max(res, Math.round(step / 2 / res) * res);
    x += step;
  }
  if (pass === null && fail !== null) pass = 0;   // the very first step failed: bisect down toward zero
  while (fail !== null && fail - pass > res && n++ < P.maxSteps) {
    const mid = Math.round((pass + fail) / 2 / res) * res;
    if (mid <= pass || mid >= fail) break;
    const r = await run(mid, 'bisect');
    if (r.pass) pass = mid; else fail = mid;
  }
  const lastPass = rows.filter(r => r.pass).sort((a, b) => b.x - a.x)[0] || null;
  const firstFail = rows.filter(r => !r.pass).sort((a, b) => a.x - b.x)[0] || null;
  return {
    phase: name, limitFound: !!firstFail, hitCap: !firstFail && x > cap,
    lastPass: lastPass && { animals: lastPass.animals, farmers: lastPass.farmers, worstFps: lastPass.worstFps, worstCam: lastPass.worstCam },
    firstFail: firstFail && { animals: firstFail.animals, farmers: firstFail.farmers, worstFps: firstFail.worstFps, worstCam: firstFail.worstCam },
    steps: rows,
  };
}

function env() {
  let gpu = null;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    gpu = gl && (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch (_) { /* ignore */ }
  const c = document.getElementById('c');
  return { userAgent: navigator.userAgent, gpu, cores: navigator.hardwareConcurrency, dpr: devicePixelRatio,
    canvas: [c.width, c.height], viewport: [innerWidth, innerHeight] };
}

async function start() {
  if (state.running) return;
  state.running = true; state.rows = [];
  try {
    await waitReady();
    const farm = window.__farm;
    if (farm.units) farm.units.adaptive = P.lod;
    farm.setSpeed(1); farm.resume(); farm.setHour(12);
    // Hide the app HUD so it does not cost frame time or cover the table.
    const hud = document.getElementById('hud'); if (hud) hud.style.display = 'none';
    // Baseline: refresh rate of the display at the default load.
    farm.setAnimalCount(3000); farm.setFarmerCount(40); farm.setCamera(...CAMS.overview.set);
    await sleep(2000);
    const baseline = await sample(3);
    log(`baseline (3000 / 40, overview): ${baseline.fps} fps`);
    const t0 = new Date();
    const phases = [];
    for (const ph of P.phases) phases.push(await runPhase(ph));
    state.result = { harness: 'FarmSim stress harness (temporary)', startedAt: t0.toISOString(), finishedAt: new Date().toISOString(),
      params: P, env: env(), baseline, phases };
    log('done');
    await save();
  } catch (e) {
    log('ERROR ' + (e && (e.stack || e.message) || e));
    state.result = { error: String(e && (e.stack || e.message) || e), rows: state.rows, params: P };
    await save();
  }
  state.running = false; state.done = true; render();
}

async function save() {
  try {
    const r = await fetch('/__stress_result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.result, null, 2) });
    state.saved = r.ok ? await r.text() : null;
    if (state.saved) log('saved ' + state.saved);
  } catch (_) { /* plain serve.py: use the download button */ }
}

function download() {
  const blob = new Blob([JSON.stringify(state.result || { rows: state.rows }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'farmsim-stress.json'; a.click();
}

function render(status) {
  const rows = state.rows.map(r => {
    const cams = P.cams.map(c => (r.shots[c] ? r.shots[c].fps : '')).map(v => `<td>${v}</td>`).join('');
    const sh = r.shots[r.worstCam];
    return `<tr class="${r.pass ? 'pass' : 'fail'}"><td style="text-align:left">${r.phase}</td><td>${r.animals}</td><td>${r.farmers}</td>${cams}`
      + `<td>${sh.simMs}</td><td>${sh.renderCpuMs}</td><td>${(sh.triangles / 1e6).toFixed(2)}M</td><td>${r.pass ? 'ok' : '&lt;' + P.target}</td></tr>`;
  }).join('');
  box.innerHTML = `<b>FarmSim stress harness</b> (temporary) · target ${P.target} fps · LOD ${P.lod ? 'adaptive' : 'fixed'}<br>`
    + `${state.running ? 'running: ' : ''}${status || state.log[state.log.length - 1] || ''}<br>`
    + `<button id="s-go"${state.running ? ' disabled' : ''}>Start</button><button id="s-dl">Download JSON</button>`
    + `<table><tr><th style="text-align:left">phase</th><th>animals</th><th>farmers</th>${P.cams.map(c => `<th>${c}</th>`).join('')}`
    + `<th>sim ms</th><th>render cpu ms</th><th>tris</th><th></th></tr>${rows}</table>`
    + `<div style="opacity:.7;margin-top:4px">fps per camera shot; sim / render / tris from the worst shot. Keep this tab visible.</div>`;
  box.querySelector('#s-go').onclick = start;
  box.querySelector('#s-dl').onclick = download;
}

render('ready, press Start' + (P.autostart ? ' (autostart)' : ''));
if (P.autostart) start();
