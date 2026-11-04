'use strict';
/**
 * TORE bot heuristic — shared by server.js (empty seats + turn timeouts)
 * and sim.js (full bot-vs-bot matches). Always returns a LEGAL card.
 *
 * Strategy — AVOIDANCE (تاوان is a penalty: the team that ends the round
 * with LESS tawan wins, and a takan dumps +30 on your own team):
 *  - Discarding (void in the led suit) → throw the biggest tawan card
 *    first: Q♠ > J♣ > 10♦ > hearts (highest heart first) > otherwise the
 *    highest useless off-suit card.
 *  - Following suit into a trick that already holds tawan → try to LOSE
 *    it: play the highest card that still loses; if forced to win, the
 *    lowest winning card. Never overtake a partner who is winning it.
 *  - Following into a clean (no-tawan) trick → play cheap; win cheaply
 *    only if an opponent is taking it.
 *  - Leading → prefer a suit at least one other player still holds (never
 *    hand your own team a takan); lowest non-scoring card.
 *  - On the final trick, declare «۱۳» when it cancels a takan
 *    (see maybeDeclare13 — the server calls it before asking for a card).
 */
const G = require('./game');

/** Cost of shedding onto a clean trick: scoring cards hurt if partner takes them. */
function shedCost(card) {
  if (card === 'QS') return 10000; // ماتکه کالا — last resort only
  return G.cardPoints(card) * 100 + G.rankOf(card);
}

function cheapest(cards) {
  return cards.slice().sort((a, b) => shedCost(a) - shedCost(b))[0];
}

function lowestRank(cards) {
  return cards.slice().sort((a, b) => G.rankOf(a) - G.rankOf(b))[0];
}

function highestRank(cards) {
  return cards.slice().sort((a, b) => G.rankOf(b) - G.rankOf(a))[0];
}

/** Dump order for discards: biggest tawan first, then highest dead card. */
function dumpOrder(cards) {
  const prio = (c) => {
    if (c === 'QS') return 0;         // ماتکه کالا — 9, dump it first
    if (c === 'JC') return 1;         // غلام پشه — 5
    if (c === 'TD') return 2;         // ده خشت — 3
    if (G.suitOf(c) === 'H') return 3; // لال — 1 each, highest first
    return 4;
  };
  return cards.slice().sort(
    (a, b) => (prio(a) - prio(b)) || (G.rankOf(b) - G.rankOf(a))
  );
}

function pickLead(round, seat, legal) {
  // A takan lead (+30 to OUR team) happens when nobody else holds the suit —
  // avoid those suits while any alternative exists.
  const suitAlive = (suit) =>
    [0, 1, 2, 3].some((s) => s !== seat && round.hands[s].some((c) => G.suitOf(c) === suit));
  const safe = legal.filter((c) => suitAlive(G.suitOf(c)));
  const pool = safe.length ? safe : legal;
  const nonScoring = pool.filter((c) => G.cardPoints(c) === 0 && c !== 'QS');
  if (nonScoring.length) return lowestRank(nonScoring);
  const noQS = pool.filter((c) => c !== 'QS');
  return cheapest(noQS.length ? noQS : pool);
}

/**
 * If `seat` is leading the final trick with a would-be takan card, declare
 * «۱۳» (bots always declare). Returns true when a declaration was made —
 * the caller should re-broadcast state before asking for the card.
 */
function maybeDeclare13(round, seat) {
  if (!round.canDeclare13(seat)) return false;
  round.declare13(seat);
  return true;
}

/**
 * Choose a card for `seat` in the given Round. Returns a card code that is
 * guaranteed to be in round.legalMovesFor(seat).
 */
function chooseCard(round, seat) {
  const legal = round.legalMovesFor(seat);
  if (!legal.length) throw new Error('bot asked to move out of turn');
  if (legal.length === 1) return legal[0];

  const trick = round.trick;

  // --- Leading the trick ---
  if (!trick.length) return pickLead(round, seat, legal);

  const ledSuit = G.suitOf(trick[0].card);

  // --- Void in the led suit: dump the biggest tawan card on the trick ---
  if (!legal.some((c) => G.suitOf(c) === ledSuit)) return dumpOrder(legal)[0];

  // Following suit (legal = only led-suit cards here).
  const currentBest = Math.max(
    ...trick.filter((p) => G.suitOf(p.card) === ledSuit).map((p) => G.rankOf(p.card))
  );
  const trickTawan = trick.reduce((sum, p) => sum + G.cardPoints(p.card), 0);
  const winners = legal.filter((c) => G.rankOf(c) > currentBest);
  const losers = legal.filter((c) => G.rankOf(c) < currentBest);

  // --- Trick carries tawan: LOSE it if at all possible ---
  if (trickTawan > 0) {
    if (losers.length) return highestRank(losers); // highest card that still loses
    return lowestRank(winners);                   // forced to take it — cheapest win
  }

  // --- Clean trick ---
  const winnerSeat = G.trickWinnerSeat(trick);
  const partnerWinning = G.teamOf(winnerSeat) === G.teamOf(seat);
  if (partnerWinning) return cheapest(legal);     // shed cheap, never overtake partner
  if (winners.length) return lowestRank(winners); // take a clean trick cheaply
  return cheapest(legal);
}

module.exports = { chooseCard, maybeDeclare13 };
