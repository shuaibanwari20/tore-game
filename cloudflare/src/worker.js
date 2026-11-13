/**
 *   up56 build marker: 30-song playlist (retrigger).
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
 *   GET  /manifest.webmanifest    the PWA manifest, /sw.js the PWA
 *   GET  /sw.js                   service worker, /icons/*.png and
 *   GET  /icons/<name>            /apple-touch-icon.png the app icons
 *   GET  /apple-touch-icon.png    — static files in this repo's
 *                                 cloudflare/ folder, public like the
 *                                 stickers (an install prompt must be
 *                                 able to fetch them without a
 *                                 session). sw.js + the manifest are
 *                                 served no-cache so updates land at
 *                                 once; the icons are edge-cached
 *                                 (PWA_URL overrides the base URL).
 *   GET  /cards/<face>.png        the deck faces + back.png,
 *   GET  /carpets/feltN.jpg       the eleven table-carpet photos,
 *   GET  /carpets/thumbs/feltN.jpg  their picker thumbnails,
 *   GET  /music/c1..c30.jpg       the music player's real song
 *                                 covers (up41), and
 *   GET  /music/m1..m30.mp3       the thirty songs themselves —
 *                                 STREAMED with the client's Range
 *                                 header relayed upstream
 *                                 (serveMusic), never buffered, and
 *   GET  /carpet.jpg              the original carpet — the game's
 *                                 IMAGE files (speed pass 2026-11-11):
 *                                 separate files in this repo's
 *                                 cloudflare/cards|carpets folders,
 *                                 public + edge-cached like the
 *                                 stickers, so the client bundle is
 *                                 code-only and a phone downloads
 *                                 each image once (CARDS_URL /
 *                                 CARPETS_URL override the bases).
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
 * The client bundle is the SAME page the Node build serves, in its
 * Cloudflare flavour (built by ../build-deploy.js +
 * scripts/build-client.mjs → cloudflare/dist-client.html). There is
 * NO KV: the Worker fetches that committed file from this repo's own
 * GitHub raw URL and keeps a copy in the edge cache (Cache API), so
 * publishing a client update is just "rebuild + commit + push". A
 * fetched copy is only served/cached after a completeness check
 * (> CLIENT_MIN_BYTES, ends with </html>) — a failed or truncated
 * fetch serves a short "game is updating" page, never a half page.
 * The upstream fetch is BOUNDED (CLIENT_FETCH_TIMEOUT_MS): a brand-
 * new ?v= URL is cold in every edge POP, and before the up39 fix a
 * stalled GitHub fetch there hung the page response forever (the
 * 2026-11-12 iPhone outage — blank page, stuck loading bar, while
 * warm POPs/Android loaded fine). On any upstream trouble
 * serveClient now falls back, in order, to: the edge copy of the
 * current URL, the version-independent "last-good" edge entry
 * (rewritten on every successful upstream fetch), the previous
 * version's URL (FALLBACK_CLIENT_URL), and only then the 503 page.
 * The source URL is one constant (CLIENT_URL_DEFAULT); the env var
 * CLIENT_URL overrides it (local testing against a static server).
 * Since the speed pass the bundle is CODE-ONLY (~0.8 MB — the images
 * are the separate routes above), and serveClient answers it with a
 * strong ETag derived from the ?v= token: the browser still sends
 * Cache-Control: no-cache (revalidate every load), but a matching
 * If-None-Match now gets a bodyless 304 instead of the whole page.
 */

import * as auth from './auth.js';
import { GameServer } from './game-server.js';
import { gatePage } from './gate-page.js';

export { GameServer };

// bump the ?v= suffix on every client rebuild to bust the edge cache
const CLIENT_URL_DEFAULT =
  'https://raw.githubusercontent.com/shuaibanwari20/tore-game/main/cloudflare/dist-client.html?v=20261113-viewportfit';
// The PREVIOUS client version's URL — last-resort fallback for
// serveClient (see the header comment): that build was live long
// enough that its edge copies are warm in the POPs, so when a fresh
// ?v= URL's first upstream fetch stalls or fails, players still get
// a working game instead of a hung/blank page. (The env var
// FALLBACK_CLIENT_URL overrides it, same pattern as CLIENT_URL.)
const FALLBACK_CLIENT_URL_DEFAULT =
  'https://raw.githubusercontent.com/shuaibanwari20/tore-game/main/cloudflare/dist-client.html?v=20261112-feat2';
