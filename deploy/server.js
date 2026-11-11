'use strict';
/**
 * TORE (توره) — authoritative game server.
 * Node + ws. Serves the client (./index.html) plus its image FILES
 * (./cards/, ./carpets/, ./carpet.jpg — separate cached files since
 * the speed pass; nothing is inlined into the page anymore) and runs
 * all game rules through game.js (the same module sim.js tests).
 * Clients only render.
 *
 * Run:  PORT=3000 node server.js     (PORT env, default 3000)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const G = require('./game');
const bots = require('./bots');
const { createNodeSocial } = require('./social-node');

// ---- Tunables (one line each) ----
const PORT = process.env.PORT || 3000;
const TURN_TIMEOUT_MS = 30000;    // a stalled human seat is played by a bot
const BOT_DELAY_MS = 750;         // bot "thinking" delay (watchable pace)
const ROUND_PAUSE_MS = 8000;      // round-summary pause before next round (6s -> 8s, owner 2026-11-11; a tap dismisses the card early on the tapper's screen only)
const TRICK_PAUSE_MS = 1600;      // completed trick stays on the table before it is collected
const RECONNECT_GRACE_MS = 120000; // seat+hand kept for a reconnecting player
const REMATCH_OFFER_MS = 30000;   // a rematch offer lives 30 s, then expires
const SPECTATOR_CAP = 20;          // clubs v8: watchers per club-game room

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'));
const STICKERS_DIR = path.join(__dirname, 'stickers');
const COVERS_DIR = path.join(__dirname, 'covers');
const ICONS_DIR = path.join(__dirname, 'icons');
const CARDS_DIR = path.join(__dirname, 'cards');
const CARPETS_DIR = path.join(__dirname, 'carpets');

const httpServer = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  // Uploaded club covers ride their own routes (handlers below):
  // POST /club-cover is the club owner's photo upload; GET
  // /club-cover/<cid> serves that club's photo publicly.
  if (url === '/club-cover' && req.method === 'POST') return handleCoverUpload(req, res);
  if (url.startsWith('/club-cover/') && req.method === 'GET') return handleCoverGet(req, res, url.slice('/club-cover/'.length));
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(INDEX_HTML);
  }
  // The chat GIF stickers are the one asset served as files (never
  // inlined into the bundle, so it stays light): /stickers/stN.gif
  // from ./stickers. The name is pinned to the known set — no other
  // path under this server exists.
  if (url.startsWith('/stickers/')) {
    const name = url.slice('/stickers/'.length);
    if (/^st([1-9]|1[0-6])\.gif$/.test(name)) {
      const full = path.join(STICKERS_DIR, name);
      if (fs.existsSync(full)) {
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'public, max-age=86400' });
        return fs.createReadStream(full).pipe(res);
      }
    }
    res.writeHead(404); return res.end('not found');
  }
  // The PWA statics (copied here by build-deploy.js from public/):
  // the manifest and the service worker are served no-cache so an
  // update lands at once; the icons ride the long cache like the
  // stickers. Only the known file set exists.
  if (url === '/manifest.webmanifest' || url === '/sw.js') {
    const name = url.slice(1);
    const full = path.join(__dirname, name);
    if (fs.existsSync(full)) {
      res.writeHead(200, {
        'Content-Type': name === 'sw.js' ? 'text/javascript' : 'application/manifest+json',
        'Cache-Control': 'no-cache',
      });
      return fs.createReadStream(full).pipe(res);
    }
    res.writeHead(404); return res.end('not found');
  }
  if (url === '/apple-touch-icon.png' || url.startsWith('/icons/')) {
    const name = url === '/apple-touch-icon.png' ? 'apple-touch-icon.png' : url.slice('/icons/'.length);
    const pinned = url === '/apple-touch-icon.png'
      ? path.join(__dirname, name)
      : (/^icon-(192|512|512-maskable)\.png$/.test(name) ? path.join(ICONS_DIR, name) : null);
    if (pinned && fs.existsSync(pinned)) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(pinned).pipe(res);
    }
    res.writeHead(404); return res.end('not found');
  }
  // The game IMAGE files (speed pass): the deck faces, the felt
  // photos (+ their picker thumbs) and the original carpet — copied
  // here by build-deploy.js from public/. Pinned to the known file
  // sets, long-cached like the stickers: after the first download a
  // phone never pulls them again (the service worker caches them
  // too). The page itself references them only via ASSET()/THUMB().
  if (url.startsWith('/cards/')) {
    const name = url.slice('/cards/'.length);
    if (/^([2-9TJQKA][CDHS]|back)\.png$/.test(name)) {
      const full = path.join(CARDS_DIR, name);
      if (fs.existsSync(full)) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        return fs.createReadStream(full).pipe(res);
      }
    }
    res.writeHead(404); return res.end('not found');
  }
  if (url.startsWith('/carpets/')) {
    const rest = url.slice('/carpets/'.length);
    const m = rest.match(/^(thumbs\/)?felt([1-9]|1[01])\.jpg$/);
    if (m) {
      const full = path.join(CARPETS_DIR, rest);
      if (fs.existsSync(full)) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
        return fs.createReadStream(full).pipe(res);
      }
    }
    res.writeHead(404); return res.end('not found');
  }
  if (url === '/carpet.jpg') {
    const full = path.join(__dirname, 'carpet.jpg');
    if (fs.existsSync(full)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(full).pipe(res);
    }
    res.writeHead(404); return res.end('not found');
  }
  // The built-in cover gallery photos are static files like the
  // stickers: /covers/<id>.jpg from ./covers, pinned to the
  // known gallery ids.
  if (url.startsWith('/covers/')) {
    const name = url.slice('/covers/'.length);
    if (/^(mountains|mosque|caravan|pomegranate|city|carpet|eagle|river|tent|trophy)\.jpg$/.test(name)) {
      const full = path.join(COVERS_DIR, name);
      if (fs.existsSync(full)) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
        return fs.createReadStream(full).pipe(res);
      }
    }
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(404); return res.end('not found');
});

const wss = new WebSocketServer({ server: httpServer });

// ---------------------------------------------------------------- rooms
const rooms = new Map();
// Busy-flag liveness (stale-busy fix, 2026-11-09): a seat counts
// toward "in a game / in a lobby" only while its player is actually
// there — connected, or disconnected inside the reconnect grace
// (a transient drop; the client auto-reconnects within seconds).
// A lobby seat stays RESERVED past that (the sweep never expires a
// waiting room, so the player can always reconnect back into it),
// but a long-dead seat must not report its owner busy forever.
// TORE_BUSY_GRACE_MS is a test lever only; production uses the
// reconnect grace.
const BUSY_GRACE_MS = (() => {
  const v = Number(process.env.TORE_BUSY_GRACE_MS);
  return Number.isFinite(v) && v >= 0 ? v : RECONNECT_GRACE_MS;
})();
function seatLive(s, now) {
  return s.connected || (!!s.disconnectAt && (now || Date.now()) - s.disconnectAt <= BUSY_GRACE_MS);
}
// Friend spectate lookup (social hook watchLookup): the room
// this identity is SEATED in as a human while a match is on the
// table (playing / roundEnd / matchEnd) — {code} or null. The
// core pairs it with its friendship graph (canWatch) to admit
// friend spectators; the host only reports the seat.
function watchLookupSid(id) {
  if (!id) return null;
  for (const room of rooms.values()) {
    if (room.phase !== 'playing' && room.phase !== 'roundEnd' && room.phase !== 'matchEnd') continue;
    if (room.seats.some((s) => s.kind === 'human' && s.sid === id)) return { code: room.code };
  }
  return null;
}
// Friends system (ملګري): a second WebSocket endpoint, /social, on
// this same server (see social-core.js / social-node.js). Identity on
// the Node hosts is the persistent client player id (p:<pid>); the
// invite check is the spec fallback — the room exists and is still
// in its lobby phase.
function sidInGame(id) {
  if (!id) return false;
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase === 'lobby') continue;
    if (room.seats.some((s) => s.kind === 'human' && s.sid === id && seatLive(s, now))) return true;
  }
  return false;
}
// A seat in a WAITING room: lobby-sitters are uninvitable too
// (owner order 2026-11-09) — the social core reports them socialBusy.
function sidInLobby(id) {
  if (!id) return false;
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase !== 'lobby') continue;
    if (room.seats.some((s) => s.kind === 'human' && s.sid === id && seatLive(s, now))) return true;
  }
  return false;
}
// Invite-time verification (stale-busy fix, 2026-11-09): re-check
// the busy claim against live room state. Every seat of this
// identity that is NOT live (socket dead past the busy grace — the
// app was closed without leaving) is reaped on the spot: a lobby
// seat is freed (the first remaining human becomes host, exactly
// like a guest leaving; a lobby left with no humans is deleted),
// an in-match seat gets the sweep's bot conversion. The corrected
// presence is pushed via syncBusyFor, and the VERIFIED state is
// returned: 'match' | 'lobby' | ''. Live seats verify unchanged.
function verifyBusySid(id) {
  if (!id) return '';
  const now = Date.now();
  let state = '';
  for (const room of [...rooms.values()]) {
    let changed = false;
    room.seats.forEach((s, i) => {
      if (s.kind !== 'human' || s.sid !== id) return;
      if (seatLive(s, now)) {
        if (room.phase !== 'lobby') state = 'match';
        else if (!state) state = 'lobby';
        return;
      }
      if (room.phase === 'lobby') {
        room.seats[i] = emptySeat();
      } else {
        s.kind = 'bot'; // bot takes over the seat and its hand
        s.avatar = null;
        s.country = '';
        s.photo = null;
        s.sid = null;
        s.voiceMic = false;
        s.voiceSpeaker = false;
        s.connected = true;
        s.disconnectAt = null;
        pumpTurn(room);
      }
      changed = true;
    });
    if (changed) {
      if (room.rematch) cancelRematch(room, 'left'); // a reaped seat kills a live offer
      broadcastState(room);
      const anyHuman = room.seats.some((s) => s.kind === 'human');
      if (!anyHuman) {
        clearTimeout(room.turnTimer);
        clearTimeout(room.roundTimer);
        clearTimeout(room.trickTimer);
        sendToSpectators(room, { type: 'roomClosed', code: 'roomCancelled' });
        rooms.delete(room.code);
        syncClubGame(room);
      }
    }
  }
  syncBusyFor(null, [id]);
  return state;
}
function syncBusyFor(room, extraSids) {
  const ids = new Set(extraSids || []);
  if (room) room.seats.forEach((s) => { if (s.sid) ids.add(s.sid); });
  ids.forEach((id) => { try { social.core.syncBusy(id); } catch (e) { /* social never breaks the game */ } });
}
const social = createNodeSocial({
  roomCheck: (id, code) => {
    const room = rooms.get(code);
    return !!room && room.phase === 'lobby';
  },
  // Invite source badge (2026-11-11): the room's club stamp.
  roomClub: (id, code) => {
    const room = rooms.get(code);
    return room && room.club ? { cid: room.club.cid, name: room.club.name } : null;
  },
  inGameCheck: sidInGame,
  inLobbyCheck: sidInLobby,
  verifyBusy: verifyBusySid,
  // Clubs v8: the club's live game room, scanned from the room table.
  clubGameLookup: (cid) => lookupClubGame(cid),
  // Friend spectate + club-vs-club hooks. NOTE for the
  // integrator: social-node.js builds the SocialCore hooks and
  // must forward these two opts into the core (one line each,
  // same pattern as clubGameLookup above):
  //   watchLookup(id) { return opts.watchLookup ? opts.watchLookup(id) : null; },
  //   vsStartMatch(spec) { return opts.vsStartMatch ? opts.vsStartMatch(spec) : null; },
  // Until that forward lands they are also attached onto the
  // social object directly below, so they can be wired by hand.
  watchLookup: watchLookupSid,
  vsStartMatch: vsStartMatchRoom,
});
social.watchLookup = watchLookupSid;
social.vsStartMatch = vsStartMatchRoom;

