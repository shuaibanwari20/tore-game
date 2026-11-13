/**
 * tickets.js — one-time LOGIN TICKETS for the installed-app
 * sign-in (U60).
 *
 * Why: inside a home-screen app (iOS standalone above all),
 * neither Firebase flow can deliver its result back into the app —
 * the popup's promise never settles and the redirect finishes in
 * Safari's storage partition. So the app gate instead:
 *
 *   1. asks the Worker for a ticket (POST /auth/ticket) — stored
 *      HERE, in the global GameServer DO's storage;
 *   2. opens /auth/google?ticket=<id> (Safari sheet) — the normal
 *      server-side OAuth flow runs there, and the callback marks
 *      the ticket complete with the verified session payload;
 *   3. polls /auth/ticket-status — the Worker reads the ticket
 *      back (ONE time) and mints the session cookie on a response
 *      served INTO the app's own context, where cookies belong.
 *
 * A ticket lives 10 minutes, completes once, and is consumed by
 * the first successful (or failed) status read — a leaked ticket
 * URL is worthless after use and useless before completion (it
 * carries no identity until Google verifies one).
 */

export const TICKET_TTL_MS = 10 * 60 * 1000;

export function isTicketId(s) {
  return typeof s === 'string' && /^[0-9a-f]{32}$/.test(s);
}

/* U63: every ticket ALSO carries an 8-digit sign-in CODE — the
 * human-carryable alias of the ticket. The app gate shows it; the
 * player types it into the gate in a normal browser (where the
 * Firebase sign-in works) and that browser completes THIS ticket.
 * The code alone is worthless: completing still requires a valid
 * Firebase ID token, and the alias dies with the ticket. */
export function isTicketCode(s) {
  return typeof s === 'string' && /^[0-9]{8}$/.test(s);
}

function randomCode() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(10000000 + (a[0] % 90000000));
}

function randomTicketId() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Storage-backed ticket store; `storage` is the DO storage API
 *  (get/put/delete), injected so the state machine is testable. */
export class TicketStore {
  constructor(storage) {
    this.storage = storage;
  }

  key(id) {
    return 'ticket:' + id;
  }

  async create() {
    const id = randomTicketId();
    await this.storage.put(this.key(id), {
      exp: Date.now() + TICKET_TTL_MS,
      user: null,
      failed: false,
    });
    return id;
  }

  async _live(id) {
    if (!isTicketId(id)) return null;
    let rec = null;
    try { rec = await this.storage.get(this.key(id)); } catch { rec = null; }
    if (!rec) return null;
    if (rec.exp && Date.now() > rec.exp) {
      try { await this.storage.delete(this.key(id)); } catch { /* already gone */ }
      return null;
    }
    return rec;
  }

  /** Mint a ticket together with its 8-digit sign-in code. */
  async createWithCode() {
    const id = await this.create();
    for (let i = 0; i < 10; i++) {
      const code = randomCode();
      let taken = null;
      try { taken = await this.storage.get('code:' + code); } catch { taken = null; }
      if (taken) continue;
      const rec = await this._live(id);
      if (!rec) return { id, code: null };
      rec.code = code;
      await this.storage.put(this.key(id), rec);
      await this.storage.put('code:' + code, id);
      return { id, code };
    }
    return { id, code: null };
  }

  /** The ticket id behind a sign-in code, or null. Only a PENDING
   *  ticket resolves — a completed or failed one is done. */
  async lookupByCode(code) {
    if (!isTicketCode(code)) return null;
    let id = null;
    try { id = await this.storage.get('code:' + code); } catch { id = null; }
    if (!isTicketId(id)) return null;
    const rec = await this._live(id);
    if (!rec || rec.failed || rec.user) return null;
    return id;
  }

  /** A verified sign-in attaches its identity — ONCE: a second
   *  completion (even with a different identity) is refused, so a
   *  completed ticket's payload can never be overwritten while
   *  the gate is still polling for it. */
  async complete(id, user) {
    if (!user || !user.sub) return false;
    const rec = await this._live(id);
    if (!rec || rec.failed || rec.user) return false;
    rec.user = user;
    await this.storage.put(this.key(id), rec);
    return true;
  }

  /** The Google callback failed: the waiting gate should stop. */
  async fail(id) {
    const rec = await this._live(id);
    if (!rec) return false;
    if (rec.code) { try { await this.storage.delete('code:' + rec.code); } catch { /* gone */ } }
    rec.failed = true;
    await this.storage.put(this.key(id), rec);
    return true;
  }

  /** One-time read: 'done' and 'failed' consume the ticket. */
  async status(id) {
    const rec = await this._live(id);
    if (!rec) return { state: 'gone' };
    if (rec.failed) {
      await this.storage.delete(this.key(id));
      if (rec.code) { try { await this.storage.delete('code:' + rec.code); } catch { /* gone */ } }
      return { state: 'failed' };
    }
    if (rec.user) {
      await this.storage.delete(this.key(id));
      if (rec.code) { try { await this.storage.delete('code:' + rec.code); } catch { /* gone */ } }
      return { state: 'done', user: rec.user };
    }
    return { state: 'pending' };
  }
}
