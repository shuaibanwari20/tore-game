/**
 * tore-proofs-clubgame.mjs — browser proof for clubs v8 (club
 * games, ?v=20261110-clubgame): the golden game button in the
 * club room, the club-context picker, the club-game lobby with
 * its member invite panel, and member spectating.
 *
 * Three browser identities (owner / member / member) plus one
 * raw social socket (role flips). Checks:
 *   (a) the button renders for owner, deputy AND plain member;
 *   (b) the club-context picker opens with کوټه preselected and
 *       its ✖ returns to the club room;
 *   (c) the club-game lobby carries the club tag + «د کلب غړي»
 *       panel; a non-friend clubmate invited from it accepts
 *       and lands in the lobby;
 *   (d) a member with no live game gets «تر اوسه لوبه نشته» and
 *       NO picker; with a live game the button wears «ژوندی» and
 *       the tap spectates — hand-free (state.hand [], mySeat -1);
 *   (e) leaving the watch returns to the club room.
 * Proofs: shots/clubgame{,2,3,4,5}-FRESH.jpg (390x844).
 * Run against the NODE host (current source client + server):
 *   PORT=8790 node server.js   (separately)
 *   node shots/tore-proofs-clubgame.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { ToreClient } from '../cloudflare/test/driver.mjs';

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

const BASE = process.env.TORE_NODE_BASE || 'http://127.0.0.1:8790';
const SHOTS = path.join(os.homedir(), 'workspace/projects/tore-game/shots');
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const vis = (page, sel) => page.$eval(sel, (el) => !el.classList.contains('hidden')).catch(() => false);
// Wait (Node-side polling, rAF-independent) until #toast hides.
async function waitToastGone(page, label) {
  for (let i = 0; i < 24; i++) {
    const t = await page.evaluate(() => {
      const el = document.querySelector('#toast');
      return el ? { show: el.classList.contains('show'), text: el.textContent } : { show: false, text: '' };
    }).catch(() => ({ show: false, text: '' }));
    if (!t.show) { await new Promise((r) => setTimeout(r, 650)); return; } // + the slide-out transition
    if (i === 23) console.log('NOTE  toast still up before ' + label + ': ' + t.text);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const shown = (page, sel) => page.$eval(sel, (el) => el.classList.contains('show')).catch(() => false);

async function newPlayer(browser, pid, name, avatar) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(({ pid, name, avatar }) => {
    try {
      localStorage.setItem('tore.pid', pid);
      localStorage.setItem('tore.profile', JSON.stringify({ name, avatar, country: 'افغانستان', photo: '' }));
    } catch (e) { /* ignore */ }
  }, { pid, name, avatar });
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#btn-create', { state: 'visible', timeout: 30000 });
  await page.waitForTimeout(2200); // splash lifts, menu dressed
  return page;
}

async function joinClubViaSearch(page, cid) {
  await page.click('#nav-clubs');
  await page.waitForFunction(() => !document.querySelector('#scr-clubs').classList.contains('hidden'), { timeout: 10000 });
  await page.click('#btn-cl-search-toggle');
  await page.fill('#cl-search-inp', cid);
  await page.click('#btn-cl-search');
  await page.waitForSelector('.cl-card', { state: 'visible', timeout: 10000 });
  // (up41: the member's floating music pill can overlay the card —
  // the tap goes through the card's handler directly)
  await page.evaluate(() => document.querySelector('.cl-card').click());
  await page.waitForFunction(() => !document.querySelector('#cl-room').classList.contains('hidden'), { timeout: 15000 });
}

