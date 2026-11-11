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
 * Node server (types: create/join/reconnect/start/leave/play/
 * declare13/chat/voice/rtc in; room/state/error/takan/declared13/
 * chat/voice/rtc/roomClosed out) so the existing client works
 * unchanged apart from the /ws path.
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
 *    closures and rng are re-wired on revive). Snapshots are PER
 *    ROOM (key "tore:room:<CODE>"; timers under "tore:timers") so a
 *    single bad or oversized write can never poison the whole room
 *    directory at once, and the admission reply (the code a host
 *    shares) is sent only after the room's snapshot is durable. A
 *    legacy single-blob snapshot ("tore:v1", written by versions up
 *    to 2026-11-08) is migrated to per-room keys on first wake.
 *    Join/reconnect additionally READ-REPAIR: a room missing from
 *    memory but present in storage is revived on the spot instead of
 *    answering roomNotFound/sessionExpired.
 */

import * as G from './game.js';
import { chooseCard, maybeDeclare13 } from './bots.js';
import { SocialCore } from './social-core.js';

// ---- Tunables (same values as ../server.js) ----
const TURN_TIMEOUT_MS = 30000;    // a stalled human seat is played by a bot
const BOT_DELAY_MS = 750;         // bot "thinking" delay (watchable pace)
const ROUND_PAUSE_MS = 6000;      // round-summary pause before next round
const TRICK_PAUSE_MS = 1600;      // completed trick stays on the table before it is collected
const RECONNECT_GRACE_MS = 120000; // seat+hand kept for a reconnecting player
const SPECTATOR_CAP = 20;          // clubs v8: watchers per club-game room
const SWEEP_MS = 10000;           // seat-expiry sweep cadence (was setInterval)

