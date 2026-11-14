/**
 * gate-page.js — the STANDALONE sign-in page.
 *
 * When AUTH_ENABLED is on and the request carries no valid session,
 * worker.js answers GET / with this page (HTTP 401) INSTEAD of the
 * game bundle — so an unauthenticated browser never downloads the
 * game at all and never flashes the main menu behind a late gate.
 * (The bundle keeps its own injected gate as a harmless fallback for
 * any path that still reaches it signed-out.)
 *
 * The look is the game's Ludo purple (RESKINNED 2026-11-11, owner
 * order): the splash's wine-plum -> magenta gradient field with the
 * diamond lattice and the night-city skyline band along the bottom,
 * a glossy gold «توره» wordmark, and the Ludo magenta card (#ov-round
 * family) instead of the old brown carpet panel. The sign-in flow
 * is the in-game gate's, step for step: Firebase JS SDK 10.12.2 from
 * gstatic, the public Tore web config, signInWithPopup with a
 * signInWithRedirect + getRedirectResult fallback, then POST
 * /auth/firebase and a reload (the reload now returns the game,
 * because the session cookie is set). U59: inside an installed
 * app the popup promise never settles (it opens in Safari), so
 * standalone skips the popup for the redirect flow, the popup is
 * raced against a 12 s timeout elsewhere, and the gate polls
 * /auth/me while a redirect is in flight so a Safari-finished
 * sign-in reloads the gate into the game on its own.
 * U60 (same evening): the real-iPhone test showed even the
 * redirect dies in the Firebase handler inside the Safari sheet,
 * so standalone no longer uses Firebase at all — the gate mints a
 * one-time login ticket, opens the server-side Google flow in
 * Safari, and polls /auth/ticket-status; the session cookie is
 * minted on the poll's own response, inside the app's context.
 * because the session cookie is set). The Facebook button is added
 * client-side only while /auth/config reports fbLive — while Facebook
 * login is parked it simply never appears.
 */
export function gatePage() {
  return GATE_HTML;
}