// ------------------------------------------------------------ club games (v8)
// A room stamped as a club game (room.club = {cid, name}, granted
// ONLY by social.core.clubGameClub at create time) is findable by
// its club while it waits or plays — the club room's game button
// badges it and routes member spectators to it.
const CLUB_GAME_PHASES = ['lobby', 'playing', 'roundEnd'];
function lookupClubGame(cid) {
  for (const room of rooms.values()) {
    if (room.club && room.club.cid === cid && CLUB_GAME_PHASES.includes(room.phase)) {
      return { code: room.code, phase: room.phase };
    }
  }
  return null;
}
function syncClubGame(room) {
  if (room && room.club) {
    try { social.core.clubGameChanged(room.club.cid); } catch (e) { /* social never breaks the game */ }
  }
}

// ------------------------------------------ club-vs-club (feature 11)
// Display name for a vs club stamp. The core's public summary
// (clubSummary) takes the club RECORD, not a cid, and the core
// exposes no cid→record getter — so resolve through the record
// when the in-process core instance exposes it, else fall back
// to the cid itself as the display name.
function vsClubName(cid, viewerId) {
  const core = social.core;
  try {
    if (core && typeof core.clubSummary === 'function') {
      let rec = null;
      if (core.clubs && typeof core.clubs.get === 'function') rec = core.clubs.get(String(cid));
      if (!rec && viewerId && typeof core.ownedClub === 'function') {
        const own = core.ownedClub(viewerId);
        if (own && String(own.cid) === String(cid)) rec = own;
      }
      if (rec) {
        const s = core.clubSummary(rec, viewerId);
        if (s && s.name) return s.name;
        if (rec.name) return rec.name;
      }
    }
  } catch (e) { /* fall through to the cid */ }
  return String(cid);
}

