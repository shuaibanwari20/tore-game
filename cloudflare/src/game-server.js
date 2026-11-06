/**
 * game-server.js — GameServer Durable Object: the Cloudflare port of
 * ../server.js (the Node + ws original stays the reference behaviour).
 *
 * ONE GameServer instance ("global") holds ALL rooms — at this game's
 * friends-sized scale that is deliberate: one object = one consistent
 * room directory, no cross-object routing. The trade-off (a single hot
 * object caps total concurrency) is documented in README-fa.md.
 *
 * Protocol parity: the WebSocket message shapes are IDENTICAL to the
 * Node server (types: create/join/reconnect/start/play/declare13/
 * chat/voice/rtc in; room/state/error/takan/declared13/chat/voice/rtc
 * out) so the existing client works unchanged apart from the /ws path.
 *
 * Cloudflare adaptations vs the Node original:
 *  - Hibernatable WebSockets (state.acceptWebSocket); per-socket data
 *    {code, seat, token, user} lives in the socket attachment.
 *  - setTimeout/setInterval → a small scheduler on the DO's single
 *    alarm: entries {id, at, kind: 'turn'|'trick'|'round'|'sweep', …}.
 *    Alarm timing is near-second precision, so bot/trick pacing can
 *    differ by a fraction of a second from the Node build.
 *  - Room + timer state is snapshotted to DO storage after every
 *    mutation, so an eviction/hibernation wake rebuilds everything
 *    (Match/Round are plain-data classes in game.js; only their emit
 *    closures and rng are re-wired on revive).
 */

import * as G from './game.js';
import { chooseCard, maybeDeclare13 } from './bots.js';

// ---- Tunables (same values as ../server.js) ----
const TURN_TIMEOUT_MS = 30000;    // a stalled human seat is played by a bot
const BOT_DELAY_MS = 750;         // bot "thinking" delay (watchable pace)
const ROUND_PAUSE_MS = 6000;      // round-summary pause before next round
const TRICK_PAUSE_MS = 1600;      // completed trick stays on the table before it is collected
const RECONNECT_GRACE_MS = 120000; // seat+hand kept for a reconnecting player
const SWEEP_MS = 10000;           // seat-expiry sweep cadence (was setInterval)

const STORAGE_KEY = 'tore:v1';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomInt(n) {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % n;
}

// Profile fields (avatar + country, and the Google photo) ride along
// with create/join/reconnect — same allow-list as the Node server. The
// 'google' avatar kind carries the player's Google profile photo, which
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
function cleanName(name) {
  const n = String(name || '').trim().slice(0, 20);
  return n || 'بازیکن';
}
// Chat / voice relay — same rules as the Node server: chat is
// PRESET-ONLY (no free text): {type:'chat', kind, value} is relayed
// only when value is an exact member of the allowlist for its kind;
// anything else (including old-style {text} frames) is dropped. A
// valid message fans out to the whole room INCLUDING the sender, one
// per 800 ms per seat; RTC signaling goes to exactly one human seat
// in the same room (~16 KB cap); the audio itself is peer-to-peer.
const CHAT_PHRASES = ['سلام', 'ښه حرکت', 'ښه لوبه', 'هاهاها', 'مننه', 'بخښنه!', 'ژر شه!', 'افرین!', 'اوس نه!', 'وای خدای', 'ښه بخت', 'بیا!'];
const CHAT_EMOJIS = ['😎', '😂', '😍', '😭', '😡', '👊', '😮', '👍', '❤️', '🔥'];
const CHAT_STICKERS = ['st1', 'st2', 'st3', 'st4', 'st5', 'st6', 'st7', 'st8', 'st9'];
const CHAT_MIN_INTERVAL_MS = 800;
const RTC_MAX_BYTES = 16384;
function cleanChat(kind, value) {
  if (typeof value !== 'string') return null;
  if (kind === 'phrase' && CHAT_PHRASES.includes(value)) return { kind, value };
  if (kind === 'emoji' && CHAT_EMOJIS.includes(value)) return { kind, value };
  if (kind === 'sticker' && CHAT_STICKERS.includes(value)) return { kind, value };
  return null;
}
/** Seat display name: the player's own profile name wins; when it is
 *  empty and the player is signed in, default to the account name. */
