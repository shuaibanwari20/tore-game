'use strict';
/**
 * TORE (توره) — shared rules engine.
 * Used by BOTH server.js (authoritative) and sim.js (acceptance tests).
 * Spec: TORE-PROMPT.md — do not substitute rules from other games.
 */

// ---- Spec constants (DEFAULTs live here, change in one line) ----
const BANK_LOSE_TARGET = 210;  // a team whose BANKED tawan (جمع‌شده) reaches this LOSES the match — there are no match points
const TAKAN_CLAIM_AMOUNT = 30; // تکان معلق: one takan claim moves exactly this much BANKED tawan
const TAKAN_CLAIM_MIN_BANK = 30; // a pending claim executes only while the VICTIM's banked tawan (جمع‌شده) is at least this
const TAWAN_BANK_MIN = 10;     // round tawan ≥ 10 banks into the match-long bank; ≤ 9 is wiped
const TAWAN_BUMP_LIMIT = 21;   // a final round tawan ABOVE this (and below 30) is written as 30
const TAWAN_BUMP_VALUE = 30;   // …the value written instead (finals already ≥ 30 stay as they are)
const PLAYERS = 4;
const CARDS_PER_PLAYER = 13;

const SUITS = ['H', 'D', 'C', 'S']; // ♥ لال · ♦ خشت · ♣ پشه · ♠ قره
const RANK_CHARS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const RANK_VALUE = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };

// Kandahari names (for UI / logs)
const SUIT_NAMES = { H: 'لال', D: 'خشت', C: 'پشه', S: 'قره' };
const RANK_NAMES = { A: 'آس', K: 'شاه', Q: 'ماتکه', J: 'غلام', T: '۱۰', '9': '۹', '8': '۸', '7': '۷', '6': '۶', '5': '۵', '4': '۴', '3': '۳', '2': '۲' };

const suitOf = (card) => card[card.length - 1];
const rankOf = (card) => RANK_VALUE[card.slice(0, -1)];
const teamOf = (seat) => seat % 2; // seats 0&2 = team 0, seats 1&3 = team 1
const partnerOf = (seat) => (seat + 2) % 4;

function cardName(card) {
  return RANK_NAMES[card.slice(0, -1)] + ' ' + SUIT_NAMES[suitOf(card)];
}

/** Scoring value (تاوان) of a single card — exactly per spec. */
function cardPoints(card) {
  if (suitOf(card) === 'H') return 1;   // every لال (hearts) card = 1
  if (card === 'JC') return 5;          // غلام پشه — Jack of clubs
  if (card === 'QS') return 9;          // ماتکه کالا — Queen of spades
  if (card === 'TD') return 3;          // ده خشت — 10 of diamonds
  return 0;
}

function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANK_CHARS) deck.push(r + s);
  return deck;
}

// The whole deck's tawan MUST total 30 — asserted here and in sim.js.
const TOTAL_TAWAN = makeDeck().reduce((sum, c) => sum + cardPoints(c), 0);
if (TOTAL_TAWAN !== 30) throw new Error('Scoring table broken: deck tawan = ' + TOTAL_TAWAN);

