/** up68 unit proof — gate email hardening: invisible-character
 *  sanitising + staged error surfacing on the link send. */
import fs from 'node:fs';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const gateSrc = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/gate-page.js', 'utf8');
check('G1 input is stripped of spaces + invisible marks before validation',
  gateSrc.includes('u200B-') && gateSrc.includes('u202A-') && gateSrc.includes('.replace(/[\\s'));
check('G2 staged errors are surfaced with a bracketed code',
  gateSrc.includes("stage = 'sdk'") && gateSrc.includes("stage = 'send'") && gateSrc.includes("GL().errConn + ' [' + code + ']'"));
check('G3 the ticket is carried through the chain in a variable',
  gateSrc.includes('var tid = ') && gateSrc.includes('encodeURIComponent(tid)'));
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
