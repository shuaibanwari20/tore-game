/**
 * test-clubmusic.mjs — up41 club music broadcast checks.
 *
 * Part A (in-process, the synced worker copy of social-core):
 *   - a NON-owner's broadcast attempt is refused (clubNoPerm)
 *     and stores nothing;
 *   - the owner's state fans out to the members IN the room with
 *     track / playing / position;
 *   - the anchor position ADVANCES with the wall clock while
 *     playing (a member who voice-joins late is synced to the
 *     live position) and FREEZES while paused;
 *   - owner pause fans out; the 'stop' action ends the broadcast
 *     for everyone; the owner LEAVING the room ends it too.
 * Part B (OPEN wrangler instance, default http://127.0.0.1:8787):
 *   the same essentials over real sockets.
 * Exit code non-zero on any failure.
 */
import { SocialCore } from '../src/social-core.js';
import { ToreClient } from './driver.mjs';

const OPEN = process.env.TORE_BASE || 'http://127.0.0.1:8787';
let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
}
const W = (base, path) => base.replace(/^http/, 'ws') + path;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= Part A: in-process core =================
{
  const sent = new Map();
  const core = new SocialCore({
    sendTo: (id, obj) => { if (!sent.has(id)) sent.set(id, []); sent.get(id).push(obj); },
    persist: () => {}, persistClubs: () => {},
  });
  const lastMusic = (id) => [...(sent.get(id) || [])].reverse().find((m) => m.type === 's-club-music-state') || null;
  const lastErr = (id) => [...(sent.get(id) || [])].reverse().find((m) => m.type === 's-error') || null;

  const OWN = 'p:cmOwn', MEM = 'p:cmMem', LATE = 'p:cmLate';
  for (const [id, name] of [[OWN, 'Cm Owner'], [MEM, 'Cm Member'], [LATE, 'Cm Late']]) {
    core.socketOpened(id);
    core.hello(id, { name, avatar: 'av1', country: 'افغانستان' });
  }
  core.clubCreate(OWN, { name: 'Music Club' });
  const cid = [...core.clubs.keys()][0];
  core.clubEnter(MEM, cid);
  core.clubEnter(LATE, cid);
  core.clubVoiceSet(OWN, 'join');
  core.clubVoiceSet(MEM, 'join');
  // LATE is a member but has NOT entered the room (no voice join).

  // ---- a non-owner cannot broadcast ----
  core.clubMusicSet(MEM, { action: 'state', track: 3, playing: true, pos: 10 });
  check('clubmusic: a member\u2019s broadcast attempt is refused (clubNoPerm)',
    !!lastErr(MEM) && lastErr(MEM).code === 'clubNoPerm', JSON.stringify(lastErr(MEM)));
  check('clubmusic: the refused attempt stored no broadcast state', core.clubMusic.size === 0);
  check('clubmusic: nobody received a state from the refused attempt', lastMusic(MEM) === null && lastMusic(OWN) === null);

  // ---- the owner broadcasts: state fans out ----
  core.clubMusicSet(OWN, { action: 'state', track: 7, playing: true, pos: 42 });
  const st1 = lastMusic(MEM);
  check('clubmusic: the member in the room receives the state',
    !!st1 && st1.on === true && st1.track === 7 && st1.playing === true, JSON.stringify(st1));
  check('clubmusic: the fanned position is the anchor (≈42)',
    !!st1 && st1.pos >= 42 && st1.pos <= 44, st1 && String(st1.pos));
  check('clubmusic: a member OUTSIDE the room receives nothing', lastMusic(LATE) === null);

  // ---- the anchor advances with the wall clock (late join) ----
  await sleep(1200);
  core.clubVoiceSet(LATE, 'join');
  const stLate = lastMusic(LATE);
  check('clubmusic: a late joiner is synced to the LIVE position',
    !!stLate && stLate.on === true && stLate.playing === true && stLate.pos >= 42.9 && stLate.pos <= 45.5,
    stLate && String(stLate.pos));

  // ---- pause freezes the anchor ----
  core.clubMusicSet(OWN, { action: 'state', track: 7, playing: false, pos: 50 });
  const st2 = lastMusic(MEM);
  check('clubmusic: owner pause fans out (playing:false, pos 50)',
    !!st2 && st2.playing === false && st2.pos === 50, JSON.stringify(st2));
  await sleep(700);
  const frozen = core._clubMusicPos(core.clubMusic.get(cid));
  check('clubmusic: the position stays frozen while paused', frozen === 50, String(frozen));

  // ---- up42: an owner's SEEK re-anchors the broadcast ----
  core.clubMusicSet(OWN, { action: 'state', track: 7, playing: true, pos: 300 });
  const stSeek = lastMusic(MEM);
  check('clubmusic: an owner seek (position jump) fans out as the new anchor',
    !!stSeek && stSeek.playing === true && stSeek.pos >= 300 && stSeek.pos <= 302, stSeek && String(stSeek.pos));
  await sleep(700);
  const adv = core._clubMusicPos(core.clubMusic.get(cid));
  check('clubmusic: after the seek, the anchor advances FROM the new spot',
    adv >= 300.5 && adv <= 302.5, String(adv));

  // ---- resume on another track, then stop ends it ----
  core.clubMusicSet(OWN, { action: 'state', track: 2, playing: true, pos: 5 });
  const st3 = lastMusic(MEM);
  check('clubmusic: a track change fans out', !!st3 && st3.track === 2 && st3.playing === true, JSON.stringify(st3));
  core.clubMusicSet(OWN, { action: 'stop' });
  const st4 = lastMusic(MEM);
  check('clubmusic: STOP ends the broadcast for the room', !!st4 && st4.on === false, JSON.stringify(st4));
  check('clubmusic: stop cleared the server state', core.clubMusic.has(cid) === false);

  // ---- the owner leaving the room ends it too ----
  core.clubMusicSet(OWN, { action: 'state', track: 1, playing: true, pos: 0 });
  check('clubmusic: broadcast live again before the leave', core.clubMusic.has(cid) === true);
  core.clubVoiceSet(OWN, 'leave');
  const st5 = lastMusic(MEM);
  check('clubmusic: the owner LEAVING the room ends the broadcast for everyone',
    !!st5 && st5.on === false && core.clubMusic.has(cid) === false, JSON.stringify(st5));
}