const STICKER_URL_BASE_DEFAULT =
  'https://raw.githubusercontent.com/shuaibanwari20/tore-game/main/cloudflare/stickers/';
const COVER_URL_BASE_DEFAULT =
  'https://raw.githubusercontent.com/shuaibanwari20/tore-game/main/cloudflare/covers/';
const PWA_URL_BASE_DEFAULT =
  'https://raw.githubusercontent.com/shuaibanwari20/tore-game/main/cloudflare/';
const CARDS_URL_BASE_DEFAULT =
  'https://raw.githubusercontent.com/shuaibanwari20/tore-game/main/cloudflare/cards/';
const CARPETS_URL_BASE_DEFAULT =
  'https://raw.githubusercontent.com/shuaibanwari20/tore-game/main/cloudflare/carpets/';
const MUSIC_URL_BASE_DEFAULT =
  'https://raw.githubusercontent.com/shuaibanwari20/tore-game/main/cloudflare/music/';
const CLIENT_MIN_BYTES = 500_000; // speed pass: the bundle is code-only now (~0.82 MB; was 13.8 MB with the images inlined)
// Bounds for serveClient's upstream fetches. Worst case for a page
// load when everything upstream stalls: 8s (current URL) + 5s
// (fallback URL) + fast cache lookups — the response ALWAYS
// completes; it can never hang on GitHub again.
const CLIENT_FETCH_TIMEOUT_MS = 8000;
const FALLBACK_FETCH_TIMEOUT_MS = 5000;
// Cache key of the version-independent "last-good" client copy:
// serveClient rewrites it on EVERY successful upstream fetch of the
// current CLIENT_URL, so it always holds the newest client that any
// request has managed to pull — the copy served when a fresh ?v=
// URL's own edge entry is cold AND its upstream fetch fails. The
// .internal host is never fetched; it is only a Cache API key.
const LAST_GOOD_CACHE_URL = 'https://last-good.tore.internal/client';
const CLIENT_CACHE_TTL = 86400; // seconds the EDGE keeps the client copy —
// the browser never gets this TTL: serveClient hands the browser
// `Cache-Control: no-cache` so it revalidates `/` on every load and
// picks up a new build immediately (the edge copy makes that cheap).
// The revalidation is cheap for the browser too: serveClient sends a
// strong ETag (from the ?v= token) and answers If-None-Match with a
// bodyless 304 (speed pass).

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

