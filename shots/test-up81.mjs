/** up81 unit proof — GIS on the gate itself. The tab flow's
 *  Firebase answers never reach the gate in the owner's
 *  browser (his 13:02 photos); the gate now renders Google's
 *  official button in tabs and posts its token to
 *  /auth/firebase, which verifies Google tokens too.
 *  Standalone keeps the ticket -> bridge route. */
import fs from 'node:fs';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const gate = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/gate-page.js', 'utf8');
const auth = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/auth.js', 'utf8');
const worker = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/worker.js', 'utf8');
check('G1 the gate takes the client ID via opts', gate.includes("typeof opts.gid === 'string'") && worker.includes("gid: env.GOOGLE_CLIENT_ID || ''"));
check('G2 the GIS script + wrap are on the gate', gate.includes('https://accounts.google.com/gsi/client') && gate.includes('id="giswrap"') && gate.includes('id="gisbtn"'));
check('G3 GIS initializes with the gate callback', gate.includes('google.accounts.id.initialize({ client_id: GID, callback: onGateGis })'));
check('G4 GIS is tab-only (standalone keeps the ticket flow)', gate.includes('if (GID && !isStandalone) {'));
check('G5 the credential posts straight to /auth/firebase', gate.includes('function finishWithToken(idToken)') && gate.includes("body: JSON.stringify({ idToken: idToken })"));
check('A1 /auth/firebase verifies Google tokens as a fallback', auth.includes('claims = await verifyGoogleIdToken(body && body.idToken, env.GOOGLE_CLIENT_ID);'));
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
