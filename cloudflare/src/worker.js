/**
 * worker.js — Tore on Cloudflare: HTTP entry point.
 *
 * Routes:
 *   GET  /                        the game client (see below). With
 *                                 AUTH_ENABLED=1 and no valid session it
 *                                 answers the STANDALONE GATE PAGE with
 *                                 401 instead (src/gate-page.js) — the
 *                                 bundle is never sent signed-out.
 *   GET  /stickers/stN.gif        the chat GIF stickers (N = 1..16),
 *                                 fetched from this repo's cloudflare/
 *                                 stickers/ folder and edge-cached, the
 *                                 same pattern as the client bundle
 *                                 (STICKERS_URL overrides the base URL
 *                                 for local testing).
 *   GET  /ws                      WebSocket upgrade → GameServer DO
 *   GET  /turn-credentials        TURN credentials for game voice
 *                                 (session required, same check as
 *                                 /ws; credentials never ship in the
 *                                 client — see serveTurnCredentials)
 *   GET  /auth/config             { enabled, fbLive } — gate state
 *   GET  /auth/me                 session user JSON, or 401
 *   GET  /auth/google             start Google OAuth (PKCE)
 *   GET  /auth/google/callback    Google OAuth callback
 *   GET  /auth/facebook           start Facebook OAuth
 *   GET  /auth/facebook/callback  Facebook OAuth callback
 *   POST /auth/firebase           Firebase ID token → session cookie
 *   GET  /auth/logout             clear the session cookie
 *   GET  /privacy                 privacy policy page (for OAuth consent)
 *   GET  /data-deletion           data deletion instructions page (for Facebook)
 *
 * The client bundle is the SAME self-contained page the Node build
 * serves, in its Cloudflare flavour (built by ../build-deploy.js +
 * scripts/build-client.mjs → cloudflare/dist-client.html). There is
 * NO KV: the Worker fetches that committed file from this repo's own
 * GitHub raw URL and keeps a copy in the edge cache (Cache API), so
 * publishing a client update is just "rebuild + commit + push". A
 * fetched copy is only served/cached after a completeness check
 * (> 3,000,000 bytes, ends with </html>) — a failed or truncated
 * fetch serves a short "game is updating" page, never a half page.
 * The source URL is one constant (CLIENT_URL_DEFAULT); the env var
 * CLIENT_URL overrides it (local testing against a static server).
 */

import * as auth from './auth.js';
import { GameServer } from './game-server.js';
import { gatePage } from './gate-page.js';

export { GameServer };

// bump the ?v= suffix on every client rebuild to bust the edge cache
const CLIENT_URL_DEFAULT =
  'https://raw.githubusercontent.com/shuaibanwari20/tore-game/main/cloudflare/dist-client.html?v=20261110-clubexit';
const STICKER_URL_BASE_DEFAULT =
  'https://raw.githubusercontent.com/shuaibanwari20/tore-game/main/cloudflare/stickers/';
const COVER_URL_BASE_DEFAULT =
  'https://raw.githubusercontent.com/shuaibanwari20/tore-game/main/cloudflare/covers/';
const CLIENT_MIN_BYTES = 3_000_000; // the real bundle is ~3.1 MB
const CLIENT_CACHE_TTL = 86400; // seconds the EDGE keeps the client copy —
// the browser never gets this TTL: serveClient hands the browser
// `Cache-Control: no-cache` so it revalidates `/` on every load and
// picks up a new build immediately (the edge copy makes that cheap).

function updatingPage(note) {
  return `<!doctype html>
<html lang="fa" dir="rtl"><meta charset="utf-8">
<title>توره — در حال به‌روزرسانی</title>
<body style="font-family:Tahoma;background:#241a10;color:#f2c14e;text-align:center;padding:3rem 1rem">
<h1>توره</h1>
<p>بازی در حال به‌روزرسانی است؛ یک دقیقهٔ دیگر دوباره تلاش کن.</p>
<p style="opacity:.6;font-size:.85em">${note}</p>
</body></html>`;
}

