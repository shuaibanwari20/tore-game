#!/usr/bin/env node
/**
 * build-client.mjs — produce the Cloudflare flavour of the client.
 *
 * ../public/index.html is the source of truth and ../build-deploy.js
 * already turns it into the self-contained ../deploy/index.html. This
 * script takes THAT bundle and applies the only two Cloudflare deltas:
 *   1. the WebSocket URL gains the /ws path (the Worker routes upgrades
 *      there; the Node server accepts any path, which is why the shared
 *      client connects to the bare host);
 *   2. the auth-gate snippet (../auth-gate.js) is injected before
 *      </body> — it stays inert unless the Worker says the gate is on.
 *
 * Output: cloudflare/client/index.html (local copy) AND
 * cloudflare/dist-client.html — the committed file the deployed
 * Worker fetches from this repo's GitHub raw URL (no KV anymore):
 *   https://raw.githubusercontent.com/shuaibanwari20/tore-game/main/cloudflare/dist-client.html
 * Rebuild + commit dist-client.html in the publish flow whenever the
 * client changes. Steps 0 (sync modules) and the deploy build run
 * automatically so one command refreshes everything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CF = path.join(HERE, '..');
const ROOT = path.join(CF, '..');

execFileSync('node', [path.join(HERE, 'sync-modules.mjs')], { stdio: 'inherit' });
execFileSync('node', [path.join(ROOT, 'build-deploy.js')], { stdio: 'inherit' });

let html = fs.readFileSync(path.join(ROOT, 'deploy', 'index.html'), 'utf8');

// 1) WS path.
const wsNeedle = 'new WebSocket(proto + location.host)';
if (html.split(wsNeedle).length - 1 !== 1) {
  throw new Error('WS connect line not found exactly once — client changed?');
}
html = html.replace(wsNeedle, "new WebSocket(proto + location.host + '/ws')");

// 2) Auth gate injection.
const gate = fs.readFileSync(path.join(CF, 'auth-gate.js'), 'utf8');
if (html.split('</body>').length - 1 !== 1) throw new Error('</body> not found exactly once');
html = html.replace('</body>', '<script>\n' + gate + '\n</script>\n</body>');

// 3) Comment strip (up47): the dist is the file every phone
// downloads from GitHub Raw, and the cardsfix budget keeps it
// under 1 MB. The heavily-commented sources stay the source of
// truth (deploy/index.html, which the Node hosts serve, is NOT
// stripped) — only this committed dist loses its JS comments,
// via esbuild's parser (never a regex: strings, template
// literals and regexes survive untouched; identifiers and
// formatting are preserved — legalComments:'none' with no
// minification). A block whose transform fails or comes out
// LARGER is kept verbatim. If esbuild is unavailable the build
// proceeds unstripped with a warning.
try {
  const { createRequire } = await import('node:module');
  const req = createRequire(path.join(CF, 'package.json'));
  const esbuild = req('esbuild');
  let savedTotal = 0;
  html = html.replace(/<script>([\s\S]*?)<\/script>/g, (whole, code) => {
    if (!code.trim()) return whole;
    try {
      const out = esbuild.transformSync(code, { loader: 'js', legalComments: 'none' }).code;
      if (out.length < code.length) { savedTotal += code.length - out.length; return '<script>' + out + '</script>'; }
    } catch (e) { /* keep the block verbatim */ }
    return whole;
  });
  console.log('build-client: comment strip saved ' + savedTotal + ' bytes');
} catch (e) {
  console.log('build-client: WARNING — esbuild unavailable, dist NOT comment-stripped (' + (e && e.message) + ')');
}

const out = path.join(CF, 'client', 'index.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log('build-client: cloudflare/client/index.html = ' + Buffer.byteLength(html) + ' bytes');

// The Worker serves THIS committed file via the repo's GitHub raw URL.
const dist = path.join(CF, 'dist-client.html');
fs.writeFileSync(dist, html);
console.log('build-client: cloudflare/dist-client.html = ' + Buffer.byteLength(html) + ' bytes (commit this)');
