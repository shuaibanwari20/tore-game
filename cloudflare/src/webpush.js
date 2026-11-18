/**
 * webpush.js — Web Push sending for the GameServer Durable Object
 * (feat5). Implements the two RFCs a push service demands, with
 * WebCrypto only (the Workers runtime has no Node crypto):
 *
 *   RFC 8292 (VAPID): an ES256 JWT signed with the app's P-256
 *     key pair identifies this sender. The PUBLIC key is a Worker
 *     var (WEBPUSH_VAPID_PUBLIC — it also ships to clients as the
 *     PushManager applicationServerKey via GET /push-key); the
 *     PRIVATE key is a Worker SECRET (WEBPUSH_VAPID_PRIVATE) set
 *     in the dashboard — it is never committed. While the secret
 *     is absent, sendPush() answers 'unconfigured' and the game
 *     simply keeps its in-app notification centre only.
 *
 *   RFC 8291 (aes128gcm payload encryption): the payload is
 *     encrypted to the subscription's p256dh with its auth secret:
 *     ECDH(ephemeral server key, ua public) → HKDF(auth) → IKM →
 *     HKDF(salt) → CEK + nonce → AES-128-GCM over payload||0x02,
 *     framed as salt(16) | rs(4096) | idlen(65) | server public |
 *     ciphertext. The round-trip is unit-proven against an
 *     independent node:crypto decryption (shots/test-feat5-core).
 *
 * Subscription records come from social-core ({endpoint, p256dh,
 * auth}); a 404/410 answer means the push service has forgotten
 * the subscription — the caller drops it via pushDropEndpoint.
 */

const te = new TextEncoder();

export function b64urlToBytes(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64url(b) {
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concat(...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
async function hmacSha256(keyBytes, data) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
// RFC 5869 expand step (the extract steps are plain HMAC calls).
async function hkdfExpand(prk, info, len) {
  const blocks = [];
  let prev = new Uint8Array(0);
  let made = 0;
  let counter = 1;
  while (made < len) {
    prev = await hmacSha256(prk, concat(prev, info, new Uint8Array([counter++])));
    blocks.push(prev);
    made += prev.length;
  }
  return concat(...blocks).subarray(0, len);
}
// The sender's JWK, rebuilt from the two stored halves: the public
// var carries the uncompressed point (0x04|x|y); the secret carries
// the raw private scalar d.
function vapidJwk(publicB64, privateB64) {
  const pub = b64urlToBytes(publicB64);
  if (pub.length !== 65 || pub[0] !== 4) return null;
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: bytesToB64url(pub.subarray(1, 33)),
    y: bytesToB64url(pub.subarray(33, 65)),
  };
  if (privateB64) jwk.d = bytesToB64url(b64urlToBytes(privateB64));
  return jwk;
}

export async function vapidJwt(endpoint, publicB64, privateB64, subject) {
  const jwk = vapidJwk(publicB64, privateB64);
  if (!jwk || !jwk.d) throw new Error('vapid keys not configured');
  const aud = new URL(endpoint).origin;
  const header = bytesToB64url(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64url(te.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject || 'mailto:admin@example.com',
  })));
  const signing = header + '.' + payload;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto's ECDSA signature is already the raw R||S JWS form.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(signing)));
  return signing + '.' + bytesToB64url(sig);
}

// RFC 8291 encryption with a CALLER-SUPPLIED salt and ephemeral key
// (the test drives this deterministically; sendPush generates both).
export async function encryptWithKey(sub, payloadBytes, serverPubBytes, serverJwk, salt) {
  const uaPub = b64urlToBytes(sub.p256dh);
  const auth = b64urlToBytes(sub.auth);
  const ecdhKey = await crypto.subtle.importKey('jwk', serverJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, ecdhKey, 256));
  // IKM: HKDF with the auth secret as salt, keyed by the ECDH secret.
  const keyInfo = concat(te.encode('WebPush: info\0'), uaPub, serverPubBytes);
  const ikm = await hkdfExpand(await hmacSha256(auth, shared), keyInfo, 32);
  // CEK + nonce: HKDF with the message salt as salt, keyed by IKM.
  const prk = await hmacSha256(salt, ikm);
  const cek = await hkdfExpand(prk, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, te.encode('Content-Encoding: nonce\0'), 12);
  const plain = concat(payloadBytes, new Uint8Array([2])); // 0x02 = last-record delimiter, no padding
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plain));
  const head = new Uint8Array(16 + 4 + 1 + serverPubBytes.length);
  head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = serverPubBytes.length;
  head.set(serverPubBytes, 21);
  return concat(head, ct);
}

// Send ONE notification to ONE subscription. Answers:
//   { sent: true, status }          the push service accepted it
//   { sent: false, gone: true }     404/410 — drop the subscription
//   { sent: false, unconfigured }   no VAPID secret on this host
//   { sent: false, error }          anything else (network, 4xx/5xx)
export async function sendPush(sub, payloadObj, opts) {
  const publicKey = opts && opts.publicKey;
  const privateKey = opts && opts.privateKey;
  if (!publicKey || !privateKey) return { sent: false, unconfigured: true };
  try {
    const pair = await crypto.subtle.generateKeyPair({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const serverPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const serverJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const body = await encryptWithKey(sub, te.encode(JSON.stringify(payloadObj || {})), serverPub, serverJwk, salt);
    const jwt = await vapidJwt(sub.endpoint, publicKey, privateKey, opts.subject);
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        TTL: String((opts && opts.ttl) || 86400),
        Authorization: 'vapid t=' + jwt + ', k=' + publicKey,
      },
      body,
    });
    if (res.status === 404 || res.status === 410) return { sent: false, gone: true, status: res.status };
    if (res.status >= 200 && res.status < 300) return { sent: true, status: res.status };
    return { sent: false, status: res.status };
  } catch (e) {
    return { sent: false, error: String((e && e.message) || e) };
  }
}