function privacyPage() {
  return `<!doctype html>
<html lang="fa" dir="rtl"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>حریم خصوصی — بازی توره | Privacy Policy — Tore</title>
<body style="font-family:Tahoma,Arial,sans-serif;background:#1c1410;color:#f5ead6;line-height:1.9;padding:2rem 1.1rem;max-width:640px;margin:0 auto">
<h1 style="color:#f2c14e;font-size:1.35rem">حریم خصوصی — بازی توره</h1>
<p>بازی توره برای ورود از گوگل یا فیسبوک استفاده می‌کند و فقط نام، ایمیل و عکس پروفایل حساب شما را می‌گیرد.</p>
<p>این اطلاعات فقط برای ساخت حساب بازی و نمایش نام و آواتار شما در بازی استفاده می‌شود؛ به هیچ‌کس فروخته یا برای تبلیغات استفاده نمی‌شود.</p>
<p>اطلاعات بازی (اتاق‌ها و امتیازها) روی سرور بازی نگهداری می‌شود. با خروج از حساب (Logout)، نشست شما بسته می‌شود.</p>
<p>برای حذف اطلاعات‌تان ایمیل بزنید: <a href="mailto:shuaibanwari20@gmail.com" style="color:#f2c14e">shuaibanwari20@gmail.com</a></p>
<p style="opacity:.65;font-size:.85em">آخرین به‌روزرسانی: 2026-11-06</p>
<hr style="border:none;border-top:1px solid #4a3826;margin:2rem 0">
<div dir="ltr" lang="en" style="text-align:left">
<h2 style="color:#f2c14e;font-size:1.2rem">Privacy Policy — Tore</h2>
<p>Tore uses Google or Facebook sign-in and receives only your name, email address, and profile picture from your account.</p>
<p>This information is used only to create your game account and to display your name and avatar in the game; it is never sold to anyone or used for advertising.</p>
<p>Game data (rooms and scores) is stored on the game server. Signing out (Logout) ends your session.</p>
<p>To have your information deleted, email: <a href="mailto:shuaibanwari20@gmail.com" style="color:#f2c14e">shuaibanwari20@gmail.com</a></p>
<p style="opacity:.65;font-size:.85em">Last updated: 2026-11-06</p>
</div>
</body></html>`;
}

function dataDeletionPage() {
  return `<!doctype html>
<html lang="fa" dir="rtl"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>حذف اطلاعات — بازی توره | Data Deletion — Tore</title>
<body style="font-family:Tahoma,Arial,sans-serif;background:#1c1410;color:#f5ead6;line-height:1.9;padding:2rem 1.1rem;max-width:640px;margin:0 auto">
<h1 style="color:#f2c14e;font-size:1.35rem">حذف اطلاعات — بازی توره</h1>
<p>اگر می‌خواهید اطلاعاتی که بازی توره از حساب گوگل یا فیسبوک شما گرفته (نام، ایمیل و عکس پروفایل) حذف شود، به این ایمیل پیام بفرستید: <a href="mailto:shuaibanwari20@gmail.com" style="color:#f2c14e">shuaibanwari20@gmail.com</a> — در عنوان بنویسید «حذف اطلاعات توره». اطلاعات شما حداکثر تا ۷ روز پس از درخواست، کامل حذف می‌شود. برای حذف فوری، در بازی دکمهٔ خروج (Logout) نشست شما را همان لحظه می‌بندد.</p>
<p style="opacity:.65;font-size:.85em">آخرین به‌روزرسانی: 2026-11-06</p>
<hr style="border:none;border-top:1px solid #4a3826;margin:2rem 0">
<div dir="ltr" lang="en" style="text-align:left">
<h2 style="color:#f2c14e;font-size:1.2rem">Data Deletion — Tore</h2>
<p>To delete the data the Tore game received from your Google or Facebook account (name, email and profile picture), email <a href="mailto:shuaibanwari20@gmail.com" style="color:#f2c14e">shuaibanwari20@gmail.com</a> with the subject 'Tore data deletion'. Your data will be fully deleted within 7 days of your request. Signing out with the Logout button ends your session immediately.</p>
<p style="opacity:.65;font-size:.85em">Last updated: 2026-11-06</p>
</div>
</body></html>`;
}

