// End-to-end smoke test: serves the app, loads it in headless Chromium (SwiftShader) and asserts on window.__farm.
import { chromium } from '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = process.env.FARM_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8795;
mkdirSync(path.join(root, 'tests/out'), { recursive: true });
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const failures = [];
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures.push(msg); };
const stats = page => page.evaluate(() => window.__farm.getStats());

try {
  await sleep(900);
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(600000);
  const problems = [];
  page.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);

  let ready = false;
  try { await page.waitForFunction(() => window.__farm && window.__farm.ready === true, null, { timeout: 30000 }); ready = true; } catch (_) {}
  const err = await page.evaluate(() => window.__farm ? window.__farm.error : 'no __farm');
  check(ready, 'ready within 30 s');
  check(!err, 'no runtime error' + (err ? ': ' + String(err).slice(0, 400) : ''));
  if (ready) {
    let s = await stats(page);
    check(s.animals === 3000, `animals == 3000 (${s.animals})`);
    check(s.farmers >= 40, `farmers >= 40 (${s.farmers})`);
    check(s.speciesCounts.length === 20, `20 species (${s.speciesCounts.length})`);
    check(s.speciesCounts.every(c => c > 0), `all 20 species present (${s.speciesCounts.join(',')})`);
    check(s.drawCalls > 0 && s.drawCalls < 80, `0 < drawCalls < 80 (${s.drawCalls})`);
    const f0 = s.frames; await sleep(3000); s = await stats(page);
    check(s.frames > f0, `frames advance (${f0} -> ${s.frames})`);
    console.log(`fps (informational, SwiftShader): ${s.fps.toFixed(1)} frameMs ${s.frameMs.toFixed(1)}`);
    // fps sample: count frames over 5 s
    const a = (await stats(page)).frames; await sleep(5000); const b = (await stats(page)).frames;
    console.log(`fps sample over 5 s: ${((b - a) / 5).toFixed(1)}`);
    await page.screenshot({ path: path.join(root, 'tests/out/shot.png') });

    await page.evaluate(() => window.__farm.setAnimalCount(5000));
    await page.waitForTimeout(1500);
    s = await stats(page);
    check(s.animals === 5000, `animals == 5000 (${s.animals})`);
    check(s.animalsOutOfPen === 0, `animalsOutOfPen == 0 (${s.animalsOutOfPen})`);
    check(s.nanCount === 0, `nanCount == 0 (${s.nanCount})`);
    await page.screenshot({ path: path.join(root, 'tests/out/shot5000.png') });

    await page.evaluate(() => { window.__farm.setAnimalCount(3000); window.__farm.pause(); });
    const t0 = Date.now();
    await page.evaluate(() => window.__farm.stepSim(300));
    console.log(`stepSim(300) took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    s = await stats(page);
    console.log('tasksCreated', s.tasksCreated.join(','), 'tasksDone', s.tasksDone.join(','), 'delivered', s.delivered.join(','));
    check(s.tasksDone[0] > 0, `tasksDone[FEED] > 0 (${s.tasksDone[0]})`);
    check(s.tasksDone[2] > 0, `tasksDone[COLLECT_EGGS] > 0 (${s.tasksDone[2]})`);
    check(s.tasksDone[5] > 0, `tasksDone[CLEAN] > 0 (${s.tasksDone[5]})`);
    check(s.nanCount === 0 && s.animalsOutOfPen === 0, `after 300 s: nan ${s.nanCount}, out-of-pen ${s.animalsOutOfPen}`);
    // trucks: goods delivered by farmers get shipped by a truck visit within ~5-8 sim minutes
    if (s.trucksVisited < 1) { await page.evaluate(() => window.__farm.stepSim(240)); s = await stats(page); }
    console.log('trucks', s.trucks, 'visited', s.trucksVisited, 'shipped', s.shipped.join(','), 'stock', s.truckStock.join(','));
    check(s.trucksVisited >= 1, `trucksVisited >= 1 (${s.trucksVisited})`);
    check(s.shipped[0] + s.shipped[1] + s.shipped[2] > 0, 'goods shipped by trucks');
    console.log('farmerLoads', s.farmerLoads, 'goods', s.farmerLoadGoods, 'autoLoads', s.autoLoads);
    check(s.farmerLoads > 0, `farmers loaded trucks (farmerLoads ${s.farmerLoads})`);
    check(s.nanCount === 0, `still no NaN after trucks (${s.nanCount})`);
    await page.evaluate(() => window.__farm.resume());
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(root, 'tests/out/shot_after.png') });
    check(!(await page.evaluate(() => window.__farm.error)), 'no runtime error at end');
    console.log('final stats:', JSON.stringify(await stats(page)));
  }
  const bad = problems.filter(p => !/GPU stall|swiftshader|GroupMarker/i.test(p));
  if (bad.length) console.log('console problems:\n' + bad.join('\n'));
  check(bad.length === 0, 'no console errors');
  await browser.close();
} catch (e) { console.error(e); failures.push('exception: ' + e.message); }
finally { server.kill(); }
console.log(failures.length ? `SMOKE FAILED (${failures.length})` : 'SMOKE PASSED');
process.exit(failures.length ? 1 : 0);
