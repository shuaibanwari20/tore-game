/**
 * fb-page.js — U61: the Firebase sign-in page the installed app's
 * gate opens in the Safari sheet (GET /auth/fb?ticket=…).
 *
 * Why this page exists: inside an iOS installed app, Firebase's
 * popup AND redirect results can never be delivered back into the
 * app (proven on a real iPhone, 2026-11-13). But Firebase works
 * perfectly HERE — this page runs in a normal Safari context, so
 * its redirect flow completes like in any browser tab. The page
 * then bridges the verified ID token to the gate's one-time
 * ticket (POST /auth/fb-complete), lands on /auth/done, and the
 * gate back in the app polls the ticket and mints the session in
 * its own context. No Google client secret is used anywhere in
 * this path — token verification is public-JWKS only (auth.js).
 *
 * U62: the return from Google is handled three ways, because in
 * the iOS sheet the one-time redirect result is often lost even
 * though the sign-in itself succeeded: (1) getRedirectResult,
 * (2) onAuthStateChanged / currentUser — Firebase persists the
 * signed-in user on THIS origin, and a persisted user bridges
 * exactly the same way, (3) a "we came back but nothing arrived"
 * message with a tap-to-retry button instead of a silent page.
 *
 * U74 (2026-11-14, owner order — sign in "the official way" and
 * pick the Gmail at Google, not through another page's button):
 * the page no longer waits for a tap and no longer bridges a
 * persisted user silently. On the FIRST load it goes straight
 * to Google's own account chooser (prompt=select_account); the
 * button remains only as the fallback for a lost/blocked
 * redirect.
 *
 * U76 (2026-11-14, owner report): he picked the 708 account at
 * the chooser yet the game opened as pubg — the browser held
 * pubg's stale Firebase session and the return leg bridged that
 * saved user before the fresh redirect result landed. Now
 * goGoogle() signs the stale user out first, and on the return
 * leg a persisted user bridges only after getRedirectResult
 * has settled without a user — the picked account always wins.
 *
 * U77 (2026-11-14, owner report — supersedes the U76 mechanism):
 * the 11:15 retest stranded on the return leg (stuck on
 * MSG_BACK, then MSG_AGAIN): on his phone the redirect-result
 * promise settles late or never, so gating on it parks the
 * player, and the pre-redirect signOut is a second suspect.
 * New rule: NO signOut. Before leaving for Google the page
 * snapshots the signed-in account's uid (STALE_KEY). On the
 * return leg a user with that same uid is HELD (it may be the
 * stale session) until the result settles — an empty result
 * releases the hold (he picked the same account; the session
 * is valid) — while any different account bridges at once,
 * and a result user always bridges immediately.
 */

import { isTicketId } from './tickets.js';

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyC-oAgspSv6Zb2R-FVs_KXtrrhg8rc1zFM',
  authDomain: 'tore-game.firebaseapp.com',
  projectId: 'tore-game',
  storageBucket: 'tore-game.firebasestorage.app',
  messagingSenderId: '162385253173',
  appId: '1:162385253173:web:e51c95272435ccd12db27c',
};
const SDK = 'https://www.gstatic.com/firebasejs/10.12.5/';

