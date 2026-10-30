// Renders the edit (compose.html) frame by frame and encodes the trailer with
// its soundtrack (out/score.wav) into public/trailer/.
//
//   npx vite --port 5173 &      (compose.html imports the game's modules)
//   node tools/trailer/render.mjs [--from 0] [--to 88] [--base http://localhost:5173]
//
// --from/--to render part of it to out/edit for a quick look without encoding.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FPS, LENGTH } from './timeline.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const base = opt('--base', 'http://localhost:5173');
const from = Number(opt('--from', 0));
const to = Number(opt('--to', LENGTH));
const full = from === 0 && to === LENGTH;
const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const dir = here('out/edit/');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.log('page error:', e.message));
page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()));
await page.goto(`${base}/tools/trailer/compose.html`);
await page.waitForFunction(() => window.ready, null, { timeout: 120_000 });
const t0 = Date.now();
const first = Math.round(from * FPS);
const last = Math.round(to * FPS);
for (let f = first; f < last; f++) {
  await page.evaluate((t) => window.renderAt(t), f / FPS);
  const jpg = await page.screenshot({ type: 'jpeg', quality: 94 });
  writeFileSync(`${dir}${String(f - first).padStart(5, '0')}.jpg`, jpg);
  if (f % 150 === 0) console.log(`${(f / FPS).toFixed(1)} s`, `${Math.round((Date.now() - t0) / 1000)} s elapsed`);
}
await browser.close();

if (full) {
  const out = here('../../public/trailer/');
  mkdirSync(out, { recursive: true });
  // H.264 + AAC plays in every browser; faststart lets it begin before it has fully downloaded
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-framerate', String(FPS), '-i', `${dir}%05d.jpg`,
    '-i', here('out/score.wav'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-vf', 'scale=1920:1080:flags=lanczos',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart', '-shortest',
    `${out}trailer.mp4`,
  ], { stdio: 'inherit' });
  console.log('wrote public/trailer/trailer.mp4');
}
