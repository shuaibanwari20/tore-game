/** Gate proof — drives the REAL gate page (served by the local
 *  gate61 server with EMAIL_ON) in Chromium:
 *    S  standalone (installed app): email form only, Google
 *       hidden, send → code row → verify → gate reloads.
 *    T  browser tab regression: the Google popup flow still runs
 *       (popup first; a hung popup falls back to redirect).
 *    F  the /auth/fb bridge page, visited directly, bridges a
 *       PERSISTED Firebase user (the page still exists; the gate
 *       itself no longer opens it — U64).
 *    E  browser tab: Google AND the email form side by side;
 *       the email flow completes and the gate reloads.
 *  Firebase is stubbed at the CDN routes; the modular SDK is
 *  stubbed for the gate, the compat SDK for the bridge page. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const req = createRequire(path.join(os.homedir(), 'workspace/projects/vault-rental-online/package.json'));
const { chromium } = req('playwright-core');
const BASE = 'http://127.0.0.1:8913';
const TICKET = '0123456789abcdef0123456789abcdef';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const base = path.join(os.homedir(), '.cache/ms-playwright');
  const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium')).sort().reverse();
  for (const d of dirs) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-headless-shell-linux/headless_shell']) {
      const p = path.join(base, d, sub);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('no chrome build found');
}

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
async function waitFor(fn, timeout = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch { /* keep waiting */ }
    await sleep(120);
  }
  return null;
}
const stats = async () => {
  const r = await fetch(BASE + '/__stats');
  return r.json();
};
const reset = async () => {
  await fetch(BASE + '/__mode', { method: 'POST', body: '{}' });
};

const APP_STUB = 'export function initializeApp() { return {}; }';
const AUTH_STUB = [
  'window.__fb = { popup: 0, redirect: 0 };',
  'export function getAuth() { return {}; }',
  'export class GoogleAuthProvider {}',
  'export function signInWithPopup() { window.__fb.popup++; return new Promise(function () {}); }',
  'export function signInWithRedirect() { window.__fb.redirect++; return new Promise(function () {}); }',
  'export function getRedirectResult() { return Promise.resolve(null); }',
].join('\n');
const COMPAT_STUB = [
  'window.__sheet = { popup: 0, redirect: 0 };',
  'window.firebase = {',
  '  initializeApp: function () { return {}; },',
  '  auth: function () { return {',
  '    currentUser: null,',
  '    getRedirectResult: function () { return Promise.resolve(null); },',
  '    onAuthStateChanged: function (cb) { setTimeout(function () { cb(null); }, 30); },',
  '    signInWithPopup: function () { window.__sheet.popup++; return new Promise(function () {}); },',
  '    signInWithRedirect: function () { window.__sheet.redirect++; return new Promise(function () {}); }',
  '  }; }',
  '};',
  'window.firebase.auth.GoogleAuthProvider = function () {};',
].join('\n');

