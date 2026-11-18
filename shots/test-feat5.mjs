/**
 * test-feat5.mjs — feat5 proofs (his picks 2026-11-18: 1 notifications,
 * 8 spectate-from-friends, 9 profile+settings on the server).
 *   STATIC — worker pin feat5; dist < 1 MB and carries the bell, the
 *     notification centre, s-notif / s-profile-pull / s-push-sub and
 *     the fr-live badge; sw.js is v6 with push handlers (public and
 *     cloudflare copies identical); social-core carries notify() +
 *     profileSync; the DO imports webpush.js and wires pushSend;
 *     wrangler.toml carries the VAPID public key.
 *   BROWSER (deploy host :8931) — a gift lands in the friend's inbox:
 *     badge on the bell, panel lists it, opening clears the badge; a
 *     friend in a live match shows «زوندی» + «تماشا» on the friends
 *     row and one tap spectates; a fresh browser with the same
 *     identity pulls the server profile (name/felt/lang/favorites).
 *   Screenshots land in ~/workspace/tmp-build/feat5/shots/.
 *   node shots/test-feat5.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = path.resolve(process.cwd());
const req = createRequire(path.join(ROOT, '../vault-rental-online/package.json'));
const { chromium } = req('playwright-core');
const EXE = '/home/hatch/.cache/ms-playwright/chromium-1228/chrome-linux/chrome';
const PORT = 8931;
const BASE = 'http://127.0.0.1:' + PORT;
const SHOTS = path.join(ROOT, '../../tmp-build/feat5/shots');
fs.mkdirSync(SHOTS, { recursive: true });
let fails = 0;
const ok = (cond, label) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- statics ----------------
const worker = fs.readFileSync('cloudflare/src/worker.js', 'utf8');
ok(worker.includes('20261118-admin'), 'worker pin micguide');
ok(worker.includes('/push-key'), 'worker serves /push-key');
const dist = fs.readFileSync('cloudflare/dist-client.html');
ok(dist.length < 1000000, 'dist under 1 MB (' + dist.length + ')');
const distS = dist.toString('utf8');
for (const needle of ['btn-bell', 'ov-notifs', 'bell-badge', 's-notif', 's-notifs-read', 's-profile-pull', 's-push-sub', 'fr-live', 'notifTitle', 'nClubAnn', 'applyServerSync', 'syncSnapshot'])
  ok(distS.includes(needle), 'dist carries ' + needle);
const swPub = fs.readFileSync('public/sw.js', 'utf8');
const swCf = fs.readFileSync('cloudflare/sw.js', 'utf8');
ok(swPub.includes("'v6'") && swPub.includes("addEventListener('push'") && swPub.includes("addEventListener('notificationclick'"), 'sw.js v6 with push + notificationclick');
ok(swPub === swCf, 'cloudflare/sw.js identical to public/sw.js');
const core = fs.readFileSync('social-core.js', 'utf8');
for (const needle of ['notify(', 'profileSync(', 'pushSubscribe(', "case 's-notifs'", "case 's-profile-pull'", 'NOTIF_CAP'])
  ok(core.includes(needle), 'social-core carries ' + needle);
const gs = fs.readFileSync('cloudflare/src/game-server.js', 'utf8');
ok(gs.includes("from './webpush.js'") && gs.includes('pushSend') && gs.includes('_webPushSend'), 'game-server wires webpush + pushSend');
ok(fs.existsSync('cloudflare/src/webpush.js'), 'cloudflare/src/webpush.js exists');
const toml = fs.readFileSync('cloudflare/wrangler.toml', 'utf8');
ok(toml.includes('WEBPUSH_VAPID_PUBLIC'), 'wrangler.toml carries the VAPID public key');
const depCore = fs.readFileSync('deploy/social-core.js', 'utf8');
ok(depCore === core, 'deploy/social-core.js mirrors the root core');

// ---------------- browser ----------------
const host = spawn('node', ['deploy/server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  try { const r = await fetch(BASE + '/'); up = r.status > 0; } catch { await sleep(400); }
}
ok(up, 'deploy host up');
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const errors = [];
async function newPlayer(tag, pid) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'] });
  await ctx.addInitScript((p) => { try { localStorage.setItem('tore.pid', p); } catch (e) { /* ignore */ } }, pid);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(tag + ': ' + e.message));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 45000 });
  await sleep(500);
  return { ctx, page };
}
// A raw social socket for the same identity (friend setup without UI).
function rawSocial(pid, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/social');
    const to = setTimeout(() => reject(new Error('raw social timeout')), 10000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 's-hello', pid, profile: { name, avatar: 'av1', country: 'AF' } }));
      setTimeout(() => { clearTimeout(to); resolve(ws); }, 400);
    };
    ws.onerror = (e) => { clearTimeout(to); reject(new Error('raw social error')); };
  });
}
const send = (ws, obj) => ws.send(JSON.stringify(obj));

