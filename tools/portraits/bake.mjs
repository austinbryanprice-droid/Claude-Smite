// Bakes the title screen's god face cards into public/portraits/<god>.jpg.
// Renders each god with the `?showcase=<god>&view=bust` dev view in headless
// Chromium (WebGL 2, the software GPU path that works on CI boxes).
//
//   npm run build && npx vite preview --port 4173 &
//   node tools/portraits/bake.mjs [http://localhost:4173] [zeus,thor,...]
//
// Needs Playwright with Chromium. Re-run after god model changes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// CommonJS resolution so a globally installed Playwright (NODE_PATH) works too
const { chromium } = createRequire(import.meta.url)('playwright');

const base = process.argv[2] ?? 'http://localhost:4173';
const gods = (process.argv[3] ?? 'zeus,thor,odin,loki,anubis').split(',');
const out = new URL('../../public/portraits/', import.meta.url);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--disable-gpu-watchdog'] });
for (const god of gods) {
  const page = await browser.newPage({ viewport: { width: 480, height: 600 } });
  await page.goto(`${base}/?showcase=${god}&view=bust&flip&capture&webgl&quality=high`);
  await page.waitForFunction(() => window.__game, null, { timeout: 900_000 });
  const jpg = await page.evaluate(async () => {
    const png = await window.__game.capture(24);
    const img = new Image();
    img.src = png;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/jpeg', 0.86);
  });
  writeFileSync(new URL(`${god}.jpg`, out), Buffer.from(jpg.split(',')[1], 'base64'));
  console.log('baked', god);
  await page.close();
}
await browser.close();
