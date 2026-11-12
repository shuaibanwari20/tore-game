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
  match.botSeats = [true, true, true, true]; // sim matches are all-bot: the BOT NO-REPEAT LAW applies to every seat
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
      // Mirror the server's bot flow (up46): when the bot's «13» plan
      // fires, it arms the declaration and leads the planned card at
      // once — the lead resolves the declaration and ends the round.
      // A bot declaration must ALWAYS be provably clean (count 0) and
      // no-worse for its team; anything else is an engine/bot error.
      const plan = bots.plan13(round, seat);
      if (plan) {
        stats.declarations++;
        const capBefore = [G.tawanOf(round.captured[0]), G.tawanOf(round.captured[1])];
        round.arm13(seat);
        round.play(seat, plan);
        if (!round.finished || !round.result.thirteen || round.result.thirteen.count !== 0) {
          stats.thirteenErrors++;
        }
        if (capBefore[G.teamOf(seat)] > capBefore[1 - G.teamOf(seat)]) stats.thirteenErrors++;
        continue;
      }
      const card = bots.chooseCard(round, seat);
      if (!round.legalMovesFor(seat).includes(card)) stats.illegalBotPlays++;
      // -- up45 counting invariant: on a LEAD, the chosen suit is never
      //    PROVABLY dead (count: played + own = 13 → unseen 0) while the
      //    bot holds any card of a suit that is not provably dead. --
      if (!round.trick.length) {
        const info = bots.countSuits(round, seat);
        if (info[G.suitOf(card)].unseen === 0 &&
            round.legalMovesFor(seat).some((c) => info[G.suitOf(c)].unseen > 0)) {
          stats.deadLeadErrors++;
        }
      }
      round.play(seat, card); // throws on illegality → caught by caller → FAIL
    }
    stats.takans += round.takanCount[0] + round.takanCount[1];

    // -- Piles: per-seat won tricks sum to the tricks actually played
    //    (13 in a full round; fewer when a «13» ended it early) and
    //    match the captured piles --
    const pileSum = round.wonTricks.reduce((a, b) => a + b, 0);
    if (pileSum !== round.tricksPlayed) stats.pileErrors++;
    if ((round.wonTricks[0] + round.wonTricks[2]) * 4 !== round.captured[0].length) stats.pileErrors++;
    if ((round.wonTricks[1] + round.wonTricks[3]) * 4 !== round.captured[1].length) stats.pileErrors++;

    // -- Acceptance 3: captured CARD tawan totals exactly 30 in a full
    //    round (a takan adds none). A «13»-ended round banks only what
    //    was captured — captured + still-unplayed must still total 30. --
    const r = round.result;
    if (r.thirteen) {
      stats.thirteenRounds++;
      const rest = round.hands.flat().concat([r.thirteen.card]);
      if (r.cardTawan[0] + r.cardTawan[1] + G.tawanOf(rest) !== 30) stats.tawanErrors++;
    } else if (r.cardTawan[0] + r.cardTawan[1] !== 30) stats.tawanErrors++;
    const capturedCards = round.captured[0].length + round.captured[1].length;
    if (capturedCards !== round.tricksPlayed * 4) stats.captureErrors++;
    // Q♠ captor recorded consistently with the actual captured pile
    const qsTeamActual = round.captured[0].includes('QS') ? 0 : 1;
    if (qsTeamActual !== r.qsTeam) stats.qsErrors++;

    // -- Takan bookkeeping (2026-11-06 model): a takan adds ZERO round
    //    tawan — no takanBonus field may exist on the result (the history
    //    entry is checked the same way below); the finals are checked
    //    against card tawan alone. --
    if (r.takanBonus !== undefined) {
      stats.takanErrors++;
    }
    // -- Takan givers recorded per team (summary names who gave the takan) --
    if (r.takanBy[0].length !== r.takanCount[0] || r.takanBy[1].length !== r.takanCount[1]) {
      stats.takanErrors++;
    }
    if (!r.takanBy.every((seats, t) => seats.every((s) => s % 2 === t))) stats.takanErrors++;

    // -- Tawan bank + PENDING TAKAN, mirrored exactly. Order per round:
    //    (1) the round's final tawan banks by the ten-bands (بندهای
    //        ده‌تایی); on an exact 15–15 tie the Q♠ captor banks 20;
    //    (2) claims are created — takans first cancel PAIRWISE across
    //        the teams («تکان با تکان ادا می‌شود»), so a team creates
    //        claims only for its SURPLUS takans:
    //        created[t] = max(0, count[t] − count[1−t]);
    //        PLUS (up46) a wrong «13» adds its penalty claims to the
    //        DECLARING team's OWN pool with NO cancellation;
    //    (3) pending claims execute (team 0 first, then team 1): while a
    //        team holds claims and the VICTIM's banked total is ≥ 30,
    //        exactly 30 moves from the victim's bank to the holder's.
    //    The engine decides match end AFTER these executions. --
    const hLast = match.history[match.history.length - 1];
    if (hLast.takanBonus !== undefined) stats.takanErrors++;
    const wantBoost = (r.tawan[0] === 15 && r.tawan[1] === 15) ? r.qsTeam : -1;
    const wantBanked = r.tawan.map((t, i) => (i === wantBoost ? 20 : G.bankAmount(t)));
    if (hLast.banked[0] !== wantBanked[0] || hLast.banked[1] !== wantBanked[1]) stats.bankErrors++;
    if (hLast.qsTieBoost !== wantBoost) stats.bankErrors++;
    if (r.bumped !== undefined || hLast.bumped !== undefined) stats.bankErrors++;
    const afterBank = [bankRun[0] + wantBanked[0], bankRun[1] + wantBanked[1]];
    const wantCancelled = Math.min(r.takanCount[0], r.takanCount[1]);
    const wantCreated = [0, 1].map((t) => Math.max(0, r.takanCount[t] - r.takanCount[1 - t]));
    if (hLast.takanCancelled !== wantCancelled) stats.pendingErrors++;
    // up46: a WRONG «13» adds its penalty claims to the DECLARING
    // team's OWN pool — no pairwise cancellation — before the
    // execution loop (they execute against the OPPONENTS' bank).
    const wantPenalty = r.thirteen && r.thirteen.count > 0 ? r.thirteen.count : 0;
    if (hLast.thirteenPenalty !== wantPenalty) stats.pendingErrors++;
    if ((hLast.thirteen ? hLast.thirteen.count : null) !== (r.thirteen ? r.thirteen.count : null)) stats.pendingErrors++;
    stats.thirteenPenalty += wantPenalty;
    const pend = [pendingRun[0] + wantCreated[0], pendingRun[1] + wantCreated[1]];
    if (wantPenalty) pend[r.thirteen.team] += wantPenalty;
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
    // -- Final tawan: EXACTLY the card tawan (a takan adds nothing and
    //    nothing rewrites it — the old bump is gone; banding is bank-only) --
    if (r.tawan[0] !== r.cardTawan[0] || r.tawan[1] !== r.cardTawan[1]) stats.bandErrors++;
    if (wantBoost >= 0) stats.tieBoosts++;

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

