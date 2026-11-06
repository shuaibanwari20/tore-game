/**
 * worker.js — Tore on Cloudflare: HTTP entry point.
 *
 * Routes:
 *   GET  /                        the game client (see below)
 *   GET  /ws                      WebSocket upgrade → GameServer DO
 *   GET  /auth/config             { enabled } — is the sign-in gate on?
 *   GET  /auth/me                 session user JSON, or 401
 *   GET  /auth/google             start Google OAuth (PKCE)
 *   GET  /auth/google/callback    Google OAuth callback
 *   GET  /auth/facebook           start Facebook OAuth
 *   GET  /auth/facebook/callback  Facebook OAuth callback
 *   GET  /auth/logout             clear the session cookie
 *   GET  /privacy                 privacy policy page (for OAuth consent)
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

export { GameServer };

const CLIENT_URL_DEFAULT =
  'https://raw.githubusercontent.com/shuaibanwari20/tore-game/main/cloudflare/dist-client.html';
const CLIENT_MIN_BYTES = 3_000_000; // the real bundle is ~3.1 MB
const CLIENT_CACHE_TTL = 86400; // seconds the edge keeps the client copy

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

async function serveClient(env) {
  const src = env.CLIENT_URL || CLIENT_URL_DEFAULT;
  const cacheKey = new Request(src, { method: 'GET' });
  let cache = null;
  try {
    cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  } catch { cache = null; }

  let note = '';
  try {
    const res = await fetch(src, { headers: { 'User-Agent': 'tore-game-worker' } });
    note = 'HTTP ' + res.status;
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const tail = new TextDecoder().decode(buf.slice(-64)).trim();
      if (buf.byteLength > CLIENT_MIN_BYTES && tail.endsWith('</html>')) {
        const page = new Response(buf, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=' + CLIENT_CACHE_TTL,
          },
        });
        if (cache) { try { await cache.put(cacheKey, page.clone()); } catch { /* serve anyway */ } }
        return page;
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const authEnabled = env.AUTH_ENABLED === '1';

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

    if (path === '/auth/config') {
      return Response.json({ enabled: authEnabled });
    }
    if (path === '/auth/me') {
      const user = await auth.readSession(request, env);
      if (!user) return new Response('unauthorized', { status: 401 });
      return Response.json(user);
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

    if ((path === '/' || path === '/index.html') && request.method === 'GET') {
      return serveClient(env);
    }

    return new Response('not found', { status: 404 });
  },
};
