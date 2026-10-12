import { chromium } from '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8791;
mkdirSync(path.join(root, 'tests/out'), { recursive: true });
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = false;
try {
  await sleep(800);
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${PORT}/tests/gl_check.html`);
  await page.waitForFunction(() => window.__glcheck && window.__glcheck.done, null, { timeout: 15000 });
  const res = await page.evaluate(() => window.__glcheck);
  await page.screenshot({ path: path.join(root, 'tests/out/gl_check.png') });
  console.log('result:', JSON.stringify(res));
  if (problems.length) console.log('console problems:\n' + problems.join('\n'));
  if (res.error || problems.some(p => !/GPU stall|swiftshader/i.test(p))) failed = true;
  // pixel sanity: centre column not all background
  await browser.close();
} catch (e) { console.error(e); failed = true; }
finally { server.kill(); }
console.log(failed ? 'GL CHECK FAILED' : 'GL CHECK PASSED');
process.exit(failed ? 1 : 0);
