/** up74 unit proof — his order: sign in "the official way" and
 *  pick the Gmail at Google. The bridge page now goes straight
 *  to Google's account chooser on first load and never bridges
 *  a persisted user silently. */
import fs from 'node:fs';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const fb = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/fb-page.js', 'utf8');
check('F1 the chooser is forced (select_account)', fb.includes("provider.setCustomParameters({ prompt: 'select_account' })"));
check('F2 first load auto-starts the redirect', fb.includes('if (TICKET && !returned) {') && fb.includes('setTimeout(function () { if (!bridged) goGoogle(); }, 400);'));
check('F3 a persisted user bridges only on the return leg, after the result settles (U76)', fb.includes('var tryPersisted = function ()') && fb.includes('if (!resultSettled) { setTimeout(tryPersisted, 250); return; }'));
check('F4 the old silent bridge is gone', !fb.includes('auth.onAuthStateChanged(function (user) {\n    if (user) { decided = true; bridge(user); }'));
check('F5 the button is hidden while auto-starting', fb.includes("btn.style.display = 'none';"));
check('F6 the fallback button returns on failure', fb.includes('function showBtn()') && fb.includes('if (!bridged && returned && !decided) { showBtn(); msg(MSG_AGAIN); }'));
check('F7 the manual path also uses the chooser', fb.includes('function goGoogle()') && fb.includes('auth.signInWithRedirect(provider)'));
check('F8 the bridge completion is unchanged', fb.includes("fetch('/auth/fb-complete'") && fb.includes("location.replace('/auth/done')"));
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
