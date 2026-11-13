/**
 * tore-proofs-searchright.mjs — up50 proof (owner order 2026-11-13):
 * the clubs discovery header's search toggle (ذره‌بین) must sit at the
 * RIGHT side of the header row. The row used a direction:ltr hack with
 * the toggle last in DOM; it is now RTL-native with the toggle FIRST
 * in DOM (= far right in every engine), create pill in the middle,
 * ✕ close last (= far left).
 *
 *   node shots/tore-proofs-searchright.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium = null;
try {
  chromium = require(path.join(os.homedir(), 'workspace/projects/vault-rental-online/node_modules/playwright-core')).chromium;
} catch { /* fall through */ }
function findChrome() {
  const base = path.join(os.homedir(), '.cache/ms-playwright');
  if (!fs.existsSync(base)) return null;
  for (const dir of fs.readdirSync(base).sort().reverse()) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome-headless-shell-linux/headless_shell']) {
      const p = path.join(base, dir, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const ROOT = path.join(os.homedir(), 'workspace/projects/tore-game');
const SHOTS = path.join(ROOT, 'shots');
const PORT = '8867';
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};

const dist = fs.readFileSync(path.join(ROOT, 'cloudflare/dist-client.html'), 'utf8');
check('dist stays code-only (< 1 MB)', Buffer.byteLength(dist) < 1_000_000, Buffer.byteLength(dist) + ' B');
check('dist headrow has NO direction:ltr hack', !dist.includes('.cl-headrow { display: flex; align-items: center; gap: 11px; direction: ltr;'));
const workerSrc = fs.readFileSync(path.join(ROOT, 'cloudflare/src/worker.js'), 'utf8');
check('worker.js serves ?v=20261113-searchright', workerSrc.includes('dist-client.html?v=20261113-searchright'));

function spawnServer(args, port) {
  const s = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, PORT: port }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('server did not start on ' + port)), 30000);
    s.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(to); resolve(s); } });
    s.stderr.on('data', (d) => { process.stderr.write('[srv ' + port + '] ' + d); });
    s.on('exit', () => reject(new Error('server exited early on ' + port)));
  });
}
const srv = await spawnServer([path.join(ROOT, 'deploy', 'server.js')], PORT);

const exe = chromium && findChrome();
if (!chromium || !exe) {
  check('browser available', false, 'playwright/chromium unavailable');
  srv.kill();
  process.exit(1);
}
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 60000 });
  await page.click('#nav-clubs');
  await page.waitForSelector('#scr-clubs:not(.hidden)', { timeout: 15000 });
  await sleep(1100);
  const m = await page.evaluate(() => {
    const t = document.querySelector('#btn-cl-search-toggle').getBoundingClientRect();
    const x = document.querySelector('#btn-cl-home').getBoundingClientRect();
    const c = document.querySelector('#btn-cl-create').getBoundingClientRect();
    const head = document.querySelector('.cl-headrow');
    const hr = head.getBoundingClientRect();
    return {
      vw: window.innerWidth,
      headH: Math.round(hr.height), headL: Math.round(hr.left), headR: Math.round(hr.right), headT: Math.round(hr.top), btnTop: Math.round(t.top), headBg: getComputedStyle(head).backgroundImage.slice(0, 120),
      search: { l: Math.round(t.left), r: Math.round(t.right) },
      xbtn: { l: Math.round(x.left), r: Math.round(x.right) },
      create: { l: Math.round(c.left), r: Math.round(c.right), h: Math.round(c.height) },
    };
  });
  check('search toggle at the header RIGHT edge (right >= vw-20)', m.search.r >= m.vw - 20, JSON.stringify(m.search) + ' vw=' + m.vw);
  check('header band bleeds edge-to-edge (no side/top gaps)', m.headL <= 1 && m.headR >= m.vw - 1 && m.headT <= 2, 'L=' + m.headL + ' R=' + m.headR + ' T=' + m.headT);
  check('header buttons raised to the top (searchbtn top - band top <= 16)', m.btnTop - m.headT <= 16, 'btnTop=' + m.btnTop + ' headT=' + m.headT);
  check('search toggle smaller now (width <= 44px)', m.search.r - m.search.l <= 44, 'w=' + (m.search.r - m.search.l));
  check('✕ close smaller now (width <= 44px)', m.xbtn.r - m.xbtn.l <= 44, 'w=' + (m.xbtn.r - m.xbtn.l));
  check('create pill smaller now (height <= 38px)', m.create.h <= 38, 'h=' + m.create.h);
  check('create pill is compact now (width <= 150px)', m.create.r - m.create.l <= 150, 'w=' + (m.create.r - m.create.l));
  check('header taller with trophy image bg (>= 177px, bg has trophy)', m.headH >= 177 && m.headBg.includes('trophy'), 'h=' + m.headH);
  check('create pill sits right beside the search toggle', m.create.r < m.search.l && m.search.l - m.create.r <= 16, `create.r=${m.create.r} search.l=${m.search.l}`);
  check('✕ close at the header LEFT edge (left <= 20)', m.xbtn.l <= 20, JSON.stringify(m.xbtn));
  check('no page errors', errors.length === 0, errors.join(' | '));
  const chipH = await page.evaluate(() => {
    const ch = document.querySelector('#scr-clubs .cl-chip');
    return ch ? Math.round(ch.getBoundingClientRect().height) : 0;
  });
  check('country chips are smaller now (height <= 30px)', chipH > 0 && chipH <= 30, 'chipH=' + chipH);
  await page.screenshot({ path: path.join(SHOTS, 'up50-clubs-createbeside-FRESH.jpg'), type: 'jpeg', quality: 88 });
  // the toggle still opens the search row
  await page.click('#btn-cl-search-toggle');
  await sleep(500);
  const rowOpen = await page.evaluate(() => !document.querySelector('#cl-searchrow').classList.contains('hidden'));
  check('toggle still opens the search row', rowOpen);
  await ctx.close();
} finally {
  await browser.close();
  srv.kill();
}
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
