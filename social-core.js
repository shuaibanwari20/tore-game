/**
 * social-core.js — the Tore friends system: directory, friend
 * requests, mutual friendships, unfriend, block/unblock, friend DMs
 * and lobby invites. ONE implementation shared by every host:
 *   - Node (server.js / deploy/server.js) requires it directly and
 *     keeps the state in memory;
 *   - the Cloudflare Durable Object imports the ESM copy produced by
 *     cloudflare/scripts/sync-modules.mjs and persists the state to
 *     DO storage through the persist hook.
 *
 * The core is environment-pure: no sockets, no storage, no clock of
 * its own beyond Date.now(). The host supplies three hooks:
 *   sendTo(id, obj)          deliver one protocol message to a player
 *   persist()                the social state changed; save it
 *   inviteRoomCheck(id,code) may this player invite to that room?
 * and drives presence with socketOpened/socketClosed (the core owns
 * the online set so presence and the online flags can never disagree).
 *
 * Identity keys are opaque strings chosen by the host: "g:<sub>" for
 * a signed-in account, "p:<pid>" for a persistent client id. The
 * directory stores ONLY public profile fields (name / avatar /
 * photo / country) — never an email or any account secret.
 *
 * Every identity also owns a permanent public player ID (`uid`): a
 * random 6-digit number assigned by the core the first time the
 * identity says hello (legacy records get theirs on their next
 * hello), stored on the directory record so it survives restarts,
 * and NEVER changed afterwards — re-hellos, profile edits and new
 * devices on the same account all keep it. Players find each other
 * BY this ID: s-search takes an ID, never a name.
 *
 * Protocol (client -> server): s-hello, s-search, s-request,
 * s-respond, s-unfriend, s-block, s-unblock, s-dm, s-dm-history,
 * s-invite, s-invite-reply, and the club messages below.
 * Protocol (server -> client): s-init, s-friends, s-presence,
 * s-search-result, s-requested, s-dm, s-dm-history, s-invited,
 * s-invite-result, s-error (codes: socialBlocked, socialNotFriends,
 * socialDuplicate, socialRate, socialOffline, socialNotInRoom,
 * socialNotFound, socialInGame, socialBusy, socialCooldown).
 *
 * Clubs (کلبونه, 2026-11-09 — spec: CLUBS-PROMPT.md): one club per
 * player; a club has a permanent unique 6-digit ID, a name, an
 * emblem, an optional description, an owner and at most CLUB_CAP
 * members in three roles (owner > deputy > member). Joining is by
 * search (exact ID, or name substring) + request approved by the
 * owner/deputies, or by a direct invite from an owner/deputy to one
 * of their FRIENDS. Club chat is members-only free text (DM caps).
 * Club state serializes SEPARATELY (serializeClubs/loadClubs, hook
 * persistClubs) so the DO host stores it under its own key
 * (clubs:v1) beside social:v1. Clubmates may lobby-invite each
 * other without being friends — the invite path below accepts the
 * club relation and every busy/cooldown rule applies unchanged.
 * Protocol (client -> server): s-club-create, s-club-search,
 * s-club-request, s-club-cancel, s-club-respond, s-club-invite,
 * s-club-invite-reply, s-club-leave, s-club-kick, s-club-role,
 * s-club-transfer, s-club-edit, s-club-dissolve, s-club-chat.
 * Protocol (server -> client): s-club (full state), 
 * s-club-search-result, s-club-chat, s-club-invited, s-error
 * (codes: clubInClub, clubNotFound, clubFull, clubDuplicate,
 * clubNoPerm, clubOwner, clubSelf, clubBlocked).
 *
 * Clubs v2 (2026-11-09 — CLUBS-PROMPT.md v2, Ludo Star club UX):
 * the club record grows a COVER (id from a built-in gallery — the
 * client renders the artwork as inline SVG scenes; the core only
 * validates the id), a COUNTRY (the canonical profile-country
 * string, chosen at creation, editable by the owner), a CATEGORY
 * ('social' | 'game' | 'family'), LIKES (a set of player ids —
 * any signed-in player may like a club ONCE; the count feeds the
 * discovery ranking) and an ANNOUNCEMENT (free text set by
 * managers). A club's LEVEL is derived, never stored:
 * clubLevel(memberCount) = 1 + floor(count/10), capped at 5.
 * Discovery (s-club-discover {tab, country}): 'explore' lists
 * clubs newest-first, 'hot' sorts by members then likes, and both
 * carry a top-3 podium (members, ties broken by likes); the
 * country filter is an exact match on the stored country ('' =
 * global). 'mine' returns my club + the clubs I liked. The public
 * page reads s-club-view {club} (summary + member preview).
 * The club room is also a VOICE room: 8 mic seats per club,
 * tracked in the core as RUNTIME-ONLY state (never persisted) —
 * s-club-voice {action:'join'|'leave'} enters/leaves the room,
 * s-club-seat {seat} sits (members only; a taken seat rejects
 * clubSeatTaken), s-club-stand stands; the state fans out as
 * s-club-voice-state {club, members, seats}. Seat occupancy dies
 * with the page: leaving the voice room, the club, or the last
 * socket closing frees the seat. WebRTC signaling between two
 * members of the same club who are BOTH in the voice room rides
 * s-rtc {to, data} -> s-rtc {from, data}, relayed here like the
 * game server relays room signaling; media is peer-to-peer and
 * never touches a host.
 * Protocol additions (client -> server): s-club-discover,
 * s-club-view, s-club-like, s-club-announce, s-club-voice,
 * s-club-seat, s-club-stand, s-rtc.
 * Protocol additions (server -> client): s-club-discover-result,
 * s-club-view-result, s-club-liked, s-club-voice-state, s-rtc,
 * s-error (new code clubSeatTaken).
 *
 * Invite rules (2026-11-08, extended 2026-11-09): a target holding
 * ANY seat cannot be invited — a started match (host hook
 * inGameCheck) rejects socialInGame, a waiting lobby seat (host
 * hook inLobbyCheck) rejects socialBusy. person() ships both flags
 * (ingame / inlobby) in every list so clients can disable the
 * button live, and syncBusy() pushes a fresh s-friends to the
 * player's friends the moment either flag flips. A successful
 * invite also starts a per-(sender,target) cooldown
 * (INVITE_COOLDOWN_MS, overridable via hooks.inviteCooldownMs for
 * tests); a repeat inside the window is rejected socialCooldown.
 * On top of that, a DELIVERED invite stays pending for
 * INVITE_PENDING_MS (the popup's on-screen life): while it is
 * pending, another invite from the SAME sender to the same target
 * is dropped with socialCooldown — the target never sees a second
 * popup. The target's s-invite-reply resolves the one popup on
 * their screen, so it clears EVERY pending invite to that target
 * (the slot is per-target, not per-pair); the pending window
 * lapsing clears it too. Cooldowns, pendings and the known busy
 * map are runtime-only — never persisted.
 *
 * Stale-busy verification (2026-11-09): the busy hooks answer from
 * the host's seat table, and a seat can outlive its player — lobby
 * seats never expire on disconnect (they stay reserved for a
 * reconnect), so a player who closed the app without leaving kept
 * a dead seat and was reported "busy" forever. On every invite the
 * core asks the host's verifyBusy hook to re-check the claim
 * against live room state: the host reaps a seat whose player is
 * demonstrably gone, pushes the corrected presence, and answers
 * with the verified state ('match' | 'lobby' | ''). A genuinely
 * seated player verifies unchanged, so the rejections above are
 * identical for them.
 */
'use strict';

const DM_KEEP = 50;          // messages kept per pair
const DM_RATE_MAX = 10;      // messages per sender per pair …
const DM_RATE_WINDOW = 60000; // … per this window (ms)
const DM_MAX_CHARS = 500;
const INVITE_COOLDOWN_MS = 10000; // per sender→target pair, after a sent invite
const INVITE_PENDING_MS = 30000;  // a delivered invite's popup life on the target's screen
const CLUB_CAP = 50;              // members per club (Clash/PUBG standard)
const CLUB_NAME_MAX = 24;
const CLUB_DESC_MAX = 120;
const CLUB_CHAT_KEEP = 50;        // messages kept per club
const CLUB_EMBLEMS = ['trophy', 'shield', 'star', 'crown', 'gem', 'crescent', 'flame', 'laurel'];
// Clubs v2: the built-in cover gallery (ids only — the client
// resolves each id to its static photo file /covers/<id>.jpg),
// the join categories, the announcement cap and the club room's
// mic seats. A club may instead carry cover 'custom': the owner
// uploaded a photo through the host's HTTP endpoint; the image
// bytes live in HOST storage (never in this state) under the club
// id, and coverV (bumped on every upload) busts its cache.
const CLUB_COVERS = ['mountains', 'mosque', 'caravan', 'pomegranate', 'city', 'carpet', 'eagle', 'river', 'tent', 'trophy'];
const CLUB_COVER_CUSTOM = 'custom';
const CLUB_CATEGORIES = ['social', 'game', 'family'];
const CLUB_ANN_MAX = 200;
const CLUB_SEATS = 8;
// Seat requests (owner order 2026-11-09): a member who wants a
// mic seat asks the club OWNER, who approves or rejects. One
// pending request per member per club; a request lives at most
// this long and dies with the club page on either side.
const CLUB_SEAT_REQ_MS = 60000;
// Club LEVEL is derived from the member count, never stored:
// Lv1 = 1–9, Lv2 = 10–19, Lv3 = 20–29, Lv4 = 30–39, Lv5 = 40–50.
function clubLevel(count) {
  const n = Math.max(1, Math.floor(Number(count) || 0));
  return Math.min(5, 1 + Math.floor(n / 10));
}