// ================= Part B: the OPEN DO instance =================
{
  const suf = String(Date.now()).slice(-6);
  const A = new ToreClient(W(OPEN, '/social'));
  const B = new ToreClient(W(OPEN, '/social'));
  const C = new ToreClient(W(OPEN, '/social'));
  await A.open(); await B.open(); await C.open();
  A.send({ type: 's-hello', pid: 'cmOwn' + suf, profile: { name: 'Cm Owner', avatar: 'av3', country: 'افغانستان' } });
  B.send({ type: 's-hello', pid: 'cmMem' + suf, profile: { name: 'Cm Member', avatar: 'av5', country: 'افغانستان' } });
  C.send({ type: 's-hello', pid: 'cmLate' + suf, profile: { name: 'Cm Late', avatar: 'av7', country: 'افغانستان' } });
  await A.waitFor((m) => m.type === 's-init', 10000, 'A s-init');
  await B.waitFor((m) => m.type === 's-init', 10000, 'B s-init');
  await C.waitFor((m) => m.type === 's-init', 10000, 'C s-init');
  A.send({ type: 's-club-create', name: 'Music DO Club' });
  const created = await A.waitFor((m) => m.type === 's-club' && m.club && m.club.myRole === 'owner', 10000, 'A club created');
  const cid = created.club.cid;
  B.send({ type: 's-club-enter', club: cid });
  await B.waitFor((m) => m.type === 's-club' && m.club && m.club.cid === cid, 10000, 'B entered');
  C.send({ type: 's-club-enter', club: cid });
  await C.waitFor((m) => m.type === 's-club' && m.club && m.club.cid === cid, 10000, 'C entered');
  A.send({ type: 's-club-voice', action: 'join' });
  B.send({ type: 's-club-voice', action: 'join' });
  await sleep(400);

  // non-owner over the wire
  B.messages.length = 0;
  B.send({ type: 's-club-music', action: 'state', track: 3, playing: true, pos: 10 });
  const errB = await B.waitFor((m) => m.type === 's-error' && m.code === 'clubNoPerm', 8000, 'B clubNoPerm').catch(() => null);
  check('clubmusic DO: a member\u2019s broadcast attempt is refused (clubNoPerm)', !!errB);

  // owner broadcasts
  B.messages.length = 0;
  A.send({ type: 's-club-music', action: 'state', track: 7, playing: true, pos: 42 });
  const stB = await B.waitFor((m) => m.type === 's-club-music-state' && m.on === true, 8000, 'B music state').catch(() => null);
  check('clubmusic DO: the member receives the owner\u2019s state (track ۷, playing, pos ≈42)',
    !!stB && stB.track === 7 && stB.playing === true && stB.pos >= 42 && stB.pos <= 45, JSON.stringify(stB));

  // late joiner syncs to the live position
  await sleep(1200);
  C.send({ type: 's-club-voice', action: 'join' });
  const stC = await C.waitFor((m) => m.type === 's-club-music-state' && m.on === true, 8000, 'C music state').catch(() => null);
  check('clubmusic DO: a late joiner syncs to the live position',
    !!stC && stC.playing === true && stC.pos >= 42.9 && stC.pos <= 46.5, stC && String(stC.pos));

  // owner pause
  B.messages.length = 0;
  A.send({ type: 's-club-music', action: 'state', track: 7, playing: false, pos: 50 });
  const stB2 = await B.waitFor((m) => m.type === 's-club-music-state' && m.playing === false, 8000, 'B paused state').catch(() => null);
  check('clubmusic DO: owner pause fans out', !!stB2 && stB2.pos === 50, JSON.stringify(stB2));

  // owner stops
  B.messages.length = 0;
  A.send({ type: 's-club-music', action: 'stop' });
  const stB3 = await B.waitFor((m) => m.type === 's-club-music-state' && m.on === false, 8000, 'B ended state').catch(() => null);
  check('clubmusic DO: STOP ends the broadcast for the room', !!stB3);

  A.close(); B.close(); C.close();
}

console.log(failures ? ('\n' + failures + ' FAILURE(S)') : '\nALL PASS');
process.exit(failures ? 1 : 0);
