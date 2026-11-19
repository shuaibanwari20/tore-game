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
 *   GET  /auth/me                 session user JSON (+ isAdmin), or 401
 *   GET  /admin/player?id=        admin only: a player's balances
 *   POST /admin/grant             admin only: grant/deduct coins|gems
 *   GET  /admin/grants            admin only: recent admin grants
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
import { emailFinishPage } from './email-finish-page.js';
import { fbPage } from './fb-page.js';
import { adminPage } from './admin-page.js';

export { GameServer };

// bump the ?v= suffix on every client rebuild to bust the edge cache
const CLIENT_URL_DEFAULT =
  'https://raw.githubusercontent.com/shuaibanwari20/tore-game/main/cloudflare/dist-client.html?v=20261119-acct1';
// The PREVIOUS client version's URL — last-resort fallback for
// serveClient (see the header comment): that build was live long
// enough that its edge copies are warm in the POPs, so when a fresh
// ?v= URL's first upstream fetch stalls or fails, players still get
// a working game instead of a hung/blank page. (The env var
// FALLBACK_CLIENT_URL overrides it, same pattern as CLIENT_URL.)
const FALLBACK_CLIENT_URL_DEFAULT =
  'https://raw.githubusercontent.com/shuaibanwari20/tore-game/main/cloudflare/dist-client.html?v=20261113-viewportfit';
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
<title>52 Online — در حال به‌روزرسانی</title>
<body style="font-family:Tahoma;background:#241a10;color:#f2c14e;text-align:center;padding:3rem 1rem">
<h1 dir="ltr">52 Online</h1>
<p>بازی در حال به‌روزرسانی است؛ یک دقیقهٔ دیگر دوباره تلاش کن.</p>
<p style="opacity:.6;font-size:.85em">${note}</p>
</body></html>`;
}

function authDonePage() {
  // U60: where the Safari-side Google flow lands after completing a
  // login ticket for the installed app. Static + trilingual; the
  // tiny script swaps in the failure text on ?fail=1.
  // U75 (2026-11-14, owner order): the success view must not park
  // the player — it tries to close this browser tab at once (the
  // app underneath is already signed in via the gate's poll) and
  // otherwise bounces straight into the game; a big return
  // button covers the manual case.
  return `<!doctype html>
<html lang="ps" dir="rtl"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>52 Online — ننوتل</title>
<body style="font-family:Tahoma,Arial,sans-serif;background:#4a0727;color:#fdf3e3;text-align:center;padding:3rem 1.2rem;margin:0">
<div id="done-ok">
<div style="font-size:64px;line-height:1">✅</div>
<h1 style="color:#ffd75e;font-size:1.5rem;margin:.8rem 0 .4rem">ننوتل بشپړ شول</h1>
<p>اپ ته ستنېږې…</p>
<p lang="fa">در حال برگشت به برنامه…</p>
<p dir="ltr" lang="en" style="opacity:.8;font-size:.9em">You are signed in — returning to the app…</p>
<a href="/" style="display:inline-block;margin-top:1.1rem;padding:.85rem 2.2rem;border-radius:999px;background:linear-gradient(180deg,#ffd968,#f5a623);color:#4a0727;font-weight:900;font-size:1.1rem;text-decoration:none">🎮 لوبې ته وګرځه</a>
</div>
<div id="done-fail" style="display:none">
<div style="font-size:64px;line-height:1">⚠️</div>
<h1 style="color:#ffd75e;font-size:1.5rem;margin:.8rem 0 .4rem">ننوتل ونه شول</h1>
<p>بېرته اپ ته راشئ او بیا هڅه وکړئ.</p>
<p lang="fa">ورود ناموفق بود — به برنامه برگردید و دوباره تلاش کنید.</p>
<p dir="ltr" lang="en" style="opacity:.8;font-size:.9em">Sign-in did not complete. Go back to the app and try again.</p>
<a href="/" style="display:inline-block;margin-top:1.1rem;padding:.85rem 2.2rem;border-radius:999px;background:linear-gradient(180deg,#ffd968,#f5a623);color:#4a0727;font-weight:900;font-size:1.1rem;text-decoration:none">🎮 لوبې ته وګرځه</a>
</div>
<script>
if (new URLSearchParams(location.search).get('fail')) {
  document.getElementById('done-ok').style.display = 'none';
  document.getElementById('done-fail').style.display = '';
} else {
  // U75: never park the player on this page — close this browser
  // tab if the browser allows it (the app underneath is already
  // signed in), otherwise bounce straight into the game.
  setTimeout(function () { try { window.close(); } catch (e) {} }, 350);
  setTimeout(function () { location.replace('/'); }, 1500);
}
</script>
</body></html>`;
}

function privacyPage() {
  return `<!doctype html>
