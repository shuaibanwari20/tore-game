#!/usr/bin/env node
/**
 * tore-proofs-delivery.mjs — up39: serveClient() must NEVER hang.
 *
 * Root cause (2026-11-12 iPhone outage, diagnosed in wk-diag): on an
 * edge-cache miss the Worker ran `await fetch(CLIENT_URL)` (~950 KB
 * from GitHub Raw) with NO timeout. A brand-new ?v= URL is cold in
 * every POP, so the first loads after a deploy pulled the file
 * inside the request path — and a stalled upstream fetch hung the
 * page forever (blank page + stuck loading bar) while warm POPs
 * loaded fine. The client code was innocent (boots in JSC).
 *
 * This driver runs the REAL Worker (wrangler dev, the production
 * stack) against a controllable in-process "GitHub Raw" (per-path
 * modes + hit counters) and proves the up39 fallback chain:
 *   T1  happy path: fast upstream -> client served; 2nd load from
 *       the per-URL edge copy (upstream hit once); If-None-Match ->
 *       bodyless 304; home BOOTS in Chromium.
 *   T2  fresh ?v= (per-URL cold, same persisted cache = same POP),
 *       upstream STALLS forever: the response completes < 15 s
 *       serving the LAST-GOOD copy, ETagged as the version it
 *       holds, and the game BOOTS from it. T2b: same with a
 *       TRICKLING upstream (headers + partial body, then silence)
 *       — the body read must abort on the same bound.
 *   T3  upstream 500 -> last-good served fast. T3b: with (a)+(b)
 *       cold, the PREVIOUS version is fetched via
 *       FALLBACK_CLIENT_URL and served with its own ETag. T3c:
 *       once the fallback's edge copy exists, a stalled fallback
 *       upstream is not even consulted.
 *   T4  everything cold + upstream DOWN (connection refused): the
 *       Persian 503 "updating" page, promptly. T4b: both URLs
 *       stall with cold caches -> still a bounded 503 (< 15 s =
 *       the 8 s + 5 s timeouts; never a hang).
 *
 * Sessions share --persist-to dirs to model ONE POP across
 * deploys: wrangler dev's Cache API persists there, so a new ?v=
 * URL is cold while last-good / previous-version entries stay warm
 * — exactly the production geometry of the outage.
 *
 *   node shots/tore-proofs-delivery.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const H = os.homedir();
const ROOT = path.join(H, 'workspace/projects/tore-game');
const CF = path.join(ROOT, 'cloudflare');
const TMP = path.join(H, 'workspace/tmp-build/up39');
fs.mkdirSync(TMP, { recursive: true });

let chromium = null;
try {
  chromium = require(path.join(H, 'workspace/projects/vault-rental-online/node_modules/playwright-core')).chromium;
} catch { /* fall through */ }
function findChrome() {
  const base = path.join(H, '.cache/ms-playwright');
  if (!fs.existsSync(base)) return null;
  for (const dir of fs.readdirSync(base).sort().reverse()) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome-headless-shell-linux/headless_shell']) {
      const p = path.join(base, dir, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const info = (msg) => console.log('INFO  ' + msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------
// Fixtures: the current (nosfx) dist and the previous (feat2) dist.
// ------------------------------------------------------------------
const CUR_BUF = fs.readFileSync(path.join(CF, 'dist-client.html'));
const FB_BUF = fs.readFileSync(path.join(H, 'workspace/tmp-build/up37/cloudflare/dist-client.html'));
check('fixtures: current and feat2 dists differ', !CUR_BUF.equals(FB_BUF),
  CUR_BUF.length + 'B vs ' + FB_BUF.length + 'B');
const workerSrc = fs.readFileSync(path.join(CF, 'src/worker.js'), 'utf8');
check('worker.js serves ?v=20261113-thirteen', workerSrc.includes('dist-client.html?v=20261113-thirteen'));
check('worker.js fallback keeps the feat2 URL', workerSrc.includes('dist-client.html?v=20261112-feat2'));
check('worker.js has the bounded fetch (AbortController + timeouts)',
  workerSrc.includes('CLIENT_FETCH_TIMEOUT_MS = 8000') && workerSrc.includes('FALLBACK_FETCH_TIMEOUT_MS = 5000'));
check('worker.js defines LAST_GOOD_CACHE_URL', /LAST_GOOD_CACHE_URL = '[^']+'/.test(workerSrc));

// ------------------------------------------------------------------
// Controllable upstream ("GitHub Raw"): per-path modes + hit counts.
// ------------------------------------------------------------------
const UP_PORT = 8902;
const modes = { cur: 'fast', fb: 'fast' };
const hits = { cur: 0, fb: 0 };
const held = new Set();
const upstream = http.createServer((req, res) => {
  const which = req.url.startsWith('/cur') ? 'cur' : req.url.startsWith('/fb') ? 'fb' : null;
  if (!which) { res.writeHead(404); res.end('nope'); return; }
  hits[which]++;
  const buf = which === 'cur' ? CUR_BUF : FB_BUF;
  const mode = modes[which];
  if (mode === 'fast') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
  } else if (mode === '500') {
    res.writeHead(500); res.end('upstream boom');
  } else if (mode === 'stall') {
    held.add(res); res.on('close', () => held.delete(res)); // never respond
  } else if (mode === 'trickle') {
    held.add(res); res.on('close', () => held.delete(res));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
    res.write(buf.subarray(0, 200)); // headers + a sliver of body, then silence
  }
});
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));
info('upstream on 127.0.0.1:' + UP_PORT + ' (per-path modes: fast|stall|trickle|500)');
const CUR = (v) => `http://127.0.0.1:${UP_PORT}/cur?v=${v}`;
const FB = `http://127.0.0.1:${UP_PORT}/fb?v=20261112-feat2`;

