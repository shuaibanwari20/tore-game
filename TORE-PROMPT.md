# TORE (توره) — Strong Build Prompt
## Online 4-player card game with Kandahari rules — build EXACTLY to this spec

You are a senior game developer. Build "TORE" — a 4-player online trick-taking
card game played in Kandahar, Afghanistan — exactly to the rules below. Do not
substitute rules from Hearts, Hokm, Tarneeb or any other game. Where this spec
says DEFAULT, implement it as a server-side constant so it can be changed in
one line.

### Players & deck
- 4 players, 2 teams of 2. Partners sit opposite each other.
- Standard 52-card deck, no jokers. 13 cards dealt to each player.
- Rank order within a suit: A (high), K, Q, J, 10, 9, 8, 7, 6, 5, 4, 3, 2.

### Kandahari card names (use these names in the UI)
- ♥ Hearts = **لال** (Laal)
- ♦ Diamonds = **خشت** (Khesht)
- ♣ Clubs = **پشه** (Pasha)
- ♠ Spades = **قره** (Qara)
- Jack = **غلام** (Ghulam) · Queen = **ماتکه** (Matka, the lady card) · King = شاه · Ace = آس

### Play of a round
- Trick-taking. The leader plays any card; the other three MUST follow the led
  suit if they hold it, otherwise they may play any card.
- DEFAULT: there is NO trump suit. The highest card of the led suit wins the
  trick. The trick winner collects the 4 cards and leads the next trick.
- A round = 13 tricks. First leader of a round rotates between rounds.

### Scoring cards — exactly 30 تاوان (tawan) in every round
- EVERY hearts (لال) card = 1 tawan → 13 tawan.
- Jack of clubs — **غلام پشه** (J♣) = 5 tawan.
- Queen of spades — **ماتکه کالا** (Q♠) = 9 tawan.
- 10 of diamonds — **ده خشت** (10♦) = 3 tawan.
- All other cards = 0. Total must always sum to 30 — assert this in code.

### Round scoring (the Tore rule — implement exactly)
- After the round, count each team's captured tawan. There are NO match
  points — only tawan, banked toward the match (below). Fewer is better:
  tawan is a penalty.
- BANKING («بندهای ده‌تایی» — ten-bands): a round's final tawan banks into
  the team's match-long bank (جمع‌شده) in whole tens: 0–9 → 0, 10–15 → 10,
  16–20 → 20, 21–30 → 30 (21 counts as 30). The final itself is never
  rewritten — banding applies only to what banks.
- TIE 15–15: the team that captured **ماتکه کالا** (Q♠) banks **20**
  instead of 10; the other team banks 10.
- TAKAN: leading a suit none of the other three players currently holds.
  It adds NO round tawan — it only creates a pending claim (★): at any
  round end, after banking, while the opposing team's banked total is
  ≥ 30, one claim moves exactly 30 banked tawan from that team to the
  takan team. If both teams takan in one round, the takans cancel PAIRWISE
  («تکان با تکان ادا می‌شود»): one takan from each team annihilate
  each other with no accounting, and only the majority team's surplus
  takans create claims — created[t] = max(0, count[t] − count[1−t]).
- «13» (up46 — owner-locked 2026-11-12, replacing the old final-trick-only
  declaration ENTIRELY): an always-available «13» button sits on the
  table, above the player's cards, on the LEFT side. Only the current
  leader (his turn, trick empty, round live) can use it: he presses it
  to ARM a declaration (pressing again disarms), then plays his lead
  card — the declaration is for that card's suit and the ROUND ENDS
  IMMEDIATELY in both outcomes (the lead card forms no trick). The
  server counts the cards of that suit in the OTHER THREE hands
  (partner included): count 0 → a CLEAN «13» — the round ends and the
  declaration creates nothing; count N > 0 → the DECLARING team is
  penalised with N pending takan claims (red stars, 30 each) AGAINST
  itself — **the stars land on the DECLARING TEAM ITSELF, in its own
  pending pool** (owner, 2026-11-12: «برای تیم من اضافه میشه»). Because
  banked tawan is a penalty (210 loses), HOLDING the claims is the
  burden, so the existing execution machinery handles them unchanged:
  after banking, while the OPPONENTS' bank is ≥ 30, each execution
  moves 30 from the opponents' bank into the declaring team's bank
  (carry-over otherwise, match-end checked after executions). The penalty claims do NOT go
  through pairwise takan cancellation; they join the pool before the
  round's execution loop and can execute the same round. Card tawan
  already captured in tricks before the declaration still banks
  normally (ten-bands on the partial sums); only the unplayed
  remainder of the round is discarded.

### Match
- The team whose BANKED tawan (جمع‌شده) reaches **210** LOSES the match;
  the other team wins. (Checked after the round's banking and any claim
  executions.)
- Edge case: if both teams cross 210 in the same round, the HIGHER banked
  total loses; if the totals are exactly equal, play one more round.

