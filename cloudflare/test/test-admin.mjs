/**
 * test-admin.mjs — up111 ADMIN panel checks against a `wrangler dev`
 * instance with AUTH on (default http://127.0.0.1:8788, same harness
 * as test-auth.mjs — start it with: npx wrangler dev --port 8788):
 *   1. /admin/* without a session → 401 (and with a forged cookie)
 *   2. a normal player's session → /auth/me isAdmin:false, /admin/*
 *      → 403 on all three routes
 *   3. the admin session (verified email shuaibanwari30@gmail.com,
 *      hand-minted with the local SESSION_SECRET exactly like
 *      test-auth) → /auth/me isAdmin:true
 *   4. a target player says hello on the social socket; the admin
 *      looks him up by his 6-digit ID (name / coins / gems / level)
 *   5. grant +5000 coins → balance + the wallet ledger reflect it
 *      (kind 'admin', ref 'admin:<email>'); grant +250 gems;
 *      deduct past the balance → floors at 0 with the applied
 *      amount reported; unknown ID → 404; bad amounts/caps → 400
 *   6. /admin/grants lists the grants just made, newest first
 * Exit code non-zero on any failure.
 */
import { ToreClient } from './driver.mjs';
import { mintSessionCookie, sessionSecret } from './mint-session.mjs';

const BASE = process.env.TORE_BASE || 'http://127.0.0.1:8788';
const SOCIAL = BASE.replace(/^http/, 'ws') + '/social';
let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
}

const secret = sessionSecret();
// Run-unique subs: the local DO persists across runs, so each run
// must arrive as brand-new players (fresh uid, fresh wallet).
const RUN = Date.now().toString(36);
const ADMIN = { provider: 'google', sub: 'admin-test-' + RUN, name: 'Admin', email: 'shuaibanwari30@gmail.com', picture: '' };
const PLAYER = { provider: 'google', sub: 'player-test-' + RUN, name: 'بازیکن عادی', email: 'player@example.com', picture: '' };
const TARGET = { provider: 'google', sub: 'target-test-' + RUN, name: 'هدف ادمین', email: 'target@example.com', picture: '' };
const adminCookie = mintSessionCookie(ADMIN, secret);
const playerCookie = mintSessionCookie(PLAYER, secret);
const targetCookie = mintSessionCookie(TARGET, secret);

