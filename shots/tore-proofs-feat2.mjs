#!/usr/bin/env node
/**
 * tore-proofs-feat2.mjs — up37 feature batch proofs (F5 DND,
 * F10 takan vibration, F14 leaders restyle, F17 photo upload,
 * F28 takan/13 animations, F35 resume, F40 tutorial, F46
 * invisible mode, and the up41 MUSIC PLAYER — which replaced
 * the F41 procedural pad entirely: pill on home/table, playlist,
 * collapse + draggable chip, the settings master, and the club
 * broadcast). F19 game sounds were removed entirely in up40 —
 * this driver asserts their absence. up42: the pill's gold
 * progress bar is a real SEEK control (tap + drag, knob, tiny
 * time labels; owner seeks re-anchor the club broadcast,
 * followers' bars are locked), and club voice DUCKS the music
 * (background level in the room, deeper under speech, restored
 * on exit).
 *
 * Runs against the DEPLOY Node host (deploy/server.js) so the
 * hand-maintained deploy variant is exercised too.
 *   node shots/tore-proofs-feat2.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require(path.join(os.homedir(), 'workspace/projects/tore-game/node_modules/ws'));
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

const ROOT = path.join(os.homedir(), 'workspace/projects/tore-game');
const SHOTS = path.join(ROOT, 'shots');
const PORT = '8821';
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};

const exe = chromium && findChrome();
if (!chromium || !exe) { console.log('FAIL  playwright/chromium unavailable'); process.exit(1); }

const srv = spawn(process.execPath, [path.join(ROOT, 'deploy', 'server.js')], {
  cwd: ROOT, env: { ...process.env, PORT }, stdio: ['ignore', 'pipe', 'pipe'],
});
let up = false;
for (let i = 0; i < 30 && !up; i++) {
  try { const r = await fetch(BASE + '/'); up = r.status > 0; } catch { await sleep(700); }
}
if (!up) { console.log('FAIL  deploy host did not come up'); process.exit(1); }

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const errs = [];
async function bootPage(ctx, tag) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(tag + ': ' + e.message));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 60000 });
  await sleep(700);
  return page;
}
async function newPlayer(tag, viewport) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'] });
  const page = await bootPage(ctx, tag);
  return { ctx, page };
}
async function setName(page, name) {
  await page.click('#btn-profile');
  await page.waitForSelector('#scr-profile:not(.hidden)', { timeout: 15000 });
  await page.click('#btn-pf-edit-av');
  await page.waitForSelector('#ov-pfedit.show', { timeout: 8000 });
  await page.fill('#pf-name', name);
  await page.click('#btn-profile-save');
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 10000 });
}
function socialHandshake(pidA, nameA, pidB, nameB) {
  return new Promise((resolve) => {
    const mk = (pid, name) => {
      const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/social');
      ws.on('open', () => ws.send(JSON.stringify({ type: 's-hello', pid, profile: { name, avatar: 'av1', country: '' } })));
      return ws;
    };
    const a = mk(pidA, nameA); const b = mk(pidB, nameB);
    let opened = 0;
    const onOpen = async () => {
      if (++opened < 2) return;
      await sleep(300);
      a.send(JSON.stringify({ type: 's-request', to: 'p:' + pidB }));
      await sleep(400);
      b.send(JSON.stringify({ type: 's-respond', from: 'p:' + pidA, accept: true }));
      await sleep(500);
      a.close(); b.close();
      resolve(true);
    };
    a.on('open', onOpen); b.on('open', onOpen);
    a.on('error', () => resolve(false)); b.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 8000);
  });
}
const friendFlags = (page, pid) => page.evaluate((id) => {
  const list = (typeof socialData !== 'undefined' && socialData && socialData.friends) || [];
  const f = list.find((x) => x.id === id);
  return f ? { online: !!f.online, ingame: !!f.ingame, inlobby: !!f.inlobby, dnd: !!f.dnd } : null;
}, 'p:' + pid);
const waitFlags = (page, pid, want, timeoutMs) => page.waitForFunction(({ id, w }) => {
  const list = (typeof socialData !== 'undefined' && socialData && socialData.friends) || [];
  const f = list.find((x) => x.id === id);
  if (!f) return false;
  return Object.entries(w).every(([k, v]) => !!f[k] === v);
}, { id: 'p:' + pid, w: want }, { timeout: timeoutMs }).then(() => true).catch(() => false);
async function createLobby(page) {
  await page.click('#btn-online');
  await page.waitForSelector('#btn-pk-play', { state: 'visible', timeout: 15000 });
  await page.click('#btn-pk-play');
  await page.waitForSelector('#scr-lobby:not(.hidden)', { timeout: 20000 });
  return (await page.evaluate(() => document.querySelector('#lobby-code').textContent)).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}
async function tapPlayable(page, preferGlow) {
  return page.evaluate((glow) => {
    let el = glow ? document.querySelector('#hand .pcard.playable.coach-glow') : null;
    if (!el) {
      const els = document.querySelectorAll('#hand .pcard.playable');
      if (!els.length) return false;
      el = els[els.length - 1];
    }
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 9, pointerType: 'touch', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    return true;
  }, !!preferGlow).catch(() => false);
}

try {
  // ================= UNIT: F10 detector + F28 bursts + F41 music (+ up40 F19-removal) =================
  const U = await newPlayer('U');
  const unit = await U.page.evaluate(() => {
    const out = {};
    window.__vib = [];
    try { Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (p) => { window.__vib.push(p); return true; } }); } catch (e) { out.vibErr = String(e); }
    const set = (k, v) => { try { setToreSetting(k, v); } catch (e) { /* ignore */ } };
    out.hasFx = typeof window.ToreFx === 'object' && !!window.ToreFx;
    const fx = window.ToreFx;
    out.detCreated = fx.takanRoundFx({ claimsCreated: [1, 0], claimsExecuted: [0, 0] }, 0);
    out.detStrong = fx.takanRoundFx({ claimsCreated: [0, 1], claimsExecuted: [0, 1] }, 0);
    out.detQuiet = fx.takanRoundFx({ claimsCreated: [0, 0], claimsExecuted: [0, 0] }, 0);
    out.detCancelled = fx.takanRoundFx({ claimsCreated: [1, 0], claimsExecuted: [1, 0] }, 0);
    // vibration through processRoundEndFx (switch ON)
    set('vibrate', true);
    window.__vib.length = 0;
    fx.processRoundEndFx({ claimsCreated: [1, 0], claimsExecuted: [0, 0], banked: [10, 20] }, 0);
    out.vibCreated = window.__vib.map((p) => p.join(',')).join('|');
    window.__vib.length = 0;
    fx.processRoundEndFx({ claimsCreated: [0, 2], claimsExecuted: [0, 1], banked: [40, 10] }, 0);
    out.vibStrong = window.__vib.map((p) => p.join(',')).join('|');
    window.__vib.length = 0;
    fx.processRoundEndFx({ claimsCreated: [0, 0], claimsExecuted: [0, 0], banked: [10, 10] }, 0);
    out.vibQuiet = window.__vib.length;
    set('vibrate', false);
    window.__vib.length = 0;
    fx.processRoundEndFx({ claimsCreated: [1, 0], claimsExecuted: [0, 0], banked: [10, 20] }, 0);
    out.vibSwitchOff = window.__vib.length;
    return out;
  });
  check('F10: detector — created claims = normal', unit.detCreated === 'normal', String(unit.detCreated));
  check('F10: detector — claims executed against my team = strong', unit.detStrong === 'strong', String(unit.detStrong));
  check('F10: detector — quiet round = null, fully-cancelled round = null', unit.detQuiet === null && unit.detCancelled === null, unit.detQuiet + '/' + unit.detCancelled);
  check('F10: vibrate [70,40,70] when claims are created', unit.vibCreated === '70,40,70', unit.vibCreated);
  check('F10: vibrate [120,50,120] when claims execute against my team', unit.vibStrong === '120,50,120', unit.vibStrong);
  check('F10: no vibration on a quiet round, and none with the switch OFF', unit.vibQuiet === 0 && unit.vibSwitchOff === 0, unit.vibQuiet + '/' + unit.vibSwitchOff);

  // F28 synthetic bursts (the same functions the render path calls)
  await U.page.evaluate(() => { showTakanBurst(true); });
  await sleep(250);
  const burst = await U.page.evaluate(() => {
    const b = document.getElementById('takanbanner');
    return { show: b.classList.contains('show'), burst: b.classList.contains('burst'), text: b.textContent };
  });
  check('F28: takan burst shows with the .burst animation class', burst.show && burst.burst, JSON.stringify(burst));
  await U.page.evaluate(() => { show13Burst('Unit Tester'); });
  await sleep(250);
  const b13 = await U.page.evaluate(() => {
    const b = document.getElementById('burst13');
    return { show: b.classList.contains('show'), sub: (b.querySelector('.b13-sub') || {}).textContent || '' };
  });
  check('F28: «13!» burst shows for a declaration, naming the declarer', b13.show && b13.sub === 'Unit Tester', JSON.stringify(b13));

  // up40: F19 was removed entirely (owner order) — no sfx handle
  // on ToreFx, and the settings sheet carries no sound row.
  const sfxGone = await U.page.evaluate(() => typeof window.ToreFx === 'object'
    && window.ToreFx.sfx === undefined && !document.getElementById('row-set-sound'));
  check('up40: F19 SFX removed — ToreFx.sfx is gone and no sound switch row exists', sfxGone);

  // ================= up41: the music player =================
  // (Replaces the F41 checks: the procedural WebAudio pad is
  // REMOVED; tore.set.music is now the player's master, default
  // ON; nothing ever autoplays — playback starts from a tap.)
  const pl0 = await U.page.evaluate(() => ({
    hasPlayer: typeof window.TorePlayer === 'object',
    oldGone: typeof window.ToreMusic === 'undefined',
    st: window.TorePlayer ? TorePlayer.state() : null,
    pill: !document.getElementById('mplayer').classList.contains('hidden'),
    cover: document.getElementById('mp-cover').getAttribute('src'),
    title: document.getElementById('mp-title').textContent,
    artist: document.getElementById('mp-artist').textContent,
    paused: window.TorePlayer ? TorePlayer.audio.paused : null,
    src: window.TorePlayer ? TorePlayer.audio.getAttribute('src') : null,
  }));
  check('up41: the player exists and the F41 procedural engine is GONE', pl0.hasPlayer && pl0.oldGone);
  check('up41: master defaults ON — pill visible on home, track ۸ (سترګې افغاني لارې) selected',
    pl0.pill && pl0.st && pl0.st.idx === 7 && pl0.cover === '/music/c8.jpg' && pl0.src === '/music/m8.mp3',
    JSON.stringify(pl0).slice(0, 160));
  check('up41: pill shows the song title + smaller artist line (ps)',
    pl0.title === 'سترګې افغاني لارې' && pl0.artist === 'اکبر شاه نیکزاد', pl0.title + ' / ' + pl0.artist);
  check('up41: NOTHING autoplays on load (audio paused, state silent)', pl0.paused === true && pl0.st && pl0.st.playing === false);
  await U.page.screenshot({ path: path.join(SHOTS, 'player-home-FRESH.jpg'), type: 'jpeg', quality: 88 });
  check('up41: proof saved (player-home-FRESH.jpg)', fs.existsSync(path.join(SHOTS, 'player-home-FRESH.jpg')));
  // up42: at rest the seek bar shows knob + 0:00 / 9:18 labels
  const seekHome = await U.page.evaluate(() => ({
    cur: document.getElementById('mp-cur').textContent,
    dur: document.getElementById('mp-dur').textContent,
    knob: !!document.getElementById('mp-knob'),
  }));
  check('up42: the seek bar rides the pill — knob + tiny 0:00 / 9:18 labels at rest',
    seekHome.knob && seekHome.cur === '0:00' && seekHome.dur === '9:18', JSON.stringify(seekHome));
  await U.page.screenshot({ path: path.join(SHOTS, 'player-seek-home-FRESH.jpg'), type: 'jpeg', quality: 88 });
  check('up42: proof saved (player-seek-home-FRESH.jpg)', fs.existsSync(path.join(SHOTS, 'player-seek-home-FRESH.jpg')));

  // ---- playlist sheet: 9 rows, real covers, row tap plays ----
  await U.page.click('#mp-list');
  await U.page.waitForSelector('#ov-playlist.show', { timeout: 8000 });
  const plRows = await U.page.evaluate(() => ({
    n: document.querySelectorAll('.mp-row').length,
    covers: [...document.querySelectorAll('.mp-row img')].map((i) => i.getAttribute('src')),
    cur: [...document.querySelectorAll('.mp-row')].indexOf(document.querySelector('.mp-row.cur')),
    durs: [...document.querySelectorAll('.mp-row .mp-row-dur')].map((d) => d.textContent),
  }));
  check('up41: playlist has 9 rows with the real covers c1..c9',
    plRows.n === 9 && plRows.covers.every((s, i) => s === '/music/c' + (i + 1) + '.jpg'), plRows.covers.join(','));
  check('up41: current row highlighted = track ۸, durations shown', plRows.cur === 7 && plRows.durs[7] === '9:18', JSON.stringify(plRows.durs));
  // ---- up42: the sheet wears the Ludo card; the ✖ is inside ----
  const sheetStyle = await U.page.evaluate(() => {
    const panel = document.querySelector('#ov-playlist .panel');
    const cs = getComputedStyle(panel);
    const pr = panel.getBoundingClientRect();
    const xr = document.getElementById('btn-playlist-x').getBoundingClientRect();
    return { bg: cs.backgroundImage,
             xIn: xr.left >= pr.left - 1 && xr.right <= pr.right + 1 && xr.top >= pr.top - 1 && xr.bottom <= pr.bottom + 1,
             xw: Math.round(xr.width), xh: Math.round(xr.height) };
  });
  check('up42: the playlist sheet is a LUDO card now (magenta family, not the old brown)',
    /216, 27, 116/.test(sheetStyle.bg) && /103, 18, 78/.test(sheetStyle.bg) && !/rgb\(74, 47, 22\)|rgb\(42, 26, 9\)/.test(sheetStyle.bg),
    sheetStyle.bg.slice(0, 90));
  check('up42: the sheet\u2019s ✖ sits fully INSIDE the top corner at a normal size',
    sheetStyle.xIn && sheetStyle.xw <= 44 && sheetStyle.xh <= 44, JSON.stringify(sheetStyle));
  await U.page.screenshot({ path: path.join(SHOTS, 'player-list-ludo-FRESH.jpg'), type: 'jpeg', quality: 88 });
  check('up42: proof saved (player-list-ludo-FRESH.jpg)', fs.existsSync(path.join(SHOTS, 'player-list-ludo-FRESH.jpg')));
  await U.page.click('#btn-playlist-x');
  const xClosed = await U.page.waitForFunction(() => !document.getElementById('ov-playlist').classList.contains('show'), null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('up42: tapping the inside ✖ closes the sheet', xClosed);
  await U.page.click('#mp-list');
  await U.page.waitForSelector('#ov-playlist.show', { timeout: 8000 });
  await U.page.screenshot({ path: path.join(SHOTS, 'player-list-FRESH.jpg'), type: 'jpeg', quality: 88 });
  check('up41: proof saved (player-list-FRESH.jpg)', fs.existsSync(path.join(SHOTS, 'player-list-FRESH.jpg')));
  await U.page.click('#mp-rows .mp-row >> nth=4');
  const rowPlayed = await U.page.waitForFunction(() => {
    const st = TorePlayer.state();
    return st.idx === 4 && !TorePlayer.audio.paused && TorePlayer.audio.currentTime > 0.05
      && !document.getElementById('ov-playlist').classList.contains('show');
  }, null, { timeout: 15000 }).then(() => true).catch(() => false);
  check('up41: tapping row ۵ (جانان) plays it and closes the sheet', rowPlayed);
  // next / prev wrap through the pill buttons
  await U.page.click('#mp-next');
  await U.page.waitForFunction(() => TorePlayer.state().idx === 5, null, { timeout: 8000 });
  await U.page.evaluate(() => TorePlayer.playTrack(8));
  await U.page.click('#mp-next');
  const wrapped = await U.page.waitForFunction(() => TorePlayer.state().idx === 0, null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('up41: NEXT wraps ۹ → ۱', wrapped);
  await U.page.click('#mp-prev');
  const wrappedBack = await U.page.waitForFunction(() => TorePlayer.state().idx === 8, null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('up41: PREV wraps ۱ → ۹', wrappedBack);

  // ---- collapse to the chip, drag it, expand again ----
  await U.page.click('#mp-cover');
  const collapsed = await U.page.waitForFunction(() => {
    const st = TorePlayer.state();
    return st.collapsed && !document.getElementById('mp-chip').classList.contains('hidden')
      && document.getElementById('mplayer').classList.contains('hidden');
  }, null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('up41: tapping the cover collapses the pill to the floating chip', collapsed);
  const chipBox0 = await U.page.$eval('#mp-chip', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y }; });
  await U.page.mouse.move(chipBox0.x + 27, chipBox0.y + 27);
  await U.page.mouse.down();
  await U.page.mouse.move(330, 120, { steps: 12 });
  await U.page.mouse.up();
  await sleep(300);
  const chipDrag = await U.page.evaluate(() => {
    const r = document.getElementById('mp-chip').getBoundingClientRect();
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('tore.player.v1') || 'null'); } catch { /* noop */ }
    return { x: r.x, y: r.y, saved, stillCollapsed: TorePlayer.state().collapsed };
  });
  check('up41: the chip DRAGS (a drag does not expand it) and the spot persists',
    chipDrag.stillCollapsed && Math.abs(chipDrag.x - 303) < 24 && Math.abs(chipDrag.y - 93) < 24
    && chipDrag.saved && chipDrag.saved.chip && Math.abs(chipDrag.saved.chip.x - 303) < 24,
    JSON.stringify(chipDrag));
  await U.page.mouse.click(330, 120);
  const expanded = await U.page.waitForFunction(() => !TorePlayer.state().collapsed
    && !document.getElementById('mplayer').classList.contains('hidden'), null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('up41: tapping the chip expands the pill at its home anchor', expanded);

  // ---- the table: pill rides along, music survives the move ----
  await U.page.click('#btn-quick');
  await U.page.waitForSelector('#btn-pk-play', { state: 'visible', timeout: 10000 });
  await U.page.click('#btn-pk-play');
  await U.page.waitForSelector('#scr-game:not(.hidden)', { timeout: 15000 });
  await U.page.waitForFunction(() => document.querySelectorAll('#hand .pcard').length === 13, null, { timeout: 15000 });
  const onTable = await U.page.evaluate(() => ({
    pill: !document.getElementById('mplayer').classList.contains('hidden'),
    playing: !TorePlayer.audio.paused,
  }));
  check('up41: pill is on the table too and the song kept playing across screens', onTable.pill && onTable.playing, JSON.stringify(onTable));
  await sleep(600);
  await U.page.screenshot({ path: path.join(SHOTS, 'player-table-FRESH.jpg'), type: 'jpeg', quality: 88 });
  check('up41: proof saved (player-table-FRESH.jpg)', fs.existsSync(path.join(SHOTS, 'player-table-FRESH.jpg')));
  // collapse on the table and drag the chip to the top-left corner
  await U.page.click('#mp-cover');
  await U.page.waitForFunction(() => TorePlayer.state().collapsed, null, { timeout: 8000 });
  const tChip = await U.page.$eval('#mp-chip', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y }; });
  await U.page.mouse.move(tChip.x + 27, tChip.y + 27);
  await U.page.mouse.down();
  await U.page.mouse.move(40, 66, { steps: 12 });
  await U.page.mouse.up();
  await sleep(300);
  const tChipPos = await U.page.$eval('#mp-chip', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y }; });
  check('up41: chip dragged to the table\u2019s top-left corner', Math.abs(tChipPos.x - 13) < 24 && Math.abs(tChipPos.y - 39) < 24, JSON.stringify(tChipPos));
  await U.page.screenshot({ path: path.join(SHOTS, 'player-chip-table-FRESH.jpg'), type: 'jpeg', quality: 88 });
  check('up41: proof saved (player-chip-table-FRESH.jpg)', fs.existsSync(path.join(SHOTS, 'player-chip-table-FRESH.jpg')));
  await U.page.mouse.click(40, 66);
  await U.page.waitForFunction(() => !TorePlayer.state().collapsed, null, { timeout: 8000 });

  // ---- settings master: OFF hides + pauses, ON restores ----
  await U.page.evaluate(() => { leaveGameToHome(); });
  await U.page.waitForSelector('#btn-quick', { state: 'visible', timeout: 10000 });
  await U.page.click('#btn-settings');
  await U.page.waitForSelector('#ov-settings.show', { timeout: 8000 });
  await U.page.click('#row-set-music');
  await sleep(400);
  const masterOff = await U.page.evaluate(() => ({
    pillHidden: document.getElementById('mplayer').classList.contains('hidden'),
    chipHidden: document.getElementById('mp-chip').classList.contains('hidden'),
    paused: TorePlayer.audio.paused,
    stored: localStorage.getItem('tore.set.music'),
  }));
  check('up41: master OFF hides pill + chip, pauses playback, persists 0',
    masterOff.pillHidden && masterOff.chipHidden && masterOff.paused && masterOff.stored === '0', JSON.stringify(masterOff));
  await U.page.click('#row-set-music');
  await sleep(400);
  const masterOn = await U.page.evaluate(() => !document.getElementById('mplayer').classList.contains('hidden')
    && localStorage.getItem('tore.set.music') === '1');
  check('up41: master ON brings the pill back (playback stays paused until a tap)', masterOn);
  await U.page.click('#btn-settings-x');
  await sleep(300);

  // ---- up42: the gold bar is a real seek control (personal) ----
  // (The fill grows from the bar's RIGHT edge — the pill is RTL —
  // so fraction f sits at x = box.x + (1 - f) * box.width.)
  // Run the checks on track ۸ (the 9:18 default), paused.
  await U.page.evaluate(() => TorePlayer.playTrack(7));
  await U.page.waitForFunction(() => TorePlayer.state().idx === 7 && !TorePlayer.audio.paused, null, { timeout: 10000 });
  await U.page.click('#mp-play');
  await U.page.waitForFunction(() => TorePlayer.audio.paused, null, { timeout: 8000 });
  const seekReady = await U.page.waitForFunction(() => Number.isFinite(TorePlayer.audio.duration) && TorePlayer.audio.duration > 100, null, { timeout: 15000 }).then(() => true).catch(() => false);
  check('up42 setup: track ۸ metadata is in (duration known)', seekReady);
  const progBox = await U.page.$eval('#mp-prog', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const xAt = (f) => progBox.x + (1 - f) * progBox.w;
  const yMid = progBox.y + progBox.h / 2;
  // (a) tap at ~50% → the middle of the song
  await U.page.mouse.click(xAt(0.5), yMid);
  const tapSeek = await U.page.waitForFunction(() => Math.abs(TorePlayer.audio.currentTime - TorePlayer.audio.duration / 2) <= 3, null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('up42: tapping the bar at 50% seeks to the middle (±3 s)', tapSeek,
    await U.page.evaluate(() => TorePlayer.audio.currentTime.toFixed(1) + '/' + TorePlayer.audio.duration.toFixed(1)));
  // the knob rides the fill's leading (playhead) edge
  const knobGeo = await U.page.evaluate(() => {
    const pr = document.getElementById('mp-prog').getBoundingClientRect();
    const fr = document.getElementById('mp-prog-fill').getBoundingClientRect();
    const kr = document.getElementById('mp-knob').getBoundingClientRect();
    const edge = Math.abs(fr.right - pr.right) < 2 ? fr.left : fr.right;
    return { knobCx: kr.x + kr.width / 2, edge };
  });
  check('up42: the knob sits on the fill\u2019s playhead edge', Math.abs(knobGeo.knobCx - knobGeo.edge) <= 3, JSON.stringify(knobGeo));
  // (b) drag 20% → 80% → lands at ~80%
  await U.page.mouse.move(xAt(0.2), yMid);
  await U.page.mouse.down();
  await U.page.mouse.move(xAt(0.8), yMid, { steps: 12 });
  await U.page.mouse.up();
  const dragSeek = await U.page.waitForFunction(() => Math.abs(TorePlayer.audio.currentTime - TorePlayer.audio.duration * 0.8) <= 3, null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('up42: dragging the bar 20% \u2192 80% scrubs to ~80%', dragSeek,
    await U.page.evaluate(() => TorePlayer.audio.currentTime.toFixed(1)));
  // (c) the tiny labels track the position; total = real duration
  const lbl = await U.page.evaluate(() => {
    const fmt = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
    return { cur: document.getElementById('mp-cur').textContent, dur: document.getElementById('mp-dur').textContent,
             wantCur: fmt(TorePlayer.audio.currentTime), wantDur: fmt(TorePlayer.audio.duration), pos: TorePlayer.audio.currentTime };
  });
  check('up42: time labels show current / total in Latin digits (total = the real duration)',
    lbl.cur === lbl.wantCur && lbl.dur === lbl.wantDur && lbl.pos > 60, JSON.stringify(lbl));
  // (d) a seek while PAUSED keeps the paused state and the spot
  const pausedBefore = await U.page.evaluate(() => TorePlayer.audio.paused);
  await U.page.mouse.click(xAt(0.3), yMid);
  await sleep(500);
  const pausedSeek = await U.page.evaluate(() => ({ paused: TorePlayer.audio.paused, pos: TorePlayer.audio.currentTime, dur: TorePlayer.audio.duration }));
  check('up42: a seek while paused lands at ~30% and playback stays paused',
    pausedBefore && pausedSeek.paused && Math.abs(pausedSeek.pos - pausedSeek.dur * 0.3) <= 3, JSON.stringify(pausedSeek));
  // proof: play, seek to ~half, screenshot the pill mid-song
  await U.page.click('#mp-play');
  await U.page.waitForFunction(() => !TorePlayer.audio.paused, null, { timeout: 8000 });
  await U.page.mouse.click(xAt(0.5), yMid);
  await U.page.waitForFunction(() => Math.abs(TorePlayer.audio.currentTime - TorePlayer.audio.duration / 2) <= 3, null, { timeout: 8000 });
  await sleep(400);
  await U.page.screenshot({ path: path.join(SHOTS, 'player-seek-mid-FRESH.jpg'), type: 'jpeg', quality: 88 });
  check('up42: proof saved (player-seek-mid-FRESH.jpg)', fs.existsSync(path.join(SHOTS, 'player-seek-mid-FRESH.jpg')));
  await U.ctx.close();

  // ---- regression: a TOTAL music outage must not loop ----
  // (Found by the up39 delivery driver: load() used to reset the
  // error-skip counter on every src change, so with every file
  // failing the player cycled the playlist forever and starved
  // the window load event. The chain must stop after ≤9 skips.)
  const X = await newPlayer('X');
  const mp3Reqs = [];
  await X.page.route('**/music/*.mp3', (route) => { mp3Reqs.push(route.request().url()); route.abort(); });
  await X.page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(6000);
  const reqsAt6 = mp3Reqs.length;
  await sleep(3000);
  check('up41: with every song failing, the skip chain STOPS (no request loop)',
    reqsAt6 > 0 && reqsAt6 <= 12 && mp3Reqs.length === reqsAt6, reqsAt6 + ' -> ' + mp3Reqs.length);
  await X.ctx.close();

  // ---- club broadcast: founder plays, member follows ----
  const O = await newPlayer('O');
  const M = await newPlayer('M');
  await setName(O.page, 'Owner Music');
  await setName(M.page, 'Member Music');
  await O.page.click('#nav-clubs');
  await O.page.waitForFunction(() => !document.querySelector('#scr-clubs').classList.contains('hidden'), { timeout: 10000 });
  await O.page.click('#btn-cl-create');
  await O.page.waitForFunction(() => !document.querySelector('#cl-room').classList.contains('hidden'), { timeout: 15000 });
  const bcCid = (await O.page.$eval('#cl-id-num', (el) => el.textContent)).replace(/\D/g, '');
  check('up41 setup: founder created club ' + bcCid, /^\d{6}$/.test(bcCid));
  const bcBtnOwner = await O.page.waitForFunction(() => !document.getElementById('mp-bc').classList.contains('hidden'), null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('up41: the club OWNER sees the broadcast toggle on the pill', bcBtnOwner);
  await M.page.click('#nav-clubs');
  await M.page.waitForFunction(() => !document.querySelector('#scr-clubs').classList.contains('hidden'), { timeout: 10000 });
  await M.page.click('#btn-cl-search-toggle');
  await M.page.fill('#cl-search-inp', bcCid);
  await M.page.click('#btn-cl-search');
  await M.page.waitForSelector('.cl-card', { state: 'visible', timeout: 10000 });
  // (the member's own floating pill can overlay the card — the
  // tap goes through the card's handler directly)
  await M.page.evaluate(() => document.querySelector('.cl-card').click());
  await M.page.waitForFunction(() => !document.querySelector('#cl-room').classList.contains('hidden'), { timeout: 15000 });
  const bcBtnMember = await M.page.evaluate(() => document.getElementById('mp-bc').classList.contains('hidden'));
  check('up41: a plain member does NOT see the broadcast toggle', bcBtnMember);
  // founder starts the broadcast, then plays
  await O.page.click('#mp-bc');
  await O.page.waitForFunction(() => TorePlayer.state().bc === 'owner', null, { timeout: 8000 });
  await O.page.click('#mp-play');
  const mFollow = await M.page.waitForFunction(() => {
    const st = TorePlayer.state();
    return st.bc === 'follow' && st.idx === 7 && !TorePlayer.audio.paused;
  }, null, { timeout: 20000 }).then(() => true).catch(() => false);
  check('up41: member follows the broadcast (track ۸, playing)', mFollow);
  await sleep(1200);
  const syncPos = await Promise.all([
    O.page.evaluate(() => TorePlayer.audio.currentTime),
    M.page.evaluate(() => TorePlayer.audio.currentTime),
    M.page.evaluate(() => document.getElementById('mp-bcchip').textContent),
    M.page.evaluate(() => document.getElementById('mp-bcchip').classList.contains('hidden')),
  ]);
  check('up41: member position syncs to the founder (≤2.5 s drift)',
    Math.abs(syncPos[0] - syncPos[1]) <= 2.5, 'owner ' + syncPos[0].toFixed(2) + ' vs member ' + syncPos[1].toFixed(2));
  check('up41: member sees the gold «موسس یې ټول کلب ته پخوي» chip',
    syncPos[3] === false && syncPos[2].includes('موسس یې ټول کلب ته پخوي'), syncPos[2]);
  await O.page.screenshot({ path: path.join(SHOTS, 'player-club-owner-FRESH.jpg'), type: 'jpeg', quality: 88 });
  check('up41: proof saved (player-club-owner-FRESH.jpg)', fs.existsSync(path.join(SHOTS, 'player-club-owner-FRESH.jpg')));
  await M.page.screenshot({ path: path.join(SHOTS, 'player-club-member-FRESH.jpg'), type: 'jpeg', quality: 88 });
  check('up41: proof saved (player-club-member-FRESH.jpg)', fs.existsSync(path.join(SHOTS, 'player-club-member-FRESH.jpg')));
  // ---- up42: the OWNER seeks — the broadcast re-anchors ----
  const oProg = await O.page.$eval('#mp-prog', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await O.page.mouse.click(oProg.x + 0.3 * oProg.w, oProg.y + oProg.h / 2);   // RTL: x = right - 0.7w → the 70% spot
  const oSeeked = await O.page.waitForFunction(() => Math.abs(TorePlayer.audio.currentTime - TorePlayer.audio.duration * 0.7) <= 4, null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('up42: the club owner can seek (lands at ~70%)', oSeeked,
    await O.page.evaluate(() => TorePlayer.audio.currentTime.toFixed(1) + '/' + TorePlayer.audio.duration.toFixed(1)));
  // the follower converges to the owner's new position
  let convDiff = null;
  for (let i = 0; i < 40 && convDiff === null; i++) {
    const [op, mp] = await Promise.all([
      O.page.evaluate(() => TorePlayer.audio.currentTime),
      M.page.evaluate(() => TorePlayer.audio.currentTime),
    ]);
    if (mp > 300 && Math.abs(op - mp) <= 2.5) convDiff = Math.abs(op - mp);
    else await sleep(500);
  }
  check('up42: the follower converges to the owner\u2019s seek position (≤2.5 s)', convDiff !== null, convDiff === null ? 'no convergence' : 'drift ' + convDiff.toFixed(2));
  // a follower's own seek attempt changes nothing (bar locked)
  const mProg = await M.page.$eval('#mp-prog', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const mBefore = await M.page.evaluate(() => TorePlayer.audio.currentTime);
  await M.page.mouse.click(mProg.x + 0.9 * mProg.w, mProg.y + mProg.h / 2);   // RTL: the ~10% spot — if the bar worked for him
  await sleep(800);
  const mAfter = await M.page.evaluate(() => TorePlayer.audio.currentTime);
  check('up42: the follower\u2019s seek bar is DISABLED (a seek attempt moves nothing)',
    mAfter > 300 && mAfter >= mBefore - 2, mBefore.toFixed(1) + ' -> ' + mAfter.toFixed(1));
  // founder pauses → member pauses
  await O.page.click('#mp-play');
  const mPaused = await M.page.waitForFunction(() => TorePlayer.audio.paused === true, null, { timeout: 12000 }).then(() => true).catch(() => false);
  check('up41: founder pause pauses the member', mPaused);
  // member taps play → detaches instead of taking over
  await M.page.click('#mp-play');
  await sleep(600);
  const mDetached = await M.page.evaluate(() => ({
    detached: TorePlayer.state().detached,
    chipDetached: document.getElementById('mp-bcchip').classList.contains('detached'),
  }));
  check('up41: member\u2019s own play press DETACHES from the broadcast', mDetached.detached === true && mDetached.chipDetached, JSON.stringify(mDetached));
  // founder stops the broadcast entirely
  await O.page.click('#mp-bc');
  const bcOff = await O.page.waitForFunction(() => TorePlayer.state().bc === 'off', null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('up41: founder stops the broadcast', bcOff);

  // ---- up42: club voice ducking (the member's own player) ----
  // In the room with club voice live, the music sits at the
  // background level; simulated remote speech — injected at
  // cv.speaking, the same analyser-fed seam the implementation
  // (and the seat glow) reads — ducks it further; ~1.3 s of
  // quiet eases it back; leaving the room restores 1.0.
  const duckBase = await M.page.waitForFunction(() => {
    const v = TorePlayer.audio.volume;
    return v >= 0.28 && v <= 0.38;
  }, null, { timeout: 10000 }).then(() => true).catch(() => false);
  check('up42 duck: in a club room the music drops to the background level (~0.33)', duckBase,
    await M.page.evaluate(() => TorePlayer.audio.volume.toFixed(2)));
  await M.page.evaluate(() => { cv.speaking.add('p:duckfake'); });
  const duckLow = await M.page.waitForFunction(() => TorePlayer.audio.volume <= 0.2, null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('up42 duck: while a remote voice speaks, the music ducks (≤0.2)', duckLow,
    await M.page.evaluate(() => TorePlayer.audio.volume.toFixed(2)));
  await M.page.evaluate(() => { cv.speaking.delete('p:duckfake'); });
  const duckBack = await M.page.waitForFunction(() => {
    const v = TorePlayer.audio.volume;
    return v >= 0.28 && v <= 0.38;
  }, null, { timeout: 10000 }).then(() => true).catch(() => false);
  check('up42 duck: after the speech stops, the music eases back to the background level', duckBack,
    await M.page.evaluate(() => TorePlayer.audio.volume.toFixed(2)));
  await M.page.evaluate(() => { exitClubRoomView(); });
  const duckFull = await M.page.waitForFunction(() => TorePlayer.audio.volume >= 0.95, null, { timeout: 10000 }).then(() => true).catch(() => false);
  check('up42 duck: leaving the club room restores full volume (1.0)', duckFull,
    await M.page.evaluate(() => TorePlayer.audio.volume.toFixed(2)));
  await O.ctx.close(); await M.ctx.close();

  // ================= F14: leaders restyle =================
  const L = await newPlayer('L');
  await L.page.click('#btn-profile');
  await L.page.waitForSelector('#scr-profile:not(.hidden)', { timeout: 15000 });
  await L.page.click('#btn-leaders');
  await L.page.waitForSelector('#scr-leaders:not(.hidden)', { timeout: 15000 });
  await sleep(600);
  const ld = await L.page.evaluate(() => {
    const grab = (sel) => { const cs = getComputedStyle(document.querySelector(sel)); return { color: cs.backgroundColor, image: cs.backgroundImage }; };
    const list = getComputedStyle(document.getElementById('ld-list'));
    return { leaders: grab('#scr-leaders'), profile: grab('#scr-profile'), listBg: list.backgroundImage, listRadius: list.borderRadius };
  });
  check('F14: leaders screen wears the purple home shell (== profile values)', ld.leaders.color === ld.profile.color && ld.leaders.image === ld.profile.image, ld.leaders.color);
  check('F14: leaders list is the magenta Ludo card', /216, 27, 116|209, 25, 115/.test(ld.listBg) && /103, 18, 78/.test(ld.listBg), ld.listBg.slice(0, 80));
  await L.page.screenshot({ path: path.join(SHOTS, 'leaders-ludo-FRESH.jpg'), type: 'jpeg', quality: 88 });
  check('F14: proof saved (leaders-ludo-FRESH.jpg)', fs.existsSync(path.join(SHOTS, 'leaders-ludo-FRESH.jpg')));
  await L.ctx.close();

  // ================= F17: profile photo upload (browser round-trip) =================
  const P = await newPlayer('P');
  await setName(P.page, 'Photo Tester');
  await P.page.click('#btn-profile');
  await P.page.waitForSelector('#scr-profile:not(.hidden)', { timeout: 15000 });
  await P.page.click('#btn-pf-edit-av');
  await P.page.waitForSelector('#ov-pfedit.show', { timeout: 8000 });
  const jpegB64 = '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';
  // The tile click arms the pick callback; the chooser supplies the file.
  const chooserP = P.page.waitForEvent('filechooser', { timeout: 10000 });
  await P.page.click('#btn-pf-upload');
  const chooser = await chooserP;
  await chooser.setFiles({ name: 'me.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpegB64, 'base64') });
  const photoSet = await P.page.waitForFunction(() => {
    try { const p = JSON.parse(localStorage.getItem('tore.profile') || '{}'); return typeof p.photo === 'string' && p.photo.startsWith('/p-photo/'); } catch { return false; }
  }, null, { timeout: 20000 }).then(() => true).catch(() => false);
  check('F17: after upload the profile photo is the /p-photo/ path', photoSet);
  const photoPath = await P.page.evaluate(() => JSON.parse(localStorage.getItem('tore.profile') || '{}').photo);
  const served = await fetch(BASE + String(photoPath).split('?')[0]);
  const servedBuf = Buffer.from(await served.arrayBuffer());
  check('F17: the GET route serves JPEG bytes for the uploaded photo', served.status === 200 && servedBuf.length > 100 && servedBuf[0] === 0xFF && servedBuf[1] === 0xD8, served.status + ' ' + servedBuf.length + 'B');
  await P.page.click('#btn-profile-save');
  await P.page.waitForSelector('#btn-quick', { state: 'visible', timeout: 10000 });
  await P.page.click('#btn-profile');
  await P.page.waitForSelector('#scr-profile:not(.hidden)', { timeout: 15000 });
  await sleep(700);
  await P.page.screenshot({ path: path.join(SHOTS, 'photo-upload-FRESH.jpg'), type: 'jpeg', quality: 88 });
  check('F17: proof saved (photo-upload-FRESH.jpg)', fs.existsSync(path.join(SHOTS, 'photo-upload-FRESH.jpg')));
  await P.ctx.close();

  // ================= F5 + F46: two-player social (browser) =================
  const A = await newPlayer('A');
  const B = await newPlayer('B');
  await setName(A.page, 'AhmadFeat');
  await setName(B.page, 'BilalFeat');
  const pidA = await A.page.evaluate(() => localStorage.getItem('tore.pid'));
  const pidB = await B.page.evaluate(() => localStorage.getItem('tore.pid'));
  check('setup: A and B befriended', await socialHandshake(pidA, 'AhmadFeat', pidB, 'BilalFeat'));
  await sleep(1200);

  // A sits in a lobby; B sees him in-lobby (baseline truth).
  const codeA = await createLobby(A.page);
  check('F46 setup: B sees A in-lobby while A really is', await waitFlags(B.page, pidA, { inlobby: true, online: true }, 15000));

  // ---- F46: A goes invisible (frame sent while A sits in his
  // lobby — the settings switch itself is covered by settingsx;
  // the mirror write keeps A's own switch UI in step) ----
  await A.page.evaluate(() => {
    setToreSetting('invisible', true);
    socialSend({ type: 's-invisible', on: true });
  });
  await sleep(600);
  check('F46: B now sees A OFFLINE everywhere while A is in a lobby', await waitFlags(B.page, pidA, { online: false, inlobby: false, ingame: false }, 15000));
  // A leaves his lobby (a seated target would be socialBusy, not
  // an F46 question) — still invisible, now free.
  await A.page.evaluate(() => { leaveGameToHome(); });
  await sleep(800);
  // B invites A anyway (raw frame — the invite must still arrive).
  const codeB = await createLobby(B.page);
  await B.page.evaluate(({ to, code }) => { socialSend({ type: 's-invite', to, code }); }, { to: 'p:' + pidA, code: codeB });
  const invPop = await A.page.waitForSelector('#ov-invite.show', { timeout: 15000 }).then(() => true).catch(() => false);
  check('F46: B\u2019s invite still ARRIVES at invisible A (popup shows)', invPop);
  await A.page.click('#btn-inv-reject');
  await sleep(500);
  // A turns invisible OFF via the real settings switch — live
  // presence returns without a reconnect.
  await A.page.click('#btn-settings');
  await A.page.waitForSelector('#ov-settings.show', { timeout: 8000 });
  await A.page.click('#row-set-invisible');
  await sleep(600);
  check('F46: turning it OFF restores A\u2019s live presence for B', await waitFlags(B.page, pidA, { online: true }, 15000));
  await A.page.click('#btn-settings-x');
  await sleep(400);

  // ---- F5: A turns DND on ----
  await A.page.click('#btn-settings');
  await A.page.waitForSelector('#ov-settings.show', { timeout: 8000 });
  await A.page.click('#row-set-dnd');
  await sleep(600);
  check('F5: B\u2019s friend payload for A carries dnd=true (the 🌙)', await waitFlags(B.page, pidA, { dnd: true }, 15000));
  await A.page.screenshot({ path: path.join(SHOTS, 'settings-switches-FRESH.jpg'), type: 'jpeg', quality: 88 });
  check('F5: proof saved (settings-switches-FRESH.jpg — settings sheet with the remaining switches, sound row removed in up40)', fs.existsSync(path.join(SHOTS, 'settings-switches-FRESH.jpg')));
  await A.page.screenshot({ path: path.join(SHOTS, 'dnd-settings-FRESH.jpg'), type: 'jpeg', quality: 88 });
  await A.page.click('#btn-settings-x');
  await sleep(400);
  // B invites A → rejected socialDnd → B sees the DND toast.
  await B.page.evaluate(({ to, code }) => { socialSend({ type: 's-invite', to, code }); }, { to: 'p:' + pidA, code: codeB });
  const toastTxt = await B.page.waitForFunction(() => {
    const t = document.getElementById('toast');
    return t && t.classList.contains('show') && t.textContent ? t.textContent : false;
  }, null, { timeout: 15000 }).then((h) => h.jsonValue()).catch(() => '');
  check('F5: sender sees the DND toast (Kandahari)', String(toastTxt).includes('مزاحمت نه غواړي'), String(toastTxt));
  await B.page.screenshot({ path: path.join(SHOTS, 'dnd-toast-FRESH.jpg'), type: 'jpeg', quality: 88 });
  const aGotInvite = await A.page.evaluate(() => document.getElementById('ov-invite').classList.contains('show'));
  check('F5: no invite popup reached DND A', aGotInvite === false);
  // DM still works under DND.
  await B.page.evaluate(({ to }) => { socialSend({ type: 's-dm', to, text: 'feat2 dm under dnd' }); }, { to: 'p:' + pidA });
  const dmOk = await A.page.waitForFunction((id) => {
    try { const th = dmThreads.get(id) || []; return th.some((m) => m.text === 'feat2 dm under dnd'); } catch { return false; }
  }, 'p:' + pidB, { timeout: 12000 }).then(() => true).catch(() => false);
  check('F5: a DM still reaches A while DND is on', dmOk);
  // DND off → the invite delivers.
  await A.page.click('#btn-settings');
  await A.page.waitForSelector('#ov-settings.show', { timeout: 8000 });
  await A.page.click('#row-set-dnd');
  await sleep(600);
  await A.page.click('#btn-settings-x');
  // The pair's 10 s send cooldown from the last DELIVERED invite
  // (the F46 one) must lapse first — rejections never stamp it,
  // but a fast driver can still be inside the window.
  await sleep(11000);
  await B.page.evaluate(({ to, code }) => { socialSend({ type: 's-invite', to, code }); }, { to: 'p:' + pidA, code: codeB });
  const invAfter = await A.page.waitForSelector('#ov-invite.show', { timeout: 15000 }).then(() => true).catch(() => false);
  check('F5: invite is delivered once DND is off', invAfter);
  await A.page.click('#btn-inv-reject');
  await A.ctx.close(); await B.ctx.close();

  // ================= F35: browser resume (persistent profiles) =================
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'tore-frz-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'tore-frz-b-'));
  const launchP = (dir) => chromium.launchPersistentContext(dir, { executablePath: exe, args: ['--no-sandbox'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'] });
  let pctxA = await launchP(dirA);
  let pctxB = await launchP(dirB);
  let fA = await bootPage(pctxA, 'FA');
  let fB = await bootPage(pctxB, 'FB');
  await setName(fA, 'Frz Ahmad');
  await setName(fB, 'Frz Bilal');
  const fcode = await createLobby(fA);
  await fB.click('#btn-join-toggle');
  await fB.waitForSelector('#ov-join.show', { timeout: 10000 });
  await fB.fill('#inp-code', fcode);
  await fB.click('#btn-join');
  await fB.waitForSelector('#scr-lobby:not(.hidden)', { timeout: 20000 });
  await fA.click('#btn-start');
  await fA.waitForSelector('#scr-game:not(.hidden)', { timeout: 20000 });
  await fB.waitForSelector('#scr-game:not(.hidden)', { timeout: 20000 });
  // play a couple of tricks on both tables
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const piles = await fA.evaluate(() => (typeof state !== 'undefined' && state && state.piles) ? state.piles.reduce((a, b) => a + b, 0) : 0).catch(() => 0);
    if (piles >= 2) break;
    await tapPlayable(fA); await tapPlayable(fB);
    await sleep(350);
  }
  const pilesBefore = await fA.evaluate(() => state.piles.reduce((a, b) => a + b, 0)).catch(() => -1);
  check('F35 setup: the match is under way (≥2 tricks)', pilesBefore >= 2, 'piles=' + pilesBefore);
  // BOTH apps die (context close — no leave frame).
  await pctxA.close(); await pctxB.close();
  await sleep(3000);
  // A returns: the client's boot resume reconnects the saved
  // session automatically — and because the match FROZE instead
  // of playing out under bots, A lands back on the exact state.
  pctxA = await launchP(dirA);
  const fA2 = pctxA.pages()[0] || await pctxA.newPage();
  fA2.on('pageerror', (e) => errs.push('FA2: ' + e.message));
  await fA2.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const backOnTable = await fA2.waitForFunction(() => {
    const g = document.getElementById('scr-game');
    return g && !g.classList.contains('hidden') && typeof state !== 'undefined' && state && state.phase === 'playing';
  }, null, { timeout: 30000 }).then(() => true).catch(() => false);
  check('F35: reopening the app auto-resumes the frozen match (back on the table)', backOnTable);
  const resumeSnap = await fA2.evaluate(() => ({ piles: state.piles.reduce((a, b) => a + b, 0), roundNo: state.roundNo })).catch(() => ({ piles: -1, roundNo: -1 }));
  check('F35: the frozen match kept its progress (no bot play while everyone was gone)',
    resumeSnap.piles >= pilesBefore && resumeSnap.piles <= pilesBefore + 1 && resumeSnap.roundNo >= 1,
    pilesBefore + ' -> ' + resumeSnap.piles + ' round ' + resumeSnap.roundNo);
  await pctxA.close();
  await sleep(1000);
  // The home Continue entry itself: relaunch with the sockets
  // blocked so the boot resume cannot complete — home renders
  // with the saved session, and «ادامهٔ بازی» must be offered.
  pctxA = await launchP(dirA);
  const fA3 = pctxA.pages()[0] || await pctxA.newPage();
  fA3.on('pageerror', (e) => errs.push('FA3: ' + e.message));
  let blockWs = true;
  await fA3.routeWebSocket(/.*/, (route) => { if (!blockWs) route.connectToServer(); });
  await fA3.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const contVisible = await fA3.waitForFunction(() => {
    const b = document.getElementById('btn-continue');
    const home = document.getElementById('scr-home');
    return b && home && !home.classList.contains('hidden') && !b.classList.contains('hidden');
  }, null, { timeout: 25000 }).then(() => true).catch(() => false);
  check('F35: home offers the «ادامهٔ بازی» Continue entry for the frozen match', contVisible);
  await fA3.screenshot({ path: path.join(SHOTS, 'resume-home-FRESH.jpg'), type: 'jpeg', quality: 88 });
  check('F35: proof saved (resume-home-FRESH.jpg)', fs.existsSync(path.join(SHOTS, 'resume-home-FRESH.jpg')));
  // Unblock and tap Continue — the same reconnect lands A back
  // on his seat and unfreezes the match.
  blockWs = false;
  await fA3.click('#btn-continue');
  const contLands = await fA3.waitForFunction(() => {
    const g = document.getElementById('scr-game');
    return g && !g.classList.contains('hidden') && typeof state !== 'undefined' && state && state.phase === 'playing';
  }, null, { timeout: 30000 }).then(() => true).catch(() => false);
  check('F35: tapping Continue reattaches A to his seat and play resumes', contLands);
  await pctxA.close();
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });

  // ================= F40 tutorial + F28 end-to-end =================
  const T = await newPlayer('T');
  await T.page.click('#btn-tutorial');
  await T.page.waitForSelector('#coach.show', { timeout: 15000 });
  const tutGoalTxt = await T.page.evaluate(() => document.getElementById('coach-txt').textContent);
  const tutGoalExpected = await T.page.evaluate(() => STR.ps.tutGoal);
  check('F40: tutorial opens on the goal card (ps)', tutGoalTxt === tutGoalExpected, tutGoalTxt.slice(0, 40));
  await T.page.click('#coach-next'); // -> tawan card
  await sleep(300);
  const tutTawanTxt = await T.page.evaluate(() => document.getElementById('coach-txt').textContent);
  check('F40: second card teaches the tawan values', tutTawanTxt === await T.page.evaluate(() => STR.ps.tutTawan), tutTawanTxt.slice(0, 40));
  await T.page.screenshot({ path: path.join(SHOTS, 'tutorial-step-FRESH.jpg'), type: 'jpeg', quality: 88 });
  check('F40: proof saved (tutorial-step-FRESH.jpg)', fs.existsSync(path.join(SHOTS, 'tutorial-step-FRESH.jpg')));
  await T.page.click('#coach-next'); // intro done — play begins
  await sleep(400);
  // Play the scripted round: dismiss coach cards, declare 13 when
  // offered, tap the glowing coach card on my turns; watch for the
  // takan burst at the round end (F28 end-to-end).
  let sawTakanBurst = false;
  let takanShot = false;
  let saw13Burst = false;
  let declared13 = false;
  const deadline = Date.now() + 420000;
  let endShown = false;
  while (Date.now() < deadline) {
    const snap = await T.page.evaluate(() => {
      const tb = document.getElementById('takanbanner');
      const b13 = document.getElementById('burst13');
      const coach = document.getElementById('coach');
      const next = document.getElementById('coach-next');
      const b13btn = document.getElementById('btn-13');
      return {
        takan: tb.classList.contains('show'),
        b13: b13.classList.contains('show'),
        coachShow: coach.classList.contains('show'),
        coachText: document.getElementById('coach-txt').textContent,
        nextVisible: next && next.style.display !== 'none',
        can13: b13btn && !b13btn.classList.contains('hidden'),
        endShow: document.getElementById('ov-tutend').classList.contains('show'),
        phase: (typeof state !== 'undefined' && state) ? state.phase : null,
      };
    }).catch(() => null);
    if (!snap) { await sleep(400); continue; }
    if (snap.takan) {
      sawTakanBurst = true;
      if (!takanShot) {
        takanShot = true;
        await T.page.screenshot({ path: path.join(SHOTS, 'takan-anim-FRESH.jpg'), type: 'jpeg', quality: 88 }).catch(() => {});
      }
    }
    if (snap.b13) saw13Burst = true;
    if (snap.endShow) { endShown = true; break; }
    if (snap.coachShow && snap.nextVisible) { await T.page.click('#coach-next').catch(() => {}); await sleep(350); continue; }
    if (snap.can13 && !declared13) {
      const clicked = await T.page.click('#btn-13', { timeout: 2000 }).then(() => true).catch(() => false);
      if (clicked) declared13 = true;
      await sleep(600);
      continue;
    }
    await tapPlayable(T.page, true);
    await sleep(330);
  }
  check('F40: the scripted lesson reaches the «حالا بازی کن» end card', endShown);
  check('F28 e2e: the takan burst fired at the scripted round end', sawTakanBurst);
  check('F28: proof saved (takan-anim-FRESH.jpg)', takanShot && fs.existsSync(path.join(SHOTS, 'takan-anim-FRESH.jpg')));
  check('F40: the «13» chance arrived in the scripted final trick', declared13);
  check('F28 e2e: the «13!» burst fired for the declaration', saw13Burst);
  if (endShown) {
    // The round-end summary still floats over the end card (the
    // lesson's round pause is huge by design) — a player taps it
    // away first (tap-to-dismiss), then uses the end card.
    await T.page.evaluate(() => { const o = document.getElementById('ov-round'); if (o) o.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await T.page.waitForFunction(() => !document.getElementById('ov-round').classList.contains('show'), null, { timeout: 8000 }).catch(() => {});
    await T.page.click('#btn-tut-home');
    await sleep(600);
    const homeOk = await T.page.evaluate(() => !!document.getElementById('btn-tutorial'));
    check('F40: end-card «کور» returns home', homeOk);
  }
  // fa/en spot-check of step 1
  for (const lang of ['fa', 'en']) {
    await T.page.evaluate((l) => { try { localStorage.setItem('tore.lang', l); } catch (e) { /* ignore */ } }, lang);
    await T.page.reload({ waitUntil: 'domcontentloaded' });
    await T.page.waitForSelector('#btn-tutorial', { state: 'visible', timeout: 30000 });
    await sleep(600);
    await T.page.click('#btn-tutorial');
    await T.page.waitForSelector('#coach.show', { timeout: 15000 });
    const txt = await T.page.evaluate(() => document.getElementById('coach-txt').textContent);
    const exp = await T.page.evaluate((l) => STR[l].tutGoal, lang);
    check('F40: step 1 renders in ' + lang, txt === exp, txt.slice(0, 40));
    await T.page.click('#coach-exit');
    await sleep(500);
  }
  await T.ctx.close();

  check('no page errors across the feat2 driver', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  check('feat2 driver completed', false, e.message);
} finally {
  try { await browser.close(); } catch { /* ignore */ }
  srv.kill('SIGKILL');
}

console.log(failures === 0 ? '\nALL FEAT2 CHECKS PASSED' : '\n' + failures + ' FEAT2 CHECK(S) FAILED');
process.exit(failures ? 1 : 0);
