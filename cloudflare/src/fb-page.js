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
 *
 * U78 (2026-11-14, owner report): the 11:24 retest completed
 * as pubg AGAIN. Prime suspect: on his slow network the auth
 * state restores seconds after the page opens, so the 400 ms
 * auto-start left before any snapshot existed. The auto-start
 * now waits for the first auth-state callback (2.5 s backstop
 * timer), goGoogle is latched against double starts, and a
 * tiny #dbg trail logs what each step saw (account labels
 * included) so a failure screenshot names the faulty step.
 *
 * U79 (2026-11-14, owner report): the 11:35 retest STILL
 * landed pubg. Four bridge builds in a row failed identically,
 * which indicts the channel, not the logic: in his browser the
 * Firebase redirect result never reaches this page at all
 * (app-tab storage partitioning), so the saved account is the
 * only user the page can ever see. GIS replaces the channel:
 * Google's official button renders on this page, the player
 * picks his account in Google's own chooser, and the signed
 * ID token returns via an in-page callback — nothing crosses
 * origins through storage. The server verifies it against
 * Google (auth.js) and canonicalizes by email into the same
 * identity. The redirect flow remains as the automatic
 * fallback when the GIS script cannot load.
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

export function fbPage(ticket, gid) {
  const t = isTicketId(ticket) ? ticket : '';
  const g = typeof gid === 'string' ? gid : '';
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
  #giswrap { margin-bottom: 16px; }
  #gisbtn { display: flex; justify-content: center; min-height: 44px; }
</style>
</head>
<body>
<div class="card">
  <h1>توره</h1>
  <div class="sub">د ننوتلو لپاره لاندې تڼۍ ووهه<br>برای ورود دکمهٔ زیر را بزن</div>
  <div id="giswrap" style="display:none">
    <div class="sub" style="margin-bottom:12px">د ګوګل په رسمي تڼۍ خپل جمیل وټاکه</div>
    <div id="gisbtn"></div>
  </div>
  <button id="btn" type="button"><span class="g">G</span><span>په ګوګل ننوتل</span></button>
  <div id="msg"></div>
  <div class="tiny">Sign in with Google to continue</div>
</div>
<script src="https://accounts.google.com/gsi/client" async defer></script>
<script src="${SDK}firebase-app-compat.js"></script>
<script src="${SDK}firebase-auth-compat.js"></script>
<script>
var TICKET = ${JSON.stringify(t)};
var GID = ${JSON.stringify(g)};
var MSG_WAIT = 'یوه شېبه… گوګل ته ځي';
var MSG_GIS = 'خپل جمیل وټاکه';
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
function label(u) { return (u && (u.email || u.uid)) || '?'; }
// U80: the #dbg debug line did its job (the 12:54 photo proved
// gis:ready on the owner's phone) and he ordered it removed —
// trail() stays as a no-op so the call sites need no surgery.
function trail(s) {}
var bridged = false;
var gisReady = false;
function completeWithToken(token) {
  if (bridged || !token || !TICKET) return;
  bridged = true;
  trail('bridge:gis');
  msg(MSG_BACK);
  fetch('/auth/fb-complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ ticket: TICKET, idToken: token })
  }).then(function (res) {
    if (res.ok) { location.replace('/auth/done'); return; }
    bridged = false;
    msg(MSG_FAIL);
    showBtnSafe();
  }).catch(function () {
    bridged = false;
    msg(MSG_FAIL);
    showBtnSafe();
  });
}
function showBtnSafe() { try { btn.style.display = ''; } catch (e) { /* ignore */ } }
function bridge(user) {
  if (bridged || !user) return;
  bridged = true;
  trail('bridge:' + label(user));
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
  var goStarted = false;
  function fail() { goStarted = false; btn.disabled = false; showBtn(); msg(MSG_FAIL); }
  function goGoogle() {
    if (goStarted || gisReady) return;
    goStarted = true;
    trail('go');
    btn.disabled = true;
    btn.style.display = 'none';
    msg(MSG_WAIT);
    markSent();
    var provider = new firebase.auth.GoogleAuthProvider();
    try { provider.setCustomParameters({ prompt: 'select_account' }); } catch (e) { /* plain redirect still works */ }
    // U77: remember which account is signed in HERE before
    // leaving, so the return leg can tell a stale session apart
    // from the account the player is about to pick.
    try {
      var cu = auth.currentUser;
      if (cu && cu.uid) { sessionStorage.setItem(STALE_KEY, cu.uid); trail('snap:' + label(cu)); }
    } catch (e) { /* ignore */ }
    try {
      auth.signInWithRedirect(provider).catch(fail);
    } catch (e) { fail(); }
  }
  // U79: GIS first. The official button needs no redirect
  // result; if it initializes, the auto-redirect is cancelled
  // and the player signs in through Google's own button. If
  // the GIS script never arrives, scheduleGo() falls back to
  // the redirect flow.
  var goTimer = null;
  function scheduleGo() {
    if (goTimer || bridged || gisReady) return;
    goTimer = setTimeout(function () {
      goTimer = null;
      if (!bridged && !gisReady) goGoogle();
    }, 2800);
  }
  function onGisCredential(resp) {
    var cred = resp && resp.credential;
    if (!cred) { trail('gis:none'); return; }
    var em = '';
    try {
      var part = cred.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      var pj = JSON.parse(decodeURIComponent(escape(atob(part))));
      em = pj.email || '';
    } catch (e) { /* label only */ }
    trail('gis:' + (em || 'ok'));
    document.getElementById('giswrap').style.display = 'none';
    completeWithToken(cred);
  }
  function initGis() {
    if (!GID) return true;
    if (!(window.google && google.accounts && google.accounts.id)) return false;
    try {
      google.accounts.id.initialize({ client_id: GID, callback: onGisCredential });
      google.accounts.id.renderButton(document.getElementById('gisbtn'),
        { theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill' });
      gisReady = true;
      if (goTimer) { clearTimeout(goTimer); goTimer = null; }
      document.getElementById('giswrap').style.display = '';
      btn.style.display = 'none';
      msg(MSG_GIS);
      trail('gis:ready');
      return true;
    } catch (e) { trail('gis:err'); return true; }
  }
  if (GID && TICKET && !returned) {
    var gisTries = 0;
    var gisTimer = setInterval(function () {
      gisTries++;
      if (initGis() || gisTries > 40) clearInterval(gisTimer);
    }, 300);
  }

  var heldUser = null;
  function releaseHold() {
    if (heldUser && !bridged) {
      var u = heldUser; heldUser = null;
      trail('rel');
      decided = true; bridge(u);
    }
  }
  auth.getRedirectResult().then(function (res) {
    trail('res:' + (res && res.user ? label(res.user) : 'null'));
    if (res && res.user) { decided = true; bridge(res.user); }
    else releaseHold();
  }).catch(function () { trail('res:err'); if (!bridged) { fail(); } });
  auth.onAuthStateChanged(function (user) {
    if (!returned) {
      // U74+U77: first load never bridges — it snapshots the
      // account that a later return must not mistake for the
      // player's fresh pick. U78: the first callback (even a
      // null one) is also what releases the auto-start, so the
      // snapshot exists before the page leaves for Google.
      if (user) { snapStale(user); trail('snap:' + label(user)); }
      if (TICKET && !bridged) scheduleGo();
      return;
    }
    if (!user) return;
    trail('auth:' + label(user));
    // U77: a user identical to the pre-redirect session may be
    // that stale session reporting early — hold it until
    // Google's result settles. Any other account is the fresh
    // pick and bridges at once.
    var st = staleUid();
    if (st && user.uid === st) { heldUser = user; trail('held:' + label(user)); return; }
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
  trail(returned ? 'ret' : 'new');
  if (TICKET && !returned) {
    // U74: straight to Google — no tap on this page at all.
    // U78: the auth-state callback above fires goGoogle as
    // soon as the SDK settles; this timer is only a backstop.
    btn.style.display = 'none';
    msg(MSG_WAIT);
    setTimeout(function () { if (!bridged) goGoogle(); }, 2500);
  }
} catch (e) {
  btn.disabled = true;
  msg(MSG_FAIL);
}
</script>
</body>
</html>`;
}
