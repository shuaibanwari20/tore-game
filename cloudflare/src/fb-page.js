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
var btn = document.getElementById('btn');
var msgEl = document.getElementById('msg');
function msg(t) { msgEl.textContent = t; }
var bridged = false;
function bridge(user) {
  if (bridged || !user) return;
  bridged = true;
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
  auth.getRedirectResult().then(function (res) {
    if (res && res.user) bridge(res.user);
  }).catch(function () { msg(MSG_FAIL); });
  btn.onclick = function () {
    if (!TICKET) { msg(MSG_BAD); return; }
    btn.disabled = true;
    msg(MSG_WAIT);
    auth.signInWithRedirect(new firebase.auth.GoogleAuthProvider())
      .catch(function () { btn.disabled = false; msg(MSG_FAIL); });
  };
} catch (e) {
  btn.disabled = true;
  msg(MSG_FAIL);
}
</script>
</body>
</html>`;
}