// ---- profile field hygiene (mirrors the game servers' rules) ------
function cleanName(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/\s+/g, ' ').trim().slice(0, 20);
}
function cleanAvatar(v) {
  if (v === 'google') return 'google';
  return (typeof v === 'string' && /^av([1-9]|1[0-2])$/.test(v)) ? v : null;
}
function cleanPhoto(p) {
  if (typeof p !== 'string' || !p || p.length > 300) return '';
  if (!p.startsWith('https://')) return '';
  if (!p.includes('googleusercontent.com')) return '';
  return p;
}
function cleanCountry(v) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, 40);
}
function pairKey(a, b) { return a < b ? a + '\n' + b : b + '\n' + a; }
function reqKey(from, to) { return from + '\n' + to; }

class SocialCore {
  constructor(hooks) {
    this.hooks = hooks || {};
    this.directory = new Map(); // id -> {id,name,avatar,photo,country,uid,lastSeen}
    this.friends = new Map();   // id -> Set<id> (always mutual)
    this.blocked = new Map();   // id -> Set<id> (one direction: I blocked them)
    this.requests = new Map();  // reqKey -> {from,to,ts}
    this.dm = new Map();        // pairKey -> [{from,text,ts}] (oldest first)
    this.dmLog = new Map();     // pairKey+'\n'+from -> [ts,...] (rate window)
    this.online = new Map();    // id -> live socket count
    this.inviteLog = new Map(); // reqKey(from,to) -> ts of last SENT invite (runtime only)
    this.pendingInvites = new Map(); // reqKey(from,to) -> ts a delivered invite awaits its reply (runtime only)
    this.busyKnown = new Map(); // id -> last seat state ('match'|'lobby'|'') pushed to friends (runtime only)
    this.clubs = new Map();       // cid -> {cid,name,emblem,desc,owner,created,members:[{id,role,ts}]}
    this.clubOf = new Map();      // playerId -> cid (rebuilt on load; derived from clubs)
    this.clubRequests = new Map();// reqKey(cid,playerId) -> {club,from,ts} join requests
    this.clubInvites = new Map(); // reqKey(cid,playerId) -> {club,from,to,ts} club invites
    this.clubChat = new Map();    // cid -> [{from,text,ts}] (oldest first)
    this.clubChatLog = new Map(); // cid+'\n'+from -> [ts,...] (rate window, runtime only)
    // Clubs v2 voice room — RUNTIME ONLY, never persisted: mic
    // seats die with the page, so a restart starts every club
    // room empty (the seat map is rebuilt by joins, not loads).
    this.clubSeats = new Map();   // cid -> Map(seatIdx -> playerId)
    this.clubVoice = new Map();   // cid -> Set<playerId> (in the voice room)
    // Seat requests — RUNTIME ONLY like the seats: reqKey(cid,
    // playerId) -> {club, from, seat, ts}. Never persisted; a
    // restart simply drops pending asks (they time out anyway).
    this.clubSeatReqs = new Map();
    this.seatReqMs = (hooks && typeof hooks.seatReqTimeoutMs === 'number' && hooks.seatReqTimeoutMs > 0)
      ? hooks.seatReqTimeoutMs : CLUB_SEAT_REQ_MS;
  }

  // ---------- persistence (DO host; Node ignores) ----------
  serialize() {
    const sets = (m) => { const o = {}; for (const [k, v] of m) o[k] = [...v]; return o; };
    return {
      directory: [...this.directory.values()],
      friends: sets(this.friends),
      blocked: sets(this.blocked),
      requests: [...this.requests.values()],
      dm: Object.fromEntries(this.dm),
    };
  }
  load(data) {
    if (!data || typeof data !== 'object') return;
    const sets = (o) => new Map(Object.entries(o || {}).map(([k, v]) => [k, new Set(Array.isArray(v) ? v : [])]));
    this.directory = new Map((Array.isArray(data.directory) ? data.directory : []).map((r) => [r.id, r]));
    this.friends = sets(data.friends);
    this.blocked = sets(data.blocked);
    this.requests = new Map((Array.isArray(data.requests) ? data.requests : []).map((r) => [reqKey(r.from, r.to), r]));
    this.dm = new Map(Object.entries(data.dm || {}));
  }
  _persist() { if (this.hooks.persist) { try { this.hooks.persist(this.serialize()); } catch (e) { /* host logs */ } } }
  // Clubs persist through their OWN hook so the DO host can store
  // them under a separate key (clubs:v1) beside social:v1.
  serializeClubs() {
    return {
      clubs: [...this.clubs.values()],
      requests: [...this.clubRequests.values()],
      invites: [...this.clubInvites.values()],
      chat: Object.fromEntries(this.clubChat),
    };
  }
  loadClubs(data) {
    if (!data || typeof data !== 'object') return;
    this.clubs = new Map((Array.isArray(data.clubs) ? data.clubs : []).map((c) => [c.cid, c]));
    // Clubs v2 field migration: records written by the v1 build
    // lack cover/country/category/likes/announcement — fill the
    // defaults in place so every reader can trust the shape.
    for (const c of this.clubs.values()) {
      if (!c || typeof c !== 'object') continue;
      if (c.cover !== CLUB_COVER_CUSTOM && !CLUB_COVERS.includes(c.cover)) c.cover = 'mountains';
      if (typeof c.coverV !== 'number' || !(c.coverV >= 0)) c.coverV = 0;
      if (typeof c.country !== 'string') c.country = '';
      if (!CLUB_CATEGORIES.includes(c.category)) c.category = 'social';
      if (!Array.isArray(c.likes)) c.likes = [];
      if (typeof c.announcement !== 'string') c.announcement = '';
      if (typeof c.desc !== 'string') c.desc = '';
      if (!Array.isArray(c.members)) c.members = [];
    }
    this.clubRequests = new Map((Array.isArray(data.requests) ? data.requests : []).map((r) => [reqKey(r.club, r.from), r]));
    this.clubInvites = new Map((Array.isArray(data.invites) ? data.invites : []).map((r) => [reqKey(r.club, r.to), r]));
    this.clubChat = new Map(Object.entries(data.chat || {}));
    this.clubOf = new Map();
    for (const c of this.clubs.values()) for (const m of (c.members || [])) this.clubOf.set(m.id, c.cid);
  }
  _persistClubs() { if (this.hooks.persistClubs) { try { this.hooks.persistClubs(this.serializeClubs()); } catch (e) { /* host logs */ } } }
  _send(id, obj) { if (this.hooks.sendTo) this.hooks.sendTo(id, obj); }
  _error(id, code) { this._send(id, { type: 's-error', code }); }

  // ---------- presence ----------
  isOnline(id) { return (this.online.get(id) || 0) > 0; }
  rebuildOnline(ids) { // after a DO wake: re-seed counts from live sockets
    this.online = new Map();
    for (const id of ids) this.online.set(id, (this.online.get(id) || 0) + 1);
  }
  socketOpened(id) {
    const was = this.isOnline(id);
    this.online.set(id, (this.online.get(id) || 0) + 1);
    if (!was) this._fanPresence(id, true);
  }
  socketClosed(id) {
    const n = (this.online.get(id) || 0) - 1;
    if (n > 0) { this.online.set(id, n); return; }
    this.online.delete(id);
    const rec = this.directory.get(id);
    if (rec) { rec.lastSeen = Date.now(); this._persist(); }
    this._fanPresence(id, false);
    // Club voice: the seat dies with the page — a fully-offline
    // player leaves the voice room and frees his mic seat.
    this._clubVoiceGone(id);
  }
  _fanPresence(id, online) {
    const msg = { type: 's-presence', id, online, ingame: this.isInGame(id), inlobby: this.isInLobby(id) };
    const set = this.friends.get(id);
    if (set) for (const f of set) if (this.isOnline(f)) this._send(f, msg);
    // Clubmates watch the same presence (their member rows render
    // from person() data too) — the club page must flip live like
    // the friends page does.
    const club = this.clubOf.has(id) ? this.clubs.get(this.clubOf.get(id)) : null;
    if (club) for (const m of club.members) {
      if (m.id !== id && this.isOnline(m.id) && !(set && set.has(m.id))) this._send(m.id, msg);
    }
  }

