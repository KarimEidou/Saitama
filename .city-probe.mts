import { chromium } from 'playwright';
import { build } from 'vite';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = '/home/user/Saitama';
const BUILD_DIR = '/tmp/saitama-city-probe';

await build({
  root: ROOT,
  configFile: path.join(ROOT, 'vite.config.ts'),
  logLevel: 'warn',
  build: {
    outDir: BUILD_DIR,
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: { cityHarness: path.join(ROOT, 'harness', 'city.html') } },
  },
  publicDir: false,
} as never);

const MOUNTS: [string, string][] = [
  ['/game-assets', path.join(ROOT, 'public', 'assets')],
  ['/basis', path.join(ROOT, 'node_modules/three/examples/jsm/libs/basis')],
  ['/draco', path.join(ROOT, 'node_modules/three/examples/jsm/libs/draco/gltf')],
];
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ktx2': 'image/ktx2',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let p = url.pathname;
  let file = path.join(BUILD_DIR, p);
  for (const [prefix, dir] of MOUNTS) {
    if (p === prefix || p.startsWith(prefix + '/')) file = path.join(dir, p.slice(prefix.length));
  }
  if (!existsSync(file)) {
    console.log('404', p);
    res.writeHead(404).end('nope');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(await readFile(file));
});
await new Promise<void>((r) => server.listen(4599, '127.0.0.1', () => r()));

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 300)));
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 400)));
page.on('requestfailed', (r) => console.log('[reqfail]', r.url().slice(-70), r.failure()?.errorText));
await page.goto('http://127.0.0.1:4599/harness/city.html', { waitUntil: 'load', timeout: 120000 });
try {
  await page.waitForFunction(() => (window as never as { __CITY_HARNESS__?: { ready: boolean } }).__CITY_HARNESS__?.ready === true, undefined, { timeout: 150000 });
  console.log('READY');
  console.log(JSON.stringify(await page.evaluate(() => (window as never as { __CITY_HARNESS__: { stats(): unknown } }).__CITY_HARNESS__.stats())).slice(0, 900));
} catch (e) {
  console.log('TIMEOUT', (e as Error).message.slice(0, 200));
}
await browser.close();
server.close();
process.exit(0);
