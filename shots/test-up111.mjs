/**
 * test-up111.mjs — ADMIN account + panel (owner order 2026-11-18:
 * an admin account on his official Gmail that can send coins and
 * gems to any player). Full-stack: a real `wrangler dev` (AUTH on)
 * serves the real dist client (via a local CLIENT_URL), sessions
 * are hand-minted with the local SESSION_SECRET exactly like
 * cloudflare/test/test-admin.mjs, and the target player is created
 * over the real social socket.
 *   statics: pin admin, dist < 1 MB, admin strings ×3 languages,
 *     worker/auth wiring present.
 *   admin session: profile shows «ادمین» → panel opens → lookup by
 *     6-digit ID renders name + balances → grant +5000 coins via
 *     the confirm popup → result + new balances shown, the grant
 *     appears in the recent list, and the server agrees (API).
 *     A gems grant through the currency toggle too.
 *   normal session: NO admin button on the profile page, and the
 *     /admin/* routes answer 403 from inside the page.
 *   node shots/test-up111.mjs   (spawns wrangler on :8789)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = path.resolve(process.cwd());
const req = createRequire(path.join(ROOT, '../vault-rental-online/package.json'));
const { chromium } = req('playwright-core');
const EXE = '/home/hatch/.cache/ms-playwright/chromium-1228/chrome-linux/chrome';
const { ToreClient } = await import('../cloudflare/test/driver.mjs');
const { mintSessionCookie, sessionSecret } = await import('../cloudflare/test/mint-session.mjs');

const WPORT = 8789;
const BASE = 'http://127.0.0.1:' + WPORT;
const SPORT = 8933;
let fails = 0;
const ok = (cond, label) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- statics ----------------
const worker = fs.readFileSync('cloudflare/src/worker.js', 'utf8');
ok(worker.includes('20261118-admin'), 'worker pin admin');
ok(worker.includes("path.startsWith('/admin/')"), 'worker carries the /admin gate');
const authSrc = fs.readFileSync('cloudflare/src/auth.js', 'utf8');
ok(authSrc.includes("ADMIN_EMAIL = 'shuaibanwari30@gmail.com'"), 'auth.js pins the admin email');
ok(authSrc.includes('export function isAdminUser'), 'auth.js exports isAdminUser');
const dist = fs.readFileSync('cloudflare/dist-client.html');
ok(dist.length < 1000000, 'dist under 1 MB (' + dist.length + ')');
const distS = dist.toString('utf8');
ok(distS.includes('ov-admin') && distS.includes('btn-admin'), 'dist carries the admin panel + button');
const src = fs.readFileSync('public/index.html', 'utf8');
for (const k of ['adminTitle', 'adminFind', 'adminSend', 'adminLevel', 'adminHistory', 'adminNotFound', 'adminDone', 'adminAmount', 'ledAdmin']) {
  ok((src.match(new RegExp(k + ':', 'g')) || []).length === 3, k + ' in all 3 languages');
}
ok(src.includes("if (user.isAdmin)"), 'client reveals the button only on isAdmin');
ok(src.includes("'/admin/player?id='"), 'client lookup wired');
ok(src.includes("'/admin/grant'"), 'client grant wired');
ok(src.includes("'/admin/grants'"), 'client grants list wired');

// ---------------- servers ----------------
const distBuf = fs.readFileSync('cloudflare/dist-client.html');
const staticSrv = http.createServer((rq, rs) => { rs.writeHead(200, { 'Content-Type': 'text/html' }); rs.end(distBuf); });
await new Promise((r) => staticSrv.listen(SPORT, '127.0.0.1', r));
const wrangler = spawn('npx', ['wrangler', 'dev', '--port', String(WPORT),
  '--var', 'CLIENT_URL:http://127.0.0.1:' + SPORT + '/dist-client.html'],
  { cwd: path.join(ROOT, 'cloudflare'), detached: true, stdio: 'pipe' });
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { const r = await fetch(BASE + '/auth/config'); up = r.status === 200; } catch { await sleep(500); }
}
ok(up, 'wrangler dev up on ' + WPORT);

// ---------------- identities ----------------
const secret = sessionSecret();
const RUN = Date.now().toString(36);
const ADMIN = { provider: 'google', sub: 'adm-ui-' + RUN, name: 'Admin', email: 'shuaibanwari30@gmail.com', picture: '' };
const PLAYER = { provider: 'google', sub: 'pl-ui-' + RUN, name: 'بازیکن', email: 'uiplayer@example.com', picture: '' };
const TARGET = { provider: 'google', sub: 'tg-ui-' + RUN, name: 'هدف رابط', email: 'uitarget@example.com', picture: '' };
const adminCookie = mintSessionCookie(ADMIN, secret);
const playerCookie = mintSessionCookie(PLAYER, secret);
const cookieOf = (full) => full.slice(full.indexOf('=') + 1);

// target player over the real social socket
const tc = new ToreClient(BASE.replace(/^http/, 'ws') + '/social', { Cookie: mintSessionCookie(TARGET, secret) });
await tc.open();
tc.send({ type: 's-hello', pid: '', profile: { name: TARGET.name, avatar: 'av3', country: 'افغانستان' } });
const init = await tc.waitFor((m) => m.type === 's-init', 20000, 'target s-init');
const uid = String(init.uid || '');
ok(/^\d{6}$/.test(uid), 'target uid ' + uid);
tc.close();

// ---------------- browser ----------------
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const errors = [];
async function newPage(cookie, tag) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: 'tore_session', value: cookieOf(cookie), url: BASE + '/' }]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(tag + ': ' + e.message));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 45000 });
  await sleep(600);
  return { ctx, page };
}
async function waitText(page, sel, needle, tries = 30) {
  let t = '';
  for (let i = 0; i < tries; i++) {
    t = await page.evaluate((s) => { const el = document.querySelector(s); return el ? el.textContent : ''; }, sel).catch(() => '');
    if (t.includes(needle)) return t;
    await sleep(250);
  }
  return t;
}

// admin: the full panel flow
{
  const { ctx, page } = await newPage(adminCookie, 'admin');
  await page.click('#btn-profile');
  await page.waitForSelector('#scr-profile:not(.hidden)', { timeout: 15000 });
  const btnVisible = await page.evaluate(() => {
    const b = document.querySelector('#btn-admin');
    return !!b && !b.classList.contains('hidden') && getComputedStyle(b).display !== 'none';
  });
  ok(btnVisible, 'admin: «ادمین» button visible on the profile page');
  await page.click('#btn-admin');
  await page.waitForSelector('#ov-admin.show', { timeout: 10000 });
  ok(true, 'admin: panel opens');
  await page.fill('#ad-id', uid);
  await page.click('#btn-ad-find');
  const info = await waitText(page, '#ad-info', TARGET.name);
  ok(info.includes(TARGET.name) && info.includes('1000'), 'admin: lookup renders name + 1000 coins (' + info.trim() + ')');
  await page.fill('#ad-amt', '5000');
  await page.click('#btn-ad-send');
  await page.waitForSelector('#ov-confirm.show', { timeout: 10000 });
  ok(true, 'admin: send asks for confirmation first');
  await page.click('#btn-cf-yes');
  const result = await waitText(page, '#ad-result', '✓');
  ok(result.includes('✓'), 'admin: grant result shown (' + result.trim() + ')');
  const info2 = await waitText(page, '#ad-info', '6000');
  ok(info2.includes('6000'), 'admin: panel shows the new balance 6000');
  // wait for THIS run's entry (the audit log may hold older local
  // test entries too — the uid is unique to this run's target)
  let list = '';
  for (let i = 0; i < 30; i++) {
    list = await page.evaluate(() => document.querySelector('#ad-list').textContent).catch(() => '');
    if (list.includes('(' + uid + ')') && list.includes('+5000')) break;
    await sleep(250);
  }
  ok(list.includes('(' + uid + ')') && list.includes('+5000') && list.includes(TARGET.name),
    'admin: recent-grants list shows the grant');
  // gems through the toggle
  await page.click('#btn-ad-gems');
  await page.fill('#ad-amt', '30');
  await page.click('#btn-ad-send');
  await page.waitForSelector('#ov-confirm.show', { timeout: 10000 });
  await page.click('#btn-cf-yes');
  const info3 = await waitText(page, '#ad-info', '💎 30');
  ok(info3.includes('💎 30'), 'admin: gems grant lands (💎 30)');
  // the server agrees — a real round-trip, not just paint
  const api = await (await fetch(BASE + '/admin/player?id=' + uid, { headers: { Cookie: adminCookie } })).json();
  ok(api.player && api.player.coins === 6000 && api.player.gems === 30,
    'server agrees: coins 6000, gems 30');
  await ctx.close();
}

// normal player: no trace of the panel, routes refuse
{
  const { ctx, page } = await newPage(playerCookie, 'player');
  await page.click('#btn-profile');
  await page.waitForSelector('#scr-profile:not(.hidden)', { timeout: 15000 });
  const btnState = await page.evaluate(() => {
    const b = document.querySelector('#btn-admin');
    return b ? (b.classList.contains('hidden') ? 'hidden' : 'VISIBLE') : 'absent';
  });
  ok(btnState === 'hidden', 'player: admin button stays hidden (' + btnState + ')');
  const codes = await page.evaluate(async (u) => {
    const a = await fetch('/admin/player?id=' + u, { credentials: 'same-origin' });
    const b = await fetch('/admin/grants', { credentials: 'same-origin' });
    return [a.status, b.status];
  }, uid);
  ok(codes[0] === 403 && codes[1] === 403, 'player: /admin/* from the page → 403/403 (' + codes.join('/') + ')');
  await ctx.close();
}

ok(errors.length === 0, 'no page errors (' + errors.slice(0, 3).join(' | ') + ')');
await browser.close();
try { process.kill(-wrangler.pid, 'SIGKILL'); } catch { /* already gone */ }
staticSrv.close();
console.log(fails === 0 ? 'ALL UP111 CHECKS PASSED' : ('UP111 FAILURES: ' + fails));
process.exit(fails ? 1 : 0);
