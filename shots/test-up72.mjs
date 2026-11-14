/** up72 unit proof — his order: the PWA is Android-only. On iOS
 *  the service worker is never registered and the install entry
 *  never appears; Android keeps the full PWA behaviour. */
import fs from 'node:fs';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const src = fs.readFileSync('/home/hatch/workspace/projects/tore-game/public/index.html', 'utf8');
const dist = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/dist-client.html', 'utf8');
const worker = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/worker.js', 'utf8');
check('S1 source: SW registration is iOS-guarded', src.includes('!pwaUAIos') && src.includes("navigator.serviceWorker.register('/sw.js')"));
check('S2 source: install entry needs a real prompt only', src.includes('const showIt = !pwaStandalone() && !!deferredInstallPrompt;'));
check('S3 source: the old iOS show-branch is gone', !src.includes('|| pwaIsIOS())'));
check('S4 source: the guide never opens on iOS', src.includes('if (pwaIsIOS()) return;'));
check('S5 Android path intact: prompt listener + handler', src.includes("addEventListener('beforeinstallprompt'") && src.includes('await ev.prompt()'));
check('D1 dist carries the iOS guard + new show rule', dist.includes('pwaUAIos') && dist.includes('showIt = !pwaStandalone() && !!deferredInstallPrompt'));
check('D2 dist under the 1 MB cap', dist.length < 1000000, dist.length + ' B');
check('W1 worker serves the new client token', worker.includes('dist-client.html?v=20261114-gmailname'));
check('W2 fallback is the previous client', worker.includes('dist-client.html?v=20261113-viewportfit'));
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