let server = null;
let browser = null;
try {
  server = spawn('node', [path.join(os.homedir(), 'workspace/tmp-build/gate61-server.mjs')], { stdio: 'ignore' });
  const up = await waitFor(async () => {
    try { const r = await fetch(BASE + '/__stats'); return r.ok; } catch { return false; }
  }, 8000);
  if (!up) throw new Error('gate61 server did not come up');
  browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });

  async function newGatePage(standalone) {
    const ctx = await browser.newContext();
    if (standalone) {
      await ctx.addInitScript(() => {
        try { Object.defineProperty(window.navigator, 'standalone', { get: () => true }); } catch (e) { /* ignore */ }
      });
    }
    await ctx.route('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js', (r) =>
      r.fulfill({ contentType: 'text/javascript', body: APP_STUB }));
    await ctx.route('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js', (r) =>
      r.fulfill({ contentType: 'text/javascript', body: AUTH_STUB }));
    await ctx.route('https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js', (r) =>
      r.fulfill({ contentType: 'text/javascript', body: COMPAT_STUB }));
    await ctx.route('https://www.gstatic.com/firebasejs/10.12.5/firebase-auth-compat.js', (r) =>
      r.fulfill({ contentType: 'text/javascript', body: '' }));
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(BASE + '/', { waitUntil: 'load' });
    // 'attached', not visible: in standalone the gate hides the
    // Google button by design (U65) — it is still in the DOM.
    await page.waitForSelector('#btn-google', { state: 'attached', timeout: 8000 });
    await sleep(400);
    return { ctx, page, errs };
  }

  // ---- S: standalone email sign-in (up65) -----------------------
  await reset();
  {
    const { ctx, page, errs } = await newGatePage(true);
    await page.waitForSelector('#btn-email-send', { timeout: 8000 });
    const vis = await page.evaluate(() => {
      const ge = document.getElementById('gate-email');
      const gb = document.getElementById('btn-google');
      return { email: !!ge && ge.style.display !== 'none', google: !!gb && gb.style.display !== 'none' };
    });
    check('S1 standalone shows the email form and hides Google', vis.email && !vis.google, JSON.stringify(vis));
    await page.fill('#email-input', 'unit@example.com');
    await page.click('#btn-email-send');
    const started = await waitFor(async () => (await stats()).startHits >= 1, 6000);
    check('S2 email-start posted', started, JSON.stringify(await stats()));
    const rowVis = await page.evaluate(() => {
      const r = document.getElementById('gate-email-code-row');
      return !!r && r.style.display !== 'none';
    });
    check('S3 code row revealed after send', rowVis);
    await page.fill('#email-code', '654321');
    await page.click('#btn-email-verify');
    const reloaded = await waitFor(async () => (await stats()).rootHits >= 2, 8000);
    check('S4 verify ok and the gate reloaded', reloaded, JSON.stringify(await stats()));
    check('S5 no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ---- T: browser-tab regression --------------------------------
  await reset();
  {
    const { ctx, page, errs } = await newGatePage(false);
    await page.click('#btn-google');
    const popped = await waitFor(async () => (await page.evaluate(() => (window.__fb || {}).popup || 0)) >= 1, 6000);
    check('T1 tab still tries the popup first', !!popped, JSON.stringify(await page.evaluate(() => window.__fb || {})));
    const fellBack = await waitFor(async () => (await page.evaluate(() => (window.__fb || {}).redirect || 0)) >= 1, 16000);
    check('T2 hung popup still falls back to redirect', !!fellBack);
    check('T3 no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ---- F: fb page bridges a PERSISTED user (up62) ---------------
  await reset();
  {
    const ctx = await browser.newContext();
    const PERSISTED_STUB = [
      'window.firebase = {',
      '  initializeApp: function () { return {}; },',
      '  auth: function () { return {',
      '    currentUser: null,',
      '    getRedirectResult: function () { return Promise.resolve(null); },',
      '    onAuthStateChanged: function (cb) { setTimeout(function () { cb({ getIdToken: function () { return Promise.resolve("tok-abc"); } }); }, 60); },',
      '    signInWithRedirect: function () { return new Promise(function () {}); }',
      '  }; }',
      '};',
      'window.firebase.auth.GoogleAuthProvider = function () {};',
    ].join('\n');
    await ctx.route('https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js', (r) =>
      r.fulfill({ contentType: 'text/javascript', body: PERSISTED_STUB }));
    await ctx.route('https://www.gstatic.com/firebasejs/10.12.5/firebase-auth-compat.js', (r) =>
      r.fulfill({ contentType: 'text/javascript', body: '' }));
    const page = await ctx.newPage();
    await page.goto(BASE + '/auth/fb?ticket=' + TICKET, { waitUntil: 'load' });
    const landed = await waitFor(() => page.url().endsWith('/auth/done'), 6000);
    check('F1 persisted user bridges and lands on /auth/done', landed, page.url());
    check('F2 bridge posted the token to /auth/fb-complete', (await stats()).fbCompleteHits >= 1, JSON.stringify(await stats()));
    await ctx.close();
  }

  // ---- E: the email flow from a browser tab (up65) --------------
  await reset();
  {
    const { ctx, page, errs } = await newGatePage(false);
    await page.waitForSelector('#btn-email-send', { timeout: 8000 });
    const vis = await page.evaluate(() => {
      const ge = document.getElementById('gate-email');
      const gb = document.getElementById('btn-google');
      return { email: !!ge && ge.style.display !== 'none', google: !!gb && gb.style.display !== 'none' };
    });
    check('E1 tab shows Google AND the email form', vis.email && vis.google, JSON.stringify(vis));
    await page.fill('#email-input', 'unit@example.com');
    await page.click('#btn-email-send');
    const started = await waitFor(async () => (await stats()).startHits >= 1, 6000);
    check('E2 email-start posted', started, JSON.stringify(await stats()));
    await page.fill('#email-code', '654321');
    await page.click('#btn-email-verify');
    const done = await waitFor(async () => (await stats()).verifyHits >= 1 && (await stats()).rootHits >= 2, 8000);
    check('E3 verify ok and the gate reloaded', done, JSON.stringify(await stats()));
    check('E4 no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
} catch (e) {
  console.log('ERROR', e && e.message ? e.message : e);
  failures++;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill('SIGKILL');
}
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
