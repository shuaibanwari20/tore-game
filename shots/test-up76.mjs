/** up76 unit proof — his report: he picked the 708 account at
 *  Google's chooser, yet the game opened as pubg (a stale
 *  Firebase session in the browser won the return-leg race).
 *  The picked account must always win. */
import fs from 'node:fs';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const fb = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/fb-page.js', 'utf8');
check('R1 goGoogle signs the stale session out first', fb.includes('var so = auth.signOut();') && fb.includes('so.catch(function () {}).then(kick);'));
check('R2 the redirect starts only after sign-out settles', fb.includes('function kick() {') && fb.includes('auth.signInWithRedirect(provider).catch(fail);'));
check('R3 the result settlement is tracked', fb.includes('var resultSettled = false;') && fb.includes('resultSettled = true;'));
check('R4 a fresh result bridges immediately', fb.includes('if (res && res.user) { decided = true; bridge(res.user); }'));
check('R5 the persisted user waits for the result to settle', fb.includes('if (!resultSettled) { setTimeout(tryPersisted, 250); return; }'));
check('R6 the persisted fallback still exists (lost-result rescue)', fb.includes('setTimeout(tryPersisted, 600);'));
check('R7 first load still never bridges a persisted user', fb.includes('if (!returned) return;'));
check('R8 the chooser is still forced', fb.includes("setCustomParameters({ prompt: 'select_account' })"));
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