  // ---------- seat (busy) flags ----------
  // The host knows the live rooms; the core only asks its hooks.
  // Without a hook nobody is ever in a game or a lobby. A player
  // holding ANY seat is "busy" for invites: 'match' (a started
  // match) outranks 'lobby' (a waiting room) when both could apply.
  isInGame(id) {
    if (this.hooks.inGameCheck) {
      try { return !!this.hooks.inGameCheck(id); } catch (e) { return false; }
    }
    return false;
  }
  isInLobby(id) {
    if (this.hooks.inLobbyCheck) {
      try { return !!this.hooks.inLobbyCheck(id); } catch (e) { return false; }
    }
    return false;
  }
  busyState(id) {
    if (this.isInGame(id)) return 'match';
    if (this.isInLobby(id)) return 'lobby';
    return '';
  }
  // Hosts call this for every identity whose room membership may
  // have changed (state broadcasts, seat conversions, room closes,
  // room creates/joins/leaves). On a flip, every online friend gets
  // a fresh s-friends so their already-open friends list repaints
  // the invite button at once — no screen reopen, no polling.
  syncBusy(id) {
    if (typeof id !== 'string' || !id) return;
    const now = this.busyState(id);
    const prev = this.busyKnown.get(id) || '';
    this.busyKnown.set(id, now);
    if (now === prev) return;
    const set = this.friends.get(id);
    if (set) for (const f of set) this.refresh(f);
    // The flipped player's own lists carry friends' flags, not
    // their own — but a refresh is harmless and keeps any second
    // device of theirs in step.
    this.refresh(id);
    // Club member rows carry the same busy flags: a flip repaints
    // the whole club page of every member (cheap: only on a flip).
    if (this.clubOf.has(id)) this.fanClub(this.clubOf.get(id));
  }

  // ---------- views ----------
  uidOf(id) {
    const r = this.directory.get(id);
    return r && r.uid ? String(r.uid) : null;
  }
  person(id) {
    const r = this.directory.get(id);
    if (!r) return { id, name: '', avatar: 'av1', photo: '', country: '', uid: null, online: this.isOnline(id), ingame: this.isInGame(id), inlobby: this.isInLobby(id) };
    return { id: r.id, name: r.name, avatar: r.avatar, photo: r.photo, country: r.country, uid: r.uid ? String(r.uid) : null, online: this.isOnline(id), ingame: this.isInGame(id), inlobby: this.isInLobby(id) };
  }
  listsFor(id) {
    const byName = (a, b) => a.name.localeCompare(b.name);
    const friends = [...(this.friends.get(id) || [])].map((f) => this.person(f))
      .sort((a, b) => (b.online - a.online) || byName(a, b));
    const incoming = [], outgoing = [];
    for (const r of this.requests.values()) {
      if (r.to === id) incoming.push(this.person(r.from));
      else if (r.from === id) outgoing.push(this.person(r.to));
    }
    incoming.sort(byName); outgoing.sort(byName);
    const blocked = [...(this.blocked.get(id) || [])].map((b) => this.person(b)).sort(byName);
    return { friends, incoming, outgoing, blocked };
  }
  refresh(id) { if (this.isOnline(id)) this._send(id, { type: 's-friends', ...this.listsFor(id) }); }
  refreshBoth(a, b) { this.refresh(a); if (b !== a) this.refresh(b); }

  // ---------- relations ----------
  areFriends(a, b) { const s = this.friends.get(a); return !!s && s.has(b); }
  blockedEither(a, b) {
    const x = this.blocked.get(a), y = this.blocked.get(b);
    return !!((x && x.has(b)) || (y && y.has(a)));
  }
  _linkFriends(a, b) {
    if (!this.friends.has(a)) this.friends.set(a, new Set());
    if (!this.friends.has(b)) this.friends.set(b, new Set());
    this.friends.get(a).add(b); this.friends.get(b).add(a);
  }
  _unlinkFriends(a, b) {
    const x = this.friends.get(a), y = this.friends.get(b);
    if (x) x.delete(b); if (y) y.delete(a);
  }

  // ---------- hello / directory ----------
  _newUid() {
    // A random 6-digit ID, retried until it is unique across the
    // whole directory. The scan-then-check race cannot split across
    // hosts: there is exactly one core instance per host process.
    const taken = new Set();
    for (const r of this.directory.values()) if (r.uid) taken.add(String(r.uid));
    for (let i = 0; i < 100; i++) {
      const uid = String(100000 + Math.floor(Math.random() * 900000));
      if (!taken.has(uid)) return uid;
    }
    for (let n = 100000; n <= 999999; n++) if (!taken.has(String(n))) return String(n);
    return null; // directory impossibly full — caller keeps uid null
  }
  hello(id, profile) {
    profile = profile || {};
    const photo = cleanPhoto(profile.photo);
    let avatar = cleanAvatar(profile.avatar);
    if (avatar === 'google' && !photo) avatar = null;
    const prev = this.directory.get(id);
    // The permanent player ID: kept from the existing record when
    // there is one; assigned exactly once otherwise (this is also
    // the migration path for records created before IDs existed).
    const uid = (prev && prev.uid) ? String(prev.uid) : this._newUid();
    this.directory.set(id, {
      id,
      name: cleanName(profile.name) || (prev && prev.name) || 'بازیکن',
      avatar: avatar || (prev && prev.avatar) || 'av1',
      photo,
      country: cleanCountry(profile.country) || (prev && prev.country) || '',
      uid,
      lastSeen: Date.now(),
    });
    this._persist();
    this._send(id, { type: 's-init', me: id, uid: uid || null, ...this.listsFor(id) });
    this.refreshClub(id, true); // the clubs state rides right behind the init
  }