// Social hook (vsStartMatch): create a room reserved for two
// clubs' chosen pairs — seat0/seat2 = playersA (team 0 = club
// A), seat1/seat3 = playersB (team 1 = club B). Every one of
// the four ids must currently be FREE (not seated in any room;
// a reserved lobby seat counts as busy) or the whole request
// fails with null and no room is created. Reserved seats are
// kind 'human' with their sid set and connected=false; the
// join handler attaches each player to his reserved seat and
// rejects anyone else ('vsOnly'). The match auto-starts when
// all four reserved seats are connected (see maybeStartVs).
function vsStartMatchRoom(spec) {
  try {
    if (!spec || typeof spec !== 'object') return null;
    const clubA = spec.clubA, clubB = spec.clubB;
    const playersA = Array.isArray(spec.playersA) ? spec.playersA : [];
    const playersB = Array.isArray(spec.playersB) ? spec.playersB : [];
    if (!clubA || !clubB || playersA.length !== 2 || playersB.length !== 2) return null;
    const ids = [...playersA, ...playersB];
    if (ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== 4) return null;
    for (const id of ids) {
      for (const r of rooms.values()) {
        if (r.seats.some((s) => s.kind === 'human' && s.sid === id)) return null;
      }
    }
    const core = social.core;
    const room = createRoom();
    room.club = null; // a vs room is NOT a club game — it carries the vs stamp instead
    room.vs = { a: clubA, b: clubB };
    room.vsNames = { a: vsClubName(clubA, playersA[0]), b: vsClubName(clubB, playersB[0]) };
    const order = [playersA[0], playersB[0], playersA[1], playersB[1]];
    order.forEach((pid, idx) => {
      const seat = room.seats[idx];
      seat.kind = 'human';
      seat.sid = pid;
      seat.connected = false;
      seat.disconnectAt = null;
      seat.token = crypto.randomBytes(8).toString('hex');
      // Name/profile from the social directory when the player
      // has one; otherwise the name stays '' and the join fills it.
      if (core && typeof core.person === 'function') {
        try {
          const p = core.person(pid);
          if (p) {
            if (p.name) seat.name = cleanName(p.name);
            seat.avatar = cleanAvatar(p.avatar);
            seat.country = cleanCountry(p.country);
            seat.photo = seat.avatar === 'google' ? cleanPhoto(p.photo) : null;
          }
        } catch (e) { /* directory is best-effort */ }
      }
    });
    syncBusyFor(room);
    return { code: room.code };
  } catch (e) { return null; }
}

// A vs room starts itself the moment all four reserved seats
// are connected — checked after every join/reconnect.
function maybeStartVs(room) {
  if (!room || !room.vs || room.phase !== 'lobby') return;
  if (room.seats.every((s) => s.kind === 'human' && s.connected)) startMatch(room);
}

