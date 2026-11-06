/**
 * auth.js — Google / Facebook OAuth2 (authorization-code) + signed
 * session cookies for the Tore Worker.
 *
 * Secrets come from the Worker environment (wrangler secrets in
 * production, .dev.vars locally — never committed):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
 *   FB_APP_ID, FB_APP_SECRET, SESSION_SECRET
 *
 * Redirect URIs are derived from the request origin, so the SAME code
 * works on localhost, workers.dev and a future custom domain. Register
 * exactly these two in the provider consoles:
 *   https://<domain>/auth/google/callback
 *   https://<domain>/auth/facebook/callback
 *
 * Session = `<b64url(json)>.<b64url(HMAC-SHA256(json))>` in an HttpOnly
 * cookie; the payload is { provider, sub, name, email, picture, exp }.
 * The id_token returned by Google's token endpoint is accepted because
 * it arrives over a direct TLS connection in answer to a request
 * authenticated with our client secret; its iss/aud/exp claims are
 * still validated below.
 */

const SESSION_COOKIE = 'tore_session';
const OAUTH_COOKIE = 'tore_oauth';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
const OAUTH_TTL_MS = 10 * 60 * 1000;          // 10 minutes to finish login

const te = new TextEncoder();
const td = new TextDecoder();

function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signValue(obj, secret) {
  const body = b64urlEncode(te.encode(JSON.stringify(obj)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, te.encode(body));
  return body + '.' + b64urlEncode(new Uint8Array(sig));
}

async function verifyValue(value, secret) {
  if (!value || !secret) return null;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const body = value.slice(0, dot);
  let sig;
  try { sig = b64urlDecode(value.slice(dot + 1)); } catch { return null; }
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify('HMAC', key, sig, te.encode(body)).catch(() => false);
  if (!ok) return null;
  try {
    const obj = JSON.parse(td.decode(b64urlDecode(body)));
    if (obj.exp && Date.now() > obj.exp) return null;
    return obj;
  } catch { return null; }
}

function parseCookies(request) {
  const out = {};
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function cookieHeader(name, value, maxAgeSec, path = '/') {
  return `${name}=${value}; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

/** The logged-in user from the request's session cookie, or null. */
export async function readSession(request, env) {
  if (!env.SESSION_SECRET) return null;
  const cookies = parseCookies(request);
  const s = await verifyValue(cookies[SESSION_COOKIE], env.SESSION_SECRET);
  if (!s || !s.provider || !s.sub) return null;
  return { provider: s.provider, sub: s.sub, name: s.name || '', email: s.email || '', picture: s.picture || '' };
}

async function startOAuth(request, env, provider) {
  const isGoogle = provider === 'google';
  const clientId = isGoogle ? env.GOOGLE_CLIENT_ID : env.FB_APP_ID;
  if (!clientId || !env.SESSION_SECRET) {
    return new Response(provider + ' sign-in is not configured on this server', { status: 500 });
  }
  const origin = new URL(request.url).origin;
  const redirectUri = origin + '/auth/' + provider + '/callback';
  const state = randomHex(16);
  const stash = { state, provider, exp: Date.now() + OAUTH_TTL_MS };
  let authUrl;
  if (isGoogle) {
    // PKCE (S256) on top of the plain code flow.
    const verifier = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest('SHA-256', te.encode(verifier));
    stash.verifier = verifier;
    authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: b64urlEncode(new Uint8Array(digest)),
      code_challenge_method: 'S256',
      access_type: 'online',
      prompt: 'select_account',
    });
  } else {
    authUrl = new URL('https://www.facebook.com/v19.0/dialog/oauth');
    authUrl.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'email,public_profile',
      state,
    });
  }
  const stashCookie = await signValue(stash, env.SESSION_SECRET);
  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      'Set-Cookie': cookieHeader(OAUTH_COOKIE, stashCookie, OAUTH_TTL_MS / 1000, '/auth'),
    },
  });
}

function failRedirect() {
  return new Response(null, { status: 302, headers: { Location: '/?auth_error=1' } });
}

async function readStash(request, env, provider, stateParam) {
  const cookies = parseCookies(request);
  const stash = await verifyValue(cookies[OAUTH_COOKIE], env.SESSION_SECRET);
  if (!stash || stash.provider !== provider || !stateParam || stash.state !== stateParam) return null;
  return stash;
}

async function finishLogin(env, sessionPayload) {
  const value = await signValue({ ...sessionPayload, exp: Date.now() + SESSION_TTL_MS }, env.SESSION_SECRET);
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/',
      'Set-Cookie': cookieHeader(SESSION_COOKIE, value, SESSION_TTL_MS / 1000),
    },
  });
}

async function callbackGoogle(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return failRedirect();
  const stash = await readStash(request, env, 'google', url.searchParams.get('state'));
  if (!stash || !stash.verifier) return failRedirect();
  const redirectUri = url.origin + '/auth/google/callback';
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: stash.verifier,
    }),
  });
  if (!tokenRes.ok) return failRedirect();
  const tokens = await tokenRes.json();
  if (!tokens.id_token) return failRedirect();
  let claims;
  try {
    claims = JSON.parse(td.decode(b64urlDecode(tokens.id_token.split('.')[1])));
  } catch { return failRedirect(); }
  const issOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  if (!issOk || claims.aud !== env.GOOGLE_CLIENT_ID || !claims.exp || Date.now() > claims.exp * 1000) {
    return failRedirect();
  }
  return finishLogin(env, {
    provider: 'google',
    sub: String(claims.sub || ''),
    name: claims.name || '',
    email: claims.email || '',
    picture: claims.picture || '',
  });
}

async function callbackFacebook(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code || !env.FB_APP_ID || !env.FB_APP_SECRET) return failRedirect();
  const stash = await readStash(request, env, 'facebook', url.searchParams.get('state'));
  if (!stash) return failRedirect();
  const redirectUri = url.origin + '/auth/facebook/callback';
  const tokenUrl = new URL('https://graph.facebook.com/v19.0/oauth/access_token');
  tokenUrl.search = new URLSearchParams({
    client_id: env.FB_APP_ID,
    client_secret: env.FB_APP_SECRET,
    redirect_uri: redirectUri,
    code,
  });
  const tokenRes = await fetch(tokenUrl);
  if (!tokenRes.ok) return failRedirect();
  const tokens = await tokenRes.json();
  if (!tokens.access_token) return failRedirect();
  const meUrl = new URL('https://graph.facebook.com/me');
  meUrl.search = new URLSearchParams({
    fields: 'id,name,email,picture.type(large)',
    access_token: tokens.access_token,
  });
  const meRes = await fetch(meUrl);
  if (!meRes.ok) return failRedirect();
  const me = await meRes.json();
  if (!me.id) return failRedirect();
  return finishLogin(env, {
    provider: 'facebook',
    sub: String(me.id),
    name: me.name || '',
    email: me.email || '',
    picture: (me.picture && me.picture.data && me.picture.data.url) || '',
  });
}

export function startGoogle(request, env) { return startOAuth(request, env, 'google'); }
export function startFacebook(request, env) { return startOAuth(request, env, 'facebook'); }
export function handleGoogleCallback(request, env) { return callbackGoogle(request, env); }
export function handleFacebookCallback(request, env) { return callbackFacebook(request, env); }

export function logout() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/',
      'Set-Cookie': cookieHeader(SESSION_COOKIE, '', 0),
    },
  });
}
