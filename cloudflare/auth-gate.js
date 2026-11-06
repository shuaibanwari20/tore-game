/* auth-gate.js — Cloudflare build only. Injected into the client bundle
 * by scripts/build-client.mjs (the Node build never sees this file).
 *
 * Behaviour: ask the Worker /auth/config whether the sign-in gate is on.
 *  - Gate OFF → do nothing at all (the game behaves exactly as before).
 *  - Gate ON + valid session (/auth/me 200) → play; if the local profile
 *    has no name yet, prefill it from the account name.
 *  - Gate ON + no session (/auth/me 401) → cover the menu with the
 *    sign-in screen (same carpet + gold field style) whose buttons
 *    start the OAuth flows: /auth/google and /auth/facebook.
 *
 * The Facebook button is rendered ONLY when /auth/config reports
 * fbLive (Worker env FB_LIVE === "1"): the Facebook app is still in
 * Development mode, where anyone outside the app's roles/testers gets
 * an error, so until the app goes Live the gate shows Google alone
 * (the /auth/facebook route itself stays in place, just unlinked).
 */
(function () {
  function showGate(fbLive) {
    if (document.getElementById('auth-gate')) return;
    var gate = document.createElement('div');
    gate.id = 'auth-gate';
    gate.setAttribute('dir', 'rtl');
    var bg = '';
    var home = document.getElementById('scr-home');
    if (home) {
      try { bg = getComputedStyle(home).backgroundImage || ''; } catch (e) { bg = ''; }
    }
    gate.style.cssText =
      'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;' +
      'background-color:#3a2410;' + (bg && bg !== 'none' ? 'background-image:' + bg + ';background-size:cover;' : '');
    var googleG =
      '<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">' +
      '<path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.5 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/>' +
      '<path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.5 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>' +
      '<path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/>' +
      '<path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>';
    var fbF =
      '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path fill="#fff" d="M13.5 21v-7h2.4l.4-3h-2.8V9.1c0-.9.3-1.5 1.6-1.5h1.3V4.9c-.3 0-1.1-.1-2-.1-2 0-3.4 1.2-3.4 3.5V11H8.5v3H11v7h2.5z"/></svg>';
    var btn =
      'display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:13px 16px;' +
      'border-radius:14px;font-size:16px;font-weight:bold;text-decoration:none;box-sizing:border-box;';
    // The spacer belongs to the Facebook button: with fbLive off the
    // chunk is omitted entirely, so the single Google button sits
    // directly under the subtitle with no empty gap.
    var fbBtn = fbLive
      ? '<div style="height:12px"></div>' +
        '<a href="/auth/facebook" style="' + btn + 'background:#1877f2;color:#fff;box-shadow:0 4px 0 #0d4fae">' + fbF + 'ورود با فیسبوک</a>'
      : '';
    gate.innerHTML =
      '<div style="width:min(88vw,340px);background:rgba(24,15,7,.92);border:2px solid #d4af37;border-radius:22px;' +
      'padding:28px 22px;text-align:center;color:#f5e7c6;box-shadow:0 18px 50px rgba(0,0,0,.55)">' +
      '<div style="font-size:44px;font-weight:900;color:#f2c14e;line-height:1.1">توره</div>' +
      '<div style="margin:6px 0 4px;font-size:15px">بازی ورق چهار نفره — دو تیم، دو به دو</div>' +
      '<div style="margin:0 0 20px;font-size:13px;opacity:.85">برای وارد شدن به بازی، اول با حساب خود وارد شو</div>' +
      '<a href="/auth/google" style="' + btn + 'background:#fff;color:#222;box-shadow:0 4px 0 #b9b9b9">' + googleG + 'ورود با گوگل</a>' +
      fbBtn +
      '</div>';
    document.body.appendChild(gate);
  }

  function init() {
    fetch('/auth/config', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        if (!cfg || !cfg.enabled) return;
        return fetch('/auth/me', { credentials: 'same-origin' }).then(function (r) {
          if (r.ok) {
            return r.json().then(function (me) {
              try {
                if (me && me.name) {
                  var p = JSON.parse(localStorage.getItem('tore.profile') || '{}');
                  if (!p.name) {
                    p.name = me.name;
                    localStorage.setItem('tore.profile', JSON.stringify(p));
                  }
                }
              } catch (e) { /* profile prefill is best-effort */ }
            });
          }
          showGate(cfg.fbLive === true);
        });
      })
      .catch(function () { /* offline etc. — never block the open game */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
