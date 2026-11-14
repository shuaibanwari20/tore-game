/** up71 unit proof — his order: email sign-in REMOVED from the
 *  gate; Google-only again (the up69 shape). The server OTP
 *  endpoints stay in the worker, dormant. */
import fs from 'node:fs';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const gateSrc = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/gate-page.js', 'utf8');
const workerSrc = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/worker.js', 'utf8');
check('G1 no email form on the gate', !gateSrc.includes('gate-email')
  && !gateSrc.includes('email-input') && !gateSrc.includes('email-code') && !gateSrc.includes('btn-email'));
check('G2 gate never calls the OTP endpoints', !gateSrc.includes('/auth/email-start') && !gateSrc.includes('/auth/email-verify'));
check('G3 no email strings/flags left in the gate', !gateSrc.includes('EMAIL_ON')
  && !gateSrc.includes('orEmail') && !gateSrc.includes('sendCode') && !gateSrc.includes('errOtp'));
check('G4 Google flow intact', gateSrc.includes('btn-google') && gateSrc.includes('signInWithPopup')
  && gateSrc.includes('getRedirectResult'));
check('G5 standalone note is the open-in-browser guidance x3',
  (gateSrc.match(/Safari\/Chrome/g) || []).length === 3);
check('G6 server OTP endpoints stay, dormant', workerSrc.includes('/auth/email-start') && workerSrc.includes('/auth/email-verify'));
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