async function main() {
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
  const plain = G.scoreRound([10, 20]);
  check(plain.tawan[0] === 10 && plain.tawan[1] === 20 &&
        plain.winner === undefined && plain.credits === undefined,
    'no points: 10 vs 20 → finals stand as-is, no winner/credits');
  const plain2 = G.scoreRound([20, 10]);
  check(plain2.tawan[0] === 20 && plain2.tawan[1] === 10 &&
        plain2.winner === undefined && plain2.credits === undefined,
    'no points: 20 vs 10 → finals stand as-is, no winner/credits');

  // Tie rule — a tied final (incl. classic 15–15) produces no winner and
  // no points: both finals stand at 15. (The Q♠ bank boost applies later,
  // at Match banking time — pinned in the Match-level checks below.)
  const tie0 = G.scoreRound([15, 15]);
  check(tie0.tawan[0] === 15 && tie0.tawan[1] === 15 &&
        tie0.winner === undefined && tie0.credits === undefined,
    'tie 15–15 → just a tie (both bank their own 15), no winner');

  // NO round-tawan transfer and NO takan bonus (2026-11-06 model):
  // scoreRound takes card tawan alone — a round's finals are exactly the
  // captured-card tawan (plus the bump), whatever takans happened.
  const tr = G.scoreRound([30, 10]);
  check(tr.tawan[0] === 30 && tr.tawan[1] === 10 && tr.transferred === undefined,
    'card-only: finals are the captured-card tawan, nothing added or moved');
  const trBoth = G.scoreRound([10, 10]);
  check(trBoth.tawan[0] === 10 && trBoth.tawan[1] === 10 && trBoth.transferred === undefined,
    'card-only: equal card tawan → equal finals stand separate');

  // PENDING TAKAN (تکان معلق — user rule, 2026-11-05): a takan creates a
  // claim of exactly 30 BANKED tawan against the other team. Claims are
  // evaluated at round end, AFTER that round's banking: while the holder
  // has claims and the victim's banked total is ≥ 30, one claim moves
  // exactly 30 from the victim's bank to the holder's. Otherwise the
  // claim stays pending (the ★ remains) into later rounds.
  // PAIRWISE CANCELLATION (user rule «تکان با تکان ادا می‌شود»,
  // 2026-11-06): when both teams takan in one round, the takans cancel
  // one-for-one BEFORE any claim is created — only the surplus counts.
  {
    const fakeR = (tawan, takanCount) => ({ result: {
      cardTawan: [0, 0], takanCount,
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
    mP.onRoundFinished(fakeR([0, 15], [0, 0])); // victim's 15 bands to 10 → bank 30, claim fires
    check(lastH(mP).claimsExecuted[0] === 1 && mP.pendingTakan[0] === 0 &&
          mP.bankedTawan[0] === 30 && mP.bankedTawan[1] === 0,
      'pending: victim crosses ≥30 later → exactly 30 moves (30→0, holder 0→30)');

    // (b) Immediate execution: the victim is already ≥ 30 after banking
    //     in the very round the takan is earned.
    const mI = new G.Match(() => {}, G.seededRng(21));
    mI.bankedTawan = [50, 40];
    mI.onRoundFinished(fakeR([0, 0], [0, 1])); // team 1 takan vs team 0 (banked 50)
    check(lastH(mI).claimsCreated[1] === 1 && lastH(mI).claimsExecuted[1] === 1 &&
          mI.pendingTakan[1] === 0 &&
          mI.bankedTawan[0] === 20 && mI.bankedTawan[1] === 70,
      'pending: victim already ≥30 → claim executes the same round (50→20, holder 40→70)');

    // (b2) Same-round execution via THIS round's banking: the victim sits
    //     at 20 (< 30) before the round; the round banks them +15 → 35,
    //     and the claim created by this round's takan fires at once.
    const mI2 = new G.Match(() => {}, G.seededRng(21));
    mI2.bankedTawan = [0, 20];
    mI2.onRoundFinished(fakeR([0, 15], [1, 0])); // team 0 takan; victim's 15 bands to 10 → bank 30
    check(lastH(mI2).claimsCreated[0] === 1 && lastH(mI2).claimsExecuted[0] === 1 &&
          mI2.pendingTakan[0] === 0 &&
          mI2.bankedTawan[0] === 30 && mI2.bankedTawan[1] === 0,
      'pending: victim crosses ≥30 via this round\'s banking → new claim executes same round (30→0, holder 0→30)');

    // (c) Multiple claims drain one after another while the victim stays ≥ 30.
    const mM = new G.Match(() => {}, G.seededRng(21));
    mM.bankedTawan = [0, 95];
    mM.onRoundFinished(fakeR([0, 0], [2, 0])); // two takans by team 0
    check(lastH(mM).claimsCreated[0] === 2 && lastH(mM).claimsExecuted[0] === 2 &&
          mM.pendingTakan[0] === 0 &&
          mM.bankedTawan[0] === 60 && mM.bankedTawan[1] === 35,
      'pending: two claims vs banked 95 → both execute (95→35, holder +60)');

    // (d) PAIRWISE CANCELLATION: 1v1 → the pair annihilates, NO claims.
    const mBoth = new G.Match(() => {}, G.seededRng(21));
    mBoth.bankedTawan = [40, 40];
    mBoth.onRoundFinished(fakeR([0, 0], [1, 1]));
    check(lastH(mBoth).takanCancelled === 1 &&
          lastH(mBoth).claimsCreated[0] === 0 && lastH(mBoth).claimsCreated[1] === 0 &&
          mBoth.pendingTakan[0] === 0 && mBoth.pendingTakan[1] === 0 &&
          mBoth.bankedTawan[0] === 40 && mBoth.bankedTawan[1] === 40,
      'pending: 1v1 takans cancel pairwise → no claims created, banks untouched');

    // (d2) 2v2 → both pairs annihilate, NO claims either way.
    const m22 = new G.Match(() => {}, G.seededRng(21));
    m22.bankedTawan = [40, 40];
    m22.onRoundFinished(fakeR([0, 0], [2, 2]));
    check(lastH(m22).takanCancelled === 2 &&
          lastH(m22).claimsCreated[0] === 0 && lastH(m22).claimsCreated[1] === 0 &&
          m22.pendingTakan[0] === 0 && m22.pendingTakan[1] === 0 &&
          m22.bankedTawan[0] === 40 && m22.bankedTawan[1] === 40,
      'pending: 2v2 takans cancel pairwise → no claims created, banks untouched');

    // (d3) 2v1 → one pair cancels, the SURPLUS takan creates exactly one
    //      claim — and it executes at once (victim banked 40 ≥ 30).
    const m21 = new G.Match(() => {}, G.seededRng(21));
    m21.bankedTawan = [0, 40];
    m21.onRoundFinished(fakeR([0, 0], [2, 1]));
    check(lastH(m21).takanCancelled === 1 &&
          lastH(m21).claimsCreated[0] === 1 && lastH(m21).claimsCreated[1] === 0 &&
          lastH(m21).claimsExecuted[0] === 1 && m21.pendingTakan[0] === 0 &&
          m21.bankedTawan[0] === 30 && m21.bankedTawan[1] === 10,
      'pending: 2v1 → 1 pair cancels, surplus = 1 claim, executed (0+30 / 40−30)');

    // (d4) 3v1 → one pair cancels, surplus = two claims; both execute
    //      while the victim (95) stays ≥ 30.
    const m31 = new G.Match(() => {}, G.seededRng(21));
    m31.bankedTawan = [0, 95];
    m31.onRoundFinished(fakeR([0, 0], [3, 1]));
    check(lastH(m31).takanCancelled === 1 &&
          lastH(m31).claimsCreated[0] === 2 && lastH(m31).claimsCreated[1] === 0 &&
          lastH(m31).claimsExecuted[0] === 2 && m31.pendingTakan[0] === 0 &&
          m31.bankedTawan[0] === 60 && m31.bankedTawan[1] === 35,
      'pending: 3v1 → 1 pair cancels, surplus = 2 claims, both execute (95→35, holder +60)');

    // (d5) Surplus claim stays PENDING when the victim is below 30 —
    //      cancellation does not change the execution gate.
    const mSurp = new G.Match(() => {}, G.seededRng(21));
    mSurp.onRoundFinished(fakeR([5, 5], [2, 1])); // finals ≤9 wipe; banks stay 0
    check(lastH(mSurp).takanCancelled === 1 &&
          lastH(mSurp).claimsCreated[0] === 1 && lastH(mSurp).claimsExecuted[0] === 0 &&
          mSurp.pendingTakan[0] === 1 && mSurp.pendingTakan[1] === 0 &&
          mSurp.bankedTawan[0] === 0 && mSurp.bankedTawan[1] === 0,
      'pending: 2v1 with victim banked 0 → surplus claim created, ★ pending, no movement');

    // (e) Match end is checked AFTER executions: a pending claim can
    //     pull a crossed team back below 210 (no loser), and can push
    //     the claim HOLDER over 210 (the holder loses).
    const mE = new G.Match(() => {}, G.seededRng(21));
    mE.bankedTawan = [195, 20];
    mE.pendingTakan = [0, 1]; // team 1 holds a claim against team 0
    mE.onRoundFinished(fakeR([20, 15], [0, 0])); // banded banks → [215, 30]; execution → [185, 60]
    check(mE.bankedTawan[0] === 185 && mE.bankedTawan[1] === 60 &&
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
  const userScenario = G.scoreRound([30, 0]);
  check(userScenario.tawan[0] === 30 && userScenario.tawan[1] === 0 &&
        userScenario.winner === undefined && userScenario.credits === undefined &&
        userScenario.bumped === undefined,
    'user scenario: card tawan 30 vs 0, no takan → finals 30/0 stand, no points');

  // Banking bands (user rule «بندهای ده‌تایی», confirmed 2026-11-06 with
  // his correction «از 16 تا 20 → 20؛ اگر 21 شد یعنی 30»): scoreRound
  // itself rewrites NOTHING anymore — the finals stand exactly as
  // captured; the banding applies only to what banks (bankAmount).
  const noBump = G.scoreRound([24, 6]);
  check(noBump.tawan[0] === 24 && noBump.tawan[1] === 6 && noBump.bumped === undefined,
    'no bump: finals 24/6 stand exactly as captured (banding is bank-only)');
  check(G.bankAmount(0) === 0 && G.bankAmount(9) === 0,
    'band: 0–9 banks 0 (boundary 9 → 0)');
  check(G.bankAmount(10) === 10 && G.bankAmount(15) === 10,
    'band: 10–15 banks 10 (boundaries 10 → 10, 15 → 10)');
  check(G.bankAmount(16) === 20 && G.bankAmount(20) === 20,
    'band: 16–20 banks 20 (boundaries 16 → 20, 20 → 20)');
  check(G.bankAmount(21) === 30 && G.bankAmount(30) === 30,
    'band: 21–30 banks 30 (21 counts as 30; 30 → 30)');

  // --- Constructed scenario: a void-suit LEAD is a takan (count 1, claim only) ---
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
    check(round.canArm13(0) === true, 'up46: «13» can be armed on ANY lead — no longer final-trick-only');
    round.play(0, '2S');
    check(round.takanCount[0] === 1 && round.takanCount[1] === 0 &&
          round.takanBonus === undefined,
      'void-suit lead fires takan: count 1 for the leader team, NO round tawan added');
    check(round.takanBy[0].length === 1 && round.takanBy[0][0] === 0 && round.takanBy[1].length === 0,
      'takan giver recorded (takanBy) for the round summary');
    check(evts.some((e) => e.type === 'takan' && e.seat === 0 && e.team === 0 && e.bonus === undefined),
      'takan event emitted for clients (count only, no bonus)');
  }

  // --- Constructed scenarios: the NEW «13» rule (up46 — owner-locked
  // 2026-11-12). The leader arms «13» on ANY lead, then plays his lead
  // card; the round ends at once. Nobody else holding the suit → clean;
  // N cards held by the other three (partner included) → N pending
  // claims AGAINST the declaring team. ---
  {
    // Arm/disarm legality: leader only, empty trick only, toggle.
    const r = new G.Round(0, () => {}, G.seededRng(11));
    r.hands = [['AS', '3D'], ['KH', '4C'], ['QD', '5H'], ['JC', '6D']];
    r.captured = [[], []];
    r.tricksPlayed = 11; r.leader = 0; r.turn = 0;
    check(r.canArm13(1) === false, 'up46 «13»: a non-leader cannot arm');
    let threw = false;
    try { r.arm13(1); } catch (e) { threw = true; }
    check(threw && r.armed13 === false, 'up46 «13»: arm13 throws for a non-leader');
    r.arm13(0);
    check(r.armed13 === true, 'up46 «13»: the leader arms on his lead');
    r.arm13(0);
    check(r.armed13 === false, 'up46 «13»: pressing again DISARMS');
    r.play(0, '3D'); // seat 2 holds Q♦, so this lead is no takan either
    check(r.canArm13(1) === false, 'up46 «13»: mid-trick arming is impossible');
    threw = false;
    try { r.arm13(1); } catch (e) { threw = true; }
    check(threw, 'up46 «13»: arm13 throws mid-trick');
  }
  {
    // CLEAN «13»: the suit is dead → the round ends at once, the
    // declaration creates nothing, and the tawan captured so far
    // banks normally by the ten-bands (partial sums).
    const evts = [];
    const r = new G.Round(0, (e) => evts.push(e), G.seededRng(11));
    r.hands = [['AS'], ['KH'], ['QD'], ['JC']]; // only seat 0 holds قره
    r.captured = [
      G.makeDeck().filter((c) => G.suitOf(c) === 'H').concat(['TD']), // team 0: 13×1 + 3 = 16
      ['QS'],                                                          // team 1: 9
    ];
    r.tricksPlayed = 12; r.leader = 0; r.turn = 0;
    r.arm13(0);
    r.play(0, 'AS');
    check(r.finished && r.result.thirteen && r.result.thirteen.count === 0 &&
          r.result.thirteen.seat === 0 && r.result.thirteen.team === 0,
      'up46 clean «13»: the round ends at the lead; the resolution is recorded (count 0)');
    check(evts.some((e) => e.type === 'declared13' && e.clean === true && e.count === 0 && e.suit === 'S'),
      'up46 clean «13»: the declared13 event carries the clean outcome');
    check(r.result.cardTawan[0] === 16 && r.result.cardTawan[1] === 9 &&
          r.takanCount[0] === 0 && r.takanCount[1] === 0,
      'up46 clean «13»: only the captured tawan stands (16/9) — the unplayed remainder is discarded, no takan');
    const m = new G.Match(() => {}, G.seededRng(21));
    m.onRoundFinished(r);
    check(m.bankedTawan[0] === 20 && m.bankedTawan[1] === 0 &&
          m.pendingTakan[0] === 0 && m.pendingTakan[1] === 0 &&
          m.history[0].thirteenPenalty === 0,
      'up46 clean «13» at Match level: partial tawan banks by the bands (16→20, 9→0); NO claims created');
  }
  {
    // WRONG «13»: the suit IS held — partner included. One claim per
    // held card lands on the DECLARING team; the claims join the pool
    // before the execution loop, so they execute the same round.
    const r = new G.Round(0, () => {}, G.seededRng(11));
    r.hands = [['5S', 'KH'], ['2S', '4C'], ['7S', 'QD'], ['9S', '6D']];
    // spades in the other three hands: 2♠ + 7♠ (PARTNER seat 2) + 9♠ = 3
    r.captured = [[], []];
    r.tricksPlayed = 11; r.leader = 0; r.turn = 0;
    r.arm13(0);
    r.play(0, '5S');
    check(r.finished && r.result.thirteen && r.result.thirteen.count === 3 &&
          r.result.thirteen.team === 0,
      'up46 wrong «13»: the server counts the suit in ALL three other hands — partner included (3)');
    const m = new G.Match(() => {}, G.seededRng(21));
    m.bankedTawan = [0, 40];
    m.onRoundFinished(r);
    // banking: cardTawan 0/0 → banks 0/0 → [0, 40]. The 3 penalty
    // claims sit ON team 0 — the DECLARING team itself — and execute
    // while the OPPONENTS' bank ≥ 30: one execution moves 30 from
    // team 1's bank into the declarer's (0→30 / 40→10), then the
    // victim is below 30 and the remaining 2 stay pending (★ on the
    // DECLARING team's own side).
    check(m.history[0].thirteenPenalty === 3 &&
          m.history[0].claimsCreated[0] === 0 && m.history[0].claimsCreated[1] === 0,
      'up46 wrong «13»: the penalty bypasses pairwise cancellation — takan claimsCreated stays 0/0');
    check(m.bankedTawan[0] === 30 && m.bankedTawan[1] === 10 &&
          m.pendingTakan[0] === 2 && m.history[0].claimsExecuted[0] === 1,
      'up46 wrong «13»: penalty claims land on the DECLARING team and execute the SAME round while the opponents’ bank ≥ 30; the rest stay pending');
  }
  {
    // The penalty does NOT cancel against the other team's takans.
    const r = new G.Round(0, () => {}, G.seededRng(11));
    r.hands = [['5S'], ['2S'], ['KH'], ['QD']]; // seat 1 holds one spade
    r.captured = [[], []];
    r.tricksPlayed = 12; r.leader = 0; r.turn = 0;
    r.takanCount = [0, 2]; // team 1 takaned twice this round (rigged)
    r.arm13(0);
    r.play(0, '5S'); // wrong «13»: 1 spade held → 1 penalty claim ON team 0 itself
    const m = new G.Match(() => {}, G.seededRng(21));
    m.onRoundFinished(r);
    // Team 1 keeps its 2 surplus takan claims IN FULL, and team 0
    // (the declarer) carries its 1 penalty claim on itself (banks
    // are 0/0, so nothing executes). Had the penalty entered the
    // pairwise takan cancellation, it would have annihilated one of
    // team 1's takans and never landed — instead both stand: 1 + 2.
    check(m.pendingTakan[0] === 1 && m.pendingTakan[1] === 2 &&
          m.history[0].claimsCreated[1] === 2 && m.history[0].thirteenPenalty === 1,
      'up46 wrong «13»: the penalty claim does NOT cancel against the rivals’ takans (declarer holds 1 penalty; rivals keep their 2 surplus)');
  }
  {
    // The same dead-suit final lead WITHOUT a declaration is still a
    // plain takan — «13» is an alternative, not a replacement.
    const r = new G.Round(0, () => {}, G.seededRng(11));
    r.hands = [['AS'], ['KH'], ['QD'], ['JC']]; // only seat 0 holds قره
    r.captured = [[], []];
    r.tricksPlayed = 12; r.leader = 0; r.turn = 0;
    r.play(0, 'AS'); r.play(1, 'KH'); r.play(2, 'QD'); r.play(3, 'JC');
    // the trick's cards (KH 1 + JC 5) are the ONLY tawan: 6, card-only.
    check(r.finished && r.takanCount[0] === 1 && r.result.thirteen === null &&
          r.result.tawan[0] === 6 && r.result.tawan[1] === 0,
      'final trick WITHOUT «13» → takan claim only; round tawan stays card-only (6/0)');
    check(r.wonTricks[0] === 1, 'won-trick pile credited to the trick winner');
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
    // (up46: no declaration — the final AS lead is itself a dead-suit
    // lead and adds a second takan; irrelevant here, the finals below
    // are card-only either way.)
    round.play(0, 'AS'); round.play(1, 'KH'); round.play(2, 'QD'); round.play(3, 'JC');
    // last trick adds KH(1) + JC(5) to team 0 → card 22 / 14. The takan
    // adds NOTHING and nothing rewrites the finals: 22 / 14 stand (the
    // 22 banks as 30 at Match level — banding is bank-only, no bump).
    const r = round.result;
    check(r.tawan[0] === 22 && r.tawan[1] === 14 && r.bumped === undefined &&
          r.transferred === undefined,
      'round-level: single takan → card-only finals (22 / 14 stand), no +30, no transfer');
    check(r.winner === undefined && r.credits === undefined,
      'round-level: no points either — just the two finals');
  }

  // --- Pending claims from REAL rounds: an armed «13» on a dead suit
  // ends the round clean and creates NO claim; the same final trick
  // WITHOUT the declaration creates a takan claim, and it executes at
  // once because the victim is already ≥ 30. ---
  {
    const rigDeclared = () => {
      const round = new G.Round(0, () => {}, G.seededRng(11));
      round.hands = [['AS'], ['KH'], ['QD'], ['JC']]; // only seat 0 holds قره
      round.captured = [[], []];
      round.tricksPlayed = 12;
      round.leader = 0; round.turn = 0;
      round.arm13(0);
      round.play(0, 'AS'); // resolves the declaration — the round ends at once
      return round;
    };
    const rigUndeclared = () => {
      const round = new G.Round(0, () => {}, G.seededRng(11));
      round.hands = [['AS'], ['KH'], ['QD'], ['JC']]; // only seat 0 holds قره
      round.captured = [[], []];
      round.tricksPlayed = 12;
      round.leader = 0; round.turn = 0;
      round.play(0, 'AS'); round.play(1, 'KH'); round.play(2, 'QD'); round.play(3, 'JC');
      return round;
    };
    const mDecl = new G.Match(() => {}, G.seededRng(21));
    mDecl.bankedTawan = [0, 40];
    mDecl.onRoundFinished(rigDeclared());
    check(mDecl.pendingTakan[0] === 0 && mDecl.pendingTakan[1] === 0 &&
          mDecl.history[0].claimsCreated[0] === 0 && mDecl.history[0].thirteenPenalty === 0,
      'pending: an armed «13» on a dead suit → round ends clean, NO claim created');
    const mNoDecl = new G.Match(() => {}, G.seededRng(21));
    mNoDecl.bankedTawan = [0, 40];
    mNoDecl.onRoundFinished(rigUndeclared());
    // round final: team 0 = 6 card tawan ONLY (the takan adds nothing) →
    // 6 ≤ 9 wipes, team 0 banks 0; victim team 1 sits at 40 ≥ 30 → the
    // new claim executes immediately: 40−30 to the victim, +30 to team 0.
    check(mNoDecl.history[0].claimsCreated[0] === 1 &&
          mNoDecl.history[0].claimsExecuted[0] === 1 &&
          mNoDecl.pendingTakan[0] === 0 &&
          mNoDecl.bankedTawan[0] === 30 && mNoDecl.bankedTawan[1] === 10,
      'pending: undeclared takan vs banked 40 → claim created AND executed (0+30 / 40−30)');
  }

  // --- Constructed scenarios: EXACT 15–15 tie through the real finish()
  // path (user's screenshot case, pinned). At Round level a tie is just
  // a tie — no winner/credits — but at Match level the Q♠ CAPTURING team
  // banks 20 instead of 10 (user rule, 2026-11-06). qsTeam must be the
  // CAPTURING team (the trick winner's team), NEVER the team of the
  // player who played the card. ---
  {
    const HEARTS = G.makeDeck().filter((c) => G.suitOf(c) === 'H');
    // Pile-rig both ways: QS+JC+1 heart = 15 vs TD+12 hearts = 15.
    const rig = (qsCapturer) => {
      const round = new G.Round(0, () => {}, G.seededRng(101));
      const withQS = ['QS', 'JC', HEARTS[0]];
      const withoutQS = ['TD', ...HEARTS.slice(1)];
      round.captured = qsCapturer === 0 ? [withQS, withoutQS] : [withoutQS, withQS];
      round.takanCount = [0, 0];
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
    rigRound.takanCount = [0, 0];
    rigRound.finish();
    mTie.onRoundFinished(rigRound);
    const hTie = mTie.history[mTie.history.length - 1];
    check(hTie.qsTeam === 0 && hTie.credits === undefined && hTie.winner === undefined &&
          hTie.banked[0] === 20 && hTie.banked[1] === 10 && hTie.qsTieBoost === 0 &&
          hTie.tawan[0] === 15 && hTie.tawan[1] === 15,
      'tie 15–15 payload (roundResult): Q♠ team banks 20, the other banks 10, no credits');

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
    // Lead: a dead-suit lead is a takan (hands the opponents a pending
    // claim on OUR bank) → the bot leads a live non-scoring card instead
    // of the dead spade.
    {
      const r = midRound(
        [['2S', '5D', '9D', '3C'], ['4H', '6D', '7C'], ['5H', '8D', '9C'], ['6H', 'TD', 'JC']],
        [], 0);
      const pick = bots.chooseCard(r, 0);
      check(pick === '3C' && G.suitOf(pick) !== 'S',
        'bot lead: avoids the dead-suit (takan) lead — cheap live card instead');
    }
    // «13» and bots (up46): a bot declares ONLY on a provably-clean
    // count with a no-worse balance (plan13 — pinned in the BOT13
    // section below); on this bare rig the count proves nothing, so
    // the fresh final-trick takan is NOT declared — its claim stands.
    {
      const r = midRound([['AS'], ['KH'], ['QD'], ['JC']], [], 0);
      r.tricksPlayed = 12;
      check(bots.plan13(r, 0) === null,
        'bot «13»: a fresh final-trick takan is NOT declared on a guess — its claim stands');
    }
  }

  // --- BOT NO-REPEAT TAKAN LAW (owner order, 2026-11-09 — «فقط دفعهٔ
  // اول تکان حساب می‌شود»): per bot, per round, only the FIRST takan of
  // a suit counts. The bot NEVER leads an already-takan'd suit while
  // any other suit remains (absolute — other suits are exhausted
  // first); a forced re-lead at the end creates NO claim (suppressed
  // in game.js for bot seats). The partner's first lead of the same
  // suit counts (per-bot rule). Humans are untouched in all cases.
  // (up46: the law's old final-trick «13» declaration is GONE with the
  // old rule — a bot now declares only via plan13, pinned in (b).) ---
  {
    const leadRig = (hands, tricksPlayed, seed) => {
      const round = new G.Round(0, () => {}, G.seededRng(seed || 401));
      round.hands = hands;
      round.trick = [];
      round.turn = 0;
      round.leader = 0;
      round.tricksPlayed = tricksPlayed;
      round.captured = [[], []];
      return round;
    };
    const ALLBOTS = [true, true, true, true];

    // Tracking + humans (e): seat 0 (a HUMAN seat — botSeats default
    // false) holds every spade; its takan is remembered per seat+suit,
    // and its REPEAT lead still counts. The engine never blocks a
    // human re-lead.
    {
      const r = new G.Round(0, () => {}, G.seededRng(401));
      r.hands = [
        G.makeDeck().filter((c) => G.suitOf(c) === 'S'),
        G.makeDeck().filter((c) => G.suitOf(c) === 'H'),
        G.makeDeck().filter((c) => G.suitOf(c) === 'D'),
        G.makeDeck().filter((c) => G.suitOf(c) === 'C'),
      ];
      r.play(0, '2S'); r.play(1, '2H'); r.play(2, '2D'); r.play(3, '2C');
      check(r.takanCount[0] === 1 &&
            JSON.stringify(r.takanSuits[0]) === '["S"]' &&
            r.takanSuits[1].length === 0 && r.takanSuits[2].length === 0 && r.takanSuits[3].length === 0,
        'bot13 tracking: a takan lead is remembered per seat+suit (round.takanSuits)');
      r.play(0, '3S'); // the human re-leads the same dead suit at once
      check(r.takanCount[0] === 2 && r.takanSuits[0].length === 1,
        'bot13 (e): a HUMAN repeat takan lead still counts — humans are untouched by the law');
    }

    // (a) His example: the bot holds قره (already takan'd) + لال → it
    // leads لال, never the takan'd suit.
    {
      const r = leadRig(
        [['5S', '3H', '7H'], ['KH', '4D', '6C'], ['2H', '8D', 'TC'], ['QH', '5D', '9C']], 10);
      r.botSeats = ALLBOTS.slice();
      r.takanSuits[0] = ['S'];
      check(bots.chooseCard(r, 0) === '3H',
        'bot13 (a): bot holds the takan’d قره + لال → leads لال, never the takan’d suit');
    }
    // (a2) Even when EVERY suit is dead, the ban holds: the old logic
    // cheapest-dead-led the takan'd 2♠ here; the law leads another suit.
    {
      const r = leadRig(
        [['2S', 'KH', '3C'], ['4D', '6D', '8D'], ['5D', '7D', '9D'], ['TD', 'JD', 'QD']], 10);
      r.botSeats = ALLBOTS.slice();
      r.takanSuits[0] = ['S'];
      check(bots.chooseCard(r, 0) === '3C',
        'bot13 (a): all suits dead — the takan’d suit is STILL not led while another suit remains');
    }

    // The full law in one organic chain: first takan counts → other
    // suit exhausted before any repeat → that suit's first takan
    // counts too (c2) → the forced final-trick repeat is led with NO
    // «13» declaration and creates no claim (suppressed).
    {
      const evts = [];
      const r = new G.Round(0, (e) => evts.push(e), G.seededRng(403));
      r.hands = [['4S', '3H', '6S'], ['QD', '2D', '9D'], ['5D', '7D', 'TC'], ['JC', '8C', '9C']];
      r.captured = [[], []];
      r.tricksPlayed = 10; r.leader = 0; r.turn = 0;
      r.botSeats = ALLBOTS.slice();
      let pick = bots.chooseCard(r, 0);
      check(pick === '4S', 'bot13 chain: with only dead suits, the bot opens a fresh suit (قره)');
      r.play(0, pick); r.play(1, 'QD'); r.play(2, '5D'); r.play(3, 'JC');
      check(r.takanCount[0] === 1 && JSON.stringify(r.takanSuits[0]) === '["S"]',
        'bot13 chain: the first قره takan counts and is remembered');
      pick = bots.chooseCard(r, 0);
      check(pick === '3H',
        'bot13 chain: 6♠ still in hand, yet the OTHER suit (لال) is led — exhaustion before any repeat');
      r.play(0, pick); r.play(1, '2D'); r.play(2, '7D'); r.play(3, '8C');
      check(r.takanCount[0] === 2 && JSON.stringify(r.takanSuits[0]) === '["S","H"]',
        'bot13 (c2): the same bot’s FIRST takan of a different suit (لال) still counts');
      check(bots.plan13(r, 0) === null,
        'bot13 (b): only the takan’d suit remains for the final trick — no «13» is planned (the count runs on the captured piles + hand; this rig’s piles cannot prove the suit dead, and its captured balance is worse anyway)');
      r.play(0, '6S'); r.play(1, '9D'); r.play(2, 'TC'); r.play(3, '9C');
      check(r.finished && r.takanCount[0] === 2 &&
            !evts.some((e) => e.type === 'declared13'),
        'bot13 (b): the forced repeat lead creates NO third takan and no new claim (suppressed)');
    }

    // (b) plan13 in isolation (up46): the bot declares «13» ONLY on a
    // provably-clean count (unseen = 0) with a no-worse captured
    // balance — never on a guess.
    {
      const spadesGone = G.makeDeck().filter((c) => G.suitOf(c) === 'S' && c !== 'AS');
      const rig = (cap) => {
        const r = leadRig([['AS', '3D'], ['KH', '4C'], ['QD', '5H'], ['JC', '6D']], 11);
        r.botSeats = ALLBOTS.slice();
        r.captured = cap;
        return r;
      };
      const rA = rig([[], spadesGone]); // 12 spades in team 1's pile (Q♠ = 9 of their tawan)
      check(bots.countSuits(rA, 0).S.unseen === 0 && bots.plan13(rA, 0) === 'AS',
        'bot13 (b): a provably-dead suit (unseen 0) + no-worse balance → the bot plans «13» with the dead card');
      rA.arm13(0);
      rA.play(0, 'AS');
      check(rA.finished && rA.result.thirteen && rA.result.thirteen.count === 0 && rA.takanCount[0] === 0,
        'bot13 (b): the planned «13» resolves clean — the round ends, no takan, no claim');
      const rB = rig([spadesGone, []]); // the same spades in OUR pile — our captured tawan is worse
      check(bots.plan13(rB, 0) === null,
        'bot13 (b): provably clean but our captured tawan is WORSE → no declaration (stopping would lock the worse result)');
      const rC = rig([[], []]); // nothing played yet — the count cannot prove the suit dead
      check(bots.plan13(rC, 0) === null,
        'bot13 (b): unseen > 0 → NO declaration — a bot never declares «13» on a guess');
    }

    // (c) Forced mid-round re-lead: led (nothing else exists), no
    // «13» planned, and NO claim — silently suppressed.
    {
      const evts = [];
      const r = new G.Round(0, (e) => evts.push(e), G.seededRng(405));
      r.hands = [['4S', '6S', '8S'], ['KH', '3H', '2H'], ['QD', '5D', '7D'], ['JC', '7C', '9C']];
      r.captured = [[], []];
      r.tricksPlayed = 10; r.leader = 0; r.turn = 0;
      r.botSeats = ALLBOTS.slice();
      r.play(0, bots.chooseCard(r, 0)); r.play(1, 'KH'); r.play(2, 'QD'); r.play(3, 'JC');
      check(r.takanCount[0] === 1, 'bot13 (c) setup: the bot’s first قره takan counts');
      const pick = bots.chooseCard(r, 0);
      check(G.suitOf(pick) === 'S' && bots.plan13(r, 0) === null,
        'bot13 (c): only the takan’d suit remains mid-round → it IS led (no «13» planned — no provably-clean count here)');
      r.play(0, pick);
      check(r.takanCount[0] === 1 && evts.filter((e) => e.type === 'takan').length === 1,
        'bot13 (c): the forced repeat lead creates NO claim — silently suppressed');
    }

    // (c3) The partner's first lead of the same dead suit is the
    // PARTNER's first — it counts.
    {
      const r = leadRig([['KH', '3H'], ['QD', '2D'], ['7S', '9S'], ['JC', '8C']], 11);
      r.botSeats = ALLBOTS.slice();
      r.takanSuits[0] = ['S']; r.takanCount = [1, 0]; // seat 0 already takan'd قره
      r.turn = 2; r.leader = 2;
      r.play(2, bots.chooseCard(r, 2));
      check(r.takanCount[0] === 2 && JSON.stringify(r.takanSuits[2]) === '["S"]',
        'bot13 (c3): the partner’s first lead of the same dead suit still counts (per-bot rule)');
    }

    // (d) A FRESH final-trick takan: no declaration, claim created —
    // exactly as before the law.
    {
      const r = leadRig([['AS'], ['KH'], ['QD'], ['JC']], 12);
      r.botSeats = ALLBOTS.slice();
      check(bots.plan13(r, 0) === null,
        'bot13 (d): a FRESH final-trick takan is not declared (no provably-clean count on this rig)');
      r.play(0, 'AS'); r.play(1, 'KH'); r.play(2, 'QD'); r.play(3, 'JC');
      check(r.finished && r.takanCount[0] === 1,
        'bot13 (d): the fresh final-trick takan creates its claim, as before');
    }

    // (e) final-trick form: a HUMAN whose last card repeats his own
    // earlier takan suit, undeclared → the repeat counts.
    {
      const r = leadRig([['AS'], ['KH'], ['QD'], ['JC']], 12);
      r.takanSuits[0] = ['S']; r.takanCount = [1, 0]; // a human seat; botSeats stay all false
      r.play(0, 'AS'); r.play(1, 'KH'); r.play(2, 'QD'); r.play(3, 'JC');
      check(r.finished && r.takanCount[0] === 2,
        'bot13 (e): a human’s undeclared repeat takan on the final trick still counts');
    }
  }

  // --- BOT CARD COUNTING (up45, owner order 2026-11-12 «همه روبات ها
  // را قوی کن»): the bot counts every played card (captured piles +
  // current trick, all public) against its own hand — unseen = 13 −
  // played − own per suit. A suit at unseen 0 is PROVABLY dead (nobody
  // else can hold it) and is hard-banned as a lead while any other card
  // exists; live suits down to their last few unseen cards are DYING
  // and get spent/shed first, before they strand the bot. ---
  {
    const countRig = (hands, trick, captured, turnSeat) => {
      const round = new G.Round(0, () => {}, G.seededRng(501));
      round.hands = hands;
      round.trick = trick;
      round.captured = captured;
      round.turn = turnSeat;
      round.leader = trick.length ? trick[0].seat : turnSeat;
      return round;
    };

    // Counting sanity: exact per-suit played/own/unseen on a rigged
    // mid-round state, and played + own + unseen = 13 for every suit.
    {
      const r = countRig(
        [['AS', 'KH', '4D'], [], [], []],
        [{ seat: 3, card: '2S' }],
        [['3S', '4S', '5H'], ['6D']], 0);
      const info = bots.countSuits(r, 0);
      check(info.S.played === 3 && info.S.own === 1 && info.S.unseen === 9 &&
            info.H.played === 1 && info.H.own === 1 && info.H.unseen === 11 &&
            info.D.played === 1 && info.D.own === 1 && info.D.unseen === 11 &&
            info.C.played === 0 && info.C.own === 0 && info.C.unseen === 13,
        'counting (up45): per-suit played/own/unseen counted exactly from piles + trick + hand');
      check(G.SUITS.every((s) => info[s].played + info[s].own + info[s].unseen === 13),
        'counting (up45): played + own + unseen = 13 for every suit');
    }

    // Provably-dead hard ban: 12 spades are already in the captured
    // piles and the bot holds the last one (K♠) — by counting, nobody
    // else can hold a spade, so the bot must NOT lead it while it holds
    // live cards; it leads the cheap live probe instead.
    {
      const spadesGone = G.makeDeck().filter((c) => G.suitOf(c) === 'S' && c !== 'KS');
      const r = countRig(
        [['KS', '4D', '9C'], ['5D', '6C', '2H'], ['7D', '8C', '3H'], ['9D', 'TC', '4H']],
        [], [spadesGone, []], 0);
      check(bots.countSuits(r, 0).S.unseen === 0,
        'counting (up45): 12 spades played + K♠ in hand → spades provably dead (unseen 0)');
      check(bots.chooseCard(r, 0) === '4D',
        'counting (up45): the provably-dead suit is never led while an alternative exists');
    }

    // Dying-suit-first lead: diamonds are down to 3 unseen (9 played,
    // 1 in hand) while clubs sit at 12 unseen — the bot spends the
    // dying suit's probe (8♦) NOW, not the cheaper healthy-suit card
    // (3♣) the settled line would have led.
    {
      const diamondsPlayed = ['2D', '3D', '4D', '5D', '6D', '7D', '9D', 'JD', 'QD'];
      const r = countRig(
        [['8D', '3C', 'KS'], ['AD', '2C', '2S'], ['KD', '5C', '3S'], ['TD', '7C', '4S']],
        [], [diamondsPlayed, []], 0);
      check(bots.countSuits(r, 0).D.unseen === 3 && bots.chooseCard(r, 0) === '8D',
        'counting (up45): a dying live suit (unseen ≤ 3) is led before a healthy suit');
    }

    // Dying-suit-first shed: void against the PARTNER's winning trick,
    // the bot sheds its dead-weight spade (spades dying: unseen 1)
    // instead of the higher diamond the settled line would shed —
    // the dying card is exactly the one that would strand it later.
    {
      const spadesPlayed = ['2S', '3S', '5S', '6S', '7S', '8S', '9S', 'TS', 'JS', 'KS'];
      const r = countRig(
        [[], ['2H', '3D'], ['4S', '9D', 'QS'], ['4H', '5D']],
        [{ seat: 0, card: 'AH' }], [spadesPlayed, []], 2);
      check(bots.countSuits(r, 2).S.unseen === 1 && bots.chooseCard(r, 2) === '4S',
        'counting (up45): void vs partner win → the dying-suit card is shed first');
    }
  }

  // Tawan bank — unit: the ten-bands, accumulating over rounds; plus
  // the 15–15 ماتکه کالا boost at Match level.
  {
    const m = new G.Match(() => {}, G.seededRng(3));
    const fake = (tawan, qsTeam) => ({ result: {
      cardTawan: [0, 0], takanCount: [0, 0], takanBy: [[], []],
      tawan, qsTeam: qsTeam || 0 } });
    m.onRoundFinished(fake([9, 21])); // bands: 9 → 0; 21 → 30
    check(m.bankedTawan[0] === 0 && m.bankedTawan[1] === 30 &&
          m.history[0].banked[0] === 0 && m.history[0].banked[1] === 30 &&
          m.history[0].qsTieBoost === -1,
      'bank bands: a 9 banks 0; a 21 banks 30 (21 counts as 30)');
    m.onRoundFinished(fake([10, 25])); // bands: 10 → 10; 25 → 30
    check(m.bankedTawan[0] === 10 && m.bankedTawan[1] === 60 &&
          m.history[1].bankedTawan[0] === 10 && m.history[1].bankedTawan[1] === 60,
      'bank bands: accumulates across two rounds (10 → 10, 25 → 30)');
    // Banding, not the raw final: card tawan 24/6 stands as the round's
    // final, but the bank receives band(24) = 30 and band(6) = 0.
    const rawRound = G.scoreRound([24, 6]);
    m.onRoundFinished({ result: {
      cardTawan: [24, 6], takanCount: [0, 0], takanBy: [[], []],
      tawan: rawRound.tawan, qsTeam: 0 } });
    check(m.bankedTawan[0] === 40 && m.bankedTawan[1] === 60 &&
          m.history[2].banked[0] === 30 && m.history[2].banked[1] === 0,
      'bank bands: a 24 final banks as 30; a 6 final banks as 0');
    // 15–15 tie: the Q♠ CAPTURING team banks 20, the other team 10 —
    // pinned for BOTH captors; a NON-tie 15 banks the plain band 10.
    const mT0 = new G.Match(() => {}, G.seededRng(3));
    mT0.onRoundFinished(fake([15, 15], 0));
    check(mT0.bankedTawan[0] === 20 && mT0.bankedTawan[1] === 10 &&
          mT0.history[0].qsTieBoost === 0,
      'bank tie-boost: 15–15 with Q♠ at team 0 → banks 20 / 10');
    const mT1 = new G.Match(() => {}, G.seededRng(3));
    mT1.onRoundFinished(fake([15, 15], 1));
    check(mT1.bankedTawan[0] === 10 && mT1.bankedTawan[1] === 20 &&
          mT1.history[0].qsTieBoost === 1,
      'bank tie-boost: 15–15 with Q♠ at team 1 → banks 10 / 20');
    const mNT = new G.Match(() => {}, G.seededRng(3));
    mNT.onRoundFinished(fake([15, 20], 0)); // not a tie — Q♠ irrelevant
    check(mNT.bankedTawan[0] === 10 && mNT.bankedTawan[1] === 20 &&
          mNT.history[0].qsTieBoost === -1,
      'bank: a NON-tie 15 banks the plain 10 (no Q♠ boost)');
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
      cardTawan: [0, 0], takanCount: [0, 0], takanBy: [[], []],
      tawan, qsTeam: 0 } });
    const evtsA = [];
    const mA = new G.Match((e) => evtsA.push(e), G.seededRng(9));
    mA.bankedTawan = [200, 100];
    mA.onRoundFinished(fake([15, 12])); // banded banks [10, 10] → [210, 110]: only team 0 crossed
    check(mA.finished === true && mA.loser === 0 && mA.winner === 1 &&
          mA.bankedTawan[0] === 210 && mA.bankedTawan[1] === 110,
      'match end: banked 210 vs 110 → team 0 (≥210) LOSES, team 1 wins');
    const fin = evtsA.find((e) => e.type === 'matchFinished');
    check(!!fin && fin.loser === 0 && fin.winner === 1 &&
          fin.bankedTawan[0] === 210 && fin.bankedTawan[1] === 110,
      'matchFinished event carries winner, loser and the banked totals');
    const mB = new G.Match(() => {}, G.seededRng(9));
    mB.bankedTawan = [205, 200];
    mB.onRoundFinished(fake([10, 25])); // banded banks [10, 30] → [215, 230]: both crossed, higher loses
    check(mB.finished === true && mB.loser === 1 && mB.winner === 0,
      'match end: both cross in one round (215 vs 230) → the HIGHER total (team 1) loses');
    const mC = new G.Match(() => {}, G.seededRng(9));
    mC.bankedTawan = [200, 200];
    mC.onRoundFinished(fake([20, 20])); // banded banks [20, 20] → [220, 220]: equal → play on
    check(mC.finished === false && mC.loser === null && mC.winner === null,
      'match end: both cross at EXACTLY equal totals (220/220) → no loser yet');
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
    thirteenErrors: 0, thirteenRounds: 0, thirteenPenalty: 0,
    pileErrors: 0, takanErrors: 0, pendingErrors: 0, bankErrors: 0,
    bandErrors: 0, tieBoosts: 0, deadLeadErrors: 0,
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
  check(stats.deadLeadErrors === 0, 'counting (up45): a provably-dead suit (played + own = 13) is never led while an alternative exists');
  check(stats.captureErrors === 0, 'every round: captured cards = 4 per completed trick (52 in a full round)');
  check(stats.tawanErrors === 0, 'every round: captured CARD tawan sums to exactly 30 in a full round; a «13»-ended round banks only what was captured (captured + unplayed still totals 30)');
  check(stats.qsErrors === 0, 'ماتکه کالا (Q♠) captor team recorded correctly every round');
  check(stats.noPointsErrors === 0, 'every round: no credits, no round winner, no points totals anywhere',
    stats.ties + ' natural tie rounds occurred');
  check(stats.pileErrors === 0, 'every round: won-trick piles sum to the tricks played (13 in a full round) and match captured cards');
  check(stats.takanErrors === 0, 'every round: takan adds ZERO round tawan (no takanBonus anywhere; finals are card-only)',
    stats.takans + ' takans, ' + stats.declarations + ' «13» declarations in bot play');
  check(stats.thirteenErrors === 0, 'up46: every bot «13» declaration was provably clean (count 0) and no-worse for its team',
    stats.declarations + ' bot declarations, ' + stats.thirteenRounds + ' rounds ended by a «13»');
  check(stats.pendingErrors === 0, 'every round: pending takan — takans cancel pairwise, claims only from the surplus, executions move exactly 30 while the victim bank is ≥30; a wrong «13» adds its penalty claims to the DECLARING team’s own pool with NO cancellation',
    stats.claimsCreated + ' claims created, ' + stats.claimsExecuted + ' executed, ' + stats.thirteenPenalty + ' «13» penalty claims in bot play');
  check(stats.bankErrors === 0, 'every round: banking follows the ten-bands (0–9→0, 10–15→10, 16–20→20, 21+→30) with the 15–15 Q♠ boost, and accumulates exactly');
  check(stats.bandErrors === 0, 'every round: finals are exactly the card tawan — no bump, no rewrite',
    stats.tieBoosts + ' tie-boost (15–15) rounds occurred in bot play');
  check(stats.earlyEndErrors === 0, 'a crossed bank (≥210) continued ONLY when both totals were exactly equal',
    stats.extraRounds + ' extra rounds played');
  check(stats.lateEndErrors === 0, 'every match ended once a banked total reached ≥210');
  check(stats.loserErrors === 0, 'match loser is always the team with the HIGHER banked total; winner is the other team');

  // The seat-photo wire protocol (Google profile photo, 2026-11-06):
  // spawn the real Node server and drive it over WebSocket.
  await serverPhotoChecks();

  // Chat / voice / RTC relay protocol (2026-11-06): the same real
  // server, driven over WebSocket by three clients in one room.
  await serverChatRtcChecks();

  console.log('\n' + (checks - failures) + '/' + checks + ' checks passed · ' +
    stats.roundsTotal + ' rounds · ' + stats.ties + ' tie rounds · ' +
    (failures ? failures + ' FAILURES' : 'ALL GREEN'));
  process.exit(failures ? 1 : 0);
}

// The 'google' avatar kind carries the player's Google profile photo
// through the seat profile. These checks boot the actual server.js on a
// scratch port and speak the real protocol: a valid photo round-trips
// into the seat state; anything invalid is dropped (never a rejection).
async function serverPhotoChecks() {
  const { spawn } = require('child_process');
  const path = require('path');
  const WebSocket = require('ws');
  const PORT = 3219;
  const PHOTO = 'https://lh3.googleusercontent.com/a/ACg8ocKvTest=s96-c';
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const clients = [];
  function openClient() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:' + PORT);
      const c = {
        ws, msgs: [], waiters: [],
        send(o) { ws.send(JSON.stringify(o)); },
        waitFor(pred, label) {
          return new Promise((res, rej) => {
            const found = c.msgs.find(pred);
            if (found) return res(found);
            const to = setTimeout(() => rej(new Error('timeout: ' + label)), 8000);
            c.waiters.push({ pred, res: (m) => { clearTimeout(to); res(m); } });
          });
        },
      };
      ws.on('message', (d) => {
        let m; try { m = JSON.parse(String(d)); } catch (e) { return; }
        c.msgs.push(m);
        c.waiters = c.waiters.filter((w) => {
          if (w.pred(m)) { w.res(m); return false; }
          return true;
        });
      });
      ws.on('open', () => resolve(c));
      ws.on('error', reject);
      clients.push(c);
    });
  }
  try {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('server.js did not start')), 8000);
      srv.stdout.on('data', (d) => {
        if (String(d).includes('listening')) { clearTimeout(to); resolve(); }
      });
      srv.on('exit', () => reject(new Error('server.js exited early')));
    });

    // 1) avatar 'google' + a valid Google photo → both ride into state.
    const a = await openClient();
    a.send({ type: 'create', name: 'گوگل', avatar: 'google', country: 'افغانستان', photo: PHOTO });
    const roomA = await a.waitFor((m) => m.type === 'room', 'room A');
    const stA = await a.waitFor((m) => m.type === 'state', 'state A');
    check(stA.seats[roomA.seat].avatar === 'google' && stA.seats[roomA.seat].photo === PHOTO,
      'server: google avatar + valid photo round-trips into state');

    // 2) avatar 'google' + a bad photo (http, wrong host) → photo
    // dropped silently, the seat still joins.
    const b = await openClient();
    b.send({ type: 'join', code: roomA.code, name: 'بد', avatar: 'google', country: '', photo: 'http://evil.example.com/x.jpg' });
    const roomB = await b.waitFor((m) => m.type === 'room', 'room B');
    const stB = await b.waitFor((m) => m.type === 'state' && m.seats[roomB.seat].kind === 'human', 'state B');
    check(stB.seats[roomB.seat].avatar === 'google' && !stB.seats[roomB.seat].photo,
      'server: bad photo URL dropped, seat still joins');

    // 3) a portrait avatar + photo → photo dropped (it belongs to the
    // 'google' avatar only).
    const c2 = await openClient();
    c2.send({ type: 'join', code: roomA.code, name: 'پرتره', avatar: 'av3', country: '', photo: PHOTO });
    const roomC = await c2.waitFor((m) => m.type === 'room', 'room C');
    const stC = await c2.waitFor((m) => m.type === 'state' && m.seats[roomC.seat].kind === 'human', 'state C');
    check(stC.seats[roomC.seat].avatar === 'av3' && !stC.seats[roomC.seat].photo,
      'server: photo dropped when avatar is not google');

    // 4) an over-long photo (> 300 chars) → dropped.
    const d = await openClient();
    d.send({ type: 'join', code: roomA.code, name: 'دراز', avatar: 'google', country: '', photo: 'https://lh3.googleusercontent.com/' + 'a'.repeat(290) });
    const roomD = await d.waitFor((m) => m.type === 'room', 'room D');
    const stD = await d.waitFor((m) => m.type === 'state' && m.seats[roomD.seat].kind === 'human', 'state D');
    check(!stD.seats[roomD.seat].photo, 'server: photo over 300 chars dropped');
  } catch (e) {
    check(false, 'server photo protocol checks', e.message);
  } finally {
    clients.forEach((c) => { try { c.ws.close(); } catch (e) { /* already closed */ } });
    srv.kill();
  }
}