  // ---------- message entry ----------
  handleMessage(id, msg) {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 's-search': return this.search(id, msg.q);
      case 's-request': return this.request(id, msg.to);
      case 's-respond': return this.respond(id, msg.from, msg.accept);
      case 's-unfriend': return this.unfriend(id, msg.id);
      case 's-block': return this.block(id, msg.id);
      case 's-unblock': return this.unblock(id, msg.id);
      case 's-dm': return this.dmSend(id, msg.to, msg.text);
      case 's-dm-history': return this.dmHistory(id, msg.with);
      case 's-invite': return this.invite(id, msg.to, msg.code);
      case 's-invite-reply': return this.inviteReply(id, msg.from, msg.code, msg.accept);
      case 's-club-create': return this.clubCreate(id, msg);
      case 's-club-search': return this.clubSearch(id, msg.q);
      case 's-club-request': return this.clubRequest(id, msg.club);
      case 's-club-cancel': return this.clubCancel(id, msg.club);
      case 's-club-respond': return this.clubRespond(id, msg.from, msg.accept);
      case 's-club-invite': return this.clubInvite(id, msg.to);
      case 's-club-invite-reply': return this.clubInviteReply(id, msg.club, msg.accept);
      case 's-club-leave': return this.clubLeave(id);
      case 's-club-kick': return this.clubKick(id, msg.id);
      case 's-club-role': return this.clubRole(id, msg.id, msg.role);
      case 's-club-transfer': return this.clubTransfer(id, msg.id);
      case 's-club-edit': return this.clubEdit(id, msg);
      case 's-club-dissolve': return this.clubDissolve(id);
      case 's-club-chat': return this.clubChatSend(id, msg.text);
      case 's-club-discover': return this.clubDiscover(id, msg.tab, msg.country);
      case 's-club-view': return this.clubViewPublic(id, msg.club);
      case 's-club-like': return this.clubLike(id, msg.club);
      case 's-club-announce': return this.clubAnnounce(id, msg.text);
      case 's-club-voice': return this.clubVoiceSet(id, msg.action);
      case 's-club-seat': return this.clubSeatSit(id, msg.seat);
      case 's-club-seat-request': return this.clubSeatRequest(id, msg.seat);
      case 's-club-seat-request-cancel': return this.clubSeatRequestCancel(id);
      case 's-club-seat-respond': return this.clubSeatRespond(id, msg.from, msg.accept === true);
      case 's-club-stand': return this.clubStand(id);
      case 's-rtc': return this.rtcRelay(id, msg);
      default: break; // unknown social messages are ignored
    }
  }

  search(id, q) {
    // Search is BY PLAYER ID ONLY (owner order 2026-11-08): names
    // are not unique and not searchable. The query is normalized to
    // digits and matched EXACTLY against the permanent uids — at
    // most one player can ever come back.
    const digits = (typeof q === 'string' ? q : '').replace(/\D/g, '').slice(0, 12);
    if (!digits) { this._send(id, { type: 's-search-result', q: digits, results: [] }); return; }
    let hit = null;
    for (const r of this.directory.values()) {
      if (r.id === id) continue;
      if (r.uid && String(r.uid) === digits) { hit = r; break; }
    }
    const out = [];
    if (hit && !this.blockedEither(id, hit.id)) { // blocked relations never surface
      let relation = 'none';
      if (this.areFriends(id, hit.id)) relation = 'friend';
      else if (this.requests.has(reqKey(id, hit.id))) relation = 'outgoing';
      else if (this.requests.has(reqKey(hit.id, id))) relation = 'incoming';
      out.push({ ...this.person(hit.id), relation });
    }
    this._send(id, { type: 's-search-result', q: digits, results: out });
  }

  request(id, to) {
    if (typeof to !== 'string' || to === id || !this.directory.has(to)) return this._error(id, 'socialNotFound');
    if (this.blockedEither(id, to)) return this._error(id, 'socialBlocked');
    if (this.areFriends(id, to)) return this._error(id, 'socialDuplicate');
    if (this.requests.has(reqKey(id, to))) return this._error(id, 'socialDuplicate');
    // They already asked me: a counter-request is an accept.
    if (this.requests.has(reqKey(to, id))) {
      this.requests.delete(reqKey(to, id));
      this._linkFriends(id, to);
      this._persist();
      this.refreshBoth(id, to);
      return;
    }
    this.requests.set(reqKey(id, to), { from: id, to, ts: Date.now() });
    this._persist();
    this.refresh(id); // my outgoing list grows
    if (this.isOnline(to)) {
      this._send(to, { type: 's-requested', from: this.person(id) });
      this.refresh(to); // their incoming list grows
    }
  }

  respond(id, from, accept) {
    if (typeof from !== 'string' || !this.requests.has(reqKey(from, id))) return;
    this.requests.delete(reqKey(from, id));
    if (accept) this._linkFriends(id, from);
    this._persist();
    this.refreshBoth(id, from); // accept: both lists gain a friend; decline: sender's outgoing clears
  }

  unfriend(id, other) {
    if (typeof other !== 'string' || !this.areFriends(id, other)) return;
    this._unlinkFriends(id, other);
    this._persist();
    this.refreshBoth(id, other);
  }

  block(id, other) {
    if (typeof other !== 'string' || other === id || !this.directory.has(other)) return;
    this._unlinkFriends(id, other);
    this.requests.delete(reqKey(id, other));
    this.requests.delete(reqKey(other, id));
    this.pendingInvites.delete(reqKey(id, other));
    this.pendingInvites.delete(reqKey(other, id));
    if (!this.blocked.has(id)) this.blocked.set(id, new Set());
    this.blocked.get(id).add(other);
    this._persist();
    this.refreshBoth(id, other); // the blocked side just sees the friendship/requests vanish
  }

  unblock(id, other) {
    const set = this.blocked.get(id);
    if (!set || typeof other !== 'string' || !set.has(other)) return;
    set.delete(other); // friendship is NOT restored — a fresh request is needed
    this._persist();
    this.refresh(id);
  }

  dmSend(id, to, text) {
    if (typeof to !== 'string' || to === id) return;
    if (this.blockedEither(id, to)) return this._error(id, 'socialBlocked');
    if (!this.areFriends(id, to)) return this._error(id, 'socialNotFriends');
    text = (typeof text === 'string' ? text : '').slice(0, DM_MAX_CHARS);
    if (!text.trim()) return;
    const pk = pairKey(id, to);
    const logKey = pk + '\n' + id;
    const now = Date.now();
    const log = (this.dmLog.get(logKey) || []).filter((t) => now - t < DM_RATE_WINDOW);
    if (log.length >= DM_RATE_MAX) { this.dmLog.set(logKey, log); return this._error(id, 'socialRate'); }
    log.push(now); this.dmLog.set(logKey, log);
    const entry = { from: id, text, ts: now };
    const thread = this.dm.get(pk) || [];
    thread.push(entry);
    while (thread.length > DM_KEEP) thread.shift();
    this.dm.set(pk, thread);
    this._persist();
    const out = { type: 's-dm', from: id, to, text, ts: now };
    this._send(to, out);   // the friend, live
    this._send(id, out);   // sender echo (other devices + this client's render path)
  }

  dmHistory(id, withId) {
    if (typeof withId !== 'string' || !this.areFriends(id, withId)) {
      this._send(id, { type: 's-dm-history', with: withId || '', messages: [] });
      if (typeof withId === 'string' && this.directory.has(withId)) this._error(id, 'socialNotFriends');
      return;
    }
    const thread = (this.dm.get(pairKey(id, withId)) || []).slice();
    this._send(id, { type: 's-dm-history', with: withId, messages: thread });
  }

  invite(id, to, code) {
    code = (typeof code === 'string' ? code : '').toUpperCase().trim().slice(0, 8);
    if (typeof to !== 'string' || to === id || !code) return;
    if (this.blockedEither(id, to)) return this._error(id, 'socialBlocked');
    // Friends may always be invited; CLUBMATES may too — club
    // membership is the relation there (owner order 2026-11-09).
    // Every rule below (room, busy, pending, cooldown) is identical.
    if (!this.areFriends(id, to) && !this.sameClub(id, to)) return this._error(id, 'socialNotFriends');
    if (!this.isOnline(to)) return this._error(id, 'socialOffline');
    // The room rule comes before the busy rules: "you are not in
    // the room you are inviting to" is the more fundamental
    // rejection (a non-seated sender learns nothing about the
    // target's state). A properly seated sender still reaches the
    // busy checks below.
    const ok = this.hooks.inviteRoomCheck ? !!this.hooks.inviteRoomCheck(id, code) : false;
    if (!ok) return this._error(id, 'socialNotInRoom');
    // A player holding ANY seat cannot be invited — the server
    // decides (the client's disabled button is cosmetic). A started
    // match reports socialInGame; a seat in a waiting lobby reports
    // socialBusy (owner order 2026-11-09: lobby-sitters too). The
    // claim is verified live first (see the header note): the host
    // re-checks its room table, reaps any seat whose player is
    // demonstrably gone, and answers with the verified state — a
    // stale seat must never strand its owner as busy. Hosts
    // without the hook fall back to the plain flag hooks.
    let busy = null;
    if (this.hooks.verifyBusy) {
      try {
        const v = this.hooks.verifyBusy(to);
        if (v === 'match' || v === 'lobby' || v === '') busy = v;
      } catch (e) { /* fall through to the flag hooks */ }
    }
    if (busy === null) busy = this.isInGame(to) ? 'match' : (this.isInLobby(to) ? 'lobby' : '');
    if (busy === 'match') return this._error(id, 'socialInGame');
    if (busy === 'lobby') return this._error(id, 'socialBusy');
    const now = Date.now();
    const key = reqKey(id, to);
    // ONE popup per pair: while my earlier invite to this target is
    // still pending (delivered, awaiting its reply, inside the
    // popup's on-screen life), a repeat is dropped as a cooldown —
    // the target never sees a second popup. This window outlives
    // the send cooldown below, so it is checked first.
    const pendTs = this.pendingInvites.get(key) || 0;
    if (pendTs && now - pendTs < INVITE_PENDING_MS) return this._error(id, 'socialCooldown');
    // Per-pair cooldown: one invite per sender→target per window.
    // Only a SENT invite starts the window; rejections never do.
    const cdMs = (typeof this.hooks.inviteCooldownMs === 'number' && this.hooks.inviteCooldownMs >= 0)
      ? this.hooks.inviteCooldownMs : INVITE_COOLDOWN_MS;
    const last = this.inviteLog.get(key) || 0;
    if (cdMs > 0 && last && now - last < cdMs) return this._error(id, 'socialCooldown');
    this.inviteLog.set(key, now);
    this.pendingInvites.set(key, now);
    // Prune stale entries opportunistically so the maps stay small.
    if (this.inviteLog.size > 200) {
      for (const [k, t] of this.inviteLog) if (now - t >= cdMs) this.inviteLog.delete(k);
    }
    if (this.pendingInvites.size > 200) {
      for (const [k, t] of this.pendingInvites) if (now - t >= INVITE_PENDING_MS) this.pendingInvites.delete(k);
    }
    this._send(to, { type: 's-invited', from: this.person(id), code });
  }

  inviteReply(id, from, code, accept) {
    if (typeof from !== 'string' || from === id) return;
    // The reply resolves the ONE popup on my screen, whichever
    // sender it came from — so it frees the popup slot entirely:
    // every pending invite TO me is spent (including ones my
    // client never displayed because a popup was already up), and
    // any sender may invite me afresh from now on.
    for (const k of [...this.pendingInvites.keys()]) {
      if (k.endsWith('\n' + id)) this.pendingInvites.delete(k);
    }
    if (!this.areFriends(id, from) && !this.sameClub(id, from)) return; // stale popup / no relation: drop silently
    code = (typeof code === 'string' ? code : '').toUpperCase().trim().slice(0, 8);
    this._send(from, { type: 's-invite-result', by: this.person(id), code, accept: !!accept });
  }

  // ================= clubs (کلبونه) =================
  // One club per player. Roles: 'owner' > 'deputy' > 'member'.
  // Managers = owner + deputies. All rules are enforced here, in
  // the one shared core; clients only paint what s-club pushes.
  sameClub(a, b) {
    const c = this.clubOf.get(a);
    return !!c && c === this.clubOf.get(b);
  }
  _clubOf(id) {
    const cid = this.clubOf.get(id);
    return cid ? (this.clubs.get(cid) || null) : null;
  }
  _clubRole(club, id) {
    if (!club) return null;
    const m = club.members.find((x) => x.id === id);
    return m ? m.role : null;
  }
  _clubManager(club, id) {
    const r = this._clubRole(club, id);
    return r === 'owner' || r === 'deputy';
  }
  _cleanClubName(v) {
    if (typeof v !== 'string') return '';
    return v.replace(/\s+/g, ' ').trim().slice(0, CLUB_NAME_MAX);
  }
  _cleanClubDesc(v) {
    if (typeof v !== 'string') return '';
    return v.replace(/\s+/g, ' ').trim().slice(0, CLUB_DESC_MAX);
  }
  _cleanEmblem(v) {
    return (typeof v === 'string' && CLUB_EMBLEMS.includes(v)) ? v : 'trophy';
  }
  // Clubs v2 field cleaners: the core validates ids/enums and
  // stores plain strings; all artwork and display names live in
  // the client (gallery covers are static photo files there). The
  // 'custom' cover is never accepted over the socket — only the
  // host's authenticated upload endpoint sets it (setCustomCover).
  _cleanCover(v) {
    return (typeof v === 'string' && CLUB_COVERS.includes(v)) ? v : 'mountains';
  }
  _cleanCategory(v) {
    return (typeof v === 'string' && CLUB_CATEGORIES.includes(v)) ? v : 'social';
  }
  _cleanClubCountry(v) {
    return cleanCountry(typeof v === 'string' ? v : '');
  }
  _cleanAnnouncement(v) {
    if (typeof v !== 'string') return '';
    return v.replace(/\s+/g, ' ').trim().slice(0, CLUB_ANN_MAX);
  }
  _newClubId() {
    for (let i = 0; i < 100; i++) {
      const cid = String(100000 + Math.floor(Math.random() * 900000));
      if (!this.clubs.has(cid)) return cid;
    }
    for (let n = 100000; n <= 999999; n++) if (!this.clubs.has(String(n))) return String(n);
    return null;
  }
  clubSummary(club, forId) {
    const owner = this.directory.get(club.owner);
    let relation = 'none';
    if (forId) {
      if (this.clubOf.get(forId) === club.cid) relation = 'member';
      else if (this.clubOf.has(forId)) relation = 'other';
      else if (this.clubRequests.has(reqKey(club.cid, forId))) relation = 'requested';
      else if (this.clubInvites.has(reqKey(club.cid, forId))) relation = 'invited';
    }
    return {
      cid: club.cid, name: club.name, emblem: club.emblem, desc: club.desc,
      cover: club.cover === CLUB_COVER_CUSTOM ? CLUB_COVER_CUSTOM
        : (CLUB_COVERS.includes(club.cover) ? club.cover : 'mountains'),
      coverV: (typeof club.coverV === 'number' && club.coverV > 0) ? club.coverV : 0,
      country: typeof club.country === 'string' ? club.country : '',
      category: CLUB_CATEGORIES.includes(club.category) ? club.category : 'social',
      level: clubLevel(club.members.length),
      likes: Array.isArray(club.likes) ? club.likes.length : 0,
      liked: forId ? (Array.isArray(club.likes) && club.likes.includes(forId)) : false,
      announcement: typeof club.announcement === 'string' ? club.announcement : '',
      owner: club.owner, ownerName: owner ? owner.name : '',
      count: club.members.length, created: club.created, relation,
    };
  }
  // The club room's live voice shape (runtime only): who is in
  // the voice room and which mic seats are taken, with the seat
  // holders' person records so a fresh page paints at once.
  _clubSeatsView(cid) {
    const seats = this.clubSeats.get(cid);
    if (!seats) return [];
    return [...seats.entries()].map(([seat, pid]) => ({ seat, person: this.person(pid) }))
      .sort((a, b) => a.seat - b.seat);
  }
  _clubVoiceIds(cid) {
    const room = this.clubVoice.get(cid);
    return room ? [...room] : [];
  }
  clubView(forId, withChat) {
    const club = this._clubOf(forId);
    if (!club) return null;
    const rank = { owner: 0, deputy: 1, member: 2 };
    const members = club.members.map((m) => ({ ...this.person(m.id), role: m.role }))
      .sort((a, b) => (rank[a.role] - rank[b.role]) || (b.online - a.online) || a.name.localeCompare(b.name));
    const view = {
      ...this.clubSummary(club, forId),
      myRole: this._clubRole(club, forId),
      members,
      seats: this._clubSeatsView(club.cid),
      voice: this._clubVoiceIds(club.cid),
      requests: this._clubManager(club, forId)
        ? [...this.clubRequests.values()].filter((r) => r.club === club.cid).map((r) => this.person(r.from))
        : [],
    };
    if (withChat) {
      view.chat = (this.clubChat.get(club.cid) || []).map((m) => {
        const p = this.person(m.from);
        return { from: m.from, name: p.name, avatar: p.avatar, photo: p.photo, text: m.text, ts: m.ts };
      });
    }
    return view;
  }
  clubPayload(id, withChat) {
    const invites = [], outgoing = [];
    for (const inv of this.clubInvites.values()) {
      if (inv.to !== id) continue;
      const club = this.clubs.get(inv.club);
      if (club) invites.push({ club: this.clubSummary(club, id), from: this.person(inv.from) });
    }
    for (const r of this.clubRequests.values()) {
      if (r.from !== id) continue;
      const club = this.clubs.get(r.club);
      if (club) outgoing.push(this.clubSummary(club, id));
    }
    return { club: this.clubView(id, withChat), invites, outgoing };
  }
  refreshClub(id, withChat) {
    if (this.isOnline(id)) this._send(id, { type: 's-club', ...this.clubPayload(id, withChat) });
  }
  fanClub(cid, withChat) {
    const club = this.clubs.get(cid);
    if (!club) return;
    for (const m of club.members) this.refreshClub(m.id, withChat);
  }
  // Joining by ANY path: membership lands, and the joiner's other
  // pending business (outgoing requests elsewhere, invites) is
  // cleared — one club per player leaves nothing dangling. The
  // affected clubs' managers get a refresh so their request lists
  // drop the name at once.
  _joinClub(id, club) {
    const touched = new Set();
    for (const [k, r] of [...this.clubRequests]) {
      if (r.from === id) { this.clubRequests.delete(k); if (r.club !== club.cid) touched.add(r.club); }
    }
    for (const [k, inv] of [...this.clubInvites]) {
      if (inv.to === id) this.clubInvites.delete(k);
    }
    club.members.push({ id, role: 'member', ts: Date.now() });
    this.clubOf.set(id, club.cid);
    this._persistClubs();
    for (const cid of touched) this.fanClub(cid);
    this.fanClub(club.cid);
    this.refreshClub(id, true);
  }
  _removeMember(club, id) {
    club.members = club.members.filter((m) => m.id !== id);
    if (this.clubOf.get(id) === club.cid) this.clubOf.delete(id);
  }

  clubCreate(id, msg) {
    if (this.clubOf.has(id)) return this._error(id, 'clubInClub');
    const name = this._cleanClubName(msg && msg.name);
    if (name.length < 2) return this._error(id, 'clubBadName');
    const cid = this._newClubId();
    if (!cid) return this._error(id, 'clubFull');
    const club = {
      cid, name,
      emblem: this._cleanEmblem(msg && msg.emblem),
      desc: this._cleanClubDesc(msg && msg.desc),
      // Clubs v2: cover/country/category/likes/announcement. The
      // country defaults to the CREATOR's profile country (his
      // directory record) when the client does not name one.
      cover: this._cleanCover(msg && msg.cover),
      coverV: 0,
      country: (msg && typeof msg.country === 'string' && msg.country.trim())
        ? this._cleanClubCountry(msg.country)
        : ((this.directory.get(id) || {}).country || ''),
      category: this._cleanCategory(msg && msg.category),
      likes: [],
      announcement: '',
      owner: id, created: Date.now(),
      members: [{ id, role: 'owner', ts: Date.now() }],
    };
    this.clubs.set(cid, club);
    this.clubOf.set(id, cid);
    this.clubChat.set(cid, []);
    // Creating a club spends any pending requests/invites of mine.
    for (const [k, r] of [...this.clubRequests]) if (r.from === id) this.clubRequests.delete(k);
    for (const [k, inv] of [...this.clubInvites]) if (inv.to === id) this.clubInvites.delete(k);
    this._persistClubs();
    this.refreshClub(id, true);
  }

  clubSearch(id, q) {
    const raw = (typeof q === 'string' ? q : '').trim().slice(0, 40);
    const out = [];
    if (raw) {
      if (/^\d+$/.test(raw)) {
        const club = this.clubs.get(raw.slice(0, 6));
        if (club && !this.blockedEither(id, club.owner)) out.push(this.clubSummary(club, id));
      } else {
        const needle = raw.toLowerCase();
        const hits = [...this.clubs.values()]
          .filter((c) => c.name.toLowerCase().includes(needle) && !this.blockedEither(id, c.owner));
        hits.sort((a, b) => (b.members.length - a.members.length) || a.name.localeCompare(b.name));
        for (const c of hits.slice(0, 20)) out.push(this.clubSummary(c, id));
      }
    }
    this._send(id, { type: 's-club-search-result', q: raw, results: out });
  }

  clubRequest(id, cid) {
    cid = (typeof cid === 'string' ? cid : '').replace(/\D/g, '').slice(0, 6);
    const club = this.clubs.get(cid);
    if (!club) return this._error(id, 'clubNotFound');
    if (this.clubOf.get(id) === cid) return this._error(id, 'clubDuplicate');
    if (this.clubOf.has(id)) return this._error(id, 'clubInClub');
    if (this.blockedEither(id, club.owner)) return this._error(id, 'clubBlocked');
    if (this.clubRequests.has(reqKey(cid, id))) return this._error(id, 'clubDuplicate');
    // I hold an invite from this very club: asking IS accepting
    // (the friends counter-request rule).
    if (this.clubInvites.has(reqKey(cid, id))) {
      if (club.members.length >= CLUB_CAP) return this._error(id, 'clubFull');
      this._joinClub(id, club);
      return;
    }
    if (club.members.length >= CLUB_CAP) return this._error(id, 'clubFull');
    this.clubRequests.set(reqKey(cid, id), { club: cid, from: id, ts: Date.now() });
    this._persistClubs();
    this.refreshClub(id);
    this.fanClub(cid); // managers see the new request
  }

  clubCancel(id, cid) {
    cid = (typeof cid === 'string' ? cid : '').replace(/\D/g, '').slice(0, 6);
    if (!this.clubRequests.delete(reqKey(cid, id))) return;
    this._persistClubs();
    this.refreshClub(id);
    this.fanClub(cid);
  }

  clubRespond(id, from, accept) {
    const club = this._clubOf(id);
    if (!club || !this._clubManager(club, id)) return;
    if (typeof from !== 'string' || !this.clubRequests.has(reqKey(club.cid, from))) return;
    if (accept) {
      if (this.clubOf.has(from)) { // they joined elsewhere meanwhile
        this.clubRequests.delete(reqKey(club.cid, from));
        this._persistClubs();
        this.fanClub(club.cid);
        this.refreshClub(from);
        return;
      }
      if (club.members.length >= CLUB_CAP) return this._error(id, 'clubFull');
      this.clubRequests.delete(reqKey(club.cid, from));
      this._joinClub(from, club);
      return;
    }
    this.clubRequests.delete(reqKey(club.cid, from));
    this._persistClubs();
    this.fanClub(club.cid);
    this.refreshClub(from); // their outgoing list drops the club
  }

  clubInvite(id, to) {
    const club = this._clubOf(id);
    if (!club || !this._clubManager(club, id)) return this._error(id, 'clubNoPerm');
    if (typeof to !== 'string' || to === id || !this.directory.has(to)) return this._error(id, 'clubNotFound');
    if (this.blockedEither(id, to)) return this._error(id, 'socialBlocked');
    if (!this.areFriends(id, to)) return this._error(id, 'socialNotFriends');
    if (this.clubOf.get(to) === club.cid) return this._error(id, 'clubDuplicate');
    if (this.clubOf.has(to)) return this._error(id, 'clubInClub');
    if (this.clubInvites.has(reqKey(club.cid, to))) return this._error(id, 'clubDuplicate');
    if (club.members.length >= CLUB_CAP) return this._error(id, 'clubFull');
    // They already ASKED to join my club: my invite is the approval.
    if (this.clubRequests.has(reqKey(club.cid, to))) {
      this.clubRequests.delete(reqKey(club.cid, to));
      this._joinClub(to, club);
      return;
    }
    this.clubInvites.set(reqKey(club.cid, to), { club: club.cid, from: id, to, ts: Date.now() });
    this._persistClubs();
    this.refreshClub(id);
    this.refreshClub(to);
    if (this.isOnline(to)) this._send(to, { type: 's-club-invited', club: this.clubSummary(club, to), from: this.person(id) });
  }

  clubInviteReply(id, cid, accept) {
    cid = (typeof cid === 'string' ? cid : '').replace(/\D/g, '').slice(0, 6);
    const key = reqKey(cid, id);
    if (!this.clubInvites.has(key)) return;
    const club = this.clubs.get(cid);
    this.clubInvites.delete(key);
    if (!accept || !club) {
      this._persistClubs();
      this.refreshClub(id);
      return;
    }
    if (this.clubOf.has(id)) { this._persistClubs(); this.refreshClub(id); return this._error(id, 'clubInClub'); }
    if (club.members.length >= CLUB_CAP) { this._persistClubs(); this.refreshClub(id); return this._error(id, 'clubFull'); }
    this._joinClub(id, club);
  }

  clubLeave(id) {
    const club = this._clubOf(id);
    if (!club) return;
    if (this._clubRole(club, id) === 'owner') return this._error(id, 'clubOwner');
    this._clubVoiceGone(id); // my mic seat + voice-room place die with the membership
    this._removeMember(club, id);
    this._persistClubs();
    this.refreshClub(id, true);
    this.fanClub(club.cid);
  }

  clubKick(id, other) {
    const club = this._clubOf(id);
    if (!club) return;
    if (typeof other !== 'string' || other === id) return this._error(id, 'clubSelf');
    const myRole = this._clubRole(club, id);
    const theirRole = this._clubRole(club, other);
    if (!theirRole) return;
    // Rank-bounded (Clash rule): the owner kicks anyone below; a
    // deputy kicks members only; a member kicks nobody.
    const ok = myRole === 'owner' ? theirRole !== 'owner'
      : myRole === 'deputy' ? theirRole === 'member' : false;
    if (!ok) return this._error(id, 'clubNoPerm');
    this._clubVoiceGone(other); // a kicked member's seat frees at once
    this._removeMember(club, other);
    this._persistClubs();
    this.refreshClub(other, true);
    this.fanClub(club.cid);
  }

  clubRole(id, other, role) {
    const club = this._clubOf(id);
    if (!club) return;
    if (this._clubRole(club, id) !== 'owner') return this._error(id, 'clubNoPerm');
    if (typeof other !== 'string' || other === id) return this._error(id, 'clubSelf');
    if (role !== 'deputy' && role !== 'member') return;
    const m = club.members.find((x) => x.id === other);
    if (!m || m.role === 'owner' || m.role === role) return;
    m.role = role;
    this._persistClubs();
    this.fanClub(club.cid);
  }

  clubTransfer(id, other) {
    const club = this._clubOf(id);
    if (!club) return;
    if (this._clubRole(club, id) !== 'owner') return this._error(id, 'clubNoPerm');
    if (typeof other !== 'string' || other === id) return this._error(id, 'clubSelf');
    const target = club.members.find((x) => x.id === other);
    // Ownership passes to a DEPUTY (spec); the old owner steps
    // down to deputy, never straight out.
    if (!target || target.role !== 'deputy') return this._error(id, 'clubNoPerm');
    const me = club.members.find((x) => x.id === id);
    target.role = 'owner';
    me.role = 'deputy';
    club.owner = other;
    this._persistClubs();
    this.fanClub(club.cid);
  }

  clubEdit(id, msg) {
    const club = this._clubOf(id);
    if (!club) return;
    if (this._clubRole(club, id) !== 'owner') return this._error(id, 'clubNoPerm');
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.name === 'string') {
      const name = this._cleanClubName(msg.name);
      if (name.length >= 2) club.name = name;
    }
    if (typeof msg.emblem === 'string') club.emblem = this._cleanEmblem(msg.emblem);
    if (typeof msg.desc === 'string') club.desc = this._cleanClubDesc(msg.desc);
    if (typeof msg.cover === 'string') {
      const wasCustom = club.cover === CLUB_COVER_CUSTOM;
      // A form that still shows the custom cover (the settings
      // page sends it back untouched) keeps it; picking any
      // gallery cover replaces it — and the uploaded blob is
      // deleted with the switch, so it stops costing host storage.
      club.cover = (msg.cover === CLUB_COVER_CUSTOM && wasCustom)
        ? CLUB_COVER_CUSTOM : this._cleanCover(msg.cover);
      if (wasCustom && club.cover !== CLUB_COVER_CUSTOM) this._deleteCoverBlob(club.cid);
    }
    if (typeof msg.country === 'string') club.country = this._cleanClubCountry(msg.country);
    if (typeof msg.category === 'string') club.category = this._cleanCategory(msg.category);
    this._persistClubs();
    this.fanClub(club.cid);
  }

  // The club this identity OWNS (role 'owner'), or null. The
  // hosts' cover-upload endpoints gate on exactly this.
  ownedClub(id) {
    const club = this._clubOf(id);
    return (club && this._clubRole(club, id) === 'owner') ? club : null;
  }
  // Host entry point AFTER it has stored an uploaded cover image
  // for the owner's club: the record flips to the custom marker
  // and the version bumps (the client reads /club-cover/<cid>?v=N,
  // so the bump is what makes the new photo show). Returns
  // {cid, v} or null when the identity owns no club.
  setCustomCover(id) {
    const club = this.ownedClub(id);
    if (!club) return null;
    club.cover = CLUB_COVER_CUSTOM;
    club.coverV = (typeof club.coverV === 'number' && club.coverV > 0 ? club.coverV : 0) + 1;
    this._persistClubs();
    this.fanClub(club.cid);
    return { cid: club.cid, v: club.coverV };
  }
  // The uploaded bytes live in host storage; the host's hook
  // removes them. Fired when a custom cover stops being the
  // club's cover (gallery switch, dissolve) — never on replace,
  // where the host simply overwrites the same key.
  _deleteCoverBlob(cid) {
    if (this.hooks.coverBlobDelete) { try { this.hooks.coverBlobDelete(cid); } catch (e) { /* host logs */ } }
  }

  clubDissolve(id) {
    const club = this._clubOf(id);
    if (!club) return;
    if (this._clubRole(club, id) !== 'owner') return this._error(id, 'clubNoPerm');
    const memberIds = club.members.map((m) => m.id);
    const hadCustomCover = club.cover === CLUB_COVER_CUSTOM;
    // Pending seat requests die with the club.
    for (const [, r] of [...this.clubSeatReqs]) if (r.club === club.cid) this._clearSeatReq(r, 'gone');
    // The voice room dies with the club: clear the runtime maps,
    // then push one empty voice-state so every member's client
    // tears its peer connections down.
    this.clubSeats.delete(club.cid);
    this.clubVoice.delete(club.cid);
    for (const mid of memberIds) if (this.clubOf.get(mid) === club.cid) this.clubOf.delete(mid);
    for (const [k, r] of [...this.clubRequests]) if (r.club === club.cid) this.clubRequests.delete(k);
    for (const [k, inv] of [...this.clubInvites]) if (inv.club === club.cid) this.clubInvites.delete(k);
    this.clubChat.delete(club.cid);
    this.clubs.delete(club.cid);
    // A dissolved club's uploaded cover dies with it (owner
    // order: it must not keep wasting host storage).
    if (hadCustomCover) this._deleteCoverBlob(club.cid);
    this._persistClubs();
    for (const mid of memberIds) {
      if (this.isOnline(mid)) this._send(mid, { type: 's-club-voice-state', club: club.cid, members: [], seats: [] });
      this.refreshClub(mid, true);
    }
  }

  clubChatSend(id, text) {
    const club = this._clubOf(id);
    if (!club) return this._error(id, 'clubNoPerm');
    text = (typeof text === 'string' ? text : '').slice(0, DM_MAX_CHARS);
    if (!text.trim()) return;
    const logKey = club.cid + '\n' + id;
    const now = Date.now();
    const log = (this.clubChatLog.get(logKey) || []).filter((t) => now - t < DM_RATE_WINDOW);
    if (log.length >= DM_RATE_MAX) { this.clubChatLog.set(logKey, log); return this._error(id, 'socialRate'); }
    log.push(now); this.clubChatLog.set(logKey, log);
    const entry = { from: id, text, ts: now };
    const thread = this.clubChat.get(club.cid) || [];
    thread.push(entry);
    while (thread.length > CLUB_CHAT_KEEP) thread.shift();
    this.clubChat.set(club.cid, thread);
    this._persistClubs();
    const p = this.person(id);
    const out = { type: 's-club-chat', club: club.cid, from: id, name: p.name, avatar: p.avatar, photo: p.photo, text, ts: now };
    for (const m of club.members) if (this.isOnline(m.id)) this._send(m.id, out);
  }

  // ================= clubs v2: discovery / likes / voice =================
  // The Ludo-style discovery page, the public club page, likes,
  // the announcement and the club voice room. Discovery ordering
  // is a pure function of the club records: explore = newest
  // first, hot = members then likes, and the podium (top 3) ranks
  // by members with likes breaking the tie.
  _clubHotSort(a, b) {
    return (b.members.length - a.members.length)
      || ((b.likes || []).length - (a.likes || []).length)
      || (a.created - b.created);
  }
  clubDiscover(id, tab, country) {
    tab = (tab === 'hot' || tab === 'mine') ? tab : 'explore';
    country = this._cleanClubCountry(country);
    if (tab === 'mine') {
      const mine = this._clubOf(id);
      const liked = [...this.clubs.values()]
        .filter((c) => (c.likes || []).includes(id) && (!mine || c.cid !== mine.cid))
        .sort((a, b) => this._clubHotSort(a, b))
        .map((c) => this.clubSummary(c, id));
      this._send(id, {
        type: 's-club-discover-result', tab, country: '',
        top: [], results: [],
        mine: mine ? this.clubSummary(mine, id) : null, liked,
      });
      return;
    }
    let pool = [...this.clubs.values()].filter((c) => !this.blockedEither(id, c.owner));
    if (country) pool = pool.filter((c) => (c.country || '') === country);
    const top = [...pool].sort((a, b) => this._clubHotSort(a, b)).slice(0, 3)
      .map((c) => this.clubSummary(c, id));
    const sorted = tab === 'hot'
      ? [...pool].sort((a, b) => this._clubHotSort(a, b))
      : [...pool].sort((a, b) => (b.created - a.created) || (b.members.length - a.members.length));
    this._send(id, {
      type: 's-club-discover-result', tab, country,
      top, results: sorted.slice(0, 40).map((c) => this.clubSummary(c, id)),
      mine: null, liked: [],
    });
  }

  // The public page of someone else's club: the summary (which
  // carries cover/country/category/level/likes/announcement) plus
  // a member preview. Blocked relations never surface, exactly
  // like search.
  clubViewPublic(id, cid) {
    cid = (typeof cid === 'string' ? cid : '').replace(/\D/g, '').slice(0, 6);
    const club = this.clubs.get(cid);
    if (!club || this.blockedEither(id, club.owner)) return this._error(id, 'clubNotFound');
    const rank = { owner: 0, deputy: 1, member: 2 };
    const members = club.members.map((m) => ({ ...this.person(m.id), role: m.role }))
      .sort((a, b) => (rank[a.role] - rank[b.role]) || (b.online - a.online) || a.name.localeCompare(b.name))
      .slice(0, 20);
    this._send(id, { type: 's-club-view-result', club: { ...this.clubSummary(club, id), members } });
  }

  // A like is ONE per player, ever (re-liking is a no-op that
  // just re-ships the summary) — the count can never double-count.
  clubLike(id, cid) {
    cid = (typeof cid === 'string' ? cid : '').replace(/\D/g, '').slice(0, 6);
    const club = this.clubs.get(cid);
    if (!club || this.blockedEither(id, club.owner)) return this._error(id, 'clubNotFound');
    if (!Array.isArray(club.likes)) club.likes = [];
    if (!club.likes.includes(id)) {
      club.likes.push(id);
      this._persistClubs();
      this.fanClub(cid); // members' room headers show the new count
    }
    this._send(id, { type: 's-club-liked', club: this.clubSummary(club, id) });
  }

  // The announcement (اعلان) is the managers' pinned line on the
  // club room + public page. Empty text clears it.
  clubAnnounce(id, text) {
    const club = this._clubOf(id);
    if (!club || !this._clubManager(club, id)) return this._error(id, 'clubNoPerm');
    club.announcement = this._cleanAnnouncement(text);
    this._persistClubs();
    this.fanClub(club.cid);
  }

  // ---------- club voice room (runtime only) ----------
  // Membership in the voice room means "this member is on the
  // club page": they hear the seat holders. Sitting in a mic seat
  // is the transmit side. All occupancy is volatile — it is kept
  // OUT of serializeClubs on purpose.
  _fanClubVoice(cid) {
    const club = this.clubs.get(cid);
    if (!club) return;
    const seats = [...(this.clubSeats.get(cid) || new Map()).entries()]
      .map(([seat, pid]) => ({ seat, id: pid })).sort((a, b) => a.seat - b.seat);
    const msg = { type: 's-club-voice-state', club: cid, members: this._clubVoiceIds(cid), seats };
    for (const m of club.members) if (this.isOnline(m.id)) this._send(m.id, msg);
  }
  // Frees id's seat + voice-room place in their club and fans the
  // change. Called on voice-leave, club leave/kick and when the
  // last social socket closes.
  _clubVoiceGone(id) {
    const cid = this.clubOf.get(id);
    if (!cid) return;
    // Seat requests die with the club page: my own pending ask if
    // I'm a requester — ALL of my club's asks if I'm its owner
    // (there is nobody left to approve them).
    const reqClub = this.clubs.get(cid);
    if (reqClub && reqClub.owner === id) {
      for (const [, r] of [...this.clubSeatReqs]) if (r.club === cid) this._clearSeatReq(r, 'gone');
    } else {
      const mine = this.clubSeatReqs.get(reqKey(cid, id));
      if (mine) this._clearSeatReq(mine, 'gone');
    }
    let changed = false;
    const seats = this.clubSeats.get(cid);
    if (seats) {
      for (const [s, who] of [...seats]) if (who === id) { seats.delete(s); changed = true; }
      if (!seats.size) this.clubSeats.delete(cid);
    }
    const room = this.clubVoice.get(cid);
    if (room && room.delete(id)) { changed = true; if (!room.size) this.clubVoice.delete(cid); }
    if (changed) this._fanClubVoice(cid);
  }
  clubVoiceSet(id, action) {
    const club = this._clubOf(id);
    if (action === 'leave') { this._clubVoiceGone(id); return; }
    if (action !== 'join') return;
    if (!club) return this._error(id, 'clubNoPerm');
    if (!this.clubVoice.has(club.cid)) this.clubVoice.set(club.cid, new Set());
    const room = this.clubVoice.get(club.cid);
    if (!room.has(id)) { room.add(id); this._fanClubVoice(club.cid); }
    else this._fanClubVoice(club.cid); // a re-join re-syncs the joiner
    // An owner (re)entering the room is re-shown his club's live
    // seat requests — they pend quietly while he is away and are
    // never promised to anyone in the meantime.
    if (club.owner === id) {
      this._pruneSeatReqs();
      for (const r of this.clubSeatReqs.values()) {
        if (r.club === club.cid) this._send(id, { type: 's-club-seat-req', club: club.cid, from: this.person(r.from), seat: r.seat });
      }
    }
  }
  clubSeatSit(id, seat, viaApproval) {
    const club = this._clubOf(id);
    if (!club) return this._error(id, 'clubNoPerm');
    // Sitting is approval-gated (owner order 2026-11-09): the
    // OWNER sits directly; everyone else's seat comes from an
    // approved seat request (clubSeatRespond calls this with
    // viaApproval). A bare s-club-seat from a member is refused.
    if (!viaApproval && this._clubRole(club, id) !== 'owner') return this._error(id, 'clubSeatReqNeeded');
    seat = Number(seat);
    if (!Number.isInteger(seat) || seat < 0 || seat >= CLUB_SEATS) return;
    if (!this.clubSeats.has(club.cid)) this.clubSeats.set(club.cid, new Map());
    const seats = this.clubSeats.get(club.cid);
    const occ = seats.get(seat);
    if (occ && occ !== id) return this._error(id, 'clubSeatTaken');
    for (const [s, who] of [...seats]) if (who === id) seats.delete(s); // moving seats frees the old one
    seats.set(seat, id);
    // Sitting implies being in the voice room (you cannot talk
    // from outside the page).
    if (!this.clubVoice.has(club.cid)) this.clubVoice.set(club.cid, new Set());
    this.clubVoice.get(club.cid).add(id);
    this._fanClubVoice(club.cid);
  }
  clubStand(id) {
    const cid = this.clubOf.get(id);
    if (!cid) return;
    const seats = this.clubSeats.get(cid);
    if (!seats) return;
    let changed = false;
    for (const [s, who] of [...seats]) if (who === id) { seats.delete(s); changed = true; }
    if (!seats.size) this.clubSeats.delete(cid);
    if (changed) this._fanClubVoice(cid);
  }
  // ---------- seat requests (owner-approved sitting) ----------
  // A member asks the club OWNER for a mic seat; the owner
  // approves (the member is seated — requested seat, else first
  // free) or rejects. One pending request per member per club;
  // requests are runtime-only and die on answer, on either side
  // leaving the club page (voice-leave / socket close run through
  // _clubVoiceGone), on club dissolve, and on timeout (pruned
  // lazily at every seat/voice entry point; both sides are told).
  _clearSeatReq(req, reason) {
    if (!this.clubSeatReqs.delete(reqKey(req.club, req.from))) return;
    this._send(req.from, { type: 's-club-seat-req-state', club: req.club, pending: false, reason });
    const club = this.clubs.get(req.club);
    if (club && club.owner !== req.from && this.isOnline(club.owner)) {
      this._send(club.owner, { type: 's-club-seat-req-gone', club: req.club, from: req.from });
    }
  }
  _pruneSeatReqs() {
    const now = Date.now();
    for (const [, r] of [...this.clubSeatReqs]) {
      if (now - r.ts >= this.seatReqMs) this._clearSeatReq(r, 'timeout');
    }
  }
  clubSeatRequest(id, seat) {
    this._pruneSeatReqs();
    const club = this._clubOf(id);
    if (!club) return this._error(id, 'clubNoPerm');
    // The owner never requests — he sits (his tap IS the sit).
    if (this._clubRole(club, id) === 'owner') { this.clubSeatSit(id, seat); return; }
    seat = Number(seat);
    if (!Number.isInteger(seat) || seat < 0 || seat >= CLUB_SEATS) return;
    const seats = this.clubSeats.get(club.cid);
    if (seats && [...seats.values()].includes(id)) return; // already seated
    const key = reqKey(club.cid, id);
    const existing = this.clubSeatReqs.get(key);
    if (existing) {
      // One pending per member: a second ask COALESCES — my own
      // state is re-shipped, the owner is never prompted twice.
      this._send(id, { type: 's-club-seat-req-state', club: club.cid, pending: true, seat: existing.seat });
      return;
    }
    const req = { club: club.cid, from: id, seat, ts: Date.now() };
    this.clubSeatReqs.set(key, req);
    if (this.isOnline(club.owner)) {
      this._send(club.owner, { type: 's-club-seat-req', club: club.cid, from: this.person(id), seat });
    }
    this._send(id, { type: 's-club-seat-req-state', club: club.cid, pending: true, seat });
  }
  clubSeatRequestCancel(id) {
    const cid = this.clubOf.get(id);
    if (!cid) return;
    const req = this.clubSeatReqs.get(reqKey(cid, id));
    if (req) this._clearSeatReq(req, 'cancelled');
  }
  clubSeatRespond(id, from, accept) {
    this._pruneSeatReqs();
    const club = this._clubOf(id);
    if (!club || club.owner !== id) return; // only the founder answers
    if (typeof from !== 'string') return;
    const req = this.clubSeatReqs.get(reqKey(club.cid, from));
    if (!req) return;
    if (!accept) { this._clearSeatReq(req, 'rejected'); return; }
    if (!this.clubSeats.has(club.cid)) this.clubSeats.set(club.cid, new Map());
    const seats = this.clubSeats.get(club.cid);
    let chosen = -1;
    if (!seats.has(req.seat)) chosen = req.seat;
    else for (let s = 0; s < CLUB_SEATS; s++) if (!seats.has(s)) { chosen = s; break; }
    if (chosen < 0) {
      this._error(id, 'clubSeatsFull');
      this._clearSeatReq(req, 'full');
      return;
    }
    this.clubSeatReqs.delete(reqKey(club.cid, from));
    this._send(id, { type: 's-club-seat-req-gone', club: club.cid, from });
    this._send(from, { type: 's-club-seat-req-state', club: club.cid, pending: false, reason: 'approved' });
    this.clubSeatSit(from, chosen, true);
  }
  // WebRTC signaling relay for the club voice room — the social
  // twin of the game server's room relay. The gate is club
  // MEMBERSHIP (persisted), never the runtime voice set: the DO
  // hibernates between messages and wakes with its seat/voice
  // maps empty while the members' screens still show their seats
  // — gating on the volatile set silently dropped every offer
  // and answer there (the «seated, mic on, silent» bug). A
  // successful relay also re-registers both ends in the voice
  // room, so the volatile state heals itself on first use.
  // Blocked pairs never signal. Media never passes through here.
  rtcRelay(id, msg) {
    const to = msg && msg.to;
    if (typeof to !== 'string' || to === id) return;
    const data = msg.data;
    if (!data || typeof data !== 'object') return;
    try { if (JSON.stringify(data).length > 32768) return; } catch (e) { return; }
    const cid = this.clubOf.get(id);
    if (!cid || this.clubOf.get(to) !== cid) return;
    if (this.blockedEither(id, to)) return;
    // Self-heal the volatile voice room (see the note above):
    // both ends are members talking voice — that IS the room.
    if (!this.clubVoice.has(cid)) this.clubVoice.set(cid, new Set());
    const room = this.clubVoice.get(cid);
    room.add(id);
    room.add(to);
    this._send(to, { type: 's-rtc', from: id, data });
  }
}

module.exports = { SocialCore, INVITE_COOLDOWN_MS, INVITE_PENDING_MS, CLUB_CAP, CLUB_EMBLEMS, CLUB_COVERS, CLUB_COVER_CUSTOM, CLUB_CATEGORIES, CLUB_SEATS, CLUB_SEAT_REQ_MS, clubLevel };
