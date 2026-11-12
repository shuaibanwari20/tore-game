#!/usr/bin/env node
/**
 * tore-proofs-settingsx.mjs — PROTOTYPE proof (owner order 2026-11-11,
 * revised same day): the settings sheet's close button moves OUTSIDE
 * the card KEEPING its original orange-ribbon style.
 *
 * Nothing in the shipping client is changed: the driver loads the real
 * client from the root Node host and applies the proposed apply-step
 * change AT RUNTIME (DOM move + injected CSS), then screenshots it.
 *
 * Current shipping state (public/index.html):
 *   markup  line 3525: #btn-settings-x (.st-ribbon) is a CHILD of
 *           #ov-settings .panel (the scrolling card)
 *   CSS     line 1927: .st-ribbon — absolute, top:-17px,
 *           inset-inline-start:16px, 44x54 orange ribbon (clip-path
 *           notch); 37 of its 54px lie INSIDE the panel outline.
 * REVISED prototype (owner verdict 2026-11-11 on the first round):
 * the glossy RED CIRCLE was REJECTED — «دکمه x باید استایلش امان قبلی
 * باشه»: the ✖ button keeps its PREVIOUS style (the orange ribbon,
 * verbatim) and ONLY its position changes, to outside/on top of the
 * card. Proposed apply change:
 *   - wrap the panel in #ov-settings .st-wrap (position:relative,
 *     width:100%, max-width:420px — the panel's own box), move
 *     #btn-settings-x out of the panel into the wrapper as the
 *     panel's sibling (the wrapper does not clip; the panel keeps
 *     overflow-y:auto inside);
 *   - .st-ribbon CSS kept VERBATIM (44x54, orange gradient
 *     linear-gradient(180deg,#ff9a44,#f06414 58%,#d94e06), clip-path
 *     notch polygon(0 0,100% 0,100% 100%,50% 80%,0 100%), padding
 *     0 0 10px, border 0, box-shadow, flex start/center, svg 20px
 *     margin-top 10px, :active scale(.94)) — only top changes
 *     -17px -> -27px (overhang 27px = half the 54px ribbon height:
 *     half out / half in, up from today's 17px peek) and z-index
 *     2 -> 3; inset-inline-start stays 16px, same corner as today
 *     (in the RTL sheet that is the panel's top-right corner,
 *     matching his photo);
 *   - the panel's max-height tightens calc(100dvh - 32px) ->
 *     calc(100dvh - 64px) so the sheet leaves screen room for the
 *     taller overhang (with it, the ribbon's top sits ~10px inside
 *     the viewport, fully visible).
 *   - id, class (.st-ribbon), click handler (closeSettings) and
 *     aria-label unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium = null;
try {
  chromium = require(path.join(os.homedir(), 'workspace/projects/vault-rental-online/node_modules/playwright-core')).chromium;
} catch { /* fall through */ }
function findChrome() {
  const base = path.join(os.homedir(), '.cache/ms-playwright');
  if (!fs.existsSync(base)) return null;
  for (const dir of fs.readdirSync(base).sort().reverse()) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome-headless-shell-linux/headless_shell']) {
      const p = path.join(base, dir, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
const exe = chromium && findChrome();
if (!chromium || !exe) { console.log('SKIP  playwright/chromium unavailable'); process.exit(0); }

const ROOT = path.join(os.homedir(), 'workspace/projects/tore-game');
const SHOTS = path.join(ROOT, 'shots');
const PORT = '8811';
const BASE = 'http://127.0.0.1:' + PORT;

let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  [' + extra + ']' : ''));
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: { ...process.env, PORT }, stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    try { const r = await fetch(BASE + '/'); up = r.status > 0; } catch { await sleep(700); }
  }
  if (!up) throw new Error('node host did not come up');

  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const sp = document.getElementById('splash');
      return document.getElementById('btn-settings') && (!sp || getComputedStyle(sp).opacity === '0' || sp.classList.contains('bye'));
    }, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);

    // ---- apply the PROTOTYPE at runtime only ----
    const applied = await page.evaluate(() => {
      const panel = document.querySelector('#ov-settings .panel');
      const btn = document.getElementById('btn-settings-x');
      if (!panel || !btn) return false;
      const wrap = document.createElement('div');
      wrap.className = 'st-wrap';
      panel.parentNode.insertBefore(wrap, panel);
      wrap.appendChild(panel);
      wrap.appendChild(btn);
      const st = document.createElement('style');
      st.id = 'stx-prototype';
      st.textContent =
        '#ov-settings .st-wrap { position: relative; width: 100%; max-width: 420px; }' +
        '#ov-settings .panel { max-height: calc(100dvh - 64px); }' +
        '#ov-settings .st-wrap > .st-ribbon { top: -27px; z-index: 3; }';
      document.head.appendChild(st);
      const cs = getComputedStyle(btn);
      return btn.parentElement === wrap && panel.parentElement === wrap &&
        btn.classList.contains('st-ribbon') &&
        cs.width === '44px' && cs.height === '54px' &&
        cs.backgroundImage.includes('255, 154, 68') &&
        cs.clipPath.includes('polygon');
    });
    check('prototype applied at runtime (button moved out of panel into wrapper)', applied);

    await page.click('#btn-settings');
    await page.waitForFunction(() => document.getElementById('ov-settings').classList.contains('show'), null, { timeout: 5000 });
    await page.waitForTimeout(450);

    const m = await page.evaluate(() => {
      const el = document.getElementById('btn-settings-x');
      const btn = el.getBoundingClientRect();
      const panel = document.querySelector('#ov-settings .panel').getBoundingClientRect();
      const p = document.querySelector('#ov-settings .panel');
      const cs = getComputedStyle(el);
      return {
        btn: { top: btn.top, bottom: btn.bottom, left: btn.left, right: btn.right, w: btn.width, h: btn.height },
        panel: { top: panel.top, bottom: panel.bottom, left: panel.left, right: panel.right },
        title: document.getElementById('st-title').textContent,
        noHOverflow: p.scrollWidth <= p.clientWidth + 1,
        overhang: panel.top - btn.top,
        cssTop: cs.top,
      };
    });
    check('sheet open with settings title', m.title === 'امادګي', m.title);
    check('button keeps the original ribbon size 44x54', Math.round(m.btn.w) === 44 && Math.round(m.btn.h) === 54, m.btn.w + 'x' + m.btn.h);
    check('ribbon hangs OUTSIDE above the card top edge (overhang ~27px = half out)', m.overhang >= 24 && m.overhang <= 30,
      'overhang ' + m.overhang.toFixed(1) + 'px (btn.top ' + m.btn.top.toFixed(1) + ' vs panel.top ' + m.panel.top.toFixed(1) + ', css top ' + m.cssTop + ')');
    check('ribbon bottom half still overlaps the card (half in)', m.btn.bottom > m.panel.top,
      'btn.bottom ' + m.btn.bottom.toFixed(1) + ' vs panel.top ' + m.panel.top.toFixed(1));
    check('ribbon on the same corner as today (inline-start = panel right edge in RTL)', Math.abs(m.btn.right - (m.panel.right - 16)) < 1.5,
      'btn.right ' + m.btn.right.toFixed(1) + ' vs panel.right-16 ' + (m.panel.right - 16).toFixed(1));
    check('ribbon fully inside the viewport (not clipped at top)', m.btn.top >= 0 && m.btn.left >= 0 && m.btn.right <= 390 && m.btn.bottom <= 844,
      'btn.top ' + m.btn.top.toFixed(1));
    check('sheet content not horizontally clipped/overflowing', m.noHOverflow);

    await page.screenshot({ path: path.join(SHOTS, 'settings-ribbon-outside-FRESH.jpg'), type: 'jpeg', quality: 88 });
    check('screenshot saved', fs.existsSync(path.join(SHOTS, 'settings-ribbon-outside-FRESH.jpg')));

    await page.click('#btn-settings-x');
    await page.waitForTimeout(350);
    const closed = await page.evaluate(() => !document.getElementById('ov-settings').classList.contains('show'));
    check('close behaviour identical (tap closes the sheet)', closed);
    check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();

    // ---------- up37 feat2 switches + the FIT law (up40: sound row removed) ----------
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page2 = await ctx2.newPage();
    const errors2 = [];
    page2.on('pageerror', (e) => errors2.push(String(e)));
    await page2.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page2.waitForFunction(() => !!document.getElementById('btn-settings'), null, { timeout: 15000 });
    await page2.waitForTimeout(900);
    await page2.click('#btn-settings');
    await page2.waitForFunction(() => document.getElementById('ov-settings').classList.contains('show'), null, { timeout: 5000 });
    await page2.waitForTimeout(450);
    const sw = await page2.evaluate(() => {
      const on = (id) => { const c = document.getElementById(id); return !!c && c.classList.contains('on'); };
      const lbl = (id) => { const l = document.getElementById(id); return l ? l.textContent : null; };
      const panel = document.querySelector('#ov-settings .panel');
      return {
        dnd: !!document.getElementById('row-set-dnd'), invisible: !!document.getElementById('row-set-invisible'),
        soundGone: !document.getElementById('row-set-sound'), music: !!document.getElementById('row-set-music'),
        dndOn: on('st-dnd-check'), invisibleOn: on('st-invisible-check'), musicOn: on('st-music-check'),
        dndLbl: lbl('st-dnd-lbl'), musicLbl: lbl('st-music-lbl'), invLbl: lbl('st-invisible-lbl'),
        fitsNoScroll: panel.scrollHeight <= panel.clientHeight + 1,
        panelH: panel.scrollHeight, panelC: panel.clientHeight,
      };
    });
    check('feat2: the feat2 settings rows exist (dnd / invisible / music)', sw.dnd && sw.invisible && sw.music);
    check('up40: the F19 sound row is REMOVED from the settings sheet', sw.soundGone);
    check('feat2: defaults — dnd/invisible OFF, music ON (up41: the player master defaults ON)', sw.dndOn === false && sw.invisibleOn === false && sw.musicOn === true, JSON.stringify(sw));
    check('feat2: ps labels (Kandahari)', sw.dndLbl === 'مزاحم نشو' && sw.invLbl === 'پټ حالت' && !!sw.musicLbl, [sw.dndLbl, sw.invLbl, sw.musicLbl].join(' / '));
    check('feat2: settings sheet STILL fits with NO scrolling (FIT law, after the up40 sound-row removal)', sw.fitsNoScroll, 'scroll ' + sw.panelH + ' vs client ' + sw.panelC);
    // up41 persistence: flip music OFF, reload, the switch must stay OFF.
    await page2.click('#row-set-music');
    await page2.waitForTimeout(250);
    const musSet = await page2.evaluate(() => { try { return localStorage.getItem('tore.set.music') === '0'; } catch { return null; } });
    check('up41: music toggle persists OFF to tore.set', musSet === true, String(musSet));
    await page2.reload({ waitUntil: 'domcontentloaded' });
    await page2.waitForFunction(() => !!document.getElementById('btn-settings'), null, { timeout: 15000 });
    await page2.waitForTimeout(900);
    await page2.click('#btn-settings');
    await page2.waitForFunction(() => document.getElementById('ov-settings').classList.contains('show'), null, { timeout: 5000 });
    await page2.waitForTimeout(400);
    const musAfter = await page2.evaluate(() => document.getElementById('st-music-check').classList.contains('on'));
    check('up41: music switch still OFF after reload', musAfter === false);
    await page2.click('#row-set-music'); // restore default ON for later suites
    await page2.waitForTimeout(200);
    check('feat2: no page errors in the switches section', errors2.length === 0, errors2.slice(0, 2).join(' | '));
    await ctx2.close();
  } catch (e) {
    check('browser prototype checks completed', false, e.message);
  }
  await browser.close();
} catch (e) {
  check('prototype driver completed', false, e.message);
} finally {
  srv.kill('SIGKILL');
}

console.log(failures === 0 ? '\nALL SETTINGS-X PROTOTYPE CHECKS PASSED' : '\n' + failures + ' SETTINGS-X CHECK(S) FAILED');
process.exit(failures ? 1 : 0);
