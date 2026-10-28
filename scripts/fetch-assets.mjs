#!/usr/bin/env node
// Downloads the free (CC0 / CC-BY / MIT) assets listed in scripts/assets.manifest.json.
//
//   node scripts/fetch-assets.mjs                 core set (skips assets marked heavy)
//   node scripts/fetch-assets.mjs --heavy         also fetch 4K skies and 40+ MB showcase models
//   node scripts/fetch-assets.mjs --only statues  only ids or categories starting with "statues"
//   node scripts/fetch-assets.mjs --no-polyhaven  skip the Poly Haven tier entirely
//   node scripts/fetch-assets.mjs --list          print what would be fetched, download nothing
//   node scripts/fetch-assets.mjs --force         re-download files that already exist
//   node scripts/fetch-assets.mjs --write-lock    record sha256 of GitHub files in scripts/assets.lock.json
//
// Runtime assets land in public/assets/, build-time source data in assets-src/.
// A CREDITS.md and credits.json for the shipped game are written to public/assets/.
//
// Requirements: Node 18+, curl and git on PATH. curl is used for all downloads so that
// HTTPS_PROXY / corporate proxies work without extra Node packages.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'scripts/assets.manifest.json');
const LOCK = join(ROOT, 'scripts/assets.lock.json');
const POLYHAVEN_API = process.env.POLYHAVEN_API ?? 'https://api.polyhaven.com';
const USER_AGENT = 'Claude-Smite-asset-fetch/1.0 (+https://github.com/austinbryanprice-droid/Claude-Smite)';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const lock = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')) : {};
const roots = Object.fromEntries(Object.entries(manifest.roots).map(([k, v]) => [k, join(ROOT, v)]));

const only = opt('--only');
const selected = manifest.assets.filter((a) => {
  if (only && !a.id.startsWith(only) && a.category !== only) return false;
  if (a.heavy && !flag('--heavy') && !only) return false;
  if (a.type === 'polyhaven' && flag('--no-polyhaven')) return false;
  return true;
});

function curl(url, out) {
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.part`;
  const r = spawnSync('curl', ['-fsSL', '--retry', '4', '--retry-delay', '2', '-A', USER_AGENT, '-o', tmp, url], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (r.error) throw new Error(`curl is required (${r.error.message})`);
  if (r.status !== 0) {
    rmSync(tmp, { force: true });
    throw new Error(`download failed (${r.stderr.toString().trim() || `curl exit ${r.status}`}): ${url}`);
  }
  renameSync(tmp, out);
}

function curlJson(url) {
  const r = spawnSync('curl', ['-fsSL', '--retry', '3', '-A', USER_AGENT, url], { maxBuffer: 64 << 20 });
  if (r.error) throw new Error(`curl is required (${r.error.message})`);
  if (r.status !== 0) throw new Error(`request failed (${r.stderr.toString().trim()}): ${url}`);
  return JSON.parse(r.stdout.toString());
}

const hash = (algo, file) => createHash(algo).update(readFileSync(file)).digest('hex');
const have = (file) => !flag('--force') && existsSync(file) && statSync(file).size > 0;

function fetchGithub(asset) {
  const base = roots[asset.root];
  for (const { src, dest } of asset.files) {
    const out = join(base, dest);
    const key = `${asset.repo}@${asset.commit}:${src}`;
    if (!have(out)) {
      const url = `https://raw.githubusercontent.com/${asset.repo}/${asset.commit}/${src.split('/').map(encodeURIComponent).join('/')}`;
      curl(url, out);
    }
    const sum = hash('sha256', out);
    if (flag('--write-lock')) lock[key] = sum;
    else if (lock[key] && lock[key] !== sum) throw new Error(`sha256 mismatch for ${dest} (expected ${lock[key]}, got ${sum})`);
  }
}

