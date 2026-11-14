/** up79 GIS harness — drives the REAL fbPage() (gate61 stub
 *  server, port 8913, fbPage called with a test client ID)
 *  with a stubbed GIS client: the official button renders, the
 *  Firebase redirect NEVER fires, and clicking the button
 *  delivers a (fake) Google credential whose token must reach
 *  /auth/fb-complete verbatim and land the page on /auth/done. */
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
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const FAKE_JWT = b64u({ alg: 'RS256', kid: 'x' }) + '.' +
  b64u({ aud: 'test-client-id.apps.googleusercontent.com', iss: 'https://accounts.google.com', sub: 'G-708', email: 'shuaibanwari708@gmail.com', email_verified: true }) + '.fakesig';

const GIS_STUB = [
  'window.google = { accounts: { id: {',
  '  initialize: function (cfg) { window.__gisCfg = cfg; },',
  '  renderButton: function (el) { el.innerHTML = \'<button id="gis-stub-btn" type="button">Continue with Google</button>\'; },',
  '  prompt: function () {}',
  '} } };',
].join('\n');
const AUTH_STUB = [
  'window.__fbp = { redirectCalls: 0 };',
  'window.firebase = { initializeApp: function () {} };',
  'firebase.auth = function () {',
  '  return {',
  '    currentUser: null,',
  '    getRedirectResult: function () { return Promise.resolve(null); },',
  '    onAuthStateChanged: function (cb) { setTimeout(function () { cb(null); }, 10); return function () {}; },',
  '    signInWithRedirect: function (p) { window.__fbp.redirectCalls++; return Promise.resolve(); }',
  '  };',
  '};',
  'firebase.auth.GoogleAuthProvider = function () { this.setCustomParameters = function () {}; };',
].join('\n');

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.route('**/gsi/client', (r) => r.fulfill({ contentType: 'text/javascript', body: GIS_STUB }));
  await page.route('**/firebase-app-compat.js', (r) => r.fulfill({ contentType: 'text/javascript', body: AUTH_STUB }));
  await page.route('**/firebase-auth-compat.js', (r) => r.fulfill({ contentType: 'text/javascript', body: AUTH_STUB }));
  const bodies = [];
  await page.route('**/auth/fb-complete', async (r) => {
    try { bodies.push(JSON.parse(r.request().postData() || '{}')); } catch { bodies.push({}); }
    await new Promise((res) => setTimeout(res, 700)); // hold: lets the test read the trail first
    await r.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.goto(BASE + '/auth/fb?ticket=' + TICKET, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#gis-stub-btn', { timeout: 6000 });
  check('H1 the GIS button renders on the bridge', true);
  const wrapVisible = await page.evaluate(() => document.getElementById('giswrap').style.display !== 'none');
  check('H2 the GIS wrap is visible (fallback button hidden)', wrapVisible);
  await page.waitForTimeout(3400); // past the 2.8 s fallback schedule
  const redirects = await page.evaluate(() => window.__fbp.redirectCalls);
  check('H3 the Firebase redirect never fired', redirects === 0, 'calls=' + redirects);
  await page.click('#gis-stub-btn');
  await page.evaluate((jwt) => { window.__gisCfg.callback({ credential: jwt }); }, FAKE_JWT);
  await page.waitForTimeout(250);
  const dbg = await page.evaluate(() => document.getElementById('dbg') ? document.getElementById('dbg').textContent : '');
  check('H4 the trail names the picked account', dbg.includes('gis:shuaibanwari708@gmail.com'), dbg.slice(0, 120));
  await page.waitForTimeout(1200);
  check('H5 exactly one completion, with the Google credential', bodies.length === 1 && bodies[0].idToken === FAKE_JWT && bodies[0].ticket === TICKET,
    'calls=' + bodies.length);
  const url = page.url();
  check('H6 the page landed on /auth/done', url.includes('/auth/done'), url);
  await ctx.close();
} finally {
  await browser.close();
}
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL GATE79 PROOF CHECKS PASSED');
process.exit(failures ? 1 : 0);
