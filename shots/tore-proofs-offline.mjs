/**
 * tore-proofs-offline.mjs — proof for the OFFLINE BOT MODE (owner
 * order 2026-11-11: «الا میخام این را که گفتی را انجام بدی»).
 * Boots the deploy host (the built bundle — the engine is inlined
 * by build-deploy.js) and drives the real client:
 *   BUNDLE: dist carries window.ToreEngine/ToreBots and stays
 *     code-only (< 1 MB); all three sw.js copies are v5 (up41 cache roll); the
 *     worker points at ?v=20261112-burstfix.
 *   ONLINE WARM-UP: after one signed-in-style load the service
 *     worker's tore-assets-v5 cache holds the deck + thumbs + the
 *     player's felt; the profile شمېرې baseline is read.
 *   OFFLINE (context.setOffline): a reload renders home from the
 *     SW shell; the ONLINE doors (انلاین / کوټه / code join) raise
 *     the no-net popup with its wifi-off icon and never navigate;
 *     the BOTS door starts a LOCAL match — no game websocket is
 *     opened, no room/state frame ever arrives; the human idles
 *     and the 30 s timer plays for him; a full round completes
 *     with the summary card.
 *   STATS: back online, the same player's شمېرې is unchanged —
 *     the offline match was recorded nowhere.
 *   REGRESSION: online again, the bots door goes to the SERVER
 *     (a game socket opens, room/state frames flow).
 *   shots/offline-bots-table-FRESH.jpg — the offline table
 *   shots/offline-nonet-popup-FRESH.jpg — the 📵 popup over home
 *   node shots/tore-proofs-offline.mjs
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
const PORT = '8831';
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};

// ---------------- bundle shape ----------------
const dist = fs.readFileSync(path.join(ROOT, 'cloudflare/dist-client.html'), 'utf8');
check('dist inlines the offline engine (ToreEngine + ToreBots)',
  dist.includes('window.ToreEngine') && dist.includes('window.ToreBots'));
check('dist stays code-only (< 1 MB)', Buffer.byteLength(dist) < 1_000_000, Buffer.byteLength(dist) + ' B');
for (const rel of ['public/sw.js', 'deploy/sw.js', 'cloudflare/sw.js']) {
  const sw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  check(rel + " is SW_VERSION 'v5'", sw.includes("const SW_VERSION = 'v5';"));
}
const workerSrc = fs.readFileSync(path.join(ROOT, 'cloudflare/src/worker.js'), 'utf8');
check('worker.js serves ?v=20261112-burstfix', workerSrc.includes('dist-client.html?v=20261112-burstfix'));

// ---------------- server ----------------
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

// ---------------- browser ----------------
const exe = chromium && findChrome();
if (!chromium || !exe) {
  check('browser available for offline proofs', false, 'playwright/chromium unavailable');
  srv.kill();
  process.exit(1);
}
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const vis = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return !!el && !el.classList.contains('hidden') && el.getClientRects().length > 0;
}, sel).catch(() => false);
async function tapPlayable(page) {
  return page.evaluate(() => {
    const els = document.querySelectorAll('#hand .pcard.playable');
    if (!els.length) return false;
    const el = els[els.length - 1];
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 9, pointerType: 'touch', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    return true;
  }).catch(() => false);
}
async function readStats(page) {
  await page.click('#btn-profile');
  await page.waitForSelector('#pf-stat-played', { state: 'visible', timeout: 15000 });
  await sleep(1500); // the social hello + stats land async
  return page.evaluate(() => ({
    p: document.querySelector('#pf-stat-played').textContent.trim(),
    w: document.querySelector('#pf-stat-won').textContent.trim(),
    l: document.querySelector('#pf-stat-lost').textContent.trim(),
  }));
}

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let sockets = [];
  page.on('websocket', (ws) => {
    const rec = { url: ws.url(), sent: [], received: [] };
    ws.on('framesent', (f) => { try { rec.sent.push(String(f.payload)); } catch { /* binary */ } });
    ws.on('framereceived', (f) => { try { rec.received.push(String(f.payload)); } catch { /* binary */ } });
    sockets.push(rec);
  });

  // ---------- Phase A: one online visit (warm-up + stats baseline)
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 30000 });
  const swOk = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active && reg.active.scriptURL.endsWith('/sw.js');
  });
  check('A: service worker active on the online visit', swOk);
  // A CONTROLLED load is what stores the shell fallback and lets
  // the warm-up's fetches pass through the worker: wait for
  // control, then reload once (a player's second open).
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 }).catch(() => {});
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 30000 });
  await sleep(1200); // the shell cache.put settles
  const warmed = await page.evaluate(async () => {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      try {
        const cache = await caches.open('tore-assets-v5');
        const keys = await cache.keys();
        if (keys.length >= 64) return keys.length;
      } catch { /* cache not there yet */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    try { return (await (await caches.open('tore-assets-v5')).keys()).length; } catch { return -1; }
  });
  check('A: warm-up filled tore-assets-v5 (53 faces + back + 11 thumbs + own felt = 65)',
    warmed >= 64, 'keys ' + warmed);
  const baseline = await readStats(page);
  check('A: stats baseline read (fresh player)', baseline.p === '0' && baseline.w === '0' && baseline.l === '0',
    JSON.stringify(baseline));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 30000 });

  // ---------- Phase B: offline ----------
  sockets = [];
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 30000 });
  check('B: home renders OFFLINE from the service-worker shell', true);
  // Chromium quirk (test-env only): a page SERVED BY the service
  // worker after an emulated-offline reload reports
  // navigator.onLine === true even though every request fails —
  // re-applying the emulation on the page's own CDP session makes
  // onLine honest again. On a real phone, airplane mode sets
  // onLine = false natively and the product code path is the same.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(400);
  const reallyOffline = await page.evaluate(() => navigator.onLine === false);
  check('B: navigator.onLine is false (emulation re-applied)', reallyOffline);

  // online doors -> the no-net popup, no navigation
  await page.click('#btn-online');
  await page.waitForSelector('#ov-nonet.show', { timeout: 8000 });
  const popup = await page.evaluate(() => {
    const o = document.querySelector('#ov-nonet');
    const svg = o.querySelector('.nonet-ico svg');
    const r = svg ? svg.getBoundingClientRect() : { width: 0 };
    return {
      shown: o.classList.contains('show'),
      title: document.querySelector('#nonet-title').textContent.trim(),
      body: document.querySelector('#nonet-body').textContent.trim(),
      iconW: r.width,
      pickerOpen: !document.querySelector('#scr-picker').classList.contains('hidden') === false,
    };
  });
  check('B: انلاین door offline -> no-net popup (Kandahari title + body + icon)',
    popup.shown && popup.title === 'انټرنټ نشته' && popup.body.includes('انټرنټ چالان کړه') && popup.iconW > 20,
    JSON.stringify(popup));
  await page.screenshot({ path: path.join(SHOTS, 'offline-nonet-popup-FRESH.jpg'), type: 'jpeg', quality: 88 });
  check('B: proof saved (offline-nonet-popup-FRESH.jpg)', true);
  await page.click('#btn-nonet-ok');
  await sleep(400);
  check('B: popup dismisses on «سمه ده»', !(await vis(page, '#ov-nonet.show')));
  await page.click('#btn-join-toggle');
  await page.waitForSelector('#ov-nonet.show', { timeout: 8000 });
  const joinBlocked = await page.evaluate(() => !document.querySelector('#ov-join').classList.contains('show'));
  check('B: join-by-code door offline -> popup, join popup never opens', joinBlocked);
  await page.click('#btn-nonet-ok');
  await sleep(300);
  await page.click('#btn-create');
  await page.waitForSelector('#ov-nonet.show', { timeout: 8000 });
  check('B: create-room door offline -> no-net popup', true);
  await page.click('#btn-nonet-ok');
  await sleep(300);

  // bots door -> a LOCAL match
  await page.click('#btn-quick');
  await page.waitForSelector('#btn-pk-play', { state: 'visible', timeout: 10000 });
  await page.click('#btn-pk-play');
  await page.waitForSelector('#scr-game:not(.hidden)', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('#hand .pcard').length === 13, null, { timeout: 15000 });
  const localFlag = await page.evaluate(() => window.__toreLocalGame === true);
  check('B: bots door offline -> LOCAL match dealt (13 cards, in-page host)', localFlag);
  const feltOk = await page.evaluate(() => {
    const g = document.querySelector('#scr-game');
    return { felt: g.dataset.felt, bg: getComputedStyle(g).backgroundImage };
  });
  check('B: table wears the creator felt (full file, cached)',
    feltOk.bg.includes('/carpets/felt' + feltOk.felt + '.jpg'), feltOk.bg.slice(0, 70));

  // idle human -> the 30 s timer plays for him
  const idlePlayed = await page.waitForFunction(
    () => document.querySelectorAll('#hand .pcard').length === 12, null, { timeout: 75000 })
    .then(() => true).catch(() => false);
  check('B: idle human is played by the timer (hand 13 -> 12)', idlePlayed);
  await tapPlayable(page);
  await sleep(1200);
  await page.screenshot({ path: path.join(SHOTS, 'offline-bots-table-FRESH.jpg'), type: 'jpeg', quality: 88 });
  check('B: proof saved (offline-bots-table-FRESH.jpg)', true);

  // play the round out -> the summary card
  const roundDone = await (async () => {
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      if (await vis(page, '#ov-round')) return true;
      await tapPlayable(page);
      await sleep(300);
    }
    return vis(page, '#ov-round');
  })();
  check('B: a full round completes offline with the summary card', roundDone);
  const sumTxt = await page.evaluate(() => (document.querySelector('#ov-round') || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim());
  check('B: summary card carries the round data', sumTxt.length > 20, sumTxt.slice(0, 80));

  // no game websocket was opened and no room/state frame ever arrived
  const gameFrames = sockets.flatMap((s) => s.received).filter((f) => f.includes('"type":"state"') || f.includes('"type":"room"'));
  const gameSockets = sockets.filter((s) => new URL(s.url).pathname === '/');
  check('B: NO game websocket opened, NO room/state frame received offline',
    gameSockets.length === 0 && gameFrames.length === 0,
    'sockets ' + sockets.map((s) => new URL(s.url).pathname).join(','));

  // leave the local game -> home, flag cleared
  await page.evaluate(() => { const o = document.querySelector('#ov-round'); if (o) o.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); }).catch(() => {});
  await sleep(400);
  await page.click('#btn-leave').catch(() => {});
  await sleep(500);
  await page.click('#btn-exit-confirm').catch(() => {});
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 15000 });
  const flagOff = await page.evaluate(() => window.__toreLocalGame === false);
  check('B: leaving the local game lands home, local flag cleared', flagOff);

  // ---------- Phase C: stats untouched ----------
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
  await ctx.setOffline(false);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 30000 });
  const after = await readStats(page);
  check('C: offline match recorded NO stats (played/won/lost unchanged)',
    after.p === baseline.p && after.w === baseline.w && after.l === baseline.l,
    'before ' + JSON.stringify(baseline) + ' after ' + JSON.stringify(after));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 30000 });

  // ---------- Phase D: online bots still go to the SERVER ----------
  sockets = [];
  await page.click('#btn-quick');
  await page.waitForSelector('#btn-pk-play', { state: 'visible', timeout: 10000 });
  await page.click('#btn-pk-play');
  await page.waitForSelector('#scr-game:not(.hidden)', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('#hand .pcard').length >= 10, null, { timeout: 15000 });
  await sleep(800);
  const srvGame = sockets.filter((s) => new URL(s.url).pathname === '/');
  const srvFrames = srvGame.flatMap((s) => s.received);
  const notLocal = await page.evaluate(() => window.__toreLocalGame === false);
  check('D: online bots -> SERVER game (socket + room/state frames, not local)',
    srvGame.length >= 1 && srvFrames.some((f) => f.includes('"type":"room"')) &&
    srvFrames.some((f) => f.includes('"type":"state"')) && notLocal,
    'game sockets ' + srvGame.length + ' frames ' + srvFrames.length);
  await page.click('#btn-leave').catch(() => {});
  await sleep(500);
  await page.click('#btn-exit-confirm').catch(() => {});
  await sleep(800);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
} catch (e) {
  check('driver completed', false, e.message);
}
await browser.close();
srv.kill();

console.log(failures === 0 ? '\nALL OFFLINE PROOF CHECKS PASSED' : '\n' + failures + ' OFFLINE CHECK(S) FAILED');
process.exit(failures ? 1 : 0);
