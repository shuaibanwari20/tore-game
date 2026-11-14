/** up83 unit proof — the player name comes from his Gmail.
 *  initSessionUser adopts the account name whenever it
 *  differs, unless the player typed a name himself in the
 *  profile editor (nameManual, set by the editor save and
 *  carried by loadProfile). Checks source + built dist. */
import fs from 'node:fs';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const src = fs.readFileSync('/home/hatch/workspace/projects/tore-game/public/index.html', 'utf8');
const dist = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/dist-client.html', 'utf8');
check('N1 the account name wins whenever it differs', src.includes('if (acctName && !profile.nameManual && profile.name !== acctName) { profile.name = acctName; changed = true; }'));
check('N2 the old empty-only adoption is gone', !src.includes('if (acctName && !profile.name) { profile.name = acctName; changed = true; }'));
check('N3 loadProfile carries the manual flag', src.includes('nameManual: p.nameManual === true,'));
check('N4 the editor save marks a typed name as manual', src.includes("nameManual: !!$('#pf-name').value.trim() || profile.nameManual === true,"));
check('N5 the dist carries the new rule', dist.includes('nameManual') && dist.includes('!profile.nameManual'));
check('N6 the dist stays under the 1 MB law', dist.length < 1000000, String(dist.length));
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