// ------------------------------------------------------------------
// Session cookie, minted exactly like cloudflare/test/mint-session.mjs
// ------------------------------------------------------------------
const devVars = fs.readFileSync(path.join(CF, '.dev.vars'), 'utf8');
const secret = devVars.match(/^SESSION_SECRET=(.+)$/m)[1].trim();
const payload = { provider: 'google', sub: 'local-test-1', name: 'شعیب تستی', email: 'test@example.com', picture: '', exp: Date.now() + 3600 * 1000 };
const bodyB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
const sig = crypto.createHmac('sha256', secret).update(bodyB64, 'utf8').digest();
const COOKIE_VALUE = bodyB64 + '.' + sig.toString('base64url');
const COOKIE = 'tore_session=' + COOKIE_VALUE;

// ------------------------------------------------------------------
// wrangler dev session management
// ------------------------------------------------------------------
// One port PER session (no waiting on a slow workerd shutdown),
// and shutdown kills only OUR workerd — matched by its socket
// port in the cmdline — never other suites' instances.
let wranglerProc = null;
let wranglerPort = null;
async function startWrangler(persistDir, clientUrl, fallbackUrl, label, port) {
  await stopWrangler();
  const logPath = path.join(TMP, 'wr-' + label + '.log');
  const out = fs.openSync(logPath, 'w');
  wranglerProc = spawn('npx', ['wrangler', 'dev', '--port', String(port),
    '--persist-to', persistDir,
    '--var', 'CLIENT_URL:' + clientUrl,
    '--var', 'FALLBACK_CLIENT_URL:' + fallbackUrl],
    { cwd: CF, stdio: ['ignore', out, out] });
  wranglerPort = port;
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 45; i++) {
    try {
      const r = await fetch(base + '/auth/config');
      if (r.status === 200) { info('wrangler up (' + label + ', port ' + port + ')'); return base; }
    } catch { /* not yet */ }
    await sleep(2000);
  }
  throw new Error('wrangler did not come up for ' + label + ' — see ' + logPath);
}
async function stopWrangler() {
  if (wranglerProc) { try { wranglerProc.kill('SIGTERM'); } catch { /* gone */ } wranglerProc = null; }
  if (wranglerPort) {
    try {
      const pids = execSync("pgrep -f 'socket-addr=entry=localhost:" + wranglerPort + "'", { encoding: 'utf8' })
        .split('\n').map((s) => s.trim()).filter(Boolean);
      for (const pid of pids) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } }
    } catch { /* none matched */ }
    wranglerPort = null;
  }
  await sleep(1200);
}