// ------------------------------------------------ uploaded club covers
// POST /club-cover — a club owner uploads his club's cover photo.
// Node hosts have no sign-in: identity is the same persistent
// player id the /social hello uses, sent as the x-tore-pid header
// (the production Worker instead derives it from the verified
// session cookie and never trusts this header). The image never
// rides the social socket (message caps) — it lands in the social
// layer's cover store and the club record flips to 'custom'.
// Hard rules: owner-only, image/jpeg|png|webp, at most 250 KB.
const COVER_MAX_BYTES = 250 * 1024;
const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
function coverJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function handleCoverUpload(req, res) {
  const pid = req.headers['x-tore-pid'];
  if (typeof pid !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(pid)) return coverJson(res, 401, { error: 'unauthorized' });
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!COVER_TYPES.includes(type)) return coverJson(res, 415, { error: 'coverBadType' });
  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (ch) => {
    size += ch.length;
    if (size > COVER_MAX_BYTES) { tooBig = true; return; }
    chunks.push(ch);
  });
  req.on('end', () => {
    if (tooBig) return coverJson(res, 413, { error: 'coverTooBig' });
    const buf = Buffer.concat(chunks);
    if (!buf.length) return coverJson(res, 400, { error: 'coverEmpty' });
    const out = social.uploadCover('p:' + pid, type, buf);
    if (!out) return coverJson(res, 403, { error: 'clubNoPerm' });
    return coverJson(res, 200, { ok: true, cid: out.cid, v: out.v });
  });
  req.on('error', () => { try { res.writeHead(400); res.end(); } catch (e) { /* gone */ } });
}
function handleCoverGet(req, res, cid) {
  if (!/^\d{6}$/.test(cid)) { res.writeHead(404); return res.end('not found'); }
  const entry = social.getCover(cid);
  if (!entry) { res.writeHead(404); return res.end('not found'); }
  // The ?v=<coverV> query is the cache key: a new upload bumps it,
  // so a year-long immutable cache is safe.
  res.writeHead(200, {
    'Content-Type': entry.type,
    'Content-Length': entry.buf.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  res.end(entry.buf);
}
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function emptySeat() {
  return { kind: 'empty', name: '', avatar: null, country: '', photo: null, token: null, ws: null, connected: false, disconnectAt: null, voiceMic: false, voiceSpeaker: true, lastChatAt: 0, sid: null };
}

function createRoom() {
  const room = {
    code: newCode(),
    seats: [emptySeat(), emptySeat(), emptySeat(), emptySeat()],
    phase: 'lobby', // lobby | playing | roundEnd | matchEnd
    match: null,
    turnTimer: null,
    roundTimer: null,
    trickTimer: null,
    trickHold: null, // { plays: [{seat, card}...], winnerSeat } while a finished trick is displayed
    club: null, // clubs v8: {cid, name} when a club manager created this room as a club game
    felt: 11, // the creator's table felt (1..11) — set from the create frame, fixed for the room's life
    back: 1, // the creator's card back (1..6) — set from the create frame, fixed for the room's life
    vs: null, // club-vs-club stamp {a, b} (cids) — only the social core's vsStartMatch hook sets it
    vsNames: null, // {a, b} display names for the vs stamp
    rematch: null, // runtime-only rematch offer {bySid, bySeat, expires, accepts:Set<sid>}
    rematchTimer: null, // expiry timer for the live rematch offer
    statsRecorded: false, // match-end stats guard: set when recorded, cleared when a new match starts
    spectators: new Set(), // clubs v8: receive-only sockets watching the public state
  };
  room.emit = (evt) => onMatchEvent(room, evt);
  rooms.set(room.code, room);
  return room;
}

function hostSeat(room) {
  const i = room.seats.findIndex((s) => s.kind === 'human');
  return i === -1 ? 0 : i;
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// Every error carries a stable machine `code` next to the Dari
// `message`: the client translates by code into the player's chosen
// language and falls back to the raw Dari text when a code is unknown.
// `extra` merges payload fields (e.g. { suit } for mustFollowSuit).
function sendError(ws, msg, code, extra) {
  send(ws, Object.assign({ type: 'error', message: msg, code }, extra || {}));
}

// ------------------------------------------------------------- state push
function stateFor(room, seatIdx) {
  const round = room.match ? room.match.round : null;
  const last = room.match && room.match.history.length
    ? room.match.history[room.match.history.length - 1] : null;
  return {
    type: 'state',
    phase: room.phase,
    code: room.code,
    club: room.club ? { cid: room.club.cid, name: room.club.name } : null,
    felt: room.felt || 11,
    back: room.back || 1,
    vs: room.vs ? {
      a: { cid: room.vs.a, name: (room.vsNames && room.vsNames.a) || room.vs.a },
      b: { cid: room.vs.b, name: (room.vsNames && room.vsNames.b) || room.vs.b },
    } : null,
    mySeat: seatIdx,
    hostSeat: hostSeat(room),
    target: G.BANK_LOSE_TARGET,
    seats: room.seats.map((s, i) => ({
      name: s.name, kind: s.kind, connected: s.connected,
      avatar: s.avatar, country: s.country, photo: s.photo, sid: s.sid || null,
      uid: s.sid ? social.core.uidOf(s.sid) : null,
      voice: { mic: !!s.voiceMic, speaker: s.voiceSpeaker !== false },
      cards: round ? round.hands[i].length : 0,
    })),
    hand: round ? round.hands[seatIdx].slice() : [],
    trick: room.trickHold
      ? room.trickHold.plays.map((p) => ({ seat: p.seat, card: p.card }))
      : round ? round.trick.map((p) => ({ seat: p.seat, card: p.card })) : [],
    trickWinner: room.trickHold ? room.trickHold.winnerSeat : null,
    turn: round && !round.finished ? round.turn : null,
    legal: round ? round.legalMovesFor(seatIdx) : [],
    bankedTawan: room.match ? room.match.bankedTawan.slice() : [0, 0],
    roundTawan: round
      ? [G.tawanOf(round.captured[0]), G.tawanOf(round.captured[1])] : [0, 0],
    takanCount: round ? round.takanCount.slice() : [0, 0],
    pendingTakan: room.match ? room.match.pendingTakan.slice() : [0, 0],
    piles: round ? round.wonTricks.slice() : [0, 0, 0, 0],
    canDeclare13: round && !room.trickHold ? round.canDeclare13(seatIdx) : false,
    declared13: round ? round.declared13 : false,
    roundNo: room.match ? room.match.roundNo : 0,
    roundResult: (room.phase === 'roundEnd' || room.phase === 'matchEnd') ? last : null,
    matchWinner: room.match && room.match.finished ? room.match.winner : null,
    matchLoser: room.match && room.match.finished ? room.match.loser : null,
    rematch: room.rematch ? {
      bySeat: room.rematch.bySeat,
      expiresIn: Math.max(0, Math.ceil((room.rematch.expires - Date.now()) / 1000)),
      acceptedSeats: room.seats
        .map((s, i) => (s.kind === 'human' && s.sid && room.rematch.accepts.has(s.sid)) ? i : -1)
        .filter((i) => i >= 0),
      totalHumans: room.seats.filter((s) => s.kind === 'human' && s.sid).length,
    } : null,
  };
}

// Clubs v8 — the SPECTATOR state: the full public table (seats,
// badges, trick, won piles, scores, turn) with every hand
// stripped. Built from a seat's push with the private fields
// blanked — hand [], legal [], no declare-13, mySeat -1. The
// roundResult rides along: game.js history carries only round
// aggregates (tawan/banked counts), never a card in hand.
function publicStateFor(room) {
  const st = stateFor(room, 0);
  st.mySeat = -1;
  st.spectator = true;
  st.hand = [];
  st.legal = [];
  st.canDeclare13 = false;
  return st;
}

function sendToSpectators(room, obj) {
  if (!room.spectators || !room.spectators.size) return;
  for (const sws of [...room.spectators]) {
    if (sws.readyState === sws.OPEN) send(sws, obj);
    else room.spectators.delete(sws);
  }
}

function broadcastState(room) {
  room.seats.forEach((s, i) => {
    if (s.kind === 'human' && s.connected && s.ws) send(s.ws, stateFor(room, i));
  });
  sendToSpectators(room, publicStateFor(room));
  syncBusyFor(room);
}

// ------------------------------------------------------------ game flow
function broadcastEvent(room, obj) {
  room.seats.forEach((s) => {
    if (s.kind === 'human' && s.connected && s.ws) send(s.ws, obj);
  });
  // Public table events (takan, declared 13, preset chat, voice
  // flags) are part of what a spectator watches — hands never
  // ride events, so the fan-out is safe as-is.
  sendToSpectators(room, obj);
}

// ------------------------------------------------ rematch (feature 4)
function rematchHumans(room) {
  const out = [];
  room.seats.forEach((s, i) => { if (s.kind === 'human' && s.sid) out.push({ sid: s.sid, seat: i }); });
  return out;
}
// Cancel a live offer: drop it, disarm its expiry timer, and
// tell every seat + spectator exactly once. Callers push the
// fresh state (every cancel site already broadcasts).
function cancelRematch(room, reason) {
  if (!room || !room.rematch) return false;
  room.rematch = null;
  if (room.rematchTimer) { clearTimeout(room.rematchTimer); room.rematchTimer = null; }
  broadcastEvent(room, { type: 'rematch-cancelled', reason });
  return true;
}
function expireRematchIfNeeded(room) {
  if (room && room.rematch && Date.now() >= room.rematch.expires) {
    cancelRematch(room, 'expired');
    broadcastState(room);
    return true;
  }
  return false;
}
function armRematchTimer(room) {
  if (room.rematchTimer) clearTimeout(room.rematchTimer);
  const delay = Math.max(0, room.rematch.expires - Date.now());
  room.rematchTimer = setTimeout(() => {
    room.rematchTimer = null;
    if (!rooms.has(room.code)) return;
    expireRematchIfNeeded(room);
  }, delay);
}

// --------------------------------- stats + vs result (features 5 + 11)
// Called ONCE per finished match from the matchFinished event
// (room.statsRecorded is the guard; startMatch clears it).
// Entries: one per human seat — won = the seat's team is the
// match winner (game.js: winner is the WINNING team index,
// the team that did NOT reach 210; team of a seat = seat % 2).
// For a vs room the winning team's club also scores the vs
// result (team 0 = club A, team 1 = club B). The core methods
// are called defensively (they land in a parallel workstream).
function recordMatchStats(room) {
  if (room.statsRecorded) return;
  room.statsRecorded = true;
  const m = room.match;
  if (!m || !m.finished || (m.winner !== 0 && m.winner !== 1)) return;
  const core = social.core;
  if (!core) return;
  const entries = [];
  room.seats.forEach((s, i) => {
    if (s.kind === 'human' && s.sid) entries.push({ id: s.sid, won: (i % 2) === m.winner });
  });
  try {
    if (entries.length && typeof core.recordMatchEnd === 'function') {
      const r = core.recordMatchEnd(entries);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    }
  } catch (e) { /* social never breaks the game */ }
  try {
    if (room.vs && typeof core.recordVsResult === 'function') {
      const winnerCid = m.winner === 0 ? room.vs.a : room.vs.b;
      const r = core.recordVsResult(room.vs.a, room.vs.b, winnerCid);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    }
  } catch (e) { /* social never breaks the game */ }
}

function onMatchEvent(room, evt) {
  if (evt.type === 'takan') {
    // Celebrate/flag the takan live; the following state push carries the
    // updated star count.
    broadcastEvent(room, { type: 'takan', seat: evt.seat, team: evt.team, count: evt.count });
  } else if (evt.type === 'declared13') {
    broadcastEvent(room, { type: 'declared13', seat: evt.seat });
  }
  if (evt.type === 'roundFinished') {
    room.phase = 'roundEnd';
    clearTimeout(room.turnTimer);
    broadcastState(room);
    clearTimeout(room.roundTimer);
    room.roundTimer = setTimeout(() => {
      if (!rooms.has(room.code) || room.match.finished) return;
      room.phase = 'playing';
      room.match.startRound();
      broadcastState(room);
      pumpTurn(room);
    }, ROUND_PAUSE_MS);
  } else if (evt.type === 'matchFinished') {
    room.phase = 'matchEnd';
    clearTimeout(room.turnTimer);
    clearTimeout(room.roundTimer);
    recordMatchStats(room); // features 5+11: player stats + vs result, once per match
    broadcastState(room);
    syncClubGame(room); // clubs v8: the club game ended — the button badge clears
  }
  // cardPlayed / trickWon need no immediate push: state is pushed after
  // every completed play() call in doPlay().
}

function doPlay(room, seat, card) {
  const round = room.match && room.match.round;
  if (!round) return false;
  if (room.trickHold) return false; // finished trick still on display — plays wait for the pause
  const tricksBefore = round.tricksPlayed;
  const trickBefore = round.trick.slice();
  try {
    round.play(seat, card);
  } catch (e) {
    return false; // illegal — caller decides how to complain
  }
  if (round.tricksPlayed > tricksBefore) {
    // Trick just completed. Rules-wise it is already scored and collected in
    // game.js; presentation-wise we hold all 4 cards on the table for
    // TRICK_PAUSE_MS so everyone can see the last card and who won, and only
    // then show the empty table and arm the winner's lead.
    room.trickHold = {
      plays: trickBefore.concat([{ seat, card }]),
      winnerSeat: round.turn, // play() leaves turn on the trick winner
    };
    clearTimeout(room.turnTimer);
    broadcastState(room);
    clearTimeout(room.trickTimer);
    room.trickTimer = setTimeout(() => {
      room.trickHold = null;
      if (!rooms.has(room.code)) return;
      broadcastState(room);
      pumpTurn(room);
    }, TRICK_PAUSE_MS);
    return true;
  }
  broadcastState(room);
  pumpTurn(room);
  return true;
}

/**
 * Play a seat by bot logic. `mayDeclare` is true only for real bot seats:
 * bots always declare «13» on the final trick when it cancels a takan.
 * A human seat auto-played by the turn timer plays WITHOUT declaring
 * (spec: on timeout the takan stands).
 */
function botPlay(room, seat, mayDeclare) {
  const round = room.match && room.match.round;
  if (!round || round.finished || round.turn !== seat) return;
  if (room.trickHold) return;
  if (mayDeclare && bots.maybeDeclare13(round, seat)) {
    broadcastState(room); // clients toast the declaration…
    pumpTurn(room);       // …then the bot plays its card on the next tick
    return;
  }
  let card;
  try { card = bots.chooseCard(round, seat); } catch (e) { return; }
  doPlay(room, seat, card);
}

/** (Re)arm the action for whoever is on turn: bot → quick, human → 30 s. */
function pumpTurn(room) {
  clearTimeout(room.turnTimer);
  if (room.trickHold) return; // the trick-pause timer re-arms the turn when it fires
  if (room.phase !== 'playing' || !room.match || !room.match.round) return;
  const round = room.match.round;
  if (round.finished) return;
  const seat = round.turn;
  const info = room.seats[seat];
  const delay = info.kind === 'bot' ? BOT_DELAY_MS : TURN_TIMEOUT_MS;
  room.turnTimer = setTimeout(() => botPlay(room, seat, info.kind === 'bot'), delay);
}

function startMatch(room) {
  clearTimeout(room.trickTimer);
  room.trickHold = null;
  if (room.rematchTimer) { clearTimeout(room.rematchTimer); room.rematchTimer = null; }
  room.rematch = null; // a fresh match (lobby start OR an accepted rematch) spends any offer
  room.statsRecorded = false; // the new match earns its own stats record at its end
  const botDigits = ['1', '2', '3'];
  let botNo = 0;
  room.seats.forEach((s) => {
    if (s.kind === 'empty') {
      s.kind = 'bot';
      s.name = 'ربات ' + (botDigits[botNo] || String(botNo + 1));
      botNo++;
      s.connected = true;
      s.voiceMic = false; // bots never talk and never listen
      s.voiceSpeaker = false;
    }
  });
  room.match = new G.Match(room.emit);
  room.phase = 'playing';
  room.match.startRound();
  broadcastState(room);
  pumpTurn(room);
}

// --------------------------------------------------------- seat lifecycle
// Profile fields (avatar + country, and the Google photo) ride along
// with create/join/reconnect. The client owns the avatar catalogue
// (portrait ids 'av1'…'av12', plus the 'google' kind = the player's
// Google profile photo); the server only checks the id against that
// known set, so a seat can never carry markup or an unbounded string.
// Anything else becomes null and the client falls back to the default
// avatar (av1). The photo is carried ONLY for the 'google' avatar and
// is validated just as strictly (short https googleusercontent URL);
// an invalid photo is dropped silently — the seat still joins.
const AVATAR_IDS = ['av1', 'av2', 'av3', 'av4', 'av5', 'av6', 'av7', 'av8', 'av9', 'av10', 'av11', 'av12'];
function cleanAvatar(av) {
  return (typeof av === 'string' && (AVATAR_IDS.includes(av) || av === 'google')) ? av : null;
}
function cleanCountry(c) {
  return String(c || '').trim().slice(0, 40);
}
function cleanPhoto(p) {
  if (typeof p !== 'string' || p.length > 300) return null;
  if (!p.startsWith('https://')) return null;
  if (!p.includes('googleusercontent.com')) return null;
  return p;
}
// The seat also carries the player's SOCIAL identity so the lobby
// player menu can address a friend request: 'p:<pid>' from the
// persistent player id the client sends with create/join/reconnect
// (the same id its /social hello uses). Charset/length match the
// social layer's own rule; anything else becomes null — the seat
// still joins, the menu just hides its request button.
function cleanPid(pid) {
  return (typeof pid === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(pid)) ? pid : null;
}

// The identity a create/join carries: the same 'p:<pid>' the seat
// stores as its social id. (The production DO port keys by the
// signed-in account instead — 'g:<sub>'.)
function joinSid(prof) {
  const pid0 = cleanPid(prof && prof.pid);
  return pid0 ? 'p:' + pid0 : null;
}

// Reattach an EXISTING seat to a (possibly new) socket — the
// 'reconnect' case's semantics, reached from 'join' when the joiner's
// identity already holds a seat in the room (duplicate-seat fix,
// 2026-11-09): the seat, its hand and its TOKEN are kept; only the
// connection and the profile fields refresh. A repeated join can
// therefore never mint a second seat for an identity already seated.
function reattachSeat(ws, room, seatIdx, msg) {
  const seat = room.seats[seatIdx];
  if (seat.ws && seat.ws !== ws) { try { seat.ws.close(); } catch (e) {} }
  if (msg && String(msg.name || '').trim()) seat.name = cleanName(msg.name);
  const av = cleanAvatar(msg.avatar); if (av) seat.avatar = av;
  const co = cleanCountry(msg.country); if (co) seat.country = co;
  const pid = cleanPid(msg.pid); if (pid) seat.sid = 'p:' + pid;
  if (seat.avatar === 'google') {
    const ph = cleanPhoto(msg.photo); if (ph) seat.photo = ph;
  } else {
    seat.photo = null; // the photo belongs to the 'google' avatar only
  }
  seat.ws = ws;
  seat.connected = true;
  seat.disconnectAt = null;
  ws._roomCode = room.code;
  ws._seat = seatIdx;
  send(ws, {
    type: 'room', code: room.code, seat: seatIdx, token: seat.token,
    isHost: seatIdx === hostSeat(room),
  });
  broadcastState(room);
}

function attachPlayer(ws, room, seatIdx, name, prof) {
  const seat = room.seats[seatIdx];
  seat.kind = 'human';
  seat.name = name;
  seat.avatar = cleanAvatar(prof && prof.avatar);
  seat.country = cleanCountry(prof && prof.country);
  seat.photo = seat.avatar === 'google' ? cleanPhoto(prof && prof.photo) : null;
  const pid0 = cleanPid(prof && prof.pid);
  seat.sid = pid0 ? 'p:' + pid0 : null;
  seat.token = crypto.randomBytes(8).toString('hex');
  seat.ws = ws;
  seat.connected = true;
  seat.disconnectAt = null;
  ws._roomCode = room.code;
  ws._seat = seatIdx;
  send(ws, {
    type: 'room', code: room.code, seat: seatIdx, token: seat.token,
    isHost: seatIdx === hostSeat(room),
  });
  broadcastState(room);
}

function onDisconnect(ws) {
  // Clubs v8: a spectator holds no seat — just leave the watch list.
  if (ws._spectator) {
    const sroom = rooms.get(ws._roomCode);
    if (sroom && sroom.spectators) sroom.spectators.delete(ws);
    ws._spectator = false;
    return;
  }
  const room = rooms.get(ws._roomCode);
  if (!room) return;
  const seat = room.seats[ws._seat];
  if (!seat || seat.ws !== ws) return;
  seat.ws = null;
  seat.connected = false;
  seat.disconnectAt = Date.now();
  if (seat.voiceMic) {
    // Voice is opt-in per connection: a gone mic is a silent mic, and
    // the room hears about it so peers tear the connection down.
    seat.voiceMic = false;
    broadcastEvent(room, { type: 'voice', seat: ws._seat, mic: false, speaker: seat.voiceSpeaker !== false, on: false });
  }
  broadcastState(room);
}

/** Expire disconnected seats after the grace window — IN-MATCH ONLY.
 *  A WAITING room never expires (owner order 2026-11-07): its code
 *  stays joinable until the match starts or the host cancels it, and
 *  a lobby seat stays reserved through a disconnect of any length,
 *  so the host (or a guest) can always reconnect back into it. */
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase === 'lobby') continue;
    // Rematch expiry backstop (the per-offer setTimeout armed at
    // creation is the primary mechanism).
    if (room.rematch && now >= room.rematch.expires) {
      cancelRematch(room, 'expired');
      broadcastState(room);
    }
    let changed = false;
    const goneSids = [];
    room.seats.forEach((s, i) => {
      if (s.kind === 'human' && !s.connected && s.disconnectAt &&
          now - s.disconnectAt > RECONNECT_GRACE_MS) {
        if (room.rematch) cancelRematch(room, 'left'); // a seat expiring kills a live offer
        if (s.sid) goneSids.push(s.sid);
        s.kind = 'bot'; // bot takes over the seat and its hand
        s.avatar = null;
        s.country = '';
        s.photo = null;
        s.sid = null;
        s.voiceMic = false;
        s.voiceSpeaker = false;
        s.connected = true;
        changed = true;
        pumpTurn(room);
      }
    });
    if (changed) broadcastState(room);
    if (goneSids.length) syncBusyFor(null, goneSids);
    const anyHuman = room.seats.some((s) => s.kind === 'human');
    if (!anyHuman) {
      clearTimeout(room.turnTimer);
      clearTimeout(room.roundTimer);
      clearTimeout(room.trickTimer);
      sendToSpectators(room, { type: 'roomClosed', code: 'roomCancelled' });
      rooms.delete(room.code);
      syncClubGame(room);
    }
  }
}, 10000);

