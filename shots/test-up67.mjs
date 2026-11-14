/** up67 unit proof — Firebase email-LINK sign-in (no mailer key).
 *  Statics over the real sources + the finish page's rendered
 *  output: the gate mints a ticket and emails a link whose
 *  continue URL is /auth/email-finish (ticket + email aboard);
 *  the finish page completes the sign-in with the link and
 *  bridges the token to the ticket via /auth/fb-complete. */
import fs from 'node:fs';
import { emailFinishPage } from '/home/hatch/workspace/projects/tore-game/cloudflare/src/email-finish-page.js';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const SRC = '/home/hatch/workspace/projects/tore-game/cloudflare/src/';
const workerSrc = fs.readFileSync(SRC + 'worker.js', 'utf8');
const gateSrc = fs.readFileSync(SRC + 'gate-page.js', 'utf8');
const finishSrc = fs.readFileSync(SRC + 'email-finish-page.js', 'utf8');

check('W1 worker routes /auth/email-finish to the finish page', workerSrc.includes("path === '/auth/email-finish'")
  && workerSrc.includes('emailFinishPage'));
check('G1-G3 gate email flow retired by U69 (finish page + worker route stay dormant)',
  !gateSrc.includes('sendSignInLinkToEmail') && !gateSrc.includes('gate-email'));

const T = '0123456789abcdef0123456789abcdef';
const page = emailFinishPage(T, 'unit@example.com');
check('F1 finish page carries ticket + email + the bridge', page.includes("var TICKET = '" + T + "'")
  && page.includes('"unit@example.com"') && page.includes('isSignInWithEmailLink')
  && page.includes('signInWithEmailLink') && page.includes("'/auth/fb-complete'")
  && page.includes("location.replace('/auth/done')"));
const badPage = emailFinishPage('zzzz', 'unit@example.com');
check('F2 a malformed ticket renders empty (the page shows MSG_BAD)', badPage.includes("var TICKET = '';"));
const evilPage = emailFinishPage(T, 'a</script>@b.co');
check('F3 an email cannot break out of the script', !evilPage.includes('a</script>'));

console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