// Timed GET / with the session cookie. A 40 s client-side abort is
// the hang detector: if serveClient ever regresses to unbounded,
// this fetch dies at 40 s and the timing checks fail loudly.
async function getPage(base, headers = {}) {
  const ctl = new AbortController();
  const killer = setTimeout(() => ctl.abort(), 40000);
  const t0 = Date.now();
  try {
    const res = await fetch(base + '/', { headers: { Cookie: COOKIE, ...headers }, redirect: 'manual', signal: ctl.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buf, ms: Date.now() - t0, etag: res.headers.get('ETag'), cc: res.headers.get('Cache-Control'), hung: false };
  } catch (e) {
    return { status: 0, buf: Buffer.alloc(0), ms: Date.now() - t0, etag: null, cc: null, hung: true };
  } finally { clearTimeout(killer); }
}

async function bootCheck(base, label, navTimeoutMs) {
  const exe = chromium && findChrome();
  if (!exe) { check(label + ': browser available', false, 'playwright/chromium missing'); return; }
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addCookies([{ name: 'tore_session', value: COOKIE_VALUE, domain: '127.0.0.1', path: '/' }]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/', { waitUntil: 'load', timeout: navTimeoutMs });
    let booted = true;
    try { await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 20000 }); }
    catch { booted = false; }
    check(label + ': game boots (home visible)', booted && errors.length === 0,
      errors.length ? 'pageerrors: ' + errors.join('; ') : '');
  } finally {
    await browser.close();
  }
}

// ==================================================================
// S1 — T1 happy path
// ===================================================================
const PA = path.join(TMP, 'persist-a');
fs.rmSync(PA, { recursive: true, force: true });
let base = await startWrangler(PA, CUR('20261112-seek'), FB, 's1', 8841);
const me = await fetch(base + '/auth/me', { headers: { Cookie: COOKIE } });
check('T1 setup: minted session accepted (/auth/me 200)', me.status === 200, 'got ' + me.status);

const t1a = await getPage(base);
check('T1: happy path serves 200 + current dist', t1a.status === 200 && t1a.buf.equals(CUR_BUF),
  t1a.status + ', ' + t1a.buf.length + 'B, ' + t1a.ms + 'ms');
check('T1: ETag is the current version tag', t1a.etag === '"tore-20261112-seek"', String(t1a.etag));
check('T1: browser Cache-Control is no-cache', t1a.cc === 'no-cache', String(t1a.cc));
check('T1: upstream fetched exactly once', hits.cur === 1, 'hits.cur=' + hits.cur);
const t1b = await getPage(base);
check('T1: second load from the per-URL edge copy (no new upstream fetch)',
  t1b.status === 200 && t1b.buf.equals(CUR_BUF) && hits.cur === 1, 'hits.cur=' + hits.cur);
const t1c = await getPage(base, { 'If-None-Match': '"tore-20261112-seek"' });
check('T1: If-None-Match with the current ETag -> bodyless 304',
  t1c.status === 304 && t1c.buf.length === 0, t1c.status + ', ' + t1c.buf.length + 'B');
await bootCheck(base, 'T1', 30000);

// ==================================================================
// S2 — T2 stall / T2b trickle (same POP: persist-a; NEW ?v= = cold)
// ===================================================================
modes.cur = 'stall';
base = await startWrangler(PA, CUR('20261112-seek2'), FB, 's2', 8842);
const t2 = await getPage(base);
check('T2: stalled upstream -> response completes < 15 s (never hangs)',
  !t2.hung && t2.ms < 15000, t2.ms + 'ms');
check('T2: the wait was the bounded 8 s timeout, not an instant error', t2.ms >= 6000, t2.ms + 'ms');
check('T2: last-good copy served (200, current bytes)', t2.status === 200 && t2.buf.equals(CUR_BUF),
  t2.status + ', ' + t2.buf.length + 'B');
check('T2: fallback response ETagged as the version the copy holds',
  t2.etag === '"tore-20261112-seek"', String(t2.etag));
check('T2: fallback URL was not needed (upstream /fb untouched)', hits.fb === 0, 'hits.fb=' + hits.fb);
await bootCheck(base, 'T2 (boots from the last-good fallback)', 70000);

