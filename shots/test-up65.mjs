/** up65 unit proof — email + 6-digit code sign-in.
 *  OtpStore/IdMap lifecycles over in-memory storage, then the
 *  REAL auth.js handlers with Brevo stubbed at fetch level (the
 *  code is captured from the outgoing email body) and a forged
 *  Firebase token for the identity-bridge checks: whichever door
 *  a person uses FIRST sets their canonical sub, and the other
 *  door adopts it — one wallet, one club, one identity. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { OtpStore, IdMap, emailDerivedSub } from '/home/hatch/workspace/projects/tore-game/cloudflare/src/otp.js';
import * as auth from '/home/hatch/workspace/projects/tore-game/cloudflare/src/auth.js';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const b64url = (buf) => Buffer.from(buf).toString('base64url');

// ---- forged Firebase token machinery (as in test-up61) ----
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
jwk.kid = 'testkid65'; jwk.alg = 'RS256'; jwk.use = 'sig';
const NOW = Math.floor(Date.now() / 1000);
function makeToken(email, sub) {
  const header = { alg: 'RS256', kid: 'testkid65', typ: 'JWT' };
  const claims = {
    iss: 'https://securetoken.google.com/tore-game', aud: 'tore-game',
    sub, iat: NOW, exp: NOW + 3600, name: 'Unit Test', email, picture: '',
  };
  const data = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claims));
  const sig = crypto.sign('sha256', Buffer.from(data), { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING });
  return data + '.' + b64url(sig);
}

// ---- fetch: JWKS + Brevo capture ----
let brevoCode = null;
let brevoTo = null;
let brevoFail = false;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://www.googleapis.com/service_accounts/v1/jwk/securetoken')) {
    return new Response(JSON.stringify({ keys: [jwk] }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' },
    });
  }
  if (u.startsWith('https://api.brevo.com/')) {
    if (brevoFail) return new Response('nope', { status: 401 });
    const body = JSON.parse(init.body);
    brevoTo = body.to[0].email;
    const m = /(\d{6})/.exec(body.textContent);
    brevoCode = m ? m[1] : null;
    return new Response('{}', { status: 201, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error('unexpected fetch ' + u);
};

// ---- DO stub over the real stores ----
const backing = new Map();
const storage = {
  get: async (k) => backing.get(k),
  put: async (k, v) => { backing.set(k, v); },
  delete: async (k) => { backing.delete(k); },
};
const otp = new OtpStore(storage);
const idmap = new IdMap(storage);
const stub = {
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    const body = await req.json().catch(() => ({}));
    const email = body.email || '';
    if (path === '/internal/authkv/otp-start') return Response.json(await otp.start(email));
    if (path === '/internal/authkv/otp-clear') { await otp.clear(email); return Response.json({ ok: true }); }
    if (path === '/internal/authkv/otp-verify') return Response.json({ result: await otp.verify(email, body.code) });
    if (path === '/internal/authkv/idmap-get') return Response.json({ sub: await idmap.get(email) });
    if (path === '/internal/authkv/idmap-set') return Response.json({ sub: await idmap.setIfAbsent(email, body.sub) });
    return new Response('not found', { status: 404 });
  },
};
const env = {
  SESSION_SECRET: 'unit-secret',
  BREVO_API_KEY: 'test-key',
  FIREBASE_PROJECT_ID: 'tore-game',
  GAME: { idFromName: () => 'global', get: () => stub },
};
const post = (path, body) => new Request('https://tore.example' + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});
const sessionOf = async (res) => {
  const cookie = (res.headers.get('Set-Cookie') || '').split(';')[0];
  if (!cookie) return null;
  return auth.readSession(new Request('https://tore.example/', { headers: { Cookie: cookie } }), env);
};

// ---------- OtpStore lifecycle ----------
{
  const st = await otp.start('a@b.co');
  check('P1 start mints a 6-digit code', st.ok === true && /^[0-9]{6}$/.test(st.code), st.code);
  check('P2 wrong code -> bad', (await otp.verify('a@b.co', st.code === '000000' ? '111111' : '000000')) === 'bad');
  const again = await otp.start('a@b.co');
  check('P3 resend inside 60 s -> cooldown, first code stays', again.ok === false && again.reason === 'cooldown');
  check('P4 first code still verifies -> ok', (await otp.verify('a@b.co', st.code)) === 'ok');
  check('P5 consumed code -> gone', (await otp.verify('a@b.co', st.code)) === 'gone');
}
{
  const st = await otp.start('c@d.co');
  let last = '';
  for (let i = 0; i < 5; i++) last = await otp.verify('c@d.co', '999999' === st.code ? '111111' : '999999');
  check('P6 five wrong tries -> locked', last === 'locked', last);
  check('P7 locked code is dead even for the right code', (await otp.verify('c@d.co', st.code)) === 'gone');
}
{
  const st = await otp.start('e@f.co');
  const rec = backing.get('otp:e@f.co');
  rec.exp = Date.now() - 1000;
  backing.set('otp:e@f.co', rec);
  check('P8 expired code -> gone', (await otp.verify('e@f.co', st.code)) === 'gone');
}

// ---------- IdMap ----------
check('M1 first writer wins', (await idmap.setIfAbsent('x@y.co', 'uid-1')) === 'uid-1'
  && (await idmap.setIfAbsent('x@y.co', 'uid-2')) === 'uid-1'
  && (await idmap.get('x@y.co')) === 'uid-1');

// ---------- handlers: email flow ----------
{
  let r = await auth.handleEmailStart(post('/auth/email-start', { email: 'not-an-email' }), env);
  check('E1 bad email -> 400', r.status === 400, 'got ' + r.status);
  r = await auth.handleEmailStart(post('/auth/email-start', { email: 'unit@example.com' }), { ...env, BREVO_API_KEY: '' });
  check('E2 no mailer key -> 503', r.status === 503, 'got ' + r.status);
  brevoCode = null;
  r = await auth.handleEmailStart(post('/auth/email-start', { email: 'Unit@Example.com' }), env);
  check('E3 start ok, code emailed to the normalized address', r.status === 200 && brevoTo === 'unit@example.com' && /^[0-9]{6}$/.test(brevoCode || ''), brevoTo + ' / ' + brevoCode);
  r = await auth.handleEmailVerify(post('/auth/email-verify', { email: 'unit@example.com', code: '12345' }), env);
  check('E4 short code -> 400', r.status === 400, 'got ' + r.status);
  r = await auth.handleEmailVerify(post('/auth/email-verify', { email: 'unit@example.com', code: brevoCode === '000000' ? '111111' : '000000' }), env);
  check('E5 wrong code -> 401', r.status === 401, 'got ' + r.status);
  r = await auth.handleEmailVerify(post('/auth/email-verify', { email: 'unit@example.com', code: brevoCode }), env);
  const me = await sessionOf(r);
  const derived = await emailDerivedSub('unit@example.com');
  check('E6 right code -> session, provider email, derived sub', r.status === 200 && !!me && me.provider === 'email' && me.sub === derived,
    me ? me.sub + ' vs ' + derived : 'no session');
}
{
  brevoFail = true;
  const r = await auth.handleEmailStart(post('/auth/email-start', { email: 'fail@example.com' }), env);
  check('E7 mailer refusal -> 502', r.status === 502, 'got ' + r.status);
  const v = await auth.handleEmailVerify(post('/auth/email-verify', { email: 'fail@example.com', code: '123456' }), env);
  check('E8 the unsent code was cleared -> 410', v.status === 410, 'got ' + v.status);
  brevoFail = false;
}

// ---------- the identity bridge ----------
{
  // Google first: the Firebase UID becomes canonical…
  let r = await auth.handleFirebaseToken(post('/auth/firebase', { idToken: makeToken('bridge@example.com', 'uid-123') }), env);
  let me = await sessionOf(r);
  check('C1 firebase sign-in keeps its uid', r.status === 200 && !!me && me.sub === 'uid-123', me && me.sub);
  // …and the email door adopts it for the same address.
  brevoCode = null;
  await auth.handleEmailStart(post('/auth/email-start', { email: 'bridge@example.com' }), env);
  r = await auth.handleEmailVerify(post('/auth/email-verify', { email: 'bridge@example.com', code: brevoCode }), env);
  me = await sessionOf(r);
  check('C2 email sign-in adopts the firebase identity', r.status === 200 && !!me && me.sub === 'uid-123' && me.provider === 'email', me && me.sub);
}
{
  // Email first: the derived sub becomes canonical…
  brevoCode = null;
  await auth.handleEmailStart(post('/auth/email-start', { email: 'first@example.com' }), env);
  let r = await auth.handleEmailVerify(post('/auth/email-verify', { email: 'first@example.com', code: brevoCode }), env);
  let me = await sessionOf(r);
  const derived = await emailDerivedSub('first@example.com');
  check('C3 email-first identity is the derived sub', !!me && me.sub === derived, me && me.sub);
  // …and a later Google sign-in lands on the SAME identity.
  r = await auth.handleFirebaseToken(post('/auth/firebase', { idToken: makeToken('first@example.com', 'uid-999') }), env);
  me = await sessionOf(r);
  check('C4 later firebase sign-in adopts the email identity', r.status === 200 && !!me && me.sub === derived, me && me.sub);
}

// ---------- statics ----------
const workerSrc = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/worker.js', 'utf8');
const gateSrc = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/gate-page.js', 'utf8');
check('S1 worker still routes the (dormant) OTP endpoints', workerSrc.includes("path === '/auth/email-start'")
  && workerSrc.includes("path === '/auth/email-verify'"));
check('S2 gate carries the email form again (U70 restored it)', gateSrc.includes('gate-email')
  && gateSrc.includes("'/auth/email-verify'") && !gateSrc.includes('gate-codebox') && !gateSrc.includes('btn-codehave'));

console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
