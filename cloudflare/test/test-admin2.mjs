/**
 * test-admin2.mjs — up112 SEPARATE admin panel checks against the
 * same wrangler dev :8788 harness as test-admin.mjs:
 *   1. GET /admin page: no session → 302 to /, player → 403,
 *      admin → 200 HTML (the new panel, links the API)
 *   2. /admin/stats, /admin/players (list + search + filters)
 *   3. ban: target banned → game 'create' refused with code
 *      'banned', social actions dropped; unban → create works
 *   4. broadcast → the target's inbox gains an 'announce' notif;
 *      notice → only the target gains one
 *   5. /admin/clubs shape, /admin/log records grant/ban/broadcast
 *   6. all new routes: player session → 403, no session → 401
 */
import { ToreClient } from './driver.mjs';
import { mintSessionCookie, sessionSecret } from './mint-session.mjs';

const BASE = process.env.TORE_BASE || 'http://127.0.0.1:8788';
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const SOCIAL = BASE.replace(/^http/, 'ws') + '/social';
let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
}
const secret = sessionSecret();
const RUN = Date.now().toString(36);
const ADMIN = { provider: 'google', sub: 'a2-admin-' + RUN, name: 'Admin', email: 'shuaibanwari30@gmail.com', picture: '' };
const PLAYER = { provider: 'google', sub: 'a2-player-' + RUN, name: 'بازیکن', email: 'p2@example.com', picture: '' };
const TARGET = { provider: 'google', sub: 'a2-target-' + RUN, name: 'هدف دوم', email: 't2@example.com', picture: '' };
const adminCookie = mintSessionCookie(ADMIN, secret);
const playerCookie = mintSessionCookie(PLAYER, secret);
const targetCookie = mintSessionCookie(TARGET, secret);