async function serveClient(env) {
  const src = env.CLIENT_URL || CLIENT_URL_DEFAULT;
  const cacheKey = new Request(src, { method: 'GET' });
  let cache = null;
  try {
    cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      // Re-head the edge copy for the browser: same body/status and
      // Content-Type, but `Cache-Control: no-cache` — the browser must
      // revalidate `/` on every load, so a freshly deployed build is
      // picked up at once instead of being served from the browser's
      // own day-long cache. (The ?v= in the source URL only ever
      // busted THIS edge copy, never the browser's.)
      const headers = new Headers(hit.headers);
      headers.set('Cache-Control', 'no-cache');
      return new Response(hit.body, {
        status: hit.status,
        statusText: hit.statusText,
        headers,
      });
    }
  } catch { cache = null; }

  let note = '';
  try {
    const res = await fetch(src, { headers: { 'User-Agent': 'tore-game-worker' } });
    note = 'HTTP ' + res.status;
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const tail = new TextDecoder().decode(buf.slice(-64)).trim();
      if (buf.byteLength > CLIENT_MIN_BYTES && tail.endsWith('</html>')) {
        // The copy stored in the edge cache keeps the long TTL (fast,
        // cheap upstream fetches)…
        const edgePage = new Response(buf, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=' + CLIENT_CACHE_TTL,
          },
        });
        if (cache) { try { await cache.put(cacheKey, edgePage); } catch { /* serve anyway */ } }
        // …but the response handed to the browser revalidates always.
        return new Response(buf, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
          },
        });
      }
      note += ' — فایل ناقص بود (' + buf.byteLength + ' بایت)';
    }
  } catch (e) {
    note = 'خطای شبکه هنگام گرفتن فایل بازی';
  }
  return new Response(updatingPage(note), {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function serveSticker(env, name) {
  const src = (env.STICKERS_URL || STICKER_URL_BASE_DEFAULT) + name;
  const cacheKey = new Request(src, { method: 'GET' });
  let cache = null;
  try {
    cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  } catch { cache = null; }

  try {
    const res = await fetch(src, { headers: { 'User-Agent': 'tore-game-worker' } });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 0) {
        const gif = new Response(buf, {
          headers: {
            'Content-Type': 'image/gif',
            'Cache-Control': 'public, max-age=' + CLIENT_CACHE_TTL,
          },
        });
        if (cache) { try { await cache.put(cacheKey, gif.clone()); } catch { /* serve anyway */ } }
        return gif;
      }
    }
  } catch { /* fall through to 404 */ }
  return new Response('not found', { status: 404 });
}

// The club cover gallery: 10 real photo covers, static files in
// the repo (cloudflare/covers/<id>.jpg), served exactly like the
// stickers — public, edge-cached. Uploaded owner covers are NOT
// here: they live in DO storage behind /club-cover/<cid>.
async function serveCover(env, name) {
  const src = (env.COVERS_URL || COVER_URL_BASE_DEFAULT) + name;
  const cacheKey = new Request(src, { method: 'GET' });
  let cache = null;
  try {
    cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  } catch { cache = null; }

  try {
    const res = await fetch(src, { headers: { 'User-Agent': 'tore-game-worker' } });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 0) {
        const jpg = new Response(buf, {
          headers: {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=' + CLIENT_CACHE_TTL,
          },
        });
        if (cache) { try { await cache.put(cacheKey, jpg.clone()); } catch { /* serve anyway */ } }
        return jpg;
      }
    }
  } catch { /* fall through to 404 */ }
  return new Response('not found', { status: 404 });
}

