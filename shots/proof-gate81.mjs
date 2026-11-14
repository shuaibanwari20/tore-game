/** up81 gate GIS harness — inline stub server (8915) serves
 *  the REAL gatePage() with a test client ID, in a desktop
 *  (tab) context with stubbed GIS + Firebase modules: the
 *  official button must appear, the Firebase popup must never
 *  be used, and the GIS credential must land at /auth/firebase
 *  and reload the gate into the game. */
import http from 'node:http';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/home/hatch/workspace/projects/vault-rental-online/');
const { chromium } = require('playwright-core');
const { gatePage } = await import('/home/hatch/workspace/projects/tore-game/cloudflare/src/gate-page.js');

let firebaseBody = null;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') {
    if ((req.headers.cookie || '').includes('tore_session=proof81')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body>GAME-OK</body></html>');
      return;
    }
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(gatePage({ gid: 'test-client-id.apps.googleusercontent.com' }));
    return;
  }
  if (u.pathname === '/auth/config') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"fbLive":false}'); return; }
  if (u.pathname === '/auth/me') { res.writeHead(401); res.end('unauthorized'); return; }
  if (u.pathname === '/auth/firebase' && req.method === 'POST') {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { firebaseBody = JSON.parse(data); } catch { firebaseBody = {}; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'tore_session=proof81; Path=/; HttpOnly' });
      res.end('{"ok":true}');
    });
    return;
  }
  res.writeHead(404); res.end('nf');
});
await new Promise((r) => server.listen(8915, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:8915';

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
const APP_STUB = 'export function initializeApp() { return {}; }';
const AUTH_STUB = [
  'window.__fbStub = { popupCalls: 0, redirectCalls: 0 };',
  'export function getAuth() { return {}; }',
  'export class GoogleAuthProvider { setCustomParameters() {} }',
  'export function signInWithPopup() { window.__fbStub.popupCalls++; return new Promise(function () {}); }',
  'export function signInWithRedirect() { window.__fbStub.redirectCalls++; return Promise.resolve(); }',
  'export function getRedirectResult() { return Promise.resolve(null); }',
  'export function onAuthStateChanged() { return function () {}; }',
].join('\n');
const CORS = { 'Access-Control-Allow-Origin': '*' };

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  await page.route('**/gsi/client', async (r) => {
    await new Promise((res) => setTimeout(res, 2500)); // slow GIS: the load window U82 closes
    await r.fulfill({ contentType: 'text/javascript', body: GIS_STUB });
  });
  await page.route('**/firebase-app.js', (r) => r.fulfill({ contentType: 'text/javascript', headers: CORS, body: APP_STUB }));
  await page.route('**/firebase-auth.js', (r) => r.fulfill({ contentType: 'text/javascript', headers: CORS, body: AUTH_STUB }));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  const early = await page.evaluate(() => ({
    g: getComputedStyle(document.getElementById('btn-google')).display,
    w: getComputedStyle(document.getElementById('giswrap')).display,
  }));
  check('K0 during the GIS load window the old button is already hidden (U82)', early.g === 'none' && early.w !== 'none', JSON.stringify(early));
  await page.waitForSelector('#gis-stub-btn', { timeout: 9000 });
  check('K1 the GIS button renders on the gate', true);
  const gateBtnDisplay = await page.evaluate(() => document.getElementById('btn-google').style.display);
  check('K2 the Firebase button is hidden once GIS is ready', gateBtnDisplay === 'none', gateBtnDisplay);
  await page.click('#gis-stub-btn');
  await page.evaluate((jwt) => { window.__gisCfg.callback({ credential: jwt }); }, FAKE_JWT);
  await page.waitForSelector('text=GAME-OK', { timeout: 8000 });
  check('K3 the gate reloaded into the game', true);
  check('K4 the posted token is the GIS credential', !!firebaseBody && firebaseBody.idToken === FAKE_JWT,
    firebaseBody ? String(firebaseBody.idToken).slice(0, 24) : 'none');
  const stub = await page.evaluate(() => window.__fbStub || null);
  check('K5 the Firebase popup was never used', !stub || stub.popupCalls === 0, stub ? 'popupCalls=' + stub.popupCalls : 'no stub state (page reloaded)');
  await ctx.close();
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL GATE81 PROOF CHECKS PASSED');
process.exit(failures ? 1 : 0);
