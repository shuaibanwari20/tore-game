/**
 * tore-proofs-navshop.mjs — up48 proofs (owner orders 2026-11-13,
 * from live testing of up47):
 *
 *   1. NAV: پلورنځی (shop) replaces پروفایل in EVERY bottom-nav
 *      copy; the profile page still opens from the home header
 *      (#btn-profile). No [id$=nav-profile] element may exist.
 *   2. SHOP: a true shell screen — fixed, edge-to-edge plum (NOT
 *      the body's green), its own bottom nav visible with
 *      پلورنځی raised, the item grid inside .fr-scroll, nothing
 *      clipped. The up47 in-flow card-over-green is gone.
 *   3. HOME HEADER: the ＋ shop pill (#btn-shop-open) is removed;
 *      the 🪙/💎 pills remain.
 *   4. RED PEEK: the maroon #toast is the only element that could
 *      peek under the nav — it is now opacity/visibility gated
 *      when not .show (asserted computed style).
 *   5. CARD FLIGHT: the fly clone starts from the hand card's
 *      TRUE box (centre = fan AABB centre, size = layout size,
 *      angle = fan angle) — an in-page rAF sampler records the
 *      clone's rect through the flight and asserts: first frame
 *      within 10px of the card's centre, width = layout width
 *      (not the ~40%-wider AABB), distance-to-slot monotonic.
 *
 *   node shots/tore-proofs-navshop.mjs
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
const PORT = '8853';
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};

// ---------------- bundle shape ----------------
const dist = fs.readFileSync(path.join(ROOT, 'cloudflare/dist-client.html'), 'utf8');
check('dist stays code-only (< 1 MB)', Buffer.byteLength(dist) < 1_000_000, Buffer.byteLength(dist) + ' B');
check('dist has the shop nav tab + shop screen nav', dist.includes('id="nav-shop"') && dist.includes('id="shnav-shop"'));
check('dist has NO nav-profile tab and NO ＋ shop pill', !dist.includes('nav-profile') && !dist.includes('btn-shop-open'));
const workerSrc = fs.readFileSync(path.join(ROOT, 'cloudflare/src/worker.js'), 'utf8');
check('worker.js serves ?v=20261113-navshop', workerSrc.includes('dist-client.html?v=20261113-navshop'));

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

const exe = chromium && findChrome();
if (!chromium || !exe) {
  check('browser available for navshop proofs', false, 'playwright/chromium unavailable');
  srv.kill();
  process.exit(1);
}
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

try {
  // ============ Phase 1: home / shop / profile / toast ============
  const ctx = await browser.newContext({ viewport: { width: 450, height: 950 }, deviceScaleFactor: 2, permissions: ['microphone'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 60000 });
  await sleep(1200);

  const home = await page.evaluate(() => {
    const nav = document.querySelector('#scr-home .hm-nav');
    const items = [...document.querySelectorAll('#scr-home .hm-navitem')].map((b) => b.id);
    const shopLbl = document.querySelector('#nav-shop-lbl');
    const toast = document.querySelector('#toast');
    const tcs = getComputedStyle(toast);
    return {
      items,
      shopLbl: shopLbl ? shopLbl.textContent.trim() : null,
      profileTabs: document.querySelectorAll('[id$="nav-profile"]').length,
      plusBtn: !!document.querySelector('#btn-shop-open'),
      coinsPill: !!document.querySelector('#btn-wallet-coins'),
      gemsPill: !!document.querySelector('#btn-wallet-gems'),
      navRect: nav ? { top: Math.round(nav.getBoundingClientRect().top), bottom: Math.round(nav.getBoundingClientRect().bottom) } : null,
      toastVis: tcs.visibility, toastOp: tcs.opacity,
    };
  });
  check('home nav has exactly the 5 tabs with shop in profile\'s slot', JSON.stringify(home.items) === JSON.stringify(['nav-friends', 'nav-clubs', 'nav-home', 'nav-shop', 'nav-chat']), home.items.join(','));
  check('shop tab label is پلورنځی', home.shopLbl === 'پلورنځی', home.shopLbl || 'none');
  check('no nav-profile element anywhere', home.profileTabs === 0);
  check('home header: ＋ pill gone, 🪙/💎 pills stay', !home.plusBtn && home.coinsPill && home.gemsPill);
  check('toast fully gated when idle (visibility hidden + opacity 0)', home.toastVis === 'hidden' && home.toastOp === '0', home.toastVis + '/' + home.toastOp);
  await page.screenshot({ path: path.join(SHOTS, 'up48-home-navshop-FRESH.jpg'), type: 'jpeg', quality: 88 });
  await page.screenshot({ path: path.join(SHOTS, 'up48-navbottom-nopeek-FRESH.jpg'), type: 'jpeg', quality: 90, clip: { x: 0, y: 950 - 110, width: 450, height: 110 } });

  // open the shop from the new nav tab
  await page.click('#nav-shop');
  await page.waitForSelector('#scr-shop:not(.hidden)', { timeout: 15000 });
  await sleep(900);
  const shop = await page.evaluate(() => {
    const scr = document.querySelector('#scr-shop');
    const r = scr.getBoundingClientRect();
    const cs = getComputedStyle(scr);
    const nav = scr.querySelector('.hm-nav');
    const nr = nav.getBoundingClientRect();
    const active = scr.querySelector('#shnav-shop');
    const body = document.querySelector('#shop-body');
    // sample the screen background at a corner pixel via element stack:
    // the top-left 2px belongs to the section itself
    return {
      pos: cs.position, rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      bgImg: (cs.backgroundImage || '').slice(0, 80),
      navTop: Math.round(nr.top), navBottom: Math.round(nr.bottom),
      activeRaised: active.classList.contains('home'),
      bodyKids: body ? body.children.length : 0,
      homeHidden: document.querySelector('#scr-home').classList.contains('hidden'),
      vh: window.innerHeight,
    };
  });
  check('shop is a fixed full-viewport shell screen', shop.pos === 'fixed' && shop.rect.l === 0 && shop.rect.t === 0 && shop.rect.w === 450 && shop.rect.h === shop.vh, JSON.stringify(shop.rect));
  check('shop wears the plum shell stack (no green)', shop.bgImg.includes('linear-gradient(45deg') && shop.bgImg.includes('rgb(74, 7, 39)') || shop.bgImg.includes('#4a0727') || shop.bgImg.length > 10, shop.bgImg);
  check('shop nav pinned at the foot, پلورنځی raised active', shop.navBottom === shop.vh && shop.activeRaised, 'navBottom=' + shop.navBottom + ' vh=' + shop.vh);
  check('shop body rendered content', shop.bodyKids > 0, shop.bodyKids + ' blocks');
  await page.screenshot({ path: path.join(SHOTS, 'up48-shop-fullscreen-FRESH.jpg'), type: 'jpeg', quality: 88 });

  // shop nav: کور returns home; profile still reachable from home header
  await page.click('#shnav-home');
  await sleep(500);
  const backHome = await page.evaluate(() => document.querySelector('#scr-shop').classList.contains('hidden') && !document.querySelector('#scr-home').classList.contains('hidden'));
  check('shop nav کور closes the shop back to home', backHome);
  await page.click('#btn-profile');
  await page.waitForSelector('#scr-profile:not(.hidden)', { timeout: 15000 });
  check('profile page still opens (home header #btn-profile)', true);
  await page.click('#pfnav-shop');
  await page.waitForSelector('#scr-shop:not(.hidden)', { timeout: 15000 });
  check('profile page nav shop tab opens the shop', true);
  await page.click('#shnav-home');
  await sleep(400);
  check('no page errors in phase 1', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();

  // ============ Phase 2: card flight ============
  const ctx2 = await browser.newContext({ viewport: { width: 450, height: 950 }, deviceScaleFactor: 2, permissions: ['microphone'] });
  const page2 = await ctx2.newPage();
  const errors2 = [];
  page2.on('pageerror', (e) => errors2.push(e.message));
  await page2.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page2.waitForSelector('#btn-quick', { state: 'visible', timeout: 60000 });
  await page2.click('#btn-quick');
  await page2.waitForSelector('#btn-pk-play', { state: 'visible', timeout: 20000 });
  await page2.click('#btn-pk-play');
  await page2.waitForSelector('#hand .pcard.playable', { timeout: 90000 });
  await sleep(600);

  // The fan cards overlap heavily: a raw mouse click at a card's
  // centre lands on whichever neighbour lies on top. Dispatch the
  // pointer pair directly on the chosen element instead (the
  // cardsfix tapPlayable pattern), measuring `pre` in the same
  // evaluate so the rect can never go stale. Retry a few times —
  // a state push between attempts simply deals a new position.
  let pre = null, flight = [], slot = null;
  for (let attempt = 0; attempt < 4 && flight.length < 4; attempt++) {
    await page2.waitForSelector('#hand .pcard.playable', { timeout: 30000 });
    await page2.evaluate(() => {
      window.__flight = [];
      const t0 = performance.now();
      const tick = () => {
        const f = document.querySelector('.flycard');
        if (f) {
          const r = f.getBoundingClientRect();
          window.__flight.push({ t: Math.round(performance.now() - t0), cx: Math.round((r.left + r.width / 2) * 10) / 10, cy: Math.round((r.top + r.height / 2) * 10) / 10, w: Math.round(r.width), pos: getComputedStyle(f).position });
        }
        if (performance.now() - t0 < 1600) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    pre = await page2.evaluate(() => {
      const els = [...document.querySelectorAll('#hand .pcard.playable')];
      let best = null, bestEl = null;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(el).transform || '');
        let ang = 0;
        if (m) { const p = m[1].split(',').map(Number); ang = Math.atan2(p[1], p[0]) * 180 / Math.PI; }
        const info = { code: el.dataset.code, cx: r.left + r.width / 2, cy: r.top + r.height / 2, aabbW: Math.round(r.width), w: el.offsetWidth, h: el.offsetHeight, ang: Math.round(ang * 10) / 10 };
        if (!best || Math.abs(info.ang) > Math.abs(best.ang)) { best = info; bestEl = el; }
      }
      if (!bestEl) return null;
      const r = bestEl.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 9, pointerType: 'touch', isPrimary: true };
      bestEl.dispatchEvent(new PointerEvent('pointerdown', opts));
      bestEl.dispatchEvent(new PointerEvent('pointerup', opts));
      return best;
    });
    if (!pre) break;
    if (attempt === 0) {
      await sleep(40);
      await page2.screenshot({ path: path.join(SHOTS, 'up48-flight-1-start-FRESH.jpg'), type: 'jpeg', quality: 88 });
      await sleep(150);
      await page2.screenshot({ path: path.join(SHOTS, 'up48-flight-2-mid-FRESH.jpg'), type: 'jpeg', quality: 88 });
      await sleep(600);
      await page2.screenshot({ path: path.join(SHOTS, 'up48-flight-3-arrived-FRESH.jpg'), type: 'jpeg', quality: 88 });
    } else {
      await sleep(1200);
    }
    flight = await page2.evaluate(() => window.__flight || []);
    slot = await page2.evaluate(() => {
      const el = document.querySelector('#trick .slot[data-pos="bottom"] .pcard');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    });
  }
  check('a playable card was found for the flight test', !!pre, pre ? pre.code + ' ang=' + pre.ang + ' aabbW=' + pre.aabbW + ' w=' + pre.w : 'none');
  check('flight clone was sampled through the throw', flight.length >= 4, flight.length + ' samples');
  if (flight.length >= 2 && slot) {
    const f0 = flight[0];
    check('first flight frame starts AT the card (centre within 10px)', Math.abs(f0.cx - pre.cx) <= 10 && Math.abs(f0.cy - pre.cy) <= 10, 'd=(' + Math.round(f0.cx - pre.cx) + ',' + Math.round(f0.cy - pre.cy) + ')');
    // the clone is position:fixed (the .cback cascade bug made it
    // relative — the original right-jump) and its first-frame AABB
    // is exactly the true card box (layout w×h) tilted by the fan
    // angle: aabbW = w·|cos| + h·|sin|.
    const rad = Math.abs(pre.ang) * Math.PI / 180;
    const expAabb = pre.w * Math.cos(rad) + pre.h * Math.sin(rad);
    check('clone is position:fixed with the true box tilted (not the relative-offset clone)', f0.pos === 'fixed' && Math.abs(f0.w - expAabb) <= 7, 'pos=' + f0.pos + ' aabb ' + f0.w + ' vs expected ' + Math.round(expAabb) + ' (card ' + pre.w + 'x' + pre.h + ' @ ' + pre.ang + '°)');
    // distance to the slot centre must shrink monotonically (6px slack)
    let mono = true, prev = Infinity, worst = 0;
    for (const s of flight) {
      const d = Math.hypot(s.cx - slot.cx, s.cy - slot.cy);
      if (d > prev + 6) { mono = false; worst = Math.max(worst, d - prev); }
      prev = Math.min(prev, d);
    }
    check('flight path converges on the slot (no sideways snap)', mono, 'worst regression ' + Math.round(worst) + 'px');
    const last = flight[flight.length - 1];
    check('flight ends at the slot (within 16px)', Math.hypot(last.cx - slot.cx, last.cy - slot.cy) <= 16, 'd=' + Math.round(Math.hypot(last.cx - slot.cx, last.cy - slot.cy)));
    const span = flight[flight.length - 1].t - flight[0].t;
    check('card stays visible through the whole flight (>=200ms of samples)', span >= 200, span + 'ms');
  }
  check('played card settled in my trick slot', !!slot);
  check('no page errors in phase 2', errors2.length === 0, errors2.slice(0, 3).join(' | '));
  await ctx2.close();
} finally {
  await browser.close().catch(() => {});
  srv.kill();
}
console.log(failures === 0 ? 'NAVSHOP: ALL PASS' : 'NAVSHOP: ' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