const ALICE = 'feat5alice', BOB = 'feat5bob', CAROL = 'feat5carol', DAVE = 'feat5dave';
const A = await newPlayer('A', ALICE);
const B = await newPlayer('B', BOB);
const C = await newPlayer('C', CAROL);

// names (profile editor, the up103 way)
async function setName(page, name) {
  await page.click('#btn-profile');
  await page.waitForSelector('#scr-profile:not(.hidden)', { timeout: 15000 });
  await page.click('#btn-pf-edit-av');
  await page.waitForSelector('#ov-pfedit.show', { timeout: 8000 });
  await page.fill('#pf-name', name);
  await page.click('#btn-profile-save');
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 15000 });
}
await setName(A.page, 'AliceF5');
await setName(B.page, 'BobF5');
await setName(C.page, 'CarolF5');

// friendships via raw sockets: Alice<->Bob, Carol<->Bob
const ra = await rawSocial(ALICE, 'AliceF5');
const rb = await rawSocial(BOB, 'BobF5');
const rc = await rawSocial(CAROL, 'CarolF5');
send(ra, { type: 's-request', to: 'p:' + BOB });
await sleep(500);
send(rb, { type: 's-respond', from: 'p:' + ALICE, accept: true });
send(rc, { type: 's-request', to: 'p:' + BOB });
await sleep(500);
send(rb, { type: 's-respond', from: 'p:' + CAROL, accept: true });
await sleep(700);

// ---------- notifications: Alice gifts Bob -> badge + panel ----------
await A.page.evaluate(() => {
  const p = [...socialPeople.values()].find((x) => x.name === 'BobF5');
  if (!p) throw new Error('bob not in directory');
  openGift(p);
});
await A.page.waitForSelector('#ov-gift.show', { timeout: 8000 });
await A.page.evaluate(() => {
  const chip = [...document.querySelectorAll('#gift-chips button')].find((b) => b.textContent.replace(/[^0-9]/g, '') === '100');
  if (chip) chip.click();
});
await A.page.click('#btn-gift-send');
await sleep(400);
let badge = false;
for (let i = 0; i < 30 && !badge; i++) {
  badge = await B.page.evaluate(() => { const b = document.querySelector('#bell-badge'); return !!b && !b.classList.contains('hidden') && b.textContent.trim() !== ''; }).catch(() => false);
  if (!badge) await sleep(500);
}
ok(badge, 'gift -> bell badge appears on the friend');
await B.page.screenshot({ path: path.join(SHOTS, 'feat5-a-home-badge.png') });
await B.page.click('#btn-bell');
await B.page.waitForSelector('#ov-notifs.show', { timeout: 8000 });
await sleep(400);
const rows = await B.page.evaluate(() => [...document.querySelectorAll('#notif-list .nt-row')].map((r) => r.textContent));
ok(rows.some((t) => t.includes('AliceF5')), 'panel lists the gift notification (' + rows.join(' | ').slice(0, 120) + ')');
await B.page.screenshot({ path: path.join(SHOTS, 'feat5-b-notif-panel.png') });
const cleared = await B.page.evaluate(() => document.querySelector('#bell-badge').classList.contains('hidden'));
ok(cleared, 'opening the centre clears the badge');
await B.page.click('#btn-notif-close');