modes.cur = 'trickle';
const t2b = await getPage(base);
check('T2b: trickling upstream -> body read aborts on the same bound, last-good served',
  !t2b.hung && t2b.ms < 15000 && t2b.status === 200 && t2b.buf.equals(CUR_BUF),
  t2b.ms + 'ms, ' + t2b.status);
modes.cur = 'fast';

// ==================================================================
// S3 — T3 upstream 500 (same POP; another new ?v= = cold)
// ===================================================================
modes.cur = '500';
base = await startWrangler(PA, CUR('20261112-seek3'), FB, 's3', 8843);
const t3 = await getPage(base);
check('T3: upstream 500 -> last-good served, fast',
  t3.status === 200 && t3.buf.equals(CUR_BUF) && t3.ms < 5000, t3.ms + 'ms, ' + t3.status);
modes.cur = 'fast';

// ==================================================================
// S4 — T3b previous-version fallback (FRESH POP: (a) and (b) cold)
// ===================================================================
const PB = path.join(TMP, 'persist-b');
fs.rmSync(PB, { recursive: true, force: true });
modes.cur = '500';
base = await startWrangler(PB, CUR('20261112-seek'), FB, 's4', 8844);
const fbHitsBefore = hits.fb;
const t3b = await getPage(base);
check('T3b: (a)+(b) cold -> previous version fetched via FALLBACK_CLIENT_URL',
  t3b.status === 200 && t3b.buf.equals(FB_BUF) && hits.fb === fbHitsBefore + 1,
  t3b.status + ', hits.fb=' + hits.fb);
check('T3b: fallback response carries the feat2 ETag', t3b.etag === '"tore-20261112-feat2"', String(t3b.etag));

// ==================================================================
// S5 — T3c fallback edge copy (same POP as S4; fallback now stalls)
// ===================================================================
modes.fb = 'stall';
base = await startWrangler(PB, CUR('20261112-seek'), FB, 's5', 8845);
const t3c = await getPage(base);
check('T3c: fallback edge copy serves without consulting the stalled fallback upstream',
  t3c.status === 200 && t3c.buf.equals(FB_BUF) && hits.fb === fbHitsBefore + 1 && t3c.ms < 4000,
  t3c.ms + 'ms, hits.fb=' + hits.fb);
modes.cur = 'fast'; modes.fb = 'fast';

// ==================================================================
// S6 — T4 cold everything + upstream down (connection refused)
// ===================================================================
const PC = path.join(TMP, 'persist-c');
fs.rmSync(PC, { recursive: true, force: true });
base = await startWrangler(PC, 'http://127.0.0.1:59999/cur?v=20261112-seek', 'http://127.0.0.1:59999/fb?v=20261112-feat2', 's6', 8846);
const t4 = await getPage(base);
check('T4: cold caches + upstream down -> prompt 503 (no hang)',
  !t4.hung && t4.status === 503 && t4.ms < 15000, t4.status + ', ' + t4.ms + 'ms');
check('T4: the 503 is the Persian updating page', t4.buf.toString('utf8').includes('در حال به‌روزرسانی'));

// ==================================================================
// S7 — T4b both URLs stall, cold caches -> bounded 503
// ===================================================================
const PD = path.join(TMP, 'persist-d');
fs.rmSync(PD, { recursive: true, force: true });
modes.cur = 'stall'; modes.fb = 'stall';
base = await startWrangler(PD, CUR('20261112-seek'), FB, 's7', 8847);
const t4b = await getPage(base);
check('T4b: both URLs stalled + cold caches -> bounded 503 (< 15 s)',
  !t4b.hung && t4b.status === 503 && t4b.ms < 15000, t4b.status + ', ' + t4b.ms + 'ms');
check('T4b: both timeouts were waited out (8 s + 5 s)', t4b.ms >= 10000, t4b.ms + 'ms');

// ------------------------------------------------------------------
await stopWrangler();
for (const res of held) { try { res.destroy(); } catch { /* gone */ } }
upstream.close();
console.log(failures === 0 ? '\nDELIVERY: ALL CHECKS PASSED' : '\nDELIVERY: ' + failures + ' CHECK(S) FAILED');
process.exit(failures ? 1 : 0);
