/** up78 unit proof — his 11:24 retest completed as pubg again.
 *  (fb) the auto-start waits for the auth SDK's first callback
 *  so the stale snapshot exists before leaving; a diagnostic
 *  trail names what each step saw. (gate) the ticket poll
 *  follows the newest ticket on every tick. */
import fs from 'node:fs';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const fb = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/fb-page.js', 'utf8');
const gate = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/gate-page.js', 'utf8');
check('B1 first callback releases the auto-start (U79: scheduled, GIS first)', fb.includes('if (TICKET && !bridged) scheduleGo();'));
check('B2 the 400 ms fixed start is gone (2.5 s backstop only)', !fb.includes('}, 400);') && fb.includes('}, 2500);'));
check('B3 goGoogle is latched (and yields to GIS)', fb.includes('var goStarted = false;') && fb.includes('if (goStarted || gisReady) return;'));
check('B4 failure re-arms the latch', fb.includes('function fail() { goStarted = false;'));
check('B5 the debug line is removed from the page (U80, owner order)', !fb.includes('id="dbg"') && !fb.includes('#dbg {'));
check('B6 trail() is a no-op now (call sites kept, nothing renders)', fb.includes('function trail(s) {}'));
check('G1 the poll reads the current ticket every tick', gate.includes('var t = storedTicket();\n      if (!t) { stopTicketPoll(); return; }'));
check('G2 the captured-ticket start is gone', !gate.includes('var t = storedTicket();\n    if (!t) return;'));
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
