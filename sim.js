'use strict';
/**
 * TORE acceptance simulation — runs full bot-vs-bot matches through the
 * SAME game.js + bots.js the server uses, and checks every invariant from
 * TORE-PROMPT.md § Acceptance checks. Exit code is non-zero on any failure.
 *
 * Run:  node sim.js [matches]     (default 24 matches)
 */
const G = require('./game');
const bots = require('./bots');

const MATCHES = parseInt(process.argv[2] || '24', 10);
let failures = 0;
let checks = 0;

function check(ok, label, detail) {
  checks++;
  if (ok) {
    console.log('PASS  ' + label + (detail ? '  (' + detail + ')' : ''));
  } else {
    failures++;
    console.log('FAIL  ' + label + (detail ? '  (' + detail + ')' : ''));
  }
}

function playMatch(seed, stats) {
  const rng = G.seededRng(seed);
  const match = new G.Match(() => {}, rng);
  let bankRun = [0, 0]; // running tawan bank, mirrored against match history
  let safety = 0;
  while (!match.finished) {
    if (++safety > 500) throw new Error('match did not terminate');
    const round = match.startRound();

    // -- Acceptance 1: deck integrity & 13 cards each --
    const all = round.hands.flat();
    stats.rounds++;
    if (all.length !== 52 || new Set(all).size !== 52) stats.deckErrors++;
    if (!round.hands.every((h) => h.length === 13)) stats.dealErrors++;
    const deckSet = new Set(G.makeDeck());
    if (!all.every((c) => deckSet.has(c))) stats.deckErrors++;

    // -- Play the round with bots; any illegal play throws (Acceptance 2) --
    while (!round.finished) {
      const seat = round.turn;
      if (bots.maybeDeclare13(round, seat)) stats.declarations++;
      const card = bots.chooseCard(round, seat);
      if (!round.legalMovesFor(seat).includes(card)) stats.illegalBotPlays++;
      round.play(seat, card); // throws on illegality → caught by caller → FAIL
    }
    stats.takans += round.takanCount[0] + round.takanCount[1];
    if (round.result.transferred) stats.transfers++;

    // -- Piles: per-seat won tricks sum to 13 and match the captured piles --
    const pileSum = round.wonTricks.reduce((a, b) => a + b, 0);
    if (pileSum !== 13) stats.pileErrors++;
    if ((round.wonTricks[0] + round.wonTricks[2]) * 4 !== round.captured[0].length) stats.pileErrors++;
    if ((round.wonTricks[1] + round.wonTricks[3]) * 4 !== round.captured[1].length) stats.pileErrors++;

    // -- Acceptance 3: captured CARD tawan totals exactly 30 (pre-bonus) --
    const r = round.result;
    if (r.cardTawan[0] + r.cardTawan[1] !== 30) stats.tawanErrors++;
    const capturedCards = round.captured[0].length + round.captured[1].length;
    if (capturedCards !== 52) stats.captureErrors++;
    // Q♠ captor recorded consistently with the actual captured pile
    const qsTeamActual = round.captured[0].includes('QS') ? 0 : 1;
    if (qsTeamActual !== r.qsTeam) stats.qsErrors++;

    // -- Takan bookkeeping: bonus is exactly 30 × count, per team --
    if (r.takanBonus[0] !== 30 * r.takanCount[0] || r.takanBonus[1] !== 30 * r.takanCount[1]) {
      stats.takanErrors++;
    }
    // -- Takan givers recorded per team (summary names who gave the takan) --
    if (r.takanBy[0].length !== r.takanCount[0] || r.takanBy[1].length !== r.takanCount[1]) {
      stats.takanErrors++;
    }
    if (!r.takanBy.every((seats, t) => seats.every((s) => s % 2 === t))) stats.takanErrors++;

    // -- Tawan bank: final ≥ 10 banks fully, ≤ 9 wipes; bank accumulates --
    const bankBefore = bankRun.slice(); // pre-round banked mirror — the transfer gate's input
    const hLast = match.history[match.history.length - 1];
    const wantBanked = r.tawan.map((t) => (t >= G.TAWAN_BANK_MIN ? t : 0));
    if (hLast.banked[0] !== wantBanked[0] || hLast.banked[1] !== wantBanked[1]) stats.bankErrors++;
    bankRun = [bankRun[0] + wantBanked[0], bankRun[1] + wantBanked[1]];
    if (hLast.bankedTawan[0] !== bankRun[0] || hLast.bankedTawan[1] !== bankRun[1]) stats.bankErrors++;
    if (match.bankedTawan[0] !== bankRun[0] || match.bankedTawan[1] !== bankRun[1]) stats.bankErrors++;
    // -- Final tawan: transfer moves the whole pot to the single takan team,
    //    then the >21→30 bump rewrites any pre-bump final in 22..29 --
    const rawSum = r.cardTawan[0] + r.cardTawan[1] + r.takanBonus[0] + r.takanBonus[1];
    const preBump = r.transferred
      ? [0, 1].map((t) => (t === r.transferTo ? rawSum : 0))
      : [r.cardTawan[0] + r.takanBonus[0], r.cardTawan[1] + r.takanBonus[1]];
    const wantFinal = preBump.map((t) => (t > G.TAWAN_BUMP_LIMIT && t < G.TAWAN_BUMP_VALUE ? G.TAWAN_BUMP_VALUE : t));
    if (r.tawan[0] !== wantFinal[0] || r.tawan[1] !== wantFinal[1]) stats.bumpErrors++;
    const wantBumped = preBump.map((t) => t > G.TAWAN_BUMP_LIMIT && t < G.TAWAN_BUMP_VALUE);
    if (!r.bumped || r.bumped[0] !== wantBumped[0] || r.bumped[1] !== wantBumped[1]) stats.bumpErrors++;
    if (r.bumped && (r.bumped[0] || r.bumped[1])) stats.bumps++;
    if (r.transferred) {
      const other = 1 - r.transferTo;
      if (r.tawan[other] !== 0 || r.tawan[r.transferTo] !== rawSum) stats.transferErrors++;
      if (!(r.takanCount[r.transferTo] > 0 && r.takanCount[other] === 0)) stats.transferErrors++;
      if (r.transferBlocked) stats.transferErrors++;
    }
    // -- Transfer GATE: with exactly one takan team, the transfer fires iff
    //    the OTHER team's PRE-ROUND banked tawan (bankBefore mirror) reached
    //    TAKAN_TRANSFER_MIN_BANK; below it the takan stands but the pot
    //    stays split and the round is flagged transferBlocked. Both-takan
    //    and no-takan rounds are never gated. The gate fields must also
    //    reach the payload (history entry == roundResult) intact. --
    {
      const singleTakan = (r.takanCount[0] > 0) !== (r.takanCount[1] > 0);
      const takanTeam = r.takanCount[0] > 0 ? 0 : 1;
      const wantTransfer = singleTakan && bankBefore[1 - takanTeam] >= G.TAKAN_TRANSFER_MIN_BANK;
      if (r.transferred !== wantTransfer) stats.transferErrors++;
      if (!r.bankedBefore || r.bankedBefore[0] !== bankBefore[0] || r.bankedBefore[1] !== bankBefore[1]) stats.transferErrors++;
      if (!hLast.bankedBefore || hLast.bankedBefore[0] !== bankBefore[0] || hLast.bankedBefore[1] !== bankBefore[1]) stats.transferErrors++;
      if (hLast.transferBlocked !== r.transferBlocked) stats.transferErrors++;
      if (singleTakan && !wantTransfer) {
        if (r.transferBlocked !== true) stats.transferErrors++;
        if (r.transferGateBanked !== bankBefore[1 - takanTeam]) stats.transferErrors++;
        if (hLast.transferGateBanked !== r.transferGateBanked) stats.transferErrors++;
        stats.blockedTransfers++;
      } else if (r.transferBlocked) stats.transferErrors++;
    }

    // -- Acceptance 4: credits always 20/10; FEWER final tawan wins --
    const sorted = r.credits.slice().sort((a, b) => a - b);
    if (sorted[0] !== 10 || sorted[1] !== 20) stats.creditErrors++;
    if (r.tawan[0] === r.tawan[1]) {
      stats.ties++;
      if (r.winner !== 1 - r.qsTeam) stats.tieErrors++; // tie → Q♠ captor LOSES
      if (r.credits[r.qsTeam] !== 10) stats.tieErrors++;
      if (r.credits[1 - r.qsTeam] !== 20) stats.tieErrors++;
    } else if (r.winner !== (r.tawan[0] < r.tawan[1] ? 0 : 1)) {
      stats.winnerErrors++;
    }

    // -- Acceptance 5 (per-round part): above 210 the match may ONLY continue
    //    on an exact tie (spec DEFAULT edge rule); otherwise it must have ended.
    if (!match.finished && Math.max(...match.scores) >= 210 &&
        match.scores[0] !== match.scores[1]) stats.earlyEndErrors++;
    if (!match.finished && Math.max(...match.scores) >= 210) stats.extraRounds++;
  }

  // -- Acceptance 5: match ended exactly when a team reached ≥210 --
  if (Math.max(...match.scores) < 210) stats.lateEndErrors++;
  if (match.winner !== (match.scores[0] > match.scores[1] ? 0 : 1)) stats.matchWinnerErrors++;
  // Scores in history must be the running sum of credits.
  let run = [0, 0];
  for (const h of match.history) {
    run = [run[0] + h.credits[0], run[1] + h.credits[1]];
    if (run[0] !== h.scoresAfter[0] || run[1] !== h.scoresAfter[1]) stats.historyErrors++;
  }
  stats.roundsTotal += match.history.length;
  return match;
}

