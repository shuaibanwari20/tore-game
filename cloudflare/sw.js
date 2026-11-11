'use strict';
/*
 * sw.js — Tore PWA service worker (Phase 0, deliberately conservative).
 *
 * The game is a LIVE multiplayer app behind a sign-in gate, so this
 * worker's first law is: never get between the player and the game.
 *
 *   - It answers ONLY two kinds of request itself:
 *       1. the pinned static PWA assets (icons + manifest) —
 *          cache-first; they are versioned by the cache name below.
 *       2. page navigations (the HTML shell at '/') — NETWORK-FIRST,
 *          so the ?v= cache-bust flow and every new build arrive
 *          exactly as before; a copy of the last GOOD shell is kept
 *          only as an offline fallback.
 *   - Everything else is left completely alone (no respondWith):
 *     WebSocket upgrades (not fetch events anyway), /auth/*,
 *     /turn-credentials, /social, /club-cover, every POST and every
 *     other API call go straight to the network, untouched.
 *   - The 401 GATE page is NEVER cached as the shell: only an
 *     HTTP-200 navigation response may enter the shell cache, so a
 *     signed-out visit can never be "remembered" as the app.
 *
 * Bump SW_VERSION on any change to this file or the precache list:
 * activate() deletes every older tore-* cache.
 */
const SW_VERSION = 'v1';
const STATIC_CACHE = 'tore-static-' + SW_VERSION;
const SHELL_CACHE = 'tore-shell-' + SW_VERSION;
const PRECACHE = [
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => { /* a failed precache must never block the install */ })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k.startsWith('tore-') && k !== STATIC_CACHE && k !== SHELL_CACHE)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Non-GET (every POST: auth, cover uploads, …) — never touched.
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  // Cross-origin (Firebase/Google/TURN pages, fonts, …) — untouched.
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  // Dynamic game traffic — untouched: auth, TURN credentials, the
  // social endpoint, uploaded club covers.
  if (path.startsWith('/auth/') || path === '/turn-credentials' ||
      path === '/social' || path === '/ws' || path.startsWith('/club-cover')) return;

  // 1) Pinned static PWA assets: cache-first.
  if (PRECACHE.includes(path)) {
    event.respondWith(
      caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      }))
    );
    return;
  }

  // 2) The HTML shell: network-first. Only a 200 may be stored as
  //    the offline fallback — a 401 gate page (or any error) is
  //    served as-is and NEVER cached.
  if (req.mode === 'navigate' || path === '/' || path === '/index.html') {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put('/', copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match('/', { ignoreSearch: true })
        .then((hit) => hit || new Response('offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })))
    );
    return;
  }

  // Everything else (stickers, covers, card requests, …): untouched.
});
