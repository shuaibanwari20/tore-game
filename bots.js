'use strict';
/**
 * TORE bot heuristic — shared by server.js (empty seats + turn timeouts)
 * and sim.js (full bot-vs-bot matches). Always returns a LEGAL card.
 *
 * Strategy — AVOIDANCE + FEED THE OPPONENTS (تاوان is a PENALTY: the team
 * that ends the round with FEWER tawan wins; a takan adds NO round tawan
 * but hands the OTHER team a pending claim on OUR bank — avoid giving it):
 *  - FEED: whenever an OPPONENT is winning the trick, push our tawan
 *    into THEIR captured pile — discarding while void, or ducking while
 *    following suit, we dump the BIGGEST scoring card we legally can
 *    (Q♠ first, then J♣, 10♦, then hearts). Never hand tawan to our own
 *    partner's winning trick.
 *  - Discarding (void in the led suit) → if partner is winning, shed
 *    NON-scoring cards only (highest dead card); forced to shed a
 *    scoring card → the cheapest one. If an opponent is winning, feed
 *    them the biggest scoring card (see FEED above).
 *  - Following suit with partner winning → never overtake, never add
 *    tawan: low safe (non-scoring) cards under the win; forced to
 *    overtake → the cheapest safe winner.
 *  - Following suit with an opponent winning → duck under whenever a
 *    legal card allows it (feeding our biggest scoring loser onto
 *    their trick); win only when forced, and then with the lowest
 *    sufficient card — a tawan trick we are forced to take costs us
 *    the least that way.
 *  - Leading → a dead-suit lead is a takan: it creates a pending claim
 *    AGAINST our own bank for the opponents, so avoid dead suits; lead
 *    a cheap non-scoring card from a live suit. Only when every lead is
 *    a dead suit (or every card scores) take the cheapest way out.
 *  - NO-REPEAT TAKAN LAW (owner order, 2026-11-09 — ABSOLUTE, not a
 *    preference): a bot NEVER leads a suit it has already takan'd this
 *    round while it still holds ANY card of another suit — the other
 *    suits are played to exhaustion first. Only when nothing but the
 *    already-takan'd suit remains may it be led again, and that repeat
 *    creates NO claim (the engine counts only a bot's FIRST takan of
 *    each suit per round — see game.js).
 *  - «13» POLICY (up46): a bot declares «13» ONLY on a PROVABLY clean
 *    call (counting: the suit's unseen = 0) and only when ending now
 *    is not worse for its team (captured ≤ the opponents'). Never on
 *    a guess — a wrong call hands the rivals one claim per held card
 *    against the bot's own team. See plan13.
 *
 * CARD COUNTING (up45, owner order 2026-11-12 «همه روبات ها را قوی
 * کن تا هیچ خطا نده»): the bot counts every card played this round
 * (the captured piles + the current trick are public) against its own
 * hand, so for each suit it knows exactly how many cards are still
 * UNSEEN — i.e. sitting in the other three hands:
 *   unseen = 13 − played − own.
 * Measured diagnosis first (400-match harness): EVERY bot takan was a
 * STRANDED endgame lead — the leader held no live suit at all, 87% of
 * them on tricks 12–13. The current lead itself is already made safe
 * by the live filter below; the winnable fight is over the bot's
 * FUTURE hand composition. So the count drives three things:
 *  - PROVABLY-DEAD SUITS (unseen = 0: played + own = 13, so NOBODY
 *    else can hold the suit) are hard-banned as leads while any other
 *    card exists — leading one is a guaranteed takan, never a gamble.
 *  - DYING-SUIT-FIRST leads and discards: a live suit down to its
 *    last few unseen cards (unseen ≤ DYING_UNSEEN) is about to strand
 *    this bot, so its cards are spent FIRST — led while leading them
 *    is still safe, shed first when discarding — instead of being
 *    kept in hand until they are the only thing left to lead.
 *    (A "most unseen first" lead order was measured and REJECTED: it
 *    preserves exactly those dying suits in hand and strands the bot
 *    more — 65.9 takans/100 rounds vs 61.1 for dying-first, same
 *    seeds; the untouched baseline was 65.1.)
 * The heuristic stays fully deterministic: no RNG anywhere below.
 */
