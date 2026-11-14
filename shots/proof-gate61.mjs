/** Gate proof — drives the REAL gate page (served by the local
 *  gate61 server) in Chromium:
 *    S  standalone (installed app) after up69: no email form,
 *       Google hidden, the browser-guidance note shows.
 *    T  browser tab regression: the Google popup flow still runs
 *       and signs the tab in.
 *    F  the /auth/fb bridge page still completes a direct-visit
 *       persisted user into a ticket (dormant but kept).
 *    E  browser tab after up69: Google only, no email form.
 *  Firebase's modular SDK is stubbed by route interception; the
 *  compat SDK on the fb page is stubbed the same way. */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require2 = createRequire('/home/hatch/workspace/projects/vault-rental-online/x.js');
const { chromium } = require2('playwright-core');
const BASE = 'http://127.0.0.1:8913';
const TICKET = '0123456789abcdef0123456789abcdef';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
async function stats() { const r = await fetch(BASE + '/__stats'); return r.json(); }
async function reset() { await fetch(BASE + '/__mode', { method: 'POST', body: 'reset' }); }
async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 200)); }
  return false;
}
function findChrome() {
  const out = execFileSync('bash', ['-c', "ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux/chrome ~/.cache/ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell 2>/dev/null | sort -V | tail -1"], { encoding: 'utf8' }).trim();
  if (!out) throw new Error('no chromium build found');
  return out;
}

const AUTH_STUB = [
  'window.__fb = {};',
  'function fakeUser(email) { return { getIdToken: () => Promise.resolve("TESTTOKEN"), email: email, displayName: "Gate Tester", photoURL: null }; }',
  'export function getAuth() { return {}; }',
  'export class GoogleAuthProvider {}',
  'export function onAuthStateChanged(auth, cb) { return function () {}; }',
  'export function signInWithPopup(auth, p) { window.__fb.popup = (window.__fb.popup || 0) + 1; return Promise.resolve({ user: fakeUser("tab@example.com") }); }',
  'export function signInWithRedirect(auth, p) { window.__fb.redirect = (window.__fb.redirect || 0) + 1; return Promise.resolve(); }',
  'export function getRedirectResult() { return Promise.resolve(null); }',
  'export function sendSignInLinkToEmail(auth, email, settings) { window.__fb.link = (window.__fb.link || 0) + 1; window.__fb.linkUrl = settings && settings.url; window.__fb.linkEmail = email; return Promise.resolve(); }',
].join('\n');
const APP_STUB = 'export function initializeApp() { return {}; }\n';
const COMPAT_APP = 'window.firebase = { initializeApp: function () {} };\n';
const COMPAT_AUTH = [
  'window.__fbp = { persisted: true, popupUsed: false };',
  'firebase.auth = function () {',
  '  var listeners = [];',
  '  var user = window.__fbp.persisted ? { getIdToken: function () { return Promise.resolve("TESTTOKEN"); }, email: "fb@example.com", displayName: "Fb Tester", photoURL: null } : null;',
  '  return {',
  '    getRedirectResult: function () { return Promise.resolve(null); },',
  '    onAuthStateChanged: function (cb) { listeners.push(cb); setTimeout(function () { cb(user); }, 30); return function () {}; },',
  '    signInWithRedirect: function (p) { window.__fbp.popupUsed = true; return Promise.resolve(); },',
  '    GoogleAuthProvider: function () {}',
  '  };',
  '};',
  'firebase.auth.GoogleAuthProvider = function () {};',
].join('\n');

let browser;
try {
  browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
  async function newGatePage(standalone) {
    const ctx = await browser.newContext({ viewport: { width: 400, height: 780 } });
    await ctx.route('**/firebase-app.js', (r) => r.fulfill({ contentType: 'text/javascript', body: APP_STUB }));
    await ctx.route('**/firebase-auth.js', (r) => r.fulfill({ contentType: 'text/javascript', body: AUTH_STUB }));
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    if (standalone) {
      await page.addInitScript(() => {
        try {
          Object.defineProperty(window.navigator, 'standalone', { get: () => true });
        } catch (e) { /* ignore */ }
      });
    }
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.__gateDefined !== 'undefined' || document.getElementById('btn-google'), null, { timeout: 8000 }).catch(() => {});
    await page.waitForSelector('#btn-google', { state: 'attached', timeout: 8000 });
    return { ctx, page, errs };
  }
  async function newFbPage() {
    const ctx = await browser.newContext({ viewport: { width: 400, height: 780 } });
    await ctx.route('**/firebase-app-compat.js', (r) => r.fulfill({ contentType: 'text/javascript', body: COMPAT_APP }));
    await ctx.route('**/firebase-auth-compat.js', (r) => r.fulfill({ contentType: 'text/javascript', body: COMPAT_AUTH }));
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    return { ctx, page, errs };
  }

  // ---- S: standalone after the email removal (up69) ------------
  await reset();
  {
    const { ctx, page, errs } = await newGatePage(true);
    const vis = await page.evaluate(() => {
      const gb = document.getElementById('btn-google');
      const note = document.getElementById('gate-sa-note');
      return {
        emailGone: !document.getElementById('gate-email'),
        google: !!gb && gb.style.display !== 'none',
        note: !!note && note.style.display !== 'none'
      };
    });
    check('S1 standalone: no email form, Google hidden, browser note shown', vis.emailGone && !vis.google && vis.note, JSON.stringify(vis));
    check('S2 no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ---- T: browser-tab regression --------------------------------
  await reset();
  {
    const { ctx, page, errs } = await newGatePage(false);
    await page.click('#btn-google');
    const popped = await waitFor(async () => (await stats()).firebaseHits >= 1, 8000);
    check('T1 tab Google popup flow completes into /auth/firebase', popped, JSON.stringify(await stats()));
    const signed = await waitFor(async () => (await stats()).rootHits >= 2, 8000);
    check('T2 tab signed in (gate reloaded)', signed, JSON.stringify(await stats()));
    check('T3 no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ---- F: the bridge page completes a persisted user ------------
  await reset();
  {
    const { ctx, page, errs } = await newFbPage();
    await page.goto(BASE + '/auth/fb?ticket=' + TICKET, { waitUntil: 'load' });
    const bridged = await waitFor(async () => (await stats()).fbCompleteHits >= 1, 8000);
    check('F1 fb page bridges a persisted user into the ticket', bridged, JSON.stringify(await stats()));
    const landed = await waitFor(async () => (await stats()).doneHits >= 1, 5000);
    check('F2 fb page lands on /auth/done', landed, JSON.stringify(await stats()));
    check('F3 no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ---- E: the tab gate after the email removal (up69) ----------
  await reset();
  {
    const { ctx, page, errs } = await newGatePage(false);
    const vis = await page.evaluate(() => {
      const gb = document.getElementById('btn-google');
      return { emailGone: !document.getElementById('gate-email'), google: !!gb && gb.style.display !== 'none' };
    });
    check('E1 tab gate is Google-only (no email form)', vis.emailGone && vis.google, JSON.stringify(vis));
    check('E2 no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
} catch (e) {
  console.log('ERROR ' + (e && e.message || e));
  failures++;
} finally {
  if (browser) await browser.close();
}
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