### Online multiplayer (required)
- Realtime server (Node.js + WebSocket) authoritative for deck, turns, rules.
- Rooms: a player creates a room and gets a short code; 3 friends join with
  the code. Empty seats may be filled with simple AI bots so a game can start.
- Reconnect: a dropped player rejoins the same seat with the same hand.
- Clients: mobile-first web (works in phone browser), Persian/Dari UI using
  the Kandahari names above, big readable cards, team score board showing
  captured tawan live and the banked tawan (جمع‌شده) — reaching 210 loses.
- No real-money betting, no payments — tawan only, no points.

### Bot policy (empty seats are filled with bots)
- Bots play AVOIDANCE + FEED THE OPPONENTS: duck tawan tricks, dump
  قره Q♠ / پشه J♣ / خشت 10♦ / لال onto opponents' winning tricks, never
  feed their partner; forced wins use the lowest sufficient card.
- NO-REPEAT TAKAN LAW (owner order, 2026-11-09 — «فقط دفعهٔ اول تکان
  حساب می‌شود»): **a bot takans each suit at most once per round.**
  A bot NEVER leads a suit it has already takan'd this round while it
  still holds any card of another suit — the other suits are played to
  exhaustion first (absolute, not a preference). When only the
  already-takan'd suit remains, the bot leads it, but the repeat
  creates NO claim: per bot, per round, per suit, only the FIRST
  takan counts (the engine suppresses a bot seat's repeat silently;
  the partner's first lead of the same suit is the partner's own first
  and still counts). Humans are unaffected in all cases: every human
  takan counts.
- BOT «13» POLICY (up46): a bot declares «13» ONLY on a PROVABLY clean
  call — its card counting (played + own = 13 for the suit, so nobody
  else can hold it) — AND only when ending the round now is not worse
  for its team (its team has captured no more tawan than the
  opponents). It never declares on a guess: a wrong call would cost
  its own team one claim per held card. (bots.plan13.)

### Acceptance checks before delivery
1. Dealing gives 13/13/13/13 and a full 52-card deck, no duplicates.
2. Follow-suit is enforced; illegal plays are rejected by the server.
3. Scoring cards in any simulated round always total exactly 30.
4. Banking follows the ten-bands (0–9 → 0, 10–15 → 10, 16–20 → 20,
   21–30 → 30); on a 15–15 tie the Q♠ captor's team banks 20, the other 10.
5. A full simulated match ends exactly when a team's banked tawan reaches
   210 — and that team loses.

### Home reskin — Ludo Star home (owner order 2026-11-09, ?v=20261109-ludomenu)
- The HOME screen wears his Ludo Star home screenshot, in the club
  discovery's magenta-purple family: purple gradient + diamond-pattern
  field (pure CSS — the landing no longer references the carpet; the
  build's ONE remaining CSS carpet reference is the game table's, and
  the landing's card fans are inline SVG, so build-deploy.js inlines
  no hero images any more).
- Top bar: gold-ringed avatar + name pill (plum) at the start, the
  settings gear as a glossy dark round at the far end. NO currency /
  level pills and NO ad rail — Tore has none (never fake counters).
- TWO BIG glossy cards: انلاین PURPLE on the RIGHT, bots ORANGE/GOLD
  on the LEFT (his settled positions), each with an ORIGINAL inline-SVG
  fan of Tore cards (Q♠ front on online, J♣ front on bots — no dice,
  no Ludo art). Taps keep the exact old flows (online = the online
  create path; bots = instant bot match / quick play).
- THREE SMALL glossy cards: ساخت اتاق (create room), ورود با کد
  (join-by-code popup), بازی با دوستان (opens the friends page — the
  same openFriends flow as the nav). The old rules small card MOVED
  into the settings sheet (#btn-rules / #rules-txt kept; the sheet
  closes first, then the same legend view opens).
- BOTTOM NAV (shared shell component): chunky purple bar, glossy
  icons; the ACTIVE screen's item is raised in a BRIGHT MAGENTA bubble
  (on home that is the centre item, کور). Slots unchanged: ملګري،
  کلبونه، کور، پروفایل، چت — every behavior, badge and active state
  preserved; clubs still hide their nav copies (v6.1); the game
  TABLE is untouched (emerald carpet).