<html lang="fa" dir="rtl"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>حریم خصوصی — بازی 52 Online | Privacy Policy — 52 Online</title>
<body style="font-family:Tahoma,Arial,sans-serif;background:#1c1410;color:#f5ead6;line-height:1.9;padding:2rem 1.1rem;max-width:640px;margin:0 auto">
<h1 style="color:#f2c14e;font-size:1.35rem">حریم خصوصی — بازی 52 Online</h1>
<p>بازی 52 Online برای ورود از گوگل یا فیسبوک استفاده می‌کند و فقط نام، ایمیل و عکس پروفایل حساب شما را می‌گیرد.</p>
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
<title>حذف اطلاعات — بازی 52 Online | Data Deletion — 52 Online</title>
<body style="font-family:Tahoma,Arial,sans-serif;background:#1c1410;color:#f5ead6;line-height:1.9;padding:2rem 1.1rem;max-width:640px;margin:0 auto">
<h1 style="color:#f2c14e;font-size:1.35rem">حذف اطلاعات — بازی 52 Online</h1>
<p>اگر می‌خواهید اطلاعاتی که بازی 52 Online از حساب گوگل یا فیسبوک شما گرفته (نام، ایمیل و عکس پروفایل) حذف شود، به این ایمیل پیام بفرستید: <a href="mailto:shuaibanwari20@gmail.com" style="color:#f2c14e">shuaibanwari20@gmail.com</a> — در عنوان بنویسید «حذف اطلاعات 52 Online». اطلاعات شما حداکثر تا ۷ روز پس از درخواست، کامل حذف می‌شود. برای حذف فوری، در بازی دکمهٔ خروج (Logout) نشست شما را همان لحظه می‌بندد.</p>
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

// up93 FAST OPEN: gzip a client buffer once; the result is cached
// beside the raw copy and served to every gzip-capable browser.
async function gzipBuffer(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip'));
  return await new Response(stream).arrayBuffer();
}