// Chat, voice flags and WebRTC signaling all ride the game socket as a
// strict server relay. These checks boot the real server.js on a
// scratch port with three clients in one room (plus one outsider in a
// second room) and speak the real protocol.
async function serverChatRtcChecks() {
  const { spawn } = require('child_process');
  const path = require('path');
  const WebSocket = require('ws');
  const PORT = 3220;
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const clients = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function openClient() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:' + PORT);
      const c = {
        ws, msgs: [], waiters: [],
        send(o) { ws.send(JSON.stringify(o)); },
        waitFor(pred, label) {
          return new Promise((res, rej) => {
            const found = c.msgs.find(pred);
            if (found) return res(found);
            const to = setTimeout(() => rej(new Error('timeout: ' + label)), 8000);
            c.waiters.push({ pred, res: (m) => { clearTimeout(to); res(m); } });
          });
        },
        // like waitFor, but only over messages received from index `mark`
        waitFrom(mark, pred, label) {
          return new Promise((res, rej) => {
            const scan = () => c.msgs.slice(mark).find(pred);
            const found = scan();
            if (found) return res(found);
            const to = setTimeout(() => rej(new Error('timeout: ' + label)), 8000);
            c.waiters.push({
              pred: (m) => c.msgs.indexOf(m) >= mark && pred(m),
              res: (m) => { clearTimeout(to); res(m); },
            });
          });
        },
        countFrom(mark, pred) { return c.msgs.slice(mark).filter(pred).length; },
      };
      ws.on('message', (d) => {
        let m; try { m = JSON.parse(String(d)); } catch (e) { return; }
        c.msgs.push(m);
        c.waiters = c.waiters.filter((w) => {
          if (w.pred(m)) { w.res(m); return false; }
          return true;
        });
      });
      ws.on('open', () => resolve(c));
      ws.on('error', reject);
      clients.push(c);
    });
  }
  try {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('server.js did not start')), 8000);
      srv.stdout.on('data', (d) => {
        if (String(d).includes('listening')) { clearTimeout(to); resolve(); }
      });
      srv.on('exit', () => reject(new Error('server.js exited early')));
    });

    // Room 1: A (host) + B + C. Room 2: E alone (cross-room canary).
    const a = await openClient();
    a.send({ type: 'create', name: 'احمد' });
    const roomA = await a.waitFor((m) => m.type === 'room', 'room A');
    const b = await openClient();
    b.send({ type: 'join', code: roomA.code, name: 'بلال' });
    const roomB = await b.waitFor((m) => m.type === 'room', 'room B');
    const c = await openClient();
    c.send({ type: 'join', code: roomA.code, name: 'کارل' });
    const roomC = await c.waitFor((m) => m.type === 'room', 'room C');
    const e = await openClient();
    e.send({ type: 'create', name: 'بیرونی' });
    await e.waitFor((m) => m.type === 'room', 'room E');

    // 1) phrase relay: an allowlisted phrase reaches the other members
    // (and echoes to the sender — clients render from the relay only),
    // carrying seat + name + kind + value.
    const eMark0 = e.msgs.length;
    a.send({ type: 'chat', kind: 'phrase', value: 'ښه چال' });
    const chatB = await b.waitFor((m) => m.type === 'chat', 'chat at B');
    check(chatB.seat === roomA.seat && chatB.name === 'احمد' && chatB.kind === 'phrase' && chatB.value === 'ښه چال',
      'server: chat phrase relay reaches room members with seat/name/kind/value');
    const chatA = await a.waitFor((m) => m.type === 'chat', 'chat echo at A');
    check(chatA.seat === roomA.seat && chatA.kind === 'phrase' && chatA.value === 'ښه چال',
      'server: chat echoes to the sender (render-from-relay)');
    await sleep(300);
    check(e.countFrom(eMark0, (m) => m.type === 'chat') === 0,
      'server: chat never leaks into another room');

    // 2) emoji and sticker relays arrive intact.
    await sleep(900);
    a.send({ type: 'chat', kind: 'emoji', value: '😂' });
    const chatEm = await b.waitFor((m) => m.type === 'chat' && m.kind === 'emoji', 'emoji chat at B');
    check(chatEm.value === '😂', 'server: chat emoji relayed intact');
    await sleep(900);
    b.send({ type: 'chat', kind: 'sticker', value: 'st1' });
    const chatSt = await a.waitFor((m) => m.type === 'chat' && m.kind === 'sticker', 'sticker chat at A');
    check(chatSt.value === 'st1' && chatSt.seat === roomB.seat, 'server: chat sticker relayed intact');

    // 3) anything NOT on the allowlists is dropped: an old-style free
    // text frame, a made-up phrase, a bad sticker id, an unknown kind.
    await sleep(900);
    const aMark1 = a.msgs.length;
    const bMark1 = b.msgs.length;
    b.send({ type: 'chat', text: 'سلام ټولو ته' });
    b.send({ type: 'chat', kind: 'phrase', value: 'متن آزاد دلخواه' });
    b.send({ type: 'chat', kind: 'sticker', value: 'st99' });
    b.send({ type: 'chat', kind: 'video', value: 'st1' });
    await sleep(500);
    check(a.countFrom(aMark1, (m) => m.type === 'chat') === 0 &&
      b.countFrom(bMark1, (m) => m.type === 'chat') === 0,
      'server: free text / non-allowlist chat dropped');

    // 4) rate limit: a second valid chat within 800 ms is dropped;
    // after the window the next one goes through.
    await sleep(900);
    const bMark2 = b.msgs.length;
    a.send({ type: 'chat', kind: 'phrase', value: 'سلام' });
    await a.waitFrom(0, (m) => m.type === 'chat' && m.value === 'سلام', 'rate-limit first at A');
    a.send({ type: 'chat', kind: 'phrase', value: 'مننه' });
    await sleep(500);
    check(b.countFrom(bMark2, (m) => m.type === 'chat' && m.value === 'مننه') === 0,
      'server: chat faster than 1/800ms dropped');
    await sleep(900);
    a.send({ type: 'chat', kind: 'phrase', value: 'بیا!' });
    await b.waitFrom(bMark2, (m) => m.type === 'chat' && m.value === 'بیا!', 'rate-limit third at B');
    check(true, 'server: chat allowed again after the 800 ms window');

    // 5) a socket that never joined a room cannot chat into one.
    const d = await openClient();
    const bMark3 = b.msgs.length;
    d.send({ type: 'chat', kind: 'phrase', value: 'سلام' });
    await sleep(400);
    check(b.countFrom(bMark3, (m) => m.type === 'chat') === 0,
      'server: chat from a seat not in a room ignored');

    // 6) voice flags: mic/speaker are independent; they broadcast to
    // the room together and ride in state as {mic, speaker} objects.
    a.send({ type: 'voice', mic: true, speaker: true });
    const voiceB = await b.waitFor((m) => m.type === 'voice', 'voice at B');
    check(voiceB.seat === roomA.seat && voiceB.mic === true && voiceB.speaker === true,
      'server: voice broadcast carries mic+speaker to room members');
    b.send({ type: 'voice', mic: true, speaker: true });
    await c.waitFor((m) => m.type === 'voice' && m.seat === roomB.seat, 'voice B at C');
    a.send({ type: 'start' }); // any state push now carries the flags
    const stVoice = await c.waitFor((m) => m.type === 'state' && m.phase === 'playing', 'playing state at C');
    check(stVoice.seats[roomA.seat].voice.mic === true && stVoice.seats[roomA.seat].voice.speaker === true &&
      stVoice.seats[roomB.seat].voice.mic === true &&
      stVoice.seats[3].voice.mic === false && stVoice.seats[3].voice.speaker === false,
      'server: voice {mic,speaker} flags ride in state (bot seat fully off)');
    // speaker can drop while the mic stays live (flags are independent)
    a.send({ type: 'voice', mic: true, speaker: false });
    const spkOff = await b.waitFor((m) => m.type === 'voice' && m.seat === roomA.seat && m.speaker === false, 'speaker-off at B');
    check(spkOff.mic === true, 'server: speaker-off broadcast leaves mic flag untouched');
    a.send({ type: 'voice', mic: false, speaker: true });
    const voiceOff = await b.waitFor((m) => m.type === 'voice' && m.mic === false, 'mic-off at B');
    check(voiceOff.seat === roomA.seat && voiceOff.speaker === true,
      'server: mic-off broadcast reaches room members, speaker flag carried');
    // a legacy announce ({on}) still maps onto the mic flag alone
    c.send({ type: 'voice', on: true });
    const legacy = await a.waitFor((m) => m.type === 'voice' && m.seat === roomC.seat, 'legacy voice at A');
    check(legacy.mic === true && legacy.speaker === true,
      'server: legacy {on:true} maps to mic, speaker default preserved');
    c.send({ type: 'voice', mic: false, speaker: true });

    // 7) RTC signaling: reaches ONLY the addressed seat in the room.
    const cMark4 = c.msgs.length;
    a.send({ type: 'rtc', to: roomB.seat, data: { kind: 'sdp', sdp: { type: 'offer', sdp: 'v=0 test' } } });
    const rtcB = await b.waitFor((m) => m.type === 'rtc', 'rtc at B');
    check(rtcB.from === roomA.seat && rtcB.data.sdp.sdp === 'v=0 test',
      'server: rtc relay reaches the target seat with payload intact');
    await sleep(400);
    check(c.countFrom(cMark4, (m) => m.type === 'rtc') === 0,
      'server: rtc relay does NOT reach other seats');
    // …not a bot seat, and not when the payload exceeds ~16 KB.
    a.send({ type: 'rtc', to: 3, data: { kind: 'sdp', sdp: 'x' } });
    a.send({ type: 'rtc', to: roomC.seat, data: { kind: 'sdp', sdp: 'y'.repeat(17000) } });
    await sleep(400);
    check(c.countFrom(cMark4, (m) => m.type === 'rtc') === 0,
      'server: rtc to a bot seat and oversized rtc dropped');

    // 8) the room still works after all the dropped traffic.
    await sleep(900);
    a.send({ type: 'chat', kind: 'phrase', value: 'ښه لوبه' });
    await b.waitFor((m) => m.type === 'chat' && m.value === 'ښه لوبه', 'post-checks chat at B');
    check(true, 'server: room healthy after chat/rtc checks');
  } catch (e2) {
    check(false, 'server chat/rtc protocol checks', e2.message);
  } finally {
    clients.forEach((cl) => { try { cl.ws.close(); } catch (e3) { /* already closed */ } });
    srv.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