### Home reskin round 2 — closer to the full Ludo home (owner order 2026-11-09, ?v=20261109-ludomenu5)
- BACKGROUND deepened to the reference's WINE-PLUM (#4a0727 →
  #a1185c family, diamond lattice fainter) and a FAINT oversized
  «توره» watermark with a small crown (.hm-wm, first child of
  #home-main, ~5% white) sits behind the cards area, like the
  reference's ghosted logo.
- TOP BAR: the settings gear is now a BARE glossy white cog (filled
  SVG, drop shadow — the dark disc is gone), like the reference's
  corner gear. Avatar + name pill unchanged; still NO currency /
  level pills.
- BIG CARDS: the fans are BIGGER (172 px) and OVERFLOW the card's
  top edge (fan top −34 px; card overflow visible, sheen clipped by
  border-radius): three layered cards with thick borders + gold
  inner trim on the front card, gold suit COINS at the fan's feet
  and a sparkle. انلاین purple RIGHT (Q♠ front), روبات‌ها orange
  LEFT (J♣ front); labels, handlers, flows unchanged.
- SMALL CARDS: the magenta icon disc is replaced by an icon CLUSTER
  overflowing the card's top edge: create = fanned mini cards +
  gold «+» token; join = gold key + «#» coin + violet dot token;
  friends = two glossy avatar faces + pink/green chat bubbles.
  Handlers unchanged.
- BOTTOM NAV: the flat white glyphs are replaced by LARGE (46 px,
  52 px on the active) colorful 3D-style ORIGINAL SVG icons — چت =
  pink/green bubbles, ملګري = three busts, کور = white house with
  gold roof, کلبونه = gold trophy, پروفایل = person bust (shared
  gradient defs injected once after <body>: nvGold/nvPink/nvGreen/
  nvBlue/nvWhite). The ACTIVE item is a RAISED MAGENTA PANEL
  (margin-top −32, flush with the bar's bottom edge — the item
  carries the bottom padding now) with its icon on top and the
  label inside, generalized from the old bubble to whichever item
  is active. Slots, DOM order, badges, behavior unchanged; clubs
  still hide the nav; the game TABLE is untouched.
- Deviations (unchanged from round 1): no currency/level pills,
  no 0/50 pill, no ad/dice rail, no locked event tiles, no sale
  banner — Tore has none of these; no fake counters, no dead
  buttons, no Ludo artwork or branding.

### Ludopages — profile / settings / friends in the Ludo card language (owner refs 2026-11-09, ?v=20261109-ludomenu6)
- PROFILE PAGE (#scr-profile) wears his Ludo profile card: magenta
  body inside a 3 px gold frame, a glossy red ribbon ✖ at the top
  corner that goes HOME (additive — the bottom nav stays). Header
  rows: avatar (gold ring) + name + purple pencil chip (opens the
  edit box focused on the name), flag + country + pencil chip (same
  box, country). The edit box (existing #pf-name / #pf-country /
  save / close) starts hidden behind the pencils. Centre: the
  selected avatar / Google photo LARGE (128 px) in a rounded gold
  frame; its ✏️ chip (now a purple pencil chip) opens the EXISTING
  avatar picker; the avatar's display name sits under it. Then the
  «شمېرې» stats panel — label/value rows with REAL data only:
  د لوبغاړي پېژند = the permanent 6-digit server ID (tap-to-copy,
  unchanged), ملګري = friends count from the social state,
  کلب = his club's name or «هیڅ», هیواد = his country. Header +
  stats repaint live (profile edits, s-friends, s-club pushes).
  NO level / coins / wins — Tore does not track them; no fake rows.
- SETTINGS sheet (#ov-settings) wears his Ludo settings card:
  magenta + gold frame, orange ribbon ✖ (same close as the old
  close button / backdrop tap). زبان row: current language name +
  purple pencil chip that reveals the existing three .st-lang
  choices (switching logic untouched). Rows panel: د لوبې قوانین
  (existing rules entry), then TWO REAL switches with gold-bordered
  square checkboxes (green ✓ when on), persisted in localStorage:
  رېږدل vibration (tore.set.vibrate, default OFF — buzz(25) on his
  card play, buzz([45,40,45]) when his team wins a match; guarded
  for iOS where navigator.vibrate is undefined) and د لوبې چټ game
  chat (tore.set.chat, default ON — OFF hides the table #btn-chat
  and toggleChatPanel cannot open the panel), then وتل (existing
  logout). Sound / notifications rows OMITTED — no systems behind
  them. Footer: «د نورو لپاره موږ تعقیب کړئ» + an Instagram tile
  linking to https://www.instagram.com/shuaibanwari20 (_blank).
- FRIENDS page: VISUAL LANGUAGE ONLY — a wooden-sign header (CSS
  wood-plank plaque, two nails, gold «ملګري») tops #scr-friends;
  the screen wears the home's wine-plum field; the search-by-ID and
  blocked top actions are glossy magenta tiles (same ids/flows);
  request + friend sections are magenta/lavender cards. Presence
  dots, «🔔 بلنه» invite, busy gamepad state, 10 s ⏳ cooldown and
  the one-popup rule are untouched. NO Facebook tab/button (his
  pick: look-only), NO rewards list. DM screen untouched.
- All new labels via STR (pfStatsTitle/pfStatId/pfStatFriends/
  pfStatClub/pfStatCountry/pfStatNone/pfEditName/pfEditCountry/
  stFollowUs/setVibrate/setChat) in ps/fa/en.
