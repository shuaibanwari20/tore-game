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
  let pendingRun = [0, 0]; // running pending-takan claims, mirrored likewise
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

    // -- Tawan bank + PENDING TAKAN, mirrored exactly. Order per round:
    //    (1) the round's final tawan banks (≥10) or wipes (≤9);
    //    (2) claims are created — one per takan, only when EXACTLY ONE
    //        team gave takan(s) this round;
    //    (3) pending claims execute (team 0 first, then team 1): while a
    //        team holds claims and the VICTIM's banked total is ≥ 30,
    //        exactly 30 moves from the victim's bank to the holder's.
    //    The engine decides match end AFTER these executions. --
    const hLast = match.history[match.history.length - 1];
    const wantBanked = r.tawan.map((t) => (t >= G.TAWAN_BANK_MIN ? t : 0));
    if (hLast.banked[0] !== wantBanked[0] || hLast.banked[1] !== wantBanked[1]) stats.bankErrors++;
    const afterBank = [bankRun[0] + wantBanked[0], bankRun[1] + wantBanked[1]];
    const singleTakan = (r.takanCount[0] > 0) !== (r.takanCount[1] > 0);
    const wantCreated = [0, 1].map((t) => (singleTakan && r.takanCount[t] > 0 ? r.takanCount[t] : 0));
    const pend = [pendingRun[0] + wantCreated[0], pendingRun[1] + wantCreated[1]];
    const wantExecuted = [0, 0];
    for (const t of [0, 1]) {
      while (pend[t] > 0 && afterBank[1 - t] >= G.TAKAN_CLAIM_MIN_BANK) {
        afterBank[1 - t] -= G.TAKAN_CLAIM_AMOUNT;
        afterBank[t] += G.TAKAN_CLAIM_AMOUNT;
        pend[t]--;
        wantExecuted[t]++;
      }
    }
    bankRun = afterBank;
    pendingRun = pend;
    if (hLast.bankedTawan[0] !== bankRun[0] || hLast.bankedTawan[1] !== bankRun[1]) stats.bankErrors++;
    if (match.bankedTawan[0] !== bankRun[0] || match.bankedTawan[1] !== bankRun[1]) stats.bankErrors++;
    if (hLast.claimsCreated[0] !== wantCreated[0] || hLast.claimsCreated[1] !== wantCreated[1]) stats.pendingErrors++;
    if (hLast.claimsExecuted[0] !== wantExecuted[0] || hLast.claimsExecuted[1] !== wantExecuted[1]) stats.pendingErrors++;
    if (hLast.pendingTakan[0] !== pendingRun[0] || hLast.pendingTakan[1] !== pendingRun[1]) stats.pendingErrors++;
    if (match.pendingTakan[0] !== pendingRun[0] || match.pendingTakan[1] !== pendingRun[1]) stats.pendingErrors++;
    stats.claimsCreated += wantCreated[0] + wantCreated[1];
    stats.claimsExecuted += wantExecuted[0] + wantExecuted[1];
    // -- Final tawan: card tawan + takan bonus, then the >21→30 bump
    //    rewrites any pre-bump final in 22..29 (NO transfer anymore) --
    const preBump = [r.cardTawan[0] + r.takanBonus[0], r.cardTawan[1] + r.takanBonus[1]];
    const wantFinal = preBump.map((t) => (t > G.TAWAN_BUMP_LIMIT && t < G.TAWAN_BUMP_VALUE ? G.TAWAN_BUMP_VALUE : t));
    if (r.tawan[0] !== wantFinal[0] || r.tawan[1] !== wantFinal[1]) stats.bumpErrors++;
    const wantBumped = preBump.map((t) => t > G.TAWAN_BUMP_LIMIT && t < G.TAWAN_BUMP_VALUE);
    if (!r.bumped || r.bumped[0] !== wantBumped[0] || r.bumped[1] !== wantBumped[1]) stats.bumpErrors++;
    if (r.bumped && (r.bumped[0] || r.bumped[1])) stats.bumps++;

    // -- Acceptance 4: NO points anywhere — a round result (and its
    //    history entry) carries no credits and no round winner; a tied
    //    final tawan is just a tie. --
    if (r.credits !== undefined || r.winner !== undefined) stats.noPointsErrors++;
    if (hLast.credits !== undefined || hLast.winner !== undefined ||
        hLast.scoresAfter !== undefined) stats.noPointsErrors++;
    if (r.tawan[0] === r.tawan[1]) stats.ties++;

    // -- Acceptance 5 (per-round part): once a banked total is ≥ 210 the
    //    match may ONLY continue when BOTH totals are ≥ 210 AND exactly
    //    equal (no loser yet); any other crossing must have ended it. --
    if (!match.finished) {
      const bt = match.bankedTawan;
      const crossed = bt[0] >= G.BANK_LOSE_TARGET || bt[1] >= G.BANK_LOSE_TARGET;
      if (crossed && bt[0] !== bt[1]) stats.earlyEndErrors++;
      if (crossed && bt[0] === bt[1]) stats.extraRounds++;
    }
  }

  // -- Acceptance 5: the match ended exactly when a banked total crossed
  //    210, and the LOSER is the team with the HIGHER banked total. --
  if (Math.max(...match.bankedTawan) < G.BANK_LOSE_TARGET) stats.lateEndErrors++;
  if (match.loser !== (match.bankedTawan[0] > match.bankedTawan[1] ? 0 : 1)) stats.loserErrors++;
  if (match.winner !== 1 - match.loser) stats.loserErrors++;
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

  // No points (user order, 2026-11-05): scoreRound produces ONLY the
  // final tawan — no winner, no credits, whatever the split.
  const plain = G.scoreRound([10, 20], [0, 0], [0, 0]);
  check(plain.tawan[0] === 10 && plain.tawan[1] === 20 &&
        plain.winner === undefined && plain.credits === undefined,
    'no points: 10 vs 20 → finals stand as-is, no winner/credits');
  const plain2 = G.scoreRound([20, 10], [0, 0], [0, 0]);
  check(plain2.tawan[0] === 20 && plain2.tawan[1] === 10 &&
        plain2.winner === undefined && plain2.credits === undefined,
    'no points: 20 vs 10 → finals stand as-is, no winner/credits');

  // Tie rule — a tied final (incl. classic 15–15) is JUST a tie now:
  // both finals stand, Q♠ decides nothing, no winner is produced.
  const tie0 = G.scoreRound([15, 15], [0, 0], [0, 0]);
  check(tie0.tawan[0] === 15 && tie0.tawan[1] === 15 &&
        tie0.winner === undefined && tie0.credits === undefined,
    'tie 15–15 → just a tie (both bank their own 15), no winner');

  // NO round-tawan transfer anymore (replaced by pending bank claims):
  // scoreRound never moves one team's tawan to the other, takan or not.
  const tr = G.scoreRound([30, 10], [0, 30]);
  check(tr.tawan[0] === 30 && tr.tawan[1] === 40 && tr.transferred === undefined,
    'no transfer: a takan bonus just adds to its own team (30 / 10+30)');
  const trBoth = G.scoreRound([10, 10], [30, 30]);
  check(trBoth.tawan[0] === 40 && trBoth.tawan[1] === 40 && trBoth.transferred === undefined,
    'no transfer: both teams hold a takan → finals still stand separate');

  // PENDING TAKAN (تکان معلق — user rule, 2026-11-05): a takan creates a
  // claim of exactly 30 BANKED tawan against the other team. Claims are
  // evaluated at round end, AFTER that round's banking: while the holder
  // has claims and the victim's banked total is ≥ 30, one claim moves
  // exactly 30 from the victim's bank to the holder's. Otherwise the
  // claim stays pending (the ★ remains) into later rounds.
  {
    const fakeR = (tawan, takanCount) => ({ result: {
      cardTawan: [0, 0], takanBonus: takanCount.map((c) => c * 30), takanCount,
      takanBy: [[], []], tawan, qsTeam: 0 } });
    const lastH = (m) => m.history[m.history.length - 1];

    // (a) The user's core example: victim banked 0 → claim created, NO
    //     movement, star pending. Then victim at 20 → still nothing.
    //     Then the victim crosses ≥ 30 in a later round → exactly 30 moves.
    const mP = new G.Match(() => {}, G.seededRng(21));
    mP.onRoundFinished(fakeR([5, 5], [1, 0])); // both finals ≤9 wipe; team 0 takan
    check(lastH(mP).claimsCreated[0] === 1 && lastH(mP).claimsExecuted[0] === 0 &&
          mP.pendingTakan[0] === 1 && mP.pendingTakan[1] === 0 &&
          mP.bankedTawan[0] === 0 && mP.bankedTawan[1] === 0,
      'pending: victim banked 0 → claim created, no movement, ★ pending');
    mP.onRoundFinished(fakeR([0, 20], [0, 0])); // victim banks 20 → [0, 20]
    check(lastH(mP).claimsExecuted[0] === 0 && mP.pendingTakan[0] === 1 &&
          mP.bankedTawan[0] === 0 && mP.bankedTawan[1] === 20,
      'pending: victim banked 20 (< 30) → claim still pending, no movement');
    mP.onRoundFinished(fakeR([0, 15], [0, 0])); // victim banks 15 → 35, then claim fires
    check(lastH(mP).claimsExecuted[0] === 1 && mP.pendingTakan[0] === 0 &&
          mP.bankedTawan[0] === 30 && mP.bankedTawan[1] === 5,
      'pending: victim crosses ≥30 later → exactly 30 moves (35→5, holder 0→30)');

    // (b) Immediate execution: the victim is already ≥ 30 after banking
    //     in the very round the takan is earned.
    const mI = new G.Match(() => {}, G.seededRng(21));
    mI.bankedTawan = [50, 40];
    mI.onRoundFinished(fakeR([0, 0], [0, 1])); // team 1 takan vs team 0 (banked 50)
    check(lastH(mI).claimsCreated[1] === 1 && lastH(mI).claimsExecuted[1] === 1 &&
          mI.pendingTakan[1] === 0 &&
          mI.bankedTawan[0] === 20 && mI.bankedTawan[1] === 70,
      'pending: victim already ≥30 → claim executes the same round (50→20, holder 40→70)');

    // (c) Multiple claims drain one after another while the victim stays ≥ 30.
    const mM = new G.Match(() => {}, G.seededRng(21));
    mM.bankedTawan = [0, 95];
    mM.onRoundFinished(fakeR([0, 0], [2, 0])); // two takans by team 0
    check(lastH(mM).claimsCreated[0] === 2 && lastH(mM).claimsExecuted[0] === 2 &&
          mM.pendingTakan[0] === 0 &&
          mM.bankedTawan[0] === 60 && mM.bankedTawan[1] === 35,
      'pending: two claims vs banked 95 → both execute (95→35, holder +60)');

    // (d) Both teams takan in the same round → NO claims either way.
    const mBoth = new G.Match(() => {}, G.seededRng(21));
    mBoth.bankedTawan = [40, 40];
    mBoth.onRoundFinished(fakeR([0, 0], [1, 1]));
    check(lastH(mBoth).claimsCreated[0] === 0 && lastH(mBoth).claimsCreated[1] === 0 &&
          mBoth.pendingTakan[0] === 0 && mBoth.pendingTakan[1] === 0 &&
          mBoth.bankedTawan[0] === 40 && mBoth.bankedTawan[1] === 40,
      'pending: both-takan round → no claims created, banks untouched');

    // (e) Match end is checked AFTER executions: a pending claim can
    //     pull a crossed team back below 210 (no loser), and can push
    //     the claim HOLDER over 210 (the holder loses).
    const mE = new G.Match(() => {}, G.seededRng(21));
    mE.bankedTawan = [195, 20];
    mE.pendingTakan = [0, 1]; // team 1 holds a claim against team 0
    mE.onRoundFinished(fakeR([20, 15], [0, 0])); // banks → [215, 35]; execution → [185, 65]
    check(mE.bankedTawan[0] === 185 && mE.bankedTawan[1] === 65 &&
          mE.finished === false && mE.loser === null,
      'pending: execution before match-end — 215 pulled back to 185, match continues');
    const mE2 = new G.Match(() => {}, G.seededRng(21));
    mE2.bankedTawan = [180, 190];
    mE2.pendingTakan = [1, 0]; // team 0 holds a claim against team 1 (190)
    mE2.onRoundFinished(fakeR([0, 0], [0, 0])); // execution → [210, 160]
    check(mE2.bankedTawan[0] === 210 && mE2.bankedTawan[1] === 160 &&
          mE2.finished === true && mE2.loser === 0 && mE2.winner === 1,
      'pending: execution pushes the HOLDER to exactly 210 → the holder loses');
  }

  // Decisive scenario (2026-11-05): round 1, card tawan 30 vs 0, NO
  // takan — the 30 stands and banks for the team that took it; there is
  // no score going anywhere (match points removed at the user's order).
  const userScenario = G.scoreRound([30, 0], [0, 0], [0, 0]);
  check(userScenario.tawan[0] === 30 && userScenario.tawan[1] === 0 &&
        userScenario.winner === undefined && userScenario.credits === undefined &&
        userScenario.bumped[0] === false && userScenario.bumped[1] === false,
    'user scenario: card tawan 30 vs 0, no takan → finals 30/0 stand, no points');

  // Bump rule (user rule): a final tawan above 21 (and below 30) is written
  // as 30 — applied BEFORE the bank.
  const bump1 = G.scoreRound([24, 6], [0, 0]);
  check(bump1.tawan[0] === 30 && bump1.tawan[1] === 6 &&
        bump1.bumped[0] === true && bump1.bumped[1] === false,
    'bump: finals 24/6 → written 30/6 (before the bank)');
  const bumpEdge = G.scoreRound([21, 9], [0, 0]);
  check(bumpEdge.tawan[0] === 21 && bumpEdge.bumped[0] === false && bumpEdge.bumped[1] === false,
    'bump: a final of exactly 21 is NOT bumped');
  const bump22 = G.scoreRound([22, 8], [0, 0]);
  check(bump22.tawan[0] === 30 && bump22.bumped[0] === true && bump22.bumped[1] === false,
    'bump: a final of 22 IS bumped to 30');
  const bumpHigh = G.scoreRound([20, 10], [40, 0]); // raw 60/10 via a takan bonus
  check(bumpHigh.tawan[0] === 60 && bumpHigh.bumped[0] === false,
    'bump: finals already ≥ 30 (takan bonus) stay as they are');

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

  // --- Constructed scenario: single takan at Round level (finish path).
  // There is NO round-level transfer anymore: the raw finals stand and
  // the takan becomes a pending BANK claim only at Match level. ---
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
    // last trick adds KH(1) + JC(5) to team 0 → card 22 / 14, raw 52 / 14.
    // Nothing moves between teams at round level.
    const r = round.result;
    check(r.tawan[0] === 52 && r.tawan[1] === 14 && r.transferred === undefined,
      'round-level: single takan → raw finals stand (52/14), no transfer');
    check(r.winner === undefined && r.credits === undefined,
      'round-level: no points either — just the two finals');
  }

  // --- Pending claims from REAL rounds: a declared «۱۳» creates NO
  // claim; the same final trick WITHOUT the declaration creates one,
  // and it executes at once because the victim is already ≥ 30. ---
  {
    const rigFinal = (declare) => {
      const round = new G.Round(0, () => {}, G.seededRng(11));
      round.hands = [['AS'], ['KH'], ['QD'], ['JC']]; // only seat 0 holds قره
      round.captured = [[], []];
      round.tricksPlayed = 12;
      round.leader = 0; round.turn = 0;
      if (declare) round.declare13(0);
      round.play(0, 'AS'); round.play(1, 'KH'); round.play(2, 'QD'); round.play(3, 'JC');
      return round;
    };
    const mDecl = new G.Match(() => {}, G.seededRng(21));
    mDecl.bankedTawan = [0, 40];
    mDecl.onRoundFinished(rigFinal(true));
    check(mDecl.pendingTakan[0] === 0 && mDecl.pendingTakan[1] === 0 &&
          mDecl.history[0].claimsCreated[0] === 0,
      'pending: «۱۳»-declared final trick → takan cancelled, NO claim created');
    const mNoDecl = new G.Match(() => {}, G.seededRng(21));
    mNoDecl.bankedTawan = [0, 40];
    mNoDecl.onRoundFinished(rigFinal(false));
    // round final: team 0 = 6 card + 30 bonus = 36 → banks 36; victim
    // team 1 sits at 40 ≥ 30 → the new claim executes immediately.
    check(mNoDecl.history[0].claimsCreated[0] === 1 &&
          mNoDecl.history[0].claimsExecuted[0] === 1 &&
          mNoDecl.pendingTakan[0] === 0 &&
          mNoDecl.bankedTawan[0] === 66 && mNoDecl.bankedTawan[1] === 10,
      'pending: undeclared takan vs banked 40 → claim created AND executed (36+30 / 40−30)');
  }

  // --- Constructed scenarios: EXACT 15–15 tie through the real finish()
  // path (user's screenshot case, pinned). A tie is JUST a tie now —
  // both teams bank their own 15 and no winner/credits exist — and
  // qsTeam must still be the CAPTURING team (the trick winner's team),
  // NEVER the team of the player who played the card. ---
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
          t0.qsTeam === 0 && t0.winner === undefined && t0.credits === undefined,
      'round tie 15–15 (Q♠ with team 0) → just a tie, no winner, no points');
    const t1 = rig(1);
    check(t1.cardTawan[0] === 15 && t1.cardTawan[1] === 15 &&
          t1.tawan[0] === 15 && t1.tawan[1] === 15 &&
          t1.qsTeam === 1 && t1.winner === undefined && t1.credits === undefined,
      'round tie 15–15 (Q♠ with team 1) → just a tie, no winner, no points');
    // The same result must reach the payload: Match history (== roundResult).
    const mTie = new G.Match(() => {}, G.seededRng(101));
    const rigRound = new G.Round(0, () => {}, G.seededRng(101));
    rigRound.captured = [['QS', 'JC', HEARTS[0]], ['TD', ...HEARTS.slice(1)]];
    rigRound.takanCount = [0, 0]; rigRound.takanBonus = [0, 0];
    rigRound.finish();
    mTie.onRoundFinished(rigRound);
    const hTie = mTie.history[mTie.history.length - 1];
    check(hTie.qsTeam === 0 && hTie.credits === undefined && hTie.winner === undefined &&
          hTie.banked[0] === 15 && hTie.banked[1] === 15 &&
          hTie.tawan[0] === 15 && hTie.tawan[1] === 15,
      'tie 15–15 payload (roundResult): both teams bank their own 15, no credits');

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
          c0.result.qsTeam === 0 && c0.result.winner === undefined &&
          c0.result.credits === undefined,
      'tie 15–15, Q♠ played by team 1: CAPTURING team 0 recorded — still just a tie');
    // Q♠ played by seat 2 (team 0), captured by seat 3 (team 1) via A♠.
    const c1 = cross(1, 2, 3, 0);
    check(c1.captured[1].includes('QS') && !c1.captured[0].includes('QS') &&
          c1.takanCount[0] === 0 && c1.takanCount[1] === 0,
      'Q♠ played by team 0 sits in TEAM 1\'s captured pile (trick winner)');
    c1.captured[1].push('JC', HEARTS[0]);                  // 9 + 5 + 1 = 15
    c1.captured[0].push('TD', ...HEARTS.slice(1));         // 3 + 12 = 15
    c1.finish();
    check(c1.result.cardTawan[0] === 15 && c1.result.cardTawan[1] === 15 &&
          c1.result.qsTeam === 1 && c1.result.winner === undefined &&
          c1.result.credits === undefined,
      'tie 15–15, Q♠ played by team 0: CAPTURING team 1 recorded — still just a tie');
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
    const fake = (tawan) => ({ result: {
      cardTawan: [0, 0], takanBonus: [0, 0], takanCount: [0, 0], takanBy: [[], []],
      tawan, qsTeam: 0 } });
    m.onRoundFinished(fake([9, 21])); // team 0: 9 → wiped; team 1: 21 → banked
    check(m.bankedTawan[0] === 0 && m.bankedTawan[1] === 21 &&
          m.history[0].banked[0] === 0 && m.history[0].banked[1] === 21,
      'bank: a ≤9 round banks 0; a ≥10 round banks the full amount');
    m.onRoundFinished(fake([10, 35])); // 10 is the threshold → banks
    check(m.bankedTawan[0] === 10 && m.bankedTawan[1] === 56 &&
          m.history[1].bankedTawan[0] === 10 && m.history[1].bankedTawan[1] === 56,
      'bank: accumulates across two rounds (10 banks fully)');
    // Bump BEFORE bank: card tawan 24/6 is written 30/6 by scoreRound, so
    // the bank must receive 30 (not 24); the 6 still wipes (≤ 9).
    const bumpedRound = G.scoreRound([24, 6], [0, 0]);
    m.onRoundFinished({ result: {
      cardTawan: [24, 6], takanBonus: [0, 0], takanCount: [0, 0], takanBy: [[], []],
      tawan: bumpedRound.tawan, bumped: bumpedRound.bumped,
      qsTeam: 0 } });
    check(m.bankedTawan[0] === 40 && m.bankedTawan[1] === 56 &&
          m.history[2].banked[0] === 30 && m.history[2].banked[1] === 0 &&
          m.history[2].bumped[0] === true && m.history[2].bumped[1] === false,
      'bank: a bumped 30 banks as 30; the other team\'s 6 still wipes');
  }

  // Match-end rule (user order): a banked total reaching 210 LOSES.
  check(G.decideMatchLoser([215, 205]) === 0, 'both ≥210 → the HIGHER banked total loses (team 0)');
  check(G.decideMatchLoser([205, 215]) === 1, 'both ≥210 → the HIGHER banked total loses (team 1)');
  check(G.decideMatchLoser([210, 210]) === null, 'both at exactly 210, equal → no loser yet, another round');
  check(G.decideMatchLoser([250, 250]) === null, 'both above 210 but exactly equal → no loser yet');
  check(G.decideMatchLoser([200, 190]) === null, 'below 210 → match continues');
  check(G.decideMatchLoser([210, 100]) === 0, 'single team at 210 → THAT team loses');
  check(G.decideMatchLoser([100, 210]) === 1, 'single team at 210 → THAT team loses (team 1)');

  // Match end-to-end (bank → loser), via onRoundFinished with rigged rounds.
  {
    const fake = (tawan) => ({ result: {
      cardTawan: [0, 0], takanBonus: [0, 0], takanCount: [0, 0], takanBy: [[], []],
      tawan, qsTeam: 0 } });
    const evtsA = [];
    const mA = new G.Match((e) => evtsA.push(e), G.seededRng(9));
    mA.bankedTawan = [200, 100];
    mA.onRoundFinished(fake([15, 12])); // banks → [215, 112]: only team 0 crossed
    check(mA.finished === true && mA.loser === 0 && mA.winner === 1 &&
          mA.bankedTawan[0] === 215 && mA.bankedTawan[1] === 112,
      'match end: banked 215 vs 112 → team 0 (≥210) LOSES, team 1 wins');
    const fin = evtsA.find((e) => e.type === 'matchFinished');
    check(!!fin && fin.loser === 0 && fin.winner === 1 &&
          fin.bankedTawan[0] === 215 && fin.bankedTawan[1] === 112,
      'matchFinished event carries winner, loser and the banked totals');
    const mB = new G.Match(() => {}, G.seededRng(9));
    mB.bankedTawan = [205, 200];
    mB.onRoundFinished(fake([10, 25])); // banks → [215, 225]: both crossed, higher loses
    check(mB.finished === true && mB.loser === 1 && mB.winner === 0,
      'match end: both cross in one round (215 vs 225) → the HIGHER total (team 1) loses');
    const mC = new G.Match(() => {}, G.seededRng(9));
    mC.bankedTawan = [200, 200];
    mC.onRoundFinished(fake([15, 15])); // banks → [215, 215]: equal → play on
    check(mC.finished === false && mC.loser === null && mC.winner === null,
      'match end: both cross at EXACTLY equal totals (215/215) → no loser yet');
    mC.onRoundFinished(fake([10, 20])); // banks → [225, 235]: now team 1 is higher
    check(mC.finished === true && mC.loser === 1 && mC.winner === 0,
      'match end: after the extra round, the higher total (team 1) loses');
  }

  const stats = {
    rounds: 0, deckErrors: 0, dealErrors: 0, illegalBotPlays: 0,
    tawanErrors: 0, captureErrors: 0, qsErrors: 0, noPointsErrors: 0,
    ties: 0, earlyEndErrors: 0, extraRounds: 0,
    lateEndErrors: 0, loserErrors: 0, roundsTotal: 0,
    takans: 0, declarations: 0, claimsCreated: 0, claimsExecuted: 0,
    pileErrors: 0, takanErrors: 0, pendingErrors: 0, bankErrors: 0,
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
  check(stats.noPointsErrors === 0, 'every round: no credits, no round winner, no points totals anywhere',
    stats.ties + ' natural tie rounds occurred');
  check(stats.pileErrors === 0, 'every round: won-trick piles sum to 13 and match captured cards');
  check(stats.takanErrors === 0, 'every round: takan bonus is exactly 30 × takan count',
    stats.takans + ' takans, ' + stats.declarations + ' «۱۳» declarations in bot play');
  check(stats.pendingErrors === 0, 'every round: pending takan — claims only from a single-takan round, executions move exactly 30 while the victim bank is ≥30',
    stats.claimsCreated + ' claims created, ' + stats.claimsExecuted + ' executed in bot play');
  check(stats.bankErrors === 0, 'every round: tawan bank wipes ≤9, banks ≥10, and accumulates exactly');
  check(stats.bumpErrors === 0, 'every round: finals in 22..29 are written as 30 and bump flags are exact',
    stats.bumps + ' bumped team-rounds occurred');
  check(stats.earlyEndErrors === 0, 'a crossed bank (≥210) continued ONLY when both totals were exactly equal',
    stats.extraRounds + ' extra rounds played');
  check(stats.lateEndErrors === 0, 'every match ended once a banked total reached ≥210');
  check(stats.loserErrors === 0, 'match loser is always the team with the HIGHER banked total; winner is the other team');

  console.log('\n' + (checks - failures) + '/' + checks + ' checks passed · ' +
    stats.roundsTotal + ' rounds · ' + stats.ties + ' tie rounds · ' +
    (failures ? failures + ' FAILURES' : 'ALL GREEN'));
  process.exit(failures ? 1 : 0);
}

main();
