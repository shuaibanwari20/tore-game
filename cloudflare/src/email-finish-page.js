/**
 * email-finish-page.js — U67: lands the Firebase email-link
 * sign-in (GET /auth/email-finish?ticket=…&e=…).
 *
 * Why this page exists: the owner chose the no-key route — no
 * Brevo API key anywhere. The gate mints a one-time ticket and
 * asks Firebase to email a sign-in LINK whose continue URL is
 * this page (the ticket and the email ride along as parameters).
 * Firebase's own action page redirects the tap here with the
 * action code appended, so this page — running in a normal
 * browser context, where Firebase works perfectly — completes
 * the sign-in with signInWithEmailLink, bridges the verified ID
 * token to the gate's ticket (POST /auth/fb-complete, the same
 * bridge the Firebase page uses), and lands on /auth/done. The
 * gate back in the app polls the ticket and mints the session
 * in its own context. No mailer key, no client secret — token
 * verification is public-JWKS only (auth.js).
 *
 * If the email parameter is missing (a forwarded link), the
 * page simply asks for the email once and completes with it.
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

export function emailFinishPage(ticket, email) {
  const t = isTicketId(ticket) ? ticket : '';
  const e = typeof email === 'string' && email.length <= 254 ? email : '';
  const eJson = JSON.stringify(e).replace(/</g, '\\u003c');
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
  #msg { font-size: 14.5px; color: #f3c1d8; line-height: 1.9; min-height: 28px; }
  #email-row { display: none; margin-top: 16px; }
  #email2 { width: 100%; padding: 12px; border-radius: 12px; border: 1.5px solid rgba(255,215,94,.55);
    background: rgba(40,0,35,.45); color: #fff; font-family: inherit; font-size: 15px; text-align: center; direction: ltr; }
  #btn { margin-top: 12px; width: 100%; padding: 13px 10px; border: 0; border-radius: 999px; cursor: pointer;
    background: linear-gradient(180deg, #ffd968, #f5a623); color: #4a0727;
    font-size: 16px; font-weight: 800; box-shadow: 0 6px 18px rgba(0,0,0,.35); }
  #btn:disabled { opacity: .55; }
</style>
</head>
<body>
<div class="card">
  <h1>توره</h1>
  <div id="msg">ننوتل بشپړېږي…</div>
  <div id="email-row">
    <input id="email2" type="email" autocomplete="email" placeholder="ایمیل دې">
    <button type="button" id="btn">سمه ده</button>
  </div>
</div>
<script src="${SDK}firebase-app-compat.js"></script>
<script src="${SDK}firebase-auth-compat.js"></script>
<script>
  var TICKET = '${t}';
  var EMAIL = ${eJson};
  var MSG_BAD = 'دا پاڼه سمه نه ده خلاصه شوې — له لوبې یې بیا پیل کړه';
  var MSG_ASK = 'د بشپړولو لپاره خپل ایمیل یو ځل بیا ولیکه';
  var MSG_NOTLINK = 'دا لینک د ننوتلو لینک نه دی — خپل ایمیل وګوره';
  var MSG_FAIL = 'ننوتل بشپړ نه شول — ایمیل دې سم ولیکه او بیا هڅه وکړه';
  var MSG_GONE = 'دا لینک زوړ شوی دی — له لوبې نوی لینک وغواړه';
  var msgEl = document.getElementById('msg');
  var rowEl = document.getElementById('email-row');
  var btnEl = document.getElementById('btn');
  function msg(t) { msgEl.textContent = t; }
  function askEmail(failMsg) {
    if (failMsg) msg(failMsg);
    else msg(MSG_ASK);
    rowEl.style.display = 'block';
    var inp = document.getElementById('email2');
    if (inp && EMAIL) inp.value = EMAIL;
  }
  function complete(email) {
    btnEl.disabled = true;
    firebase.auth().signInWithEmailLink(email, window.location.href)
      .then(function (res) { return res.user.getIdToken(); })
      .then(function (tok) {
        return fetch('/auth/fb-complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket: TICKET, idToken: tok })
        });
      })
      .then(function (r) {
        if (r && r.ok) { location.replace('/auth/done'); return; }
        msg(MSG_GONE);
      })
      .catch(function () { askEmail(MSG_FAIL); btnEl.disabled = false; });
  }
  try {
    firebase.initializeApp(${JSON.stringify(FIREBASE_CONFIG)});
    if (!TICKET) {
      msg(MSG_BAD);
    } else if (!firebase.auth().isSignInWithEmailLink(window.location.href)) {
      msg(MSG_NOTLINK);
    } else if (EMAIL) {
      complete(EMAIL);
    } else {
      askEmail('');
    }
  } catch (e) {
    msg(MSG_BAD);
  }
  btnEl.onclick = function () {
    var v = (document.getElementById('email2').value || '').trim().toLowerCase();
    if (!v) { msg(MSG_ASK); return; }
    msg('ننوتل بشپړېږي…');
    rowEl.style.display = 'none';
    complete(v);
  };
</script>
</body>
</html>`;
}
