/**
 * tore-proofs-dragteams.mjs — up52 proofs: the HOST arranges the
 * teams in the LOBBY by drag-and-drop (owner's order 2026-11-13).
 * Teams are seat parity (game.js teamOf: seats 0&2 vs 1&3), so
 * moving a player between seats IS setting his team. The client
 * drags a filled seat row onto another row and sends
 * {type:'seatswap', a, b}; the server accepts it ONLY from the
 * host, ONLY in the lobby phase — the seat RECORDS trade places
 * whole (identity + live connection ride together) and the two
 * sockets' seat back-pointers (Node: ws._seat; DO: the socket
 * attachment) are re-pointed, then the normal state broadcast
 * re-renders everyone and each moved client adopts its new
 * mySeat from the state.
 *
 *   STATIC — worker.js serves ?v=20261113-listpage; the dist
 *     stays under the 1,000,000 B budget; both Node server twins
 *     (server.js + deploy/server.js), the DO host and the client
 *     all carry 'seatswap'.
 *   RAW WS (root server.js) — two clients, one room: the GUEST's
 *     swap attempt changes nothing; the HOST's swap onto an EMPTY
 *     seat moves the guest there and the guest's next state
 *     carries mySeat=3 (his identity followed him); after the
 *     match starts, a further swap changes nothing.
 *   BROWSER (deploy/server.js) — three contexts (host + 2 guests)
 *     in one lobby: team pills + edge classes render for everyone,
 *     the drag hint shows ONLY to the host, only the host's filled
 *     rows are draggable; the guest's raw swap attempt changes
 *     nothing; the host performs two REAL pointer drags — a
 *     filled↔filled swap and a move onto the empty seat — and
 *     BOTH other clients re-render the new order with the moved
 *     players' mySeat adopted and team parity flipped; after the
 *     match starts a further swap changes nothing; no page errors.
 *   shots/up52-lobby-dragteams-FRESH.jpg — the host's lobby right
 *     after both drags (3 seats filled, teams arranged).
 *
 *   node shots/tore-proofs-dragteams.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
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
const WebSocket = require(path.join(os.homedir(), 'workspace/projects/tore-game/node_modules/ws'));

const ROOT = path.join(os.homedir(), 'workspace/projects/tore-game');
const SHOTS = path.join(ROOT, 'shots');
const RPORT = '8798';                    // root server.js (raw ws)
const BPORT = '8799';                    // deploy/server.js (browser)
const BBASE = 'http://127.0.0.1:' + BPORT;
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, stepMs = 350) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true;
    await sleep(stepMs);
  }
  return false;
}

// ---------------- static guards ----------------
const workerSrc = fs.readFileSync(path.join(ROOT, 'cloudflare/src/worker.js'), 'utf8');
check('worker.js serves ?v=20261113-listpage', workerSrc.includes('dist-client.html?v=20261113-listpage'));
const distBytes = fs.statSync(path.join(ROOT, 'cloudflare/dist-client.html')).size;
check('dist-client.html under the 1,000,000 B budget', distBytes < 1000000, distBytes + ' B');
for (const f of ['server.js', 'deploy/server.js', 'cloudflare/src/game-server.js', 'public/index.html']) {
  check(f + " carries 'seatswap'", fs.readFileSync(path.join(ROOT, f), 'utf8').includes('seatswap'));
}

execFileSync(process.execPath, [path.join(ROOT, 'build-deploy.js')], { stdio: 'pipe' });

function spawnServer(args, port) {
  const s = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, PORT: port },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('server did not start on ' + port)), 25000);
    s.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(to); resolve(s); } });
    s.on('exit', () => reject(new Error('server exited early on ' + port)));
  });
}
const rsrv = await spawnServer([path.join(ROOT, 'server.js')], RPORT);
const bsrv = await spawnServer([path.join(ROOT, 'deploy', 'server.js')], BPORT);

// ---------------- raw ws: the Node-host semantics ----------------
function wsClient(port) {
  const ws = new WebSocket('ws://127.0.0.1:' + port);
  const c = { ws, msgs: [], waiters: [] };
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(String(d)); } catch { return; }
    c.msgs.push(m);
    c.waiters = c.waiters.filter((w) => !w(m));
  });
  c.open = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  c.waitFor = (pred, ms = 10000) => new Promise((res, rej) => {
    const hit = c.msgs.find(pred);
    if (hit) return res(hit);
    const to = setTimeout(() => rej(new Error('waitFor timeout')), ms);
    c.waiters.push((m) => { if (pred(m)) { clearTimeout(to); res(m); return true; } return false; });
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.lastState = () => { for (let i = c.msgs.length - 1; i >= 0; i--) if (c.msgs[i].type === 'state') return c.msgs[i]; return null; };
  return c;
}
const seatSig = (st) => st ? st.seats.map((s) => s.kind === 'empty' ? '·' : s.name).join('|') : '<none>';
try {
  const a = wsClient(RPORT);
  await a.open;
  a.send({ type: 'create', name: 'RawHost', avatar: 'av3', country: 'افغانستان', pid: 'dragteamsRawA' });
  const room = await a.waitFor((m) => m.type === 'room');
  const b = wsClient(RPORT);
  await b.open;
  b.send({ type: 'join', code: room.code, name: 'RawGuest', avatar: 'av5', country: 'افغانستان', pid: 'dragteamsRawB' });
  await b.waitFor((m) => m.type === 'state' && m.mySeat === 1);
  const sig0 = seatSig(a.lastState());
  check('RAW setup: RawHost seat 0, RawGuest seat 1', sig0 === 'RawHost|RawGuest|·|·', sig0);

  // The GUEST tries to move himself to seat 3 — not the host: ignored.
  const bStatesBefore = b.msgs.filter((m) => m.type === 'state').length;
  b.send({ type: 'seatswap', a: 1, b: 3 });
  await sleep(700);
  check('RAW non-host seatswap is ignored (no state change, no broadcast)',
    seatSig(a.lastState()) === sig0 && b.msgs.filter((m) => m.type === 'state').length === bStatesBefore,
    'sig ' + seatSig(a.lastState()));

  // Bad indices from the host: also ignored.
  a.send({ type: 'seatswap', a: 0, b: 0 });
  a.send({ type: 'seatswap', a: -1, b: 2 });
  a.send({ type: 'seatswap', a: 0, b: 9 });
  await sleep(500);
  check('RAW invalid seatswap (a==b / out of range) is ignored', seatSig(a.lastState()) === sig0);

  // The HOST moves the guest onto the EMPTY seat 3.
  a.send({ type: 'seatswap', a: 1, b: 3 });
  const moved = await b.waitFor((m) => m.type === 'state' && m.mySeat === 3);
  check('RAW host swap onto an empty seat moves the guest — his next state says mySeat=3',
    seatSig(moved) === 'RawHost|·|·|RawGuest', seatSig(moved));
  check('RAW the host sees the same new order', seatSig(a.lastState()) === 'RawHost|·|·|RawGuest', seatSig(a.lastState()));

  // Match starts; a further swap (host <-> the moved guest) changes nothing.
  a.send({ type: 'start' });
  await b.waitFor((m) => m.type === 'state' && m.phase === 'playing');
  const sigPlay = seatSig(b.lastState());
  a.send({ type: 'seatswap', a: 0, b: 3 });
  await sleep(700);
  check('RAW seatswap after the match started changes nothing', seatSig(b.lastState()) === sigPlay,
    'before ' + sigPlay + ' / after ' + seatSig(b.lastState()));
  a.ws.close();
  b.ws.close();
} catch (e) {
  check('RAW ws checks completed', false, String(e && e.message || e).slice(0, 200));
}

// ---------------- browser: the real drag ----------------
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const errors = [];
async function newPlayer(tag) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    permissions: ['microphone'],
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(tag + ': ' + e.message));
  await page.goto(BBASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 45000 });
  await sleep(500);
  return { ctx, page };
}
async function setName(page, name) {
  await page.click('#btn-profile');
  await page.waitForSelector('#scr-profile:not(.hidden)', { timeout: 15000 });
  await page.click('#btn-pf-edit-av');
  await page.waitForSelector('#ov-pfedit.show', { timeout: 8000 });
  await page.fill('#pf-name', name);
  await page.click('#btn-profile-save');
  await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 15000 });
}
async function createLobby(page) {
  await page.click('#btn-online');
  await page.waitForSelector('#btn-pk-play', { state: 'visible', timeout: 15000 });
  await page.click('#btn-pk-play');
  await page.waitForSelector('#scr-lobby:not(.hidden)', { timeout: 20000 });
  return (await page.evaluate(() => document.querySelector('#lobby-code').textContent)).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}
async function joinLobby(page, code) {
  await page.click('#btn-join-toggle');
  await page.waitForSelector('#ov-join.show', { timeout: 10000 });
  await page.fill('#inp-code', code);
  await page.click('#btn-join');
  await page.waitForSelector('#scr-lobby:not(.hidden)', { timeout: 20000 });
}
const stateNames = (page) => page.evaluate(() =>
  (state && state.seats) ? state.seats.map((s) => s.kind === 'empty' ? '' : s.name) : []).catch(() => []);
const mySeatIs = (page) => page.evaluate(() => mySeat).catch(() => -99);
const sameNames = (arr, want) => arr.length === want.length && arr.every((v, i) => v === want[i]);

async function dragRow(page, fromSeat, toSeat) {
  const src = page.locator('#lobby-seats .seatrow[data-seat="' + fromSeat + '"]');
  const dst = page.locator('#lobby-seats .seatrow[data-seat="' + toSeat + '"]');
  await src.scrollIntoViewIfNeeded();
  const sb = await src.boundingBox();
  const db = await dst.boundingBox();
  if (!sb || !db) throw new Error('row boxes missing for drag ' + fromSeat + '->' + toSeat);
  const sx = sb.x + sb.width / 2, sy = sb.y + sb.height / 2;
  const tx = db.x + db.width / 2, ty = db.y + db.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx, sy + 16, { steps: 4 });  // cross the ~10px drag threshold
  await page.mouse.move(tx, ty, { steps: 16 });
  await sleep(150);
  await page.mouse.up();
}

let H = null, Bp = null, Cp = null;
try {
  H = await newPlayer('H');
  Bp = await newPlayer('B');
  Cp = await newPlayer('C');
  await setName(H.page, 'HostAhmad');
  await setName(Bp.page, 'GuestBilal');
  await setName(Cp.page, 'GuestKarim');
  const code = await createLobby(H.page);
  await joinLobby(Bp.page, code);
  await joinLobby(Cp.page, code);
  const setupOk = await waitFor(async () =>
    sameNames(await stateNames(H.page), ['HostAhmad', 'GuestBilal', 'GuestKarim', '']), 20000);
  check('setup: host + 2 guests seated (0,1,2), seat 3 empty', setupOk,
    JSON.stringify(await stateNames(H.page)));

  // --- team display + host-only affordances ---
  const view = await H.page.evaluate(() => {
    const rows = [...document.querySelectorAll('#lobby-seats .seatrow')];
    return {
      classes: rows.map((r) => (r.classList.contains('team-a') ? 'A' : r.classList.contains('team-b') ? 'B' : '?')),
      badges: rows.map((r) => { const b = r.querySelector('.teambadge'); return b ? b.textContent : ''; }),
      draggables: rows.map((r) => r.classList.contains('draggable')),
      hintHidden: document.querySelector('#lobby-draghint').classList.contains('hidden'),
      hintText: document.querySelector('#lobby-draghint').textContent,
    };
  });
  check('team edge classes alternate by seat parity (A,B,A,B)', view.classes.join('') === 'ABAB', view.classes.join(','));
  check('team pills render (ټیم 1 / ټیم 2 / ټیم 1, empty seat none)',
    view.badges[0] === 'ټیم 1' && view.badges[1] === 'ټیم 2' && view.badges[2] === 'ټیم 1' && view.badges[3] === '',
    JSON.stringify(view.badges));
  check('filled rows are draggable for the host, the empty row is not',
    view.draggables.join(',') === 'true,true,true,false', view.draggables.join(','));
  check('the host sees the drag hint line', !view.hintHidden && view.hintText.includes('ټیمونه'), view.hintText.slice(0, 40));
  const guestView = await Bp.page.evaluate(() => ({
    draggables: [...document.querySelectorAll('#lobby-seats .seatrow')].filter((r) => r.classList.contains('draggable')).length,
    hintHidden: document.querySelector('#lobby-draghint').classList.contains('hidden'),
    badge1: (document.querySelector('#lobby-seats .seatrow[data-seat="1"] .teambadge') || {}).textContent || '',
  }));
  check('the guest gets NO dragging and NO hint, but sees the team pills',
    guestView.draggables === 0 && guestView.hintHidden && guestView.badge1 === 'ټیم 2', JSON.stringify(guestView));

  // --- the guest's raw swap attempt changes nothing ---
  await Bp.page.evaluate(() => send({ type: 'seatswap', a: 1, b: 3 }));
  await sleep(800);
  check("guest's seatswap attempt changes nothing on any client",
    sameNames(await stateNames(H.page), ['HostAhmad', 'GuestBilal', 'GuestKarim', '']) &&
    sameNames(await stateNames(Bp.page), ['HostAhmad', 'GuestBilal', 'GuestKarim', '']));

  // --- REAL DRAG 1: filled <-> filled (Bilal seat 1 onto Karim seat 2) ---
  await dragRow(H.page, 1, 2);
  const swapOk = await waitFor(async () =>
    sameNames(await stateNames(H.page), ['HostAhmad', 'GuestKarim', 'GuestBilal', '']), 12000);
  check('drag 1 (seat 1 onto seat 2) swaps the two players on the host', swapOk,
    JSON.stringify(await stateNames(H.page)));
  check('drag 1 re-renders on BOTH guests too',
    sameNames(await stateNames(Bp.page), ['HostAhmad', 'GuestKarim', 'GuestBilal', '']) &&
    sameNames(await stateNames(Cp.page), ['HostAhmad', 'GuestKarim', 'GuestBilal', '']),
    'B ' + JSON.stringify(await stateNames(Bp.page)) + ' C ' + JSON.stringify(await stateNames(Cp.page)));
  check('moved players adopt their new mySeat (Bilal 1->2, Karim 2->1, host stays 0)',
    (await mySeatIs(Bp.page)) === 2 && (await mySeatIs(Cp.page)) === 1 && (await mySeatIs(H.page)) === 0,
    'B=' + (await mySeatIs(Bp.page)) + ' C=' + (await mySeatIs(Cp.page)) + ' H=' + (await mySeatIs(H.page)));
  const domAfterSwap = await H.page.evaluate(() => {
    const r2 = document.querySelector('#lobby-seats .seatrow[data-seat="2"]');
    return {
      name: r2.querySelector('.sr-name').textContent,
      badge: r2.querySelector('.teambadge').textContent,
      cls: r2.className,
    };
  });
  check("Bilal's team parity flipped: seat 2 row shows him with the ټیم 1 pill",
    domAfterSwap.name.includes('GuestBilal') && domAfterSwap.badge === 'ټیم 1' && domAfterSwap.cls.includes('team-a'),
    JSON.stringify(domAfterSwap));

  // --- REAL DRAG 2: filled onto EMPTY (Karim, now seat 1, onto seat 3) ---
  await dragRow(H.page, 1, 3);
  const moveOk = await waitFor(async () =>
    sameNames(await stateNames(H.page), ['HostAhmad', '', 'GuestBilal', 'GuestKarim']), 12000);
  check('drag 2 (seat 1 onto the EMPTY seat 3) moves Karim there', moveOk,
    JSON.stringify(await stateNames(H.page)));
  check('drag 2 lands on the guests too; Karim adopts mySeat=3',
    sameNames(await stateNames(Cp.page), ['HostAhmad', '', 'GuestBilal', 'GuestKarim']) &&
    (await mySeatIs(Cp.page)) === 3,
    'C seats ' + JSON.stringify(await stateNames(Cp.page)) + ' mySeat=' + (await mySeatIs(Cp.page)));

  // --- the proof screenshot: arranged lobby, 3 seats filled ---
  await sleep(600);
  await H.page.screenshot({ path: path.join(SHOTS, 'up52-lobby-dragteams-FRESH.jpg'), type: 'jpeg', quality: 88 });
  check('proof saved (up52-lobby-dragteams-FRESH.jpg — lobby after both drags)', true);

  // --- start the match; a further swap changes nothing ---
  await H.page.click('#btn-start');
  const playing = await waitFor(async () =>
    (await H.page.evaluate(() => state && state.phase).catch(() => '')) === 'playing', 20000);
  check('the host starts the match from the arranged lobby', playing);
  await sleep(600);
  const sigPlay = (await stateNames(H.page)).join('|');
  await H.page.evaluate(() => send({ type: 'seatswap', a: 0, b: 1 }));
  await sleep(800);
  check('a seatswap during play changes nothing', (await stateNames(H.page)).join('|') === sigPlay,
    'before ' + sigPlay + ' / after ' + (await stateNames(H.page)).join('|'));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('dragteams driver completed without exception', false, String(e && e.message || e).slice(0, 240));
} finally {
  for (const p of [H, Bp, Cp]) { if (p) await p.ctx.close().catch(() => {}); }
  await browser.close().catch(() => {});
  rsrv.kill();
  bsrv.kill();
}
console.log(failures ? ('\n' + failures + ' FAILURE(S)') : '\nALL DRAG-TEAMS PROOF CHECKS PASSED');
process.exit(failures ? 1 : 0);