function shuffle(deck, rng = Math.random) {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Deal a shuffled deck into 4 hands of 13. Returns hands[seat] = [cards]. */
function deal(rng = Math.random) {
  const deck = shuffle(makeDeck(), rng);
  const hands = [[], [], [], []];
  deck.forEach((card, i) => hands[i % 4].push(card));
  return hands;
}

/** Cards in `hand` that may legally be played given the led suit (null = leading). */
function legalPlays(hand, ledSuit) {
  if (!ledSuit) return hand.slice();
  const follow = hand.filter((c) => suitOf(c) === ledSuit);
  return follow.length ? follow : hand.slice();
}

/** trick = [{seat, card}, ...] in play order. Returns winning seat. No trump. */
function trickWinnerSeat(trick) {
  const led = suitOf(trick[0].card);
  let best = trick[0];
  for (const play of trick) {
    if (suitOf(play.card) === led && rankOf(play.card) > rankOf(best.card)) best = play;
  }
  return best.seat;
}

function tawanOf(cards) {
  return cards.reduce((sum, c) => sum + cardPoints(c), 0);
}

/**
 * Round scoring — the Tore rule (تاوان is a PENALTY: FEWER is better).
 * Input: cardTawan = tawan from captured cards ONLY. A takan adds NO
 * round tawan (user's clarified model, 2026-11-06): it only creates a
 * PENDING claim on the other team's BANK, executed by Match (تکان
 * معلق — see Match.onRoundFinished). The two teams' card tawan always
 * sums to exactly 30 before the bump.
 *  BUMP: a final tawan above 21 (and below 30) is written as 30 —
 *  «هر بازیکن که بیشتر از ۲۱ تاوان گرفت باید برایش ۳۰ تاوان نوشته شوه».
 *  A final of exactly 30 stays as-is. The bump applies BEFORE the bank.
 * There are NO match points (removed at the user's explicit order,
 * 2026-11-05): a round only produces the final tawan, which banks in
 * Match (see TAWAN_BANK_MIN) toward BANK_LOSE_TARGET. A tied final —
 * incl. the classic 15–15 — is simply a tie: both teams bank their
 * own equal tawan; Q♠ decides nothing.
 * Returns { tawan (final, post-bump), bumped }.
 */
function scoreRound(cardTawan) {
  const tawan = cardTawan.slice();
  const bumped = tawan.map((t) => t > TAWAN_BUMP_LIMIT && t < TAWAN_BUMP_VALUE);
  if (bumped[0]) tawan[0] = TAWAN_BUMP_VALUE;
  if (bumped[1]) tawan[1] = TAWAN_BUMP_VALUE;
  return { tawan, bumped };
}

/**
 * Match decision after a round, from the BANKED tawan totals (جمع‌شده).
 * The team whose banked total reaches BANK_LOSE_TARGET LOSES the match.
 * Returns the LOSING team, or null to keep playing: nobody at target
 * yet, or BOTH teams at/above target with EXACTLY equal totals (no
 * loser yet → one more round). If both are at/above target and the
 * totals differ, the HIGHER total loses.
 */
function decideMatchLoser(bankedTawan) {
  const [a, b] = bankedTawan;
  if (a < BANK_LOSE_TARGET && b < BANK_LOSE_TARGET) return null;
  if (a === b) return null; // both across but exactly equal → another round
  return a > b ? 0 : 1;
}

/**
 * One round (13 tricks). Authoritative state machine.
 * emit(evt) receives: cardPlayed, trickWon, takan, declared13, roundFinished.
 */
class Round {
  constructor(firstLeader, emit = () => {}, rng = Math.random) {
    this.hands = deal(rng);
    this.emit = emit;
    this.leader = firstLeader;
    this.turn = firstLeader;
    this.trick = [];                       // [{seat, card}]
    this.captured = [[], []];              // captured cards per team
    this.tricksPlayed = 0;
    this.wonTricks = [0, 0, 0, 0];         // won-trick pile size per seat
    this.takanCount = [0, 0];              // تکان events per team this round
    this.takanBy = [[], []];               // seats that gave each تکان, per team
    this.declared13 = false;               // leader declared «۱۳» for the current trick
    this.finished = false;
    this.result = null;                    // see finish()
  }

  ledSuit() {
    return this.trick.length ? suitOf(this.trick[0].card) : null;
  }

  /** True if NO other player currently holds `suit` (checked pre-play). */
  othersVoidIn(suit, seat) {
    return [0, 1, 2, 3].every(
      (s) => s === seat || !this.hands[s].some((c) => suitOf(c) === suit)
    );
  }

  /**
   * True when `seat` is leading the FINAL trick (everyone holds 1 card)
   * with a card whose suit nobody else holds — i.e. playing it would be a
   * takan unless they first declare «۱۳».
   */
  canDeclare13(seat) {
    if (this.finished || this.declared13) return false;
    if (seat !== this.turn || this.trick.length) return false;
    if (!this.hands.every((h) => h.length === 1)) return false;
    return this.othersVoidIn(suitOf(this.hands[seat][0]), seat);
  }

  /** Declare «۱۳» for the current (final) trick. Throws when not allowed. */
  declare13(seat) {
    if (!this.canDeclare13(seat)) throw new Error('cannot declare 13 now');
    this.declared13 = true;
    this.emit({ type: 'declared13', seat });
  }

  legalMovesFor(seat) {
    if (this.finished || seat !== this.turn) return [];
    return legalPlays(this.hands[seat], this.ledSuit());
  }

  /** Play a card. Throws Error with a plain message on any illegal move. */
  play(seat, card) {
    if (this.finished) throw new Error('round is finished');
    if (seat !== this.turn) throw new Error('not your turn');
    const hand = this.hands[seat];
    const idx = hand.indexOf(card);
    if (idx === -1) throw new Error('card not in hand');
    if (!legalPlays(hand, this.ledSuit()).includes(card)) {
      throw new Error('must follow suit (' + SUIT_NAMES[this.ledSuit()] + ')');
    }

    // TAKAN (تکان): leading a suit NONE of the other three players currently
    // holds (checked now, before the card leaves the leader's hand). A «۱۳»
    // declaration for this trick cancels it. A takan adds NO round tawan —
    // it only counts toward a pending BANK claim at Match level (تکان معلق).
    if (this.trick.length === 0) {
      const declared = this.declared13;
      this.declared13 = false; // the flag belongs to this one lead only
      if (!declared && this.othersVoidIn(suitOf(card), seat)) {
        const team = teamOf(seat);
        this.takanCount[team]++;
        this.takanBy[team].push(seat);
        this.emit({
          type: 'takan', seat, team, card,
          count: this.takanCount[team],
        });
      }
    }

    hand.splice(idx, 1);
    this.trick.push({ seat, card });
    this.emit({ type: 'cardPlayed', seat, card });

    if (this.trick.length < PLAYERS) {
      this.turn = (seat + 1) % PLAYERS;
      return;
    }
    // Trick complete.
    const winnerSeat = trickWinnerSeat(this.trick);
    const wonCards = this.trick.map((p) => p.card);
    this.captured[teamOf(winnerSeat)].push(...wonCards);
    this.wonTricks[winnerSeat]++;
    this.emit({
      type: 'trickWon', winnerSeat, cards: wonCards,
      tawan: tawanOf(wonCards), trickNo: this.tricksPlayed + 1,
    });
    this.trick = [];
    this.tricksPlayed++;
    this.leader = winnerSeat;
    this.turn = winnerSeat;

    if (this.tricksPlayed === CARDS_PER_PLAYER) this.finish();
  }

  finish() {
    const cardTawan = [tawanOf(this.captured[0]), tawanOf(this.captured[1])];
    const qsTeam = this.captured[0].includes('QS') ? 0 : 1;
    const s = scoreRound(cardTawan);
    this.result = {
      cardTawan,                                  // tawan from captured cards (sums to 30)
      takanCount: this.takanCount.slice(),        // تکان count per team this round (claims only — no round tawan)
      takanBy: [this.takanBy[0].slice(), this.takanBy[1].slice()], // seats that gave the takans
      bumped: s.bumped,                           // >21 final written as 30, per team
      tawan: s.tawan,                             // FINAL round tawan per team (post-bump)
      qsTeam,                                     // team that captured Q♠ (summary info only — decides nothing)
    };
    this.finished = true;
    this.emit({ type: 'roundFinished', ...this.result });
  }
}

/**
 * A full match: rounds until one team's BANKED tawan reaches
 * BANK_LOSE_TARGET — that team LOSES and the other team wins. There
 * are no match points; banked tawan (جمع‌شده) decides everything.
 * First leader rotates each round (round index % 4).
 * emit(evt) receives everything Round emits, plus matchFinished
 * ({ winner, loser, bankedTawan }).
 */
class Match {
  constructor(emit = () => {}, rng = Math.random) {
    this.emit = emit;
    this.rng = rng;
    this.bankedTawan = [0, 0];   // match-long tawan bank: a round's final tawan banks only when ≥ TAWAN_BANK_MIN (≤ 9 is wiped)
    this.pendingTakan = [0, 0];  // تکان معلق: pending claims per team — each claim takes TAKAN_CLAIM_AMOUNT from the OTHER team's bank once it reaches TAKAN_CLAIM_MIN_BANK
    this.roundNo = 0;
    this.history = [];   // per-round: {roundNo, cardTawan, takanCount, takanBy, bumped, tawan, banked, claimsCreated, claimsExecuted, pendingTakan, bankedTawan, qsTeam}
    this.finished = false;
    this.winner = null;   // the team that did NOT cross the target
    this.loser = null;    // the team whose banked tawan reached BANK_LOSE_TARGET
    this.round = null;
  }

  firstLeader() {
    return this.roundNo % PLAYERS;
  }

  startRound() {
    if (this.finished) throw new Error('match is finished');
    this.roundNo++;
    const round = new Round(this.firstLeader(), (evt) => {
      this.emit(evt);
      if (evt.type === 'roundFinished') this.onRoundFinished(round);
    }, this.rng);
    this.round = round;
    return round;
  }

  onRoundFinished(round) {
    const r = round.result;
    // Tawan bank (user rule): the round's FINAL (post-bump) tawan is
    // added to the team's match-long bank only when it reaches
    // TAWAN_BANK_MIN; a final of ≤ 9 is wiped and forgotten. scoreRound
    // has already applied the >21→30 bump to r.tawan, so a bumped 30
    // banks as 30 and the ≤9 wipe is unaffected.
    const banked = r.tawan.map((t) => (t >= TAWAN_BANK_MIN ? t : 0));
    this.bankedTawan[0] += banked[0];
    this.bankedTawan[1] += banked[1];

    // PENDING TAKAN (تکان معلق — user rule, 2026-11-05): if EXACTLY ONE
    // team gave takan(s) this round, that team gains one pending claim
    // per takan against the other (victim) team. (Both-takan rounds
    // create nothing; a «۱۳»-cancelled takan never reaches takanCount,
    // so it creates nothing either.) Then — AFTER this round's banking —
    // pending claims execute: while a team holds claims and the VICTIM's
    // banked tawan is ≥ TAKAN_CLAIM_MIN_BANK, one claim moves exactly
    // TAKAN_CLAIM_AMOUNT from the victim's bank to the claim holder's
    // bank. A claim earned this round can execute this same round; an
    // unexecuted claim stays pending (its ★ stays on the board) into
    // later rounds. Team 0's claims are processed before team 1's, so
    // the order is deterministic when both teams hold claims.
    const claimsCreated = [0, 0];
    const singleTakan = (r.takanCount[0] > 0) !== (r.takanCount[1] > 0);
    if (singleTakan) {
      const t = r.takanCount[0] > 0 ? 0 : 1;
      claimsCreated[t] = r.takanCount[t];
      this.pendingTakan[t] += r.takanCount[t];
    }
    const claimsExecuted = [0, 0];
    for (const t of [0, 1]) {
      const victim = 1 - t;
      while (this.pendingTakan[t] > 0 &&
             this.bankedTawan[victim] >= TAKAN_CLAIM_MIN_BANK) {
        this.bankedTawan[victim] -= TAKAN_CLAIM_AMOUNT;
        this.bankedTawan[t] += TAKAN_CLAIM_AMOUNT;
        this.pendingTakan[t]--;
        claimsExecuted[t]++;
      }
    }

    this.history.push({
      roundNo: this.roundNo, cardTawan: r.cardTawan.slice(),
      takanCount: r.takanCount.slice(),
      takanBy: r.takanBy ? r.takanBy.map((a) => a.slice()) : [[], []],
      bumped: r.bumped ? r.bumped.slice() : [false, false],
      tawan: r.tawan.slice(), banked: banked.slice(),
      claimsCreated, claimsExecuted,
      pendingTakan: this.pendingTakan.slice(),
      bankedTawan: this.bankedTawan.slice(), qsTeam: r.qsTeam,
    });
    // Match end (user rule) — checked AFTER the pending executions
    // above: the team whose banked tawan (جمع‌شده) has reached
    // BANK_LOSE_TARGET LOSES; the other team wins. Both across in the
    // same round → the higher total loses; exactly equal → the match
    // continues with another round (see decideMatchLoser).
    const loser = decideMatchLoser(this.bankedTawan);
    if (loser !== null) {
      this.finished = true;
      this.loser = loser;
      this.winner = 1 - loser;
      this.emit({
        type: 'matchFinished', winner: this.winner, loser,
        bankedTawan: this.bankedTawan.slice(),
      });
    }
  }
}

/** Deterministic RNG (mulberry32) — for reproducible simulations. */
function seededRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = {
  BANK_LOSE_TARGET, TAKAN_CLAIM_AMOUNT, TAKAN_CLAIM_MIN_BANK, TAWAN_BANK_MIN, TAWAN_BUMP_LIMIT, TAWAN_BUMP_VALUE, PLAYERS, CARDS_PER_PLAYER,
  SUITS, SUIT_NAMES, RANK_NAMES, TOTAL_TAWAN,
  suitOf, rankOf, teamOf, partnerOf, cardName, cardPoints,
  makeDeck, shuffle, deal, legalPlays, trickWinnerSeat, tawanOf,
  scoreRound, decideMatchLoser, Round, Match, seededRng,
};