const browser = await chromium.launch({
  executablePath: exe,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
try {
  // ---------- owner creates the club (one-tap), room paints ----------
  const pA = await newPlayer(browser, 'cgProofA01', 'CgProof Owner', 'av3');
  await pA.click('#nav-clubs');
  await pA.waitForFunction(() => !document.querySelector('#scr-clubs').classList.contains('hidden'), { timeout: 10000 });
  await pA.click('#btn-cl-create');
  await pA.waitForFunction(() => !document.querySelector('#cl-room').classList.contains('hidden'), { timeout: 15000 });
  const cid = (await pA.$eval('#cl-id-num', (el) => el.textContent)).replace(/\D/g, '');
  check('club created via one tap', /^\d{6}$/.test(cid), 'cid ' + cid);

  // (a) the game button renders for the OWNER, under the trophy
  // (owner move order 2026-11-10: out of the input bar, into the
  // trophy column directly below the emblem + ♥ pill)
  check('owner sees the game button', await vis(pA, '#btn-cl-game'));
  const btnBox = await pA.$eval('#btn-cl-game', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const pillBox = await pA.$eval('.cl-trophy-n', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const colBox = await pA.$eval('.cl-trophy', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const barBox = await pA.$eval('.cl-inputbar', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const btnHome = await pA.$eval('#btn-cl-game', (el) => ({
    inTrophy: !!el.closest('.cl-trophy'), inBar: !!el.closest('.cl-inputbar'),
  }));
  check('button sits in the trophy column under the ♥ pill, NOT in the input bar',
    btnHome.inTrophy && !btnHome.inBar &&
    btnBox.y >= pillBox.y + pillBox.h - 1 &&
    btnBox.x >= colBox.x - 1 && btnBox.x + btnBox.w <= colBox.x + colBox.w + 1 &&
    Math.abs((btnBox.x + btnBox.w / 2) - (colBox.x + colBox.w / 2)) <= 3 &&
    btnBox.y + btnBox.h <= barBox.y + 1 &&
    // clubgame5 size order: the disc is now 56x56 (was 68 in clubgame4)
    btnBox.w >= 54 && btnBox.w <= 58 && btnBox.h >= 54 && btnBox.h <= 58,
    JSON.stringify(btnBox));
  check('no live badge before any game', !(await vis(pA, '#cl-game-live')));
  // let the «you are a member» toast clear the bar before framing
  await waitToastGone(pA, 'proof 1');
  await pA.screenshot({ path: path.join(SHOTS, 'clubgame-FRESH.jpg'), type: 'jpeg', quality: 82 });
  check('proof 1 saved (club room, owner, game button)', true);

  // ---------- member joins; (d) no game yet ----------
  const pB = await newPlayer(browser, 'cgProofB01', 'CgProof Member', 'av5');
  await joinClubViaSearch(pB, cid);
  check('member auto-joined into the room', true);
  check('plain member sees the game button', await vis(pB, '#btn-cl-game'));
  await pB.click('#btn-cl-game');
  await pB.waitForFunction(() => document.querySelector('#toast').classList.contains('show'), { timeout: 6000 });
  const toastTxt = await pB.$eval('#toast', (el) => el.textContent);
  check('member tap with no game → «تر اوسه لوبه نشته» toast', toastTxt.includes('تر اوسه لوبه نشته'), toastTxt);
  check('member tap with no game → picker does NOT open', !(await vis(pB, '#scr-picker')));

  // ---------- second member joins ----------
  const pC = await newPlayer(browser, 'cgProofC01', 'CgProof Watcher', 'av7');
  await joinClubViaSearch(pC, cid);
  check('second member joined; button visible', await vis(pC, '#btn-cl-game'));

  // (a) deputy: flip B's role over a raw social socket (same
  // identity as B's browser), the room state push re-roles him.
  const raw = new ToreClient(BASE.replace(/^http/, 'ws') + '/social');
  await raw.open();
  raw.send({ type: 's-hello', pid: 'cgProofA01', profile: { name: 'CgProof Owner', avatar: 'av3', country: 'افغانستان' } });
  await raw.waitFor((m) => m.type === 's-init', 8000, 'raw init');
  raw.send({ type: 's-club-role', id: 'p:cgProofB01', role: 'deputy' });
  await pB.waitForFunction(() => typeof roomClub === 'function' && roomClub() && roomClub().myRole === 'deputy', { timeout: 10000 });
  const bMgr = await pB.evaluate(() => clubIsManager(roomClub()));
  check('deputy counts as manager (button opens picker for him)', bMgr === true);
  raw.send({ type: 's-club-role', id: 'p:cgProofB01', role: 'member' });
  await pB.waitForFunction(() => roomClub() && roomClub().myRole === 'member', { timeout: 10000 });
  raw.close();

  // ---------- (b) owner's club-context picker ----------
  await pA.click('#btn-cl-game');
  await pA.waitForFunction(() => !document.querySelector('#scr-picker').classList.contains('hidden'), { timeout: 8000 });
  const roomTabSel = await pA.$eval('#pktab-room', (el) => el.classList.contains('sel'));
  check('club picker opens with کوټه preselected', roomTabSel);
  await pA.screenshot({ path: path.join(SHOTS, 'clubgame2-FRESH.jpg'), type: 'jpeg', quality: 82 });
  check('proof 2 saved (picker from club)', true);
  await pA.click('#btn-pk-close');
  await pA.waitForFunction(() => document.querySelector('#scr-picker').classList.contains('hidden'), { timeout: 5000 });
  check('picker ✖ returns to the CLUB ROOM', await vis(pA, '#cl-room') && !(await vis(pA, '#scr-picker')));

  // ---------- (c) create the club game; lobby tag + panel + invite ----------
  await pA.click('#btn-cl-game');
  await pA.waitForFunction(() => !document.querySelector('#scr-picker').classList.contains('hidden'), { timeout: 8000 });
  await pA.click('#btn-pk-play');
  await pA.waitForFunction(() => !document.querySelector('#scr-lobby').classList.contains('hidden'), { timeout: 15000 });
  const tagTxt = await pA.$eval('#lobby-clubtag', (el) => el.textContent);
  check('lobby wears the club tag', tagTxt.includes('CgProof Owner'), tagTxt);
  check('creator sees «د کلب غړي»', await vis(pA, '#btn-lobby-club'));
  await pA.click('#btn-lobby-club');
  await pA.waitForFunction(() => document.querySelector('#ov-lobbyclub').classList.contains('show'), { timeout: 5000 });
  const rows = await pA.$$eval('#lc-list .fr-row', (rs) => rs.map((r) => r.textContent));
  check('panel lists both other members', rows.length === 2, rows.join(' | ').slice(0, 80));
  await pA.screenshot({ path: path.join(SHOTS, 'clubgame3-FRESH.jpg'), type: 'jpeg', quality: 82 });
  check('proof 3 saved (club-game lobby + member panel)', true);
  // invite B (NOT a friend — clubmate path) from the panel
  const bClicked = await pA.evaluate(() => {
    const row = [...document.querySelectorAll('#lc-list .fr-row')]
      .find((r) => r.textContent.includes('CgProof Member'));
    const btn = row ? row.querySelector('.fr-act.primary') : null;
    if (btn) btn.click();
    return !!btn;
  });
  check('B row carries a live «🔔 بلنه» button', bClicked);
  await pB.waitForFunction(() => document.querySelector('#ov-invite').classList.contains('show'), { timeout: 10000 });
  check('clubmate invite popup reaches B', await shown(pB, '#ov-invite'));
  await pB.click('#btn-inv-accept');
  await pB.waitForFunction(() => !document.querySelector('#scr-lobby').classList.contains('hidden'), { timeout: 15000 });
  check('B accepts and lands in the club-game lobby', true);
  await pA.evaluate(() => document.querySelector('#ov-lobbyclub').classList.remove('show'));

  // ---------- start; member spectates the live game ----------
  await pA.click('#btn-start');
  await pA.waitForFunction(() => !document.querySelector('#scr-game').classList.contains('hidden'), { timeout: 15000 });
  check('club game started (owner at the table)', true);
  await pC.waitForFunction(() => {
    const b = document.querySelector('#cl-game-live');
    return b && !b.classList.contains('hidden');
  }, { timeout: 12000 });
  check('member button wears the «ژوندی» badge while the game runs', true);
  await waitToastGone(pC, 'proof 4');
  await pC.screenshot({ path: path.join(SHOTS, 'clubgame4-FRESH.jpg'), type: 'jpeg', quality: 82 });
  check('proof 4 saved (member room + live badge)', true);

  await pC.click('#btn-cl-game');
  await pC.waitForFunction(() => !document.querySelector('#scr-game').classList.contains('hidden'), { timeout: 15000 });
  check('member tap spectates into the table', await vis(pC, '#spec-chip'));
  const spec = await pC.evaluate(() => ({
    spectating, mySeat: state && state.mySeat, spectator: state && state.spectator,
    hand: state && state.hand, seatsCards: state && state.seats.map((s) => s.cards),
    handDom: document.querySelectorAll('#hand > *').length,
  }));
  check('PRIVACY: spectator state has NO hand', spec.spectating === true && spec.spectator === true &&
    spec.mySeat === -1 && Array.isArray(spec.hand) && spec.hand.length === 0 && spec.handDom === 0,
    JSON.stringify(spec));
  check('spectator sees seat card COUNTS only', spec.seatsCards.every((n) => typeof n === 'number'),
    spec.seatsCards.join(','));
  await pC.waitForTimeout(1200);
  await pC.screenshot({ path: path.join(SHOTS, 'clubgame5-FRESH.jpg'), type: 'jpeg', quality: 82 });
  check('proof 5 saved (spectator table view)', true);

  // (e) leaving the watch returns to the club room
  await pC.click('#btn-leave');
  await pC.waitForFunction(() => !document.querySelector('#cl-room').classList.contains('hidden') &&
    document.querySelector('#scr-game').classList.contains('hidden'), { timeout: 8000 });
  check('spectator exit returns to the club room', true);

  // (f) SPECTATE-EXIT regression (owner bug 2026-11-11): leaving
  // the club screens for home (closeClubs — the handler behind the
  // room's exits; the clnav bar itself is display:none by design,
  // CSS «#scr-clubs .hm-nav { display:none }», so the handler is
  // invoked directly) only hides the club overlay — it assumes
  // #scr-home is alive underneath. During the watch, render() ->
  // show('scr-game') hid #scr-home and the old exitSpectate never
  // restored it, so this landed on the bare body (blank dark-green
  // field). exitSpectate now restores the base screen first.
  await pC.evaluate(() => closeClubs());
  await pC.waitForTimeout(600);
  const homeC = await pC.evaluate(() => ({
    home: !document.querySelector('#scr-home').classList.contains('hidden'),
    homeDisplay: getComputedStyle(document.querySelector('#scr-home')).display,
    game: !document.querySelector('#scr-game').classList.contains('hidden'),
    clubs: !document.querySelector('#scr-clubs').classList.contains('hidden'),
    doors: !!document.querySelector('#btn-quick') && document.querySelector('#btn-quick').getBoundingClientRect().width > 0,
    nav: !!document.querySelector('#nav-clubs') && document.querySelector('#nav-clubs').getBoundingClientRect().width > 0,
  }));
  check('club-spectate exit -> club room -> home nav lands on a COMPLETE home (no blank field)',
    homeC.home && homeC.homeDisplay !== 'none' && !homeC.game && !homeC.clubs && homeC.doors && homeC.nav,
    JSON.stringify(homeC));
} finally {
  await browser.close();
}
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL CLUBGAME BROWSER CHECKS PASSED');
process.exit(failures ? 1 : 0);
