/**
 * test-up109.mjs — no-mic toast fix (owner report 2026-11-18: some
 * Android players saw the red «مایکروفون نشته» toast in the lobby).
 *   The red micUnavailable toast must NEVER fire again — not on
 *   lobby entry, not from any automatic path. Behaviour contract:
 *     (a) no capture API (in-app WebView): mic buttons hidden at
 *         boot, zero toasts, zero getUserMedia calls;
 *     (b) getUserMedia rejects NotReadableError (mic busy in
 *         another app) on a deliberate tap: exactly ONE gentle
 *         info toast (micHint), none on re-tap. (NotAllowedError
 *         — a permission BLOCK — no longer hints: since up110 it
 *         opens the fix-it guide; see test-up110.mjs.)
 *     (c) getUserMedia rejects NotFoundError: total silence;
 *     (d) fake-media success: mic turns on, no error toast.
 *   Plus statics: worker pin nomic, dist < 1 MB, no remaining
 *   toast(T('micUnavailable')) / toast(T('clMicDenied')) call sites,
 *   micHint present in all three languages.
 *   node shots/test-up109.mjs   (deploy host :8931)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = path.resolve(process.cwd());
const req = createRequire(path.join(ROOT, '../vault-rental-online/package.json'));
const { chromium } = req('playwright-core');
const EXE = '/home/hatch/.cache/ms-playwright/chromium-1228/chrome-linux/chrome';
const PORT = 8931;
const BASE = 'http://127.0.0.1:' + PORT;
let fails = 0;
const ok = (cond, label) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- statics ----------------
const worker = fs.readFileSync('cloudflare/src/worker.js', 'utf8');
ok(worker.includes('20261118-admin'), 'worker pin micguide');
const dist = fs.readFileSync('cloudflare/dist-client.html');
ok(dist.length < 1000000, 'dist under 1 MB (' + dist.length + ')');
const distS = dist.toString('utf8');
ok(distS.includes('micHint'), 'dist carries micHint');
const src = fs.readFileSync('public/index.html', 'utf8');
ok(!src.includes("toast(T('micUnavailable'))"), 'no toast(micUnavailable) call site left');
ok(!src.includes("toast(T('clMicDenied'))"), 'no toast(clMicDenied) call site left');
ok(src.includes('const MIC_API'), 'MIC_API one-time detection present');
ok((src.match(/micHint:/g) || []).length === 3, 'micHint string in all 3 languages');

// ---------------- browser ----------------
const host = spawn('node', ['deploy/server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  try { const r = await fetch(BASE + '/'); up = r.status > 0; } catch { await sleep(400); }
}
ok(up, 'deploy host up');
const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const errors = [];

// Toast recorder + optional environment stub, installed before any
// page script runs. Records { text, info } per toast text change.
const RECORDER = () => {
  window.__toasts = [];
  let lastToast = '';
  setInterval(() => {
    try {
      const el = document.querySelector('#toast');
      if (!el) return;
      const tx = el.textContent || '';
      if (tx && tx !== lastToast && el.classList.contains('show')) {
        window.__toasts.push({ text: tx, info: el.classList.contains('info') });
      }
      lastToast = tx;
    } catch (e) {}
  }, 80);
};
const STUB_NO_API = () => {
  try { Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }); } catch (e) {}
};
// up110: toggleVoice pre-checks the Permissions API — a context
// that never granted the mic reads 'denied' in headless Chromium
// and would (correctly, per up110) open the guide before capture.
// Scenarios that model a CAPTURE failure (busy / missing device)
// therefore also pin the permission state to 'prompt', so the
// gum rejection is what decides — exactly like a real phone.
const STUB_PERM_PROMPT = () => {
  try {
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: {
      query: () => Promise.resolve({ state: 'prompt', onchange: null, addEventListener() {}, removeEventListener() {} }),
    } });
  } catch (e) {}
};
// NOTE: addInitScript stringifies the function — a closure over
// `name` would resolve to window.name in the page. Bake the error
// name into a self-contained function body instead.
const stubReject = (name) => new Function(`
  window.__gumCalls = 0;
  try {
    navigator.mediaDevices.getUserMedia = () => {
      window.__gumCalls++;
      const e = new Error(${JSON.stringify(name)});
      e.name = ${JSON.stringify(name)};
      return Promise.reject(e);
    };
  } catch (e) {}
`);

async function newPlayer(tag, { init = null, perms = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: perms });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(tag + ': ' + e.message));
  if (init) for (const fn of [].concat(init)) await page.addInitScript(fn);
  await page.addInitScript(RECORDER);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 45000 });
  await sleep(300);
  return { ctx, page };
}
async function enterLobby(page) {
  await page.click('#btn-online');
  await page.waitForSelector('#btn-pk-play', { state: 'visible', timeout: 15000 });
  await page.click('#btn-pk-play');
  await page.waitForSelector('#scr-lobby:not(.hidden)', { timeout: 20000 });
  // the floating music pill overlaps the lobby mic button at this
  // viewport — park it so the mic tap is a clean real click
  await page.evaluate(() => { const p = document.querySelector('#mplayer'); if (p) p.style.display = 'none'; });
  await sleep(1200);
}
const toasts = (page) => page.evaluate(() => window.__toasts || []);
const micToasts = async (page) => {
  const [list, bad] = await Promise.all([
    toasts(page),
    page.evaluate(() => T('micUnavailable')),
  ]);
  return list.filter((t) => t.text === bad);
};

// (a) no capture API at all — in-app WebView class of environment
{
  const { ctx, page } = await newPlayer('A-noapi', { init: STUB_NO_API });
  await enterLobby(page);
  const disp = await page.evaluate(() => {
    const g = (s) => { const b = document.querySelector(s); return b ? getComputedStyle(b).display : 'missing'; };
    return { lobby: g('#btn-lobby-mic'), table: g('#btn-mic'), club: g('#btn-cl-mic') };
  });
  ok(disp.lobby === 'none', '(a) lobby mic button hidden (' + disp.lobby + ')');
  ok(disp.table === 'none', '(a) table mic button hidden (' + disp.table + ')');
  ok(disp.club === 'none', '(a) club mic button hidden (' + disp.club + ')');
  ok((await micToasts(page)).length === 0, '(a) no micUnavailable toast on lobby entry');
  ok((await toasts(page)).length === 0, '(a) no toast at all on lobby entry');
  await ctx.close();
}

// (b) mic busy (NotReadableError) on a deliberate tap — one hint only
{
  const { ctx, page } = await newPlayer('B-busy', { init: [stubReject('NotReadableError'), STUB_PERM_PROMPT] });
  await enterLobby(page);
  ok((await toasts(page)).length === 0, '(b) no toast on lobby entry');
  await page.click('#btn-lobby-mic');
  await sleep(900);
  const hint = await page.evaluate(() => T('micHint'));
  const list1 = await toasts(page);
  ok(list1.length === 1 && list1[0].text === hint, '(b) exactly one gentle hint toast after first tap (' + JSON.stringify(list1) + ')');
  ok(list1.length === 1 && list1[0].info === true, '(b) the hint uses the gentle info style, not red');
  ok((await micToasts(page)).length === 0, '(b) red micUnavailable toast never fired');
  ok(await page.evaluate(() => micOn) === false, '(b) mic stays off');
  await page.click('#btn-lobby-mic');
  await sleep(900);
  const list2 = await toasts(page);
  ok(list2.length === 1, '(b) second tap shows NO further toast (' + list2.length + ')');
  ok(await page.evaluate(() => window.__gumCalls) === 2, '(b) second tap did retry capture silently');
  await ctx.close();
}

// (c) genuinely no mic device — total silence
{
  const { ctx, page } = await newPlayer('C-nofind', { init: [stubReject('NotFoundError'), STUB_PERM_PROMPT] });
  await enterLobby(page);
  await page.click('#btn-lobby-mic');
  await sleep(900);
  const cList1 = await toasts(page);
  ok(cList1.length === 0, '(c) no toast at all for NotFoundError (' + JSON.stringify(cList1) + ')');
  ok(await page.evaluate(() => micOn) === false, '(c) mic stays off');
  await page.click('#btn-lobby-mic');
  await sleep(700);
  const cList2 = await toasts(page);
  ok(cList2.length === 0, '(c) still silent on second tap (' + JSON.stringify(cList2) + ')');
  await ctx.close();
}

// (d) normal fake-media success — mic turns on, no error toast
{
  const { ctx, page } = await newPlayer('D-ok', { perms: ['microphone'] });
  await enterLobby(page);
  ok((await toasts(page)).length === 0, '(d) no toast on lobby entry');
  await page.click('#btn-lobby-mic');
  let on = false;
  for (let i = 0; i < 25 && !on; i++) { on = await page.evaluate(() => micOn).catch(() => false); if (!on) await sleep(200); }
  ok(on, '(d) mic turns on with a working device');
  ok((await micToasts(page)).length === 0, '(d) no micUnavailable toast');
  await page.click('#btn-lobby-mic');
  await sleep(600);
  ok(await page.evaluate(() => micOn) === false, '(d) mic turns back off');
  await ctx.close();
}

ok(errors.length === 0, 'no page errors (' + errors.slice(0, 3).join(' | ') + ')');
await browser.close();
host.kill('SIGKILL');
console.log(fails === 0 ? 'ALL UP109 CHECKS PASSED' : ('UP109 FAILURES: ' + fails));
process.exit(fails ? 1 : 0);
