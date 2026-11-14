/** up82 unit proof — one button only. His 13:17 photos: the
 *  gate showed the old button first; he tapped it, its dead
 *  flow returned him, and only then did the GIS button
 *  appear. With GIS configured, the old button is now hidden
 *  from the first paint on both pages, and returns only if
 *  GIS itself fails to load. */
import fs from 'node:fs';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};
const gate = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/gate-page.js', 'utf8');
const fb = fs.readFileSync('/home/hatch/workspace/projects/tore-game/cloudflare/src/fb-page.js', 'utf8');
check('B1 the gate marks gis-mode before first paint', gate.includes("document.documentElement.classList.add('gis-mode')") && gate.includes('var __gidEarly = __GID__;'));
check('B2 the CSS hides the old button and shows the GIS slot', gate.includes('html.gis-mode #btn-google { display: none !important; }') && gate.includes('html.gis-mode #giswrap { display: block !important; }'));
check('B3 standalone is excluded from gis-mode (ticket flow keeps its button)', gate.includes('__gidEarly && !__saEarly'));
check('B4 a GIS outage restores the old button on the gate', gate.includes("document.documentElement.classList.remove('gis-mode')") && gate.includes("gBtn.style.display = '';"));
check('B5 the bridge renders its fallback button hidden when GIS is configured', fb.includes("${g ? ' style=\"display:none\"' : ''}"));
check('B6 a GIS outage reveals the bridge fallback button', fb.includes("if (!ok) btn.style.display = '';") && fb.includes("btn.style.display = ''; return true; }"));
console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
