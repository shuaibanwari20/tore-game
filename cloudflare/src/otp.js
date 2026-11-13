/**
 * otp.js — U65: email sign-in codes + the identity bridge.
 *
 * Two small stores over the social DO's storage (they live next
 * to the login tickets because they share the same trust domain):
 *
 * OtpStore — one live 6-digit code per email:
 *   key   `otp:<email>`  → { h, exp, tries, sentAt }
 *   - h is the SHA-256 hex of "<email>:<code>" — the plaintext
 *     code is NEVER stored; it exists only in the worker's hand
 *     for the seconds it takes to email it.
 *   - 10-minute TTL, a 60-second resend cooldown, and at most 5
 *     verify attempts before the code locks and dies.
 *
 * IdMap — the identity bridge:
 *   key   `idmap:<email>` → the canonical session `sub` for that
 *   email, FIRST WRITER WINS. Google (Firebase) sign-ins register
 *   their Firebase UID; email-code sign-ins adopt the registered
 *   sub when one exists, so the SAME person keeps ONE game
 *   identity (wallet, club, friends) across both doors. When no
 *   mapping exists yet, an email sign-in derives a stable sub
 *   from the email itself (see auth.js canonicalSub).
 *
 * Both stores are reached only through the DO's internal
 * /internal/authkv/* routes (game-server.js) via auth.js.
 */

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_COOLDOWN_MS = 60 * 1000;
export const OTP_MAX_TRIES = 5;

export function normalizeEmail(s) {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

export function isEmail(s) {
  return typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashOtpCode(email, code) {
  return sha256Hex(email + ':' + code);
}

/** The stable sub an email-only identity derives for itself. */
export async function emailDerivedSub(email) {
  return 'm:' + (await sha256Hex('tore:' + email)).slice(0, 24);
}

function randomOtpCode() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(100000 + (a[0] % 900000));
}

export class OtpStore {
  constructor(storage) {
    this.storage = storage;
  }

  key(email) {
    return 'otp:' + email;
  }

  /**
   * Start (or restart) a code for the email.
   * → { ok: true, code } — the plaintext code, for emailing.
   * → { ok: false, reason: 'cooldown', waitSec } — a code was
   *   sent too recently; the live one stays valid.
   */
  async start(email) {
    const k = this.key(email);
    let rec = null;
    try { rec = await this.storage.get(k); } catch { rec = null; }
    const now = Date.now();
    if (rec && typeof rec.sentAt === 'number' && rec.exp > now && now - rec.sentAt < OTP_COOLDOWN_MS) {
      return { ok: false, reason: 'cooldown', waitSec: Math.ceil((OTP_COOLDOWN_MS - (now - rec.sentAt)) / 1000) };
    }
    const code = randomOtpCode();
    await this.storage.put(k, {
      h: await hashOtpCode(email, code),
      exp: now + OTP_TTL_MS,
      tries: 0,
      sentAt: now,
    });
    return { ok: true, code };
  }

  /** Drop any live code (a send failed, or housekeeping). */
  async clear(email) {
    try { await this.storage.delete(this.key(email)); } catch { /* already gone */ }
  }

  /**
   * Check a code: 'ok' | 'bad' | 'gone' | 'locked'.
   * 'ok' consumes the code. A wrong code costs one try; running
   * out of tries locks the code (it is deleted — ask for a new one).
   */
  async verify(email, code) {
    const k = this.key(email);
    let rec = null;
    try { rec = await this.storage.get(k); } catch { rec = null; }
    if (!rec || typeof rec.h !== 'string') return 'gone';
    if (rec.exp <= Date.now()) {
      await this.clear(email);
      return 'gone';
    }
    const h = await hashOtpCode(email, typeof code === 'string' ? code : '');
    if (h === rec.h) {
      await this.clear(email);
      return 'ok';
    }
    rec.tries = (typeof rec.tries === 'number' ? rec.tries : 0) + 1;
    if (rec.tries >= OTP_MAX_TRIES) {
      await this.clear(email);
      return 'locked';
    }
    await this.storage.put(k, rec);
    return 'bad';
  }
}

export class IdMap {
  constructor(storage) {
    this.storage = storage;
  }

  key(email) {
    return 'idmap:' + email;
  }

  /** The canonical sub registered for the email, or null. */
  async get(email) {
    let v = null;
    try { v = await this.storage.get(this.key(email)); } catch { v = null; }
    return typeof v === 'string' && v ? v : null;
  }

  /**
   * Register `sub` for the email if none is registered yet.
   * Returns the canonical sub either way (first writer wins).
   */
  async setIfAbsent(email, sub) {
    const existing = await this.get(email);
    if (existing) return existing;
    if (typeof sub === 'string' && sub) {
      await this.storage.put(this.key(email), sub);
      return sub;
    }
    return null;
  }
}
