/** up78 gate poll harness — the cross-talk scenario: the gate
 *  RESUMES polling an old ticket (previous run), then the
 *  player mints a NEW ticket. The poll must follow the NEW
 *  ticket and land the new session (reload), never sit on the
 *  old one. Inline stub server on 8914 serves the REAL
 *  gatePage(); old ticket never completes, new completes at
 *  its 2nd status hit. */
import http from 'node:http';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/home/hatch/workspace/projects/vault-rental-online/');
const { chromium } = require('playwright-core');
const { gatePage } = await import('/home/hatch/workspace/projects/tore-game/cloudflare/src/gate-page.js');

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
let rootHits = 0;
let ticketHits = 0;
const statusBy = {};
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') {
    rootHits++;
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(gatePage());
    return;
  }
  if (u.pathname === '/auth/config') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"fbLive":false}'); return; }
  if (u.pathname === '/auth/me') { res.writeHead(401); res.end('unauthorized'); return; }
  if (u.pathname === '/auth/ticket' && req.method === 'POST') {
    ticketHits++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ticket: NEW }));
    return;
  }
  if (u.pathname === '/auth/ticket-status') {
    const t = u.searchParams.get('ticket') || '';
    statusBy[t] = (statusBy[t] || 0) + 1;
    if (t === NEW && statusBy[t] >= 2) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'tore_session=proof78; Path=/; HttpOnly' });
      res.end('{"ok":true,"user":{"provider":"firebase","sub":"uid-new","name":"New User"}}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":false}');
    return;
  }
  res.writeHead(404); res.end('nf');
});
await new Promise((r) => server.listen(8914, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:8914';

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
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 13; Redmi Note 9T) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
try {
  const ctx = await browser.newContext({ userAgent: UA_ANDROID, viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.addInitScript((old) => {
    const realMM = window.matchMedia.bind(window);
    window.matchMedia = (q) => q.includes('standalone')
      ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }
      : realMM(q);
    window.__opened = [];
    window.open = (u) => { window.__opened.push(String(u)); return { closed: false, focus() {} }; };
    try {
      sessionStorage.setItem('tore.gate.pending', String(Date.now()));
      sessionStorage.setItem('tore.gate.ticket', old);
    } catch (e) { /* ignore */ }
  }, OLD);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3200);
  check('P1 the resumed poll is asking about the OLD ticket', (statusBy[OLD] || 0) >= 1, 'oldHits=' + (statusBy[OLD] || 0));
  await page.click('#btn-google');
  await page.waitForTimeout(600);
  check('P2 a NEW ticket was minted', ticketHits >= 1, 'ticketHits=' + ticketHits);
  const opened = await page.evaluate(() => window.__opened || []);
  check('P3 the bridge opened for the NEW ticket', opened.length > 0 && opened[0].includes(NEW), opened[0] || 'none');
  for (let i = 0; i < 20 && rootHits < 2; i++) await sleep(700);
  check('P4 the poll followed the NEW ticket', (statusBy[NEW] || 0) >= 2, 'newHits=' + (statusBy[NEW] || 0));
  check('P5 the new session landed (gate reloaded)', rootHits >= 2, 'rootHits=' + rootHits);
  await ctx.close();
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL GATE78 PROOF CHECKS PASSED');
process.exit(failures ? 1 : 0);
