/** up61 unit proof — the Firebase bridge for the installed app.
 *  A forged Firebase ID token (local RSA keypair; the securetoken
 *  JWKS endpoint is stubbed to serve the matching public key) runs
 *  through the REAL auth.js verifier into POST /auth/fb-complete,
 *  completes a real ticket in a Map-backed TicketStore (via a fake
 *  env.GAME stub mirroring the DO contract), and the resulting
 *  session must read back through readSession with the SAME
 *  identity /auth/firebase mints. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { TicketStore, isTicketId } from '/home/hatch/workspace/projects/tore-game/cloudflare/src/tickets.js';
import * as auth from '/home/hatch/workspace/projects/tore-game/cloudflare/src/auth.js';
import { fbPage } from '/home/hatch/workspace/projects/tore-game/cloudflare/src/fb-page.js';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const b64url = (buf) => Buffer.from(buf).toString('base64url');

// ---------- RSA keypair + forged-token factory ----------
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
jwk.kid = 'testkid61'; jwk.alg = 'RS256'; jwk.use = 'sig';
const NOW = Math.floor(Date.now() / 1000);
function makeToken(overrides = {}, key = privateKey, kid = 'testkid61') {
  const header = { alg: 'RS256', kid, typ: 'JWT' };
  const claims = {
    iss: 'https://securetoken.google.com/tore-game', aud: 'tore-game',
    sub: 'uid-123', iat: NOW, exp: NOW + 3600,
    name: 'Unit Test', email: 'unit@example.com', picture: '',
    ...overrides,
  };
  const data = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claims));
  const sig = crypto.sign('sha256', Buffer.from(data), { key, padding: crypto.constants.RSA_PKCS1_PADDING });
  return data + '.' + b64url(sig);
}

// ---------- fetch stub: only the securetoken JWKS ----------
globalThis.fetch = async (url) => {
  if (String(url).startsWith('https://www.googleapis.com/service_accounts/v1/jwk/securetoken')) {
    return new Response(JSON.stringify({ keys: [jwk] }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' },
    });
  }
  throw new Error('unexpected fetch ' + url);
};

// ---------- TicketStore over a Map + fake GAME stub ----------
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
    if (path === '/internal/tickets/create') return Response.json({ ticket: await store.create() });
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

// ---------- static page / route checks ----------
const validTicket = 'a'.repeat(32);
const page = fbPage(validTicket);
check('S1 fb page embeds ticket + Firebase redirect flow', page.includes(validTicket)
  && page.includes('firebase-auth-compat.js') && page.includes('signInWithRedirect')
  && page.includes('getRedirectResult') && page.includes('/auth/fb-complete')
  && page.includes('onAuthStateChanged') && page.includes('tore.fb.sent'));
const badPage = fbPage('garbage!!');
check('S2 fb page with a bad ticket embeds none', !/[a-f0-9]{32}/.test(badPage.split('TICKET = ')[1].split(';')[0])
  && badPage.includes('سمه نه ده'));
const workerSrc = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/worker.js', 'utf8');
check('S3 worker routes /auth/fb + /auth/fb-complete', workerSrc.includes("path === '/auth/fb'")
  && workerSrc.includes("path === '/auth/fb-complete'") && workerSrc.includes('fbPage'));
const gateSrc = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/gate-page.js', 'utf8');
check('S4 gate opens /auth/fb, not /auth/google', gateSrc.includes("'/auth/fb?ticket='") && !gateSrc.includes("'/auth/google?ticket='"));

// ---------- fb-complete behaviour ----------
let r = await auth.handleFirebaseTicketComplete(post('/auth/fb-complete', { ticket: 'nope', idToken: makeToken() }), env);
check('B1 bad ticket format -> 400', r.status === 400, 'got ' + r.status);
r = await auth.handleFirebaseTicketComplete(post('/auth/fb-complete', { ticket: validTicket, idToken: 'garbage' }), env);
check('B2 garbage token -> 401', r.status === 401, 'got ' + r.status);
r = await auth.handleFirebaseTicketComplete(post('/auth/fb-complete', { ticket: validTicket, idToken: makeToken({ aud: 'other-proj' }) }), env);
check('B3 wrong aud -> 401', r.status === 401, 'got ' + r.status);
r = await auth.handleFirebaseTicketComplete(post('/auth/fb-complete', { ticket: validTicket, idToken: makeToken({ iss: 'https://securetoken.google.com/other' }) }), env);
check('B4 wrong iss -> 401', r.status === 401, 'got ' + r.status);
r = await auth.handleFirebaseTicketComplete(post('/auth/fb-complete', { ticket: validTicket, idToken: makeToken({ iat: NOW - 7200, exp: NOW - 3600 }) }), env);
check('B5 expired token -> 401', r.status === 401, 'got ' + r.status);
r = await auth.handleFirebaseTicketComplete(post('/auth/fb-complete', { ticket: validTicket, idToken: makeToken({}, other.privateKey) }), env);
check('B6 wrong signing key -> 401', r.status === 401, 'got ' + r.status);
r = await auth.handleFirebaseTicketComplete(post('/auth/fb-complete', { ticket: validTicket, idToken: makeToken() }), env);
check('B7 valid token + unknown ticket -> 409', r.status === 409, 'got ' + r.status);

const ticket = await auth.createLoginTicket(env);
check('B8a create returns a ticket', isTicketId(ticket), ticket);
r = await auth.handleFirebaseTicketComplete(post('/auth/fb-complete', { ticket, idToken: makeToken() }), env);
const rj = await r.json().catch(() => ({}));
check('B8 valid token + real ticket -> 200 ok', r.status === 200 && rj.ok === true, 'got ' + r.status);
r = await auth.handleFirebaseTicketComplete(post('/auth/fb-complete', { ticket, idToken: makeToken() }), env);
check('B9 second complete of same ticket -> 409', r.status === 409, 'got ' + r.status);
const st = await auth.loginTicketStatus(env, ticket);
check('B10 status done with the firebase identity', st.state === 'done' && st.user
  && st.user.provider === 'firebase' && st.user.sub === 'uid-123'
  && st.user.name === 'Unit Test' && st.user.email === 'unit@example.com',
  JSON.stringify(st.user || {}));
const loginRes = await auth.ticketLoginResponse(env, st.user);
const cookie = (loginRes.headers.get('Set-Cookie') || '').split(';')[0];
const meReq = new Request('https://tore.example/', { headers: { Cookie: cookie } });
const me = await auth.readSession(meReq, env);
check('B11 poll-minted cookie reads back via readSession', !!me && me.provider === 'firebase' && me.sub === 'uid-123',
  JSON.stringify(me || {}));
check('B12 done ticket consumed by the status read', (await auth.loginTicketStatus(env, ticket)).state === 'gone');

// ---------- regression: /auth/firebase mints the SAME identity ----------
r = await auth.handleFirebaseToken(post('/auth/firebase', { idToken: makeToken() }), env);
const fbCookie = (r.headers.get('Set-Cookie') || '').split(';')[0];
const me2 = await auth.readSession(new Request('https://tore.example/', { headers: { Cookie: fbCookie } }), env);
check('R1 /auth/firebase identity == bridge identity', r.status === 200 && !!me2
  && me2.provider === (me && me.provider) && me2.sub === (me && me.sub), JSON.stringify(me2 || {}));

console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
