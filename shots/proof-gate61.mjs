/** up60 proof — the installed-app gate signs in by TICKET.
 *  S (standalone): the tap mints a ticket, opens /auth/fb?ticket=
 *     in a new sheet, polls the status, and when the (mimicked)
 *     completion lands, the gate reloads ITSELF with the session
 *     cookie set in THIS context. Firebase is never used.
 *  T (browser tab): regression — the Firebase popup still runs
 *     first, hangs (stubbed), and falls back to redirect. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const chromium = require(path.join(os.homedir(), 'workspace/projects/vault-rental-online/node_modules/playwright-core')).chromium;
function findChrome() {
  const base = path.join(os.homedir(), '.cache/ms-playwright');
  for (const dir of fs.readdirSync(base).sort().reverse()) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome-headless-shell-linux/headless_shell']) {
      const p = path.join(base, dir, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
const BASE = 'http://127.0.0.1:8913';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, stepMs = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (await fn()) return true; await sleep(stepMs); }
  return false;
}
async function reset() { await fetch(BASE + '/__mode', { method: 'POST', body: 'x' }); }
async function stats() { const r = await fetch(BASE + '/__stats'); return r.json(); }

const APP_STUB = 'export function initializeApp() { return {}; }';
const AUTH_STUB = [
  'window.__fb = { popup: 0, redirect: 0 };',
  'export function getAuth() { return {}; }',
  'export class GoogleAuthProvider {}',
  'export function signInWithPopup() { window.__fb.popup++; return new Promise(function () {}); }',
  'export function signInWithRedirect() { window.__fb.redirect++; return new Promise(function () {}); }',
  'export function getRedirectResult() { return Promise.resolve(null); }',
].join('\n');

let server = null;
let browser = null;
try {
  server = spawn('node', [path.join(os.homedir(), 'workspace/tmp-build/gate61-server.mjs')], { stdio: 'pipe' });
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
    const COMPAT_STUB = [
      'window.__sheet = { redirect: 0 };',
      'window.firebase = {',
      '  initializeApp: function () { return {}; },',
      '  auth: function () { return {',
      '    getRedirectResult: function () { return Promise.resolve(null); },',
      '    currentUser: null,',
      '    onAuthStateChanged: function (cb) { setTimeout(function () { cb(null); }, 30); },',
      '    signInWithRedirect: function () { window.__sheet.redirect++; return new Promise(function () {}); }',
      '  }; }',
      '};',
      'window.firebase.auth.GoogleAuthProvider = function () {};',
    ].join('\n');
    await ctx.route('https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js', (r) =>
      r.fulfill({ contentType: 'text/javascript', body: COMPAT_STUB }));
    await ctx.route('https://www.gstatic.com/firebasejs/10.12.5/firebase-auth-compat.js', (r) =>
      r.fulfill({ contentType: 'text/javascript', body: '' }));
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForSelector('#btn-google', { timeout: 8000 });
    await sleep(400);
    return { ctx, page, errs };
  }

  // ---- S: standalone ticket flow --------------------------------
  await reset();
  {
    const { ctx, page, errs } = await newGatePage(true);
    const opened = [];
    let sheetPage = null;
    ctx.on('page', (p) => { opened.push(p.url()); sheetPage = p; });
    await page.click('#btn-google');
    const sheetOk = await waitFor(() => opened.some((u) => u.includes('/auth/fb?ticket=0123456789abcdef0123456789abcdef')), 5000);
    check('S1 fb bridge page opened with the ticket', sheetOk, opened.join(' , '));
    const codeShown = await waitFor(async () => {
      const v = await page.evaluate(() => {
        const el = document.getElementById('gate-code');
        const box = document.getElementById('gate-codebox');
        return el && box ? { t: el.textContent, vis: box.style.display !== 'none' } : null;
      }).catch(() => null);
      return v && v.t === '12345678' && v.vis ? v : null;
    }, 5000);
    check('S8 sign-in code shown on the app gate', !!codeShown, JSON.stringify(codeShown));
    const reloaded = await waitFor(async () => (await stats()).rootHits >= 2, 14000);
    check('S2 ticket poll completed and the gate reloaded itself', reloaded, JSON.stringify(await stats()));
    const cookies = await ctx.cookies(BASE);
    const sess = cookies.find((c) => c.name === 'tore_session');
    check('S3 session cookie landed in THIS context', !!sess && sess.value === 'proof-cookie', JSON.stringify(cookies.map((c) => c.name)));
    await waitFor(async () => (await page.evaluate(() => typeof window.__fb !== 'undefined').catch(() => false)), 6000);
    const f = await page.evaluate(() => window.__fb || { popup: -1, redirect: -1 }).catch(() => ({ popup: -2, redirect: -2 }));
    check('S4 Firebase sign-in never used in standalone', f.popup === 0 && f.redirect === 0, JSON.stringify(f));
    check('S5 no page errors', errs.length === 0, errs.join(' | '));
    if (sheetPage) {
      await sheetPage.waitForSelector('#btn', { timeout: 6000 }).catch(() => {});
      const tk = await sheetPage.evaluate(() => (typeof TICKET !== 'undefined' ? TICKET : '')).catch(() => '');
      check('S6 sheet page is the real fb page with the ticket', tk === '0123456789abcdef0123456789abcdef', tk);
      await sheetPage.click('#btn').catch(() => {});
      const redir = await waitFor(async () => (await sheetPage.evaluate(() => window.__sheet || { redirect: -1 })).redirect === 1, 5000).catch(() => false);
      check('S7 sheet button starts Firebase redirect sign-in', !!redir);
    } else {
      check('S6 sheet page is the real fb page with the ticket', false, 'no sheet page');
      check('S7 sheet button starts Firebase redirect sign-in', false, 'no sheet page');
    }
    await ctx.close();
  }

  // ---- T: browser-tab regression --------------------------------
  await reset();
  {
    const { ctx, page, errs } = await newGatePage(false);
    await page.click('#btn-google');
    await sleep(1500);
    const f1 = await page.evaluate(() => window.__fb);
    check('T1 tab still tries the popup first', f1.popup === 1 && f1.redirect === 0, JSON.stringify(f1));
    const fell = await waitFor(async () => (await page.evaluate(() => window.__fb)).redirect === 1, 16000);
    check('T2 hung popup still falls back to redirect', fell);
    check('T3 no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  // ---- F: fb page bridges a PERSISTED user (up62) ----------------
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
    await page.goto(BASE + '/auth/fb?ticket=0123456789abcdef0123456789abcdef', { waitUntil: 'load' });
    const landed = await waitFor(() => page.url().endsWith('/auth/done'), 6000);
    check('F1 persisted user bridges and lands on /auth/done', landed, page.url());
    check('F2 bridge posted the token to /auth/fb-complete', (await stats()).fbCompleteHits >= 1, JSON.stringify(await stats()));
    await ctx.close();
  }
  // ---- C: the code rescue from a browser tab (up63) --------------
  await reset();
  {
    const ctx = await browser.newContext();
    const AUTH_OK = [
      'window.__fb = { popup: 0, redirect: 0 };',
      'export function getAuth() { return {}; }',
      'export class GoogleAuthProvider {}',
      'export function signInWithPopup() { window.__fb.popup++; return Promise.resolve({ user: { getIdToken: function () { return Promise.resolve("tok-abc"); } } }); }',
      'export function signInWithRedirect() { window.__fb.redirect++; return new Promise(function () {}); }',
      'export function getRedirectResult() { return Promise.resolve(null); }',
    ].join('\n');
    await ctx.route('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js', (r) =>
      r.fulfill({ contentType: 'text/javascript', body: APP_STUB }));
    await ctx.route('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js', (r) =>
      r.fulfill({ contentType: 'text/javascript', body: AUTH_OK }));
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForSelector('#btn-google', { timeout: 8000 });
    await sleep(400);
    const haveVisible = await page.evaluate(() => {
      const row = document.getElementById('gate-codehave-row');
      return !!row && row.style.display !== 'none';
    });
    check('C1 code entry offered in a browser tab', haveVisible);
    await page.click('#btn-codehave');
    await page.fill('#code-input', '12345678');
    await page.click('#btn-codego');
    const coded = await waitFor(async () => (await stats()).codeHits >= 1, 8000);
    check('C2 code completed with the sign-in token', coded, JSON.stringify(await stats()));
    const reloaded = await waitFor(async () => (await stats()).rootHits >= 2, 8000);
    check('C3 tab gate then signed itself in and reloaded', reloaded, JSON.stringify(await stats()));
    check('C4 no page errors', errs.length === 0, errs.join(' | '));
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