export function fbPage(ticket) {
  const t = isTicketId(ticket) ? ticket : '';
  return `<!DOCTYPE html>
<html lang="ps" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>توره — ننوتل</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { min-height: 100dvh; display: flex; align-items: center; justify-content: center;
    background: radial-gradient(120% 90% at 50% 0%, #6d0f3d 0%, #4a0727 55%, #2b0417 100%);
    font-family: "Segoe UI", Tahoma, Arial, sans-serif; color: #ffe9a8; padding: 20px; }
  .card { width: min(92vw, 380px); text-align: center; background: rgba(30,4,20,.55);
    border: 1.5px solid rgba(255,201,76,.45); border-radius: 22px; padding: 30px 22px 26px;
    box-shadow: 0 18px 50px rgba(0,0,0,.5); }
  h1 { font-size: 34px; color: #ffc94c; margin-bottom: 6px; }
  .sub { font-size: 13.5px; color: #f3c1d8; margin-bottom: 22px; line-height: 1.7; }
  #btn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%;
    padding: 14px 10px; border: 0; border-radius: 999px; cursor: pointer;
    background: linear-gradient(180deg, #ffd968, #f5a623); color: #4a0727;
    font-size: 17px; font-weight: 800; box-shadow: 0 6px 18px rgba(0,0,0,.35); }
  #btn:disabled { opacity: .55; }
  #btn .g { display: inline-flex; width: 22px; height: 22px; border-radius: 50%;
    background: #fff; align-items: center; justify-content: center;
    font-size: 15px; font-weight: 900; color: #4285f4; }
  #msg { min-height: 22px; margin-top: 16px; font-size: 14px; color: #ffe9a8; line-height: 1.7; }
  .tiny { margin-top: 10px; font-size: 11.5px; color: #c99; color: #d8a7bd; line-height: 1.8; }
</style>
</head>
<body>
<div class="card">
  <h1>توره</h1>
  <div class="sub">د ننوتلو لپاره لاندې تڼۍ ووهه<br>برای ورود دکمهٔ زیر را بزن</div>
  <button id="btn" type="button"><span class="g">G</span><span>په ګوګل ننوتل</span></button>
  <div id="msg"></div>
  <div class="tiny">Sign in with Google to continue</div>
</div>
<script src="${SDK}firebase-app-compat.js"></script>
<script src="${SDK}firebase-auth-compat.js"></script>
<script>
var TICKET = ${JSON.stringify(t)};
var MSG_WAIT = 'یوه شېبه… گوګل ته ځي';
var MSG_BACK = 'بیرته راغلې… ننوتل بشپړېږي';
var MSG_FAIL = 'ننوتل ونشول — بیا هڅه وکړه';
var MSG_BAD = 'دا پاڼه سمه نه ده خلاصه شوې — له لوبې یې بیا پیل کړه';
var MSG_AGAIN = 'ننوتل وشول خو نتیجه دلته ونه رسېده — تڼۍ یو ځل بیا ووهه';
var SENT_KEY = 'tore.fb.sent';
var STALE_KEY = 'tore.fb.stale';
function staleUid() { try { return sessionStorage.getItem(STALE_KEY) || ''; } catch (e) { return ''; } }
function snapStale(user) { try { if (user && user.uid) sessionStorage.setItem(STALE_KEY, user.uid); } catch (e) { /* ignore */ } }
function sentBefore() { try { return sessionStorage.getItem(SENT_KEY) === '1'; } catch (e) { return false; } }
function markSent() { try { sessionStorage.setItem(SENT_KEY, '1'); } catch (e) { /* ignore */ } }
function clearSent() { try { sessionStorage.removeItem(SENT_KEY); } catch (e) { /* ignore */ } }
var btn = document.getElementById('btn');
var msgEl = document.getElementById('msg');
function msg(t) { msgEl.textContent = t; }
var bridged = false;
function bridge(user) {
  if (bridged || !user) return;
  bridged = true;
  clearSent();
  btn.disabled = true;
  msg(MSG_BACK);
  user.getIdToken().then(function (tok) {
    return fetch('/auth/fb-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: TICKET, idToken: tok })
    });
  }).then(function (r) { return r.json().catch(function () { return null; }); })
    .then(function (j) {
      if (j && j.ok) { location.replace('/auth/done'); return; }
      bridged = false; btn.disabled = false; msg(MSG_FAIL);
    })
    .catch(function () { bridged = false; btn.disabled = false; msg(MSG_FAIL); });
}
try {
  firebase.initializeApp(${JSON.stringify(FIREBASE_CONFIG)});
  var auth = firebase.auth();
  if (!TICKET) { btn.disabled = true; msg(MSG_BAD); }
  var returned = sentBefore();
  if (returned) msg(MSG_BACK);
  var decided = false;
  function showBtn() { btn.style.display = ''; }
  function goGoogle() {
    btn.disabled = true;
    btn.style.display = 'none';
    msg(MSG_WAIT);
    markSent();
    var provider = new firebase.auth.GoogleAuthProvider();
    try { provider.setCustomParameters({ prompt: 'select_account' }); } catch (e) { /* plain redirect still works */ }
    function fail() { btn.disabled = false; showBtn(); msg(MSG_FAIL); }
    // U77: remember which account is signed in HERE before
    // leaving, so the return leg can tell a stale session apart
    // from the account the player is about to pick.
    try {
      var cu = auth.currentUser;
      if (cu && cu.uid) sessionStorage.setItem(STALE_KEY, cu.uid);
    } catch (e) { /* ignore */ }
    try {
      auth.signInWithRedirect(provider).catch(fail);
    } catch (e) { fail(); }
  }
  var heldUser = null;
  function releaseHold() {
    if (heldUser && !bridged) {
      var u = heldUser; heldUser = null;
      decided = true; bridge(u);
    }
  }
  auth.getRedirectResult().then(function (res) {
    if (res && res.user) { decided = true; bridge(res.user); }
    else releaseHold();
  }).catch(function () { if (!bridged) { showBtn(); msg(MSG_FAIL); } });
  auth.onAuthStateChanged(function (user) {
    if (!user) return;
    if (!returned) {
      // U74+U77: first load never bridges — it only snapshots
      // the account that a later return must not mistake for
      // the player's fresh pick.
      snapStale(user);
      return;
    }
    // U77: a user identical to the pre-redirect session may be
    // that stale session reporting early — hold it until
    // Google's result settles. Any other account is the fresh
    // pick and bridges at once.
    var st = staleUid();
    if (st && user.uid === st) { heldUser = user; return; }
    decided = true; bridge(user);
  });
  setTimeout(function () {
    if (!bridged && returned && !decided) { showBtn(); msg(MSG_AGAIN); }
  }, 3500);
  btn.onclick = function () {
    if (!TICKET) { msg(MSG_BAD); return; }
    if (returned && auth.currentUser) { bridge(auth.currentUser); return; }
    goGoogle();
  };
  if (TICKET && !returned) {
    // U74: straight to Google — no tap on this page at all.
    btn.style.display = 'none';
    msg(MSG_WAIT);
    setTimeout(function () { if (!bridged) goGoogle(); }, 400);
  }
} catch (e) {
  btn.disabled = true;
  msg(MSG_FAIL);
}
</script>
</body>
</html>`;
}