function displayName(msg, user) {
  const raw = String(msg.name || '').trim();
  if (raw) return cleanName(raw);
  if (user && user.name) return cleanName(user.name);
  return cleanName('');
}

function emptySeat() {
  return { kind: 'empty', name: '', avatar: null, country: '', photo: null, token: null, ws: null, connected: false, disconnectAt: null, voiceOn: false, lastChatAt: 0 };
}

function send(ws, obj) {
  if (!ws) return;
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch { /* socket already gone */ }
}
function sendError(ws, msg) {
  send(ws, { type: 'error', message: msg });
}

// ---------------------------------------------------------- snapshots
// Everything game.js keeps in Match/Round is plain JSON data, so a
// snapshot is a field copy; revive re-attaches the prototype, the emit
// closure and Math.random as rng.
function snapshotRound(r) {
  if (!r) return null;
  return {
    hands: r.hands, leader: r.leader, turn: r.turn, trick: r.trick,
    captured: r.captured, tricksPlayed: r.tricksPlayed, wonTricks: r.wonTricks,
    takanCount: r.takanCount, takanBy: r.takanBy, declared13: r.declared13,
    finished: r.finished, result: r.result,
  };
}
function reviveRound(snap, match) {
  const r = Object.create(G.Round.prototype);
  Object.assign(r, snap);
  r.emit = (evt) => {
    match.emit(evt);
    if (evt.type === 'roundFinished') match.onRoundFinished(r);
  };
  return r;
}
function snapshotMatch(m) {
  if (!m) return null;
  return {
    bankedTawan: m.bankedTawan, pendingTakan: m.pendingTakan,
    roundNo: m.roundNo, history: m.history, finished: m.finished,
    winner: m.winner, loser: m.loser, round: snapshotRound(m.round),
  };
}
function reviveMatch(snap, emit) {
  const m = Object.create(G.Match.prototype);
  m.emit = emit;
  m.rng = Math.random;
  m.bankedTawan = snap.bankedTawan;
  m.pendingTakan = snap.pendingTakan;
  m.roundNo = snap.roundNo;
  m.history = snap.history;
  m.finished = snap.finished;
  m.winner = snap.winner;
  m.loser = snap.loser;
  m.round = snap.round ? reviveRound(snap.round, m) : null;
  return m;
}

