/** up77 two-load harness — drives the REAL fbPage() (gate61
 *  stub server, port 8913) through a full round trip per
 *  scenario: load 1 = first load (snapshot + auto-redirect),
 *  load 2 = the return leg, same tab (sessionStorage shared).
 *  S1 picked a DIFFERENT account: the stale user reports first
 *     and must be HELD; the picked account bridges when it
 *     reports — never the stale token.
 *  S2 picked the SAME account, result delivers: bridges via
 *     the result.
 *  S3 picked the SAME account, result lost: the empty result
 *     releases the hold and the session bridges. */
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/home/hatch/workspace/projects/vault-rental-online/');
const { chromium } = require('playwright-core');
const BASE = 'http://127.0.0.1:8913';
const TICKET = '0123456789abcdef0123456789abcdef';

function findChrome() {
  const root = process.env.HOME + '/.cache/ms-playwright';
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium')).sort().reverse();
  for (const d of dirs) {
    for (const sub of ['chrome-headless-shell-linux/headless_shell', 'chrome-linux/chrome']) {
      const p = root + '/' + d + '/' + sub;
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('no chromium build found');
}
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mode = null; // read live by the SDK route handler
function stub() {
  const m = mode;
  const events = m.events.map(([d, u]) => 'setTimeout(function () { cb(' + u + '); }, ' + d + ');').join(' ');
  return [
    'window.__fbp = { redirectCalls: 0 };',
    'window.firebase = { initializeApp: function () {} };',
    'var stale = { uid: "U-PUBG", getIdToken: function () { return Promise.resolve("TOKEN-PUBG"); }, email: "pubgaccound2023@gmail.com" };',
    'var picked = { uid: "U-708", getIdToken: function () { return Promise.resolve("TOKEN-708"); }, email: "shuaibanwari708@gmail.com" };',
    'firebase.auth = function () {',
    '  return {',
    '    currentUser: ' + m.current + ',',
    '    getRedirectResult: function () { return new Promise(function (res) { setTimeout(function () { res(' + m.result + '); }, ' + m.resultDelay + '); }); },',
    '    onAuthStateChanged: function (cb) { ' + events + ' return function () {}; },',
    '    signInWithRedirect: function (p) { window.__fbp.redirectCalls++; return Promise.resolve(); }',
    '  };',
    '};',
    'firebase.auth.GoogleAuthProvider = function () { this.setCustomParameters = function (o) { window.__fbp.providerParams = o; }; };',
  ].join('\n');
}

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
async function scenario(name, load2, expectToken, notBeforeMs) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.route('**/gsi/client', (r) => r.fulfill({ contentType: 'text/javascript', body: '/* GIS disabled in this harness — redirect fallback under test */' }));
  await page.route('**/firebase-app-compat.js', (r) => r.fulfill({ contentType: 'text/javascript', body: stub() }));
  await page.route('**/firebase-auth-compat.js', (r) => r.fulfill({ contentType: 'text/javascript', body: stub() }));
  const bodies = [];
  await page.route('**/auth/fb-complete', async (r) => {
    try { bodies.push(JSON.parse(r.request().postData() || '{}')); } catch { bodies.push({}); }
    await r.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
  });
  // load 1 — first load: stale session present, auto-redirect
  mode = { current: 'stale', events: [[10, 'stale']], result: 'null', resultDelay: 0 };
  await page.goto(BASE + '/auth/fb?ticket=' + TICKET, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3800); // U79: the fallback redirect is scheduled (2.8 s) to give GIS first chance
  const snap = await page.evaluate(() => ({
    redirects: window.__fbp ? window.__fbp.redirectCalls : -1,
    stale: (() => { try { return sessionStorage.getItem('tore.fb.stale'); } catch (e) { return null; } })(),
  }));
  check(name + ' L1 auto-redirects', snap.redirects === 1, 'calls=' + snap.redirects);
  check(name + ' L1 snapshots the stale uid', snap.stale === 'U-PUBG', String(snap.stale));
  check(name + ' L1 bridges nothing', bodies.length === 0, 'calls=' + bodies.length);
  // load 2 — the return leg in the same tab
  mode = load2;
  const t0 = Date.now();
  await page.goto(BASE + '/auth/fb?ticket=' + TICKET, { waitUntil: 'domcontentloaded' });
  if (notBeforeMs) {
    await page.waitForTimeout(notBeforeMs);
    check(name + ' L2 stale user held (no early bridge)', bodies.length === 0, 'calls=' + bodies.length);
  }
  for (let i = 0; i < 22 && bodies.length === 0; i++) await sleep(300);
  check(name + ' L2 exactly one bridge', bodies.length === 1, 'calls=' + bodies.length);
  check(name + ' L2 bridged token is ' + expectToken, bodies.length === 1 && bodies[0].idToken === expectToken,
    (bodies[0] && bodies[0].idToken) + ' after ~' + (Date.now() - t0) + 'ms');
  await ctx.close();
}
try {
  await scenario('S1', { current: 'stale', events: [[10, 'stale'], [900, 'picked']], result: 'null', resultDelay: 1500 }, 'TOKEN-708', 700);
  await scenario('S2', { current: 'stale', events: [[10, 'stale']], result: '{ user: stale }', resultDelay: 600 }, 'TOKEN-PUBG', 0);
  await scenario('S3', { current: 'stale', events: [[10, 'stale']], result: 'null', resultDelay: 500 }, 'TOKEN-PUBG', 0);
} finally {
  await browser.close();
}
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL GATE77 PROOF CHECKS PASSED');
process.exit(failures ? 1 : 0);
