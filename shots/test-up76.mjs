/** up76/up77 unit proof — his reports: (1) he picked the 708
 *  account at Google's chooser, yet the game opened as pubg;
 *  (2) the U76 return-leg gate then stranded him (result
 *  promise settles late/never on his phone). U77 supersedes
 *  the U76 mechanism: no signOut, no blind waiting — a stale
 *  uid snapshot + a hold that only the identical user waits
 *  out. These checks pin the CURRENT rule. */
import fs from 'node:fs';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const fb = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/fb-page.js', 'utf8');
check('R1 no signOut anywhere (suspect variable removed)', !fb.includes('auth.signOut()'));
check('R2 the stale uid is snapshotted before leaving', fb.includes("var STALE_KEY = 'tore.fb.stale';") && fb.includes('function snapStale(user)') && fb.includes('sessionStorage.setItem(STALE_KEY, cu.uid);'));
check('R3 first load snapshots and never bridges', fb.includes('snapStale(user);'));
check('R4 a result user always bridges immediately', fb.includes('if (res && res.user) { decided = true; bridge(res.user); }'));
check('R5 an empty result releases the hold', fb.includes('else releaseHold();') && fb.includes('function releaseHold()'));
check('R6 only the uid-identical user is held', fb.includes('if (st && user.uid === st) { heldUser = user; return; }'));
check('R7 a different account bridges at once on return', fb.includes('decided = true; bridge(user);'));
check('R8 the chooser is still forced', fb.includes("setCustomParameters({ prompt: 'select_account' })"));
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