/**
 * Short-lived TURN credentials for game voice, from the game's OWN
 * relay account — a dedicated relay is far stronger than the public
 * demo relay the client also carries as a last resort. The client
 * fetches this before opening voice peers and puts the returned
 * iceServers first in its RTCPeerConnection config.
 *
 * Three providers, first configured wins:
 *  - ExpressTURN (preferred): EXPRESSTURN_USERNAME (var) +
 *    EXPRESSTURN_CREDENTIAL (secret), plus optional
 *    EXPRESSTURN_URLS (var — comma-separated TURN URLs; a built-in
 *    default list around relay1.expressturn.com is used when the
 *    var is unset/empty). ExpressTURN issues LONG-TERM (static)
 *    credentials on a 1,000 GB/month free plan with no card, so
 *    there is NOTHING to fetch upstream: the Worker assembles the
 *    single iceServers entry itself. (Metered's free trial turned
 *    out to be only 500 MB/month — too small — which is why
 *    ExpressTURN wins whenever it is configured.)
 *  - Metered: METERED_CREDENTIALS_URL (var — the workspace's full
 *    credentials-endpoint URL from the Metered dashboard, WITHOUT
 *    the key) + METERED_API_KEY (secret). Metered assigns no
 *    per-app subdomain: the relay host is global.relay.metered.ca
 *    and each workspace gets one credentials URL. The Worker
 *    appends the key (?apiKey= or &apiKey=) and Metered answers a
 *    plain GET with a JSON ARRAY of ice-server entries.
 *  - Cloudflare: TURN_KEY_ID (var) + TURN_API_TOKEN (secret). The
 *    Worker mints credentials with a POST and gets back ONE
 *    iceServers object.
 * The response is NORMALIZED either way to {"iceServers": [...]} —
 * an array, always — so the client consumes exactly one shape.
 * Provider keys are used solely for this server-side call; neither
 * they nor the minted credentials are ever logged.
 */
async function serveTurnCredentials(env) {
  if (env.EXPRESSTURN_USERNAME && env.EXPRESSTURN_CREDENTIAL) {
    return expressTurnCredentials(env);
  }
  if (env.METERED_CREDENTIALS_URL && env.METERED_API_KEY) {
    return meteredTurnCredentials(env);
  }
  if (env.TURN_KEY_ID && env.TURN_API_TOKEN) {
    return cloudflareTurnCredentials(env);
  }
  // TURN not set up on this deployment yet — the client falls back
  // to its built-in STUN + demo-TURN config, so voice still works
  // the way it did before this route existed.
  return Response.json({ error: 'turn_not_configured' }, { status: 503 });
}

// ExpressTURN's relay URLs when EXPRESSTURN_URLS is unset/empty:
// the relay host over UDP + TCP on the standard port, the port-80
// pair, and TLS on 443 (the last is what gets through strict
// carrier NATs/firewalls that only let web traffic out).
const EXPRESSTURN_DEFAULT_URLS = [
  'turn:relay1.expressturn.com:3478',
  'turn:relay1.expressturn.com:3478?transport=tcp',
  'turn:relay1.expressturn.com:80',
  'turn:relay1.expressturn.com:80?transport=tcp',
  'turns:relay1.expressturn.com:443',
];

