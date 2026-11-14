/** up73 unit proof — his order: on Android phones players sign in
 *  with Gmail in one tap. Android standalone keeps the Google
 *  button and the ticket flow opens the bridge page in the
 *  browser; iOS standalone keeps the U64 behaviour. */
import fs from 'node:fs';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const gate = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/gate-page.js', 'utf8');
const worker = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/worker.js', 'utf8');
check('G1 Android is detected from the UA', gate.includes("isAndroid = /android/i.test(window.navigator.userAgent || '')"));
check('G2 the note shows only for non-Android standalone', gate.includes('if (isStandalone && !isAndroid) {') && gate.includes("saEl.style.display = '';"));
check('G3 the button hides only for non-Android standalone', gate.includes("if (isStandalone && !isAndroid) { gBtn.style.display = 'none'; }"));
check('G4 the old unconditional hide is gone', !gate.includes("if (isStandalone) { gBtn.style.display = 'none'; }"));
check('G5 the ticket flow opens the bridge on Android', gate.includes("var bridgeUrl = '/auth/fb?ticket=' + encodeURIComponent(j.ticket);") && gate.includes("window.open(bridgeUrl, '_blank')"));
check('G6 bridge fallback navigates if the open is blocked', gate.includes('if (!bw) { try { location.href = bridgeUrl; }'));
check('G7 standalone still routes to the ticket flow', gate.includes('if (isStandalone) {') && gate.includes('startTicketFlow();'));
check('G8 the ticket poll still mints via ticket-status', gate.includes("fetch('/auth/ticket-status?ticket=' + encodeURIComponent(t), { credentials: 'same-origin' })"));
check('W1 bridge routes still live in the worker', worker.includes("path === '/auth/fb'") && worker.includes("path === '/auth/fb-complete'") && worker.includes("path === '/auth/ticket-status'") && worker.includes("path === '/auth/done'"));
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