export class GameServer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = new Map();
    this.timers = [];
    this.timerSeq = 0;
    this.authEnabled = env.AUTH_ENABLED === '1';

    state.blockConcurrencyWhile(async () => {
      const saved = await state.storage.get(STORAGE_KEY);
      if (!saved) return;
      this.timerSeq = saved.timerSeq || 0;
      this.timers = saved.timers || [];
      for (const [code, snap] of Object.entries(saved.rooms || {})) {
        const room = this._reviveRoom(snap);
        this.rooms.set(code, room);
      }
      // Rebind live (hibernated) sockets to their seats.
      for (const ws of state.getWebSockets()) {
        const att = this._attachment(ws);
        if (!att || !att.code) continue;
        const room = this.rooms.get(att.code);
        if (!room) continue;
        const seat = room.seats[att.seat];
        if (seat && seat.kind === 'human' && seat.token === att.token) {
          seat.ws = ws;
          seat.connected = true;
        }
      }
      this._armAlarm();
      if (this.rooms.size) this._ensureSweep();
    });
  }

  _reviveRoom(snap) {
    const room = {
      code: snap.code,
      phase: snap.phase,
      seats: snap.seats.map((s) => ({ ...s, ws: null })),
      trickHold: snap.trickHold || null,
      match: null,
    };
    room.emit = (evt) => this._onMatchEvent(room, evt);
    room.match = snap.match ? reviveMatch(snap.match, room.emit) : null;
    return room;
  }

  async _persist() {
    const rooms = {};
    for (const [code, room] of this.rooms) {
      rooms[code] = {
        code: room.code,
        phase: room.phase,
        seats: room.seats.map((s) => ({
          kind: s.kind, name: s.name, avatar: s.avatar, country: s.country,
          photo: s.photo, voiceOn: !!s.voiceOn,
          token: s.token, connected: s.connected, disconnectAt: s.disconnectAt,
        })),
        trickHold: room.trickHold,
        match: snapshotMatch(room.match),
      };
    }
    await this.state.storage.put(STORAGE_KEY, {
      rooms, timers: this.timers, timerSeq: this.timerSeq,
    });
  }

  // ------------------------------------------------------------ alarms
  _schedule(kind, delay, data = {}) {
    const t = { id: ++this.timerSeq, at: Date.now() + delay, kind, ...data };
    this.timers.push(t);
    this._armAlarm();
    return t.id;
  }
  _cancelTimers(code, kind) {
    const before = this.timers.length;
    this.timers = this.timers.filter((t) => !(t.code === code && (kind === undefined || t.kind === kind)));
    if (this.timers.length !== before) this._armAlarm();
  }
  _armAlarm() {
    if (!this.timers.length) {
      this.state.storage.deleteAlarm().catch(() => {});
      return;
    }
    const at = Math.min(...this.timers.map((t) => t.at));
    this.state.storage.setAlarm(at).catch(() => {});
  }
  _ensureSweep() {
    if (!this.timers.some((t) => t.kind === 'sweep')) this._schedule('sweep', SWEEP_MS, {});
  }

  async alarm() {
    const now = Date.now();
    const due = this.timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at || a.id - b.id);
    this.timers = this.timers.filter((t) => t.at > now);
    for (const t of due) {
      try { this._fireTimer(t); } catch { /* one bad timer must not kill the rest */ }
    }
    this._armAlarm();
    await this._persist();
  }

  _fireTimer(t) {
    if (t.kind === 'sweep') {
      this._sweep();
      if (this.rooms.size) this._schedule('sweep', SWEEP_MS, {});
      return;
    }
    const room = this.rooms.get(t.code);
    if (!room) return;
    if (t.kind === 'turn') {
      this._botPlay(room, t.seat, t.mayDeclare);
    } else if (t.kind === 'trick') {
      room.trickHold = null;
      if (!this.rooms.has(room.code)) return;
      this._broadcastState(room);
      this._pumpTurn(room);
    } else if (t.kind === 'round') {
      if (!this.rooms.has(room.code) || room.match.finished) return;
      room.phase = 'playing';
      room.match.startRound();
      this._broadcastState(room);
      this._pumpTurn(room);
    }
  }

  /** Expire disconnected seats after the grace window; drop dead lobby rooms. */
  _sweep() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      let changed = false;
      room.seats.forEach((s, i) => {
        if (s.kind === 'human' && !s.connected && s.disconnectAt &&
            now - s.disconnectAt > RECONNECT_GRACE_MS) {
          if (room.phase === 'lobby') {
            room.seats[i] = emptySeat();
          } else {
            s.kind = 'bot'; // bot takes over the seat and its hand
            s.avatar = null;
            s.country = '';
            s.photo = null;
            s.voiceOn = false;
            s.connected = true;
            changed = true;
            this._pumpTurn(room);
          }
          changed = true;
        }
      });
      if (changed) this._broadcastState(room);
      const anyHuman = room.seats.some((s) => s.kind === 'human');
      if (!anyHuman) {
        this._cancelTimers(room.code);
        this.rooms.delete(room.code);
      }
    }
  }

  // ------------------------------------------------------------- fetch
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }
    // The Worker verifies the session cookie and forwards the user here;
    // with AUTH on, a socket without a user is refused (defence in depth —
    // the Worker already 401s it before the upgrade reaches us).
    let user = null;
    const userHeader = request.headers.get('x-tore-user');
    if (userHeader) { try { user = JSON.parse(userHeader); } catch { user = null; } }
    if (this.authEnabled && !user) {
      return new Response('unauthorized — sign in first', { status: 401 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ code: null, seat: -1, token: null, user });
    return new Response(null, { status: 101, webSocket: client });
  }

  _attachment(ws) {
    try { return ws.deserializeAttachment(); } catch { return null; }
  }
  _saveAttachment(ws, att) {
    try { ws.serializeAttachment(att); } catch { /* ignore */ }
  }

  // ------------------------------------------------------ ws handlers
  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)); }
    catch { return; }
    const att = this._attachment(ws) || { code: null, seat: -1, token: null, user: null };
    try { this._handleMessage(ws, att, msg); }
    catch { sendError(ws, 'خطای سرور'); }
    await this._persist();
  }

  async webSocketClose(ws) {
    this._onDisconnect(ws);
    await this._persist();
  }

  async webSocketError(ws) {
    this._onDisconnect(ws);
    await this._persist();
  }

  _onDisconnect(ws) {
    const att = this._attachment(ws);
    if (!att || !att.code) return;
    const room = this.rooms.get(att.code);
    if (!room) return;
    const seat = room.seats[att.seat];
    if (!seat || seat.ws !== ws) return;
    seat.ws = null;
    seat.connected = false;
    seat.disconnectAt = Date.now();
    if (seat.voiceOn) {
      seat.voiceOn = false;
      this._broadcastEvent(room, { type: 'voice', seat: att.seat, on: false });
    }
    this._broadcastState(room);
  }

  // ------------------------------------------------------------ rooms
  _newCode() {
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    } while (this.rooms.has(code));
    return code;
  }

  _createRoom() {
    const room = {
      code: this._newCode(),
      seats: [emptySeat(), emptySeat(), emptySeat(), emptySeat()],
      phase: 'lobby', // lobby | playing | roundEnd | matchEnd
      match: null,
      trickHold: null, // { plays: [{seat, card}...], winnerSeat } while a finished trick is displayed
    };
    room.emit = (evt) => this._onMatchEvent(room, evt);
    this.rooms.set(room.code, room);
    this._ensureSweep();
    return room;
  }

  _hostSeat(room) {
    const i = room.seats.findIndex((s) => s.kind === 'human');
    return i === -1 ? 0 : i;
  }

  // -------------------------------------------------------- state push
  _stateFor(room, seatIdx) {
    const round = room.match ? room.match.round : null;
    const last = room.match && room.match.history.length
      ? room.match.history[room.match.history.length - 1] : null;
    return {
      type: 'state',
      phase: room.phase,
      code: room.code,
      mySeat: seatIdx,
      hostSeat: this._hostSeat(room),
      target: G.BANK_LOSE_TARGET,
      seats: room.seats.map((s, i) => ({
        name: s.name, kind: s.kind, connected: s.connected,
        avatar: s.avatar, country: s.country, photo: s.photo,
        voice: !!s.voiceOn,
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

  _broadcastState(room) {
    room.seats.forEach((s, i) => {
      if (s.kind === 'human' && s.connected && s.ws) send(s.ws, this._stateFor(room, i));
    });
  }
  _broadcastEvent(room, obj) {
    room.seats.forEach((s) => {
      if (s.kind === 'human' && s.connected && s.ws) send(s.ws, obj);
    });
  }

  // ---------------------------------------------------------- game flow
  _onMatchEvent(room, evt) {
    if (evt.type === 'takan') {
      this._broadcastEvent(room, { type: 'takan', seat: evt.seat, team: evt.team, count: evt.count });
    } else if (evt.type === 'declared13') {
      this._broadcastEvent(room, { type: 'declared13', seat: evt.seat });
    }
    if (evt.type === 'roundFinished') {
      room.phase = 'roundEnd';
      this._cancelTimers(room.code, 'turn');
      this._broadcastState(room);
      this._cancelTimers(room.code, 'round');
      this._schedule('round', ROUND_PAUSE_MS, { code: room.code });
    } else if (evt.type === 'matchFinished') {
      room.phase = 'matchEnd';
      this._cancelTimers(room.code, 'turn');
      this._cancelTimers(room.code, 'round');
      this._broadcastState(room);
    }
    // cardPlayed / trickWon need no immediate push: state is pushed after
    // every completed play() call in _doPlay().
  }

  _doPlay(room, seat, card) {
    const round = room.match && room.match.round;
    if (!round) return false;
    if (room.trickHold) return false; // finished trick still on display — plays wait for the pause
    const tricksBefore = round.tricksPlayed;
    const trickBefore = round.trick.slice();
    try {
      round.play(seat, card);
    } catch {
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
      this._cancelTimers(room.code, 'turn');
      this._broadcastState(room);
      this._cancelTimers(room.code, 'trick');
      this._schedule('trick', TRICK_PAUSE_MS, { code: room.code });
      return true;
    }
    this._broadcastState(room);
    this._pumpTurn(room);
    return true;
  }

  /**
   * Play a seat by bot logic. `mayDeclare` is true only for real bot seats:
   * bots always declare «13» on the final trick when it cancels a takan.
   * A human seat auto-played by the turn timer plays WITHOUT declaring
   * (spec: on timeout the takan stands).
   */
  _botPlay(room, seat, mayDeclare) {
    const round = room.match && room.match.round;
    if (!round || round.finished || round.turn !== seat) return;
    if (room.trickHold) return;
    if (mayDeclare && maybeDeclare13(round, seat)) {
      this._broadcastState(room); // clients toast the declaration…
      this._pumpTurn(room);       // …then the bot plays its card on the next tick
      return;
    }
    let card;
    try { card = chooseCard(round, seat); } catch { return; }
    this._doPlay(room, seat, card);
  }

  /** (Re)arm the action for whoever is on turn: bot → quick, human → 30 s. */
  _pumpTurn(room) {
    this._cancelTimers(room.code, 'turn');
    if (room.trickHold) return; // the trick-pause timer re-arms the turn when it fires
    if (room.phase !== 'playing' || !room.match || !room.match.round) return;
    const round = room.match.round;
    if (round.finished) return;
    const seat = round.turn;
    const info = room.seats[seat];
    const delay = info.kind === 'bot' ? BOT_DELAY_MS : TURN_TIMEOUT_MS;
    this._schedule('turn', delay, { code: room.code, seat, mayDeclare: info.kind === 'bot' });
  }

  _startMatch(room) {
    this._cancelTimers(room.code, 'trick');
    room.trickHold = null;
    const botDigits = ['1', '2', '3'];
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
    this._broadcastState(room);
    this._pumpTurn(room);
  }

  // ------------------------------------------------------- seat lifecycle
  _attachPlayer(ws, att, room, seatIdx, name, prof) {
    const seat = room.seats[seatIdx];
    seat.kind = 'human';
    seat.name = name;
    seat.avatar = cleanAvatar(prof && prof.avatar);
    seat.country = cleanCountry(prof && prof.country);
    seat.photo = seat.avatar === 'google' ? cleanPhoto(prof && prof.photo) : null;
    seat.token = randomHex(8);
    seat.ws = ws;
    seat.connected = true;
    seat.disconnectAt = null;
    att.code = room.code;
    att.seat = seatIdx;
    att.token = seat.token;
    this._saveAttachment(ws, att);
    send(ws, {
      type: 'room', code: room.code, seat: seatIdx, token: seat.token,
      isHost: seatIdx === this._hostSeat(room),
    });
    this._broadcastState(room);
  }

  _handleMessage(ws, att, msg) {
    // Auth gate: with AUTH on, room actions need the signed-in user the
    // Worker verified from the session cookie (carried in the attachment).
    const needsAuth = msg.type === 'create' || msg.type === 'join' || msg.type === 'reconnect';
    if (this.authEnabled && needsAuth && !att.user) {
      return sendError(ws, 'اول با گوگل یا فیسبوک وارد شو');
    }
    switch (msg.type) {
      case 'create': {
        const room = this._createRoom();
        this._attachPlayer(ws, att, room, 0, displayName(msg, att.user), msg);
        break;
      }
      case 'join': {
        const room = this.rooms.get(String(msg.code || '').toUpperCase().trim());
        if (!room) return sendError(ws, 'اتاق پیدا نشد — کد را بررسی کن');
        if (room.phase !== 'lobby') return sendError(ws, 'بازی این اتاق شروع شده است');
        const idx = room.seats.findIndex((s) => s.kind === 'empty');
        if (idx === -1) return sendError(ws, 'اتاق پر است');
        this._attachPlayer(ws, att, room, idx, displayName(msg, att.user), msg);
        break;
      }
      case 'reconnect': {
        const room = this.rooms.get(String(msg.code || '').toUpperCase().trim());
        if (!room) return sendError(ws, 'نشست منقضی شده است — اتاق تازه بساز');
        const idx = room.seats.findIndex((s) => s.kind === 'human' && s.token === msg.token);
        if (idx === -1) return sendError(ws, 'نشست منقضی شده است — اتاق تازه بساز');
        const seat = room.seats[idx];
        if (seat.ws && seat.ws !== ws) { try { seat.ws.close(1012, 'replaced'); } catch { /* ignore */ } }
        // A reconnect may carry the player's current profile — refresh it.
        const av = cleanAvatar(msg.avatar); if (av) seat.avatar = av;
        const co = cleanCountry(msg.country); if (co) seat.country = co;
        if (seat.avatar === 'google') {
          const ph = cleanPhoto(msg.photo); if (ph) seat.photo = ph;
        } else {
          seat.photo = null; // the photo belongs to the 'google' avatar only
        }
        seat.ws = ws;
        seat.connected = true;
        seat.disconnectAt = null;
        att.code = room.code;
        att.seat = idx;
        att.token = seat.token;
        this._saveAttachment(ws, att);
        send(ws, {
          type: 'room', code: room.code, seat: idx, token: seat.token,
          isHost: idx === this._hostSeat(room),
        });
        this._broadcastState(room);
        break;
      }
      case 'start': {
        const room = this.rooms.get(att.code);
        if (!room || room.phase !== 'lobby') return;
        if (att.seat !== this._hostSeat(room)) return sendError(ws, 'فقط میزبان می‌تواند بازی را شروع کند');
        this._startMatch(room);
        break;
      }
      case 'declare13': {
        const room = this.rooms.get(att.code);
        if (!room || room.phase !== 'playing') return;
        if (room.trickHold) { send(ws, this._stateFor(room, att.seat)); return; } // trick on display — resync silently
        const round = room.match && room.match.round;
        if (!round) return;
        try {
          round.declare13(att.seat); // emits declared13 → clients toast it
          this._broadcastState(room);
        } catch {
          sendError(ws, 'الآن نمی‌توانی «13» بگویی');
          send(ws, this._stateFor(room, att.seat));
        }
        break;
      }
      case 'play': {
        const room = this.rooms.get(att.code);
        if (!room || room.phase !== 'playing') return;
        if (room.trickHold) { send(ws, this._stateFor(room, att.seat)); return; } // trick on display — resync silently, no error
        if (!this._doPlay(room, att.seat, String(msg.card || ''))) {
          // Illegal move: explain in Dari and resync the client.
          const round = room.match.round;
          let why = 'این ورق را نمی‌توانی بازی کنی';
          if (round && round.turn !== att.seat) why = 'نوبت تو نیست';
          else if (round && !round.hands[att.seat].includes(msg.card)) why = 'این ورق در دستت نیست';
          else if (round) why = 'باید از رنگِ ورقِ اول (' + G.SUIT_NAMES[round.ledSuit()] + ') بیایی';
          sendError(ws, why);
          send(ws, this._stateFor(room, att.seat));
        }
        break;
      }
      case 'chat': {
        const room = this.rooms.get(att.code);
        if (!room) return;
        const seat = room.seats[att.seat];
        if (!seat || seat.kind !== 'human') return;
        const c = cleanChat(msg.kind, msg.value);
        if (!c) return; // not on the preset allowlists — drop silently
        const now = Date.now();
        if (seat.lastChatAt && now - seat.lastChatAt < CHAT_MIN_INTERVAL_MS) return; // too fast — drop silently
        seat.lastChatAt = now;
        this._broadcastEvent(room, { type: 'chat', seat: att.seat, name: seat.name, kind: c.kind, value: c.value, ts: now });
        break;
      }
      case 'voice': {
        const room = this.rooms.get(att.code);
        if (!room) return;
        const seat = room.seats[att.seat];
        if (!seat || seat.kind !== 'human') return;
        const on = !!msg.on;
        if (seat.voiceOn === on) return;
        seat.voiceOn = on;
        this._broadcastEvent(room, { type: 'voice', seat: att.seat, on });
        break;
      }
      case 'rtc': {
        // WebRTC signaling: relay `data` to exactly one other human
        // seat in the same room; the audio itself is peer-to-peer.
        const room = this.rooms.get(att.code);
        if (!room) return;
        const seat = room.seats[att.seat];
        if (!seat || seat.kind !== 'human') return;
        const to = msg.to;
        if (!Number.isInteger(to) || to < 0 || to > 3 || to === att.seat) return;
        const target = room.seats[to];
        if (!target || target.kind !== 'human' || !target.connected || !target.ws) return;
        let raw;
        try { raw = JSON.stringify(msg.data); } catch { return; }
        if (raw === undefined || raw.length > RTC_MAX_BYTES) return;
        send(target.ws, { type: 'rtc', from: att.seat, data: msg.data });
        break;
      }
    }
  }
}
