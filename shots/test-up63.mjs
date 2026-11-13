/** up63 unit proof — the 8-digit sign-in code. TicketStore code
 *  lifecycle (mint, lookup, complete-once, consume/fail cleanup)
 *  plus the REAL auth.js chain for POST /auth/fb-code-complete
 *  with a forged Firebase token (local RSA keypair; securetoken
 *  JWKS stubbed), ending in the same session identity /auth/
 *  firebase mints. The fake GAME stub mirrors the DO contract. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { TicketStore, isTicketId, isTicketCode } from '/home/hatch/workspace/projects/tore-game/cloudflare/src/tickets.js';
import * as auth from '/home/hatch/workspace/projects/tore-game/cloudflare/src/auth.js';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const b64url = (buf) => Buffer.from(buf).toString('base64url');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
jwk.kid = 'testkid63'; jwk.alg = 'RS256'; jwk.use = 'sig';
const NOW = Math.floor(Date.now() / 1000);
function makeToken(overrides = {}) {
  const header = { alg: 'RS256', kid: 'testkid63', typ: 'JWT' };
  const claims = {
    iss: 'https://securetoken.google.com/tore-game', aud: 'tore-game',
    sub: 'uid-123', iat: NOW, exp: NOW + 3600,
    name: 'Unit Test', email: 'unit@example.com', picture: '',
    ...overrides,
  };
  const data = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claims));
  const sig = crypto.sign('sha256', Buffer.from(data), { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING });
  return data + '.' + b64url(sig);
}
globalThis.fetch = async (url) => {
  if (String(url).startsWith('https://www.googleapis.com/service_accounts/v1/jwk/securetoken')) {
    return new Response(JSON.stringify({ keys: [jwk] }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' },
    });
  }
  throw new Error('unexpected fetch ' + url);
};

const backing = new Map();
const storage = {
  get: async (k) => backing.get(k),
  put: async (k, v) => { backing.set(k, v); },
  delete: async (k) => { backing.delete(k); },
};
const store = new TicketStore(storage);
const stub = {
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    const body = await req.json().catch(() => ({}));
    if (path === '/internal/tickets/create') { const r = await store.createWithCode(); return Response.json({ ticket: r.id, code: r.code }); }
    if (path === '/internal/tickets/bycode') return Response.json({ ticket: await store.lookupByCode(body.code) });
    if (path === '/internal/tickets/complete') return Response.json({ ok: !!(body.user) && (await store.complete(body.ticket, body.user)) });
    if (path === '/internal/tickets/fail') return Response.json({ ok: await store.fail(body.ticket) });
    if (path === '/internal/tickets/status') return Response.json(await store.status(body.ticket));
    return new Response('not found', { status: 404 });
  },
};
const env = {
  SESSION_SECRET: 'unit-secret',
  FIREBASE_PROJECT_ID: 'tore-game',
  GAME: { idFromName: () => 'global', get: () => stub },
};
const post = (path, body) => new Request('https://tore.example' + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});

// ---------- TicketStore code lifecycle ----------
const made = await store.createWithCode();
check('K1 createWithCode returns id + 8-digit code', isTicketId(made.id) && isTicketCode(made.code), made.code);
check('K2 lookupByCode resolves the pending ticket', (await store.lookupByCode(made.code)) === made.id);
const probe = made.code === '12345678' ? '87654321' : '12345678';
check('K3 unknown / malformed codes resolve to null',
  (await store.lookupByCode(probe)) === null && (await store.lookupByCode('123')) === null && (await store.lookupByCode('abcdefgh')) === null);
check('K4 isTicketCode format', isTicketCode('12345678') && !isTicketCode('1234567') && !isTicketCode('123456789') && !isTicketCode(12345678));

// ---------- auth.js code chain ----------
const madeAuth = await auth.createLoginTicket(env);
check('A1 createLoginTicket returns {ticket, code}', !!madeAuth && isTicketId(madeAuth.ticket) && isTicketCode(madeAuth.code),
  JSON.stringify(madeAuth));
let r = await auth.handleFirebaseCodeComplete(post('/auth/fb-code-complete', { code: '123', idToken: makeToken() }), env);
check('A2 malformed code -> 400', r.status === 400, 'got ' + r.status);
r = await auth.handleFirebaseCodeComplete(post('/auth/fb-code-complete', { code: probe === madeAuth.code ? '87654321' : probe, idToken: makeToken() }), env);
check('A3 unknown code -> 404', r.status === 404, 'got ' + r.status);
r = await auth.handleFirebaseCodeComplete(post('/auth/fb-code-complete', { code: madeAuth.code, idToken: 'garbage' }), env);
check('A4 real code + garbage token -> 401', r.status === 401, 'got ' + r.status);
check('A5 ticket still pending after the 401', (await store.lookupByCode(madeAuth.code)) === madeAuth.ticket);
r = await auth.handleFirebaseCodeComplete(post('/auth/fb-code-complete', { code: madeAuth.code, idToken: makeToken() }), env);
const rj = await r.json().catch(() => ({}));
check('A6 real code + valid token -> 200 ok', r.status === 200 && rj.ok === true, 'got ' + r.status);
check('A7 completed ticket no longer resolves by code', (await store.lookupByCode(madeAuth.code)) === null);
r = await auth.handleFirebaseCodeComplete(post('/auth/fb-code-complete', { code: madeAuth.code, idToken: makeToken() }), env);
check('A8 same code again -> 404', r.status === 404, 'got ' + r.status);
const st = await auth.loginTicketStatus(env, madeAuth.ticket);
check('A9 status done with the firebase identity', st.state === 'done' && st.user
  && st.user.provider === 'firebase' && st.user.sub === 'uid-123', JSON.stringify(st.user || {}));
check('A10 consume cleared the code alias', !backing.has('code:' + madeAuth.code));
const loginRes = await auth.ticketLoginResponse(env, st.user);
const cookie = (loginRes.headers.get('Set-Cookie') || '').split(';')[0];
const me = await auth.readSession(new Request('https://tore.example/', { headers: { Cookie: cookie } }), env);
check('A11 poll-minted cookie reads back via readSession', !!me && me.provider === 'firebase' && me.sub === 'uid-123');

// ---------- fail path clears the alias ----------
const made2 = await store.createWithCode();
await store.fail(made2.id);
check('F1 failed ticket: code alias gone', (await store.lookupByCode(made2.code)) === null && !backing.has('code:' + made2.code));
check('F2 failed ticket reports failed once', (await store.status(made2.id)).state === 'failed');

// ---------- statics ----------
const workerSrc = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/worker.js', 'utf8');
const gateSrc = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/gate-page.js', 'utf8');
check('S1 worker routes /auth/fb-code-complete', workerSrc.includes("path === '/auth/fb-code-complete'") && workerSrc.includes('handleFirebaseCodeComplete'));
check('S2 fb-code-complete endpoint still routed (gate UI moved to email in U65)', workerSrc.includes("path === '/auth/fb-code-complete'")
  && workerSrc.includes('handleFirebaseCodeComplete'));

console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
