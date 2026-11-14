/** up68 unit proof — gate email hardening: invisible-character
 *  sanitising + staged error surfacing on the link send. */
import fs from 'node:fs';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const gateSrc = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/gate-page.js', 'utf8');
check('U68 handler retired with the email flow (U69, his order)',
  !gateSrc.includes('sendSignInLinkToEmail') && !gateSrc.includes('gate-email'));
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
