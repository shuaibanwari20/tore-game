/**
 * test-up103.mjs — feat4 proofs (owner picks 2026-11-15: special packs,
 * dramatic entrance, animated frame/backs).
 *   STATIC — worker pin revertseek + sticker regex to 24; dist < 1 MB and
 *     carries pack-emoji / fr5 / cback-7 / entered; social-core sells
 *     back7/fr5/fr6/pack-emoji/pack-sticker; both game servers allow
 *     st17-24 + premium emojis; 24 sticker files in public + cloudflare.
 *   BROWSER (deploy host :8931) — guest joins host's lobby -> host sees
 *     the entrance overlay; shop look tab shows back7, fr5, fr6 and the
 *     packs section; the table chat panel lists 8 premium stickers and
 *     8 premium emojis, all locked for a wallet that owns no pack.
 *   node shots/test-up103.mjs
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
let fails = 0;
const ok = (cond, label) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- statics ----------------
const worker = fs.readFileSync('cloudflare/src/worker.js', 'utf8');
ok(worker.includes('20261118-admin'), 'worker pin micguide');
ok(/st\(\[1-9\]\|1\[0-9\]\|2\[0-4\]\)/.test(worker), 'worker sticker regex to 24');
const dist = fs.readFileSync('cloudflare/dist-client.html');
ok(dist.length < 1000000, 'dist under 1 MB (' + dist.length + ')');
const distS = dist.toString('utf8');
for (const needle of ['pack-emoji', 'pack-sticker', 'fr5', 'fr6', 'cback-7', 'ov-entered', 'st24', 'onEntered'])
  ok(distS.includes(needle), 'dist carries ' + needle);
const core = fs.readFileSync('social-core.js', 'utf8');
for (const sku of ['back7', 'fr5', 'fr6', 'pack-emoji', 'pack-sticker'])
  ok(core.includes("'" + sku + "'"), 'social-core sells ' + sku);
ok(/fr\[1-6\]/.test(core), 'social-core frame range fr1-6');
for (const f of ['cloudflare/src/game-server.js', 'server.js']) {
  const s = fs.readFileSync(f, 'utf8');
  ok(s.includes('CHAT_STICKERS2') && s.includes('st24'), f + ' premium stickers');
  ok(s.includes('CHAT_EMOJIS2'), f + ' premium emojis');
  ok(s.includes("'entered'"), f + ' entered broadcast');
}
for (const dir of ['public/stickers', 'cloudflare/stickers']) {
  const n = fs.readdirSync(dir).filter((x) => /^st\d+\.gif$/.test(x)).length;
  ok(n === 24, dir + ' has 24 stickers (' + n + ')');
}

// ---------------- browser ----------------
const host = spawn('node', ['deploy/server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  try { const r = await fetch(BASE + '/'); up = r.status > 0; } catch { await sleep(400); }
}
ok(up, 'deploy host up');
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const errors = [];
async function newPlayer(tag) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(tag + ': ' + e.message));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 45000 });
  await sleep(400);
  return { ctx, page };
}
async function setName(page, name) {
  await page.click('#btn-profile');
  await page.waitForSelector('#scr-profile:not(.hidden)', { timeout: 15000 });
  await page.click('#btn-pf-edit-av');
  await page.waitForSelector('#ov-pfedit.show', { timeout: 8000 });
  await page.fill('#pf-name', name);
  await page.click('#btn-profile-save');
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 15000 });
}

const A = await newPlayer('A');
const B = await newPlayer('B');
await setName(A.page, 'HostA');
await setName(B.page, 'GuestB');

// entrance: A creates, B joins, A sees the overlay
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
let enteredSeen = false;
for (let i = 0; i < 40 && !enteredSeen; i++) {
  enteredSeen = await A.page.evaluate(() => { const o = document.querySelector('#ov-entered'); return !!o && o.classList.contains('show'); }).catch(() => false);
  if (!enteredSeen) await sleep(100);
}
ok(enteredSeen, 'host saw the entrance overlay');
if (enteredSeen) {
  const nm = await A.page.evaluate(() => document.querySelector('#ov-entered .en-name').textContent);
  ok(/GuestB/.test(nm), 'entrance shows the guest name (' + nm + ')');
  await A.page.screenshot({ path: path.join(ROOT, '../../up103-entered.jpg') });
}
await B.page.waitForSelector('#scr-lobby:not(.hidden)', { timeout: 20000 });

// shop: frames + packs on B (fresh wallet, owns nothing)
await B.page.evaluate(() => { location.reload(); });
await B.page.waitForSelector('#btn-quick', { state: 'visible', timeout: 45000 });
await sleep(800);
await B.page.evaluate(() => openShop('look'));
await B.page.waitForSelector('#scr-shop:not(.hidden)', { timeout: 10000 });
await sleep(600);
const shop = await B.page.evaluate(() => {
  const items = [...document.querySelectorAll('#shop-body .si-name')].map((e) => e.textContent);
  const sects = [...document.querySelectorAll('#shop-body .ss-lbl')].map((e) => e.textContent);
  return { items, sects };
});
ok(shop.sects.some((x) => x.includes('ځانګړي بستې')), 'packs section present (' + shop.sects.join(' | ') + ')');
ok(shop.items.some((x) => x.includes('متحرک طلایي')), 'back7 in shop');
ok(shop.items.some((x) => x.includes('څرخنده اور')), 'fr5 in shop');
ok(shop.items.some((x) => x.includes('رنګينه')), 'fr6 in shop');
ok(shop.items.some((x) => x.includes('ځانګړي ایموجي')), 'pack-emoji in shop');
ok(shop.items.some((x) => x.includes('ځانګړي سټیکرونه')), 'pack-sticker in shop');
await B.page.evaluate(() => { const els = [...document.querySelectorAll('#shop-body .shop-item')]; const t = els.find((e) => e.textContent.includes('څرخنده اور')); if (t) t.scrollIntoView({ block: 'center' }); });
await sleep(500);
await B.page.screenshot({ path: path.join(ROOT, '../../up103-shop-frames.jpg') });
await B.page.evaluate(() => { const els = [...document.querySelectorAll('#shop-body .shop-item')]; const t = els.find((e) => e.textContent.includes('ځانګړي ایموجي')); if (t) t.scrollIntoView({ block: 'center' }); });
await sleep(500);
await B.page.screenshot({ path: path.join(ROOT, '../../up103-shop-packs.jpg') });
await B.page.evaluate(() => closeShop());

// chat panel: premium rows locked (fresh context — B is parked in a lobby)
const C = await newPlayer('C');
await C.page.click('#btn-quick');
await C.page.waitForSelector('#btn-pk-play', { state: 'visible', timeout: 15000 });
await C.page.click("#btn-pk-play");
await C.page.waitForSelector("#scr-game:not(.hidden)", { timeout: 25000 });
await sleep(1200);
await C.page.click('#btn-chat');
await sleep(700);
const chat = await C.page.evaluate(() => {
  const st = [...document.querySelectorAll('#chat-stickers [data-pack]')];
  const em = [...document.querySelectorAll('#chat-emojis [data-pack]')];
  return {
    st: st.length, em: em.length,
    stLocked: st.filter((b) => b.classList.contains('qlock')).length,
    emLocked: em.filter((b) => b.classList.contains('qlock')).length,
  };
});
ok(chat.st === 8, 'chat panel: 8 premium stickers (' + chat.st + ')');
ok(chat.em === 8, 'chat panel: 8 premium emojis (' + chat.em + ')');
ok(chat.stLocked === 8 && chat.emLocked === 8, 'all premium chat items locked (' + chat.stLocked + '/' + chat.emLocked + ')');
await C.page.evaluate(() => { const p = document.querySelector('#sticker-pager'); if (p) p.scrollTo({ left: -2 * p.clientWidth }); const q = document.querySelector('#emoji-pager'); if (q) q.scrollTo({ left: -2 * q.clientWidth }); });
await sleep(600);
await C.page.screenshot({ path: path.join(ROOT, '../../up103-chat-packs.jpg') });

ok(errors.length === 0, 'no page errors' + (errors.length ? ' — ' + errors.slice(0, 3).join(' ; ') : ''));
await browser.close();
host.kill('SIGKILL');
console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' CHECK(S) FAILED');
process.exit(fails ? 1 : 0);