// The shell's strong ETag derives from the ?v= token of the client
// source URL: every client rebuild bumps ?v= (standing rule), so the
// token IS the bundle version. A URL without ?v= falls back to the
// URL itself. (304 flow added in the speed pass.)
function clientETag(src) {
  const m = /[?&]v=([^&]+)/.exec(src);
  return '"tore-' + (m ? m[1] : encodeURIComponent(src).slice(0, 40)) + '"';
}
function ifNoneMatchHits(request, etag) {
  const inm = request.headers.get('If-None-Match');
  if (!inm) return false;
  return inm.split(',').some((t) => {
    const tag = t.trim().replace(/^W\//, '');
    return tag === '*' || tag === etag;
  });
}

// One BOUNDED upstream fetch of a client bundle, with the standing
// completeness check (> CLIENT_MIN_BYTES, ends with </html>). The
// AbortController covers the WHOLE fetch — headers AND body — so a
// stalled or trickling upstream can never hang the caller: when the
// timer fires, a pending arrayBuffer() rejects and we land in the
// catch. Never throws; returns { buf } on success, { note } (a short
// Persian reason for the 503 page) on any failure.
async function fetchClientCopy(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'tore-game-worker' },
      signal: ctl.signal,
    });
    if (!res.ok) return { buf: null, note: 'HTTP ' + res.status };
    const buf = await res.arrayBuffer();
    const tail = new TextDecoder().decode(buf.slice(-64)).trim();
    if (buf.byteLength > CLIENT_MIN_BYTES && tail.endsWith('</html>')) {
      return { buf, note: 'HTTP ' + res.status };
    }
    return { buf: null, note: 'HTTP ' + res.status + ' — فایل ناقص بود (' + buf.byteLength + ' بایت)' };
  } catch (e) {
    return {
      buf: null,
      note: ctl.signal.aborted
        ? 'گرفتن فایل بازی بیش از حد طول کشید'
        : 'خطای شبکه هنگام گرفتن فایل بازی',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function serveClient(request, env) {
  const src = env.CLIENT_URL || CLIENT_URL_DEFAULT;
  const etag = clientETag(src);
  const fallbackSrc = env.FALLBACK_CLIENT_URL || FALLBACK_CLIENT_URL_DEFAULT;
  const fallbackEtag = clientETag(fallbackSrc);
  const notModified = (tag) => new Response(null, {
    status: 304,
    headers: { 'ETag': tag, 'Cache-Control': 'no-cache' },
  });
  const cacheKey = new Request(src, { method: 'GET' });
  const lastGoodKey = new Request(LAST_GOOD_CACHE_URL, { method: 'GET' });
  const fallbackKey = new Request(fallbackSrc, { method: 'GET' });
  let cache = null;
  try { cache = caches.default; } catch { cache = null; }

  // Serve an EDGE CACHE copy to the browser. `tag` is the ETag of
  // the version the copy actually holds — for the current URL that
  // is `etag`; a fallback copy carries its own, so a browser holding
  // exactly that copy still gets a correct, bodyless 304, and a
  // browser holding a fallback copy is NOT 304'd once the current
  // build is reachable again (its If-None-Match names the fallback's
  // tag, which no longer matches `etag` on the happy path).
  const serveCached = (hit, tag) => {
    // The browser revalidates on every load (no-cache below), but
    // with the ETag that revalidation is free when nothing changed:
    // a matching If-None-Match gets a bodyless 304.
    if (ifNoneMatchHits(request, tag)) return notModified(tag);
    // Re-head the edge copy for the browser: same body/status and
    // Content-Type, but `Cache-Control: no-cache` — the browser must
    // revalidate `/` on every load, so a freshly deployed build is
    // picked up at once instead of being served from the browser's
    // own day-long cache. (The ?v= in the source URL only ever
    // busted THIS edge copy, never the browser's.)
    const headers = new Headers(hit.headers);
    headers.delete('X-Tore-Client-ETag');
    headers.set('Cache-Control', 'no-cache');
    headers.set('ETag', tag);
    return new Response(hit.body, {
      status: hit.status,
      statusText: hit.statusText,
      headers,
    });
  };
  // The copy stored in the edge cache keeps the long TTL (fast,
  // cheap upstream fetches) and remembers — in X-Tore-Client-ETag —
  // which version it holds, so a version-independent reader (the
  // last-good fallback) can still ETag it correctly.
  const edgeCopy = (buf, tag) => new Response(buf, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=' + CLIENT_CACHE_TTL,
      'X-Tore-Client-ETag': tag,
    },
  });
  // Hand a freshly fetched buffer to THIS browser: the response
  // revalidates always — and if this very request already carries
  // the copy's ETag, it needs no body at all.
  const serveFresh = (buf, tag) => {
    if (ifNoneMatchHits(request, tag)) return notModified(tag);
    return new Response(buf, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'ETag': tag,
      },
    });
  };
  const cacheMatch = async (key) => {
    if (!cache) return null;
    try { return await cache.match(key); } catch { return null; }
  };
  const cachePut = async (key, resp) => {
    if (!cache) return;
    try { await cache.put(key, resp); } catch { /* serve anyway */ }
  };

  // Happy path 1: the edge already holds the current client.
  const hit = await cacheMatch(cacheKey);
  if (hit) return serveCached(hit, etag);

  // Happy path 2: pull it from upstream — BOUNDED, so a cold ?v=
  // URL whose GitHub fetch stalls can never hang the page again.
  const fresh = await fetchClientCopy(src, CLIENT_FETCH_TIMEOUT_MS);
  if (fresh.buf) {
    // Cache the copy under its own URL AND as the version-
    // independent last-good entry (rewritten on every successful
    // upstream fetch), then serve it.
    await cachePut(cacheKey, edgeCopy(fresh.buf, etag));
    await cachePut(lastGoodKey, edgeCopy(fresh.buf, etag));
    return serveFresh(fresh.buf, etag);
  }

  // Upstream failed, timed out or sent a truncated file. Fall back
  // to the most recent good client copy instead of hanging/503ing:
  // (a) the edge copy of the CURRENT URL — re-checked here because
  //     the first match may have raced a concurrent request's put
  //     (or transiently failed) while our fetch was in flight;
  const hitAgain = await cacheMatch(cacheKey);
  if (hitAgain) return serveCached(hitAgain, etag);
  // (b) the last-good entry — its stored header says which version
  //     it holds, so it is ETagged as that version;
  const lastGood = await cacheMatch(lastGoodKey);
  if (lastGood) {
    return serveCached(lastGood, lastGood.headers.get('X-Tore-Client-ETag') || etag);
  }
  // (c) the PREVIOUS version's URL: its edge copy if this POP has
  //     one, else one bounded fetch of it (it was live for a day —
  //     in production the fetch is a warm GitHub raw read).
  const fbHit = await cacheMatch(fallbackKey);
  if (fbHit) return serveCached(fbHit, fallbackEtag);
  const fbFresh = await fetchClientCopy(fallbackSrc, FALLBACK_FETCH_TIMEOUT_MS);
  if (fbFresh.buf) {
    await cachePut(fallbackKey, edgeCopy(fbFresh.buf, fallbackEtag));
    return serveFresh(fbFresh.buf, fallbackEtag);
  }
  // (d) Nothing good anywhere — the standing "game is updating"
  //     page, answered promptly with the current URL's failure note.
  return new Response(updatingPage(fresh.note), {
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

// The game IMAGE files (speed pass): deck faces, felt photos and
// their thumbnails, the original carpet. Static files in the repo
// (cloudflare/cards/, cloudflare/carpets/, cloudflare/carpet.jpg),
// served exactly like the stickers/covers — public, edge-cached,
// long browser cache. One generic fetcher: base + repo-relative
// path + content type.
async function serveRepoAsset(env, base, rel, contentType) {
  const src = base + rel;
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
        const file = new Response(buf, {
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=' + CLIENT_CACHE_TTL,
          },
        });
        if (cache) { try { await cache.put(cacheKey, file.clone()); } catch { /* serve anyway */ } }
        return file;
      }
    }
  } catch { /* fall through to 404 */ }
  return new Response('not found', { status: 404 });
}

