import { chromium } from '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8821;
mkdirSync('/tmp/outline', { recursive: true });
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = false;
try {
  await sleep(800);
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
  const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${PORT}/tests/outline_check.html`);
  await page.waitForFunction(() => window.__oc && window.__oc.done, null, { timeout: 60000 });
  const res = await page.evaluate(() => window.__oc);
  // the page ends with the 5000-instance mesh hidden, so the screenshot shows the clean scene
  await page.screenshot({ path: '/tmp/outline/outline.png' });
  console.log('result:', JSON.stringify(res));
  if (problems.length) console.log('console problems:\n' + problems.join('\n'));
  if (res.error || problems.some(p => !/GPU stall|swiftshader/i.test(p))) failed = true;
  await browser.close();
} catch (e) { console.error(e); failed = true; }
finally { server.kill(); }
console.log(failed ? 'OUTLINE CHECK FAILED' : 'OUTLINE CHECK PASSED');
process.exit(failed ? 1 : 0);
