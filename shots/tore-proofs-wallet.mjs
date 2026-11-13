#!/usr/bin/env node
/**
 * tore-proofs-wallet.mjs — up47 money-system proofs (phases 1+2).
 *
 *   node shots/tore-proofs-wallet.mjs unit   — SocialCore wallet
 *     API directly: start grant once, daily bonus once per Kabul
 *     day, chest + cooldown, shop buy / ownership / poor / bad
 *     sku, escrow all-or-nothing, win settlement (each winner
 *     +2×), loser loss, forfeit burn, insufficient → no movement,
 *     void refund, double-settle / double-escrow impossible,
 *     ledger cap.
 *   node shots/tore-proofs-wallet.mjs node   — the Node host
 *     (server.js) over real sockets: grant on hello, escrow at
 *     match start, explicit-leave forfeit + frozen-expiry refund
 *     (the leaver is NOT refunded), bot-seat match runs free,
 *     insufficient-balance match runs free, locked cosmetic
 *     filtered at create, shop claims over /social.
 *   node shots/tore-proofs-wallet.mjs do     — the Durable Object
 *     host (wrangler dev, AUTH off, fresh persist dir): grant,
 *     escrow, and a FULL staked match played to the end by four
 *     scripted clients → settlement lands exactly once (winners
 *     +2× tier net of their stake, losers keep the loss).
 *
 * Exit code non-zero on any failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(os.homedir(), 'workspace/projects/tore-game');
const WebSocket = require(path.join(ROOT, 'node_modules/ws'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const part = process.argv[2] || 'unit';

// A minimal WS client in the spirit of cloudflare/test/driver.mjs.
class C {
  constructor(url) { this.url = url; this.messages = []; this.waiters = []; this.state = null; }
  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on('open', resolve);
      ws.on('error', reject);
      ws.on('message', (data) => {
        let m; try { m = JSON.parse(data.toString()); } catch { return; }
        this.messages.push(m);
        if (m.type === 'state') this.state = m;
        this.waiters = this.waiters.filter((w) => {
          if (w.pred(m)) { w.resolve(m); return false; }
          return true;
        });
      });
    });
  }
  send(o) { try { this.ws.send(JSON.stringify(o)); } catch { /* gone */ } }
  waitFor(pred, timeoutMs = 20000, label = 'message') {
    const hit = this.messages.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout: ' + label)), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
  wallet() {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.type === 's-wallet') return m.wallet;
      if (m.type === 's-init' && m.wallet) return m.wallet;
    }
    return null;
  }
  async waitWallet(pred, timeoutMs = 20000, label = 'wallet') {
    const t0 = Date.now();
    for (;;) {
      const w = this.wallet();
      if (w && pred(w)) return w;
      if (Date.now() - t0 > timeoutMs) throw new Error('timeout: ' + label + ' (last=' + JSON.stringify(w) + ')');
      await sleep(150);
    }
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
  kill() { try { this.ws.terminate(); } catch { /* ignore */ } }
}