const api = async (path, cookie, opts = {}) => {
  const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) };
  const r = await fetch(BASE + path, { ...opts, headers });
  let j = null;
  try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, j };
};
const grant = (cookie, body) => api('/admin/grant', cookie, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// ---- 1. unauthenticated → 401 ------------------------------------
for (const [name, p, o] of [
  ['GET /admin/player', '/admin/player?id=123456', {}],
  ['POST /admin/grant', '/admin/grant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
  ['GET /admin/grants', '/admin/grants', {}],
]) {
  const r = await api(p, null, o);
  check('no session: ' + name + ' → 401', r.status === 401, 'status ' + r.status);
}
{
  const r = await api('/admin/grants', 'tore_session=AAAA.BBBB');
  check('forged cookie: /admin/grants → 401', r.status === 401, 'status ' + r.status);
}

// ---- 2. normal player → 403 --------------------------------------
{
  const me = await api('/auth/me', playerCookie);
  check('/auth/me (player) isAdmin:false', me.status === 200 && me.j && me.j.isAdmin === false);
  const a = await api('/admin/player?id=123456', playerCookie);
  const b = await grant(playerCookie, { playerId: '123456', currency: 'coins', amount: 5 });
  const c = await api('/admin/grants', playerCookie);
  check('player: /admin/player → 403', a.status === 403, 'status ' + a.status);
  check('player: /admin/grant → 403', b.status === 403, 'status ' + b.status);
  check('player: /admin/grants → 403', c.status === 403, 'status ' + c.status);
}

// ---- 3. admin session ---------------------------------------------
{
  const me = await api('/auth/me', adminCookie);
  check('/auth/me (admin) isAdmin:true', me.status === 200 && me.j && me.j.isAdmin === true,
    me.j ? 'email ' + me.j.email : 'status ' + me.status);
}

// ---- 4. target player on the social socket ------------------------
const tc = new ToreClient(SOCIAL, { Cookie: targetCookie });
await tc.open();
tc.send({ type: 's-hello', pid: '', profile: { name: TARGET.name, avatar: 'av3', country: 'افغانستان' } });
const init = await tc.waitFor((m) => m.type === 's-init', 15000, 'target s-init');
const uid = String(init.uid || '');
check('target got a 6-digit uid', /^\d{6}$/.test(uid), 'uid ' + uid);
tc.send({ type: 's-wallet' }); // mints the wallet (1000 start grant)
const w0 = await tc.waitFor((m) => m.type === 's-wallet', 15000, 'target s-wallet');
check('target wallet minted at 1000 coins / 0 gems',
  w0.wallet.coins === 1000 && w0.wallet.gems === 0,
  'coins ' + w0.wallet.coins + ' gems ' + w0.wallet.gems);

// a second target who never pulled his wallet: no record yet
const TARGET2 = { provider: 'google', sub: 'target2-test-' + RUN, name: 'هدف دوم', email: 'target2@example.com', picture: '' };
const tc2 = new ToreClient(SOCIAL, { Cookie: mintSessionCookie(TARGET2, secret) });
await tc2.open();
tc2.send({ type: 's-hello', pid: '', profile: { name: TARGET2.name, avatar: 'av5', country: 'افغانستان' } });
const init2 = await tc2.waitFor((m) => m.type === 's-init', 15000, 'target2 s-init');
const uid2 = String(init2.uid || '');

// ---- 5. lookup -----------------------------------------------------
{
  const r = await api('/admin/player?id=' + uid, adminCookie);
  check('lookup: 200 + identity', r.status === 200 && r.j && r.j.player && r.j.player.name === TARGET.name,
    r.j && r.j.player ? r.j.player.name : 'status ' + r.status);
  check('lookup: balances 1000/0 + level', !!r.j && !!r.j.player && r.j.player.coins === 1000 && r.j.player.gems === 0
    && Number.isInteger(r.j.player.level), JSON.stringify(r.j && r.j.player));
  const noWallet = await api('/admin/player?id=' + uid2, adminCookie);
  check('lookup: wallet minted at first hello → 1000 coins',
    noWallet.status === 200 && noWallet.j.player.coins === 1000 && noWallet.j.player.gems === 0,
    JSON.stringify(noWallet.j && noWallet.j.player));
  const missing = await api('/admin/player?id=000000', adminCookie);
  check('lookup: unknown ID → 404', missing.status === 404, 'status ' + missing.status);
  const badId = await api('/admin/player?id=12345', adminCookie);
  check('lookup: malformed ID → 400', badId.status === 400, 'status ' + badId.status);
}

// ---- 6. grants ------------------------------------------------------
{
  const g1 = await grant(adminCookie, { playerId: uid, currency: 'coins', amount: 5000 });
  check('grant +5000 coins → 200, balance 6000', g1.status === 200 && g1.j && g1.j.ok && g1.j.coins === 6000 && g1.j.amount === 5000,
    JSON.stringify(g1.j));
  tc.send({ type: 's-wallet' });
  const w1 = await tc.waitFor((m) => m.type === 's-wallet' && m.wallet.coins === 6000, 15000, 'wallet after grant');
  const led = (w1.wallet.ledger || [])[0] || {};
  check('ledger: newest entry is the admin grant', led.kind === 'admin' && led.amount === 5000 && String(led.ref).startsWith('admin:'),
    JSON.stringify(led));

  const g2 = await grant(adminCookie, { playerId: uid, currency: 'gems', amount: 250 });
  check('grant +250 gems → gems 250', g2.status === 200 && g2.j && g2.j.gems === 250, JSON.stringify(g2.j));

  const g3 = await grant(adminCookie, { playerId: uid, currency: 'coins', amount: -999999 });
  check('deduct past balance → floors at 0, applied -6000',
    g3.status === 200 && g3.j && g3.j.coins === 0 && g3.j.amount === -6000, JSON.stringify(g3.j));

  const g4 = await grant(adminCookie, { playerId: uid, currency: 'gems', amount: -50 });
  check('deduct -50 gems → gems 200', g4.status === 200 && g4.j && g4.j.gems === 200, JSON.stringify(g4.j));

  const g5 = await grant(adminCookie, { playerId: uid2, currency: 'coins', amount: 100 });
  check('grant to second target → 1000 + 100 = 1100',
    g5.status === 200 && g5.j && g5.j.coins === 1100, JSON.stringify(g5.j));

  for (const [name, body] of [
    ['amount 0', { playerId: uid, currency: 'coins', amount: 0 }],
    ['coins over cap', { playerId: uid, currency: 'coins', amount: 1000001 }],
    ['gems over cap', { playerId: uid, currency: 'gems', amount: 100001 }],
    ['non-integer amount', { playerId: uid, currency: 'coins', amount: 5.5 }],
    ['string amount', { playerId: uid, currency: 'coins', amount: '500' }],
    ['bad currency', { playerId: uid, currency: 'gold', amount: 5 }],
  ]) {
    const r = await grant(adminCookie, body);
    check('reject: ' + name + ' → 400', r.status === 400 && r.j && r.j.ok === false, 'status ' + r.status);
  }
  const nf = await grant(adminCookie, { playerId: '000000', currency: 'coins', amount: 5 });
  check('grant: unknown player → 404', nf.status === 404, 'status ' + nf.status);
  const badPid = await grant(adminCookie, { playerId: '123', currency: 'coins', amount: 5 });
  check('grant: malformed playerId → 400', badPid.status === 400, 'status ' + badPid.status);
}

// ---- 7. audit list ---------------------------------------------------
{
  const r = await api('/admin/grants', adminCookie);
  const list = (r.j && r.j.grants) || [];
  check('grants list: 200 with the grants just made', r.status === 200 && list.length >= 5, 'entries ' + list.length);
  const mine = list.filter((g) => g.uid === uid);
  check('grants list: newest first (last grant at top)',
    mine.length >= 4 && mine[0].currency === 'gems' && mine[0].amount === -50,
    JSON.stringify(mine[0] || null));
  check('grants list: carries target, currency, amount, admin identity',
    mine.some((g) => g.currency === 'coins' && g.amount === 5000 && g.by === ADMIN.email && g.name === TARGET.name));
  check('grants list: clamped deduction recorded as applied (-6000)',
    mine.some((g) => g.currency === 'coins' && g.amount === -6000));
}
tc.close();
tc2.close();

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL ADMIN CHECKS PASSED');
process.exit(failures ? 1 : 0);
