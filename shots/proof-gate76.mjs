/** up76 race harness — drives the REAL fbPage() (gate61 stub
 *  server, port 8913) with an adversarial Firebase stub: the
 *  STALE persisted user (pubg) reports first, the FRESH redirect
 *  result (the picked 708 account) lands later.
 *  R-A: the bridge must carry the PICKED account's token.
 *  R-B: with no fresh result at all, the persisted fallback
 *  still bridges (the U62 lost-result rescue). */
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

function stubFor(withResult) {
  return [
    'window.__fbp = { redirectCalls: 0, signOutCalls: 0 };',
    'window.firebase = { initializeApp: function () {} };',
    'var stale = { getIdToken: function () { return Promise.resolve("TOKEN-PUBG"); }, email: "pubgaccound2023@gmail.com" };',
    'var picked = { getIdToken: function () { return Promise.resolve("TOKEN-708"); }, email: "shuaibanwari708@gmail.com" };',
    'firebase.auth = function () {',
    '  return {',
    '    currentUser: stale,',
    '    signOut: function () { window.__fbp.signOutCalls++; return Promise.resolve(); },',
    '    getRedirectResult: function () { return new Promise(function (res) { setTimeout(function () { res(' + (withResult ? '{ user: picked }' : 'null') + '); }, 350); }); },',
    '    onAuthStateChanged: function (cb) { setTimeout(function () { cb(stale); }, 10); return function () {}; },',
    '    signInWithRedirect: function (p) { window.__fbp.redirectCalls++; return Promise.resolve(); }',
    '  };',
    '};',
    'firebase.auth.GoogleAuthProvider = function () { this.setCustomParameters = function (o) { window.__fbp.providerParams = o; }; };',
  ].join('\n');
}

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
try {
  for (const [name, withResult, expect] of [['R-A', true, 'TOKEN-708'], ['R-B', false, 'TOKEN-PUBG']]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const stub = stubFor(withResult);
    await page.route('**/firebase-app-compat.js', (r) => r.fulfill({ contentType: 'text/javascript', body: stub }));
    await page.route('**/firebase-auth-compat.js', (r) => r.fulfill({ contentType: 'text/javascript', body: stub }));
    const bodies = [];
    await page.route('**/auth/fb-complete', async (r) => {
      try { bodies.push(JSON.parse(r.request().postData() || '{}')); } catch { bodies.push({}); }
      await r.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.addInitScript(() => { try { sessionStorage.setItem('tore.fb.sent', '1'); } catch (e) { /* ignore */ } });
    await page.goto(BASE + '/auth/fb?ticket=' + TICKET, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 20 && bodies.length === 0; i++) await sleep(400);
    check(name + ' exactly one bridge completion', bodies.length === 1, 'calls=' + bodies.length);
    check(name + ' bridged token is ' + expect, bodies.length === 1 && bodies[0].idToken === expect,
      bodies.length ? String(bodies[0].idToken) : 'none');
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL GATE76 RACE CHECKS PASSED');
process.exit(failures ? 1 : 0);
