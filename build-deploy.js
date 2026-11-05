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
 *   3. Inlines the one CSS image reference, url("carpet.jpg"), directly.
 *   4. Copies game.js + bots.js into deploy/ (deploy/server.js is the
 *      deploy variant and is NOT overwritten; deploy/package.json neither).
 *   5. Asserts nothing in the bundle can trigger an external image request:
 *      outside the __ASSETS__ map and ASSET('…') lookups, no 'cards/' or
 *      'carpet.jpg' reference may remain.
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

// 3: CSS carpet — the only image reference outside ASSET().
const cssNeedle = 'url("carpet.jpg")';
if (html.split(cssNeedle).length - 1 !== 1) throw new Error('CSS carpet url not found exactly once');
html = html.replace(cssNeedle, 'url("' + assets['carpet.jpg'] + '")');

// 2: inject the asset map immediately before the main script.
const anchor = "<script>\n'use strict';";
if (!html.includes(anchor)) throw new Error('main <script> anchor not found');
const inject = '<script>\n// ---- Inlined assets (build-deploy.js): deploy server serves only this page ----\n' +
  'window.__ASSETS__ = ' + JSON.stringify(assets) + ';\n</script>\n';
html = html.replace(anchor, inject + anchor);

// ---- 5: prove the bundle cannot request an image from the server ----------
// Remove the injected map, every ASSET('…') lookup and all comments (the
// credits/comments legitimately NAME the files; only load sites matter).
// Nothing image-like may remain afterwards.
let scrubbed = html.replace(/window\.__ASSETS__ = \{.*?\};/s, '');
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
if (dataURIs !== assetCount + 1) { // map entries + the CSS carpet
  throw new Error('expected ' + (assetCount + 1) + ' data URIs in bundle, got ' + dataURIs);
}

// ---- 4: write deploy/ -------------------------------------------------------
fs.writeFileSync(path.join(DEPLOY, 'index.html'), html);
for (const f of ['game.js', 'bots.js']) fs.copyFileSync(path.join(ROOT, f), path.join(DEPLOY, f));

console.log('build-deploy: inlined ' + assetCount + ' assets (' +
  cardFiles.length + ' card images + carpet) + CSS carpet = ' + dataURIs + ' data URIs');
console.log('build-deploy: deploy/index.html = ' + Buffer.byteLength(html) + ' bytes');
console.log('build-deploy: copied game.js, bots.js -> deploy/');