// ------------------------------------------------- chat / voice relay
// In-room chat and WebRTC voice ride the same socket. Chat is
// PRESET-ONLY — there is no free text: the client sends
// {type:'chat', kind, value} and value must be an exact member of the
// allowlist for its kind (the same lists the client panel offers).
// Anything else — including old-style {text} frames — is dropped
// silently. A valid message is fanned out to the whole room INCLUDING
// the sender; clients render it only from the relay, as a bubble over
// the sender's badge. One message per 800 ms per seat. The sticker
// GIFs themselves are static files (the stickers folder beside this
// server, served by the HTTP layer above); only the sticker id
// crosses the socket. RTC signaling is forwarded to ONE target seat
// in the same room (SDP/ICE JSON, ~16 KB cap); the audio itself is
// peer-to-peer and never touches this server. Voice on/off is
// broadcast so clients can show who has a live mic (and the flag
// also rides in every state push, for late joiners and reconnects).
const CHAT_PHRASES = ['سلام', 'ښه چال', 'ښه لوبه', 'هاهاها', 'مننه', 'بخښنه!', 'ژر شه!', 'شاباس!', 'اوس نه!', 'وای خدایه!', 'ښه بخت', 'بیا!',
  'ښه کار!', 'واه واه!', 'ستا وار دی', 'صبر وکړه', 'زه چمتو یم', 'یو ځل بیا!', 'نه منم!', 'مه وېرېږه', 'ټينګ اوسه!', 'ډېر ښه!', 'خدای دې مل شه', 'وروسته ګورو'];
