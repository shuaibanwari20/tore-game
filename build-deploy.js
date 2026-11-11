#!/usr/bin/env node
/*
 * build-deploy.js — build the self-contained deploy bundle.
 *
 * deploy/server.js serves ONLY ./index.html from memory and 404s everything
 * else, so the bundle must carry every image inside the page. This script:
 *
 *   1. Reads public/index.html (the client source; all JS image loads go
 *      through the ASSET() resolver — see public/index.html).
 *   2. Builds window.__ASSETS__: { 'carpet.jpg': dataURI, 'cards/<f>': dataURI,
 *      'carpets/<f>': dataURI } for public/carpet.jpg, EVERY file in
 *      public/cards/ (52 faces + back.png) and the eleven table-felt carpet
 *      PHOTOS in public/carpets/ (felt1..11.jpg — real medallion carpets
 *      plus felt 11, the ORIGINAL cream carpet from the first build,
 *      provenance in carpet-src/SOURCES.md), and injects it just before
 *      the main <script>.
 *   3. No markup/CSS raster reference exists anymore: the landing left
 *      the carpet in the 2026-11-09 ludomenu reskin and the game table
 *      left it in the 2026-11-11 tabnew reskin — both fields are pure
 *      CSS gradients, and the menu fans are real deck faces rendered by
 *      cardEl() through ASSET(). The carpet survives ONLY as an ASSET()
 *      map entry above (a JS preload still names it; nothing paints it).
 *   4. Copies game.js + bots.js into deploy/ (deploy/server.js is the
 *      deploy variant and is NOT overwritten; deploy/package.json neither).
 *   5. Asserts nothing in the bundle can trigger an external image request:
 *      outside the __ASSETS__ map and ASSET('…') lookups, no 'cards/' or
 *      'carpet.jpg' reference may remain.
 *      ONE deliberate exception: the chat GIF stickers are served as
 *      files (the stickers folder beside each host's server) so the
 *      bundle stays light. The client may reference them ONLY from
 *      stickerURL() — this script counts the references and scrubs
 *      that single construction before the assertion above.
 *
 * Usage: node build-deploy.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DEPLOY = path.join(ROOT, 'deploy');

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
function dataURI(file) {
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime) throw new Error('no mime for ' + file);
  return 'data:' + mime + ';base64,' + fs.readFileSync(file).toString('base64');
}

// ---- 1+2: collect every asset the page can request -------------------------
const assets = {};
assets['carpet.jpg'] = dataURI(path.join(PUB, 'carpet.jpg'));
const cardFiles = fs.readdirSync(path.join(PUB, 'cards'))
  .filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
for (const f of cardFiles) assets['cards/' + f] = dataURI(path.join(PUB, 'cards', f));
const feltFiles = fs.readdirSync(path.join(PUB, 'carpets'))
  .filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
for (const f of feltFiles) assets['carpets/' + f] = dataURI(path.join(PUB, 'carpets', f));
const assetCount = Object.keys(assets).length;
if (assetCount !== 65) {
  throw new Error('expected 65 assets (carpet + 53 cards + 11 felt photos), got ' + assetCount);
}

// ---- transform the page ----------------------------------------------------
let html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

// 3a: RETIRED 2026-11-11 (tabnew reskin, ?v=20261111-tabnew): the game
// table's field used to carry its own CSS carpet — the one CSS
// url("carpet.jpg") reference outside ASSET(), inlined here so the
// field painted immediately (late-asset flash fix). The owner-approved
// reskin makes the felt pure CSS gradients, so no CSS image reference
// remains to inline; the data-URI count check below now expects the
// asset map alone. The carpet stays in the map (a JS preload names it).

// 2: inject the asset map immediately before the main script.
const anchor = "<script>\n'use strict';";
if (!html.includes(anchor)) throw new Error('main <script> anchor not found');
const inject = '<script>\n// ---- Inlined assets (build-deploy.js): deploy server serves only this page ----\n' +
  'window.__ASSETS__ = ' + JSON.stringify(assets) + ';\n</script>\n';
html = html.replace(anchor, inject + anchor);

// ---- 5: prove the bundle cannot request an image from the server ----------
// The stickers exception, checked on the raw page first: exactly ONE
// sticker-path reference may exist — the stickerURL() construction —
// and it must be there (a client without it has no stickers at all).
const stickerRefs = (html.match(/stickers\//g) || []).length;
if (stickerRefs !== 1 || !html.includes("'/stickers/' + id + '.gif'")) {
  throw new Error('sticker files may be referenced ONLY from stickerURL() — found ' +
    stickerRefs + ' sticker path references');
}
// Remove the injected map, every ASSET('…') lookup and all comments (the
// credits/comments legitimately NAME the files; only load sites matter).
// Nothing image-like may remain afterwards.
let scrubbed = html.replace(/window\.__ASSETS__ = \{.*?\};/s, '');
scrubbed = scrubbed.replace(/\/stickers\//g, ''); // the one allowed external image path (see above)
scrubbed = scrubbed.replace(/ASSET\('[^']*'\)/g, '').replace(/ASSET\("[^"]*"\)/g, '');
scrubbed = scrubbed.replace(/ASSET\('cards\/' \+ [^)]*\)/g, ''); // dynamic face lookup
scrubbed = scrubbed.replace(/ASSET\('carpets\/felt' \+ [^)]*\)/g, ''); // dynamic felt-photo lookup
scrubbed = scrubbed.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
scrubbed = scrubbed.split('\n').map((line) => {
  if (line.includes('data:')) return line; // data-URI lines (the asset map)
  const i = line.search(/(^|\s)\/\//);
  return i >= 0 ? line.slice(0, i) : line;
}).join('\n');
for (const bad of ['cards/', 'carpet.jpg', 'cards\\']) {
  if (scrubbed.includes(bad)) {
    throw new Error('bundle still references ' + bad + ' outside ASSET()/map — fix public/index.html');
  }
}
const dataURIs = (html.match(/data:image\//g) || []).length;
// One deliberate extra data URI: the clubs v6 night skyline is
// an inline SVG in CSS — decorative and self-contained, so it
// keeps the guarantee this count protects (no external image
// request) while not being a raster asset.
const svgURIs = (html.match(/data:image\/svg\+xml/g) || []).length;
// The drawn-SVG table carpets (2026-11-11, one iteration) are GONE —
// the felts are real carpet PHOTOS now and ride the asset map like
// the cards, so they are counted by the asset check below, not here.
if (svgURIs !== 2) {
  // Two deliberate decorative SVG data URIs: the clubs v6 night
  // skyline (above) and the card-back gold-star emblem (features
  // batch 2026-11-11, feature 15) — both self-contained CSS decor,
  // same guarantee as the skyline exception.
  throw new Error('expected exactly 2 decorative SVG data URIs (club skyline + card-back emblem), got ' + svgURIs);
}
if (dataURIs - svgURIs !== assetCount) { // the asset map alone (CSS carpet retired with tabnew)
  throw new Error('expected ' + assetCount + ' data URIs in bundle, got ' + dataURIs);
}

// ---- 4: write deploy/ -------------------------------------------------------
fs.writeFileSync(path.join(DEPLOY, 'index.html'), html);
for (const f of ['game.js', 'bots.js', 'social-core.js', 'social-node.js']) fs.copyFileSync(path.join(ROOT, f), path.join(DEPLOY, f));

// The PWA statics ride as FILES beside the bundle (deploy/server.js
// serves them from pinned routes, like the stickers): the manifest,
// the service worker, the apple touch icon and the app icons. They
// are copied, never inlined — a service worker or manifest inside
// the page could not be fetched as its own URL at all.
for (const f of ['manifest.webmanifest', 'sw.js', 'apple-touch-icon.png']) fs.copyFileSync(path.join(PUB, f), path.join(DEPLOY, f));
const DEPLOY_ICONS = path.join(DEPLOY, 'icons');
fs.mkdirSync(DEPLOY_ICONS, { recursive: true });
for (const f of fs.readdirSync(path.join(PUB, 'icons')).filter((x) => /\.png$/i.test(x))) fs.copyFileSync(path.join(PUB, 'icons', f), path.join(DEPLOY_ICONS, f));

console.log('build-deploy: inlined ' + assetCount + ' assets (' +
  cardFiles.length + ' card images + ' + feltFiles.length + ' felt photos + carpet in the map) = ' + dataURIs + ' data URIs (table felts are real carpet photos via ASSET())');
console.log('build-deploy: deploy/index.html = ' + Buffer.byteLength(html) + ' bytes');
console.log('build-deploy: copied game.js, bots.js, social-core.js, social-node.js -> deploy/');
console.log('build-deploy: copied manifest.webmanifest, sw.js, apple-touch-icon.png, icons/ -> deploy/');