const STORAGE_KEY = 'tore:v1'; // legacy single-blob snapshot (read + migrate, never written)
const ROOM_KEY_PREFIX = 'tore:room:'; // one snapshot per room: tore:room:<CODE>
const TIMERS_KEY = 'tore:timers'; // { timers, timerSeq }
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
// Same rule as the Node server: the client's persistent player id,
// used for the seat's social identity when no account session backs
// the socket. Anything else becomes null.
function cleanPid(pid) {
  return (typeof pid === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(pid)) ? pid : null;
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
/** Seat display name: the player's own profile name wins; when it is
 *  empty and the player is signed in, default to the account name. */
function displayName(msg, user) {
  const raw = String(msg.name || '').trim();
  if (raw) return cleanName(raw);
  if (user && user.name) return cleanName(user.name);
  return cleanName('');
}

function emptySeat() {
  return { kind: 'empty', name: '', avatar: null, country: '', photo: null, token: null, ws: null, connected: false, disconnectAt: null, voiceMic: false, voiceSpeaker: true, lastChatAt: 0, sid: null };
}

function send(ws, obj) {
  if (!ws) return;
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch { /* socket already gone */ }
}
// Every error carries a stable machine `code` next to the Dari
// `message`: the client translates by code into the player's chosen
// language and falls back to the raw Dari text when a code is unknown.
// `extra` merges payload fields (e.g. { suit } for mustFollowSuit).
function sendError(ws, msg, code, extra) {
  send(ws, Object.assign({ type: 'error', message: msg, code }, extra || {}));
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
    takanSuits: r.takanSuits, botSeats: r.botSeats,
    finished: r.finished, result: r.result,
  };
}
function reviveRound(snap, match) {
  const r = Object.create(G.Round.prototype);
  Object.assign(r, snap);
  // Legacy snapshots (pre BOT NO-REPEAT LAW) lack these — default them.
  if (!r.takanSuits) r.takanSuits = [[], [], [], []];
  if (!r.botSeats) r.botSeats = [false, false, false, false];
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
    winner: m.winner, loser: m.loser, botSeats: m.botSeats,
    round: snapshotRound(m.round),
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
  m.botSeats = snap.botSeats || [false, false, false, false]; // legacy snapshots lack it
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
    this.social = null; // SocialCore, lazily built by _ensureSocial()
    this._pendingDeletes = new Set(); // room codes whose storage key still needs deleting
    this._reapedRooms = new Set(); // rooms mutated by a social-side reap; persisted after the message
    // Busy-flag liveness window (stale-busy fix, 2026-11-09): a
    // seat counts toward "busy" while connected or disconnected
    // inside this grace. TORE_BUSY_GRACE_MS is a test lever only;
    // production uses the reconnect grace.
    const bgv = Number(env && env.TORE_BUSY_GRACE_MS);
    this.busyGraceMs = (Number.isFinite(bgv) && bgv >= 0) ? bgv : RECONNECT_GRACE_MS;

    state.blockConcurrencyWhile(async () => {
      // Timers (their own small key; the legacy blob carried them too).
      const meta = await state.storage.get(TIMERS_KEY).catch(() => null);
      if (meta) {
        this.timerSeq = meta.timerSeq || 0;
        this.timers = Array.isArray(meta.timers) ? meta.timers : [];
      }
      // Per-room snapshots — the current format.
      const listed = await state.storage.list({ prefix: ROOM_KEY_PREFIX }).catch(() => new Map());
      for (const snap of listed.values()) {
        if (snap && snap.code && Array.isArray(snap.seats)) {
          this.rooms.set(snap.code, this._reviveRoom(snap));
        }
      }
      // Legacy single-blob snapshot: adopt whatever it holds (rooms
      // not already loaded per-room win a per-room key), adopt its
      // timers when no timers key exists yet, then drop the blob so
      // it can never shadow newer state.
      const legacy = await state.storage.get(STORAGE_KEY).catch(() => null);
      if (legacy) {
        if (!meta && Array.isArray(legacy.timers)) {
          this.timers = legacy.timers;
          this.timerSeq = legacy.timerSeq || 0;
        }
        for (const snap of Object.values(legacy.rooms || {})) {
          if (snap && snap.code && Array.isArray(snap.seats) && !this.rooms.has(snap.code)) {
            const room = this._reviveRoom(snap);
            this.rooms.set(snap.code, room);
            await this._putRoom(room).catch(() => {});
          }
        }
        await state.storage.delete(STORAGE_KEY).catch(() => {});
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
      seats: snap.seats.map((s) => {
        const seat = { ...s, ws: null };
        // Voice flags were a single voiceOn before the mic/speaker
        // split: an old snapshot's voiceOn is its mic; speaker
        // defaults to on (the client's default).
        if (seat.voiceMic === undefined) seat.voiceMic = !!seat.voiceOn;
        if (seat.voiceSpeaker === undefined) seat.voiceSpeaker = true;
        delete seat.voiceOn;
        return seat;
      }),
      trickHold: snap.trickHold || null,
      club: snap.club || null, // clubs v8: {cid, name} club-game stamp (spectators are runtime-only)
      spectators: new Set(),
      match: null,
    };
    room.emit = (evt) => this._onMatchEvent(room, evt);
    room.match = snap.match ? reviveMatch(snap.match, room.emit) : null;
    return room;
  }

  _roomSnapshot(room) {
    return {
      code: room.code,
      phase: room.phase,
      seats: room.seats.map((s) => ({
        kind: s.kind, name: s.name, avatar: s.avatar, country: s.country,
        photo: s.photo, sid: s.sid || null, voiceMic: !!s.voiceMic, voiceSpeaker: s.voiceSpeaker !== false,
        token: s.token, connected: s.connected, disconnectAt: s.disconnectAt,
      })),
      trickHold: room.trickHold,
      club: room.club || null,
      match: snapshotMatch(room.match),
    };
  }

  async _putRoom(room) {
    await this.state.storage.put(ROOM_KEY_PREFIX + room.code, this._roomSnapshot(room));
  }

  /** Persist one room; a failed write is logged, never thrown — the
   *  next mutation/alarm re-runs _persist() and retries every room,
   *  and join/reconnect read-repair can still find the last good
   *  snapshot. One room's bad write must not break the handler that
   *  triggered it (the old single-blob _persist threw OUT of
   *  webSocketMessage after the reply had already been sent). */
  async _persistRoom(room) {
    try { await this._putRoom(room); }
    catch (e) { console.error('tore: room persist failed', room.code, e && e.message); }
  }

  async _persist() {
    for (const room of this.rooms.values()) await this._persistRoom(room);
    // Rooms removed since the last flush lose their storage key too —
    // otherwise a later read-repair/wake would resurrect them.
    for (const code of [...this._pendingDeletes]) {
      if (this.rooms.has(code)) { this._pendingDeletes.delete(code); continue; }
      try {
        await this.state.storage.delete(ROOM_KEY_PREFIX + code);
        this._pendingDeletes.delete(code);
      } catch { /* retried on the next flush */ }
    }
    try {
      await this.state.storage.put(TIMERS_KEY, {
        timers: this.timers, timerSeq: this.timerSeq,
      });
    } catch (e) { console.error('tore: timers persist failed', e && e.message); }
  }

  /** Read-repair: a room missing from memory but present in storage
   *  (per-room key, or the legacy blob) is revived on the spot. Used
   *  by join/reconnect so a stale in-memory directory can never
   *  answer "room not found" for a room that is actually stored. */
  async _loadRoom(code) {
    // The in-memory copy is canonical: never revive a second object
    // for a room this DO already holds (duplicate-seat fix, 2026-11-09
    // — two handlers racing a read-repair could otherwise each revive
    // their own copy and seat the same identity once per copy).
    const held = this.rooms.get(code);
    if (held) return held;
    const snap = await this.state.storage.get(ROOM_KEY_PREFIX + code).catch(() => null);
    if (snap && snap.code && Array.isArray(snap.seats)) {
      const raced = this.rooms.get(code);
      if (raced) return raced;
      const room = this._reviveRoom(snap);
      this.rooms.set(code, room);
      this._ensureSweep();
      return room;
    }
    const legacy = await this.state.storage.get(STORAGE_KEY).catch(() => null);
    const lsnap = legacy && legacy.rooms ? legacy.rooms[code] : null;
    if (lsnap && Array.isArray(lsnap.seats)) {
      const raced = this.rooms.get(code);
      if (raced) return raced;
      const room = this._reviveRoom(lsnap);
      this.rooms.set(code, room);
      this._ensureSweep();
      await this._persistRoom(room); // give it its per-room key
      return room;
    }
    return null;
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

  /** Expire disconnected seats after the grace window — IN-MATCH ONLY.
   *  A WAITING room never expires (owner order 2026-11-07): its code
   *  stays joinable until the match starts or the host cancels it, and
   *  a lobby seat stays reserved through a disconnect of any length,
   *  so the host (or a guest) can always reconnect back into it. */
  _sweep() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
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
          this._pumpTurn(room);
        }
      });
      if (changed) this._broadcastState(room);
      if (goneSids.length) this._syncBusyFor(null, goneSids);
      const anyHuman = room.seats.some((s) => s.kind === 'human');
      if (!anyHuman) {
        this._cancelTimers(room.code);
        this._sendToSpectators(room, { type: 'roomClosed', code: 'roomCancelled' });
        this.rooms.delete(room.code);
        this._pendingDeletes.add(room.code);
        this._syncClubGame(room);
      }
    }
  }

  // ------------------------------------------------------------- fetch
  async fetch(request) {
    // Uploaded club covers are plain HTTP, not sockets: POST
    // /club-cover stores the owner's photo; GET /club-cover/<cid>
    // serves it back publicly. Everything else is a socket.
    const reqPath = new URL(request.url).pathname;
    if (reqPath === '/club-cover' && request.method === 'POST') return this._coverUpload(request);
    if (reqPath.startsWith('/club-cover/') && request.method === 'GET') return this._coverGet(reqPath.slice('/club-cover/'.length));
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
    // Friends-system sockets ride the /social path: tagged so they
    // can be found as a group, with their own attachment shape (the
    // resolved social identity `sid` is filled in by the hello).
    if (new URL(request.url).pathname === '/social') {
      this.state.acceptWebSocket(server, ['social']);
      server.serializeAttachment({ social: true, sid: null, user });
      return new Response(null, { status: 101, webSocket: client });
    }
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ code: null, seat: -1, token: null, user });
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------------------------------------------------------- social
  // The friends system (social-core.js — the same implementation the
  // Node servers run). State persists under its own storage key,
  // keyed by identity: "g:<sub>" for a signed-in account (the Worker
  // verified the session and forwarded the user), else "p:<pid>"
  // from the client's persistent player id (auth-off local runs).
  async _ensureSocial() {
    if (this.social) return this.social;
    const core = new SocialCore({
      sendTo: (id, obj) => this._socialSend(id, obj),
      persist: (data) => { this.state.storage.put('social:v1', data).catch(() => {}); },
      persistClubs: (data) => { this.state.storage.put('clubs:v1', data).catch(() => {}); },
      inviteRoomCheck: (id, code) => this._socialRoomCheck(id, code),
      inGameCheck: (id) => this._isInGame(id),
      inLobbyCheck: (id) => this._isInLobby(id),
      verifyBusy: (id) => this._verifyBusy(id),
      // Clubs v8: the club's live game room, scanned from the room table.
      clubGameLookup: (cid) => this._clubGameLookup(cid),
      coverBlobDelete: (cid) => { this._deleteCoverBlob(cid); },
    });
    const saved = await this.state.storage.get('social:v1').catch(() => null);
    if (saved) core.load(saved);
    const savedClubs = await this.state.storage.get('clubs:v1').catch(() => null);
    if (savedClubs) core.loadClubs(savedClubs);
    // Presence is rebuilt from the live (possibly hibernated)
    // sockets — their attachments kept the resolved identities.
    const ids = [];
    for (const ws of this.state.getWebSockets('social')) {
      const att = this._attachment(ws);
      if (att && att.sid) ids.push(att.sid);
    }
    core.rebuildOnline(ids);
    this.social = core;
    return core;
  }

  _socialSend(id, obj) {
    const data = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets('social')) {
      const att = this._attachment(ws);
      if (att && att.sid === id) { try { ws.send(data); } catch { /* gone */ } }
    }
  }

  // ------------------------------------------ uploaded club covers
  // An owner's cover photo lives in THIS object's storage under
  // coverimg:<cid> (a small meta record) + coverimg:<cid>:<i>
  // chunks of 96 KB — one storage value stays far under the size
  // limit while the upload cap is 250 KB (at most 3 chunks).
  // Nothing else references the chunks, so dissolve / gallery
  // switch cleanup is just deleting the key family (the social
  // core calls the coverBlobDelete hook at exactly those moments;
  // a re-upload overwrites in place and drops stale tail chunks).
  async _putCoverBlob(cid, type, buf) {
    const CH = 96 * 1024;
    const u8 = new Uint8Array(buf);
    const chunks = Math.max(1, Math.ceil(u8.byteLength / CH));
    const old = await this.state.storage.get('coverimg:' + cid).catch(() => null);
    const puts = {};
    for (let i = 0; i < chunks; i++) puts['coverimg:' + cid + ':' + i] = u8.slice(i * CH, (i + 1) * CH).buffer;
    puts['coverimg:' + cid] = { type, len: u8.byteLength, chunks };
    await this.state.storage.put(puts);
    if (old && old.chunks > chunks) {
      const stale = [];
      for (let i = chunks; i < old.chunks; i++) stale.push('coverimg:' + cid + ':' + i);
      if (stale.length) await this.state.storage.delete(stale).catch(() => {});
    }
  }
  async _getCoverBlob(cid) {
    const meta = await this.state.storage.get('coverimg:' + cid).catch(() => null);
    if (!meta || !meta.chunks) return null;
    const keys = [];
    for (let i = 0; i < meta.chunks; i++) keys.push('coverimg:' + cid + ':' + i);
    const got = await this.state.storage.get(keys).catch(() => null);
    if (!got) return null;
    const out = new Uint8Array(meta.len);
    let off = 0;
    for (const k of keys) {
      const part = got.get(k);
      if (!part) return null;
      out.set(new Uint8Array(part), off);
      off += part.byteLength;
    }
    return { type: meta.type || 'image/jpeg', body: out };
  }
  async _deleteCoverBlob(cid) {
    try {
      const meta = await this.state.storage.get('coverimg:' + cid).catch(() => null);
      const keys = ['coverimg:' + cid];
      if (meta && meta.chunks) for (let i = 0; i < meta.chunks; i++) keys.push('coverimg:' + cid + ':' + i);
      await this.state.storage.delete(keys);
    } catch { /* already gone */ }
  }
  // POST /club-cover: the Worker verified the session (gate on)
  // and forwarded the user; with the gate off the client's player
  // id header is the identity, exactly like the social hello.
  // Rules: owner-only for the caller's own club, image/jpeg|png|
  // webp, at most 250 KB. The record flips through the core, so
  // every member's client re-renders with the new ?v= URL at once.
  async _coverUpload(request) {
    const json = (status, obj) => new Response(JSON.stringify(obj), {
      status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
    let user = null;
    const userHeader = request.headers.get('x-tore-user');
    if (userHeader) { try { user = JSON.parse(userHeader); } catch { user = null; } }
    if (this.authEnabled && !user) return json(401, { error: 'unauthorized' });
    let identity = null;
    if (user && user.sub) identity = 'g:' + user.sub;
    else {
      const pid = request.headers.get('x-tore-pid');
      if (typeof pid === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(pid)) identity = 'p:' + pid;
    }
    if (!identity) return json(401, { error: 'unauthorized' });
    const type = String(request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) return json(415, { error: 'coverBadType' });
    const buf = await request.arrayBuffer();
    if (!buf.byteLength) return json(400, { error: 'coverEmpty' });
    if (buf.byteLength > 250 * 1024) return json(413, { error: 'coverTooBig' });
    const core = await this._ensureSocial();
    const club = core.ownedClub(identity);
    if (!club) return json(403, { error: 'clubNoPerm' });
    await this._putCoverBlob(club.cid, type, buf);
    const out = core.setCustomCover(identity);
    if (!out) { await this._deleteCoverBlob(club.cid); return json(403, { error: 'clubNoPerm' }); }
    return json(200, { ok: true, cid: out.cid, v: out.v });
  }
  // GET /club-cover/<cid>: public read, versioned by the client's
  // ?v=<coverV> — immutable caching is safe.
  async _coverGet(cid) {
    if (!/^\d{6}$/.test(cid)) return new Response('not found', { status: 404 });
    const blob = await this._getCoverBlob(cid);
    if (!blob) return new Response('not found', { status: 404 });
    return new Response(blob.body, {
      headers: { 'Content-Type': blob.type, 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
  }

  // Busy-flag liveness (stale-busy fix, 2026-11-09): a seat counts
  // toward "busy" only while its player is actually there —
  // connected, or disconnected inside the busy grace (a transient
  // drop; the client auto-reconnects within seconds). A lobby seat
  // stays RESERVED past that (the sweep never expires a waiting
  // room, so the player can always reconnect back into it), but a
  // long-dead seat must not report its owner busy forever.
  _seatLive(s) {
    return s.connected || (!!s.disconnectAt && Date.now() - s.disconnectAt <= this.busyGraceMs);
  }

  _isInGame(id) {
    if (!id) return false;
    for (const room of this.rooms.values()) {
      if (room.phase === 'lobby') continue;
      if (room.seats.some((s) => s.kind === 'human' && s.sid === id && this._seatLive(s))) return true;
    }
    return false;
  }

  // A seat in a WAITING room: lobby-sitters are uninvitable too
  // (owner order 2026-11-09) — the social core reports them socialBusy.
  _isInLobby(id) {
    if (!id) return false;
    for (const room of this.rooms.values()) {
      if (room.phase !== 'lobby') continue;
      if (room.seats.some((s) => s.kind === 'human' && s.sid === id && this._seatLive(s))) return true;
    }
    return false;
  }

  // Invite-time verification (stale-busy fix, 2026-11-09): re-check
  // the busy claim against live room state. Every seat of this
  // identity that is NOT live (socket dead past the busy grace —
  // the app was closed without leaving) is reaped on the spot: a
  // lobby seat is freed (the first remaining human becomes host,
  // exactly like a guest leaving; a lobby left with no humans is
  // deleted), an in-match seat gets the sweep's bot conversion.
  // The corrected presence is pushed via _syncBusyFor, and the
  // VERIFIED state is returned: 'match' | 'lobby' | ''. Live seats
  // verify unchanged. Mutated rooms are queued in _reapedRooms —
  // _socialMessage persists them once the core call returns.
  _verifyBusy(id) {
    if (!id) return '';
    let state = '';
    for (const room of [...this.rooms.values()]) {
      let changed = false;
      room.seats.forEach((s, i) => {
        if (s.kind !== 'human' || s.sid !== id) return;
        if (this._seatLive(s)) {
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
          this._pumpTurn(room);
        }
        changed = true;
      });
      if (changed) {
        this._reapedRooms.add(room.code);
        this._broadcastState(room);
        const anyHuman = room.seats.some((s) => s.kind === 'human');
        if (!anyHuman) {
          this._cancelTimers(room.code);
          this._sendToSpectators(room, { type: 'roomClosed', code: 'roomCancelled' });
          this.rooms.delete(room.code);
          this._pendingDeletes.add(room.code);
          this._syncClubGame(room);
        }
      }
    }
    this._syncBusyFor(null, [id]);
    return state;
  }

  _syncBusyFor(room, extraSids) {
    if (!this.social) return;
    const ids = new Set(extraSids || []);
    if (room) room.seats.forEach((s) => { if (s.sid) ids.add(s.sid); });
    ids.forEach((id) => { try { this.social.syncBusy(id); } catch { /* social never breaks the game */ } });
  }

  _socialRoomCheck(id, code) {
    const room = this.rooms.get(code);
    if (!room || room.phase !== 'lobby') return false;
    if (id.startsWith('g:')) {
      // Exact check (social and game state live in this same
      // object): a seat of this room whose game socket belongs to
      // the same signed-in account.
      for (const seat of room.seats) {
        if (seat.kind !== 'human' || !seat.ws) continue;
        const att = this._attachment(seat.ws);
        if (att && att.user && ('g:' + String(att.user.sub)) === id) return true;
      }
      return false;
    }
    return true; // p:<pid> seats carry no account link — spec fallback
  }

  async _socialMessage(ws, att, msg) {
    const core = await this._ensureSocial();
    if (msg.type === 's-hello') {
      const prof = (msg.profile && typeof msg.profile === 'object') ? msg.profile : {};
      let sid = att.sid || null;
      let helloProfile = prof;
      if (att.user && att.user.sub) {
        // Signed-in account wins: identity, name and photo come
        // from the session the Worker verified — never from the
        // client's hello (only the country is the player's own).
        sid = 'g:' + String(att.user.sub);
        helloProfile = {
          name: att.user.name || prof.name,
          avatar: att.user.picture ? 'google' : prof.avatar,
          photo: att.user.picture || '',
          country: prof.country,
        };
      } else if (!sid) {
        const pid = (typeof msg.pid === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(msg.pid))
          ? msg.pid : ('x' + randomHex(6));
        sid = 'p:' + pid;
      }
      if (att.sid !== sid) {
        att.sid = sid;
        this._saveAttachment(ws, att);
        core.socketOpened(sid);
      }
      core.hello(sid, helloProfile);
      return;
    }
    if (!att.sid) return; // hello first
    core.handleMessage(att.sid, msg);
    // An invite may have reaped stale seats (see _verifyBusy): the
    // social path returns before webSocketMessage's trailing
    // persist, so flush the mutated rooms (and any room deletion)
    // here — a reap must survive a DO eviction like any mutation.
    if (this._reapedRooms.size) {
      this._reapedRooms.clear();
      await this._persist();
    }
  }

  _socialDisconnect(ws) {
    const att = this._attachment(ws);
    if (att && att.sid && this.social) this.social.socketClosed(att.sid);
  }

  // ------------------------------------------------------------ club games (v8)
  // A room stamped as a club game (room.club = {cid, name},
  // granted ONLY by SocialCore.clubGameClub at create time) is
  // findable by its club while it waits or plays — the club
  // room's game button badges it and routes member spectators.
  _clubGameLookup(cid) {
    for (const room of this.rooms.values()) {
      if (room.club && room.club.cid === cid &&
          (room.phase === 'lobby' || room.phase === 'playing' || room.phase === 'roundEnd')) {
        return { code: room.code, phase: room.phase };
      }
    }
    return null;
  }

  _syncClubGame(room) {
    if (room && room.club && this.social) {
      try { this.social.clubGameChanged(room.club.cid); } catch { /* social never breaks the game */ }
    }
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
    if (att.social) {
      try { await this._socialMessage(ws, att, msg); } catch { /* social errors never touch the game */ }
      return;
    }
    try { await this._handleMessage(ws, att, msg); }
    catch { sendError(ws, 'خطای سرور', 'serverError'); }
    await this._persist();
  }

  async webSocketClose(ws) {
    const att = this._attachment(ws);
    if (att && att.social) { this._socialDisconnect(ws); return; }
    this._onDisconnect(ws);
    await this._persist();
  }

  async webSocketError(ws) {
    const att = this._attachment(ws);
    if (att && att.social) { this._socialDisconnect(ws); return; }
    this._onDisconnect(ws);
    await this._persist();
  }

  _onDisconnect(ws) {
    const att = this._attachment(ws);
    if (!att) return;
    // Clubs v8: a spectator holds no seat — just leave the watch list.
    if (att.spectator) {
      const sroom = this.rooms.get(att.code);
      if (sroom && sroom.spectators) sroom.spectators.delete(ws);
      return;
    }
    if (!att.code) return;
    const room = this.rooms.get(att.code);
    if (!room) return;
    const seat = room.seats[att.seat];
    if (!seat || seat.ws !== ws) return;
    seat.ws = null;
    seat.connected = false;
    seat.disconnectAt = Date.now();
    if (seat.voiceMic) {
      seat.voiceMic = false;
      this._broadcastEvent(room, { type: 'voice', seat: att.seat, mic: false, speaker: seat.voiceSpeaker !== false, on: false });
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
      club: null, // clubs v8: {cid, name} when a club manager created this room as a club game
      spectators: new Set(), // clubs v8: receive-only sockets watching the public state
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
      club: room.club ? { cid: room.club.cid, name: room.club.name } : null,
      mySeat: seatIdx,
      hostSeat: this._hostSeat(room),
      target: G.BANK_LOSE_TARGET,
      seats: room.seats.map((s, i) => ({
        name: s.name, kind: s.kind, connected: s.connected,
        avatar: s.avatar, country: s.country, photo: s.photo, sid: s.sid || null,
        // The seat's permanent player ID, resolved from the social
        // directory (never client-supplied); null until the player
        // has a directory record (their /social hello creates one).
        uid: s.sid && this.social ? this.social.uidOf(s.sid) : null,
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

  // Clubs v8 — the SPECTATOR state: the full public table (seats,
  // badges, trick, won piles, scores, turn) with every hand
  // stripped. Built from a seat's push with the private fields
  // blanked — hand [], legal [], no declare-13, mySeat -1. The
  // roundResult rides along: game.js history carries only round
  // aggregates (tawan/banked counts), never a card in hand.
  _publicStateFor(room) {
    const st = this._stateFor(room, 0);
    st.mySeat = -1;
    st.spectator = true;
    st.hand = [];
    st.legal = [];
    st.canDeclare13 = false;
    return st;
  }

  _sendToSpectators(room, obj) {
    if (!room.spectators || !room.spectators.size) return;
    for (const sws of [...room.spectators]) {
      try { sws.send(JSON.stringify(obj)); }
      catch { room.spectators.delete(sws); }
    }
  }

  _broadcastState(room) {
    room.seats.forEach((s, i) => {
      if (s.kind === 'human' && s.connected && s.ws) send(s.ws, this._stateFor(room, i));
    });
    this._sendToSpectators(room, this._publicStateFor(room));
    this._syncBusyFor(room);
  }
  _broadcastEvent(room, obj) {
    room.seats.forEach((s) => {
      if (s.kind === 'human' && s.connected && s.ws) send(s.ws, obj);
    });
    // Public table events (takan, declared 13, preset chat, voice
    // flags) are part of what a spectator watches — hands never
    // ride events, so the fan-out is safe as-is.
    this._sendToSpectators(room, obj);
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
      this._syncClubGame(room); // clubs v8: the club game ended — the button badge clears
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
    // BOT NO-REPEAT LAW: keep the engine's bot-seat flags current — a
    // seat can convert to a bot mid-match (leave/disconnect takeover).
    round.botSeats = room.seats.map((s) => s.kind === 'bot');
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
   * a bot declares «13» ONLY for the forced final-trick REPEAT of a suit
   * it already takan'd this round (BOT NO-REPEAT LAW — see bots.js).
   * A human seat auto-played by the turn timer plays WITHOUT declaring
   * (spec: on timeout the takan stands).
   */
  _botPlay(room, seat, mayDeclare) {
    const round = room.match && room.match.round;
    if (!round || round.finished || round.turn !== seat) return;
    if (room.trickHold) return;
    if (mayDeclare && maybeDeclare13(round, seat)) {
      round.declare13(seat);        // emits declared13 → clients toast it…
      this._broadcastState(room);    // …the state shows the declaration…
      this._pumpTurn(room);          // …then the bot plays its card on the next tick
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
        s.voiceMic = false; // bots never talk and never listen
        s.voiceSpeaker = false;
      }
    });
    room.match = new G.Match(room.emit);
    room.match.botSeats = room.seats.map((s) => s.kind === 'bot');
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
    // Social identity for the lobby player menu: a signed-in
    // account WINS — the Worker verified the session cookie and
    // forwarded the user to this DO as the x-tore-user header (the
    // exact handoff /social uses), and fetch() stored it in this
    // socket's attachment. Otherwise the persistent player id the
    // client sent, exactly like the Node servers.
    if (att.user && att.user.sub) seat.sid = 'g:' + String(att.user.sub);
    else { const pid0 = cleanPid(prof && prof.pid); seat.sid = pid0 ? 'p:' + pid0 : null; }
    seat.token = randomHex(8);
    seat.ws = ws;
    seat.connected = true;
    seat.disconnectAt = null;
    att.code = room.code;
    att.seat = seatIdx;
    att.token = seat.token;
    this._saveAttachment(ws, att);
    // The caller sends the room reply AFTER persisting the room
    // (_sendRoomReply) — a code is never announced before it is
    // durable, so a shared code can never point at a memory-only room.
  }

  // The identity a join carries: the signed-in account ('g:<sub>',
  // from the Worker-verified attachment) wins; otherwise the
  // persistent player id the client sent ('p:<pid>') — the same two
  // identities the seats store as `sid` (see _attachPlayer).
  _joinSid(att, msg) {
    if (att.user && att.user.sub) return 'g:' + String(att.user.sub);
    const pid0 = cleanPid(msg && msg.pid);
    return pid0 ? 'p:' + pid0 : null;
  }

  // Reattach an EXISTING seat to a (possibly new) socket — the
  // 'reconnect' case's semantics, reached from 'join' when the
  // joiner's identity already holds a seat in the room (duplicate-
  // seat fix, 2026-11-09): the seat, its hand and its TOKEN are
  // kept; only the connection and the profile fields refresh.
  // Synchronous on purpose: the caller runs it in the same tick as
  // the identity check, so no second join can slip between them.
  _reattachSeat(ws, att, room, seatIdx, msg) {
    const seat = room.seats[seatIdx];
    if (seat.ws && seat.ws !== ws) { try { seat.ws.close(1012, 'replaced'); } catch { /* ignore */ } }
    if (msg && String(msg.name || '').trim()) seat.name = cleanName(msg.name);
    const av = cleanAvatar(msg.avatar); if (av) seat.avatar = av;
    const co = cleanCountry(msg.country); if (co) seat.country = co;
    if (att.user && att.user.sub) seat.sid = 'g:' + String(att.user.sub);
    else { const pid = cleanPid(msg.pid); if (pid) seat.sid = 'p:' + pid; }
    if (seat.avatar === 'google') {
      const ph = cleanPhoto(msg.photo); if (ph) seat.photo = ph;
    } else {
      seat.photo = null; // the photo belongs to the 'google' avatar only
    }
    seat.ws = ws;
    seat.connected = true;
    seat.disconnectAt = null;
    att.code = room.code;
    att.seat = seatIdx;
    att.token = seat.token;
    this._saveAttachment(ws, att);
  }

  _sendRoomReply(ws, room, seatIdx) {
    const seat = room.seats[seatIdx];
    send(ws, {
      type: 'room', code: room.code, seat: seatIdx, token: seat.token,
      isHost: seatIdx === this._hostSeat(room),
    });
  }

  async _handleMessage(ws, att, msg) {
    // Auth gate: with AUTH on, room actions need the signed-in user the
    // Worker verified from the session cookie (carried in the attachment).
    const needsAuth = msg.type === 'create' || msg.type === 'join' || msg.type === 'reconnect' || msg.type === 'spectate';
    if (this.authEnabled && needsAuth && !att.user) {
      return sendError(ws, 'اول با گوگل یا فیسبوک وارد شو', 'signInFirst');
    }
    // Clubs v8: a SPECTATOR attachment is receive-only. It may
    // leave; every other frame (play, chat, rtc, start, …) is
    // dropped here so a spectator can never act on the room.
    if (att.spectator) {
      if (msg.type === 'leave') {
        const room = this.rooms.get(att.code);
        if (room && room.spectators) room.spectators.delete(ws);
        att.spectator = false;
        att.code = null;
        this._saveAttachment(ws, att);
        try { ws.close(1000, 'spectator left'); } catch { /* ignore */ }
      }
      return;
    }
    switch (msg.type) {
      case 'create': {
        const room = this._createRoom();
        this._attachPlayer(ws, att, room, 0, displayName(msg, att.user), msg);
        // Clubs v8: a club stamp is granted ONLY by the social
        // core, which verifies the creator is a manager of that
        // club — a forged club id in the create frame earns
        // nothing. Set before the persist so the stamp is durable.
        if (msg.club) {
          const core = await this._ensureSocial();
          const cg = core.clubGameClub(room.seats[0].sid, msg.club);
          if (cg) room.club = cg;
        }
        await this._persistRoom(room); // durable before the code is announced
        this._sendRoomReply(ws, room, 0);
        this._broadcastState(room);
        this._syncClubGame(room);
        break;
      }
      case 'spectate': {
        // Clubs v8 — spectating is a CLUB feature: the room must
        // be a club game and the watcher a member of that club
        // (the core verifies from social state). Spectators hold
        // no seat, never count as busy, are capped per room, and
        // only ever receive the public state (_publicStateFor).
        const code = String(msg.code || '').toUpperCase().trim();
        let room = this.rooms.get(code);
        if (!room) room = await this._loadRoom(code); // read-repair from storage
        if (!room) return sendError(ws, 'اتاق پیدا نشد — کد را بررسی کن', 'roomNotFound');
        room = this.rooms.get(code) || room;
        const core = await this._ensureSocial();
        const sid = this._joinSid(att, msg);
        if (!room.club || !sid || !core.clubMembership(sid, room.club.cid)) {
          return sendError(ws, 'تماشای این بازی فقط برای اعضای کلب است', 'spectateDenied');
        }
        if (!room.spectators) room.spectators = new Set();
        if (!room.spectators.has(ws) && room.spectators.size >= SPECTATOR_CAP) {
          return sendError(ws, 'تعداد تماشاچیان پر است', 'spectatorFull');
        }
        room.spectators.add(ws);
        att.spectator = true;
        att.code = room.code;
        att.seat = -1;
        this._saveAttachment(ws, att);
        send(ws, { type: 'spectating', code: room.code });
        send(ws, this._publicStateFor(room));
        break;
      }
      case 'join': {
        const code = String(msg.code || '').toUpperCase().trim();
        let room = this.rooms.get(code);
        if (!room) room = await this._loadRoom(code); // read-repair from storage
        if (!room) return sendError(ws, 'اتاق پیدا نشد — کد را بررسی کن', 'roomNotFound');
        // Duplicate-seat fix (2026-11-09): one identity holds AT
        // MOST one seat per room. If this join's identity is already
        // seated here — any phase, lobby or mid-match — the join
        // REATTACHES to that seat instead of taking a new one,
        // however often it is repeated and from whichever socket it
        // arrives. (The client's join flow opens a fresh socket per
        // call, so every repeated tap / invite re-accept used to
        // mint another seat.) Everything from the canonical
        // re-resolve below to the seat mutation is SYNCHRONOUS, so
        // a concurrent join for the same identity cannot slip
        // between the check and the attach.
        room = this.rooms.get(code) || room;
        const sid = this._joinSid(att, msg);
        const mine = sid ? room.seats.findIndex((s) => s.kind === 'human' && s.sid === sid) : -1;
        if (mine !== -1) {
          this._reattachSeat(ws, att, room, mine, msg);
          await this._persistRoom(room);
          this._sendRoomReply(ws, room, mine);
          this._broadcastState(room);
          if (room.phase === 'playing') this._pumpTurn(room);
          break;
        }
        if (room.phase !== 'lobby') return sendError(ws, 'بازی این اتاق شروع شده است', 'gameStarted');
        const idx = room.seats.findIndex((s) => s.kind === 'empty');
        if (idx === -1) return sendError(ws, 'اتاق پر است', 'roomFull');
        this._attachPlayer(ws, att, room, idx, displayName(msg, att.user), msg);
        await this._persistRoom(room);
        this._sendRoomReply(ws, room, idx);
        this._broadcastState(room);
        break;
      }
      case 'reconnect': {
        const code = String(msg.code || '').toUpperCase().trim();
        let room = this.rooms.get(code);
        if (!room) room = await this._loadRoom(code); // read-repair from storage
        if (!room) return sendError(ws, 'نشست منقضی شده است — اتاق تازه بساز', 'sessionExpired');
        const idx = room.seats.findIndex((s) => s.kind === 'human' && s.token === msg.token);
        if (idx === -1) return sendError(ws, 'نشست منقضی شده است — اتاق تازه بساز', 'sessionExpired');
        const seat = room.seats[idx];
        if (seat.ws && seat.ws !== ws) { try { seat.ws.close(1012, 'replaced'); } catch { /* ignore */ } }
        // A reconnect may carry the player's current profile — refresh it.
        const av = cleanAvatar(msg.avatar); if (av) seat.avatar = av;
        const co = cleanCountry(msg.country); if (co) seat.country = co;
        if (att.user && att.user.sub) seat.sid = 'g:' + String(att.user.sub);
        else { const pid = cleanPid(msg.pid); if (pid) seat.sid = 'p:' + pid; }
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
        await this._persistRoom(room);
        this._sendRoomReply(ws, room, idx);
        this._broadcastState(room);
        // A read-repaired in-match room may have lost its turn timer
        // with the in-memory state — re-arm it (cancels any duplicate).
        if (room.phase === 'playing') this._pumpTurn(room);
        break;
      }
      case 'start': {
        const room = this.rooms.get(att.code);
        if (!room || room.phase !== 'lobby') return;
        if (att.seat !== this._hostSeat(room)) return sendError(ws, 'فقط میزبان می‌تواند بازی را شروع کند', 'hostOnly');
        this._startMatch(room);
        this._syncClubGame(room); // clubs v8: the club game is now in progress
        break;
      }
      case 'leave': {
        // Leaving the WAITING room (the match has not started): a
        // guest's seat is freed at once; the HOST leaving cancels the
        // room for everyone — the remaining players get a coded
        // roomClosed notice and their clients return to the main menu.
        // Leaving MID-MATCH (playing / roundEnd / matchEnd): the seat
        // is handed to a bot at once — the same conversion the
        // disconnect grace expiry performs (kind bot, profile cleared,
        // voice off, bot name) — and the match plays on for the others.
        const room = this.rooms.get(att.code);
        if (!room) return;
        const seat = room.seats[att.seat];
        if (!seat || seat.kind !== 'human') return;
        const leavingSid = seat.sid || null;
        const roomSids = room.seats.map((s) => s.sid).filter(Boolean);
        if (room.phase === 'lobby') {
          if (att.seat === this._hostSeat(room)) {
            room.seats.forEach((s, i) => {
              if (i !== att.seat && s.kind === 'human' && s.connected && s.ws) {
                send(s.ws, { type: 'roomClosed', code: 'roomCancelled' });
              }
            });
            this._sendToSpectators(room, { type: 'roomClosed', code: 'roomCancelled' });
            this._cancelTimers(room.code);
            this.rooms.delete(room.code);
            this._pendingDeletes.add(room.code);
            this._syncClubGame(room); // clubs v8: the club game dissolved — badge clears
            this._syncBusyFor(null, roomSids);
          } else {
            room.seats[att.seat] = emptySeat();
            this._broadcastState(room);
            if (leavingSid) this._syncBusyFor(null, [leavingSid]);
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
          this._broadcastState(room);
          if (leavingSid) this._syncBusyFor(null, [leavingSid]);
          this._pumpTurn(room);
        }
        att.code = null;
        att.seat = -1;
        att.token = null;
        this._saveAttachment(ws, att);
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
          sendError(ws, 'الآن نمی‌توانی «13» بگویی', 'cannotDeclare13');
          send(ws, this._stateFor(room, att.seat));
        }
        break;
      }
      case 'play': {
        const room = this.rooms.get(att.code);
        if (!room || room.phase !== 'playing') return;
        if (room.trickHold) { send(ws, this._stateFor(room, att.seat)); return; } // trick on display — resync silently, no error
        if (!this._doPlay(room, att.seat, String(msg.card || ''))) {
          // Illegal move: explain (Dari text + machine code) and resync.
          const round = room.match.round;
          let why = 'این ورق را نمی‌توانی بازی کنی', whyCode = 'cannotPlay', whyExtra = null;
          if (round && round.turn !== att.seat) { why = 'نوبت تو نیست'; whyCode = 'notYourTurn'; }
          else if (round && !round.hands[att.seat].includes(msg.card)) { why = 'این ورق در دستت نیست'; whyCode = 'cardNotInHand'; }
          else if (round) {
            const suit = round.ledSuit();
            why = 'باید از رنگِ ورقِ اول (' + G.SUIT_NAMES[suit] + ') بیایی';
            whyCode = 'mustFollowSuit'; whyExtra = { suit };
          }
          sendError(ws, why, whyCode, whyExtra);
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
        // Mic and speaker are independent flags; they ride together
        // in one message. A legacy client sends only `on` (= mic) —
        // its speaker flag is then left as-is.
        const mic = msg.mic !== undefined ? !!msg.mic : !!msg.on;
        const speaker = msg.speaker !== undefined ? !!msg.speaker : seat.voiceSpeaker !== false;
        if (seat.voiceMic === mic && (seat.voiceSpeaker !== false) === speaker) return;
        seat.voiceMic = mic;
        seat.voiceSpeaker = speaker;
        this._broadcastEvent(room, { type: 'voice', seat: att.seat, mic, speaker, on: mic });
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