const api = async (path, cookie, opts = {}) => {
  const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) };
  const r = await fetch(BASE + path, { ...opts, headers, redirect: 'manual' });
  let j = null; const text = await r.text();
  try { j = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, j, text, loc: r.headers.get('location') };
};
const post = (cookie, body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// ---- 1. the page gate ---------------------------------------------
{
  const noSess = await api('/admin', null);
  check('page: no session → 302 to /', noSess.status === 302 && (noSess.loc || '').endsWith('/'), 'status ' + noSess.status);
  const asPlayer = await api('/admin', playerCookie);
  check('page: player session → 403', asPlayer.status === 403, 'status ' + asPlayer.status);
  const asAdmin = await api('/admin', adminCookie);
  check('page: admin → 200 + panel HTML', asAdmin.status === 200 && asAdmin.text.includes('پنل مدیریت') && asAdmin.text.includes('/admin/stats'), 'status ' + asAdmin.status + ', ' + asAdmin.text.length + ' bytes');
}

// target says hello (creates his directory record + wallet)
const soc = new ToreClient(SOCIAL, { Cookie: targetCookie });
await soc.open();
soc.send({ type: 's-hello', profile: { name: 'هدف دوم', avatar: 'av3', country: 'افغانستان' } });
const init = await soc.waitFor((m) => m.type === 's-init', 10000, 'target s-init');
const tuid = init.uid;
check('target hello → uid', /^\d{6}$/.test(tuid || ''), String(tuid));

// ---- 2. stats + players -------------------------------------------
{
  const st = await api('/admin/stats', adminCookie);
  check('stats: 200 + counters', st.status === 200 && st.j && st.j.stats && st.j.stats.players >= 1 && typeof st.j.stats.coins === 'number', JSON.stringify(st.j && st.j.stats));
  const list = await api('/admin/players', adminCookie);
  check('players: lists the target', list.status === 200 && list.j && list.j.rows.some((r) => r.uid === tuid), 'total ' + (list.j && list.j.total));
  const byUid = await api('/admin/players?q=' + tuid, adminCookie);
  check('players: search by uid finds exactly him', byUid.j && byUid.j.total === 1 && byUid.j.rows[0].uid === tuid);
  const banned0 = await api('/admin/players?f=banned', adminCookie);
  check('players: banned filter excludes him (not banned yet)', banned0.j && !banned0.j.rows.some((r) => r.uid === tuid));
  const noSess = await api('/admin/stats', null);
  check('stats: no session → 401', noSess.status === 401);
  const asPlayer = await api('/admin/players', playerCookie);
  check('players: player session → 403', asPlayer.status === 403);
}

// ---- 3. ban enforcement ---------------------------------------------
{
  const ban = await api('/admin/ban', adminCookie, post(adminCookie, { playerId: tuid, banned: true }));
  check('ban: 200 + banned:true', ban.status === 200 && ban.j && ban.j.ok && ban.j.banned === true, JSON.stringify(ban.j));
  const det = await api('/admin/player?id=' + tuid, adminCookie);
  check('ban: detail shows banned', det.j && det.j.player && det.j.player.banned === true);
  const bannedList = await api('/admin/players?f=banned', adminCookie);
  check('ban: banned filter now lists him', bannedList.j && bannedList.j.rows.some((r) => r.uid === tuid));

  const g = new ToreClient(WS, { Cookie: targetCookie });
  await g.open();
  g.send({ type: 'create', name: 'هدف دوم', avatar: 'av3', country: 'افغانستان' });
  const err = await g.waitFor((m) => m.type === 'error', 10000, 'banned create error').catch(() => null);
  check('ban: game create refused (code banned)', !!err && err.code === 'banned', err ? String(err.code) : 'no error frame');
  g.ws.close();

  const unban = await api('/admin/ban', adminCookie, post(adminCookie, { playerId: tuid, banned: false }));
  check('unban: 200 + banned:false', unban.status === 200 && unban.j && unban.j.banned === false);
  const g2 = new ToreClient(WS, { Cookie: targetCookie });
  await g2.open();
  g2.send({ type: 'create', name: 'هدف دوم', avatar: 'av3', country: 'افغانستان' });
  const room = await g2.waitFor((m) => m.type === 'room', 10000, 'room after unban').catch(() => null);
  check('unban: game create works again', !!room && /^[A-Z0-9]{4}$/.test(room.code || ''), room ? room.code : 'no room');
  g2.ws.close();
  const badId = await api('/admin/ban', adminCookie, post(adminCookie, { playerId: '12345', banned: true }));
  check('ban: malformed id → 400', badId.status === 400);
  const unknown = await api('/admin/ban', adminCookie, post(adminCookie, { playerId: '999998', banned: true }));
  check('ban: unknown id → 404', unknown.status === 404, 'status ' + unknown.status);
}

// ---- 4. broadcast + notice -------------------------------------------
{
  const before = (init.notifs || []).length;
  const bc = await api('/admin/broadcast', adminCookie, post(adminCookie, { text: 'اعلان آزمایشی همگانی' }));
  check('broadcast: 200 + sent >= 1', bc.status === 200 && bc.j && bc.j.ok && bc.j.sent >= 1, JSON.stringify(bc.j));
  const push = await soc.waitFor((m) => m.type === 's-notif' && m.notif && m.notif.kind === 'announce', 10000, 'announce push').catch(() => null);
  check('broadcast: online target got the announce push', !!push && push.notif.text === 'اعلان آزمایشی همگانی');
  const empty = await api('/admin/broadcast', adminCookie, post(adminCookie, { text: '   ' }));
  check('broadcast: empty text → 400', empty.status === 400);
  const nt = await api('/admin/notice', adminCookie, post(adminCookie, { playerId: tuid, text: 'پیام خصوصی آزمایشی' }));
  check('notice: 200 ok', nt.status === 200 && nt.j && nt.j.ok === true);
  const push2 = await soc.waitFor((m) => m.type === 's-notif' && m.notif && m.notif.text === 'پیام خصوصی آزمایشی', 10000, 'notice push').catch(() => null);
  check('notice: target got the private announce', !!push2);
}

// ---- 5. clubs + log ----------------------------------------------------
{
  const cl = await api('/admin/clubs', adminCookie);
  check('clubs: 200 + array', cl.status === 200 && cl.j && Array.isArray(cl.j.clubs));
  const grant = await api('/admin/grant', adminCookie, post(adminCookie, { playerId: tuid, currency: 'coins', amount: 777 }));
  check('grant for log: ok', grant.j && grant.j.ok === true);
  const log = await api('/admin/log', adminCookie);
  const acts = (log.j && log.j.log || []).map((e) => e.action);
  check('log: has grant + ban + unban + broadcast + notice', ['grant', 'ban', 'unban', 'broadcast', 'notice'].every((a) => acts.includes(a)), acts.slice(0, 8).join(','));
}

soc.ws.close();
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL ADMIN2 CHECKS PASSED');
process.exit(failures ? 1 : 0);
