/** up79 unit proof — GIS on the bridge + dual token verify.
 *  (fb) Google's official button renders on the bridge page,
 *  the credential returns via an in-page callback, and the
 *  redirect fallback only fires when GIS cannot load.
 *  (auth) a Google ID token is verified against Google and
 *  lands through the same canonical identity map. */
import fs from 'node:fs';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const fb = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/fb-page.js', 'utf8');
const auth = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/auth.js', 'utf8');
const worker = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/worker.js', 'utf8');
check('F1 the bridge takes the Google client ID', fb.includes('function fbPage(ticket, gid)') && worker.includes("fbPage(t, env.GOOGLE_CLIENT_ID || '')"));
check('F2 the GIS client script loads', fb.includes('https://accounts.google.com/gsi/client'));
check('F3 GIS initializes with the callback and renders the official button',
  fb.includes('google.accounts.id.initialize({ client_id: GID, callback: onGisCredential })') && fb.includes('google.accounts.id.renderButton'));
check('F4 the credential completes the ticket directly', fb.includes('function completeWithToken(token)') && fb.includes("body: JSON.stringify({ ticket: TICKET, idToken: token })"));
check('F5 the redirect never fires once GIS is ready', fb.includes('if (goStarted || gisReady) return;'));
check('F6 the fallback redirect is scheduled, not instant', fb.includes('function scheduleGo()') && fb.includes('}, 2800);'));
check('A1 Google tokens verify against tokeninfo', auth.includes('async function verifyGoogleIdToken(idToken, clientId)') && auth.includes('https://oauth2.googleapis.com/tokeninfo?id_token='));
check('A2 aud + issuer + verified email are required', auth.includes('j.aud !== clientId') && auth.includes("j.iss !== 'https://accounts.google.com'") && auth.includes("j.email_verified !== 'true'"));
check('A3 completion tries Firebase, then Google', auth.includes('claims = await verifyGoogleIdToken(idToken, env.GOOGLE_CLIENT_ID);'));
check('A4 the identity still lands via the canonical email map', auth.includes('sub: await canonicalSub(env, email, claims.sub),'));
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
