'use strict';
/**
 * TORE bot heuristic — shared by server.js (empty seats + turn timeouts)
 * and sim.js (full bot-vs-bot matches). Always returns a LEGAL card.
 *
 * Strategy — COLLECTION (تاوان is the prize: the team that ends the round
 * with MORE tawan wins, and a takan adds +30 to your own team):
 *  - Discarding (void in the led suit) → if partner is winning the trick,
 *    feed it the biggest scoring card (those points land with our team);
 *    otherwise shed NON-scoring cards first (highest dead card), keeping
 *    hearts/Q♠/J♣/10♦; forced to shed a scoring card → the cheapest one.
 *  - Following suit into a trick that already holds tawan → try to WIN
 *    it: lowest winning card — unless partner is already winning it
 *    (never overtake a partner; feed points under the win instead).
 *  - Following into a clean (no-tawan) trick → don't waste big winners
 *    on empty tricks: duck under when possible, win only when forced.
 *  - Leading → seek a takan (a suit nobody else holds is a REWARD now):
 *    lead a dead suit when holding one; otherwise a cheap non-scoring
 *    card from a live suit.
 *  - On the final trick bots do NOT declare «۱۳» — declaring would
 *    cancel their own takan reward (see maybeDeclare13).
 */
const G = require('./game');

function lowestRank(cards) {
  return cards.slice().sort((a, b) => G.rankOf(a) - G.rankOf(b))[0];
}

function highestRank(cards) {
  return cards.slice().sort((a, b) => G.rankOf(b) - G.rankOf(a))[0];
}

/** Cheapest card to give away: fewest tawan points, then lowest rank. */
function cheapestGiveaway(cards) {
  return cards.slice().sort(
    (a, b) => (G.cardPoints(a) - G.cardPoints(b)) || (G.rankOf(a) - G.rankOf(b))
  )[0];
}

/** Biggest scoring card in `cards` (most tawan, then highest rank), or null. */
function biggestScoring(cards) {
  const scoring = cards.filter((c) => G.cardPoints(c) > 0);
  if (!scoring.length) return null;
  return scoring.slice().sort(
    (a, b) => (G.cardPoints(b) - G.cardPoints(a)) || (G.rankOf(b) - G.rankOf(a))
  )[0];
}

function pickLead(round, seat, legal) {
  // A takan lead (+30 to OUR team) happens when nobody else holds the suit —
  // seek those suits first: the trick is uncontested and the bonus is ours.
  const dead = legal.filter((c) => round.othersVoidIn(G.suitOf(c), seat));
  if (dead.length) return lowestRank(dead);
  // Live suit: cheap non-scoring probe — scoring cards stay in hand.
  const nonScoring = legal.filter((c) => G.cardPoints(c) === 0);
  if (nonScoring.length) return lowestRank(nonScoring);
  return cheapestGiveaway(legal);
}

/**
 * Bots never declare «۱۳»: under collection rules a takan is a reward
 * (+30 to the bot's own team), and declaring would cancel it. Returns
 * false always — the declaration mechanic remains available to humans.
 * (The server calls this before asking for a card.)
 */
function maybeDeclare13(round, seat) {
  return false;
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
  const winnerSeat = G.trickWinnerSeat(trick);
  const partnerWinning = G.teamOf(winnerSeat) === G.teamOf(seat);
  const trickTawan = trick.reduce((sum, p) => sum + G.cardPoints(p.card), 0);

  // --- Void in the led suit: discard ---
  if (!legal.some((c) => G.suitOf(c) === ledSuit)) {
    if (partnerWinning) {
      // The points land with OUR team — feed the biggest scoring card.
      const feed = biggestScoring(legal);
      if (feed) return feed;
      return highestRank(legal); // nothing scoring: shed the biggest dead card
    }
    // An opponent takes this trick: shed dead weight, keep scoring cards.
    const deadCards = legal.filter((c) => G.cardPoints(c) === 0);
    if (deadCards.length) return highestRank(deadCards);
    return cheapestGiveaway(legal); // forced: give away the cheapest points
  }

  // Following suit (legal = only led-suit cards here).
  const currentBest = Math.max(
    ...trick.filter((p) => G.suitOf(p.card) === ledSuit).map((p) => G.rankOf(p.card))
  );
  const winners = legal.filter((c) => G.rankOf(c) > currentBest);
  const losers = legal.filter((c) => G.rankOf(c) < currentBest);

  // --- Partner is winning: never overtake — feed points under the win ---
  if (partnerWinning) {
    const feed = biggestScoring(losers);
    if (feed) return feed;
    if (losers.length) return cheapestGiveaway(losers);
    return lowestRank(winners); // forced to overtake: cheapest winner (trick stays ours)
  }

  // --- Opponent is winning a trick that carries tawan: TAKE it ---
  if (trickTawan > 0) {
    if (winners.length) return lowestRank(winners); // cheapest card that takes the points
    // Can't win: shed without adding points where possible.
    const deadLosers = losers.filter((c) => G.cardPoints(c) === 0);
    if (deadLosers.length) return highestRank(deadLosers);
    return cheapestGiveaway(losers.length ? losers : legal);
  }

  // --- Clean trick, opponent winning: don't waste big winners on it ---
  if (losers.length) return highestRank(losers); // duck under, keep the winners
  return lowestRank(winners);                    // forced to take an empty trick
}

module.exports = { chooseCard, maybeDeclare13 };
