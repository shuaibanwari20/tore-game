#!/usr/bin/env node
/*
 * build-deploy.js — build the deploy bundle.
 *
 * deploy/server.js serves the client from files pinned beside it:
 * ./index.html is the page, and since the SPEED PASS (2026-11-11)
 * the game's images are separate cached FILES too — deploy/cards/,
 * deploy/carpets/ (+ thumbs), deploy/carpet.jpg, exactly like the
 * stickers/covers/PWA statics always were. NOTHING is inlined into
 * the page anymore: the bundle used to carry 65 raster data URIs
 * (~9.3 MB of base64 — the whole game was one 13.8 MB file that
 * every open re-downloaded). This script:
 *
 *   1. Reads public/index.html (the client source; all JS image
 *      loads go through the ASSET()/THUMB() resolvers — see
 *      public/index.html) and writes it to deploy/index.html
 *      unchanged.
 *   2. Copies the image folders into deploy/: public/cards/ ->
 *      deploy/cards/, public/carpets/ (incl. thumbs/) ->
 *      deploy/carpets/, public/carpet.jpg -> deploy/carpet.jpg.
 *   3. Copies game.js + bots.js + social-core.js + social-node.js
 *      into deploy/ (deploy/server.js is the deploy variant and is
 *      NOT overwritten; deploy/package.json neither).
 *   4. Copies the PWA statics (manifest, sw.js, apple touch icon,
 *      icons/) from public/ — as before.
 *   5. Asserts the bundle carries NO raster data URI at all: the
 *      only data URIs allowed are the 2 decorative SVG ones (the
 *      clubs v6 night skyline + the card-back gold-star emblem —
 *      self-contained CSS decor). Every ASSET()/THUMB() path the
 *      client can name must exist as a copied file.
 *
 * Usage: node build-deploy.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DEPLOY = path.join(ROOT, 'deploy');

// ---- 1: the page, unchanged ------------------------------------------------
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
if (html.includes('__ASSETS__')) {
  throw new Error('client still references the retired __ASSETS__ inline map — images are files now');
}
const rasterURIs = (html.match(/data:image\/(?!svg\+xml)[a-z+]+;base64/g) || []).length;
if (rasterURIs !== 0) {
  throw new Error('expected 0 raster data URIs in the bundle (images are separate files), got ' + rasterURIs);
}
const svgURIs = (html.match(/data:image\/svg\+xml/g) || []).length;
if (svgURIs !== 2) {
  // Two deliberate decorative SVG data URIs: the clubs v6 night
  // skyline and the card-back gold-star emblem (features batch
  // 2026-11-11, feature 15) — both self-contained CSS decor.
  throw new Error('expected exactly 2 decorative SVG data URIs (club skyline + card-back emblem), got ' + svgURIs);
}
// The stickers exception stays: exactly ONE sticker-path reference
// may exist — the stickerURL() construction.
const stickerRefs = (html.match(/stickers\//g) || []).length;
if (stickerRefs !== 1 || !html.includes("'/stickers/' + id + '.gif'")) {
  throw new Error('sticker files may be referenced ONLY from stickerURL() — found ' +
    stickerRefs + ' sticker path references');
}

// ---- 2-4: copy everything the hosts serve ----------------------------------
function copyDir(srcDir, dstDir, filter) {
  fs.mkdirSync(dstDir, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, f.name), d = path.join(dstDir, f.name);
    if (f.isDirectory()) n += copyDir(s, d, filter);
    else if (!filter || filter(f.name)) { fs.copyFileSync(s, d); n++; }
  }
  return n;
}
fs.writeFileSync(path.join(DEPLOY, 'index.html'), html);
for (const f of ['game.js', 'bots.js', 'social-core.js', 'social-node.js']) fs.copyFileSync(path.join(ROOT, f), path.join(DEPLOY, f));

const imgFiles = /\.(png|jpe?g)$/i;
const nCards = copyDir(path.join(PUB, 'cards'), path.join(DEPLOY, 'cards'), (f) => imgFiles.test(f));
const nCarpets = copyDir(path.join(PUB, 'carpets'), path.join(DEPLOY, 'carpets'), (f) => imgFiles.test(f));
fs.copyFileSync(path.join(PUB, 'carpet.jpg'), path.join(DEPLOY, 'carpet.jpg'));
if (nCards !== 53) throw new Error('expected 53 card files (52 faces + back.png), copied ' + nCards);
if (nCarpets !== 22) throw new Error('expected 22 carpet files (11 full + 11 thumbs), copied ' + nCarpets);

for (const f of ['manifest.webmanifest', 'sw.js', 'apple-touch-icon.png']) fs.copyFileSync(path.join(PUB, f), path.join(DEPLOY, f));
const nIcons = copyDir(path.join(PUB, 'icons'), path.join(DEPLOY, 'icons'), (f) => /\.png$/i.test(f));

console.log('build-deploy: NO inlined assets (speed pass) — 0 raster data URIs, ' + svgURIs + ' decorative SVG data URIs');
console.log('build-deploy: deploy/index.html = ' + Buffer.byteLength(html) + ' bytes');
console.log('build-deploy: copied ' + nCards + ' cards -> deploy/cards/, ' + nCarpets + ' carpets (full+thumbs) -> deploy/carpets/, carpet.jpg -> deploy/');
console.log('build-deploy: copied game.js, bots.js, social-core.js, social-node.js -> deploy/');
console.log('build-deploy: copied manifest.webmanifest, sw.js, apple-touch-icon.png, ' + nIcons + ' icons -> deploy/');
