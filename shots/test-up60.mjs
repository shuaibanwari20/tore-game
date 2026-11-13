/** up60 unit proof — the ticket state machine + the real auth.js
 *  chain (startGoogle stash -> callback -> ticket completion ->
 *  status consume -> session cookie that readSession accepts).
 *  Google's token endpoint is stubbed; the DO is a TicketStore over
 *  a Map, reached through a fake env.GAME stub that mirrors the
 *  real _ticketRoute contract. */
import { TicketStore, isTicketId } from '/home/hatch/workspace/projects/tore-game/cloudflare/src/tickets.js';
import * as auth from '/home/hatch/workspace/projects/tore-game/cloudflare/src/auth.js';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

// ---------- TicketStore over a Map ----------
const backing = new Map();
const storage = {
  get: async (k) => backing.get(k),
  put: async (k, v) => { backing.set(k, v); },
  delete: async (k) => { backing.delete(k); },
};
const store = new TicketStore(storage);
const t1 = await store.create();
check('T1 create returns a 32-hex id', isTicketId(t1), t1);
check('T2 fresh ticket is pending', (await store.status(t1)).state === 'pending');
const user = { provider: 'google', sub: '12345', name: 'Unit Test', email: 'unit@example.com', picture: '' };
check('T3 complete accepts a user', (await store.complete(t1, user)) === true);
const done = await store.status(t1);
check('T4 status done with the user', done.state === 'done' && done.user && done.user.sub === '12345');
check('T5 done consumes the ticket', (await store.status(t1)).state === 'gone');
const t2 = await store.create();
await store.fail(t2);
check('T6 failed ticket reports failed', (await store.status(t2)).state === 'failed');
check('T7 failed consumes the ticket', (await store.status(t2)).state === 'gone');
const t3 = await store.create();
backing.get('ticket:' + t3).exp = Date.now() - 1000; // backdate
check('T8 expired ticket is gone', (await store.status(t3)).state === 'gone');
check('T9 bogus ids are gone', (await store.status('nope')).state === 'gone' && (await store.complete('zz', user)) === false);

// ---------- auth.js chain with a fake GAME stub ----------
const stub = {
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    const body = await req.json().catch(() => ({}));
    if (path === '/internal/tickets/create') return Response.json({ ticket: await store.create() });
    if (path === '/internal/tickets/complete') return Response.json({ ok: !!(body.user) && (await store.complete(body.ticket, body.user)) });
    if (path === '/internal/tickets/fail') return Response.json({ ok: await store.fail(body.ticket) });
    if (path === '/internal/tickets/status') return Response.json(await store.status(body.ticket));
    return new Response('not found', { status: 404 });
  },
};
const env = {
  SESSION_SECRET: 'unit-secret',
  GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'unit-google-secret',
  GAME: { idFromName: () => 'global', get: () => stub },
};
let tokenMode = 'ok';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
    if (tokenMode === 'fail') return { ok: false, json: async () => ({}) };
    const claims = {
      iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 3600, sub: '12345',
      name: 'Unit Test', email: 'unit@example.com', picture: '',
    };
    return { ok: true, json: async () => ({ id_token: b64url({ alg: 'RS256' }) + '.' + b64url(claims) + '.sig' }) };
  }
  throw new Error('unexpected fetch ' + url);
};
try {
  const ticket = (await auth.createLoginTicket(env)).ticket /* U63: returns {ticket, code} */;
  check('A1 worker-side create returns a ticket', isTicketId(ticket), ticket);

  const startRes = await auth.startGoogle(new Request('https://tore.example/auth/google?ticket=' + ticket), env);
  const loc = new URL(startRes.headers.get('Location'));
  check('A2 start 302s to Google', startRes.status === 302 && loc.hostname === 'accounts.google.com', loc.hostname);
  const stashCookie = (startRes.headers.get('Set-Cookie') || '').split(';')[0];
  check('A3 stash cookie set', stashCookie.startsWith('tore_oauth='));
  const state = loc.searchParams.get('state');
  check('A4 state present', !!state);

  const cbRes = await auth.handleGoogleCallback(new Request(
    'https://tore.example/auth/google/callback?code=fake-code&state=' + state,
    { headers: { Cookie: stashCookie } },
  ), env);
  check('A5 callback lands on /auth/done', cbRes.status === 302 && cbRes.headers.get('Location') === '/auth/done', cbRes.headers.get('Location'));
  check('A6 callback also sets a session cookie', (cbRes.headers.get('Set-Cookie') || '').includes('tore_session='));

  const st = await auth.loginTicketStatus(env, ticket);
  check('A7 ticket status done with the Google user', st.state === 'done' && st.user.sub === '12345' && st.user.provider === 'google', JSON.stringify(st));
  check('A8 status is one-time', (await auth.loginTicketStatus(env, ticket)).state === 'gone');

  // The poll-minted cookie must authenticate via readSession.
  const loginRes = await auth.ticketLoginResponse(env, st.user);
  const sessCookie = (loginRes.headers.get('Set-Cookie') || '').split(';')[0];
  const me = await auth.readSession(new Request('https://tore.example/', { headers: { Cookie: sessCookie } }), env);
  check('A9 minted cookie reads back as the user', !!me && me.sub === '12345' && me.email === 'unit@example.com', JSON.stringify(me));

  // Failure path: token exchange fails -> done?fail=1 + ticket failed.
  tokenMode = 'fail';
  const ticket2 = (await auth.createLoginTicket(env)).ticket /* U63: returns {ticket, code} */;
  const s2 = await auth.startGoogle(new Request('https://tore.example/auth/google?ticket=' + ticket2), env);
  const loc2 = new URL(s2.headers.get('Location'));
  const cookie2 = (s2.headers.get('Set-Cookie') || '').split(';')[0];
  const cb2 = await auth.handleGoogleCallback(new Request(
    'https://tore.example/auth/google/callback?code=fake&state=' + loc2.searchParams.get('state'),
    { headers: { Cookie: cookie2 } },
  ), env);
  check('A10 failed exchange lands on /auth/done?fail=1', cb2.headers.get('Location') === '/auth/done?fail=1', cb2.headers.get('Location'));
  check('A11 ticket reports failed', (await auth.loginTicketStatus(env, ticket2)).state === 'failed');

  // Plain (ticketless) flow unchanged: callback lands on '/'.
  tokenMode = 'ok';
  const s3 = await auth.startGoogle(new Request('https://tore.example/auth/google'), env);
  const loc3 = new URL(s3.headers.get('Location'));
  const cookie3 = (s3.headers.get('Set-Cookie') || '').split(';')[0];
  const cb3 = await auth.handleGoogleCallback(new Request(
    'https://tore.example/auth/google/callback?code=fake&state=' + loc3.searchParams.get('state'),
    { headers: { Cookie: cookie3 } },
  ), env);
  check('A12 ticketless callback still lands on /', cb3.headers.get('Location') === '/');
} finally {
  globalThis.fetch = realFetch;
}
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