// ============================== UNIT ==============================
if (part === 'unit') {
  const { SocialCore } = require(path.join(ROOT, 'social-core.js'));
  const sent = [];
  const core = new SocialCore({ sendTo: (id, m) => sent.push({ id, m }), persist: () => {} });
  const P = (n) => 'p:unit' + n;
  const bal = (id) => core.walletState(id).coins;

  core.hello(P(1), { name: 'Unit One' });
  check('unit: start grant 1000 on first hello', bal(P(1)) === 1000, String(bal(P(1))));
  core.hello(P(1), { name: 'Unit One' });
  const grants = core.walletState(P(1)).ledger.filter((e) => e.kind === 'grant');
  check('unit: grant lands exactly once across re-hellos', bal(P(1)) === 1000 && grants.length === 1);

  check('unit: daily bonus +100', core.walletClaimBonus(P(1)) === true && bal(P(1)) === 1100);
  check('unit: second bonus the same Kabul day rejected', core.walletClaimBonus(P(1)) === false && bal(P(1)) === 1100);
  // A wallet whose lastBonusDay is yesterday (Kabul) may claim again.
  core._wallet(P(2), true); // mint via the internal create path (grant included)
  core.wallets.get(P(2)).lastBonusDay = '2000-01-01';
  check('unit: bonus claimable again on a new Kabul day', core.walletClaimBonus(P(2)) === true && bal(P(2)) === 1100);

  check('unit: chest +50', core.walletClaimChest(P(1)) === true && bal(P(1)) === 1150);
  check('unit: chest cooldown rejects an immediate second claim', core.walletClaimChest(P(1)) === false && bal(P(1)) === 1150);
  check('unit: chest state reports a future chestNext', core.walletState(P(1)).chestNext > Date.now());

  check('unit: buy back2 (300) deducts and owns', core.walletBuy(P(1), 'back2') === true && bal(P(1)) === 850 && core.ownsCosmetic(P(1), 'back2'));
  check('unit: buying an owned item rejected (walletOwned)', core.walletBuy(P(1), 'back2') === false && bal(P(1)) === 850);
  check('unit: forged sku rejected (walletBadSku)', core.walletBuy(P(1), '__proto__') === false && core.walletBuy(P(1), 'back99') === false && bal(P(1)) === 850);
  check('unit: the free defaults are always owned', core.ownsCosmetic(P(1), 'back1') && core.ownsCosmetic(P(1), 'felt11'));
  check('unit: unaffordable buy rejected (walletPoor)', core.walletBuy(P(1), 'felt10') === false && bal(P(1)) === 850); // felt10 = 1500 > 850

  // Escrow + settle: seats 0..3, teams {0,2} vs {1,3}.
  const S = (n, seat) => ({ id: P(n), seat });
  check('unit: escrow takes the tier from all four', core.walletEscrow('U-M1', 100, [S(1, 0), S(3, 1), S(4, 2), S(5, 3)]) === true
    && bal(P(1)) === 750 && bal(P(3)) === 900 && bal(P(4)) === 900 && bal(P(5)) === 900);
  check('unit: double escrow of one match impossible', core.walletEscrow('U-M1', 100, [S(1, 0), S(3, 1), S(4, 2), S(5, 3)]) === false && bal(P(1)) === 750);
  check('unit: settle pays each winner +2× tier', core.walletSettle('U-M1', 0) === true
    && bal(P(1)) === 950 && bal(P(4)) === 1100 && bal(P(3)) === 900 && bal(P(5)) === 900);
  check('unit: double settlement impossible', core.walletSettle('U-M1', 0) === false && bal(P(1)) === 950);
  check('unit: refund after settlement is a no-op', core.walletRefund('U-M1') === false && bal(P(1)) === 950);

  // Forfeit burn: P3 (seat 1, team 1) leaves; team 1 wins anyway.
  check('unit: escrow #2', core.walletEscrow('U-M2', 100, [S(1, 0), S(3, 1), S(4, 2), S(5, 3)]) === true && bal(P(3)) === 800);
  check('unit: forfeit marks the leaver', core.walletForfeit('U-M2', P(3)) === true);
  check('unit: forfeit is idempotent + strangers cannot forfeit', core.walletForfeit('U-M2', P(3)) === false && core.walletForfeit('U-M2', P(99)) === false);
  check('unit: forfeited winner share burns, partner still paid', core.walletSettle('U-M2', 1) === true
    && bal(P(3)) === 800 && bal(P(5)) === 1000 && bal(P(1)) === 850 && bal(P(4)) === 1000);

  // Void refund: everyone who did not forfeit gets the tier back.
  check('unit: escrow #3', core.walletEscrow('U-M3', 500, [S(1, 0), S(3, 1), S(4, 2), S(5, 3)]) === true && bal(P(1)) === 350);
  // Balances after the #3 escrow: P1 350, P3 300, P4 500, P5 500 —
  // the refund must restore each to his pre-escrow balance.
  check('unit: void refund returns stakes', core.walletRefund('U-M3') === true
    && bal(P(1)) === 850 && bal(P(3)) === 800 && bal(P(4)) === 1000 && bal(P(5)) === 1000);
  check('unit: double refund impossible', core.walletRefund('U-M3') === false && bal(P(1)) === 850);

  // Insufficient funds: ONE short player → NO wallet moves at all.
  core.walletBuy(P(5), 'felt7'); // 1000 - 1000 = 0
  check('unit: drained wallet is at 0', bal(P(5)) === 0, String(bal(P(5))));
  const before = [bal(P(1)), bal(P(3)), bal(P(4)), bal(P(5))];
  check('unit: escrow with a broke player refused, nothing moves', core.walletEscrow('U-M4', 100, [S(1, 0), S(3, 1), S(4, 2), S(5, 3)]) === false
    && before.every((b, i) => bal(P([1, 3, 4, 5][i])) === b));
  check('unit: a forged tier is refused', core.walletEscrow('U-M5', 250, [S(1, 0), S(3, 1), S(4, 2), S(5, 3)]) === false
    && core.walletEscrow('U-M5', '100', [S(1, 0), S(3, 1), S(4, 2), S(5, 3)]) === false);

  // Ledger cap: hammer escrow+refund cycles, ledger stays ≤ 100.
  for (let i = 0; i < 40; i++) {
    const mid = 'U-CAP' + i;
    core.walletEscrow(mid, 100, [S(1, 0), S(3, 1), S(4, 2), S(6, 3)]);
    core.walletRefund(mid);
  }
  const ledLen = core.wallets.get(P(1)).ledger.length;
  check('unit: ledger capped at 100 entries', ledLen <= 100, String(ledLen));
  check('unit: balance never went negative anywhere', [...core.wallets.values()].every((w) => w.coins >= 0 && w.gems >= 0));

  // Persistence round-trip: wallets + an OPEN escrow survive.
  core.walletEscrow('U-P1', 100, [S(1, 0), S(3, 1), S(4, 2), S(6, 3)]);
  const snap = JSON.parse(JSON.stringify(core.serialize()));
  const core2 = new SocialCore({ sendTo: () => {}, persist: () => {} });
  core2.load(snap);
  check('unit: wallets + open escrow survive serialize/load', core2.walletState(P(1)).coins === bal(P(1))
    && core2.walletSettle('U-P1', 0) === true);

  console.log(failures ? ('\nUNIT: ' + failures + ' FAILURES') : '\nUNIT: ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

// ============================== NODE ==============================
if (part === 'node') {
  const PORT = '8823';
  const BASE = 'http://127.0.0.1:' + PORT;
  const WS = 'ws://127.0.0.1:' + PORT;
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, env: { ...process.env, PORT, TORE_FROZEN_MS: '2500' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    try { const r = await fetch(BASE + '/'); up = r.status > 0; } catch { await sleep(500); }
  }
  if (!up) { console.log('FAIL  node host did not come up'); process.exit(1); }

  const pid = (n) => 'walNode' + n + 'x';
  const social = {}, game = {};
  for (const n of [1, 2, 3, 4]) {
    social[n] = new C(WS + '/social');
    await social[n].open();
    social[n].send({ type: 's-hello', pid: pid(n), profile: { name: 'Node ' + n, avatar: 'av1', country: '' } });
    const init = await social[n].waitFor((m) => m.type === 's-init', 10000, 's-init ' + n);
    check('node: player ' + n + ' start grant 1000 in s-init', init.wallet && init.wallet.coins === 1000, JSON.stringify(init.wallet && init.wallet.coins));
  }
  // Grant once: a second hello must not re-grant.
  social[1].send({ type: 's-hello', pid: pid(1), profile: { name: 'Node 1', avatar: 'av1', country: '' } });
  await sleep(600);
  check('node: re-hello does not re-grant', social[1].wallet().coins === 1000);

  async function openGame(n) {
    const g = new C(WS + '/ws');
    await g.open();
    game[n] = g;
    return g;
  }
  async function createRoom(n, frame) {
    const g = await openGame(n);
    g.send({ type: 'create', name: 'Node ' + n, pid: pid(n), felt: 11, back: 1, ...frame });
    const room = await g.waitFor((m) => m.type === 'room', 10000, 'room reply');
    const st = await g.waitFor((m) => m.type === 'state' && m.phase === 'lobby', 10000, 'lobby state');
    return { g, code: room.code, st };
  }
  async function joinRoom(n, code) {
    const g = await openGame(n);
    g.send({ type: 'join', code, name: 'Node ' + n, pid: pid(n) });
    await g.waitFor((m) => m.type === 'room', 10000, 'join reply ' + n);
    return g;
  }

  // --- staked match: escrow at start ---
  const r1 = await createRoom(1, { tier: 100 });
  check('node: lobby state carries the tier', r1.st.tier === 100 && r1.st.staked === false, 'tier=' + r1.st.tier);
  await joinRoom(2, r1.code); await joinRoom(3, r1.code); await joinRoom(4, r1.code);
  game[1].send({ type: 'start' });
  const started = await game[1].waitFor((m) => m.type === 'state' && m.phase === 'playing', 15000, 'match start');
  check('node: state reports the match as staked', started.staked === true && started.tier === 100);
  for (const n of [1, 2, 3, 4]) {
    const w = await social[n].waitWallet((x) => x.coins === 900, 10000, 'escrow ' + n);
    check('node: escrow deducted 100 from player ' + n, w.coins === 900);
  }
  // --- explicit leave = forfeit; the rest disconnect → freeze → refund (not the leaver) ---
  game[2].send({ type: 'leave' });
  await sleep(800);
  check('node: leaver balance untouched at leave (stake already escrowed)', social[2].wallet().coins === 900);
  game[1].kill(); game[3].kill(); game[4].kill();
  for (const n of [1, 3, 4]) {
    const w = await social[n].waitWallet((x) => x.coins === 1000, 45000, 'frozen refund ' + n);
    check('node: frozen-expiry refund returns player ' + n + ' to 1000', w.coins === 1000);
  }
  await sleep(500);
  check('node: the explicit leaver is NOT refunded (forfeit stands)', social[2].wallet().coins === 900);

  // --- bot-seat match runs free ---
  const r2 = await createRoom(1, { tier: 500 });
  await joinRoom(2, r2.code);
  game[1].send({ type: 'start' });
  const st2 = await game[1].waitFor((m) => m.type === 'state' && m.phase === 'playing', 15000, 'bot match start');
  check('node: a match with bot seats is NOT staked', st2.staked === false);
  await sleep(700);
  check('node: bot match moved no wallet', social[1].wallet().coins === 1000 && social[2].wallet().coins === 900);
  game[1].send({ type: 'leave' }); game[2].send({ type: 'leave' });

  // --- insufficient balance → the whole match runs free ---
  social[1].send({ type: 's-wallet-buy', sku: 'back4' }); // 1000 - 800 = 200
  const wA = await social[1].waitWallet((x) => x.coins === 200 && x.owned.includes('back4'), 10000, 'drain buy');
  check('node: shop buy over /social works (back4, 800)', wA.coins === 200 && wA.owned.includes('back4'));
  const r3 = await createRoom(1, { tier: 500 });
  await joinRoom(2, r3.code); await joinRoom(3, r3.code); await joinRoom(4, r3.code);
  game[1].send({ type: 'start' });
  const st3 = await game[1].waitFor((m) => m.type === 'state' && m.phase === 'playing', 15000, 'poor match start');
  check('node: match with a short player is NOT staked', st3.staked === false);
  await sleep(700);
  check('node: short-player match moved no wallet', social[1].wallet().coins === 200 && social[2].wallet().coins === 900
    && social[3].wallet().coins === 1000 && social[4].wallet().coins === 1000);
  for (const n of [1, 2, 3, 4]) game[n].send({ type: 'leave' });

  // --- locked cosmetics are filtered at create; owned ones pass ---
  const r4 = await createRoom(1, { felt: 5, back: 6 }); // owns neither (felt5, back6)
  check('node: locked felt+back fall back to the free defaults', r4.st.felt === 11 && r4.st.back === 1, 'felt=' + r4.st.felt + ' back=' + r4.st.back);
  game[1].send({ type: 'leave' });
  const r5 = await createRoom(1, { back: 4 }); // owns back4
  check('node: an owned back reaches the table', r5.st.back === 4, 'back=' + r5.st.back);
  game[1].send({ type: 'leave' });

  // --- shop claims over /social ---
  social[3].send({ type: 's-wallet-buy', sku: 'felt1' });
  const wC = await social[3].waitWallet((x) => x.owned.includes('felt1'), 10000, 'buy felt1');
  check('node: buy felt1 (400) → 600 + owned', wC.coins === 600 && wC.owned.includes('felt1'));
  social[3].send({ type: 's-wallet-buy', sku: 'felt1' });
  const e1 = await social[3].waitFor((m) => m.type === 's-error' && m.code === 'walletOwned', 10000, 'walletOwned');
  check('node: re-buy rejected walletOwned', !!e1);
  social[3].send({ type: 's-wallet-buy', sku: 'constructor' });
  const e2 = await social[3].waitFor((m) => m.type === 's-error' && m.code === 'walletBadSku', 10000, 'walletBadSku');
  check('node: forged sku rejected walletBadSku', !!e2 && social[3].wallet().coins === 600);
  social[3].send({ type: 's-wallet-chest' });
  const wC2 = await social[3].waitWallet((x) => x.coins === 650, 10000, 'chest claim');
  check('node: chest claim +50', wC2.coins === 650 && wC2.chestNext > Date.now());
  social[3].send({ type: 's-wallet-chest' });
  const e3 = await social[3].waitFor((m) => m.type === 's-error' && m.code === 'walletChestWait', 10000, 'walletChestWait');
  check('node: second chest inside the cooldown rejected', !!e3);
  social[3].send({ type: 's-wallet-bonus' });
  const wC3 = await social[3].waitWallet((x) => x.coins === 750, 10000, 'bonus claim');
  check('node: daily bonus claim +100', wC3.coins === 750 && wC3.bonusReady === false);
  social[3].send({ type: 's-wallet-bonus' });
  const e4 = await social[3].waitFor((m) => m.type === 's-error' && m.code === 'walletBonusWait', 10000, 'walletBonusWait');
  check('node: second bonus the same day rejected', !!e4);

  for (const n of [1, 2, 3, 4]) { social[n].close(); if (game[n]) game[n].close(); }
  srv.kill('SIGKILL');
  console.log(failures ? ('\nNODE: ' + failures + ' FAILURES') : '\nNODE: ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

// ============================== DO ==============================
if (part === 'do') {
  const PORT = 8797;
  const BASE = 'http://127.0.0.1:' + PORT;
  const WS = 'ws://127.0.0.1:' + PORT;
  const persist = path.join(os.homedir(), 'workspace/tmp-build/up47-do-persist');
  fs.rmSync(persist, { recursive: true, force: true });
  const wrangler = spawn(path.join(ROOT, 'cloudflare/node_modules/.bin/wrangler'),
    ['dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist, '--var', 'AUTH_ENABLED:0'],
    { cwd: path.join(ROOT, 'cloudflare'), stdio: ['ignore', 'pipe', 'pipe'] });
  wrangler.stderr.on('data', (d) => process.stderr.write('[wr] ' + d));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { const r = await fetch(BASE + '/'); up = r.status > 0; } catch { await sleep(1000); }
  }
  if (!up) { console.log('FAIL  wrangler did not come up'); try { wrangler.kill('SIGKILL'); } catch {} process.exit(1); }

  const pid = (n) => 'walDo' + n + 'xx';
  const social = {}, game = {};
  for (const n of [1, 2, 3, 4]) {
    social[n] = new C(WS + '/social');
    await social[n].open();
    social[n].send({ type: 's-hello', pid: pid(n), profile: { name: 'Do ' + n, avatar: 'av1', country: '' } });
    const init = await social[n].waitFor((m) => m.type === 's-init', 15000, 'DO s-init ' + n);
    check('do: player ' + n + ' start grant 1000 in s-init', init.wallet && init.wallet.coins === 1000);
  }
  async function openGame(n) { const g = new C(WS + '/ws'); await g.open(); game[n] = g; return g; }
  const gA = await openGame(1);
  gA.send({ type: 'create', name: 'Do 1', pid: pid(1), tier: 100, felt: 11, back: 1 });
  const room = await gA.waitFor((m) => m.type === 'room', 15000, 'DO room');
  for (const n of [2, 3, 4]) {
    const g = await openGame(n);
    g.send({ type: 'join', code: room.code, name: 'Do ' + n, pid: pid(n) });
    await g.waitFor((m) => m.type === 'room', 15000, 'DO join ' + n);
  }
  gA.send({ type: 'start' });
  const started = await gA.waitFor((m) => m.type === 'state' && m.phase === 'playing' && m.staked === true, 30000, 'DO staked start');
  check('do: state reports the match as staked (tier 100)', started.staked === true && started.tier === 100);
  for (const n of [1, 2, 3, 4]) {
    const w = await social[n].waitWallet((x) => x.coins === 900, 15000, 'DO escrow ' + n);
    check('do: escrow deducted 100 from player ' + n, w.coins === 900);
  }
  // Play the whole match: every client plays its first legal card
  // whenever it is its turn (outside the trick-hold window).
  const deadline = Date.now() + 600000;
  let endState = null;
  while (Date.now() < deadline) {
    let done = false;
    for (const n of [1, 2, 3, 4]) {
      const st = game[n].state;
      if (!st) continue;
      if (st.phase === 'matchEnd') { endState = st; done = true; }
    }
    if (done) break;
    for (const n of [1, 2, 3, 4]) {
      const st = game[n].state;
      if (st && st.phase === 'playing' && st.turn === st.mySeat && !st.trickWinner && st.legal && st.legal.length) {
        game[n].send({ type: 'play', card: st.legal[0] });
      }
    }
    await sleep(120);
  }
  check('do: the staked match played to matchEnd', !!endState, endState ? 'winner team ' + endState.matchWinner : 'TIMEOUT');
  if (endState) {
    const winner = endState.matchWinner;
    await sleep(1500); // settlement pushes land
    for (const n of [1, 2, 3, 4]) {
      const seat = n - 1;
      const expect = (seat % 2) === winner ? 1100 : 900;
      const w = await social[n].waitWallet((x) => x.coins === expect, 20000, 'DO settle ' + n);
      check('do: player ' + n + ' settled to ' + expect + ' (' + ((seat % 2) === winner ? 'winner +2×' : 'loser') + ')', w.coins === expect);
    }
    const snap = [1, 2, 3, 4].map((n) => social[n].wallet().coins);
    await sleep(4000);
    check('do: settlement is exactly-once (balances stable)', [1, 2, 3, 4].every((n, i) => social[n].wallet().coins === snap[i]));
    // Shop on the DO too: winner buys back2 from the settled balance.
    const wn = winner === 0 ? 1 : 2; // a winning seat's client (seat 0 → player 1, seat 1 → player 2)
    const beforeBuy = social[wn].wallet().coins;
    social[wn].send({ type: 's-wallet-buy', sku: 'back2' });
    const wB = await social[wn].waitWallet((x) => x.owned.includes('back2'), 15000, 'DO buy');
    check('do: shop buy on the DO (back2, 300)', wB.coins === beforeBuy - 300 && wB.owned.includes('back2'));
  }
  for (const n of [1, 2, 3, 4]) { social[n].close(); if (game[n]) game[n].close(); }
  try { wrangler.kill('SIGKILL'); } catch { /* ignore */ }
  console.log(failures ? ('\nDO: ' + failures + ' FAILURES') : '\nDO: ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

console.log('usage: node shots/tore-proofs-wallet.mjs unit|node|do');
process.exit(2);
