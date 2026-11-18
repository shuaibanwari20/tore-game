/**
 * test-up110.mjs — mic-permission guide (owner photos 2026-11-18:
 * on some players' Android phones Chrome holds the site's mic
 * permission at "blocked" — getUserMedia rejects instantly with
 * NotAllowedError, Chrome never re-prompts, and the up109 hint
 * could not fix it). up110 adds a fix-it guide overlay:
 *   (a) permission state 'denied' + gum rejects NotAllowedError:
 *       tap mic → guide opens with the steps in Pashto; «try
 *       again» while still denied → guide re-opens, mic off, NO
 *       hint toast and NO red toast; flip the stub to granted +
 *       gum success → try again → guide closes, mic turns on.
 *   (b) state 'prompt' + gum success → no guide, mic on directly.
 *   (c) no capture API → no guide ever, mic buttons hidden (up109).
 *   (d) NotFoundError → total silence: no guide, no toast.
 *   Plus statics: pin micguide, dist < 1 MB, guide strings in all
 *   three languages, guide wired into toggleVoice + ensureMic.
 *   node shots/test-up110.mjs   (deploy host :8931)
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
ok(distS.includes('ov-micguide'), 'dist carries the guide overlay');
ok(distS.includes('micGuideStep1'), 'dist carries the guide strings');
const src = fs.readFileSync('public/index.html', 'utf8');
for (const k of ['micGuideTitle', 'micGuideIntro', 'micGuideStep1', 'micGuideStep2', 'micGuideStep3', 'micGuideAlt', 'micGuideRetry']) {
  ok((src.match(new RegExp(k + ':', 'g')) || []).length === 3, k + ' in all 3 languages');
}
ok(src.includes('function showMicGuide'), 'showMicGuide present');
ok(src.includes('showMicGuide(() => toggleVoice(true))'), 'guide wired into toggleVoice (retry skips pre-check)');
ok(src.includes('ensureMic(silent, retry)'), 'ensureMic takes a retry callback');
ok(src.includes("if (micPermError(e)) showMicGuide(retry);"), 'guide wired into club ensureMic');
ok(!src.includes("toast(T('micUnavailable'))"), 'still no toast(micUnavailable) call site');
ok(!src.includes("toast(T('clMicDenied'))"), 'still no toast(clMicDenied) call site');

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
// Controllable permission world: window.__micPerm.state feeds the
// Permissions API stub; window.__micPerm.gum picks the capture
// outcome ('deny' → NotAllowedError, 'notfound' → NotFoundError,
// 'ok' → the real fake-device capture). Self-contained body —
// addInitScript stringifies it, so no closures (see up109 note).
const stubPerm = (state, gum) => new Function(`
  window.__micPerm = { state: ${JSON.stringify(state)}, gum: ${JSON.stringify(gum)} };
  window.__gumCalls = 0;
  const realGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (c) => {
    window.__gumCalls++;
    const m = window.__micPerm.gum;
    if (m === 'deny' || m === 'notfound') {
      const e = new Error(m);
      e.name = m === 'deny' ? 'NotAllowedError' : 'NotFoundError';
      return Promise.reject(e);
    }
    return realGum(c);
  };
  try {
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: {
      query: () => Promise.resolve({ state: window.__micPerm.state, onchange: null, addEventListener() {}, removeEventListener() {} }),
    } });
  } catch (e) {}
`);

async function newPlayer(tag, { init = null, perms = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: perms });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(tag + ': ' + e.message));
  if (init) await page.addInitScript(init);
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
  await page.evaluate(() => { const p = document.querySelector('#mplayer'); if (p) p.style.display = 'none'; });
  await sleep(1200);
}
const toasts = (page) => page.evaluate(() => window.__toasts || []);
const guideShown = (page) => page.evaluate(() => {
  const o = document.querySelector('#ov-micguide');
  return !!o && o.classList.contains('show') && getComputedStyle(o).display !== 'none';
});
async function waitGuide(page, want, tries = 20) {
  let v = await guideShown(page);
  for (let i = 0; i < tries && v !== want; i++) { await sleep(200); v = await guideShown(page); }
  return v;
}
async function waitMicOn(page, tries = 25) {
  let on = false;
  for (let i = 0; i < tries && !on; i++) { on = await page.evaluate(() => micOn).catch(() => false); if (!on) await sleep(200); }
  return on;
}

// (a) permission BLOCKED — guide, retry loop, then the fix lands
{
  const { ctx, page } = await newPlayer('A-denied', { init: stubPerm('denied', 'deny'), perms: ['microphone'] });
  await enterLobby(page);
  ok(!(await guideShown(page)), '(a) no guide on lobby entry');
  ok((await toasts(page)).length === 0, '(a) no toast on lobby entry');
  await page.click('#btn-lobby-mic');
  ok(await waitGuide(page, true), '(a) tap with blocked permission opens the guide');
  const guideText = await page.evaluate(() => ({
    title: document.querySelector('#micg-title').textContent,
    s1: document.querySelector('#micg-s1').textContent,
    s2: document.querySelector('#micg-s2').textContent,
    s3: document.querySelector('#micg-s3').textContent,
    alt: document.querySelector('#micg-alt').textContent,
    retry: document.querySelector('#btn-micg-retry').textContent,
    expTitle: T('micGuideTitle'), expS1: T('micGuideStep1'), expRetry: T('micGuideRetry'),
  }));
  ok(guideText.title === guideText.expTitle && guideText.s1 === guideText.expS1 && guideText.retry === guideText.expRetry,
    '(a) guide renders the Pashto strings (' + guideText.title + ')');
  ok(guideText.s2.includes('مایکروفون') && guideText.s3.includes('اجازه') && guideText.alt.includes('مایکروفون'),
    '(a) steps name the microphone settings route');
  ok(await page.evaluate(() => micOn) === false, '(a) mic stays off behind the guide');
  const badTexts = await page.evaluate(() => [T('micUnavailable'), T('micHint')]);
  let list = await toasts(page);
  ok(!list.some((t) => badTexts.includes(t.text)), '(a) neither the red toast nor the old hint fired');
  // retry while STILL denied → guide comes back, still no toast
  await page.click('#btn-micg-retry');
  ok(await waitGuide(page, true), '(a) try-again while still denied re-opens the guide');
  ok(await page.evaluate(() => micOn) === false, '(a) mic still off after the denied retry');
  list = await toasts(page);
  ok(!list.some((t) => badTexts.includes(t.text)), '(a) still no toast after the denied retry');
  // the player fixes it in Chrome settings → retry in place works
  await page.evaluate(() => { window.__micPerm.state = 'granted'; window.__micPerm.gum = 'ok'; });
  await page.click('#btn-micg-retry');
  ok(await waitMicOn(page), '(a) after the fix, try-again turns the mic on');
  ok(!(await guideShown(page)), '(a) guide closed once the mic is on');
  await page.click('#btn-lobby-mic');
  await sleep(500);
  ok(await page.evaluate(() => micOn) === false, '(a) mic toggles back off normally');
  await ctx.close();
}

// (b) permission merely prompt-able — straight in, no guide
{
  const { ctx, page } = await newPlayer('B-prompt', { init: stubPerm('prompt', 'ok'), perms: ['microphone'] });
  await enterLobby(page);
  await page.click('#btn-lobby-mic');
  ok(await waitMicOn(page), '(b) mic turns on directly when permission is prompt-able');
  ok(!(await guideShown(page)), '(b) guide never opened');
  await ctx.close();
}

// (c) no capture API at all — up109 behaviour preserved, no guide
{
  const { ctx, page } = await newPlayer('C-noapi', { init: STUB_NO_API });
  await enterLobby(page);
  const disp = await page.evaluate(() => {
    const g = (s) => { const b = document.querySelector(s); return b ? getComputedStyle(b).display : 'missing'; };
    return { lobby: g('#btn-lobby-mic'), club: g('#btn-cl-mic') };
  });
  ok(disp.lobby === 'none' && disp.club === 'none', '(c) mic buttons hidden with no capture API');
  ok(!(await guideShown(page)), '(c) no guide with no capture API');
  ok((await toasts(page)).length === 0, '(c) no toast at all');
  await ctx.close();
}

// (d) genuinely no mic device — silence, and specifically no guide
{
  const { ctx, page } = await newPlayer('D-nofind', { init: stubPerm('prompt', 'notfound') });
  await enterLobby(page);
  await page.click('#btn-lobby-mic');
  await sleep(900);
  ok(!(await guideShown(page)), '(d) no guide for NotFoundError');
  ok((await toasts(page)).length === 0, '(d) no toast for NotFoundError');
  ok(await page.evaluate(() => micOn) === false, '(d) mic stays off');
  await ctx.close();
}

ok(errors.length === 0, 'no page errors (' + errors.slice(0, 3).join(' | ') + ')');
await browser.close();
host.kill('SIGKILL');
console.log(fails === 0 ? 'ALL UP110 CHECKS PASSED' : ('UP110 FAILURES: ' + fails));
process.exit(fails ? 1 : 0);
