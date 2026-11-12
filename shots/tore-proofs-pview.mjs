/**
 * tore-proofs-pview.mjs — proofs for the 2026-11-12 up36 batch:
 *   1 PVIEW — tapping a player's avatar OR name on the friends
 *      page opens his FULL profile (#scr-pview: the same magenta
 *      card family as my own profile — photo frame with name +
 *      country at its base, real شمېرې from the server, club
 *      name) with a state-aware friend button (friend → «دوست دی»
 *      disabled; stranger → «د دوستۍ غوښتنه» that really sends).
 *      Also wired from ID search results, the table/lobby player
 *      menu and the club menus; the old #ov-playerview is gone.
 *   4 FRMENU RESTYLE — the friends-row ⋯ popover (#ov-friendmenu)
 *      and the player menu (#ov-playermenu) left the old dark
 *      emerald for the Ludo magenta card + dark-plum rows.
 *   5 PHOTO VIEWER — tapping the photo on my profile AND on the
 *      player profile opens it LARGE (#ov-photoview, felt-viewer
 *      pattern); the frame pencil still opens ONLY the editor.
 *   3 CLUBS NOTABS — the discovery tabs are deleted: no tab
 *      elements, ONE browse listing (stage + chips + grid),
 *      name search works, the create pill works, and the
 *      s-clubs-changed live re-query still refreshes the grid.
 * Boots the deploy host (the shipped artifact) and drives the
 * real client in three browser contexts + one raw social client.
 *   node shots/tore-proofs-pview.mjs
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
const PORT = '8857';
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const shot = (page, name) => page.screenshot({ path: path.join(ROOT, 'shots', name) });

// ---------------- bundle shape ----------------
const dist = fs.readFileSync(path.join(ROOT, 'cloudflare/dist-client.html'), 'utf8');
check('dist carries the pview screen + s-profile + photo viewer',
  dist.includes('scr-pview') && dist.includes('s-profile') && dist.includes('ov-photoview'));
check('dist no longer carries the old #ov-playerview popup', !dist.includes('id="ov-playerview"') && !dist.includes('function fillProfileView'));
check('dist no longer carries the clubs discovery tabs', !dist.includes('cl-tab-explore') && !dist.includes('cl-pane-mine'));
const workerSrc = fs.readFileSync(path.join(ROOT, 'cloudflare/src/worker.js'), 'utf8');
check('worker.js serves ?v=20261112-player', workerSrc.includes('dist-client.html?v=20261112-player'));

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

// ---------------- raw social client (the stranger C) ----------------
function rawSocial(pid, name) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/social');
    const api = { ws, uid: null, me: null, msgs: [] };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      api.msgs.push(m);
      if (m.type === 's-init') { api.uid = String(m.uid); api.me = m.me; resolve(api); }
    });
    ws.on('open', () => ws.send(JSON.stringify({ type: 's-hello', pid, profile: { name, avatar: 'av7', country: 'هند' } })));
    ws.on('error', () => resolve(api));
    setTimeout(() => resolve(api), 10000);
  });
}
function socialHandshake(pidA, nameA, pidB, nameB) {
  return new Promise((resolve) => {
    const mk = (pid, name) => {
      const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/social');
      ws.on('open', () => ws.send(JSON.stringify({ type: 's-hello', pid, profile: { name, avatar: 'av1', country: '' } })));
      return ws;
    };
    const a = mk(pidA, nameA); const b = mk(pidB, nameB);
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
}

// ---------------- browser ----------------
const exe = chromium && findChrome();
if (!chromium || !exe) {
  check('browser available for pview proofs', false, 'playwright/chromium unavailable');
  srv.kill();
  process.exit(1);
}
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const errs = [];
async function bootPage(tag) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(tag + ': ' + e.message));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 60000 });
  await sleep(600);
  return { ctx, page };
}
async function setName(page, name) {
  await page.click('#btn-profile');
  await page.waitForSelector('#scr-profile:not(.hidden)', { timeout: 15000 });
  await page.click('#btn-pf-edit-av');
  await page.waitForSelector('#ov-pfedit.show', { timeout: 8000 });
  await page.fill('#pf-name', name);
  await page.click('#btn-profile-save'); // persists + closes popup + closeProfile()
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 10000 });
}

try {
  const A = await bootPage('A');
  const B = await bootPage('B');
  await setName(A.page, 'AhmadView');
  await setName(B.page, 'BilalView');
  const pidA = await A.page.evaluate(() => localStorage.getItem('tore.pid'));
  const pidB = await B.page.evaluate(() => localStorage.getItem('tore.pid'));
  check('setup: both pages hold player ids', !!pidA && !!pidB && pidA !== pidB, pidA + ' / ' + pidB);
  check('setup: A and B befriended (raw handshake)', await socialHandshake(pidA, 'AhmadView', pidB, 'BilalView'));
  const C = await rawSocial('pviewC001', 'CemView');
  check('setup: stranger C is in the directory with a uid', !!C.uid, String(C.uid));

  // ---- B creates his club (one tap) so A's view of B names it ----
  await B.page.click('#nav-clubs');
  await B.page.waitForSelector('#btn-cl-create', { state: 'visible', timeout: 15000 });
  await B.page.click('#btn-cl-create');
  await B.page.waitForSelector('#btn-poll-create', { state: 'visible', timeout: 20000 });
  const clubName = await B.page.evaluate(() => (document.querySelector('#cl-name') || {}).textContent || '');
  check('setup: B created his club (room open)', clubName.includes('BilalView'), clubName.trim());
  await B.page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }); // reload = the driver's clean club-room exit (membership persists)
  await B.page.waitForSelector('#btn-quick', { state: 'visible', timeout: 60000 });
  await sleep(500);

  // ================= 1: friend profile via AVATAR tap =================
  await A.page.click('#nav-friends');
  await A.page.waitForSelector('#fr-list .fr-row', { state: 'visible', timeout: 15000 });
  await sleep(500);
  const bUid = await A.page.evaluate(() => {
    const list = (typeof socialData !== 'undefined' && socialData && socialData.friends) || [];
    const f = list.find((x) => (x.name || '').includes('Bilal'));
    return f ? String(f.uid) : '';
  });
  await A.page.click('#fr-list .fr-row .fr-who .pavatar');
  await A.page.waitForSelector('#scr-pview:not(.hidden)', { timeout: 10000 });
  await A.page.waitForFunction(() => (document.querySelector('#pv2-stat-club') || {}).textContent === 'BilalView', null, { timeout: 10000 });
  const pv1 = await A.page.evaluate(() => ({
    name: document.querySelector('#pv2-name').textContent,
    id: document.querySelector('#pv2-id').textContent,
    friends: document.querySelector('#pv2-stat-friends').textContent,
    club: document.querySelector('#pv2-stat-club').textContent,
    played: document.querySelector('#pv2-stat-played').textContent,
    won: document.querySelector('#pv2-stat-won').textContent,
    lost: document.querySelector('#pv2-stat-lost').textContent,
    btnText: document.querySelector('#btn-pv2-friend').textContent,
    btnDisabled: document.querySelector('#btn-pv2-friend').disabled,
    btnHidden: document.querySelector('#btn-pv2-friend').classList.contains('hidden'),
    friendsHidden: document.querySelector('#scr-friends').classList.contains('hidden'),
  }));
  check('friend profile (avatar tap): full page with his real data',
    pv1.name.includes('BilalView') && pv1.id === bUid && pv1.friends === '1' && pv1.club === 'BilalView' &&
    pv1.played === '0' && pv1.won === '0' && pv1.lost === '0' && pv1.friendsHidden,
    JSON.stringify(pv1));
  check('friend profile: friend button shows «دوست دی», disabled',
    pv1.btnText.includes('دوست دی') && pv1.btnDisabled && !pv1.btnHidden, pv1.btnText);
  await shot(A.page, 'pview-friend-FRESH.jpg');

  // ---- photo viewer on the player profile (item 5) ----
  await A.page.click('#pv2-preview-av');
  await A.page.waitForSelector('#ov-photoview.show', { timeout: 8000 });
  const phv = await A.page.evaluate(() => {
    const p = document.querySelector('#ov-photoview .pavatar');
    const r = p.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  check('photo viewer opens from the player profile photo, big', phv.w >= 240 && phv.h >= 240, JSON.stringify(phv));
  await A.page.mouse.click(8, 8); // backdrop tap closes (felt-viewer pattern)
  await A.page.waitForFunction(() => !document.querySelector('#ov-photoview').classList.contains('show'), null, { timeout: 5000 });
  check('photo viewer closes on backdrop tap', true);
  await A.page.click('#btn-pv2-close');
  await A.page.waitForSelector('#scr-friends:not(.hidden)', { timeout: 8000 });
  check('profile ✖ returns to the friends page', true);

  // ================= 1b: friend profile via NAME tap =================
  await A.page.click('#fr-list .fr-row .fr-name');
  await A.page.waitForSelector('#scr-pview:not(.hidden)', { timeout: 10000 });
  const nm2 = await A.page.evaluate(() => document.querySelector('#pv2-name').textContent);
  check('friend profile (name tap): opens too', nm2.includes('BilalView'), nm2);
  await A.page.click('#btn-pv2-close');
  await A.page.waitForSelector('#scr-friends:not(.hidden)', { timeout: 8000 });

  // ================= 1c: stranger via ID search =================
  await A.page.click('#btn-fr-opensearch');
  await A.page.waitForSelector('#fr-searchbox:not(.hidden)', { timeout: 8000 });
  await A.page.fill('#fr-search-inp', C.uid);
  await A.page.click('#btn-fr-search');
  await A.page.waitForSelector('#fr-results .fr-row', { state: 'visible', timeout: 10000 });
  await A.page.click('#fr-results .fr-row .fr-who');
  await A.page.waitForSelector('#scr-pview:not(.hidden)', { timeout: 10000 });
  await A.page.waitForFunction(() => {
    const b = document.querySelector('#btn-pv2-friend');
    return b && !b.classList.contains('hidden') && (b.textContent || '').length > 2;
  }, null, { timeout: 10000 });
  const pvS = await A.page.evaluate(() => ({
    name: document.querySelector('#pv2-name').textContent,
    btnText: document.querySelector('#btn-pv2-friend').textContent,
    btnDisabled: document.querySelector('#btn-pv2-friend').disabled,
  }));
  check('stranger profile: name + «د دوستۍ غوښتنه» request button, enabled',
    pvS.name.includes('CemView') && pvS.btnText.includes('د دوستۍ غوښتنه') && !pvS.btnDisabled, JSON.stringify(pvS));
  await shot(A.page, 'pview-stranger-FRESH.jpg');
  await A.page.click('#btn-pv2-friend');
  await A.page.waitForFunction(() => document.querySelector('#btn-pv2-friend').disabled, null, { timeout: 8000 });
  const pvS2 = await A.page.evaluate(() => document.querySelector('#btn-pv2-friend').textContent);
  check('stranger profile: after the tap the button is pending «په تمه»', pvS2.includes('په تمه'), pvS2);
  await sleep(700);
  const cGot = C.msgs.some((m) => m.type === 's-requested' && m.from && m.from.name && m.from.name.includes('Ahmad'));
  check('stranger profile: the request really lands on C (s-requested)', cGot,
    C.msgs.map((m) => m.type).join(','));
  await A.page.click('#btn-pv2-close');
  await sleep(300);

  // ================= 5: photo viewer on MY profile + pencil =================
  await A.page.click('#frnav-profile');
  await A.page.waitForSelector('#pf-preview-av', { state: 'visible', timeout: 15000 });
  await A.page.click('#pf-preview-av');
  await A.page.waitForSelector('#ov-photoview.show', { timeout: 8000 });
  const phv2 = await A.page.evaluate(() => {
    const p = document.querySelector('#ov-photoview .pavatar');
    const r = p.getBoundingClientRect();
    return { w: r.width, hasSvg: !!p.querySelector('svg'), hasImg: !!p.querySelector('img') };
  });
  check('my profile: photo tap opens the large viewer (SVG portrait scales)', phv2.w >= 240 && phv2.hasSvg, JSON.stringify(phv2));
  await shot(A.page, 'profile-bigphoto-FRESH.jpg');
  await A.page.click('#btn-photoview-x');
  await A.page.waitForFunction(() => !document.querySelector('#ov-photoview').classList.contains('show'), null, { timeout: 5000 });
  await A.page.click('#btn-pf-edit-av');
  await A.page.waitForSelector('#ov-pfedit.show', { timeout: 8000 });
  const pencilOk = await A.page.evaluate(() => !document.querySelector('#ov-photoview').classList.contains('show'));
  check('my profile: the frame pencil opens ONLY the edit popup (no viewer)', pencilOk);
  await A.page.click('#btn-profile-close');
  await A.page.click('#btn-pf-home');
  await A.page.waitForSelector('#scr-home:not(.hidden)', { timeout: 10000 });

  // ================= 4: friend ⋯ popover restyle =================
  await A.page.click('#nav-friends');
  await A.page.waitForSelector('#fr-list .fr-row .fr-dots', { state: 'visible', timeout: 15000 });
  await A.page.click('#fr-list .fr-row .fr-dots');
  await A.page.waitForSelector('#ov-friendmenu.show', { timeout: 8000 });
  const fm = await A.page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('#ov-friendmenu'));
    const row = document.querySelector('#ov-friendmenu .pmpop-row');
    const rcs = row ? getComputedStyle(row) : null;
    return { bg: cs.backgroundImage, rowBg: rcs ? rcs.backgroundColor : '' };
  });
  check('friendmenu: magenta Ludo card, emerald gone',
    fm.bg.includes('216, 27, 116') && !fm.bg.includes('15, 64, 38') && !fm.bg.includes('7, 39, 26'), fm.bg.slice(0, 100));
  check('friendmenu: rows are dark plum', fm.rowBg.includes('43, 6, 54'), fm.rowBg);
  await shot(A.page, 'frmenu-restyle-FRESH.jpg');
  await A.page.mouse.click(195, 60); // outside tap closes the popover
  await sleep(400);

  // ================= 1d+4: table player menu → full profile =================
  await A.page.click('#frnav-home');
  await A.page.waitForSelector('#btn-online', { state: 'visible', timeout: 10000 });
  await A.page.click('#btn-online');
  await A.page.waitForSelector('#btn-pk-play', { state: 'visible', timeout: 15000 });
  await A.page.click('#btn-pk-play');
  await A.page.waitForSelector('#scr-lobby:not(.hidden)', { timeout: 20000 });
  const code = (await A.page.evaluate(() => document.querySelector('#lobby-code').textContent)).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  check('table setup: room code issued', /^[A-Z0-9]{4}$/.test(code), code);
  await B.page.click('#btn-join-toggle');
  await B.page.waitForSelector('#ov-join.show', { timeout: 10000 });
  await B.page.fill('#inp-code', code);
  await B.page.click('#btn-join');
  await B.page.waitForSelector('#scr-lobby:not(.hidden)', { timeout: 20000 });
  // lobby: A's tap on B's row opens the (restyled) player menu
  await A.page.waitForSelector('#scr-lobby .seatrow.tappable', { timeout: 15000 });
  await A.page.click('#scr-lobby .seatrow.tappable');
  await A.page.waitForSelector('#ov-playermenu.show', { timeout: 8000 });
  const pmBg = await A.page.evaluate(() => getComputedStyle(document.querySelector('#ov-playermenu')).backgroundImage);
  check('playermenu (lobby): magenta Ludo card, emerald gone',
    pmBg.includes('216, 27, 116') && !pmBg.includes('15, 64, 38'), pmBg.slice(0, 100));
  await A.page.click('#scr-lobby .seatrow.tappable'); // same row again toggles it closed
  await A.page.waitForFunction(() => !document.querySelector('#ov-playermenu').classList.contains('show'), null, { timeout: 5000 });
  // start the match
  await A.page.click('#btn-start');
  await A.page.waitForSelector('#scr-game:not(.hidden)', { timeout: 20000 });
  await A.page.waitForFunction(() => document.querySelectorAll('#hand .pcard').length >= 13, null, { timeout: 30000 });
  const badgeSel = await A.page.evaluate(() => {
    const b = document.querySelector('#seat-top.tappable, #seat-right.tappable, #seat-left.tappable');
    return b ? '#' + b.id : '';
  });
  check('table: the human seat badge is tappable', !!badgeSel, badgeSel);
  await A.page.click(badgeSel);
  await A.page.waitForSelector('#ov-playermenu.show', { timeout: 8000 });
  await shot(A.page, 'pview-tablemenu-FRESH.jpg');
  await A.page.click('#btn-pm-profile');
  await A.page.waitForSelector('#scr-pview:not(.hidden)', { timeout: 10000 });
  await A.page.waitForFunction(() => (document.querySelector('#pv2-name') || {}).textContent.includes('Bilal'), null, { timeout: 10000 });
  const pvT = await A.page.evaluate(() => ({
    name: document.querySelector('#pv2-name').textContent,
    btn: document.querySelector('#btn-pv2-friend').textContent,
  }));
  check('table menu → پروفایل opens the FULL profile over the table', pvT.name.includes('BilalView') && pvT.btn.includes('دوست دی'), JSON.stringify(pvT));
  await A.page.click('#btn-pv2-close');
  await A.page.waitForSelector('#scr-game:not(.hidden)', { timeout: 8000 });
  check('profile ✖ at the table returns to the table', true);
  // bots are inert: a non-tappable badge never opens the menu
  const botBadge = await A.page.evaluate(() => {
    const bots = [...document.querySelectorAll('.seatbadge')].filter((el) => !el.classList.contains('tappable') && el.id !== 'seat-bottom');
    if (!bots.length) return null;
    const r = bots[0].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, n: bots.length };
  });
  check('table: bot badges carry no .tappable', !!botBadge && botBadge.n >= 1, JSON.stringify(botBadge));
  await A.page.mouse.click(botBadge.x, botBadge.y);
  await sleep(600);
  const menuStayedShut = await A.page.evaluate(() => !document.querySelector('#ov-playermenu').classList.contains('show'));
  check('table: tapping a BOT badge opens nothing', menuStayedShut);
  // leave the table back home for the clubs phase
  await A.page.click('#btn-leave');
  await A.page.waitForSelector('#ov-exit.show', { timeout: 8000 });
  await A.page.click('#btn-exit-confirm');
  await A.page.waitForSelector('#scr-home:not(.hidden)', { timeout: 10000 });

  // ================= 3: clubs discovery without tabs =================
  await A.page.click('#nav-clubs');
  await A.page.waitForSelector('#scr-clubs:not(.hidden)', { timeout: 15000 });
  await A.page.waitForSelector('#cl-grid .cl-card, #cl-grid > *', { state: 'visible', timeout: 20000 }).catch(() => {});
  await sleep(800);
  const notabs = await A.page.evaluate(() => ({
    tabEls: document.querySelectorAll('.cl-tabs, .cl-tab, #cl-tab-explore, #cl-tab-hot, #cl-tab-mine, #cl-pane-mine').length,
    stage: !!document.querySelector('.cl-podium-stage') && document.querySelector('.cl-podium-stage').getClientRects().length > 0,
    chips: document.querySelectorAll('#cl-chips > *').length,
    gridCards: document.querySelectorAll('#cl-grid > *').length,
    gridText: (document.querySelector('#cl-grid') || {}).textContent || '',
    createVisible: !!document.querySelector('#btn-cl-create') && !document.querySelector('#btn-cl-create').classList.contains('hidden'),
  }));
  check('clubs discovery: NO tab bar elements exist', notabs.tabEls === 0, 'tabEls=' + notabs.tabEls);
  check('clubs discovery: stage + chips + grid render as ONE listing',
    notabs.stage && notabs.chips >= 1 && notabs.gridCards >= 1 && notabs.gridText.includes('BilalView'),
    JSON.stringify({ chips: notabs.chips, cards: notabs.gridCards }));
  check('clubs discovery: create pill present (A has no club)', notabs.createVisible);
  // name search (features batch) still works
  await A.page.click('#btn-cl-search-toggle');
  await A.page.waitForSelector('#cl-searchrow:not(.hidden)', { timeout: 8000 });
  await A.page.fill('#cl-search-inp', 'Bilal');
  await A.page.click('#btn-cl-search');
  await A.page.waitForFunction(() => ((document.querySelector('#cl-results') || {}).textContent || '').includes('BilalView'), null, { timeout: 10000 });
  check('clubs discovery: search by name finds the club', true);
  await shot(A.page, 'clubs-notabs-FRESH.jpg');
  // live re-query: a NEW club created elsewhere appears on A's open page
  const D = await bootPage('D');
  await setName(D.page, 'DaraView');
  await D.page.click('#nav-clubs');
  await D.page.waitForSelector('#btn-cl-create', { state: 'visible', timeout: 15000 });
  await D.page.click('#btn-cl-create');
  await D.page.waitForSelector('#btn-poll-create', { state: 'visible', timeout: 20000 });
  let liveOk = false;
  try {
    await A.page.waitForFunction(() => ((document.querySelector('#cl-grid') || {}).textContent || '').includes('DaraView'), null, { timeout: 12000 });
    liveOk = true;
  } catch { /* asserted below */ }
  check('clubs discovery: s-clubs-changed live re-query refreshes the grid (no reload)', liveOk);
  // create pill works: A creates his own club and lands in its room
  await A.page.click('#btn-cl-create');
  await A.page.waitForSelector('#btn-poll-create', { state: 'visible', timeout: 20000 });
  check('clubs discovery: the create pill creates + opens the room', true);

  check('no page errors in any context', errs.length === 0, errs.slice(0, 3).join(' | '));
  await A.ctx.close().catch(() => {});
  await B.ctx.close().catch(() => {});
  await D.ctx.close().catch(() => {});
} catch (e) {
  check('driver completed without exception', false, String(e && e.message || e).slice(0, 200));
} finally {
  try { C.ws.close(); } catch { /* gone */ }
  await browser.close().catch(() => {});
  srv.kill();
}
console.log(failures === 0 ? '\nALL PVIEW PROOF CHECKS PASSED' : '\n' + failures + ' PVIEW PROOF CHECK(S) FAILED');
process.exit(failures ? 1 : 0);
