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

// ---- Tunables (one line each) ----
const PORT = process.env.PORT || 3000;
const TURN_TIMEOUT_MS = 30000;    // a stalled human seat is played by a bot
const BOT_DELAY_MS = 750;         // bot "thinking" delay (watchable pace)
const ROUND_PAUSE_MS = 6000;      // round-summary pause before next round
const TRICK_PAUSE_MS = 1600;      // completed trick stays on the table before it is collected
const RECONNECT_GRACE_MS = 120000; // seat+hand kept for a reconnecting player

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'));

const httpServer = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(INDEX_HTML);
  }
  res.writeHead(404); return res.end('not found');
});

const wss = new WebSocketServer({ server: httpServer });

// ---------------------------------------------------------------- rooms
const rooms = new Map();
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function emptySeat() {
  return { kind: 'empty', name: '', token: null, ws: null, connected: false, disconnectAt: null };
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

function sendError(ws, msg) {
  send(ws, { type: 'error', message: msg });
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
    target: G.MATCH_TARGET,
    seats: room.seats.map((s, i) => ({
      name: s.name, kind: s.kind, connected: s.connected,
      cards: round ? round.hands[i].length : 0,
    })),
    hand: round ? round.hands[seatIdx].slice() : [],
    trick: room.trickHold
      ? room.trickHold.plays.map((p) => ({ seat: p.seat, card: p.card }))
      : round ? round.trick.map((p) => ({ seat: p.seat, card: p.card })) : [],
    trickWinner: room.trickHold ? room.trickHold.winnerSeat : null,
    turn: round && !round.finished ? round.turn : null,
    legal: round ? round.legalMovesFor(seatIdx) : [],
    scores: room.match ? room.match.scores.slice() : [0, 0],
    bankedTawan: room.match ? room.match.bankedTawan.slice() : [0, 0],
    roundTawan: round
      ? [G.tawanOf(round.captured[0]), G.tawanOf(round.captured[1])] : [0, 0],
    takanCount: round ? round.takanCount.slice() : [0, 0],
    takanBonus: round ? round.takanBonus.slice() : [0, 0],
    piles: round ? round.wonTricks.slice() : [0, 0, 0, 0],
    canDeclare13: round && !room.trickHold ? round.canDeclare13(seatIdx) : false,
    declared13: round ? round.declared13 : false,
    roundNo: room.match ? room.match.roundNo : 0,
    roundResult: (room.phase === 'roundEnd' || room.phase === 'matchEnd') ? last : null,
    matchWinner: room.match && room.match.finished ? room.match.winner : null,
  };
}

function broadcastState(room) {
  room.seats.forEach((s, i) => {
    if (s.kind === 'human' && s.connected && s.ws) send(s.ws, stateFor(room, i));
  });
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
    // updated star count and bonus.
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
 * bots always declare «۱۳» on the final trick when it cancels a takan.
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
  const botDigits = ['۱', '۲', '۳'];
  let botNo = 0;
  room.seats.forEach((s) => {
    if (s.kind === 'empty') {
      s.kind = 'bot';
      s.name = 'ربات ' + (botDigits[botNo] || String(botNo + 1));
      botNo++;
      s.connected = true;
    }
  });
  room.match = new G.Match(room.emit);
  room.phase = 'playing';
  room.match.startRound();
  broadcastState(room);
  pumpTurn(room);
}

// --------------------------------------------------------- seat lifecycle
function attachPlayer(ws, room, seatIdx, name) {
  const seat = room.seats[seatIdx];
  seat.kind = 'human';
  seat.name = name;
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
  broadcastState(room);
}

/** Expire disconnected seats after the grace window; drop dead lobby rooms. */
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    let changed = false;
    room.seats.forEach((s, i) => {
      if (s.kind === 'human' && !s.connected && s.disconnectAt &&
          now - s.disconnectAt > RECONNECT_GRACE_MS) {
        if (room.phase === 'lobby') {
          room.seats[i] = emptySeat();
        } else {
          s.kind = 'bot'; // bot takes over the seat and its hand
          s.connected = true;
          changed = true;
          pumpTurn(room);
        }
        changed = true;
      }
    });
    if (changed) broadcastState(room);
    const anyHuman = room.seats.some((s) => s.kind === 'human');
    if (!anyHuman) {
      clearTimeout(room.turnTimer);
      clearTimeout(room.roundTimer);
      clearTimeout(room.trickTimer);
      rooms.delete(room.code);
    }
  }
}, 10000);

// -------------------------------------------------------------- ws layer
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    try { handleMessage(ws, msg); } catch (e) { sendError(ws, 'خطای سرور'); }
  });
  ws.on('close', () => onDisconnect(ws));
});

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create': {
      const room = createRoom();
      attachPlayer(ws, room, 0, cleanName(msg.name));
      break;
    }
    case 'join': {
      const room = rooms.get(String(msg.code || '').toUpperCase().trim());
      if (!room) return sendError(ws, 'اتاق پیدا نشد — کد را بررسی کن');
      if (room.phase !== 'lobby') return sendError(ws, 'بازی این اتاق شروع شده است');
      const idx = room.seats.findIndex((s) => s.kind === 'empty');
      if (idx === -1) return sendError(ws, 'اتاق پر است');
      attachPlayer(ws, room, idx, cleanName(msg.name));
      break;
    }
    case 'reconnect': {
      const room = rooms.get(String(msg.code || '').toUpperCase().trim());
      if (!room) return sendError(ws, 'نشست منقضی شده است — اتاق تازه بساز');
      const idx = room.seats.findIndex((s) => s.kind === 'human' && s.token === msg.token);
      if (idx === -1) return sendError(ws, 'نشست منقضی شده است — اتاق تازه بساز');
      const seat = room.seats[idx];
      if (seat.ws && seat.ws !== ws) { try { seat.ws.close(); } catch (e) {} }
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
      if (ws._seat !== hostSeat(room)) return sendError(ws, 'فقط میزبان می‌تواند بازی را شروع کند');
      startMatch(room);
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
        sendError(ws, 'الآن نمی‌توانی «۱۳» بگویی');
        send(ws, stateFor(room, ws._seat));
      }
      break;
    }
    case 'play': {
      const room = rooms.get(ws._roomCode);
      if (!room || room.phase !== 'playing') return;
      if (room.trickHold) { send(ws, stateFor(room, ws._seat)); return; } // trick on display — resync silently, no error
      if (!doPlay(room, ws._seat, String(msg.card || ''))) {
        // Illegal move: explain in Dari and resync the client.
        const round = room.match.round;
        let why = 'این ورق را نمی‌توانی بازی کنی';
        if (round && round.turn !== ws._seat) why = 'نوبت تو نیست';
        else if (round && !round.hands[ws._seat].includes(msg.card)) why = 'این ورق در دستت نیست';
        else if (round) why = 'باید از رنگِ ورقِ اول (' + G.SUIT_NAMES[round.ledSuit()] + ') بیایی';
        sendError(ws, why);
        send(ws, stateFor(room, ws._seat));
      }
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
