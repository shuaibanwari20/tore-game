'use strict';
/**
 * TORE bot heuristic — shared by server.js (empty seats + turn timeouts)
 * and sim.js (full bot-vs-bot matches). Always returns a LEGAL card.
 *
 * Strategy (simple, in priority order):
 *  - Partner already winning the trick → shed the cheapest card; never waste
 *    ماتکه کالا (Q♠) while an alternative exists.
 *  - An opponent is winning → win as cheaply as possible (lowest rank that
 *    beats the current winner); if we cannot win, shed cheap.
 *  - Leading → play the lowest non-scoring card; keep Q♠ back.
 */
const G = require('./game');

/** Cost of giving a card away: scoring cards are expensive, Q♠ is precious. */
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
  if (!trick.length) {
    const nonScoring = legal.filter((c) => G.cardPoints(c) === 0 && c !== 'QS');
    if (nonScoring.length) return lowestRank(nonScoring);
    const noQS = legal.filter((c) => c !== 'QS');
    return cheapest(noQS.length ? noQS : legal);
  }

  const ledSuit = G.suitOf(trick[0].card);
  const winnerSeat = G.trickWinnerSeat(trick);
  const partnerWinning = G.teamOf(winnerSeat) === G.teamOf(seat);

  // --- Partner is winning: shed cheap, protect Q♠ ---
  if (partnerWinning) return cheapest(legal);

  // --- Opponent is winning: try to take it cheaply ---
  const currentBest = Math.max(
    ...trick.filter((p) => G.suitOf(p.card) === ledSuit).map((p) => G.rankOf(p.card))
  );
  const winners = legal.filter(
    (c) => G.suitOf(c) === ledSuit && G.rankOf(c) > currentBest
  );
  if (winners.length) {
    // Cheapest winning card: lowest rank that still wins. (If it happens to
    // be a scoring card we capture its tawan ourselves, so no extra penalty.)
    return lowestRank(winners);
  }
  // Cannot win → shed cheap, keep Q♠ unless forced.
  return cheapest(legal);
}

module.exports = { chooseCard };