const CHAT_EMOJIS = ['😎', '😂', '😍', '😭', '😡', '👊', '😮', '👍', '❤️', '🔥',
  '🤣', '😜', '🥳', '🙏', '👏', '💪', '🎉', '🤔', '😴', '🥺'];
const CHAT_STICKERS = ['st1', 'st2', 'st3', 'st4', 'st5', 'st6', 'st7', 'st8', 'st9', 'st10', 'st11', 'st12', 'st13', 'st14', 'st15', 'st16'];
const CHAT_MIN_INTERVAL_MS = 800;
const RTC_MAX_BYTES = 16384;

function cleanChat(kind, value) {
  if (typeof value !== 'string') return null;
  if (kind === 'phrase' && CHAT_PHRASES.includes(value)) return { kind, value };
  if (kind === 'emoji' && CHAT_EMOJIS.includes(value)) return { kind, value };
  if (kind === 'sticker' && CHAT_STICKERS.includes(value)) return { kind, value };
  return null;
}

// -------------------------------------------------------------- ws layer
wss.on('connection', (ws, req) => {
  // Friends-system sockets live on their own endpoint (/social) and
  // never touch the game handling below.
  if (social.isSocialPath(req && req.url)) { social.handleConnection(ws); return; }
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    try { handleMessage(ws, msg); } catch (e) { sendError(ws, 'خطای سرور', 'serverError'); }
  });
  ws.on('close', () => onDisconnect(ws));
});