// The music player's songs (up41): streamed, never buffered —
// the client's Range header is relayed to GitHub Raw (which
// honours it) and the 200/206 response streams straight back
// with the byte headers a media element needs to seek.
async function serveMusic(env, request, name) {
  const src = (env.MUSIC_URL || MUSIC_URL_BASE_DEFAULT) + name;
  const headers = { 'User-Agent': 'tore-game-worker' };
  const range = request.headers.get('Range');
  if (range) headers.Range = range;
  try {
    const res = await fetch(src, { headers });
    if (res.status !== 200 && res.status !== 206) {
      return new Response('not found', { status: 404 });
    }
    const out = new Headers();
    out.set('Content-Type', 'audio/mpeg');
    out.set('Cache-Control', 'public, max-age=' + CLIENT_CACHE_TTL);
    out.set('Accept-Ranges', 'bytes');
    for (const h of ['Content-Length', 'Content-Range']) {
      const v = res.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(res.body, { status: res.status, headers: out });
  } catch { /* fall through to 404 */ }
  return new Response('not found', { status: 404 });
}

// The PWA statics: manifest.webmanifest + sw.js + the app icons,
// static files in the repo (cloudflare/manifest.webmanifest,
// cloudflare/sw.js, cloudflare/icons/*.png,
// cloudflare/apple-touch-icon.png), served from the same raw-URL
// pattern as the stickers — public, no session (the browser fetches
// the manifest and the worker script outside the game's sign-in
// flow). Two serving flavours:
//   - sw.js + manifest: fetched fresh on every request and handed
//     to the browser as no-cache. A service worker whose bytes are
//     stuck in an edge cache for a day ships its fixes a day late,
//     and the file is tiny — freshness beats caching here.
//   - icons: edge-cached with the long TTL like the stickers; the
//     browser also gets the long TTL (icon art changes rarely, and
//     a change ships under a bumped ?v= on the client bundle that
//     references the same stable URLs — acceptable for Phase 0).
async function servePwaText(env, name, contentType) {
  const src = (env.PWA_URL || PWA_URL_BASE_DEFAULT) + name;
  try {
    const res = await fetch(src, { headers: { 'User-Agent': 'tore-game-worker' } });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 0) {
        return new Response(buf, {
          headers: { 'Content-Type': contentType, 'Cache-Control': 'no-cache' },
        });
      }
    }
  } catch { /* fall through to 404 */ }
  return new Response('not found', { status: 404 });
}

