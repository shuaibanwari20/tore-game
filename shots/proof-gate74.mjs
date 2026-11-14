/** up74 bridge harness — drives the REAL fbPage() served by the
 *  gate61 stub server (port 8913; restart it after fb edits),
 *  with the Firebase compat SDK stubbed per scenario.
 *  F1 fresh browser: the page goes to Google BY ITSELF (no tap),
 *     with the account chooser forced.
 *  F2 persisted user: still goes to the chooser — no silent
 *     bridge, no /auth/fb-complete.
 *  F3 return leg (sent flag + redirect result): bridges and
 *     lands on /auth/done. */
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
const stats = async () => (await (await fetch(BASE + '/__stats')).json());
const reset = async () => { await fetch(BASE + '/__mode', { method: 'POST' }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stubFor(mode) {
  const user = mode === 'fresh' ? 'null'
    : '{ getIdToken: function () { return Promise.resolve("TESTTOKEN"); }, email: "fb@example.com", displayName: "Fb Tester", photoURL: null }';
  const result = mode === 'result' ? '{ user: user }' : 'null';
  return [
    'window.__fbp = { redirectCalls: 0, providerParams: null };',
    'window.firebase = { initializeApp: function () {} };',
    'firebase.auth = function () {',
    '  var user = ' + user + ';',
    '  return {',
    '    currentUser: user,',
    '    getRedirectResult: function () { return Promise.resolve(' + result + '); },',
    '    onAuthStateChanged: function (cb) { setTimeout(function () { cb(user); }, 30); return function () {}; },',
    '    signInWithRedirect: function (p) { window.__fbp.redirectCalls++; return Promise.resolve(); }',
    '  };',
    '};',
    'firebase.auth.GoogleAuthProvider = function () { this.setCustomParameters = function (o) { window.__fbp.providerParams = o; }; };',
  ].join('\n');
}

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
try {
  for (const [name, mode, sent] of [['F1', 'fresh', false], ['F2', 'persisted', false], ['F3', 'result', true]]) {
    await reset();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const stub = stubFor(mode);
    await page.route('**/firebase-app-compat.js', (r) => r.fulfill({ contentType: 'text/javascript', body: stub }));
    await page.route('**/firebase-auth-compat.js', (r) => r.fulfill({ contentType: 'text/javascript', body: stub }));
    if (sent) {
      await page.addInitScript(() => { try { sessionStorage.setItem('tore.fb.sent', '1'); } catch (e) { /* ignore */ } });
    }
    await page.goto(BASE + '/auth/fb?ticket=' + TICKET, { waitUntil: 'domcontentloaded' });
    if (name === 'F3') {
      let st = await stats();
      for (let i = 0; i < 16 && st.fbCompleteHits < 1; i++) { await sleep(500); st = await stats(); }
      check('F3 return leg bridges via /auth/fb-complete', st.fbCompleteHits >= 1, 'fbCompleteHits=' + st.fbCompleteHits);
      await page.waitForTimeout(700);
      check('F3 lands on /auth/done', page.url().includes('/auth/done'), page.url());
    } else {
      await page.waitForTimeout(1800);
      const s = await page.evaluate(() => ({
        calls: window.__fbp ? window.__fbp.redirectCalls : -1,
        params: window.__fbp ? window.__fbp.providerParams : null,
        btnDisplay: getComputedStyle(document.getElementById('btn')).display,
      }));
      check(name + ' auto-redirects to Google with NO tap', s.calls === 1, 'calls=' + s.calls);
      check(name + ' account chooser forced', !!s.params && s.params.prompt === 'select_account', JSON.stringify(s.params));
      check(name + ' bridge button stays hidden', s.btnDisplay === 'none');
      const st = await stats();
      check(name + ' nothing bridged before the player chooses', st.fbCompleteHits === 0, 'fbCompleteHits=' + st.fbCompleteHits);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL GATE74 PROOF CHECKS PASSED');
process.exit(failures ? 1 : 0);
