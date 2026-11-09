/**
 * social-node.js — Node glue for the friends system (social-core.js).
 *
 * server.js and deploy/server.js both serve the game on one ws
 * server; connections whose path is /social are handed here. The
 * Node hosts have no sign-in, so identity is the persistent client
 * player id from the hello: "p:<pid>". State lives in memory only
 * (the Cloudflare DO is the persistent production host).
 *
 * Usage:
 *   const social = createNodeSocial({ roomCheck: (id, code) => … });
 *   wss.on('connection', (ws, req) => {
 *     if (social.isSocialPath(req.url)) return social.handleConnection(ws);
 *     … game handling …
 *   });
 */
'use strict';
const crypto = require('crypto');
const { SocialCore } = require('./social-core.js');

function cleanPid(v) {
  return (typeof v === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(v)) ? v : null;
}

function createNodeSocial(opts) {
  opts = opts || {};
  const sockets = new Map(); // identity id -> Set<ws>
  // Uploaded club covers (owner photos): cid -> {type, buf}.
  // Memory-only like the rest of the Node social state — the
  // Cloudflare DO is the persistent production host.
  const coverBlobs = new Map();
  const core = new SocialCore({
    coverBlobDelete(cid) { coverBlobs.delete(cid); },
    sendTo(id, obj) {
      const set = sockets.get(id);
      if (!set) return;
      const data = JSON.stringify(obj);
      for (const ws of set) { try { ws.send(data); } catch (e) { /* already gone */ } }
    },
    persist() { /* Node hosts keep social state in memory only */ },
    inviteRoomCheck(id, code) {
      return opts.roomCheck ? !!opts.roomCheck(id, code) : false;
    },
    inGameCheck(id) {
      return opts.inGameCheck ? !!opts.inGameCheck(id) : false;
    },
    inLobbyCheck(id) {
      return opts.inLobbyCheck ? !!opts.inLobbyCheck(id) : false;
    },
    verifyBusy(id) {
      return opts.verifyBusy ? opts.verifyBusy(id) : undefined;
    },
    inviteCooldownMs: (typeof opts.inviteCooldownMs === 'number') ? opts.inviteCooldownMs : undefined,
  });

  function handleConnection(ws) {
    let myId = null;
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch (e) { return; }
      if (!msg || typeof msg.type !== 'string') return;
      if (!myId) {
        // The first message on a social socket must be the hello; it
        // carries the persistent player id + the public profile.
        if (msg.type !== 's-hello') return;
        const pid = cleanPid(msg.pid) || ('x' + crypto.randomBytes(9).toString('hex'));
        myId = 'p:' + pid;
        if (!sockets.has(myId)) sockets.set(myId, new Set());
        sockets.get(myId).add(ws);
        core.socketOpened(myId);
        core.hello(myId, msg.profile || {});
        return;
      }
      if (msg.type === 's-hello') { core.hello(myId, msg.profile || {}); return; }
      core.handleMessage(myId, msg);
    });
    const gone = () => {
      if (!myId) return;
      const set = sockets.get(myId);
      if (set) { set.delete(ws); if (!set.size) sockets.delete(myId); }
      core.socketClosed(myId);
      myId = null;
    };
    ws.on('close', gone);
    ws.on('error', gone);
  }

  return {
    core,
    handleConnection,
    isSocialPath(url) { return typeof url === 'string' && url.split('?')[0] === '/social'; },
    // ---- uploaded club covers (the hosts' HTTP routes) ----
    // Store an owner's uploaded cover, then flip the club record
    // to the custom marker through the core. Returns {cid, v} or
    // null when the identity owns no club.
    uploadCover(identityId, type, buf) {
      const club = core.ownedClub(identityId);
      if (!club) return null;
      coverBlobs.set(club.cid, { type, buf });
      const out = core.setCustomCover(identityId);
      if (!out) { coverBlobs.delete(club.cid); return null; }
      return out;
    },
    getCover(cid) { return coverBlobs.get(cid) || null; },
  };
}

module.exports = { createNodeSocial };