async function servePwaIcon(env, name) {
  const src = (env.PWA_URL || PWA_URL_BASE_DEFAULT) + 'icons/' + name;
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
        const png = new Response(buf, {
          headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=' + CLIENT_CACHE_TTL,
          },
        });
        if (cache) { try { await cache.put(cacheKey, png.clone()); } catch { /* serve anyway */ } }
        return png;
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

    if (request.method === 'GET' && path === '/manifest.webmanifest') {
      return servePwaText(env, 'manifest.webmanifest', 'application/manifest+json; charset=utf-8');
    }

    if (request.method === 'GET' && path === '/sw.js') {
      // The service worker script itself: root path = root scope.
      return servePwaText(env, 'sw.js', 'text/javascript; charset=utf-8');
    }

    if (request.method === 'GET' && path.startsWith('/icons/')) {
      // PWA app icons: only the generated set exists.
      const name = path.slice('/icons/'.length);
      if (/^icon-(192|512|512-maskable)\.png$/.test(name)) return servePwaIcon(env, name);
      return new Response('not found', { status: 404 });
    }

    if (request.method === 'GET' && path === '/apple-touch-icon.png') {
      return servePwaText(env, 'apple-touch-icon.png', 'image/png');
    }

    if (path.startsWith('/cards/') && request.method === 'GET') {
      // Deck faces + the back: only the known 53 files exist.
      // Public like the stickers — no session needed to load one.
      const name = path.slice('/cards/'.length);
      if (/^([2-9TJQKA][CDHS]|back)\.png$/.test(name)) {
        return serveRepoAsset(env, env.CARDS_URL || CARDS_URL_BASE_DEFAULT, name, 'image/png');
      }
      return new Response('not found', { status: 404 });
    }

    if (path.startsWith('/carpets/') && request.method === 'GET') {
      // The eleven felt photos and their picker thumbnails.
      const rest = path.slice('/carpets/'.length);
      if (/^(thumbs\/)?felt([1-9]|1[01])\.jpg$/.test(rest)) {
        return serveRepoAsset(env, env.CARPETS_URL || CARPETS_URL_BASE_DEFAULT, rest, 'image/jpeg');
      }
      return new Response('not found', { status: 404 });
    }

    if (path === '/carpet.jpg' && request.method === 'GET') {
      // The original carpet (JS preload legacy path; ASSET-rooted).
      return serveRepoAsset(env, env.PWA_URL || PWA_URL_BASE_DEFAULT, 'carpet.jpg', 'image/jpeg');
    }

    if (path.startsWith('/music/') && request.method === 'GET') {
      // up41 music player files: the songs (m1..m30.mp3, up56) and
      // their own covers (c1..c30.jpg), static repo files like the
      // cards. Covers ride the generic cached fetcher; the songs
      // STREAM with Range relayed upstream (serveMusic) so a
      // phone can seek and the Worker never buffers a whole song.
      const name = path.slice('/music/'.length);
      if (/^c([1-9]|[12][0-9]|30)\.jpg$/.test(name)) {
        return serveRepoAsset(env, env.MUSIC_URL || MUSIC_URL_BASE_DEFAULT, name, 'image/jpeg');
      }
      if (/^m([1-9]|[12][0-9]|30)\.mp3$/.test(name)) return serveMusic(env, request, name);
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

    if (path === '/p-photo' && request.method === 'POST') {
      // A player uploads HIS OWN profile photo (F17). Session
      // rules are exactly the cover route's: with the gate on, no
      // cookie = 401, and the identity the DO trusts comes from
      // the verified session (x-tore-user) — a client-sent
      // x-tore-pid is honoured ONLY with the gate off.
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

    if (path.startsWith('/p-photo/') && request.method === 'GET') {
      // An uploaded profile photo: public read — the ?v=<photoV>
      // query is the cache buster. The DO owns the bytes.
      const rest = path.slice('/p-photo/'.length);
      if (!/^\d{6}\.jpg$/.test(rest)) return new Response('not found', { status: 404 });
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
      return serveClient(request, env);
    }

    return new Response('not found', { status: 404 });
  },
};
