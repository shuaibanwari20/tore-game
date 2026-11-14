/** up70 unit proof — his explicit re-order: email + 6-digit code
 *  sign-in restored on the gate (server OTP never left), with
 *  the U68 input sanitising + status-named send failures. */
import fs from 'node:fs';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const gateSrc = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/gate-page.js', 'utf8');
check('G1 gate carries the email + code form again', gateSrc.includes('gate-email')
  && gateSrc.includes('email-input') && gateSrc.includes('email-code') && gateSrc.includes('btn-email-verify'));
check('G2 gate calls the OTP endpoints', gateSrc.includes("'/auth/email-start'") && gateSrc.includes("'/auth/email-verify'"));
check('G3 the address is sanitised before validation (U68)', gateSrc.includes('u200B-') && gateSrc.includes('u202A-'));
check('G4 a failed send names its status', gateSrc.includes("GL().errConn + ' [' + r.status + ']'"));
check('G5 Google flow intact', gateSrc.includes('btn-google') && gateSrc.includes('signInWithPopup'));
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
