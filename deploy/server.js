'use strict';
/**
 * TORE (توره) — authoritative game server.
 * Node + ws. Serves the self-contained client (./index.html — every image
 * inlined as a data URI, no public/ folder needed) and runs all game rules
 * through game.js (the same module sim.js tests). Clients only render.
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
const ROUND_PAUSE_MS = 6000;      // round-summary pause before next round
const TRICK_PAUSE_MS = 1600;      // completed trick stays on the table before it is collected
const RECONNECT_GRACE_MS = 120000; // seat+hand kept for a reconnecting player

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'));
const STICKERS_DIR = path.join(__dirname, 'stickers');

const httpServer = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
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
  res.writeHead(404); return res.end('not found');
});

const wss = new WebSocketServer({ server: httpServer });

// ---------------------------------------------------------------- rooms
const rooms = new Map();
// Friends system (ملګري): a second WebSocket endpoint, /social, on
// this same server (see social-core.js / social-node.js). Identity on
// the Node hosts is the persistent client player id (p:<pid>); the
// invite check is the spec fallback — the room exists and is still
// in its lobby phase.
function sidInGame(id) {
  if (!id) return false;
  for (const room of rooms.values()) {
    if (room.phase === 'lobby') continue;
    if (room.seats.some((s) => s.kind === 'human' && s.sid === id)) return true;
  }
  return false;
}
function syncInGameFor(room, extraSids) {
  const ids = new Set(extraSids || []);
  if (room) room.seats.forEach((s) => { if (s.sid) ids.add(s.sid); });
  ids.forEach((id) => { try { social.core.syncInGame(id); } catch (e) { /* social never breaks the game */ } });
}
const social = createNodeSocial({
  roomCheck: (id, code) => {
    const room = rooms.get(code);
    return !!room && room.phase === 'lobby';
  },
  inGameCheck: sidInGame,
});
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
  };
}

function broadcastState(room) {
  room.seats.forEach((s, i) => {
    if (s.kind === 'human' && s.connected && s.ws) send(s.ws, stateFor(room, i));
  });
  syncInGameFor(room);
}

// ------------------------------------------------------------ game flow
function broadcastEvent(room, obj) {
  room.seats.forEach((s) => {
    if (s.kind === 'human' && s.connected && s.ws) send(s.ws, obj);
  });
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
    broadcastState(room);
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
    let changed = false;
    const goneSids = [];
    room.seats.forEach((s, i) => {
      if (s.kind === 'human' && !s.connected && s.disconnectAt &&
          now - s.disconnectAt > RECONNECT_GRACE_MS) {
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
    if (goneSids.length) syncInGameFor(null, goneSids);
    const anyHuman = room.seats.some((s) => s.kind === 'human');
    if (!anyHuman) {
      clearTimeout(room.turnTimer);
      clearTimeout(room.roundTimer);
      clearTimeout(room.trickTimer);
      rooms.delete(room.code);
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
const CHAT_PHRASES = ['سلام', 'ښه حرکت', 'ښه لوبه', 'هاهاها', 'مننه', 'بخښنه!', 'ژر شه!', 'افرین!', 'اوس نه!', 'وای خدای', 'ښه بخت', 'بیا!',
  'ښه کار!', 'واه واه!', 'ستا وار دی', 'صبر وکړه', 'زه چمتو یم', 'یو ځل بیا!', 'نه منم!', 'مه وېرېږه', 'قوي اوسه!', 'ډېر ښه!', 'خدای دې مل شه', 'وروسته ګورو'];
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
  switch (msg.type) {
    case 'create': {
      const room = createRoom();
      attachPlayer(ws, room, 0, cleanName(msg.name), msg);
      break;
    }
    case 'join': {
      const room = rooms.get(String(msg.code || '').toUpperCase().trim());
      if (!room) return sendError(ws, 'اتاق پیدا نشد — کد را بررسی کن', 'roomNotFound');
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
      break;
    }
    case 'start': {
      const room = rooms.get(ws._roomCode);
      if (!room || room.phase !== 'lobby') return;
      if (ws._seat !== hostSeat(room)) return sendError(ws, 'فقط میزبان می‌تواند بازی را شروع کند', 'hostOnly');
      startMatch(room);
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
      const leavingSid = seat.sid || null;
      const roomSids = room.seats.map((s) => s.sid).filter(Boolean);
      if (room.phase === 'lobby') {
        if (ws._seat === hostSeat(room)) {
          room.seats.forEach((s, i) => {
            if (i !== ws._seat && s.kind === 'human' && s.connected && s.ws) {
              send(s.ws, { type: 'roomClosed', code: 'roomCancelled' });
            }
          });
          clearTimeout(room.turnTimer);
          clearTimeout(room.roundTimer);
          clearTimeout(room.trickTimer);
          rooms.delete(room.code);
          syncInGameFor(null, roomSids);
        } else {
          room.seats[ws._seat] = emptySeat();
          broadcastState(room);
          if (leavingSid) syncInGameFor(null, [leavingSid]);
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
        if (leavingSid) syncInGameFor(null, [leavingSid]);
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

httpServer.listen(PORT, () => {
  console.log('TORE server listening on port ' + PORT);
});