const GATE_HTML = `<!DOCTYPE html>
<html lang="ps" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>توره — ننوتل</title>
<script>
  // Resolve the language FIRST — this tiny script sits before the
  // style block. The card below stays hidden until the main
  // script applies these strings, so a player who stored Dari/English
  // never sees the static Pashto defaults flash (the same no-flash
  // rule as the game page's splash veil).
  window.__glang = 'ps';
  try {
    var __sl = localStorage.getItem('tore.lang');
    if (__sl === 'ps' || __sl === 'fa' || __sl === 'en') window.__glang = __sl;
  } catch (e) { /* private mode — Pashto default stands */ }
  document.documentElement.lang = window.__glang;
  document.documentElement.dir = window.__glang === 'en' ? 'ltr' : 'rtl';
</script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { min-height: 100%; }
  body {
    font-family: Tahoma, "Segoe UI", system-ui, sans-serif;
    color: #fdf3e3;
    display: flex; align-items: center; justify-content: center;
    min-height: 100dvh; padding: 18px 14px;
    position: relative; overflow: hidden;
    background-color: #4a0727;
    background-image:
      radial-gradient(ellipse 90% 46% at 50% 40%, rgba(240,86,159,.30) 0%, rgba(240,86,159,0) 62%),
      linear-gradient(45deg, rgba(255,255,255,.035) 1px, transparent 1.3px),
      linear-gradient(-45deg, rgba(255,255,255,.035) 1px, transparent 1.3px),
      linear-gradient(180deg, #4a0727 0%, #7d1046 34%, #a1185c 62%, #8a1250 82%, #2a0a2e 100%);
    background-size: 100% 100%, 34px 34px, 34px 34px, 100% 100%;
    background-repeat: no-repeat, repeat, repeat, no-repeat;
  }
  .gate-city { position: fixed; left: 0; right: 0; bottom: 0; height: 30%; min-height: 118px; z-index: 0; pointer-events: none; }
  .gate-city svg { display: block; width: 100%; height: 100%; }
  .gate-card {
    position: relative; z-index: 1; width: 100%; max-width: 400px;
    background: linear-gradient(180deg, #d81b74 0%, #b3126e 34%, #8e1a63 70%, #67124e 100%);
    border: 2px solid rgba(255, 183, 224, .4);
    border-radius: 24px; padding: 30px 24px 20px;
    text-align: center; color: #fff;
    box-shadow: 0 14px 34px rgba(0, 0, 0, .6), 0 0 44px rgba(216, 27, 116, .35), inset 0 2px 0 rgba(255, 255, 255, .35), inset 0 -14px 26px rgba(40, 0, 35, .35);
    /* Hidden until the main script applies the resolved language
       (body.lang-ready); the animation is the no-JS failsafe that
       still reveals the card (in the Pashto defaults) after 3 s. */
    visibility: hidden; animation: gateShow .01s linear 3s forwards;
  }
  body.lang-ready .gate-card { visibility: visible; animation: none; }
  @keyframes gateShow { to { visibility: visible; } }
  .gate-card h1 {
    font-size: 56px; font-weight: 900; line-height: 1.15; color: #ffd75e;
    letter-spacing: .5px;
    filter: drop-shadow(0 3px 0 rgba(90, 10, 60, .55)) drop-shadow(0 8px 20px rgba(0, 0, 0, .45)) drop-shadow(0 0 22px rgba(255, 183, 71, .35));
  }
  @supports ((-webkit-background-clip: text) or (background-clip: text)) {
    .gate-card h1 {
      background-image: linear-gradient(180deg, #fff6c8 0%, #ffe98a 30%, #ffd75e 48%, #f5b81e 72%, #d18d06 100%);
      -webkit-background-clip: text; background-clip: text;
      color: transparent; -webkit-text-fill-color: transparent;
    }
  }
  .gsub { margin-top: 6px; font-size: 16px; font-weight: 700; color: #ffe9c9; text-shadow: 0 1px 4px rgba(0, 0, 0, .35); }
  .gbtns { margin-top: 22px; display: flex; flex-direction: column; gap: 12px; }
  .gbtn {
    display: flex; align-items: center; justify-content: center; gap: 10px;
    width: 100%; padding: 13px 14px; border-radius: 14px; border: 0;
    font-family: inherit; font-size: 16.5px; font-weight: 800; cursor: pointer;
    box-shadow: 0 5px 16px rgba(0, 0, 0, .4), inset 0 1px 0 rgba(255, 255, 255, .55);
  }
  .gbtn:active { transform: translateY(1px); }
  .gbtn[disabled] { opacity: .65; cursor: wait; }
  .gbtn.google { background: linear-gradient(180deg, #ffffff 0%, #eef0f4 100%); color: #22242a; }
  .gbtn.facebook { background: #1877f2; color: #fff; }
  .gbtn .fic {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; border-radius: 50%;
    background: #fff; color: #1877f2; font-size: 17px; font-weight: 900;
    font-family: Arial, sans-serif; line-height: 1;
  }
  .gerr { min-height: 20px; margin-top: 14px; font-size: 13.5px; color: #ffc9bd; }
  .gemail { margin-top: 16px; }
  .gordiv { font-size: 12.5px; color: rgba(255, 233, 201, .85); margin-bottom: 10px; }
  .gemail input[type="email"] { width: 100%; padding: 11px 12px; border-radius: 12px; border: 1.5px solid rgba(255, 215, 94, .55); background: rgba(40, 0, 35, .45); color: #fff; font-family: inherit; font-size: 15px; text-align: center; direction: ltr; }
  .gbtn.emailgo { margin-top: 10px; background: linear-gradient(180deg, #ffd968, #f5a623); color: #4a0727; }
  .gemail-msg { min-height: 18px; margin-top: 8px; font-size: 12.5px; color: #ffe9c9; }
  .gcodeentry { margin-top: 10px; display: flex; gap: 8px; justify-content: center; }
  .gcodeentry input { width: 150px; padding: 9px 10px; border-radius: 10px; border: 1.5px solid rgba(255, 215, 94, .6); background: rgba(40, 0, 35, .45); color: #fff; font-size: 17px; font-weight: 800; letter-spacing: 3px; text-align: center; direction: ltr; }
  .gcodego { padding: 9px 16px; border-radius: 10px; border: 0; background: linear-gradient(180deg, #ffd968, #f5a623); color: #4a0727; font-family: inherit; font-size: 14px; font-weight: 800; cursor: pointer; }
  .gnote { margin-top: 10px; font-size: 12.5px; color: rgba(255, 233, 201, .85); }
  .glangs { margin-top: 18px; display: flex; gap: 8px; justify-content: center; }
  .glang {
    padding: 7px 16px; border-radius: 999px; cursor: pointer; font-family: inherit;
    font-size: 14px; font-weight: 700; color: #ffe9c9;
    background: rgba(38, 4, 32, .55); border: 1.5px solid rgba(255, 183, 71, .5);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .12);
  }
  .glang.sel {
    background: linear-gradient(180deg, #ffe98a 0%, #ffd75e 45%, #f5b81e 100%);
    border-color: #ffd75e; color: #4a0727;
    box-shadow: 0 3px 10px rgba(0, 0, 0, .35), inset 0 1px 0 rgba(255, 255, 255, .7);
  }
</style>
</head>
<body>
  <div class="gate-city" aria-hidden="true"><svg viewBox="0 0 480 150" preserveAspectRatio="xMidYMax slice"><path fill="#8e4bd0" opacity=".38" d="M-6 150V62h54v88zM58 150V44h40v106zM112 150V70h58v80zM188 150V38h44v112zM248 150V60h62v90zM326 150V48h42v102zM384 150V66h56v84zM452 150V54h36v96z"/><path fill="#451c72" opacity=".92" d="M-10 150V88h48v62zM50 150V74h36v76zM100 150V96h52v54zM166 150V66h40v84zM222 150V90h58v60zM300 150V76h44v74zM360 150V94h52v56zM428 150V82h58v68z"/><path fill="#27094a" d="M-14 150v-42h56v42zM56 150v-50h44v50zM112 150v-36h60v36zM186 150v-46h38v46zM236 150v-40h54v40zM304 150v-48h16v48zM336 150v-38h48v38zM398 150v-44h66v44z"/><path fill="#27094a" d="M304 102a8 7 0 0 1 16 0z"/><path fill="#ffd98a" opacity=".85" d="M66 112h3v5h-3zM78 122h3v5h-3zM126 122h3v5h-3zM146 130h3v5h-3zM196 114h3v5h-3zM206 126h3v5h-3zM248 120h3v5h-3zM266 132h3v5h-3zM310 112h3v5h-3zM348 122h3v5h-3zM368 132h3v5h-3zM410 116h3v5h-3zM432 128h3v5h-3zM20 118h3v5h-3zM-2 130h3v5h-3z"/><path fill="#ffedbe" opacity=".9" d="M84 108h3v5h-3zM158 118h3v5h-3zM256 108h3v5h-3zM356 110h3v5h-3zM446 118h3v5h-3zM32 132h3v5h-3z"/><rect y="143" width="480" height="7" fill="#0d0122"/><path stroke="#0d0122" stroke-width="3" fill="none" stroke-linecap="round" d="M40 150c1-10 2-16 4-22M44 128c-6-4-11-3-15 1M44 128c-4-6-9-7-13-5M44 128c-1-7 2-11 6-12M44 128c4-5 9-6 13-3M44 128c6-2 11 0 14 4M448 150c-1-9-2-14-4-19M444 131c-6-4-11-3-14 1M444 131c-4-6-9-7-13-5M444 131c-1-6 2-10 6-11M444 131c4-5 9-5 12-3M444 131c6-2 10 0 13 4"/></svg></div>
  <div class="gate-card">
    <h1>توره</h1>
    <div class="gsub" id="gate-sub">د لوبې لپاره ننوځه</div>
    <div class="gbtns" id="gate-btns">
      <button type="button" class="gbtn google" id="btn-google">
        <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34.3 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34.3 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>
        <span id="btn-google-label">په ګوګل ننوځه</span>
      </button>
    </div>
    <div class="gerr" id="gate-err"></div>
    <div class="gemail" id="gate-email" style="display:none">
      <div class="gordiv" id="gate-or"></div>
      <input id="email-input" type="email" autocomplete="email">
      <button type="button" class="gbtn emailgo" id="btn-email-send"></button>
      <div class="gemail-msg" id="gate-email-msg"></div>
    </div>
    <div class="gnote" id="gate-note">ننوتل یعنې د لوبې قوانین منل</div>
    <div class="gnote" id="gate-sa-note" style="display:none"></div>
    <div class="glangs" id="gate-langs">
      <button type="button" class="glang" data-lang="ps">پښتو</button>
      <button type="button" class="glang" data-lang="fa">دری</button>
      <button type="button" class="glang" data-lang="en">English</button>
    </div>
  </div>
<script>
(function () {
  var EMAIL_ON = true; // U66 (his order): the email form ALWAYS shows;
  // without a mailer key the send button answers the emailOff note
  // Firebase web config — PUBLIC values (the same ones shipped in the
  // game bundle's gate); security comes from the server-side token
  // check on /auth/firebase, never from hiding these.
  var firebaseConfig = {
    apiKey: 'AIzaSyC-oAgspSv6Zb2R-FVs_KXtrrhg8rc1zFM',
    authDomain: 'tore-game.firebaseapp.com',
    projectId: 'tore-game',
    appId: '1:162385253173:web:e51c95272435ccd12db27c'
  };
  // Language: the same store as the game itself (localStorage
  // 'tore.lang'), default Pashto. The switcher under the card lets a
  // player pick a language BEFORE signing in, and the choice carries
  // into the game. Only the texts change — the sign-in flow below is
  // untouched.
  var GATE_STR = {
    ps: { title: 'توره — ننوتل', sub: 'د لوبې لپاره ننوځه', google: 'په ګوګل ننوځه', busy: 'ننوتل کېږي…', fb: 'په فېسبوک ننوځه', note: 'ننوتل یعنې د لوبې قوانین منل', errFail: 'ننوتل ونه شول — بیا هڅه وکړه', errConn: 'په ننوتلو کې ستونزه — انټرنېټ دې وګوره', saNote: 'په اپ کې د ننوتلو لپاره خپل ایمیل ولیکه — د ننوتلو لینک به درته ایمیل شي؛ پرې ووهه او بېرته دې اپ ته راشه', orEmail: 'یا په ایمیل ننوځه', emailPh: 'ایمیل دې', sendLink: 'لینک واستوه', linkSent: 'لینک ستا ایمیل ته واستول شو — خپل ایمیل وګوره او پر لینک ووهه؛ لینک ۱۰ دقیقې کار کوي', errEmail: 'ایمیل سم ولیکه' },
    fa: { title: 'توره — ورود', sub: 'برای بازی وارد شوید', google: 'ورود با گوگل', busy: 'در حال ورود…', fb: 'ورود با فیسبوک', note: 'ورود یعنی پذیرش قانون‌های بازی', errFail: 'ورود ناموفق بود — دوباره تلاش کنید', errConn: 'خطا در ورود — اتصال اینترنت را بررسی کنید', saNote: 'برای ورود در اپ ایمیلت را بنویس — لینک ورود برایت ایمیل می‌شود؛ رویش بزن و به این اپ برگرد', orEmail: 'یا با ایمیل وارد شوید', emailPh: 'ایمیلت', sendLink: 'لینک را بفرست', linkSent: 'لینک به ایمیلت فرستاده شد — ایمیلت را باز کن و روی لینک بزن؛ لینک ۱۰ دقیقه کار می‌کند', errEmail: 'ایمیل را درست بنویسید' },
    en: { title: 'Tore — Sign in', sub: 'Sign in to play', google: 'Sign in with Google', busy: 'Signing in…', fb: 'Sign in with Facebook', note: 'Signing in means accepting the game rules', errFail: 'Sign-in failed — please try again', errConn: 'Sign-in error — check your internet connection', saNote: 'To sign in inside the app, enter your email — a sign-in link will be emailed to you; tap it, then come back to this app', orEmail: 'or sign in with email', emailPh: 'Your email', sendLink: 'Send sign-in link', linkSent: 'Link sent — open your email and tap the link; it works for 10 minutes', errEmail: 'Enter a valid email' }
  };
  var glang = (window.__glang && GATE_STR[window.__glang]) ? window.__glang : 'ps';
  try {
    var savedLang = localStorage.getItem('tore.lang');
    if (savedLang && GATE_STR[savedLang]) glang = savedLang;
  } catch (e) { /* private mode — Pashto default stands */ }
  function GL() { return GATE_STR[glang]; }
  function applyGateLang() {
    var d = GL();
    document.documentElement.lang = glang;
    document.documentElement.dir = glang === 'en' ? 'ltr' : 'rtl';
    document.body.classList.add('lang-ready');
    document.title = d.title;
    document.getElementById('gate-sub').textContent = d.sub;
    document.getElementById('btn-google-label').textContent = d.google;
    document.getElementById('gate-note').textContent = d.note;
    var saN = document.getElementById('gate-sa-note');
    if (saN) saN.textContent = d.saNote || '';
    var fbLbl = document.getElementById('gate-fb-label');
    if (fbLbl) fbLbl.textContent = d.fb;
    var orEl = document.getElementById('gate-or');
    if (orEl) orEl.textContent = d.orEmail;
    var eInp = document.getElementById('email-input');
    if (eInp) eInp.placeholder = d.emailPh;
    var esB = document.getElementById('btn-email-send');
    if (esB) esB.textContent = d.sendLink;
    var bs = document.querySelectorAll('.glang');
    for (var i = 0; i < bs.length; i++) {
      bs[i].classList.toggle('sel', bs[i].getAttribute('data-lang') === glang);
    }
  }
  var langBtns = document.querySelectorAll('.glang');
  for (var j = 0; j < langBtns.length; j++) {
    langBtns[j].onclick = function () {
      glang = this.getAttribute('data-lang');
      try { localStorage.setItem('tore.lang', glang); } catch (e) { /* ignore */ }
      applyGateLang();
    };
  }
  applyGateLang();

  var errBox = document.getElementById('gate-err');
  var gBtn = document.getElementById('btn-google');
  var gLabel = document.getElementById('btn-google-label');
  function gateFail(msg) {
    errBox.textContent = msg;
    gBtn.disabled = false;
    gLabel.textContent = GL().google;
  }
  function busy() {
    errBox.textContent = '';
    gBtn.disabled = true;
    gLabel.textContent = GL().busy;
  }
  // The Facebook button appears only while the server says FB login is
  // live (/auth/config fbLive) — same rule as the in-game gate.
  fetch('/auth/config').then(function (r) { return r.json(); }).then(function (cfg) {
    if (!cfg || !cfg.fbLive) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'gbtn facebook';
    var ic = document.createElement('span');
    ic.className = 'fic';
    ic.textContent = 'f';
    var tx = document.createElement('span');
    tx.id = 'gate-fb-label';
    tx.textContent = GL().fb;
    b.appendChild(ic);
    b.appendChild(tx);
    b.onclick = function () { location.href = '/auth/facebook'; };
    document.getElementById('gate-btns').appendChild(b);
  }).catch(function () { /* config unreachable — Google stays available */ });

  var authMod = null;
  var authObj = null;
  function loadAuth() {
    if (authObj) return Promise.resolve(authObj);
    return Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js')
    ]).then(function (mods) {
      var app = mods[0].initializeApp(firebaseConfig);
      authMod = mods[1];
      authObj = authMod.getAuth(app);
      return authObj;
    });
  }
  function finishWithUser(user) {
    if (!user) return;
    user.getIdToken().then(function (idToken) {
      return fetch('/auth/firebase', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: idToken })
      });
    }).then(function (r) {
      if (r && r.ok) { location.reload(); return; }
      gateFail(GL().errFail);
    }).catch(function () {
      gateFail(GL().errConn);
    });
  }
  // --- U59: sign-in must also work inside an installed app --------
  // In a home-screen app (iOS standalone especially) a Firebase
  // popup opens in Safari and its promise NEVER settles here, which
  // used to leave this button stuck on the busy label forever. So:
  // standalone goes straight to the redirect flow; the popup gets a
  // 12 s race timeout everywhere else and falls back to redirect;
  // and while a redirect sign-in is in flight the gate polls
  // /auth/me, so when the session lands (finished in Safari, cookie
  // shared back) the gate reloads into the game by itself.
  var isStandalone = false;
  try {
    isStandalone = (window.navigator && window.navigator.standalone === true) ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  } catch (e) { /* detection failed — browser-tab flow stands */ }
  if (isStandalone) {
    var saEl = document.getElementById('gate-sa-note');
    if (saEl) saEl.style.display = '';
  }
  var PENDING_KEY = 'tore.gate.pending';
  function markPending() {
    try { sessionStorage.setItem(PENDING_KEY, String(Date.now())); } catch (e) { /* ignore */ }
  }
  function pendingFresh() {
    try {
      var t = parseInt(sessionStorage.getItem(PENDING_KEY) || '0', 10);
      return t > 0 && (Date.now() - t) < 10 * 60 * 1000;
    } catch (e) { return false; }
  }
  function clearPending() {
    try { sessionStorage.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
  }
  var pollTimer = null;
  function stopAuthPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  function startAuthPoll() {
    if (pollTimer) return;
    var tries = 0;
    pollTimer = setInterval(function () {
      tries++;
      if (tries > 48 || !pendingFresh()) { stopAuthPoll(); return; }
      fetch('/auth/me', { credentials: 'same-origin' }).then(function (r) {
        return r.ok ? r.json() : null;
      }).then(function (me) {
        if (me && (me.id || me.name || me.email)) {
          stopAuthPoll(); clearPending(); location.reload();
        }
      }).catch(function () { /* keep polling */ });
    }, 2500);
  }
  // If the browser never actually leaves (in-app webview) or the
  // player comes back without a session, free the button again —
  // the polls keep running for a late success either way.
  function armWatchdog() {
    setTimeout(function () {
      if (!gBtn.disabled) return;
      gBtn.disabled = false;
      gLabel.textContent = GL().google;
      errBox.textContent = GL().errConn;
    }, 30000);
  }
  function startRedirect(auth, provider) {
    markPending();
    startAuthPoll();
    armWatchdog();
    return authMod.signInWithRedirect(auth, provider);
  }
  // --- U60/U64: the ticket flow (installed apps) ------------------
  // The gate mints a one-time ticket, opens the Firebase
  // bridge page (/auth/fb?ticket=…) in the Safari sheet, and polls
  // /auth/ticket-status. When Google verifies the player there, the
  // poll's response carries the session cookie — minted into THIS
  // context — and the gate reloads into the game.
  var TICKET_KEY = 'tore.gate.ticket';
  function storedTicket() {
    try { return sessionStorage.getItem(TICKET_KEY) || ''; } catch (e) { return ''; }
  }
  function storeTicket(t) {
    try {
      if (t) sessionStorage.setItem(TICKET_KEY, t);
      else sessionStorage.removeItem(TICKET_KEY);
    } catch (e) { /* ignore */ }
  }
  var ticketTimer = null;
  function stopTicketPoll() {
    if (ticketTimer) { clearInterval(ticketTimer); ticketTimer = null; }
  }
  function startTicketPoll() {
    if (ticketTimer) return;
    var t = storedTicket();
    if (!t) return;
    ticketTimer = setInterval(function () {
      if (!pendingFresh()) { stopTicketPoll(); return; }
      fetch('/auth/ticket-status?ticket=' + encodeURIComponent(t), { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j) return;
          if (j.ok) {
            stopTicketPoll(); storeTicket(''); clearPending();
            location.reload();
          } else if (j.failed) {
            stopTicketPoll(); storeTicket(''); clearPending();
            gateFail(GL().errFail);
          }
        }).catch(function () { /* keep polling */ });
    }, 2500);
  }
  function startTicketFlow() {
    fetch('/auth/ticket', { method: 'POST', credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.ticket) throw new Error('no ticket');
        markPending();
        storeTicket(j.ticket);
        startTicketPoll();
        armWatchdog();
        // U64 (his order «این صفحه را حذف کن»): the bridge sheet
        // page is NO LONGER opened — it kept stranding him. The
        // gate just shows the sign-in code; he enters it on the
        // game page in a normal browser and this gate's poll
        // brings the session in by itself.
      })
      .catch(function () { gateFail(GL().errFail); });
  }
  gBtn.onclick = function () {
    busy();
    if (isStandalone) {
      // U60: neither the popup nor the redirect result can come
      // back into an installed app — the ticket flow delivers the
      // session through our own poll in THIS context instead.
      startTicketFlow();
      return;
    }
    loadAuth().then(function (auth) {
      var provider = new authMod.GoogleAuthProvider();
      var popup = authMod.signInWithPopup(auth, provider);
      var timeout = new Promise(function (resolve, reject) {
        setTimeout(function () {
          var e = new Error('popup hung');
          e.code = 'auth/popup-timeout-tore';
          reject(e);
        }, 12000);
      });
      return Promise.race([popup, timeout]).then(function (cred) {
        finishWithUser(cred.user);
      }).catch(function (e) {
        var code = (e && e.code) || '';
        if (code.indexOf('popup') >= 0 || code.indexOf('operation-not-supported') >= 0 ||
            code.indexOf('cancelled') >= 0) {
          // Popup blocked/unsupported/hung (in-app browsers): full-page flow.
          return startRedirect(auth, provider);
        }
        throw e;
      });
    }).catch(function () {
      gateFail(GL().errFail);
    });
  };
  // Back in the app with a sign-in possibly finished elsewhere
  // (Safari): resume the session poll whenever the flag is fresh.
  function resumePolls() {
    if (!pendingFresh()) return;
    startAuthPoll();
    if (storedTicket()) startTicketPoll();
  }
  // U67: email-LINK sign-in (his pick — no mailer key at all).
  // Send = mint the one-time ticket, then ask Firebase to email
  // a sign-in link whose continue URL is /auth/email-finish with
  // the ticket (and the email) riding along. The finish page
  // completes the ticket with the link's Firebase token, and
  // THIS gate's ticket poll brings the session in by itself —
  // the very flow the ticket machinery was built for.
  function emailMsg(t) {
    var m = document.getElementById('gate-email-msg');
    if (m) m.textContent = t || '';
  }
  var esBtn = document.getElementById('btn-email-send');
  if (esBtn) esBtn.onclick = function () {
    var inp = document.getElementById('email-input');
    // U68: strip spaces + invisible bidi/zero-width marks — an RTL
    // keyboard (or autofill) can leave them inside the address,
    // which made a perfectly good email fail validation on his
    // phone («ایمیل سم ولیکه» with a visibly correct address).
    var v = ((inp && inp.value) || '').replace(/[\s\u200B-\u200F\u202A-\u202E\uFEFF]/g, '').toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) { emailMsg(GL().errEmail); return; }
    esBtn.disabled = true;
    // U68: staged errors — the message names the failing step so
    // a screenshot of the gate carries the real cause.
    var stage = 'ticket';
    var tid = '';
    fetch('/auth/ticket', { method: 'POST', credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.ticket) throw new Error('no ticket');
        tid = j.ticket;
        markPending();
        storeTicket(j.ticket);
        startTicketPoll();
        armWatchdog();
        stage = 'sdk';
        return loadAuth();
      })
      .then(function () {
        stage = 'send';
        return authMod.sendSignInLinkToEmail(authObj, v, {
          url: location.origin + '/auth/email-finish?ticket=' + encodeURIComponent(tid) + '&e=' + encodeURIComponent(v),
          handleCodeInApp: false
        });
      })
      .then(function () {
        esBtn.disabled = false;
        emailMsg(GL().linkSent);
      })
      .catch(function (e) {
        esBtn.disabled = false;
        var code = (e && e.code) || stage;
        emailMsg(GL().errConn + ' [' + code + ']');
      });
  };
  var ge = document.getElementById('gate-email');
  if (ge) ge.style.display = '';
  if (isStandalone) { gBtn.style.display = 'none'; }
  resumePolls();
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) resumePolls();
  });
  window.addEventListener('pageshow', resumePolls);
  // Returning from the redirect flow: pick up the result once.
  loadAuth().then(function (auth) {
    return authMod.getRedirectResult(auth);
  }).then(function (cred) {
    if (cred && cred.user) { busy(); clearPending(); finishWithUser(cred.user); }
  }).catch(function () { /* no redirect in flight — ignore */ });
})();
</script>
</body>
</html>
`;
