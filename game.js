'use strict';
/**
 * TORE (توره) — shared rules engine.
 * Used by BOTH server.js (authoritative) and sim.js (acceptance tests).
 * Spec: TORE-PROMPT.md — do not substitute rules from other games.
 */

// ---- Spec constants (DEFAULTs live here, change in one line) ----
const MATCH_TARGET = 210;      // match points to win
const ROUND_WIN_POINTS = 20;    // credited to round winner
const ROUND_LOSE_POINTS = 10;   // credited to round loser
const TAKAN_POINTS = 30;       // تکان bonus tawan (leading a suit nobody else holds)
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
 * Round scoring — the Tore rule (تاوان is a PENALTY: fewer is better).
 * Inputs: cardTawan = tawan from captured cards; takanBonus / takanCount per
 * team; qsTeam = team that captured Q♠ (ماتکه کالا).
 *  1. Round tawan per team = cardTawan + takanBonus.
 *  2. TAKAN TRANSFER: if EXACTLY ONE team has a takan, ALL of both teams'
 *     round tawan is reassigned to the takan team (the other team gets 0).
 *  3. The team with FEWER final tawan wins (20); the other gets 10.
 *     On a tie (incl. the classic 15–15), the team that did NOT capture
 *     Q♠ wins. Credits are always 20/10.
 * Returns { tawan (final), transferred, transferTo, winner, credits }.
 */
function scoreRound(cardTawan, takanBonus, takanCount, qsTeam) {
  const raw = [cardTawan[0] + takanBonus[0], cardTawan[1] + takanBonus[1]];
  let tawan = raw.slice();
  let transferred = false;
  let transferTo = null;
  const has0 = takanCount[0] > 0, has1 = takanCount[1] > 0;
  if (has0 !== has1) {
    transferTo = has0 ? 0 : 1;
    tawan = [0, 0];
    tawan[transferTo] = raw[0] + raw[1];
    transferred = true;
  }
  let winner;
  if (tawan[0] < tawan[1]) winner = 0;
  else if (tawan[1] < tawan[0]) winner = 1;
  else winner = 1 - qsTeam; // tie → the team that did NOT take ماتکه کالا wins
  const credits = [ROUND_LOSE_POINTS, ROUND_LOSE_POINTS];
  credits[winner] = ROUND_WIN_POINTS;
  return { tawan, transferred, transferTo, winner, credits };
}

/**
 * Match decision after a round. scores = [s0, s1].
 * Returns winning team, or null to keep playing (nobody at target, or an
 * exact tie at/above target → one more round per spec DEFAULT).
 */
function decideMatch(scores) {
  const [a, b] = scores;
  if (a < MATCH_TARGET && b < MATCH_TARGET) return null;
  if (a === b) return null; // exact tie above target → extra round
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
    this.takanBonus = [0, 0];              // تکان bonus tawan per team (30 × count)
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
    // declaration for this trick cancels it. +30 tawan to the leader's team.
    if (this.trick.length === 0) {
      const declared = this.declared13;
      this.declared13 = false; // the flag belongs to this one lead only
      if (!declared && this.othersVoidIn(suitOf(card), seat)) {
        const team = teamOf(seat);
        this.takanCount[team]++;
        this.takanBonus[team] += TAKAN_POINTS;
        this.emit({
          type: 'takan', seat, team, card,
          count: this.takanCount[team], bonus: this.takanBonus[team],
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
    const s = scoreRound(cardTawan, this.takanBonus, this.takanCount, qsTeam);
    this.result = {
      cardTawan,                                  // tawan from captured cards (sums to 30)
      takanBonus: this.takanBonus.slice(),        // تکان bonus per team
      takanCount: this.takanCount.slice(),        // تکان count per team (red stars)
      transferred: s.transferred,                 // takan transfer applied?
      transferTo: s.transferTo,                   // team that received ALL tawan (or null)
      tawan: s.tawan,                             // FINAL round tawan per team
      qsTeam, winner: s.winner, credits: s.credits,
    };
    this.finished = true;
    this.emit({ type: 'roundFinished', ...this.result });
  }
}

/**
 * A full match: rounds until a team reaches MATCH_TARGET.
 * First leader rotates each round (round index % 4).
 * emit(evt) receives everything Round emits, plus matchFinished.
 */
class Match {
  constructor(emit = () => {}, rng = Math.random) {
    this.emit = emit;
    this.rng = rng;
    this.scores = [0, 0];
    this.roundNo = 0;
    this.history = [];   // per-round: {roundNo, cardTawan, takanBonus, takanCount, transferred, transferTo, tawan, qsTeam, winner, credits, scoresAfter}
    this.finished = false;
    this.winner = null;
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
    this.scores[0] += r.credits[0];
    this.scores[1] += r.credits[1];
    this.history.push({
      roundNo: this.roundNo, cardTawan: r.cardTawan.slice(),
      takanBonus: r.takanBonus.slice(), takanCount: r.takanCount.slice(),
      transferred: r.transferred, transferTo: r.transferTo,
      tawan: r.tawan.slice(), qsTeam: r.qsTeam,
      winner: r.winner, credits: r.credits.slice(), scoresAfter: this.scores.slice(),
    });
    const winner = decideMatch(this.scores);
    if (winner !== null) {
      this.finished = true;
      this.winner = winner;
      this.emit({ type: 'matchFinished', winner, scores: this.scores.slice() });
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
  MATCH_TARGET, ROUND_WIN_POINTS, ROUND_LOSE_POINTS, TAKAN_POINTS, PLAYERS, CARDS_PER_PLAYER,
  SUITS, SUIT_NAMES, RANK_NAMES, TOTAL_TAWAN,
  suitOf, rankOf, teamOf, partnerOf, cardName, cardPoints,
  makeDeck, shuffle, deal, legalPlays, trickWinnerSeat, tawanOf,
  scoreRound, decideMatch, Round, Match, seededRng,
};