async function serveClient(request, env) {
  const src = env.CLIENT_URL || CLIENT_URL_DEFAULT;
  const etag = clientETag(src);
  const fallbackSrc = env.FALLBACK_CLIENT_URL || FALLBACK_CLIENT_URL_DEFAULT;
  const fallbackEtag = clientETag(fallbackSrc);
  const notModified = (tag) => new Response(null, {
    status: 304,
    headers: { 'ETag': tag, 'Cache-Control': BROWSER_CC },
  });
  const cacheKey = new Request(src, { method: 'GET' });
  const lastGoodKey = new Request(LAST_GOOD_CACHE_URL, { method: 'GET' });
  // up93 FAST OPEN (owner report 2026-11-15, "the game opens very
  // late"): the client is ~1 MB of HTML and worker responses are
  // NOT compressed by the edge here, so a phone used to pull the
  // whole megabyte before first paint. The worker now keeps a gzip
  // copy (≈222 KB on the wire) beside the raw one and serves it to
  // gzip-capable browsers; and the browser-facing lifetime becomes
  // a short max-age instead of no-cache, so repeat opens within
  // two minutes need no network at all — a new build still lands
  // within two minutes, and after that the ETag revalidation is a
  // single tiny 304.
  const BROWSER_CC = 'private, max-age=120';
  // HOTFIX up95 (2026-11-15): worker-side gzip DISABLED — on the
  // owner's phone the gzipped body arrived WITHOUT decompression
  // and rendered as raw binary garbage (his screenshot, 09:01).
  // The raw path below is the proven one; the short browser
  // max-age stays. Do not re-enable without a phone-verified test.
  const wantsGzip = false;
  const gzTag = (tag) => tag.replace(/"$/, '-gz"');
  const gzKeyOf = (url) => new Request(url + '#gz', { method: 'GET' });
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
  const serveCached = (hit, tag, isGz) => {
    // The browser may reuse its copy for BROWSER_CC's lifetime;
    // after that the ETag revalidation is free when nothing
    // changed: a matching If-None-Match gets a bodyless 304.
    const effTag = isGz ? gzTag(tag) : tag;
    if (ifNoneMatchHits(request, effTag)) return notModified(effTag);
    // Re-head the edge copy for the browser: same body/status and
    // Content-Type, but `Cache-Control: no-cache` — the browser must
    // revalidate `/` on every load, so a freshly deployed build is
    // picked up at once instead of being served from the browser's
    // own day-long cache. (The ?v= in the source URL only ever
    // busted THIS edge copy, never the browser's.)
    const headers = new Headers(hit.headers);
    headers.delete('X-Tore-Client-ETag');
    headers.set('Cache-Control', BROWSER_CC);
    headers.set('ETag', effTag);
    if (isGz) { headers.set('Content-Encoding', 'gzip'); headers.set('Vary', 'Accept-Encoding'); }
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
  const edgeCopy = (buf, tag, isGz) => new Response(buf, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=' + CLIENT_CACHE_TTL,
      'X-Tore-Client-ETag': tag,
      ...(isGz ? { 'Content-Encoding': 'gzip' } : {}),
    },
  });
  // Hand a freshly fetched buffer to THIS browser: the response
  // revalidates always — and if this very request already carries
  // the copy's ETag, it needs no body at all.
  const serveFresh = (buf, tag, isGz) => {
    const effTag = isGz ? gzTag(tag) : tag;
    if (ifNoneMatchHits(request, effTag)) return notModified(effTag);
    return new Response(buf, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': BROWSER_CC,
        'ETag': effTag,
        ...(isGz ? { 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' } : {}),
      },
    });
  };
  // Serve a cached copy, preferring its gzip twin when the browser
  // takes gzip (compressing + caching the twin on first need).
  const serveHit = async (hit, tag, rawUrl) => {
    if (!wantsGzip) return serveCached(hit, tag, false);
    const gzHit = await cacheMatch(gzKeyOf(rawUrl));
    if (gzHit) return serveCached(gzHit, tag, true);
    const gz = await gzipBuffer(await hit.arrayBuffer());
    await cachePut(gzKeyOf(rawUrl), edgeCopy(gz, tag, true));
    return serveFresh(gz, tag, true);
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
  if (hit) return serveHit(hit, etag, src);

  // Happy path 2: pull it from upstream — BOUNDED, so a cold ?v=
  // URL whose GitHub fetch stalls can never hang the page again.
  const fresh = await fetchClientCopy(src, CLIENT_FETCH_TIMEOUT_MS);
  if (fresh.buf) {
    // Cache the copy under its own URL AND as the version-
    // independent last-good entry (rewritten on every successful
    // upstream fetch), then serve it.
    await cachePut(cacheKey, edgeCopy(fresh.buf, etag));
    await cachePut(lastGoodKey, edgeCopy(fresh.buf, etag));
    if (wantsGzip) {
      const gz = await gzipBuffer(fresh.buf);
      await cachePut(gzKeyOf(src), edgeCopy(gz, etag, true));
      await cachePut(gzKeyOf(LAST_GOOD_CACHE_URL), edgeCopy(gz, etag, true));
      return serveFresh(gz, etag, true);
    }
    return serveFresh(fresh.buf, etag, false);
  }

  // Upstream failed, timed out or sent a truncated file. Fall back
  // to the most recent good client copy instead of hanging/503ing:
  // (a) the edge copy of the CURRENT URL — re-checked here because
  //     the first match may have raced a concurrent request's put
  //     (or transiently failed) while our fetch was in flight;
  const hitAgain = await cacheMatch(cacheKey);
  if (hitAgain) return serveHit(hitAgain, etag, src);
  // (b) the last-good entry — its stored header says which version
  //     it holds, so it is ETagged as that version;
  const lastGood = await cacheMatch(lastGoodKey);
  if (lastGood) {
    return serveHit(lastGood, lastGood.headers.get('X-Tore-Client-ETag') || etag, LAST_GOOD_CACHE_URL);
  }
  // (c) the PREVIOUS version's URL: its edge copy if this POP has
  //     one, else one bounded fetch of it (it was live for a day —
  //     in production the fetch is a warm GitHub raw read).
  const fbHit = await cacheMatch(fallbackKey);
  if (fbHit) return serveCached(fbHit, fallbackEtag, false);
  const fbFresh = await fetchClientCopy(fallbackSrc, FALLBACK_FETCH_TIMEOUT_MS);
  if (fbFresh.buf) {
    await cachePut(fallbackKey, edgeCopy(fbFresh.buf, fallbackEtag));
    return serveFresh(fbFresh.buf, fallbackEtag, false);
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
      if (/^st([1-9]|1[0-9]|2[0-4])\.gif$/.test(name)) return serveSticker(env, name);
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
      if (/^(thumbs\/)?felt([1-9]|1[01]|ev1)\.jpg$/.test(rest)) { // feat3: + the event carpet
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
      if (/^c([1-9]|[1-9][0-9]|100)\.jpg$/.test(name)) {
        return serveRepoAsset(env, env.MUSIC_URL || MUSIC_URL_BASE_DEFAULT, name, 'image/jpeg');
      }
      if (/^m([1-9]|[1-9][0-9]|100)\.mp3$/.test(name)) return serveMusic(env, request, name);
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

    if (path === '/push-key') {
      // feat5: the Web Push VAPID PUBLIC key — the Android PWA
      // client needs it as the PushManager applicationServerKey.
      // It is a public identifier (the matching private key is a
      // dashboard secret the Worker alone holds), so no session is
      // required; while the var is unset the route 404s and the
      // client simply never subscribes.
      if (request.method !== 'GET') {
        return new Response('method not allowed', { status: 405 });
      }
      const key = env.WEBPUSH_VAPID_PUBLIC || '';
      if (!key) return new Response('not configured', { status: 404 });
      return new Response(JSON.stringify({ key }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      });
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

    if (path === '/admin' && request.method === 'GET') {
      // up112: the SEPARATE admin panel page (its own new UI). The
      // gate is the same as the API's: a verified session whose
      // VERIFIED email is the admin email. No session -> back to
      // the game gate; a non-admin session -> a plain 403.
      const user = await auth.readSession(request, env);
      if (!user) return Response.redirect(url.origin + '/', 302);
      if (!auth.isAdminUser(user)) {
        return new Response('403 — admin only', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
      return new Response(adminPage(user), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    if (path.startsWith('/admin/')) {
      // up111: the owner's admin panel API — grant/deduct coins
      // and gems to any player by his 6-digit ID. THE GATE IS
      // HERE and only here: a verified session (401 without one)
      // whose VERIFIED email is the admin email (403 otherwise —
      // see auth.isAdminUser for why the session email can be
      // trusted). The wallet work runs in the DO's social core
      // over the internal route, like the ticket/authkv calls.
      const user = await auth.readSession(request, env);
      if (!user) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
      if (!auth.isAdminUser(user)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const stub = env.GAME.get(env.GAME.idFromName('global'));
      const call = (action, payload) => stub.fetch(new Request('https://do.internal/internal/admin/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      }));
      if (path === '/admin/player' && request.method === 'GET') {
        const id = url.searchParams.get('id') || '';
        if (!/^\d{6}$/.test(id)) return Response.json({ ok: false, error: 'bad id' }, { status: 400 });
        return call('player', { uid: id });
      }
      if (path === '/admin/grant' && request.method === 'POST') {
        let body = null;
        try { body = await request.json(); } catch { body = null; }
        const playerId = body && typeof body.playerId === 'string' ? body.playerId : '';
        if (!/^\d{6}$/.test(playerId)) return Response.json({ ok: false, error: 'bad id' }, { status: 400 });
        return call('grant', {
          uid: playerId, currency: body && body.currency, amount: body && body.amount,
          adminEmail: user.email, adminSub: user.sub,
        });
      }
      if (path === '/admin/grants' && request.method === 'GET') return call('grants', {});
      // up112: full-access routes for the separate admin panel.
      if (path === '/admin/stats' && request.method === 'GET') return call('stats', {});
      if (path === '/admin/players' && request.method === 'GET') {
        return call('players', {
          q: url.searchParams.get('q') || '',
          filter: url.searchParams.get('f') || 'all',
          offset: Number(url.searchParams.get('o')) || 0,
        });
      }
      if (path === '/admin/clubs' && request.method === 'GET') return call('clubs', {});
      if (path === '/admin/log' && request.method === 'GET') return call('log', {});
      if (path === '/admin/ban' && request.method === 'POST') {
        let body = null;
        try { body = await request.json(); } catch { body = null; }
        const playerId = body && typeof body.playerId === 'string' ? body.playerId : '';
        if (!/^\d{6}$/.test(playerId)) return Response.json({ ok: false, error: 'bad id' }, { status: 400 });
        return call('ban', {
          uid: playerId, banned: !!(body && body.banned),
          adminEmail: user.email, adminSub: user.sub,
        });
      }
      if (path === '/admin/broadcast' && request.method === 'POST') {
        let body = null;
        try { body = await request.json(); } catch { body = null; }
        return call('broadcast', {
          text: body && typeof body.text === 'string' ? body.text : '',
          adminEmail: user.email, adminSub: user.sub,
        });
      }
      if (path === '/admin/notice' && request.method === 'POST') {
        let body = null;
        try { body = await request.json(); } catch { body = null; }
        const playerId = body && typeof body.playerId === 'string' ? body.playerId : '';
        if (!/^\d{6}$/.test(playerId)) return Response.json({ ok: false, error: 'bad id' }, { status: 400 });
        return call('notice', {
          uid: playerId, text: body && typeof body.text === 'string' ? body.text : '',
          adminEmail: user.email, adminSub: user.sub,
        });
      }
      return Response.json({ ok: false, error: 'not found' }, { status: 404 });
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
      // up111: isAdmin rides along so the client can show the
      // admin panel — a display hint only; /admin/* re-checks the
      // verified email itself on every call.
      return Response.json({ ...user, isAdmin: auth.isAdminUser(user) });
    }
    if (path === '/auth/firebase') {
      // The gate POSTs a Firebase ID token here; auth.js verifies it
      // against Google's securetoken JWKS and mints the session cookie.
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      return auth.handleFirebaseToken(request, env);
    }
    if (path === '/auth/fb') {
      // U61: the Firebase bridge page for the installed app. The
      // gate's Safari sheet lands here; Firebase signs the player
      // in inside Safari (where its redirect flow works) and the
      // page bridges the token to the gate's ticket (below).
      if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
      const t = new URL(request.url).searchParams.get('ticket') || '';
      return new Response(fbPage(t, env.GOOGLE_CLIENT_ID || ''), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    if (path === '/auth/fb-complete') {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      return auth.handleFirebaseTicketComplete(request, env);
    }
    if (path === '/auth/email-finish') {
      // U67: the Firebase email-link landing page (completes the
      // gate's ticket with the link's token via /auth/fb-complete).
      const u = new URL(request.url);
      return new Response(emailFinishPage(u.searchParams.get('ticket') || '', u.searchParams.get('e') || ''), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    if (path === '/auth/email-start') {
      // U65: email + 6-digit code sign-in (the code is emailed).
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      return auth.handleEmailStart(request, env);
    }
    if (path === '/auth/email-verify') {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      return auth.handleEmailVerify(request, env);
    }
    if (path === '/auth/fb-code-complete') {
      // U63: the sign-in-code rescue — a browser gate completes
      // the app gate's ticket by its 8-digit code.
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      return auth.handleFirebaseCodeComplete(request, env);
    }
    if (path === '/auth/ticket' && request.method === 'POST') {
      // U60: the installed-app gate mints a one-time login ticket
      // (stored in the global DO), then opens /auth/google?ticket=…
      // in Safari; the gate polls /auth/ticket-status for the
      // result. The ticket carries no identity until the Google
      // callback completes it.
      if (!env.SESSION_SECRET) return Response.json({ ok: false, error: 'sign-in is not configured on this server' }, { status: 500 });
      const made = await auth.createLoginTicket(env);
      if (!made) return Response.json({ ok: false, error: 'ticket store unavailable' }, { status: 502 });
      return Response.json({ ok: true, ticket: made.ticket, code: made.code });
    }
    if (path === '/auth/ticket-status') {
      // One-time read: a completed ticket is consumed here and the
      // session cookie is minted on THIS response — served into
      // the app gate's own context, where the cookie belongs.
      const t = new URL(request.url).searchParams.get('ticket') || '';
      const st = await auth.loginTicketStatus(env, t);
      if (st.state === 'done' && st.user) return auth.ticketLoginResponse(env, st.user);
      if (st.state === 'failed') return Response.json({ ok: false, failed: true });
      return Response.json({ ok: false });
    }
    if (path === '/auth/done') {
      return new Response(authDonePage(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
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
          return new Response(gatePage({ email: !!env.BREVO_API_KEY, gid: env.GOOGLE_CLIENT_ID || '' }), {
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
