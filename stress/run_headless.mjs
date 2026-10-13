// STRESS HARNESS (temporary): plumbing check in headless Chromium (SwiftShader). Its fps numbers mean nothing;
// the real run is stress/index.html on a real GPU. Usage: node stress/run_headless.mjs [query]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const { chromium } = createRequire(import.meta.url)(execSync('npm root -g').toString().trim() + '/playwright');
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8796;
const query = process.argv[2] || 'phases=combined,farmers&a0=500&aStep=500&aRes=250&f0=100&fStep=100&fRes=50&fixedA=500&ratio=5&target=20&near=25&warm=0.5&settle=0.3&measure=1&cams=overview,orbit&maxSteps=6&autostart=1';
const server = spawn('python3', [path.join(root, 'stress/serve.py'), String(PORT)], { stdio: 'inherit' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  await sleep(800);
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', e => console.log('pageerror', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('console.error', m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/stress/?${query}`);
  await page.waitForFunction(() => window.__stress && window.__stress.done, null, { timeout: 900000, polling: 1000 });
  const r = await page.evaluate(() => ({ result: window.__stress.result, saved: window.__stress.saved, log: window.__stress.log }));
  console.log(r.log.join('\n'));
  console.log('saved:', r.saved);
  for (const p of r.result.phases || []) console.log(p.phase, 'lastPass', JSON.stringify(p.lastPass), 'firstFail', JSON.stringify(p.firstFail));
  if (r.result.error) console.log('ERROR', r.result.error);
  await page.screenshot({ path: path.join(root, 'stress/results/headless.png') });
  await browser.close();
} finally { server.kill(); }
