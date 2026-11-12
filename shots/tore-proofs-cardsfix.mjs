/**
 * tore-proofs-cardsfix.mjs — proof for the CARDSFIX (owner report
 * 2026-11-11, live screenshot from Telegram's in-app browser: two
 * cards already played into the trick stood on the table as big
 * BLANK WHITE rectangles for seconds — one wearing the gold winner
 * frame — and spectators saw the same: «fix it so this never
 * happens, even if 100 people are watching»).
 *
 * Diagnosis (public/index.html): cardEl() set <img src=/cards/…>
 * cold at render over .pcard's #fffef9 background — until the PNG
 * arrived, the white box WAS the card. The deck warm-up only runs
 * under a service worker (Telegram's webview has none) and nothing
 * at table entry awaited the faces.
 *
 * Fix under test: every card element is born wearing the room's
 * card-BACK design with its face invisible; the face fades in only
 * once loaded (one retry, then the back stays). A shared deck gate
 * (gateFaces) runs at every table entry. This driver boots the
 * deploy host and proves, on COLD caches (fresh contexts — every
 * face crosses the network at least once) with CDP slow-4G
 * throttling (phase D runs fully service-worker-free, the owner's
 * Telegram-webview condition, via a static server that 404s sw.js):
 *   A  cold bot game — at no audited moment does any trick/hand
 *      card present blank-white (each is faceready or wears the
 *      plum back placeholder); the >300 ms gate shows the slim
 *      «کارتونه بارېږي…» hint; a complete trick is captured with
 *      every face visible → cardsfix-trick-FRESH.jpg.
 *   C  warm re-entry (same context, HTTP cache warm, page reload)
 *      — no loader flash, the dealt hand is faceready at once.
 *   B  a second COLD + throttled client spectates a live
 *      human-vs-bots game mid-round (the real spectateGame entry)
 *      — same never-blank law + complete-trick capture →
 *      cardsfix-spectate-FRESH.jpg; the spectator has no hand.
 *   D  failure injection — the first 8D.png request is aborted:
 *      the face recovers via the retry; every KH.png request is
 *      aborted: the card settles as the plum back, never white.
 *   E  nav guards (scope extension, owner order 2026-11-11):
 *      OFFLINE, the Clubs / Friends / Chat entries (bottom nav,
 *      the home friends card) raise the same 📵 popup and the
 *      player stays home → offline-nonet-nav-FRESH.jpg; ONLINE
 *      the three pages open normally (regression).
 *   B-exit  spectate-exit (second scope extension): friend-
 *      spectate -> exit -> friends -> «کور» must land on a COMPLETE
 *      home — the old exitSpectate never restored #scr-home after
 *      the watch's show('scr-game') hid it, so the overlay's home
 *      nav revealed the bare body (his blank dark-green screenshot)
 *      → spectate-exit-home-FRESH.jpg.
 *   G  DM on the table (third scope extension): the friends-page
 *      💬 is live only while the friend is in a match (else dimmed
 *      + aria-disabled + toast); a DM sent from EITHER the friends
 *      💬 or the چت page pops as a bubble at the table's top-left
 *      (auto-dismiss ~6 s, tap dismisses, thread + badge intact);
 *      no bubble in the lobby or while spectating
 *      → dm-overlay-table-FRESH.jpg, dm-button-gating-FRESH.jpg.
 *   A2 pill position + DM restyle (owner orders 2026-11-11, later):
 *      the «کارتونه بارېږي…» hint moved ABOVE the top avatar —
 *      centred in the band between the score-strip bottom (47.4)
 *      and the top avatar top (105.4): fixed top 132px -> 53px,
 *      geometry asserted in phase A (natural show) and in a
 *      dedicated 390x932 context → cardsfix-pill-above-FRESH.jpg.
 *      The DM bubble lost its box entirely (bare avatar + gold
 *      name + white shadowed text on the felt) and moved to
 *      directly under the score strip (top 96px -> 51px); phase G
 *      asserts computed background/shadow none, bubble top >=
 *      strip bottom, no overlap with the top avatar
 *      → dm-overlay-table2-FRESH.jpg.
 *   node shots/tore-proofs-cardsfix.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require(path.join(os.homedir(), 'workspace/projects/tore-game/node_modules/ws'));
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
const PORT = '8851';
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};

// ---------------- bundle shape ----------------
const dist = fs.readFileSync(path.join(ROOT, 'cloudflare/dist-client.html'), 'utf8');
check('dist carries the never-blank card path (faceready + gateFaces + cardsLoading)',
  dist.includes('faceready') && dist.includes('gateFaces') && dist.includes('cardsLoading'));
check('dist stays code-only (< 1 MB)', Buffer.byteLength(dist) < 1_000_000, Buffer.byteLength(dist) + ' B');
const workerSrc = fs.readFileSync(path.join(ROOT, 'cloudflare/src/worker.js'), 'utf8');
check('worker.js serves ?v=20261113-bots', workerSrc.includes('dist-client.html?v=20261113-bots'));

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
  check('browser available for cardsfix proofs', false, 'playwright/chromium unavailable');
  srv.kill();
  process.exit(1);
}
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const SLOW4G = { offline: false, latency: 150, downloadThroughput: Math.floor(1.6 * 1024 * 1024 / 8), uploadThroughput: Math.floor(1.6 * 1024 * 1024 / 8) };
async function throttle(ctx, page, on) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', on ? SLOW4G : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  return cdp;
}
const auditCards = (page) => page.evaluate(() => [...document.querySelectorAll('#trick .pcard, #hand .pcard')].map((el) => {
  const img = el.querySelector('img.face');
  return {
    face: el.dataset.face || '',
    ready: el.classList.contains('faceready'),
    back: el.classList.contains('cback'),
    nw: img ? img.naturalWidth : 0,
    op: img ? getComputedStyle(img).opacity : '1',
  };
})).catch(() => []);
const blankViolations = (list) => list.filter((c) => !c.ready && !(c.back && c.op === '0'));
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
function watchLoader(page, store) {
  const iv = setInterval(async () => {
    const seen = await page.evaluate(() => {
      const el = document.querySelector('#cardloader');
      return !!el && !el.classList.contains('hidden');
    }).catch(() => false);
    if (seen) store.seen = true;
  }, 90);
  return () => clearInterval(iv);
}

try {
  // ================= Phase A: cold + throttled bot game =================
  const ctxA = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'] });
  const pageA = await ctxA.newPage();
  const errorsA = [];
  pageA.on('pageerror', (e) => errorsA.push(e.message));
  // NOTE: fresh context = the SW is present but its cache is EMPTY (cold);
  // phase D covers the fully SW-free case. Every face crosses the network.
  await throttle(ctxA, pageA, true);
  const loaderA = { seen: false };
  const stopWatchA = watchLoader(pageA, loaderA);
  await pageA.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await pageA.waitForSelector('#btn-quick', { state: 'visible', timeout: 60000 });
  await pageA.click('#btn-quick');
  await pageA.waitForSelector('#btn-pk-play', { state: 'visible', timeout: 20000 });
  await pageA.click('#btn-pk-play');
  await pageA.waitForSelector('#scr-game:not(.hidden)', { timeout: 40000 });
  await pageA.waitForFunction(() => document.querySelectorAll('#hand .pcard').length >= 13, null, { timeout: 40000 });
  check('A: cold throttled bot game deals a full hand', true);

  let violations = [];
  let firstTrickSeen = false;
  let proofA = false;
  let pillGeo = null;
  const pillRects = (page) => page.evaluate(() => {
    const R = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
    return { pill: R('#cardloader'), strip: R('.scorestrip'), avatar: R('#seat-top .pavatar'), exit: R('#btn-leave') };
  }).catch(() => null);
  const deadlineA = Date.now() + 150000;
  while (Date.now() < deadlineA && !proofA) {
    const list = await auditCards(pageA);
    violations = violations.concat(blankViolations(list));
    const trickAudit = await pageA.evaluate(() => [...document.querySelectorAll('#trick .pcard')].map((el) => {
      const img = el.querySelector('img.face');
      return { face: el.dataset.face || '', ready: el.classList.contains('faceready'), back: el.classList.contains('cback'), nw: img ? img.naturalWidth : 0, op: img ? getComputedStyle(img).opacity : '1' };
    })).catch(() => []);
    if (trickAudit.length) firstTrickSeen = true;
    violations = violations.concat(blankViolations(trickAudit));
    const handAll = await pageA.evaluate(() => [...document.querySelectorAll('#hand .pcard')].every((el) => el.classList.contains('faceready'))).catch(() => false);
    if (trickAudit.length === 4 && trickAudit.every((c) => c.ready && c.nw > 0) && handAll) {
      await pageA.screenshot({ path: path.join(SHOTS, 'cardsfix-trick-FRESH.jpg'), type: 'jpeg', quality: 88 });
      proofA = true;
      break;
    }
    // Pill geometry, captured at a NATURAL show (the gate is still
    // running under throttle): pill + top avatar both on screen.
    if (!pillGeo) {
      const vis = await pageA.evaluate(() => {
        const el = document.querySelector('#cardloader');
        return !!el && !el.classList.contains('hidden') && !!document.querySelector('#seat-top .pavatar');
      }).catch(() => false);
      if (vis) {
        pillGeo = await pillRects(pageA);
        if (pillGeo && pillGeo.pill) {
          await pageA.screenshot({ path: path.join(SHOTS, 'cardsfix-pill-above-FRESH.jpg'), type: 'jpeg', quality: 88 });
        }
      }
    }
    await tapPlayable(pageA);
    await sleep(420);
  }
  stopWatchA();
  if (!pillGeo || !pillGeo.pill) {
    // Fallback: force-show the pill in the live game and measure
    // (its position is static CSS — the rect is the shipped one).
    pillGeo = await pageA.evaluate(() => {
      const el = document.querySelector('#cardloader');
      el.classList.remove('hidden');
      const R = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
      return { pill: R('#cardloader'), strip: R('.scorestrip'), avatar: R('#seat-top .pavatar'), exit: R('#btn-leave') };
    }).catch(() => null);
    if (pillGeo && pillGeo.pill) {
      await pageA.screenshot({ path: path.join(SHOTS, 'cardsfix-pill-above-FRESH.jpg'), type: 'jpeg', quality: 88 });
      await pageA.evaluate(() => document.querySelector('#cardloader').classList.add('hidden'));
    }
  }
  const rectsOverlap = (a, b) => a && b && !(a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left);
  check('A: pill ABOVE the top avatar — inside the band: top >= score-strip bottom, bottom <= avatar top, no exit-button overlap',
    !!pillGeo && !!pillGeo.pill && pillGeo.pill.top >= pillGeo.strip.bottom - 0.5 &&
    pillGeo.pill.bottom <= pillGeo.avatar.top + 0.5 && !rectsOverlap(pillGeo.pill, pillGeo.exit),
    JSON.stringify(pillGeo));
  check('A: pill proof saved (cardsfix-pill-above-FRESH.jpg)', !!pillGeo && !!pillGeo.pill);
  check('A: a trick rendered under cold+throttle', firstTrickSeen);
  check('A: NEVER a blank-white card (every unloaded card wore the plum back, face invisible)',
    violations.length === 0, violations.slice(0, 3).map((v) => v.face + ' op' + v.op).join(','));
  check('A: complete trick captured with every face visible (cardsfix-trick-FRESH.jpg)', proofA);
  check('A: the >300 ms deck gate showed the slim loading hint', loaderA.seen);
  await throttle(ctxA, pageA, false);

  // ================= Phase C: warm re-entry =================
  await pageA.click('#btn-leave');
  await pageA.waitForSelector('#ov-exit.show', { timeout: 10000 });
  await pageA.click('#btn-exit-confirm');
  await pageA.waitForSelector('#scr-home:not(.hidden)', { timeout: 15000 });
  await pageA.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await pageA.waitForSelector('#btn-quick', { state: 'visible', timeout: 30000 });
  const loaderC = { seen: false };
  const stopWatchC = watchLoader(pageA, loaderC);
  const t0 = Date.now();
  await pageA.click('#btn-quick');
  await pageA.waitForSelector('#btn-pk-play', { state: 'visible', timeout: 10000 });
  await pageA.click('#btn-pk-play');
  await pageA.waitForFunction(() => document.querySelectorAll('#hand .pcard').length >= 13 &&
    [...document.querySelectorAll('#hand .pcard')].every((el) => el.classList.contains('faceready')), null, { timeout: 20000 });
  const warmMs = Date.now() - t0;
  stopWatchC();
  check('C: warm re-entry deals a fully-faced hand fast', warmMs < 8000, warmMs + ' ms');
  check('C: warm re-entry shows NO loader flash', !loaderC.seen);
  check('A/C: no page errors', errorsA.length === 0, errorsA.slice(0, 3).join(' | '));
  await ctxA.close();

  // ================= Phase A2: pill geometry at 390x932 =================
  // The header is content-sized, so the band must be identical at
  // the taller viewport — assert it in a fresh context there.
  const ctxA2 = await browser.newContext({ viewport: { width: 390, height: 932 }, deviceScaleFactor: 2, permissions: ['microphone'] });
  const pageA2 = await ctxA2.newPage();
  await pageA2.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pageA2.waitForSelector('#btn-quick', { state: 'visible', timeout: 30000 });
  await pageA2.click('#btn-quick');
  await pageA2.waitForSelector('#btn-pk-play', { state: 'visible', timeout: 10000 });
  await pageA2.click('#btn-pk-play');
  await pageA2.waitForSelector('#scr-game:not(.hidden)', { timeout: 20000 });
  await pageA2.waitForFunction(() => document.querySelectorAll('#hand .pcard').length >= 13, null, { timeout: 20000 });
  const pillGeo932 = await pageA2.evaluate(() => {
    const el = document.querySelector('#cardloader');
    el.classList.remove('hidden');
    const R = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
    const out = { pill: R('#cardloader'), strip: R('.scorestrip'), avatar: R('#seat-top .pavatar'), exit: R('#btn-leave') };
    el.classList.add('hidden');
    return out;
  }).catch(() => null);
  check('A2: pill geometry at 390x932 — same band: top >= strip bottom, bottom <= avatar top, no exit overlap',
    !!pillGeo932 && !!pillGeo932.pill && pillGeo932.pill.top >= pillGeo932.strip.bottom - 0.5 &&
    pillGeo932.pill.bottom <= pillGeo932.avatar.top + 0.5 && !rectsOverlap(pillGeo932.pill, pillGeo932.exit),
    JSON.stringify(pillGeo932));
  await ctxA2.close();

  // ================= Phase B: cold spectator of a live game =================
  // Spectate admission is authorized server-side (club membership or
  // the social core's canWatch between friends) — so, exactly like
  // the features proof, the two identities are befriended with a raw
  // /social handshake and B enters through the real «تماشا» button,
  // which lands in the same spectateGame() entry the club flow uses.
  const socialHandshake = (pidA, pidB) => new Promise((resolve) => {
    const mk = (pid, name) => {
      const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/social');
      ws.on('open', () => ws.send(JSON.stringify({ type: 's-hello', pid, profile: { name, avatar: 1, country: '' } })));
      return ws;
    };
    const a = mk(pidA, 'PlayerA');
    const b = mk(pidB, 'PlayerB');
    let opened = 0;
    const onOpen = async () => {
      if (++opened < 2) return;
      await sleep(300);
      a.send(JSON.stringify({ type: 's-request', to: 'p:' + pidB }));
      await sleep(400);
      b.send(JSON.stringify({ type: 's-respond', from: 'p:' + pidA, accept: true }));
      await sleep(500);
      a.close(); b.close();
      resolve(true);
    };
    a.on('open', onOpen); b.on('open', onOpen);
    a.on('error', () => resolve(false)); b.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 8000);
  });
  const ctxH = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'] });
  const pageH = await ctxH.newPage();
  await pageH.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pageH.waitForSelector('#btn-quick', { state: 'visible', timeout: 30000 });
  const pidH = await pageH.evaluate(() => localStorage.getItem('tore.pid'));

  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'] });
  const pageB = await ctxB.newPage();
  const errorsB = [];
  pageB.on('pageerror', (e) => errorsB.push(e.message));
  await throttle(ctxB, pageB, true);
  await pageB.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await pageB.waitForSelector('#btn-quick', { state: 'visible', timeout: 60000 });
  const pidB = await pageB.evaluate(() => localStorage.getItem('tore.pid'));
  check('B: two identities ready + friendship handshake over /social',
    !!pidH && !!pidB && pidH !== pidB && (await socialHandshake(pidH, pidB)), pidH + ' / ' + pidB);

  // A starts a bots match and plays into the round.
  await pageH.click('#btn-quick');
  await pageH.waitForSelector('#btn-pk-play', { state: 'visible', timeout: 10000 });
  await pageH.click('#btn-pk-play');
  await pageH.waitForSelector('#scr-game:not(.hidden)', { timeout: 20000 });
  await pageH.waitForFunction(() => document.querySelectorAll('#hand .pcard').length >= 13, null, { timeout: 20000 });
  for (let i = 0; i < 5; i++) { await tapPlayable(pageH); await sleep(350); }
  const hostTapper = setInterval(() => { tapPlayable(pageH); }, 1500);

  // B opens friends and taps «تماشا» on the in-match friend.
  await pageB.click('#nav-friends');
  let watchClicked = false;
  for (let i = 0; i < 40 && !watchClicked; i++) {
    watchClicked = await pageB.evaluate(() => {
      const btns = [...document.querySelectorAll('#scr-friends button')];
      const b = btns.find((x) => x.textContent.trim() === 'تماشا');
      if (b) { b.click(); return true; }
      return false;
    }).catch(() => false);
    if (!watchClicked) await sleep(1000);
  }
  check('B: «تماشا» offered on the in-match friend and tapped', watchClicked);
  await pageB.waitForSelector('#spec-chip:not(.hidden)', { timeout: 40000 });
  check('B: cold spectator reached the table (spec chip)', true);
  const specHand = await pageB.evaluate(() => document.querySelectorAll('#hand .pcard').length);
  check('B: spectator has NO hand cards', specHand === 0, 'dom hand ' + specHand);
  let violationsB = [];
  let proofB = false;
  let firstTrickB = false;
  const deadlineB = Date.now() + 150000;
  while (Date.now() < deadlineB && !proofB) {
    const trickAudit = await pageB.evaluate(() => [...document.querySelectorAll('#trick .pcard')].map((el) => {
      const img = el.querySelector('img.face');
      return { face: el.dataset.face || '', ready: el.classList.contains('faceready'), back: el.classList.contains('cback'), nw: img ? img.naturalWidth : 0, op: img ? getComputedStyle(img).opacity : '1' };
    })).catch(() => []);
    if (trickAudit.length) firstTrickB = true;
    violationsB = violationsB.concat(blankViolations(trickAudit));
    if (trickAudit.length === 4 && trickAudit.every((c) => c.ready && c.nw > 0)) {
      await pageB.screenshot({ path: path.join(SHOTS, 'cardsfix-spectate-FRESH.jpg'), type: 'jpeg', quality: 88 });
      proofB = true;
      break;
    }
    await sleep(300);
  }
  clearInterval(hostTapper);
  check('B: spectator saw a live trick mid-round', firstTrickB);
  check('B: spectator NEVER saw a blank-white card', violationsB.length === 0,
    violationsB.slice(0, 3).map((v) => v.face + ' op' + v.op).join(','));
  check('B: complete trick captured on the spectator (cardsfix-spectate-FRESH.jpg)', proofB);
  check('B: no page errors on the spectator', errorsB.length === 0, errorsB.slice(0, 3).join(' | '));

  // ---- B-exit: SPECTATE-EXIT (owner bug 2026-11-11, second scope
  // extension): friend-spectate -> exit -> friends -> «کور» must land
  // on a COMPLETE home. Mechanism: the social screens are overlays
  // whose home navs (closeFriends & friends) only HIDE the overlay,
  // assuming #scr-home is alive underneath — but the watch ran
  // render() -> show('scr-game'), which hid #scr-home, and the old
  // exitSpectate hid #scr-game without restoring #scr-home: the
  // «کور» tap revealed the bare body (the blank dark-green field
  // of his screenshot — body's own radial gradient, CSS line ~53).
  await pageB.click('#btn-leave');
  await pageB.waitForSelector('#scr-friends:not(.hidden)', { timeout: 10000 });
  check('B-exit: spectator exit returns to the friends page', true);
  await pageB.click('#frnav-home');
  await sleep(600);
  const homeB = await pageB.evaluate(() => ({
    home: !document.querySelector('#scr-home').classList.contains('hidden'),
    homeDisplay: getComputedStyle(document.querySelector('#scr-home')).display,
    game: !document.querySelector('#scr-game').classList.contains('hidden'),
    friends: !document.querySelector('#scr-friends').classList.contains('hidden'),
    doors: ['#btn-online', '#btn-quick'].every((s) => { const el = document.querySelector(s); return el && el.getBoundingClientRect().width > 0; }),
    nav: !!document.querySelector('#nav-clubs') && document.querySelector('#nav-clubs').getBoundingClientRect().width > 0,
    fanFaces: document.querySelectorAll('#scr-home .pcard').length,
  }));
  check('B-exit: friends -> home nav lands on a COMPLETE home (shell, doors, fans, nav — never the blank field)',
    homeB.home && homeB.homeDisplay !== 'none' && !homeB.game && !homeB.friends && homeB.doors && homeB.nav && homeB.fanFaces > 0,
    JSON.stringify(homeB));
  await pageB.screenshot({ path: path.join(SHOTS, 'spectate-exit-home-FRESH.jpg'), type: 'jpeg', quality: 88 });
  check('B-exit: proof saved (spectate-exit-home-FRESH.jpg)', true);
  await pageB.click('#nav-friends');
  await pageB.waitForSelector('#scr-friends:not(.hidden)', { timeout: 10000 });
  check('B-exit: the landed home is INTERACTIVE (bottom nav opens friends again)', true);
  check('B-exit: no page errors on the exit path', errorsB.length === 0, errorsB.slice(0, 3).join(' | '));
  await ctxB.close();
  await ctxH.close();

  // ================= Phase G: DM on the table =================
  // (third scope extension, owner order + clarification 2026-11-11:
  // «همان چت معمولی باشد، روی میز هم بیاید» — the NORMAL DM also
  // pops on the in-game player's table, and it must make NO
  // difference whether the sender used the چت page or the
  // friends-page 💬: both end in the same s-dm receive. The
  // friends-page 💬 itself is live only while the friend is in a
  // match — the same p.ingame signal as «تماشا» — else dimmed +
  // aria-disabled with a toast on tap.)
  const ctxGA = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'] });
  const pageGA = await ctxGA.newPage();
  const errorsGA = [];
  pageGA.on('pageerror', (e) => errorsGA.push(e.message));
  await pageGA.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pageGA.waitForSelector('#btn-quick', { state: 'visible', timeout: 30000 });
  const pidGA = await pageGA.evaluate(() => localStorage.getItem('tore.pid'));
  const ctxGB = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'] });
  const pageGB = await ctxGB.newPage();
  const errorsGB = [];
  pageGB.on('pageerror', (e) => errorsGB.push(e.message));
  await pageGB.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pageGB.waitForSelector('#btn-quick', { state: 'visible', timeout: 30000 });
  const pidGB = await pageGB.evaluate(() => localStorage.getItem('tore.pid'));
  const pidGC = 'cfdm' + Math.random().toString(36).slice(2, 10);
  check('G: identities + friendships (A<->B, B<->C-idle)',
    !!pidGA && !!pidGB && (await socialHandshake(pidGA, pidGB)) && (await socialHandshake(pidGB, pidGC)),
    pidGA + ' / ' + pidGB + ' / ' + pidGC);

  // A enters a server bot match and keeps playing.
  await pageGA.click('#btn-quick');
  await pageGA.waitForSelector('#btn-pk-play', { state: 'visible', timeout: 10000 });
  await pageGA.click('#btn-pk-play');
  await pageGA.waitForSelector('#scr-game:not(.hidden)', { timeout: 20000 });
  await pageGA.waitForFunction(() => document.querySelectorAll('#hand .pcard').length >= 13, null, { timeout: 20000 });
  const tapperG = setInterval(() => { tapPlayable(pageGA); }, 1500);

  // B opens friends: A's row (carries «تماشا») — 💬 live; C's row — 💬 gated.
  await pageGB.click('#nav-friends');
  await pageGB.waitForSelector('#scr-friends:not(.hidden)', { timeout: 10000 });
  const rowState = () => pageGB.evaluate(() => [...document.querySelectorAll('#fr-list .fr-row')].map((r) => {
    const chat = r.querySelector('button[data-act="chat"]');
    const watch = r.querySelector('button[data-act="watch"]');
    return { chat: !!chat, off: !!(chat && chat.classList.contains('fr-chatbtn-off')),
             ariaDis: chat ? chat.getAttribute('aria-disabled') : null, watch: !!watch };
  }));
  let rowsG = [];
  for (let i = 0; i < 30; i++) { rowsG = await rowState(); if (rowsG.length >= 2 && rowsG.some((r) => r.watch)) break; await sleep(700); }
  const rowGA = rowsG.find((r) => r.watch);
  const rowGC = rowsG.find((r) => !r.watch);
  check('G: 💬 GATING — in-match friend: 💬 ACTIVE (+ «تماشا» on the row)', !!rowGA && rowGA.chat && !rowGA.off, JSON.stringify(rowsG));
  check('G: 💬 GATING — idle friend: 💬 dimmed + aria-disabled', !!rowGC && rowGC.chat && rowGC.off && rowGC.ariaDis === 'true', JSON.stringify(rowsG));
  await pageGB.screenshot({ path: path.join(SHOTS, 'dm-button-gating-FRESH.jpg'), type: 'jpeg', quality: 88 });
  check('G: proof saved (dm-button-gating-FRESH.jpg)', true);

  const tapRowChat = (wantWatch) => pageGB.evaluate((w) => {
    const r = [...document.querySelectorAll('#fr-list .fr-row')].find((x) => !!x.querySelector('button[data-act="watch"]') === w);
    const b = r && r.querySelector('button[data-act="chat"]');
    if (b) { b.click(); return true; }
    return false;
  }, wantWatch);
  check('G: tapped the idle friend\'s gated 💬', await tapRowChat(false));
  await sleep(500);
  const toastState = await pageGB.evaluate(() => ({
    toast: document.querySelector('#toast').textContent,
    toastShown: document.querySelector('#toast').classList.contains('show'),
    dmHidden: document.querySelector('#scr-dm').classList.contains('hidden'),
  }));
  check('G: gated 💬 tap -> toast explains, the DM does NOT open',
    toastState.toastShown && toastState.toast.includes('یوازې هغه وخت') && toastState.dmHidden, JSON.stringify(toastState));

  // SEND PATH 1 — the friends-page 💬 opens A's DM page directly.
  check('G: tapped the in-match friend\'s 💬', await tapRowChat(true));
  await pageGB.waitForSelector('#scr-dm:not(.hidden)', { timeout: 10000 });
  check('G: the active 💬 opens the friend\'s DM page directly', true);
  await pageGB.fill('#dm-inp', 'DM-TEST-ONE سلام');
  await pageGB.click('#btn-dm-send');
  await pageGA.waitForSelector('#dm-overlay .dm-bubble', { timeout: 12000 });
  const bub1 = await pageGA.evaluate(() => {
    const b = document.querySelector('#dm-overlay .dm-bubble');
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    const R = (s) => { const e = document.querySelector(s); if (!e) return null; const q = e.getBoundingClientRect(); return { top: q.top, bottom: q.bottom, left: q.left, right: q.right }; };
    return { text: b.textContent, x: r.x, y: r.y, bottom: r.bottom, right: r.right,
      bg: cs.backgroundColor, bgImg: cs.backgroundImage, shadow: cs.boxShadow, borderW: cs.borderTopWidth,
      strip: R('.scorestrip'), avatar: R('#seat-top .pavatar'),
      name: (b.querySelector('.dm-name') || {}).textContent || '' };
  });
  check('G: SEND PATH 1 (friends 💬) -> overlay pops on A\'s table, top-left, sender + text',
    bub1.text.includes('DM-TEST-ONE') && bub1.name.length > 0 && bub1.x < 60, JSON.stringify(bub1));
  check('G: bubble is BACKGROUND-FREE (transparent bg, no image, no shadow, no border), sits DIRECTLY under the score strip, clear of the top avatar',
    bub1.bg === 'rgba(0, 0, 0, 0)' && bub1.bgImg === 'none' && bub1.shadow === 'none' && bub1.borderW === '0px' &&
    bub1.y >= bub1.strip.bottom - 0.5 &&
    !(bub1.bottom > bub1.avatar.top && bub1.avatar.bottom > bub1.y && bub1.right > bub1.avatar.left && bub1.x < bub1.avatar.right),
    JSON.stringify(bub1));
  const bufBub = await pageGA.screenshot({ type: 'jpeg', quality: 88 });
  fs.writeFileSync(path.join(SHOTS, 'dm-overlay-table-FRESH.jpg'), bufBub);
  fs.writeFileSync(path.join(SHOTS, 'dm-overlay-table2-FRESH.jpg'), bufBub);
  check('G: proofs saved (dm-overlay-table-FRESH.jpg + dm-overlay-table2-FRESH.jpg)', true);
  const unread1 = await pageGA.evaluate((id) => dmUnread.get(id) || 0, 'p:' + pidGB);
  check('G: the DM still landed in the thread + unread badge (unread = 1)', unread1 === 1, 'unread=' + unread1);
  await pageGA.waitForFunction(() => !document.querySelector('#dm-overlay .dm-bubble'), null, { timeout: 9000 });
  check('G: overlay auto-dismisses (~6 s)', true);

  // SEND PATH 2 — the چت page (owner clarification: no difference).
  await pageGB.click('#btn-dm-back');
  await pageGB.waitForSelector('#scr-friends:not(.hidden)', { timeout: 10000 });
  await pageGB.click('#frnav-chat');
  await pageGB.waitForSelector('#scr-chats:not(.hidden)', { timeout: 10000 });
  await pageGB.evaluate(() => { const r = document.querySelector('#ch-list .ch-row'); if (r) r.click(); });
  await pageGB.waitForSelector('#scr-dm:not(.hidden)', { timeout: 10000 });
  await pageGB.fill('#dm-inp', 'DM-TEST-TWO سلام');
  await pageGB.click('#btn-dm-send');
  await pageGA.waitForSelector('#dm-overlay .dm-bubble', { timeout: 12000 });
  const bub2txt = await pageGA.evaluate(() => document.querySelector('#dm-overlay .dm-bubble').textContent);
  check('G: SEND PATH 2 (چت page) -> overlay pops on A\'s table the same way', bub2txt.includes('DM-TEST-TWO'), bub2txt);
  await pageGA.click('#dm-overlay .dm-bubble');
  await sleep(300);
  check('G: tap dismisses the overlay at once', await pageGA.evaluate(() => !document.querySelector('#dm-overlay .dm-bubble')));
  const threadLen = await pageGA.evaluate((id) => (dmThreads.get(id) || []).length, 'p:' + pidGB);
  check('G: both messages are in A\'s DM thread', threadLen >= 2, 'thread=' + threadLen);

  // A leaves the match -> B's 💬 for A gates off.
  clearInterval(tapperG);
  await pageGA.click('#btn-leave');
  await pageGA.waitForSelector('#ov-exit.show', { timeout: 8000 });
  await pageGA.click('#btn-exit-confirm');
  await pageGA.waitForSelector('#scr-home:not(.hidden)', { timeout: 10000 });
  await pageGB.click('#btn-dm-back');
  await pageGB.waitForSelector('#scr-chats:not(.hidden)', { timeout: 10000 });
  await pageGB.click('#chnav-friends');
  await pageGB.waitForSelector('#scr-friends:not(.hidden)', { timeout: 10000 });
  let gatedOff = false;
  for (let i = 0; i < 24 && !gatedOff; i++) {
    const rs = await rowState();
    gatedOff = rs.length >= 2 && rs.every((r) => r.off) && !rs.some((r) => r.watch);
    if (!gatedOff) await sleep(700);
  }
  check('G: after A leaves the match, B\'s 💬 for A gates OFF too', gatedOff);

  // LOBBY state: A in a room lobby; B DMs -> no overlay (badge only).
  await pageGA.click('#btn-online');
  await pageGA.waitForSelector('#btn-pk-play', { state: 'visible', timeout: 10000 });
  await pageGA.click('#btn-pk-play');
  await pageGA.waitForSelector('#scr-lobby:not(.hidden)', { timeout: 20000 });
  await pageGB.click('#frnav-chat');
  await pageGB.waitForSelector('#scr-chats:not(.hidden)', { timeout: 10000 });
  await pageGB.evaluate(() => { const r = document.querySelector('#ch-list .ch-row'); if (r) r.click(); });
  await pageGB.waitForSelector('#scr-dm:not(.hidden)', { timeout: 10000 });
  await pageGB.fill('#dm-inp', 'DM-TEST-THREE');
  await pageGB.click('#btn-dm-send');
  await sleep(2500);
  check('G: NO overlay while A is in the LOBBY (badge only)',
    await pageGA.evaluate(() => !document.querySelector('#dm-overlay .dm-bubble')));

  // SPECTATOR state: B watches A's started game; A DMs B -> no overlay.
  await pageGA.click('#btn-start');
  await pageGA.waitForSelector('#scr-game:not(.hidden)', { timeout: 20000 });
  await pageGA.waitForFunction(() => document.querySelectorAll('#hand .pcard').length >= 13, null, { timeout: 20000 });
  const tapperG2 = setInterval(() => { tapPlayable(pageGA); }, 1500);
  await pageGB.click('#btn-dm-back');
  await pageGB.waitForSelector('#scr-chats:not(.hidden)', { timeout: 10000 });
  await pageGB.click('#chnav-friends');
  await pageGB.waitForSelector('#scr-friends:not(.hidden)', { timeout: 10000 });
  let specInG = false;
  for (let i = 0; i < 40 && !specInG; i++) {
    specInG = await pageGB.evaluate(() => {
      const b = [...document.querySelectorAll('#scr-friends button')].find((x) => x.textContent.trim() === 'تماشا');
      if (b) { b.click(); return true; }
      return false;
    }).catch(() => false);
    if (!specInG) await sleep(700);
  }
  check('G: B entered spectate on A\'s game', specInG);
  await pageGB.waitForSelector('#spec-chip:not(.hidden)', { timeout: 15000 });
  await pageGA.evaluate((id) => socialSend({ type: 's-dm', to: id, text: 'DM-TEST-FOUR' }), 'p:' + pidGB);
  await sleep(2500);
  const specDm = await pageGB.evaluate((id) => ({ bubble: !!document.querySelector('#dm-overlay .dm-bubble'), unread: dmUnread.get(id) || 0 }), 'p:' + pidGA);
  check('G: NO overlay while B is SPECTATING (badge only)', !specDm.bubble && specDm.unread >= 1, JSON.stringify(specDm));
  clearInterval(tapperG2);
  check('G: no page errors (A)', errorsGA.length === 0, errorsGA.slice(0, 3).join(' | '));
  check('G: no page errors (B)', errorsGB.length === 0, errorsGB.slice(0, 3).join(' | '));
  await ctxGA.close();
  await ctxGB.close();

  // ================= Phase D: failure injection =================
  // Network-layer injection (page.route cannot see past the service
  // worker): a tiny static server rooted at deploy/ that 404s sw.js
  // (this phase is fully SW-free), destroys the FIRST /cards/8D.png
  // request at the socket, slow-serves its retries, and destroys
  // EVERY /cards/KH.png request. '8D' stands in for the recoverable
  // face (QS itself is pre-used by the home menu fans).
  const http = await import('node:http');
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.json': 'application/json' };
  let d8Hits = 0, khHits = 0;
  const dsrv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/sw.js') { res.writeHead(404); res.end('no sw in this phase'); return; }
    if (u.pathname === '/cards/8D.png') {
      d8Hits++;
      if (d8Hits === 1) { req.socket.destroy(); return; }
      setTimeout(() => {
        try { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(fs.readFileSync(path.join(ROOT, 'deploy', 'cards', '8D.png'))); } catch { /* gone */ }
      }, 1500);
      return;
    }
    if (u.pathname === '/cards/KH.png') { khHits++; req.socket.destroy(); return; }
    const file = path.join(ROOT, 'deploy', u.pathname === '/' ? 'index.html' : u.pathname);
    if (!file.startsWith(path.join(ROOT, 'deploy')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => dsrv.listen(8861, '127.0.0.1', r));
  const DBASE = 'http://127.0.0.1:8861';
  const ctxD = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const pageD = await ctxD.newPage();
  const warns = [];
  pageD.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') warns.push(m.text()); });
  await pageD.goto(DBASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pageD.waitForSelector('#btn-quick', { state: 'visible', timeout: 30000 });
  const swFree = await pageD.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return true;
    const regs = await navigator.serviceWorker.getRegistrations();
    return regs.length === 0 && !navigator.serviceWorker.controller;
  });
  check('D: phase runs with NO service worker (Telegram-webview condition)', swFree);
  await pageD.evaluate(() => {
    const a = cardEl('8D'); a.id = 'probe-qs'; document.body.appendChild(a);
    const b = cardEl('KH'); b.id = 'probe-kh'; document.body.appendChild(b);
  });
  await sleep(400);
  const duringD = await pageD.evaluate(() => {
    const q = document.querySelector('#probe-qs');
    return { qsBack: q.classList.contains('cback'), qsReady: q.classList.contains('faceready') };
  });
  check('D: while the face is missing the card wears the plum back (not white)', duringD.qsBack === true && duringD.qsReady === false,
    JSON.stringify(duringD));
  const qsRecovered = await pageD.waitForFunction(() => {
    const q = document.querySelector('#probe-qs');
    const img = q && q.querySelector('img.face');
    return q && q.classList.contains('faceready') && img && img.naturalWidth > 0;
  }, null, { timeout: 20000 }).then(() => true).catch(() => false);
  check('D: first 8D.png destroyed at the socket -> the RETRY recovered the face', qsRecovered && d8Hits >= 2, '8D server hits ' + d8Hits);
  await sleep(5000); // KH: initial + retry + registry attempts all destroyed by now
  const khState = await pageD.evaluate(() => {
    const k = document.querySelector('#probe-kh');
    const img = k.querySelector('img.face');
    return { ready: k.classList.contains('faceready'), back: k.classList.contains('cback'), op: getComputedStyle(img).opacity, nw: img.naturalWidth };
  });
  check('D: KH.png permanently destroyed -> card settles as the plum back, face invisible, never white',
    khState.ready === false && khState.back === true && khState.op === '0' && khState.nw === 0 && khHits >= 2,
    JSON.stringify(khState) + ' KH server hits ' + khHits);
  check('D: the failed face logged a console warning', warns.some((w) => w.includes('KH')), warns.slice(0, 2).join(' | '));
  await ctxD.close();
  dsrv.close();

  // ================= Phase E: offline nav guards =================
  const ctxE = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'] });
  const pageE = await ctxE.newPage();
  const errorsE = [];
  pageE.on('pageerror', (e) => errorsE.push(e.message));
  await pageE.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pageE.waitForSelector('#btn-quick', { state: 'visible', timeout: 30000 });
  // Go offline the documented way: context offline + the CDP
  // re-apply that makes navigator.onLine honest on SW-served pages
  // (same quirk + fix as the offline driver).
  await ctxE.setOffline(true);
  const cdpE = await ctxE.newCDPSession(pageE);
  await cdpE.send('Network.enable');
  await cdpE.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(400);
  check('E: navigator.onLine is false (offline)', await pageE.evaluate(() => navigator.onLine === false));
  const navTaps = [
    ['#nav-clubs', 'کلبونه (bottom nav)'],
    ['#nav-friends', 'ملګري (bottom nav)'],
    ['#btn-friends-card', 'ملګري (home friends card)'],
    ['#nav-chat', 'چت (bottom nav)'],
  ];
  let navProof = false;
  for (const [sel, label] of navTaps) {
    await pageE.click(sel);
    await pageE.waitForSelector('#ov-nonet.show', { timeout: 8000 });
    const st = await pageE.evaluate(() => ({
      popup: document.querySelector('#ov-nonet').classList.contains('show'),
      icon: (document.querySelector('#ov-nonet .nonet-ico svg') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width,
      clubs: !document.querySelector('#scr-clubs').classList.contains('hidden'),
      friends: !document.querySelector('#scr-friends').classList.contains('hidden'),
      chats: !document.querySelector('#scr-chats').classList.contains('hidden'),
      home: !document.querySelector('#scr-home').classList.contains('hidden'),
    }));
    check('E: OFFLINE tap ' + label + ' -> 📵 popup, page unchanged (still home)',
      st.popup && st.icon > 20 && !st.clubs && !st.friends && !st.chats && st.home, JSON.stringify(st));
    if (!navProof) {
      await pageE.screenshot({ path: path.join(SHOTS, 'offline-nonet-nav-FRESH.jpg'), type: 'jpeg', quality: 88 });
      navProof = true;
    }
    await pageE.click('#btn-nonet-ok');
    await sleep(350);
    const gone = await pageE.evaluate(() => !document.querySelector('#ov-nonet').classList.contains('show'));
    check('E: popup dismisses («سمه ده») after ' + label, gone);
  }
  check('E: proof saved (offline-nonet-nav-FRESH.jpg)', navProof);
  // Profile is NOT guarded — it works offline by design.
  await pageE.click('#btn-profile');
  await sleep(600);
  const profOffline = await pageE.evaluate(() => !document.querySelector('#scr-profile').classList.contains('hidden') &&
    !document.querySelector('#ov-nonet').classList.contains('show'));
  check('E: profile still opens OFFLINE (not guarded)', profOffline);
  // Back online: the three pages open normally (regression).
  await ctxE.setOffline(false);
  await cdpE.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(500);
  await pageE.evaluate(() => { const b = document.querySelector('#pfnav-home'); if (b) b.click(); });
  await sleep(400);
  await pageE.click('#nav-clubs');
  await pageE.waitForSelector('#scr-clubs:not(.hidden)', { timeout: 10000 });
  check('E: ONLINE clubs page opens', true);
  await pageE.click('#btn-cl-home');
  await pageE.waitForSelector('#scr-home:not(.hidden)', { timeout: 10000 });
  await pageE.click('#nav-friends');
  await pageE.waitForSelector('#scr-friends:not(.hidden)', { timeout: 10000 });
  check('E: ONLINE friends page opens', true);
  await pageE.click('#frnav-chat');
  await pageE.waitForSelector('#scr-chats:not(.hidden)', { timeout: 10000 });
  check('E: ONLINE chat page opens', true);
  check('E: no page errors', errorsE.length === 0, errorsE.slice(0, 3).join(' | '));
  await ctxE.close();
} catch (e) {
  check('driver completed all phases', false, e.message);
}

await browser.close();
srv.kill();
console.log(failures === 0 ? '\nALL CARDSFIX PROOF CHECKS PASSED' : '\n' + failures + ' CARDSFIX CHECK(S) FAILED');
process.exit(failures ? 1 : 0);