function handleMessage(ws, msg) {
  // Clubs v8: a SPECTATOR socket is receive-only. It may leave;
  // every other frame (play, chat, rtc, start, …) is dropped here
  // so a spectator can never act on the room it watches.
  if (ws._spectator) {
    if (msg.type === 'leave') {
      const room = rooms.get(ws._roomCode);
      if (room && room.spectators) room.spectators.delete(ws);
      ws._spectator = false;
      ws._roomCode = undefined;
      try { ws.close(); } catch (e) { /* gone */ }
    }
    return;
  }
  switch (msg.type) {
    case 'create': {
      const room = createRoom();
      room.felt = cleanFelt(msg.felt); // creator's felt, validated; fixed at creation
      room.back = cleanBack(msg.back); // creator's card back, validated the same way
      // Clubs v8: a club stamp is granted ONLY by the social
      // core, which verifies the creator is a manager of that
      // club — a forged club id in the create frame earns nothing.
      if (msg.club) {
        const cg = social.core.clubGameClub(joinSid(msg), msg.club);
        if (cg) room.club = cg;
      }
      attachPlayer(ws, room, 0, cleanName(msg.name), msg);
      syncClubGame(room);
      break;
    }
    case 'spectate': {
      // Clubs v8 — spectating is a CLUB feature: the room must be
      // a club game and the watcher a member of that club (the
      // core verifies from social state). Spectators hold no
      // seat, never count as busy, are capped per room, and only
      // ever receive the public state (publicStateFor).
      // Friend spectate (feature 3): a watcher the core vouches
      // for — canWatch(watcher, the room's seated human ids),
      // i.e. a friend of a seated player — is ALSO admitted,
      // club room or not. canWatch lands in a parallel
      // workstream: absent = false, called defensively.
      const room = rooms.get(String(msg.code || '').toUpperCase().trim());
      if (!room) return sendError(ws, 'اتاق پیدا نشد — کد را بررسی کن', 'roomNotFound');
      const sid = joinSid(msg);
      let admitted = !!(room.club && sid && social.core.clubMembership(sid, room.club.cid));
      if (!admitted && sid && typeof social.core.canWatch === 'function') {
        const humanSeatSids = room.seats.filter((s) => s.kind === 'human' && s.sid).map((s) => s.sid);
        try { admitted = !!social.core.canWatch(sid, humanSeatSids); } catch (e) { admitted = false; }
      }
      if (!admitted) {
        return sendError(ws, 'تماشای این بازی فقط برای اعضای کلب است', 'spectateDenied');
      }
      if (!room.spectators) room.spectators = new Set();
      if (!room.spectators.has(ws) && room.spectators.size >= SPECTATOR_CAP) {
        return sendError(ws, 'تعداد تماشاچیان پر است', 'spectatorFull');
      }
      room.spectators.add(ws);
      ws._spectator = true;
      ws._roomCode = room.code;
      ws._seat = undefined;
      send(ws, { type: 'spectating', code: room.code });
      send(ws, publicStateFor(room));
      break;
    }
    case 'join': {
      const room = rooms.get(String(msg.code || '').toUpperCase().trim());
      if (!room) return sendError(ws, 'اتاق پیدا نشد — کد را بررسی کن', 'roomNotFound');
      // Duplicate-seat fix (2026-11-09): one identity holds AT MOST
      // one seat per room. If this join's identity is already seated
      // here — any phase, lobby or mid-match — the join REATTACHES
      // to that seat instead of taking a new one, however often it
      // is repeated and from whichever socket it arrives. (The
      // client's join flow opens a fresh socket per call, so every
      // repeated tap / invite re-accept used to mint another seat.)
      const sid = joinSid(msg);
      const mine = sid ? room.seats.findIndex((s) => s.kind === 'human' && s.sid === sid) : -1;
      if (mine !== -1) { reattachSeat(ws, room, mine, msg); maybeStartVs(room); break; }
      // Club-vs-club rooms seat ONLY their four reserved
      // players — anyone else is refused outright.
      if (room.vs) return sendError(ws, 'این بازی فقط برای بازیکنان دو کلب است', 'vsOnly');
      if (room.phase !== 'lobby') return sendError(ws, 'بازی این اتاق شروع شده است', 'gameStarted');
      const idx = room.seats.findIndex((s) => s.kind === 'empty');
      if (idx === -1) return sendError(ws, 'اتاق پر است', 'roomFull');
      attachPlayer(ws, room, idx, cleanName(msg.name), msg);
      break;
    }
    case 'reconnect': {
      const room = rooms.get(String(msg.code || '').toUpperCase().trim());
      if (!room) return sendError(ws, 'نشست منقضی شده است — اتاق تازه بساز', 'sessionExpired');
      const idx = room.seats.findIndex((s) => s.kind === 'human' && s.token === msg.token);
      if (idx === -1) return sendError(ws, 'نشست منقضی شده است — اتاق تازه بساز', 'sessionExpired');
      const seat = room.seats[idx];
      if (seat.ws && seat.ws !== ws) { try { seat.ws.close(); } catch (e) {} }
      // A reconnect may carry the player's current profile (e.g. the seat
      // was created before profiles existed) — refresh what it carries.
      const av = cleanAvatar(msg.avatar); if (av) seat.avatar = av;
      const co = cleanCountry(msg.country); if (co) seat.country = co;
      const pid = cleanPid(msg.pid); if (pid) seat.sid = 'p:' + pid;
      if (seat.avatar === 'google') {
        const ph = cleanPhoto(msg.photo); if (ph) seat.photo = ph;
      } else {
        seat.photo = null; // the photo belongs to the 'google' avatar only
      }
      seat.ws = ws;
      seat.connected = true;
      seat.disconnectAt = null;
      ws._roomCode = room.code;
      ws._seat = idx;
      send(ws, {
        type: 'room', code: room.code, seat: idx, token: seat.token,
        isHost: idx === hostSeat(room),
      });
      broadcastState(room);
      maybeStartVs(room); // a token reconnect can be a vs room's 4th connection
      break;
    }
    case 'start': {
      const room = rooms.get(ws._roomCode);
      if (!room || room.phase !== 'lobby') return;
      if (ws._seat !== hostSeat(room)) return sendError(ws, 'فقط میزبان می‌تواند بازی را شروع کند', 'hostOnly');
      // A vs room starts ONLY when all four reserved seats are
      // connected (it auto-starts then — see maybeStartVs).
      if (room.vs && !room.seats.every((s) => s.kind === 'human' && s.connected)) return;
      startMatch(room);
      syncClubGame(room); // clubs v8: the club game is now in progress
      break;
    }
    case 'leave': {
      // Leaving the WAITING room (the match has not started): a guest's
      // seat is freed at once; the HOST leaving cancels the room for
      // everyone — the remaining players get a coded roomClosed notice
      // and their clients return to the main menu.
      // Leaving MID-MATCH (playing / roundEnd / matchEnd): the seat is
      // handed to a bot at once — the same conversion the disconnect
      // grace expiry performs (kind bot, profile cleared, voice off,
      // bot name) — and the match plays on for the others.
      const room = rooms.get(ws._roomCode);
      if (!room) return;
      const seat = room.seats[ws._seat];
      if (!seat || seat.kind !== 'human') return;
      if (room.rematch) cancelRematch(room, 'left'); // a human leaving kills a live offer
      const leavingSid = seat.sid || null;
      const roomSids = room.seats.map((s) => s.sid).filter(Boolean);
      if (room.phase === 'lobby') {
        if (ws._seat === hostSeat(room)) {
          room.seats.forEach((s, i) => {
            if (i !== ws._seat && s.kind === 'human' && s.connected && s.ws) {
              send(s.ws, { type: 'roomClosed', code: 'roomCancelled' });
            }
          });
          sendToSpectators(room, { type: 'roomClosed', code: 'roomCancelled' });
          clearTimeout(room.turnTimer);
          clearTimeout(room.roundTimer);
          clearTimeout(room.trickTimer);
          rooms.delete(room.code);
          syncClubGame(room); // clubs v8: the club game dissolved — badge clears
          syncBusyFor(null, roomSids);
        } else {
          room.seats[ws._seat] = emptySeat();
          broadcastState(room);
          if (leavingSid) syncBusyFor(null, [leavingSid]);
        }
      } else {
        const botNo = room.seats.filter((s) => s.kind === 'bot').length;
        seat.kind = 'bot'; // bot takes over the seat and its hand
        seat.name = 'ربات ' + (botNo + 1);
        seat.avatar = null;
        seat.country = '';
        seat.photo = null;
        seat.sid = null;
        seat.voiceMic = false;
        seat.voiceSpeaker = false;
        seat.ws = null;
        seat.connected = true;
        seat.disconnectAt = null;
        broadcastState(room);
        if (leavingSid) syncBusyFor(null, [leavingSid]);
        pumpTurn(room);
      }
      ws._roomCode = undefined;
      ws._seat = undefined;
      break;
    }
    case 'declare13': {
      const room = rooms.get(ws._roomCode);
      if (!room || room.phase !== 'playing') return;
      if (room.trickHold) { send(ws, stateFor(room, ws._seat)); return; } // trick on display — resync silently
      const round = room.match && room.match.round;
      if (!round) return;
      try {
        round.declare13(ws._seat); // emits declared13 → clients toast it
        broadcastState(room);
      } catch (e) {
        sendError(ws, 'الآن نمی‌توانی «13» بگویی', 'cannotDeclare13');
        send(ws, stateFor(room, ws._seat));
      }
      break;
    }
    case 'rematch': {
      // Feature 4: a seated human offers a rematch while the
      // match-end screen is up. The initiator auto-accepts; a
      // lone human restarts at once (nobody to wait for).
      const room = rooms.get(ws._roomCode);
      if (!room) return;
      const seat = room.seats[ws._seat];
      if (!seat || seat.kind !== 'human' || !seat.sid) return;
      expireRematchIfNeeded(room);
      if (room.phase !== 'matchEnd' || room.rematch) return;
      const humans = rematchHumans(room);
      if (!humans.length) return;
      if (humans.length === 1) { startMatch(room); break; }
      room.rematch = {
        bySid: seat.sid, bySeat: ws._seat,
        expires: Date.now() + REMATCH_OFFER_MS,
        accepts: new Set([seat.sid]),
      };
      armRematchTimer(room);
      broadcastState(room);
      break;
    }
    case 'rematch-reply': {
      // Accept joins the offer (the last accept starts the new
      // match in this same room, via the normal startMatch path
      // — seats/teams/names/felt/back/club/vs all kept, scores
      // reset with the fresh Match). ANY decline cancels.
      const room = rooms.get(ws._roomCode);
      if (!room) return;
      const seat = room.seats[ws._seat];
      if (!seat || seat.kind !== 'human' || !seat.sid) return;
      expireRematchIfNeeded(room);
      if (!room.rematch) return;
      if (seat.sid === room.rematch.bySid) return; // the initiator already auto-accepted
      if (!rematchHumans(room).some((h) => h.sid === seat.sid)) return;
      if (msg.accept) {
        room.rematch.accepts.add(seat.sid);
        const humans = rematchHumans(room);
        if (humans.length && humans.every((h) => room.rematch.accepts.has(h.sid))) {
          startMatch(room); // clears the offer + its timer, pushes state, arms the turn
        } else {
          broadcastState(room);
        }
      } else {
        cancelRematch(room, 'declined');
        broadcastState(room);
      }
      break;
    }
    case 'play': {
      const room = rooms.get(ws._roomCode);
      if (!room || room.phase !== 'playing') return;
      if (room.trickHold) { send(ws, stateFor(room, ws._seat)); return; } // trick on display — resync silently, no error
      if (!doPlay(room, ws._seat, String(msg.card || ''))) {
        // Illegal move: explain (Dari text + machine code) and resync.
        const round = room.match.round;
        let why = 'این ورق را نمی‌توانی بازی کنی', whyCode = 'cannotPlay', whyExtra = null;
        if (round && round.turn !== ws._seat) { why = 'نوبت تو نیست'; whyCode = 'notYourTurn'; }
        else if (round && !round.hands[ws._seat].includes(msg.card)) { why = 'این ورق در دستت نیست'; whyCode = 'cardNotInHand'; }
        else if (round) {
          const suit = round.ledSuit();
          why = 'باید از رنگِ ورقِ اول (' + G.SUIT_NAMES[suit] + ') بیایی';
          whyCode = 'mustFollowSuit'; whyExtra = { suit };
        }
        sendError(ws, why, whyCode, whyExtra);
        send(ws, stateFor(room, ws._seat));
      }
      break;
    }
    case 'chat': {
      const room = rooms.get(ws._roomCode);
      if (!room) return;
      const seat = room.seats[ws._seat];
      if (!seat || seat.kind !== 'human') return;
      const c = cleanChat(msg.kind, msg.value);
      if (!c) return; // not on the preset allowlists — drop silently
      const now = Date.now();
      if (seat.lastChatAt && now - seat.lastChatAt < CHAT_MIN_INTERVAL_MS) return; // too fast — drop silently
      seat.lastChatAt = now;
      broadcastEvent(room, { type: 'chat', seat: ws._seat, name: seat.name, kind: c.kind, value: c.value, ts: now });
      break;
    }
    case 'voice': {
      const room = rooms.get(ws._roomCode);
      if (!room) return;
      const seat = room.seats[ws._seat];
      if (!seat || seat.kind !== 'human') return;
      // Mic and speaker are independent flags; they ride together
      // in one message. A legacy client sends only `on` (= mic) —
      // its speaker flag is then left as-is.
      const mic = msg.mic !== undefined ? !!msg.mic : !!msg.on;
      const speaker = msg.speaker !== undefined ? !!msg.speaker : seat.voiceSpeaker !== false;
      if (seat.voiceMic === mic && (seat.voiceSpeaker !== false) === speaker) return;
      seat.voiceMic = mic;
      seat.voiceSpeaker = speaker;
      broadcastEvent(room, { type: 'voice', seat: ws._seat, mic, speaker, on: mic });
      break;
    }
    case 'rtc': {
      // WebRTC signaling: relay `data` (SDP offer/answer or an ICE
      // candidate) to exactly one other human seat in the same room.
      const room = rooms.get(ws._roomCode);
      if (!room) return;
      const seat = room.seats[ws._seat];
      if (!seat || seat.kind !== 'human') return;
      const to = msg.to;
      if (!Number.isInteger(to) || to < 0 || to > 3 || to === ws._seat) return;
      const target = room.seats[to];
      if (!target || target.kind !== 'human' || !target.connected || !target.ws) return;
      let raw;
      try { raw = JSON.stringify(msg.data); } catch (e) { return; }
      if (raw === undefined || raw.length > RTC_MAX_BYTES) return;
      send(target.ws, { type: 'rtc', from: ws._seat, data: msg.data });
      break;
    }
  }
}

function cleanName(name) {
  const n = String(name || '').trim().slice(0, 20);
  return n || 'بازیکن';
}

// Table felts (قالین): the create frame carries the creator's felt
// (integer 1..11). Anything else — missing, fractional, out of
// range, a forged string — falls back to 11 (the default: felt 11,
// the ORIGINAL cream carpet from the game's first build). The
// felt is fixed at creation; stateFor stamps it on every push so
// the whole room plays on the creator's field.
function cleanFelt(v) {
  return (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 11) ? v : 11;
}

// Card backs: the create frame carries the creator's card-back
// design (integer 1..6), validated exactly like the felt —
// anything else falls back to 1. Fixed at creation; stateFor
// stamps it on every push so the whole room plays with the
// creator's backs.
function cleanBack(v) {
  return (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 6) ? v : 1;
}

httpServer.listen(PORT, () => {
  console.log('TORE server listening on port ' + PORT);
});
