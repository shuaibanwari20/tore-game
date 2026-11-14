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
check('G1 gate sends the link with the ticket in the continue URL', gateSrc.includes('sendSignInLinkToEmail')
  && gateSrc.includes("'/auth/email-finish?ticket='") && gateSrc.includes('handleCodeInApp: false'));
check('G2 gate mints + polls the ticket for the email flow', gateSrc.includes("fetch('/auth/ticket'")
  && gateSrc.includes('startTicketPoll()'));
check('G3 gate no longer uses the OTP endpoints', !gateSrc.includes("'/auth/email-start'")
  && !gateSrc.includes("'/auth/email-verify'") && !gateSrc.includes('gate-email-code-row'));

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