const G = require('./game');

/** A live suit with at most this many unseen cards is "dying" for the
 *  bot holding it — spend/shed its cards before it strands the bot. */
const DYING_UNSEEN = 3;

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

/**
 * CARD COUNTING: per suit, how many cards have been PLAYED this round
 * (both captured piles + the current trick — all public), how many the
 * bot itself holds (own), and how many are therefore still UNSEEN in
 * the other three hands: unseen = 13 − played − own. unseen === 0
 * PROVES nobody else holds the suit (a lead of it is a certain takan).
 * Exported for sim's counting checks.
 */
function countSuits(round, seat) {
  const played = { H: 0, D: 0, C: 0, S: 0 };
  const tally = (cards) => { for (const c of cards) played[G.suitOf(c)]++; };
  const captured = round.captured || [[], []];
  tally(captured[0]); tally(captured[1]);
  for (const p of round.trick || []) played[G.suitOf(p.card)]++;
  const own = { H: 0, D: 0, C: 0, S: 0 };
  for (const c of round.hands[seat]) own[G.suitOf(c)]++;
  const info = {};
  for (const s of G.SUITS) {
    info[s] = { played: played[s], own: own[s], unseen: 13 - played[s] - own[s] };
  }
  return info;
}

/**
 * EARLY SHEDDING: pick which of `cards` to throw away — prefer the suit
 * that is dead or dying FOR THIS BOT (fewest unseen cards: the suit it
 * will soon be stranded holding alone); ties go to the suit it holds
 * MORE of (the bigger stranding risk). Within the chosen suit, shed
 * the highest rank (dead weight first), as before.
 * GATED mode (the partner-winning shed): the settled line there is the
 * highest dead card overall, so the dying-suit override applies only
 * when a suit really is dying (unseen ≤ DYING_UNSEEN).
 */
function shedCard(round, seat, cards, gated) {
  const info = countSuits(round, seat);
  const suits = [...new Set(cards.map((c) => G.suitOf(c)))];
  suits.sort((a, b) =>
    (info[a].unseen - info[b].unseen) || (info[b].own - info[a].own));
  if (gated && info[suits[0]].unseen > DYING_UNSEEN) return highestRank(cards);
  const suit = suits[0];
  return highestRank(cards.filter((c) => G.suitOf(c) === suit));
}

function pickLead(round, seat, legal) {
  // NO-REPEAT TAKAN LAW (absolute): suits this bot has already takan'd
  // this round are BANNED as leads while any card of another suit
  // remains in hand — no exceptions, no weighing. Only when the hand
  // holds nothing but banned suits does the ban lift (the forced
  // re-lead; it creates no claim — game.js counts first takans only).
  const banned = (round.takanSuits && round.takanSuits[seat]) || [];
  let base = legal;
  if (banned.length) {
    const other = legal.filter((c) => !banned.includes(G.suitOf(c)));
    if (other.length) base = other;
  }
  // CARD COUNTING hard ban: a PROVABLY-dead suit (played + own = 13 —
  // by counting, nobody else can hold it) is never led while any other
  // card remains. In real play this coincides with the othersVoidIn
  // filter below; it is stated in counting terms because the count is
  // what a strong player actually knows, and sim pins it directly.
  const info = countSuits(round, seat);
  const provable = base.filter((c) => info[G.suitOf(c)].unseen > 0);
  if (provable.length) base = provable;
  // A takan lead happens when nobody else holds the suit — AVOID those
  // suits now; a takan hands the opponents a pending claim on our bank,
  // and the uncontested trick comes back to us with everyone's dumps in it.
  const live = base.filter((c) => !round.othersVoidIn(G.suitOf(c), seat));
  const pool = live.length ? live : base;
  // Live suit: cheap non-scoring probe — scoring cards stay in hand,
  // waiting to be fed to the opponents.
  const nonScoring = pool.filter((c) => G.cardPoints(c) === 0);
  if (nonScoring.length) {
    if (live.length) {
      // DYING-SUIT-FIRST (counting): a live suit down to its last few
      // unseen cards is about to strand this bot — spend its cheap
      // probe NOW, while leading it is still safe, instead of keeping
      // it for the endgame. The threshold keeps ordinary play on the
      // settled cheapest-probe line below.
      const dying = [...new Set(nonScoring.map((c) => G.suitOf(c)))]
        .filter((s) => info[s].unseen <= DYING_UNSEEN)
        .sort((a, b) =>
          (info[a].unseen - info[b].unseen) || (info[a].own - info[b].own));
      if (dying.length) {
        return lowestRank(nonScoring.filter((c) => G.suitOf(c) === dying[0]));
      }
    }
    return lowestRank(nonScoring);
  }
  return cheapestGiveaway(pool);
}