// ---------- spectate from the friends list ----------
await A.page.click('#btn-online');
await A.page.waitForSelector('#btn-pk-play', { state: 'visible', timeout: 15000 });
await A.page.click('#btn-pk-play');
await A.page.waitForSelector('#scr-lobby:not(.hidden)', { timeout: 20000 });
const code = (await A.page.evaluate(() => document.querySelector('#lobby-code').textContent)).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
ok(code.length === 4, 'room code ' + code);
await B.page.click('#btn-join-toggle');
await B.page.waitForSelector('#ov-join.show', { timeout: 10000 });
await B.page.fill('#inp-code', code);
await B.page.click('#btn-join');
await B.page.waitForSelector('#scr-lobby:not(.hidden)', { timeout: 20000 });
await A.page.click('#btn-start');
await A.page.waitForSelector('#scr-game:not(.hidden)', { timeout: 25000 });
await B.page.waitForSelector('#scr-game:not(.hidden)', { timeout: 25000 });
await sleep(1000);
// Carol opens the friends page: Bob's row must wear the live badge + watch button
await C.page.click('#nav-friends');
await C.page.waitForSelector('#scr-friends:not(.hidden)', { timeout: 15000 });
let liveRow = null;
for (let i = 0; i < 30 && !liveRow; i++) {
  liveRow = await C.page.evaluate(() => {
    const rows = [...document.querySelectorAll('#fr-list .fr-row')];
    const r = rows.find((x) => x.textContent.includes('BobF5'));
    if (!r) return null;
    return { live: !!r.querySelector('.fr-live'), watch: !!r.querySelector('[data-act="watch"]') };
  }).catch(() => null);
  if (!liveRow || !liveRow.live) { liveRow = null; await sleep(600); }
}
ok(!!liveRow && liveRow.live, 'friends row shows the pulsing «زوندی» badge');
ok(!!liveRow && liveRow.watch, 'friends row shows the «تماشا» button');
await C.page.screenshot({ path: path.join(SHOTS, 'feat5-c-friends-live.png') });
await C.page.evaluate(() => {
  const rows = [...document.querySelectorAll('#fr-list .fr-row')];
  const r = rows.find((x) => x.textContent.includes('BobF5'));
  r.querySelector('[data-act="watch"]').click();
});
await C.page.waitForSelector('#scr-game:not(.hidden)', { timeout: 25000 });
await sleep(800);
const spec = await C.page.evaluate(() => { const c = document.querySelector('#spec-chip'); return !!c && !c.classList.contains('hidden'); });
ok(spec, 'one tap spectates the friend match (spec chip on)');

// ---------- profile sync: Dave sets, a fresh Dave pulls ----------
const D1 = await newPlayer('D1', DAVE);
await D1.page.evaluate(() => {
  profile.name = 'Dave Synced';
  profile.felt = 7;
  saveProfile();
  setLang('en');
  TorePlayer.favsSet([2, 5]);
  socialHello();
});
await sleep(900);
const D2 = await newPlayer('D2', DAVE);
let pulled = null;
for (let i = 0; i < 30 && !pulled; i++) {
  pulled = await D2.page.evaluate(() => (profile && profile.name === 'Dave Synced')
    ? { name: profile.name, felt: profile.felt, lang: LANG, favs: TorePlayer.favsList() } : null).catch(() => null);
  if (!pulled) await sleep(600);
}
ok(!!pulled, 'fresh browser pulled the server profile');
if (pulled) {
  ok(pulled.felt === 7, 'pulled felt applied (' + pulled.felt + ')');
  ok(pulled.lang === 'en', 'pulled language applied (' + pulled.lang + ')');
  ok(pulled.favs.includes(2) && pulled.favs.includes(5), 'pulled favorites applied (' + pulled.favs.join(',') + ')');
}
await D2.page.click('#btn-profile');
await D2.page.waitForSelector('#scr-profile:not(.hidden)', { timeout: 15000 });
await sleep(500);
await D2.page.screenshot({ path: path.join(SHOTS, 'feat5-d-profile-pulled.png') });

ok(errors.length === 0, 'no page errors' + (errors.length ? ' — ' + errors.slice(0, 3).join(' ; ') : ''));
await browser.close();
host.kill('SIGKILL');
console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' CHECK(S) FAILED');
process.exit(fails ? 1 : 0);
