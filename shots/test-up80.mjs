/** up80 unit proof — the owner ordered the bridge page's
 *  debug line removed ("این متن را از این صفحه حذف کن", with
 *  the 12:54 photo that also proved gis:ready on his phone).
 *  The #dbg element and its CSS are gone; trail() is a no-op;
 *  the GIS flow itself is untouched. */
import fs from 'node:fs';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const fb = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/fb-page.js', 'utf8');
check('D1 no debug element on the page', !fb.includes('id="dbg"'));
check('D2 no debug CSS on the page', !fb.includes('#dbg {'));
check('D3 nothing writes debug text anywhere', !fb.includes('dbgEl') && !fb.includes('trailParts'));
check('D4 trail() is a no-op', fb.includes('function trail(s) {}'));
check('D5 the GIS button flow is intact', fb.includes('https://accounts.google.com/gsi/client') && fb.includes('google.accounts.id.renderButton') && fb.includes('function completeWithToken(token)'));
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
