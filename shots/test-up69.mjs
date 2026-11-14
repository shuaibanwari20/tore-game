/** up69 unit proof — his order: email sign-in REMOVED from the
 *  game. The gate is Google-only again; the standalone note
 *  points to the browser; the dormant server endpoints stay. */
import fs from 'node:fs';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const gateSrc = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/gate-page.js', 'utf8');
check('G1 no email UI or flow left in the gate', !gateSrc.includes('gate-email')
  && !gateSrc.includes('sendSignInLinkToEmail') && !gateSrc.includes('/auth/email-finish')
  && !gateSrc.includes('btn-email-send'));
check('G2 Google flow intact', gateSrc.includes('btn-google') && gateSrc.includes('signInWithPopup')
  && gateSrc.includes("'/auth/firebase'"));
check('G3 standalone note points to the browser', gateSrc.includes('Sign-in is not available inside the app'));
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
