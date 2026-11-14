/** up75 unit proof — his order: the /auth/done page must not be
 *  shown parked after sign-in; it returns to the app by itself. */
import fs from 'node:fs';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const w = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/worker.js', 'utf8');
check('D1 success tries to close the browser tab', w.includes("setTimeout(function () { try { window.close(); } catch (e) {} }, 350);"));
check('D2 otherwise it bounces straight into the game', w.includes("setTimeout(function () { location.replace('/'); }, 1500);"));
check('D3 a manual return button exists (both views)', (w.match(/🎮 لوبې ته وګرځه/g) || []).length === 2);
check('D4 the old park-here text is gone', !w.includes('You can close this page.'));
check('D5 the fail view is preserved', w.includes("document.getElementById('done-fail').style.display = '';") && w.includes('Sign-in did not complete.'));
check('D6 auto-return runs only on success', w.includes('} else {\n  // U75: never park the player on this page'));
check('D7 the client token is untouched', w.includes('dist-client.html?v=20261114-gmailname'));
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