function fetchGitSparse(asset) {
  const out = join(roots[asset.root], asset.dest);
  if (!flag('--force') && existsSync(join(out, '.fetched'))) return;
  const tmp = mkdtempSync(join(tmpdir(), 'smite-assets-'));
  try {
    const git = (...a) => {
      const r = spawnSync('git', a, { stdio: ['ignore', 'ignore', 'pipe'] });
      if (r.error) throw new Error(`git is required (${r.error.message})`);
      if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr.toString().trim()}`);
    };
    git('init', '-q', tmp);
    git('-C', tmp, 'remote', 'add', 'origin', `https://github.com/${asset.repo}.git`);
    git('-C', tmp, 'sparse-checkout', 'set', '--no-cone', ...asset.paths.map((p) => `/${p}`));
    git('-C', tmp, 'fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', asset.commit);
    git('-C', tmp, 'checkout', '-q', 'FETCH_HEAD');
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    cpSync(tmp, out, { recursive: true, filter: (src) => !src.startsWith(join(tmp, '.git')) });
    writeFileSync(join(out, '.fetched'), `${asset.repo}@${asset.commit}\n`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Poly Haven: resolve real file URLs and md5 sums through the public API (https://api.polyhaven.com).
function fetchPolyHaven(asset) {
  const files = curlJson(`${POLYHAVEN_API}/files/${asset.asset}`);
  const out = join(roots.public, asset.dest);
  const jobs = [];
  if (asset.kind === 'texture') {
    for (const map of asset.maps) {
      const entry = files[map]?.[asset.res]?.jpg ?? files[map]?.[asset.res]?.png;
      if (!entry) throw new Error(`${asset.asset}: no ${map} map at ${asset.res}`);
      jobs.push([entry, join(out, entry.url.split('/').pop())]);
    }
  } else if (asset.kind === 'model') {
    const gltf = files.gltf?.[asset.res]?.gltf;
    if (!gltf) throw new Error(`${asset.asset}: no glTF at ${asset.res}`);
    jobs.push([gltf, join(out, `${asset.asset}.gltf`)]);
    for (const [rel, entry] of Object.entries(gltf.include ?? {})) jobs.push([entry, join(out, rel)]);
  } else if (asset.kind === 'hdri') {
    const entry = files.hdri?.[asset.res]?.hdr;
    if (!entry) throw new Error(`${asset.asset}: no .hdr at ${asset.res}`);
    jobs.push([entry, join(out, entry.url.split('/').pop())]);
  }
  for (const [entry, file] of jobs) {
    if (!have(file) || hash('md5', file) !== entry.md5) curl(entry.url, file);
    if (entry.md5 && hash('md5', file) !== entry.md5) throw new Error(`md5 mismatch for ${file}`);
  }
}

function writeCredits(done) {
  const shipped = manifest.assets.filter((a) => a.root !== 'src' && done.has(a.id));
  const usesPolyHavenApi = shipped.some((a) => a.type === 'polyhaven');
  const rows = shipped.map((a) => ({ id: a.id, author: a.author, license: a.license, source: a.origin }));
  mkdirSync(roots.public, { recursive: true });
  writeFileSync(join(roots.public, 'credits.json'), `${JSON.stringify(rows, null, 2)}\n`);
  const md = [
    '# Asset credits',
    '',
    'Generated by scripts/fetch-assets.mjs. CC-BY assets require this attribution to ship with the game.',
    ...(usesPolyHavenApi ? ['', 'Some assets were downloaded through the Poly Haven API. Powered by Poly Haven (https://polyhaven.com).'] : []),
    '',
    '| Asset | Author | License | Source |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.id} | ${r.author} | ${r.license} | ${r.source} |`),
    '',
  ].join('\n');
  writeFileSync(join(roots.public, 'CREDITS.md'), md);
}

if (flag('--list')) {
  for (const a of selected) console.log(`${a.type.padEnd(10)} ${a.license.padEnd(36)} ${a.id}`);
  console.log(`\n${selected.length} assets`);
  process.exit(0);
}

const done = new Set();
const failed = [];
let polyHavenDown = null;
for (const asset of selected) {
  process.stdout.write(`${asset.id} ... `);
  try {
    if (asset.type === 'github') fetchGithub(asset);
    else if (asset.type === 'git-sparse') fetchGitSparse(asset);
    else if (asset.type === 'polyhaven') {
      if (polyHavenDown) throw polyHavenDown;
      fetchPolyHaven(asset);
    } else throw new Error(`unknown type ${asset.type}`);
    done.add(asset.id);
    console.log('ok');
  } catch (err) {
    console.log(asset.optional ? 'skipped' : 'FAILED');
    // One unreachable API call means the whole tier is unreachable; don't retry it per asset.
    if (asset.type === 'polyhaven' && err.message.startsWith('request failed')) polyHavenDown ??= err;
    failed.push({ asset, err });
  }
}

// Keep credits for assets fetched earlier but outside this run's selection.
for (const a of manifest.assets) {
  if (a.type === 'github' && a.files.every((f) => existsSync(join(roots[a.root], f.dest)))) done.add(a.id);
  if (a.type === 'polyhaven' && existsSync(join(roots.public, a.dest))) done.add(a.id);
}
writeCredits(done);
if (flag('--write-lock')) writeFileSync(LOCK, `${JSON.stringify(Object.fromEntries(Object.entries(lock).sort()), null, 2)}\n`);

for (const { asset, err } of failed) {
  if (err === polyHavenDown && asset.id !== failed.find((f) => f.err === polyHavenDown).asset.id) continue;
  console.error(`${asset.optional ? 'warning' : 'error'}: ${asset.id}: ${err.message}`);
}
if (polyHavenDown) console.error(`warning: Poly Haven API unreachable, skipped ${failed.filter((f) => f.err === polyHavenDown).length} Poly Haven assets.`);
const hardFailures = failed.filter((f) => !f.asset.optional);
console.log(`\n${done.size} assets present, ${failed.length} not fetched${hardFailures.length ? `, ${hardFailures.length} required` : ''}.`);
if (failed.some((f) => f.asset.type === 'polyhaven')) {
  console.log('Poly Haven assets are optional. If api.polyhaven.com is blocked on this network, run the script again from a normal connection or in CI.');
}
process.exit(hardFailures.length ? 1 : 0);