function main() {
  console.log('TORE sim — ' + MATCHES + ' full bot-vs-bot matches\n');

  // Scoring table unit check (spec § Scoring cards)
  check(G.TOTAL_TAWAN === 30, 'deck tawan totals exactly 30', 'TOTAL_TAWAN=' + G.TOTAL_TAWAN);
  check(G.cardPoints('AH') === 1 && G.cardPoints('2H') === 1, 'every لال (hearts) card = 1');
  check(G.cardPoints('JC') === 5, 'غلام پشه (J♣) = 5');
  check(G.cardPoints('QS') === 9, 'ماتکه کالا (Q♠) = 9');
  check(G.cardPoints('TD') === 3, 'ده خشت (10♦) = 3');
  check(G.cardPoints('AS') === 0 && G.cardPoints('KD') === 0 && G.cardPoints('QC') === 0,
    'non-scoring cards = 0');

  // Scoring direction — unit-tested directly (FEWER tawan wins the round;
  // flipped at the user's explicit order, 2026-11-05)
  const plain = G.scoreRound([10, 20], [0, 0], [0, 0], 0);
  check(plain.winner === 0 && plain.credits[0] === 20 && plain.credits[1] === 10,
    'fewer tawan wins: 10 vs 20 → the 10-team gets 20');
  const plain2 = G.scoreRound([20, 10], [0, 0], [0, 0], 1);
  check(plain2.winner === 1 && plain2.credits[1] === 20 && plain2.credits[0] === 10,
    'fewer tawan wins: 20 vs 10 → the 10-team gets 20');

  // Tie rule — on ANY final tie (incl. classic 15–15) the team that
  // CAPTURED Q♠ LOSES the tie: it gets the 10, the other team the 20.
  const tie0 = G.scoreRound([15, 15], [0, 0], [0, 0], 0);
  const tie1 = G.scoreRound([15, 15], [0, 0], [0, 0], 1);
  check(tie0.winner === 1 && tie0.credits[0] === 10 && tie0.credits[1] === 20,
    'tie 15–15, Q♠ with team 0 → captor (team 0) LOSES, gets 10');
  check(tie1.winner === 0 && tie1.credits[1] === 10 && tie1.credits[0] === 20,
    'tie 15–15, Q♠ with team 1 → captor (team 1) LOSES, gets 10');

  // Takan transfer — the user's example shape: totals 30 vs 10, the
  // 10-team holds the takan → finals 0 and 40, takan team's pot is FULL.
  const tr = G.scoreRound([30, 10], [0, 0], [0, 1], 0);
  check(tr.transferred === true && tr.transferTo === 1 &&
        tr.tawan[0] === 0 && tr.tawan[1] === 40,
    'transfer: 30 vs 10 with takan on the 10-team → finals 0 / 40');
  check(tr.winner === 0 && tr.credits[0] === 20 && tr.credits[1] === 10,
    'transfer: the takan team is stuck with 40 tawan → the OTHER team (0) wins the round 20');
  const trBoth = G.scoreRound([10, 10], [30, 30], [1, 1], 0);
  check(trBoth.transferred === false && trBoth.tawan[0] === 40 && trBoth.tawan[1] === 40,
    'both teams hold a takan → no transfer');
  const trNone = G.scoreRound([10, 20], [0, 0], [0, 0], 0);
  check(trNone.transferred === false && trNone.tawan[0] === 10 && trNone.tawan[1] === 20,
    'no takan → no transfer');

  // Transfer GATE (user rule): the transfer fires only when the NON-takan
  // team's PRE-ROUND banked tawan (جمع‌شده, the 5th argument) is ≥ 30.
  // (a) other team banked 29 → blocked: finals stay separate, the takan
  //     team keeps its card tawan + its +30 bonus, credits follow the
  //     FEWER final (48 vs 12 → the 12-team wins).
  const gate29 = G.scoreRound([18, 12], [30, 0], [1, 0], 0, [0, 29]);
  check(gate29.transferred === false && gate29.transferBlocked === true &&
        gate29.transferGateBanked === 29 && gate29.transferTo === null &&
        gate29.tawan[0] === 48 && gate29.tawan[1] === 12 &&
        gate29.winner === 1 && gate29.credits[0] === 10 && gate29.credits[1] === 20,
    'gate: other team banked 29 → NO transfer; finals stay 48/12 (bonus kept)');
  // The gate reads the OTHER team's banked — the takan team's own high
  // banked total does not unlock it.
  const gateOwn = G.scoreRound([18, 12], [30, 0], [1, 0], 0, [99, 5]);
  check(gateOwn.transferred === false && gateOwn.transferBlocked === true &&
        gateOwn.transferGateBanked === 5,
    'gate: takan team banked 99 but other team 5 → still blocked');
  // (b) other team banked exactly 30 → the transfer fires as before.
  const gate30 = G.scoreRound([18, 12], [30, 0], [1, 0], 0, [0, 30]);
  check(gate30.transferred === true && gate30.transferTo === 0 &&
        gate30.transferBlocked === false && gate30.transferGateBanked === null &&
        gate30.tawan[0] === 60 && gate30.tawan[1] === 0,
    'gate: other team banked exactly 30 → transfer fires (finals 60/0)');
  // (c) other team banked 45 → the transfer fires.
  const gate45 = G.scoreRound([20, 10], [0, 30], [0, 1], 1, [45, 7]);
  check(gate45.transferred === true && gate45.transferTo === 1 &&
        gate45.transferBlocked === false &&
        gate45.tawan[0] === 0 && gate45.tawan[1] === 60,
    'gate: other team banked 45 → transfer fires');
  // (d) both-takan and no-takan rounds are completely unaffected by the gate.
  const gateBoth = G.scoreRound([10, 10], [30, 30], [1, 1], 0, [0, 0]);
  check(gateBoth.transferred === false && gateBoth.transferBlocked === false &&
        gateBoth.tawan[0] === 40 && gateBoth.tawan[1] === 40,
    'gate: both teams hold a takan → unaffected (no transfer, no block)');
  const gateNone = G.scoreRound([10, 20], [0, 0], [0, 0], 0, [3, 4]);
  check(gateNone.transferred === false && gateNone.transferBlocked === false &&
        gateNone.tawan[0] === 10 && gateNone.tawan[1] === 20,
    'gate: no takan → unaffected');

  // Decisive scenario, re-pinned after the user's explicit flip order
  // (2026-11-05): round 1, card tawan 30 vs 0, NO takan — the bank still
  // shows the 30 for the team that took it, but the match score now goes
  // the other way: the 0-team (fewer tawan) gets the 20, the 30-team 10.
  const userScenario = G.scoreRound([30, 0], [0, 0], [0, 0], 0);
  check(userScenario.tawan[0] === 30 && userScenario.tawan[1] === 0 &&
        userScenario.winner === 1 && userScenario.credits[0] === 10 && userScenario.credits[1] === 20 &&
        userScenario.bumped[0] === false && userScenario.bumped[1] === false,
    'user scenario: card tawan 30 vs 0, no takan → credits 10/20 (fewer wins)');

  // Bump rule (user rule): a final tawan above 21 (and below 30) is written
  // as 30 — applied AFTER transfer, BEFORE credits and BEFORE the bank.
  const bump1 = G.scoreRound([24, 6], [0, 0], [0, 0], 0);
  check(bump1.tawan[0] === 30 && bump1.tawan[1] === 6 &&
        bump1.bumped[0] === true && bump1.bumped[1] === false &&
        bump1.winner === 1 && bump1.credits[0] === 10 && bump1.credits[1] === 20,
    'bump: finals 24/6 → written 30/6, credits follow the bumped finals (6 wins)');
  const bumpEdge = G.scoreRound([21, 9], [0, 0], [0, 0], 1);
  check(bumpEdge.tawan[0] === 21 && bumpEdge.bumped[0] === false && bumpEdge.bumped[1] === false,
    'bump: a final of exactly 21 is NOT bumped');
  const bump22 = G.scoreRound([22, 8], [0, 0], [0, 0], 1);
  check(bump22.tawan[0] === 30 && bump22.bumped[0] === true && bump22.bumped[1] === false,
    'bump: a final of 22 IS bumped to 30');
  const bumpHigh = G.scoreRound([20, 10], [0, 30], [0, 1], 0); // transfer → [0, 60]
  check(bumpHigh.tawan[1] === 60 && bumpHigh.bumped[1] === false,
    'bump: finals already ≥ 30 (takan transfer) stay as they are');

  // --- Constructed scenario: a void-suit LEAD is a takan (+30, count 1) ---
  {
    const evts = [];
    const round = new G.Round(0, (e) => evts.push(e), G.seededRng(7));
    // seat 0 holds ALL of قره (spades); the others hold one full suit each,
    // so nobody else can hold a spade when seat 0 leads one.
    round.hands = [
      G.makeDeck().filter((c) => G.suitOf(c) === 'S'),
      G.makeDeck().filter((c) => G.suitOf(c) === 'H'),
      G.makeDeck().filter((c) => G.suitOf(c) === 'D'),
      G.makeDeck().filter((c) => G.suitOf(c) === 'C'),
    ];
    check(round.canDeclare13(0) === false, 'no «۱۳» before the final trick');
    round.play(0, '2S');
    check(round.takanCount[0] === 1 && round.takanBonus[0] === 30 &&
          round.takanCount[1] === 0,
      'void-suit lead fires takan: +30 tawan, count 1 for the leader team');
    check(round.takanBy[0].length === 1 && round.takanBy[0][0] === 0 && round.takanBy[1].length === 0,
      'takan giver recorded (takanBy) for the round summary');
    check(evts.some((e) => e.type === 'takan' && e.seat === 0 && e.team === 0),
      'takan event emitted for clients');
  }

  // --- Constructed scenario: «۱۳» on the final trick cancels the takan ---
  function finalTrickRound() {
    const round = new G.Round(0, () => {}, G.seededRng(11));
    round.hands = [['AS'], ['KH'], ['QD'], ['JC']]; // only seat 0 holds قره
    round.captured = [[], []];
    round.tricksPlayed = 12;
    round.leader = 0; round.turn = 0;
    return round;
  }
  {
    const r = finalTrickRound();
    check(r.canDeclare13(0) === true, 'final trick, dead-suit card → «۱۳» available');
    r.declare13(0);
    r.play(0, 'AS'); r.play(1, 'KH'); r.play(2, 'QD'); r.play(3, 'JC');
    check(r.finished && r.takanCount[0] === 0 && r.takanCount[1] === 0 &&
          r.result.takanBonus[0] === 0,
      'declared «۱۳» → no takan, no +30');
  }
  {
    const r = finalTrickRound();
    r.play(0, 'AS'); r.play(1, 'KH'); r.play(2, 'QD'); r.play(3, 'JC');
    check(r.finished && r.takanCount[0] === 1 && r.result.takanBonus[0] === 30,
      'final trick WITHOUT «۱۳» → takan applies (+30)');
    check(r.wonTricks[0] === 1, 'won-trick pile credited to the trick winner');
  }
  {
    // «۱۳» must be rejected when someone else holds the led suit
    const round = new G.Round(0, () => {}, G.seededRng(13));
    round.hands = [['AS'], ['2S'], ['QD'], ['JC']];
    round.captured = [[], []];
    round.tricksPlayed = 12;
    let threw = false;
    check(round.canDeclare13(0) === false, '«۱۳» unavailable when the suit is not dead');
    try { round.declare13(0); } catch (e) { threw = true; }
    check(threw, 'declare13 throws when the situation does not allow it');
  }

  // --- Constructed scenario: transfer at Round level (finish path) ---
  {
    const round = new G.Round(0, () => {}, G.seededRng(17));
    round.hands = [['AS'], ['KH'], ['QD'], ['JC']];
    // card tawan: team 0 = 16 (13 hearts + 10♦), team 1 = 14 (J♣ + Q♠)
    round.captured = [
      G.makeDeck().filter((c) => G.suitOf(c) === 'H').concat(['TD']),
      ['JC', 'QS'],
    ];
    round.tricksPlayed = 12;
    round.takanCount = [1, 0];
    round.takanBonus = [30, 0];
    round.declare13(0); // keep the final AS lead from adding a second takan
    round.play(0, 'AS'); round.play(1, 'KH'); round.play(2, 'QD'); round.play(3, 'JC');
    // last trick adds KH(1) + JC(5) to team 0 → card 22 / 14, raw 52 / 14,
    // single takan on team 0 → ALL 66 dumped on team 0, team 1 = 0 → team 1
    // wins (penalty model: the takan team is stuck with the pot AND the 10).
    const r = round.result;
    check(r.transferred === true && r.transferTo === 0 &&
          r.tawan[0] === 66 && r.tawan[1] === 0,
      'round-level transfer: single-takan team is dumped with the whole pot');
    check(r.winner === 1 && r.credits[1] === 20 && r.credits[0] === 10,
      'round-level transfer: the takan team (66 tawan) gets the 10');
  }

  // --- Constructed scenarios: EXACT 15–15 tie through the real finish()
  // path (user's screenshot case, pinned). Credits must go AGAINST the
  // team that CAPTURED Q♠ (the captor LOSES the tie), and qsTeam must be
  // the CAPTURING team (the trick winner's team) — NEVER the team of the
  // player who played the card. ---
  {
    const HEARTS = G.makeDeck().filter((c) => G.suitOf(c) === 'H');
    // Pile-rig both ways: QS+JC+1 heart = 15 vs TD+12 hearts = 15.
    const rig = (qsCapturer) => {
      const round = new G.Round(0, () => {}, G.seededRng(101));
      const withQS = ['QS', 'JC', HEARTS[0]];
      const withoutQS = ['TD', ...HEARTS.slice(1)];
      round.captured = qsCapturer === 0 ? [withQS, withoutQS] : [withoutQS, withQS];
      round.takanCount = [0, 0]; round.takanBonus = [0, 0];
      round.finish();
      return round.result;
    };
    const t0 = rig(0);
    check(t0.cardTawan[0] === 15 && t0.cardTawan[1] === 15 &&
          t0.tawan[0] === 15 && t0.tawan[1] === 15 &&
          t0.qsTeam === 0 && t0.winner === 1 && t0.credits[0] === 10 && t0.credits[1] === 20,
      'round tie 15–15: Q♠ captured by team 0 → captor loses, credits [10,20]');
    const t1 = rig(1);
    check(t1.cardTawan[0] === 15 && t1.cardTawan[1] === 15 &&
          t1.tawan[0] === 15 && t1.tawan[1] === 15 &&
          t1.qsTeam === 1 && t1.winner === 0 && t1.credits[0] === 20 && t1.credits[1] === 10,
      'round tie 15–15: Q♠ captured by team 1 → captor loses, credits [20,10]');
    // The same result must reach the payload: Match history (== roundResult).
    const mTie = new G.Match(() => {}, G.seededRng(101));
    const rigRound = new G.Round(0, () => {}, G.seededRng(101));
    rigRound.captured = [['QS', 'JC', HEARTS[0]], ['TD', ...HEARTS.slice(1)]];
    rigRound.takanCount = [0, 0]; rigRound.takanBonus = [0, 0];
    rigRound.finish();
    mTie.onRoundFinished(rigRound);
    const hTie = mTie.history[mTie.history.length - 1];
    check(hTie.qsTeam === 0 && hTie.credits[0] === 10 && hTie.credits[1] === 20 &&
          hTie.tawan[0] === 15 && hTie.tawan[1] === 15,
      'tie 15–15 payload (roundResult): captor team 0 loses, credits [10,20]');

    // Played-by-A-captured-by-B, through real play(): the Q♠ player LOSES
    // the trick to the A♠ of the other team → the OTHER team is the captor.
    const cross = (leaderSeat, qsSeat, aceSeat, lastSeat) => {
      const round = new G.Round(leaderSeat, () => {}, G.seededRng(103));
      round.hands = [[], [], [], []];
      round.hands[leaderSeat] = ['2S'];
      round.hands[qsSeat] = ['QS'];
      round.hands[aceSeat] = ['AS'];
      round.hands[lastSeat] = ['3S'];
      for (let i = 0; i < 4; i++) {
        const s = (leaderSeat + i) % 4;
        round.play(s, round.hands[s][0]);
      }
      return round;
    };
    // Q♠ played by seat 1 (team 1), captured by seat 2 (team 0) via A♠.
    const c0 = cross(0, 1, 2, 3);
    check(c0.captured[0].includes('QS') && !c0.captured[1].includes('QS') &&
          c0.takanCount[0] === 0 && c0.takanCount[1] === 0,
      'Q♠ played by team 1 sits in TEAM 0\'s captured pile (trick winner)');
    c0.captured[0].push(...HEARTS.slice(0, 6));            // 9 + 6 = 15
    c0.captured[1].push('JC', 'TD', ...HEARTS.slice(6));   // 5 + 3 + 7 = 15
    c0.finish();
    check(c0.result.cardTawan[0] === 15 && c0.result.cardTawan[1] === 15 &&
          c0.result.qsTeam === 0 && c0.result.winner === 1 &&
          c0.result.credits[0] === 10 && c0.result.credits[1] === 20,
      'tie 15–15, Q♠ played by team 1: CAPTURING team 0 LOSES the tie (10)');
    // Q♠ played by seat 2 (team 0), captured by seat 3 (team 1) via A♠.
    const c1 = cross(1, 2, 3, 0);
    check(c1.captured[1].includes('QS') && !c1.captured[0].includes('QS') &&
          c1.takanCount[0] === 0 && c1.takanCount[1] === 0,
      'Q♠ played by team 0 sits in TEAM 1\'s captured pile (trick winner)');
    c1.captured[1].push('JC', HEARTS[0]);                  // 9 + 5 + 1 = 15
    c1.captured[0].push('TD', ...HEARTS.slice(1));         // 3 + 12 = 15
    c1.finish();
    check(c1.result.cardTawan[0] === 15 && c1.result.cardTawan[1] === 15 &&
          c1.result.qsTeam === 1 && c1.result.winner === 0 &&
          c1.result.credits[0] === 20 && c1.result.credits[1] === 10,
      'tie 15–15, Q♠ played by team 0: CAPTURING team 1 LOSES the tie (10)');
  }

  // --- Bot behaviour probes (AVOIDANCE + FEED THE OPPONENTS, user order
  // 2026-11-05): constructed mid-trick states, asserting the exact card
  // the bot heuristic must pick. ---
  {
    const midRound = (hands, trick, turnSeat, seed) => {
      const round = new G.Round(0, () => {}, G.seededRng(seed || 201));
      round.hands = hands;
      round.trick = trick;
      round.turn = turnSeat;
      round.leader = trick.length ? trick[0].seat : turnSeat;
      return round;
    };
    // FEED on discard: void in the led suit, an OPPONENT is winning →
    // the bot dumps its BIGGEST tawan card (Q♠) onto their trick.
    {
      const r = midRound(
        [[], [], ['QS', 'JC', '9D', '4S'], []],
        [{ seat: 1, card: 'AH' }], 2);
      check(bots.chooseCard(r, 2) === 'QS',
        'bot feed: void vs opponent win → dumps Q♠ (biggest tawan) on their trick');
    }
    // NEVER feed partner: void, PARTNER winning → shed a non-scoring
    // card even while holding Q♠ and J♣.
    {
      const r = midRound(
        [[], [], ['QS', 'JC', '9D', '4S'], []],
        [{ seat: 0, card: 'AH' }], 2);
      const pick = bots.chooseCard(r, 2);
      check(pick === '9D' && G.cardPoints(pick) === 0,
        'bot no-feed: void vs partner win → sheds a dead card, keeps Q♠/J♣');
    }
    // DUCK + FEED following suit: opponent winning a hearts trick, the
    // bot ducks with its small heart (feeding it to them), never the A♥.
    {
      const r = midRound(
        [[], [], ['2H', 'AH', '5C', '6C'], []],
        [{ seat: 1, card: 'QH' }], 2);
      check(bots.chooseCard(r, 2) === '2H',
        'bot duck+feed: following suit vs opponent win → small heart under, A♥ kept');
    }
    // The classic feed: Q♠ dumped UNDER an opponent's K♠.
    {
      const r = midRound(
        [['QS', 'AS', '4C', '5C'], [], [], []],
        [{ seat: 3, card: 'KS' }], 0);
      check(bots.chooseCard(r, 0) === 'QS',
        'bot feed: Q♠ goes under the opponent\'s K♠ instead of winning with A♠');
    }
    // Partner winning, following suit: never overtake — low safe card.
    {
      const r = midRound(
        [[], [], ['AH', '3H', '7C', '8C'], []],
        [{ seat: 0, card: 'KH' }, { seat: 1, card: '2H' }], 2);
      check(bots.chooseCard(r, 2) === '3H',
        'bot partner-safe: never overtakes partner — plays the low safe 3♥');
    }
    // Forced to take a tawan trick: lowest sufficient card wins it.
    {
      const r = midRound(
        [[], [], ['KH', 'AH', '7C', '8C'], []],
        [{ seat: 1, card: 'QH' }], 2);
      check(bots.chooseCard(r, 2) === 'KH',
        'bot forced win: takes the tawan trick with the LOWEST winning card (K♥, not A♥)');
    }
    // Lead: a dead-suit lead is a takan (+30 on OUR team) → the bot
    // leads a live non-scoring card instead of the dead spade.
    {
      const r = midRound(
        [['2S', '5D', '9D', '3C'], ['4H', '6D', '7C'], ['5H', '8D', '9C'], ['6H', 'TD', 'JC']],
        [], 0);
      const pick = bots.chooseCard(r, 0);
      check(pick === '3C' && G.suitOf(pick) !== 'S',
        'bot lead: avoids the dead-suit (takan) lead — cheap live card instead');
    }
    // «۱۳» stays human-only: even with a declaration available on the
    // final trick, the bot never declares.
    {
      const r = midRound([['AS'], ['KH'], ['QD'], ['JC']], [], 0);
      r.tricksPlayed = 12;
      check(r.canDeclare13(0) === true && bots.maybeDeclare13(r, 0) === false,
        'bot «۱۳»: never declares, even when a declaration is available');
    }
  }

  // Tawan bank — unit: ≤9 wipes, ≥10 banks fully, accumulates over rounds
  {
    const m = new G.Match(() => {}, G.seededRng(3));
    const fake = (tawan, credits) => ({ result: {
      cardTawan: [0, 0], takanBonus: [0, 0], takanCount: [0, 0], takanBy: [[], []],
      transferred: false, transferTo: null, tawan, qsTeam: 0,
      winner: tawan[0] < tawan[1] ? 0 : 1, credits } });
    m.onRoundFinished(fake([9, 21], [10, 20])); // team 0: 9 → wiped; team 1: 21 → banked
    check(m.bankedTawan[0] === 0 && m.bankedTawan[1] === 21 &&
          m.history[0].banked[0] === 0 && m.history[0].banked[1] === 21,
      'bank: a ≤9 round banks 0; a ≥10 round banks the full amount');
    m.onRoundFinished(fake([10, 35], [10, 20])); // 10 is the threshold → banks
    check(m.bankedTawan[0] === 10 && m.bankedTawan[1] === 56 &&
          m.history[1].bankedTawan[0] === 10 && m.history[1].bankedTawan[1] === 56,
      'bank: accumulates across two rounds (10 banks fully)');
    // Bump BEFORE bank: card tawan 24/6 is written 30/6 by scoreRound, so
    // the bank must receive 30 (not 24); the 6 still wipes (≤ 9).
    const bumpedRound = G.scoreRound([24, 6], [0, 0], [0, 0], 0);
    m.onRoundFinished({ result: {
      cardTawan: [24, 6], takanBonus: [0, 0], takanCount: [0, 0], takanBy: [[], []],
      transferred: false, transferTo: null, tawan: bumpedRound.tawan, bumped: bumpedRound.bumped,
      qsTeam: 0, winner: bumpedRound.winner, credits: bumpedRound.credits } });
    check(m.bankedTawan[0] === 40 && m.bankedTawan[1] === 56 &&
          m.history[2].banked[0] === 30 && m.history[2].banked[1] === 0 &&
          m.history[2].bumped[0] === true && m.history[2].bumped[1] === false,
      'bank: a bumped 30 banks as 30; the other team\'s 6 still wipes');
  }

  // Transfer gate at Match level: the pre-round banked snapshot must
  // thread from Match.startRound (bankedTawan BEFORE this round) into
  // scoring — this round's own tawan never counts toward its own gate.
  // Banking and credits then follow the (un-)transferred finals exactly.
  {
    const rigGateRound = (m) => {
      const round = m.startRound();
      // card tawan 20 vs 10 — team 0: QS(9)+JC(5)+TD(3)+3 hearts; team 1: 10 hearts
      const HEARTS = G.makeDeck().filter((c) => G.suitOf(c) === 'H');
      round.captured = [
        ['QS', 'JC', 'TD', ...HEARTS.slice(0, 3)],
        HEARTS.slice(3),
      ];
      round.takanCount = [1, 0]; // single takan, team 0
      round.takanBonus = [30, 0];
      round.takanBy = [[0], []];
      round.finish();
      return round.result;
    };
    // (a) other team enters the round banked at 29 → NO transfer: finals
    //     stay 50/10, both bank in full (≥ 10), credits follow the FEWER
    //     final (50 vs 10 → team 1 wins the round).
    const mA = new G.Match(() => {}, G.seededRng(5));
    mA.bankedTawan = [10, 29];
    const rA = rigGateRound(mA);
    const hA = mA.history[mA.history.length - 1];
    check(rA.transferred === false && rA.transferBlocked === true &&
          rA.transferGateBanked === 29 &&
          rA.bankedBefore[0] === 10 && rA.bankedBefore[1] === 29 &&
          rA.tawan[0] === 50 && rA.tawan[1] === 10 &&
          rA.winner === 1 && rA.credits[0] === 10 && rA.credits[1] === 20 &&
          hA.banked[0] === 50 && hA.banked[1] === 10 &&
          hA.transferBlocked === true && hA.transferGateBanked === 29 &&
          mA.bankedTawan[0] === 60 && mA.bankedTawan[1] === 39,
      'match gate: banked 29 entering → no transfer; bank/credits from the 50/10 finals');
    // (b) other team enters banked at exactly 30 → the transfer fires.
    const mB = new G.Match(() => {}, G.seededRng(5));
    mB.bankedTawan = [10, 30];
    const rB = rigGateRound(mB);
    check(rB.transferred === true && rB.transferTo === 0 &&
          rB.transferBlocked === false &&
          rB.tawan[0] === 60 && rB.tawan[1] === 0 &&
          mB.bankedTawan[0] === 70 && mB.bankedTawan[1] === 30,
      'match gate: banked exactly 30 entering → transfer fires (finals 60/0)');
  }

  // Match-edge rule (spec DEFAULT): both cross 210 same round
  check(G.decideMatch([215, 205]) === 0, 'both ≥210 → higher total wins (team 0)');
  check(G.decideMatch([205, 215]) === 1, 'both ≥210 → higher total wins (team 1)');
  check(G.decideMatch([210, 210]) === null, 'exact tie at 210 → extra round');
  check(G.decideMatch([200, 190]) === null, 'below 210 → match continues');
  check(G.decideMatch([210, 100]) === 0, 'single team at 210 → wins');

  const stats = {
    rounds: 0, deckErrors: 0, dealErrors: 0, illegalBotPlays: 0,
    tawanErrors: 0, captureErrors: 0, qsErrors: 0, creditErrors: 0,
    ties: 0, tieErrors: 0, winnerErrors: 0, earlyEndErrors: 0, extraRounds: 0,
    lateEndErrors: 0, matchWinnerErrors: 0, historyErrors: 0, roundsTotal: 0,
    takans: 0, declarations: 0, transfers: 0, blockedTransfers: 0,
    pileErrors: 0, takanErrors: 0, transferErrors: 0, bankErrors: 0,
    bumpErrors: 0, bumps: 0,
  };

  let thrown = null;
  for (let i = 0; i < MATCHES; i++) {
    try { playMatch(1000 + i * 77, stats); }
    catch (e) { thrown = e; break; }
  }
  check(!thrown, 'no illegal play / engine throw across all matches',
    thrown ? thrown.message : MATCHES + ' matches completed');
  check(stats.deckErrors === 0, 'every round: 52 unique cards from the standard deck',
    stats.rounds + ' rounds');
  check(stats.dealErrors === 0, 'every round: 13/13/13/13 dealt');
  check(stats.illegalBotPlays === 0, 'every bot move was in the legal set (follow-suit enforced)');
  check(stats.captureErrors === 0, 'every round: all 52 cards captured by the two teams');
  check(stats.tawanErrors === 0, 'every round: captured CARD tawan sums to exactly 30 (before bonuses)');
  check(stats.qsErrors === 0, 'ماتکه کالا (Q♠) captor team recorded correctly every round');
  check(stats.creditErrors === 0, 'every round: credits are always 20/10');
  check(stats.winnerErrors === 0, 'every non-tie round: winner = team with FEWER final tawan');
  check(stats.tieErrors === 0, 'every tied round: 20 went to the team that did NOT capture Q♠ (captor loses)',
    stats.ties + ' natural tie rounds occurred');
  check(stats.pileErrors === 0, 'every round: won-trick piles sum to 13 and match captured cards');
  check(stats.takanErrors === 0, 'every round: takan bonus is exactly 30 × takan count',
    stats.takans + ' takans, ' + stats.declarations + ' «۱۳» declarations in bot play');
  check(stats.transferErrors === 0, 'every round: transfer fires exactly when a single takan clears the pre-round bank gate',
    stats.transfers + ' transferred, ' + stats.blockedTransfers + ' gate-blocked rounds occurred');
  check(stats.bankErrors === 0, 'every round: tawan bank wipes ≤9, banks ≥10, and accumulates exactly');
  check(stats.bumpErrors === 0, 'every round: finals in 22..29 are written as 30 and bump flags are exact',
    stats.bumps + ' bumped team-rounds occurred');
  check(stats.earlyEndErrors === 0, 'above 210 the match continued ONLY on an exact tie (extra-round rule)',
    stats.extraRounds + ' extra rounds played');
  check(stats.lateEndErrors === 0, 'every match ended once a team reached ≥210');
  check(stats.matchWinnerErrors === 0, 'match winner always the higher total');
  check(stats.historyErrors === 0, 'round history scores are exact running sums');

  console.log('\n' + (checks - failures) + '/' + checks + ' checks passed · ' +
    stats.roundsTotal + ' rounds · ' + stats.ties + ' tie rounds · ' +
    (failures ? failures + ' FAILURES' : 'ALL GREEN'));
  process.exit(failures ? 1 : 0);
}

main();
