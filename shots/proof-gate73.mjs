/** up73 gate harness — drives the REAL gatePage() served by the
 *  gate61 stub server (port 8913; restart it after gate edits).
 *  A: Android standalone — button visible, note hidden; click
 *     mints a ticket, opens /auth/fb in the browser, the poll
 *     lands the session and the gate reloads.
 *  B: iOS standalone — button hidden, note shown (unchanged).
 *  C: Android browser tab — button visible, note hidden. */
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/home/hatch/workspace/projects/vault-rental-online/');
const { chromium } = require('playwright-core');
const BASE = 'http://127.0.0.1:8913';

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

const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 13; Redmi Note 9T Build/RP1A.200720.011) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
try {
  // ---------- A: Android standalone ----------
  await reset();
  {
    const ctx = await browser.newContext({ userAgent: UA_ANDROID, viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const realMM = window.matchMedia.bind(window);
      window.matchMedia = (q) => q.includes('standalone')
        ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }
        : realMM(q);
      window.__opened = [];
      window.open = (u) => { window.__opened.push(String(u)); return { closed: false, focus() {} }; };
    });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    const vis = await page.evaluate(() => {
      const b = document.getElementById('btn-google');
      const n = document.getElementById('gate-sa-note');
      return { btn: getComputedStyle(b).display !== 'none', note: getComputedStyle(n).display !== 'none' };
    });
    check('A1 Android standalone: Google button VISIBLE', vis.btn === true);
    check('A2 Android standalone: dead-end note hidden', vis.note === false);
    await page.click('#btn-google');
    await page.waitForFunction(() => (window.__opened || []).length > 0, null, { timeout: 8000 }).catch(() => {});
    const opened = await page.evaluate(() => window.__opened || []);
    check('A3 click opened the bridge page in the browser', opened.length > 0 && opened[0].startsWith('/auth/fb?ticket='), opened[0] || 'none');
    let st = await stats();
    check('A4 a login ticket was minted', st.ticketHits >= 1, 'ticketHits=' + st.ticketHits);
    // the poll flips done at the 3rd status hit -> session -> reload
    for (let i = 0; i < 24; i++) { st = await stats(); if (st.statusHits >= 3 && st.rootHits >= 2) break; await sleep(1000); }
    check('A5 the poll landed the session and the gate reloaded', st.statusHits >= 3 && st.rootHits >= 2, 'statusHits=' + st.statusHits + ' rootHits=' + st.rootHits);
    await ctx.close();
  }
  // ---------- B: iOS standalone ----------
  await reset();
  {
    const ctx = await browser.newContext({ userAgent: UA_IPHONE, viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      try { Object.defineProperty(window.navigator, 'standalone', { get: () => true }); } catch (e) { /* ignore */ }
    });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    const vis = await page.evaluate(() => {
      const b = document.getElementById('btn-google');
      const n = document.getElementById('gate-sa-note');
      return { btn: getComputedStyle(b).display !== 'none', note: getComputedStyle(n).display !== 'none' };
    });
    check('B1 iOS standalone: Google button still hidden', vis.btn === false);
    check('B2 iOS standalone: browser note still shown', vis.note === true);
    await ctx.close();
  }
  // ---------- C: Android browser tab ----------
  await reset();
  {
    const ctx = await browser.newContext({ userAgent: UA_ANDROID, viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    const vis = await page.evaluate(() => {
      const b = document.getElementById('btn-google');
      const n = document.getElementById('gate-sa-note');
      return { btn: getComputedStyle(b).display !== 'none', note: getComputedStyle(n).display !== 'none' };
    });
    check('C1 Android tab: Google button visible', vis.btn === true);
    check('C2 Android tab: note hidden', vis.note === false);
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL GATE73 PROOF CHECKS PASSED');
process.exit(failures ? 1 : 0);