function expressTurnCredentials(env) {
  // Static (long-term) credentials — no upstream call at all. The
  // credential comes from the secret and is never logged.
  const urls = String(env.EXPRESSTURN_URLS || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  return Response.json(
    {
      iceServers: [
        {
          urls: urls.length ? urls : EXPRESSTURN_DEFAULT_URLS,
          username: env.EXPRESSTURN_USERNAME,
          credential: env.EXPRESSTURN_CREDENTIAL,
        },
      ],
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

async function meteredTurnCredentials(env) {
  // The dashboard URL carries no key; append ours with the right
  // separator for a URL that may already have a query string.
  const base = String(env.METERED_CREDENTIALS_URL);
  const url = base + (base.includes('?') ? '&' : '?') +
    'apiKey=' + encodeURIComponent(env.METERED_API_KEY);
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    return Response.json({ error: 'turn_upstream_failed' }, { status: 502 });
  }
  if (!res.ok) {
    return Response.json({ error: 'turn_upstream_failed' }, { status: 502 });
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    return Response.json({ error: 'turn_upstream_failed' }, { status: 502 });
  }
  if (!Array.isArray(data) || !data.length) {
    return Response.json({ error: 'turn_upstream_failed' }, { status: 502 });
  }
  // Metered's answer already IS the normalized array form.
  return Response.json(
    { iceServers: data },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

async function cloudflareTurnCredentials(env) {
  const keyId = env.TURN_KEY_ID;
  const token = env.TURN_API_TOKEN;
  let res;
  try {
    res = await fetch(
      'https://rtc.live.cloudflare.com/v1/turn/keys/' +
        encodeURIComponent(keyId) + '/credentials/generate',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 86400 }),
      },
    );
  } catch (e) {
    return Response.json({ error: 'turn_upstream_failed' }, { status: 502 });
  }
  if (!res.ok) {
    return Response.json({ error: 'turn_upstream_failed' }, { status: 502 });
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    return Response.json({ error: 'turn_upstream_failed' }, { status: 502 });
  }
  if (!data || !data.iceServers) {
    return Response.json({ error: 'turn_upstream_failed' }, { status: 502 });
  }
  // Wrap Cloudflare's single iceServers object in the normalized
  // array form the route always answers with.
  return Response.json(
    { iceServers: [data.iceServers] },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const authEnabled = env.AUTH_ENABLED === '1';

    if (path.startsWith('/stickers/') && request.method === 'GET') {
      // Chat GIF stickers: only the known set exists (st1…st16). They
      // are public images — no session needed to load one.
      const name = path.slice('/stickers/'.length);
      if (/^st([1-9]|1[0-6])\.gif$/.test(name)) return serveSticker(env, name);
      return new Response('not found', { status: 404 });
    }

    if (path.startsWith('/covers/') && request.method === 'GET') {
      // Club cover gallery photos: only the 10 known ids exist.
      // Public like the stickers — no session needed to load one.
      const name = path.slice('/covers/'.length);
      if (/^(mountains|mosque|caravan|pomegranate|city|carpet|eagle|river|tent|trophy)\.jpg$/.test(name)) return serveCover(env, name);
      return new Response('not found', { status: 404 });
    }

    if (path === '/club-cover' && request.method === 'POST') {
      // A club owner uploads his club's cover photo. The bytes go
      // to the social DO, which stores them under the club id and
      // flips the club record to cover 'custom'. Session rules are
      // exactly the game's: with the gate on, no cookie = 401, and
      // the identity the DO trusts comes from the verified session
      // (x-tore-user) — a client-sent x-tore-pid is honoured ONLY
      // with the gate off (local/dev parity with the Node hosts).
      const user = await auth.readSession(request, env);
      if (authEnabled && !user) {
        return new Response('unauthorized — sign in first', { status: 401 });
      }
      const stub = env.GAME.get(env.GAME.idFromName('global'));
      const headers = new Headers(request.headers);
      if (user) { headers.set('x-tore-user', JSON.stringify(user)); headers.delete('x-tore-pid'); }
      else headers.delete('x-tore-user');
      return stub.fetch(new Request(request, { headers }));
    }

    if (path.startsWith('/club-cover/') && request.method === 'GET') {
      // An uploaded club cover: public read (like the stickers) —
      // the ?v=<coverV> query is the cache buster. The DO owns the
      // bytes; a dissolved club or a gallery switch answers 404.
      const cid = path.slice('/club-cover/'.length);
      if (!/^\d{6}$/.test(cid)) return new Response('not found', { status: 404 });
      const stub = env.GAME.get(env.GAME.idFromName('global'));
      return stub.fetch(request);
    }

    if (path === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected a websocket upgrade', { status: 426 });
      }
      // Verify the session HERE: with the gate on, no cookie = no socket.
      const user = await auth.readSession(request, env);
      if (authEnabled && !user) {
        return new Response('unauthorized — sign in first', { status: 401 });
      }
      const stub = env.GAME.get(env.GAME.idFromName('global'));
      const headers = new Headers(request.headers);
      if (user) headers.set('x-tore-user', JSON.stringify(user));
      else headers.delete('x-tore-user');
      return stub.fetch(new Request(request, { headers }));
    }

    if (path === '/social') {
      // Friends system (ملګري): directory / requests / DMs / lobby
      // invites. Same session gate as /ws, same global DO — the DO
      // keys all social data by the account identity (g:<sub>).
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected a websocket upgrade', { status: 426 });
      }
      const user = await auth.readSession(request, env);
      if (authEnabled && !user) {
        return new Response('unauthorized — sign in first', { status: 401 });
      }
      const stub = env.GAME.get(env.GAME.idFromName('global'));
      const headers = new Headers(request.headers);
      if (user) headers.set('x-tore-user', JSON.stringify(user));
      else headers.delete('x-tore-user');
      return stub.fetch(new Request(request, { headers }));
    }

    if (path === '/turn-credentials') {
      if (request.method !== 'GET') {
        return new Response('method not allowed', { status: 405 });
      }
      // Same session check as /ws: with the gate on, no cookie = no
      // credentials (TURN quota is the game's, not the public's).
      const user = await auth.readSession(request, env);
      if (authEnabled && !user) {
        return new Response('unauthorized — sign in first', { status: 401 });
      }
      return serveTurnCredentials(env);
    }

    if (path === '/auth/config') {
      // fbLive tells the client gate whether to offer the Facebook
      // button at all: the FB app stays in Development mode (only app
      // roles/testers could sign in) until it passes review, so the
      // button is hidden unless FB_LIVE is exactly "1". The /auth/
      // facebook routes below stay live either way; Google sign-in
      // never depends on the FB_* secrets.
      return Response.json({ enabled: authEnabled, fbLive: env.FB_LIVE === '1' });
    }
    if (path === '/auth/me') {
      const user = await auth.readSession(request, env);
      if (!user) return new Response('unauthorized', { status: 401 });
      return Response.json(user);
    }
    if (path === '/auth/firebase') {
      // The gate POSTs a Firebase ID token here; auth.js verifies it
      // against Google's securetoken JWKS and mints the session cookie.
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      return auth.handleFirebaseToken(request, env);
    }
    if (path === '/auth/google') return auth.startGoogle(request, env);
    if (path === '/auth/google/callback') return auth.handleGoogleCallback(request, env);
    if (path === '/auth/facebook') return auth.startFacebook(request, env);
    if (path === '/auth/facebook/callback') return auth.handleFacebookCallback(request, env);
    if (path === '/auth/logout') return auth.logout();

    if (path === '/privacy') {
      return new Response(privacyPage(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (path === '/data-deletion') {
      return new Response(dataDeletionPage(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if ((path === '/' || path === '/index.html') && request.method === 'GET') {
      // Gate FIRST: with auth on, a request without a valid session
      // gets the standalone sign-in page (401) — the game bundle is
      // never sent to an unauthenticated browser, so the main menu
      // can never flash behind a late gate. Authenticated requests
      // fall through to the bundle as always.
      if (authEnabled) {
        const user = await auth.readSession(request, env);
        if (!user) {
          return new Response(gatePage(), {
            status: 401,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            },
          });
        }
      }
      return serveClient(env);
    }

    return new Response('not found', { status: 404 });
  },
};