/**
 * «13» PLAN (up46): on a LEAD, the card to declare «13» with — or
 * null to play normally. Declares ONLY when BOTH: PROVABLY CLEAN
 * (countSuits: a suit in hand with unseen === 0 — nobody else can
 * hold it; never a guess, a wrong call costs one claim per held
 * card) AND NOT WORSE (its team captured ≤ the opponents' tawan).
 * Card = cheapest giveaway among the dead suits. Deterministic.
 * (Hosts: on non-null, arm13 + play the card — the round ends.)
 */
function plan13(round, seat) {
  if (!round || round.finished || round.trick.length || round.turn !== seat) return null;
  const hand = round.hands[seat];
  if (!hand || !hand.length) return null;
  const info = countSuits(round, seat);
  const dead = hand.filter((c) => info[G.suitOf(c)].unseen === 0);
  if (!dead.length) return null;
  const captured = round.captured || [[], []];
  const myTeam = G.teamOf(seat);
  if (G.tawanOf(captured[myTeam]) > G.tawanOf(captured[1 - myTeam])) return null;
  return cheapestGiveaway(dead);
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

  // --- Void in the led suit: discard ---
  if (!legal.some((c) => G.suitOf(c) === ledSuit)) {
    if (partnerWinning) {
      // The points land with OUR team — NEVER feed tawan to partner:
      // shed dead weight, keep scoring cards for the opponents. EARLY
      // SHEDDING (counting, gated): when one of the dead cards belongs
      // to a suit that is dying for this bot, that card goes first, so
      // the bot is never left holding only a dead suit at the end.
      const deadCards = legal.filter((c) => G.cardPoints(c) === 0);
      if (deadCards.length) return shedCard(round, seat, deadCards, true);
      return cheapestGiveaway(legal); // forced: give away the cheapest points
    }
    // An opponent takes this trick: FEED them — the biggest tawan card
    // we hold lands in THEIR captured pile (Q♠ above all).
    const feed = biggestScoring(legal);
    if (feed) return feed;
    return shedCard(round, seat, legal); // nothing scoring: shed from a dying suit
  }

  // Following suit (legal = only led-suit cards here).
  const currentBest = Math.max(
    ...trick.filter((p) => G.suitOf(p.card) === ledSuit).map((p) => G.rankOf(p.card))
  );
  const winners = legal.filter((c) => G.rankOf(c) > currentBest);
  const losers = legal.filter((c) => G.rankOf(c) < currentBest);

  // --- Partner is winning: never overtake, never add tawan ---
  if (partnerWinning) {
    const safeLosers = losers.filter((c) => G.cardPoints(c) === 0);
    if (safeLosers.length) return lowestRank(safeLosers); // low safe card under the win
    if (losers.length) return cheapestGiveaway(losers);  // forced scoring loser: cheapest
    // Forced to overtake: cheapest SAFE winner so the trick stays ours
    // without adding new tawan.
    const safeWinners = winners.filter((c) => G.cardPoints(c) === 0);
    if (safeWinners.length) return lowestRank(safeWinners);
    return lowestRank(winners);
  }

  // --- Opponent is winning: duck under — and FEED the trick ---
  if (losers.length) {
    // Our biggest scoring loser lands in the OPPONENTS' captured pile.
    const feed = biggestScoring(losers);
    if (feed) return feed;
    return highestRank(losers); // duck under, shed the biggest dead card
  }

  // --- Forced to win: take it with the lowest sufficient card ---
  // (Clean or tawan trick alike — winning costs us the capture, so
  // spend the cheapest card that does it.)
  return lowestRank(winners);
}

module.exports = { chooseCard, plan13, countSuits };
