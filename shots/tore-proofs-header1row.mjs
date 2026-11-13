/**
 * tore-proofs-header1row.mjs — up49 proof (owner order 2026-11-13):
 * the home top bar must put avatar + player NAME + 🪙 pill + 💎 pill +
 * gear in ONE row at real phone widths (390 and 360 CSS px).
 *
 * Root cause of the stacked look on the owner's phone: .hm-pname had
 * no min-width:0, so the name pill could never shrink and the row
 * overflowed at iPhone widths (the 450px proof viewport hid it).
 * Fix: nowrap topbar, min-width:0 + tighter name pill (max 118px),
 * tighter pills/gear, align-items:center.
 *
 *   node shots/tore-proofs-header1row.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium = null;
try {
  chromium = require(path.join(os.homedir(), 'workspace/projects/vault-rental-online/node_modules/playwright-core')).chromium;
} catch { /* fall through */ }
function findChrome() {
  const base = path.join(os.homedir(), '.cache/ms-playwright');
  if (!fs.existsSync(base)) return null;
  for (const dir of fs.readdirSync(base).sort().reverse()) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome-headless-shell-linux/headless_shell']) {
      const p = path.join(base, dir, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const ROOT = path.join(os.homedir(), 'workspace/projects/tore-game');
const SHOTS = path.join(ROOT, 'shots');
const PORT = '8857';
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
};

// ---------------- bundle shape ----------------
const dist = fs.readFileSync(path.join(ROOT, 'cloudflare/dist-client.html'), 'utf8');
check('dist stays code-only (< 1 MB)', Buffer.byteLength(dist) < 1_000_000, Buffer.byteLength(dist) + ' B');
check('dist has the one-row topbar css', dist.includes('flex-wrap: nowrap') && dist.includes('max-width: 150px'));
const workerSrc = fs.readFileSync(path.join(ROOT, 'cloudflare/src/worker.js'), 'utf8');
check('worker.js serves ?v=20261113-header1row', workerSrc.includes('dist-client.html?v=20261113-header1row'));

// ---------------- server ----------------
function spawnServer(args, port) {
  const s = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, PORT: port }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('server did not start on ' + port)), 30000);
    s.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(to); resolve(s); } });
    s.stderr.on('data', (d) => { process.stderr.write('[srv ' + port + '] ' + d); });
    s.on('exit', () => reject(new Error('server exited early on ' + port)));
  });
}
const srv = await spawnServer([path.join(ROOT, 'deploy', 'server.js')], PORT);

const exe = chromium && findChrome();
if (!chromium || !exe) {
  check('browser available', false, 'playwright/chromium unavailable');
  srv.kill();
  process.exit(1);
}
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

async function measure(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('.hm-topbar');
    const prof = document.querySelector('#btn-profile').getBoundingClientRect();
    const wal = document.querySelector('.hm-wallet').getBoundingClientRect();
    const gear = document.querySelector('#btn-settings').getBoundingClientRect();
    const name = document.querySelector('#home-name');
    const nr = name.getBoundingClientRect();
    return {
      barW: Math.round(bar.getBoundingClientRect().width),
      barSW: bar.scrollWidth,
      tops: { prof: Math.round(prof.top), wal: Math.round(wal.top), gear: Math.round(gear.top) },
      heights: { prof: Math.round(prof.height), wal: Math.round(wal.height), gear: Math.round(gear.height) },
      nameW: Math.round(nr.width), nameTxt: name.textContent.trim(),
      nameFull: name.scrollWidth <= name.clientWidth + 1,
      gearRight: Math.round(gear.right), vw: window.innerWidth,
    };
  });
}

try {
  for (const w of [430, 393, 375, 360]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 844 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('#btn-quick', { state: 'visible', timeout: 60000 });
    await sleep(900);
    // the owner's real display name + real balances
    await page.evaluate(() => {
      document.querySelector('#home-name').textContent = 'Shuaib Anwari';
      document.querySelector('#wallet-coins').textContent = '1150';
      document.querySelector('#wallet-gems').textContent = '0';
    });
    await sleep(250);
    const m = await measure(page);
    const centers = {
      prof: m.tops.prof + m.heights.prof / 2,
      wal: m.tops.wal + m.heights.wal / 2,
      gear: m.tops.gear + m.heights.gear / 2,
    };
    const cvals = Object.values(centers);
    const spread = Math.max(...cvals) - Math.min(...cvals);
    check(`@${w}px one row: profile/wallet/gear centres aligned (spread <= 6px)`, spread <= 6, JSON.stringify(centers) + ' name=' + m.nameTxt + ' nameW=' + m.nameW);
    check(`@${w}px no horizontal overflow (scrollWidth <= bar width)`, m.barSW <= m.barW + 1, `sw=${m.barSW} w=${m.barW}`);
    if (w >= 375) check(`@${w}px full name visible (no ellipsis)`, m.nameFull, `nameW=${m.nameW}`);
    check(`@${w}px gear inside viewport`, m.gearRight <= m.vw, `right=${m.gearRight} vw=${m.vw}`);
    check(`@${w}px no page errors`, errors.length === 0, errors.join(' | '));
    if (w === 430) {
      await page.screenshot({ path: path.join(SHOTS, 'up49-header-430-FRESH.jpg'), type: 'jpeg', quality: 88 });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  srv.kill();
}
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
