#!/usr/bin/env node
/*
 * build-deploy.js — build the self-contained deploy bundle.
 *
 * deploy/server.js serves ONLY ./index.html from memory and 404s everything
 * else, so the bundle must carry every image inside the page. This script:
 *
 *   1. Reads public/index.html (the client source; all JS image loads go
 *      through the ASSET() resolver — see public/index.html).
 *   2. Builds window.__ASSETS__: { 'carpet.jpg': dataURI, 'cards/<f>': dataURI }
 *      for public/carpet.jpg and EVERY file in public/cards/ (52 faces +
 *      back.png), and injects it just before the main <script>.
 *   3. Inlines the markup image references directly: url("carpet.jpg")
 *      in CSS (TWO places — #scr-game and #scr-home, so the landing's
 *      field is part of the first paint) and the four hero-fan
 *      <img src="cards/…"> tags on the landing (QS/AS/KH/back, likewise
 *      real markup, not JS-assigned — no late-asset flash on open).
 *   4. Copies game.js + bots.js into deploy/ (deploy/server.js is the
 *      deploy variant and is NOT overwritten; deploy/package.json neither).
 *   5. Asserts nothing in the bundle can trigger an external image request:
 *      outside the __ASSETS__ map and ASSET('…') lookups, no 'cards/' or
 *      'carpet.jpg' reference may remain. (The step-3 references are
 *      replaced BEFORE this scrub, so the guarantee is unchanged.)
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
const assetCount = Object.keys(assets).length;
if (assetCount !== 54) {
  throw new Error('expected 54 assets (carpet + 53 cards), got ' + assetCount);
}

// ---- transform the page ----------------------------------------------------
let html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

// 3a: CSS carpet — TWO references outside ASSET(): #scr-game and #scr-home.
// The landing carries its own CSS carpet so the field paints immediately,
// without waiting for the main script / __ASSETS__ (late-asset flash fix).
const cssNeedle = 'url("carpet.jpg")';
if (html.split(cssNeedle).length - 1 !== 2) throw new Error('CSS carpet url not found exactly twice (game + home)');
html = html.split(cssNeedle).join('url("' + assets['carpet.jpg'] + '")');

// 3b: hero-fan <img> tags on the landing — real markup (decoded during
// parse, under the splash veil), inlined with the same data URIs.
const heroFiles = ['cards/QS.png', 'cards/AS.png', 'cards/KH.png', 'cards/back.png'];
for (const f of heroFiles) {
  const needle = 'src="' + f + '"';
  if (html.split(needle).length - 1 !== 1) throw new Error('hero img ' + needle + ' not found exactly once');
  html = html.replace(needle, 'src="' + assets[f] + '"');
}

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
scrubbed = scrubbed.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
scrubbed = scrubbed.split('\n').map((line) => {
  if (line.includes('data:')) return line; // inlined CSS carpet line
  const i = line.search(/(^|\s)\/\//);
  return i >= 0 ? line.slice(0, i) : line;
}).join('\n');
for (const bad of ['cards/', 'carpet.jpg', 'cards\\']) {
  if (scrubbed.includes(bad)) {
    throw new Error('bundle still references ' + bad + ' outside ASSET()/map — fix public/index.html');
  }
}
const dataURIs = (html.match(/data:image\//g) || []).length;
if (dataURIs !== assetCount + 2 + heroFiles.length) { // map + 2 CSS carpets + hero imgs
  throw new Error('expected ' + (assetCount + 2 + heroFiles.length) + ' data URIs in bundle, got ' + dataURIs);
}

// ---- 4: write deploy/ -------------------------------------------------------
fs.writeFileSync(path.join(DEPLOY, 'index.html'), html);
for (const f of ['game.js', 'bots.js', 'social-core.js', 'social-node.js']) fs.copyFileSync(path.join(ROOT, f), path.join(DEPLOY, f));

console.log('build-deploy: inlined ' + assetCount + ' assets (' +
  cardFiles.length + ' card images + carpet) + CSS carpets + hero imgs = ' + dataURIs + ' data URIs');
console.log('build-deploy: deploy/index.html = ' + Buffer.byteLength(html) + ' bytes');
console.log('build-deploy: copied game.js, bots.js, social-core.js, social-node.js -> deploy/');
