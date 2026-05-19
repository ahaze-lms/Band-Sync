# BandSync — Design Document v18

> Updated 2026-05-18. Supersedes v17.
>
> Major changes from v17: **Remote warm-up countdown** ("STARTING IN X") during the 8s lead time. **Lobby warmup panel** — device picker (keyboard/MIDI) + playable piano or drum canvas below the lobby cards so players warm up before the song starts. **Mobile-friendly pass** — new 480px breakpoint, 44px touch targets, lifted dark-navy theme for daylight readability. **Personal replay** — records every noteOn during a run, lets you watch your own performance back from the results screen; `onRawInput` + `injectInput()` added to gameplay-engine.

---

## 🚦 Current state (2026-05-18)

**`play.html` — the real game** (production gameplay surface, live):
- Song select pulling from a generated `songs/manifest.json`
- Setup screen: Speed (1–10) + Difficulty (1–7) selectors at top; per-player identity (Me / Friend / Guest) × instrument × MIDI device × track below
- **Computer Keyboard** is a first-class device option with mutex (only one slot per machine) — QWERTY → MIDI mapping covering 2 octaves
- Identity persists across song-select ↔ setup ↔ game ↔ results loops AND across page reloads via §26 Evolution v2 durable session attachments (24h token TTL, revocable from Connected Devices). Paired-friend dropdown for one-tap reattach without a fresh code.
- Gameplay using the extracted, parameterised `js/core/gameplay-engine.js` (1–N players)
- 1 / 2 / 3 / 4-player grid layouts; score strip on top of each panel, canvas fills via `object-fit: contain`
- **Warm-up state** before count-off: engine alive (audio + input responsive) so players can find their hand position before clicking ▶ START SONG
- **Always-on note name labels** on falling blocks (C, F#, D…) — teaches recognition by exposure regardless of input device. Keyboard players see the QWERTY key as a secondary hint.
- **ResizeObserver-driven crisp canvas** — pixel buffer matches `displaySize × devicePixelRatio` so the keyboard renders sharp at any size (4K, mobile, anything between)
- Live per-player score card, hit-feedback overlays, song timer, pause / restart
- Results screen: per-slot scores + grade + identity, NEW PERSONAL BEST badge when host beats their own PB
- **Personal replay** — every noteOn/noteOff during a run is recorded in memory; "⏪ REPLAY" button on results replays your exact performance back through the engine with all scoring live, using a rAF injector loop. `ctx.isReplay` guard prevents re-recording during playback. `injectInput(playerIdx, note, velocity)` on the engine public API feeds synthetic events through `dispatch()`.
- End-of-song persistence writes one `play_sessions` row + N `play_session_slots` rows (records actual speed/difficulty used)
- Personal best displayed under each song on setup ("YOUR BEST: 14,400 · S · 98% · 2d ago")
- **Mobile-friendly pass** — 480px breakpoint: 44px touch targets, hidden non-essential meta (BPM, PGMW), stacked lobby actions, shrunk feedback overlays. Theme lifted from near-black to visible dark-navy (`--bg: #101022`, `--bg2: #18182e`, `--bg3: #1e1e34`) for daylight readability on phones.

**Player identity** (`§26` + `§26 Evolution v2`):
- Friend generates a 6-digit code in their profile's PAIRING card (snapshots their identity, 10-min TTL, single-use)
- Host claims it at `play.html → setup → IDENTITY: Join with code…` (6-digit modal, paste-friendly)
- On claim, Supabase issues a durable **session token** stored in localStorage — reloads call `attach_session(token)` to rehydrate the friend identity without a fresh code. 24h TTL.
- Previously-paired friends show up as one-tap options in the identity dropdown (no code needed for re-pairing within the token window)
- Friend's profile shows RECENT ACCOUNT ACTIVITY (used codes audit log) + CONNECTED DEVICES (active attachments with Revoke buttons)
- Opportunistic cleanup runs inside `claim_device_code` — expired/revoked attachments >30d and used codes >90d get pruned automatically

**Remote multiplayer** (`§27`) — all phases shipped:
- `lobbies` + `lobby_participants` schema with full RLS (recursion-fix helpers, host vs participant visibility)
- `create_lobby` + `join_lobby` RPCs (atomic, lowest-free-slot assignment, idempotent re-joins)
- `js/services/lobbies.js` — create/join/leave/setReady/kick/setStartAt/setState/listParticipants + `subscribeLobby` Realtime helper + `measureClockOffset()`
- `play.html` SPA gains a LOBBY state. Song-select MODE toggle (SOLO/COUCH ↔ REMOTE LOBBY). Remote-mode song click creates a lobby and routes there. `?lobby=<id>` URL param auto-joins on boot for shareable invite links.
- Live roster + ready states via Supabase Realtime (per-lobby channel). Host gets KICK + START. Participants get READY UP + LEAVE. Host-abandon detection on guest side with auto-exit.
- **Clock sync (phase 5):** `get_server_time()` RPC; `measureClockOffset()` runs in background on lobby entry. Host clicks START → measures offset → writes `start_at = serverNow + 8s` + state='starting'. Non-host: Realtime delivers `start_at`, converts to local `performance.now()` via offset, `launchRemoteGame()` launches immediately. Each client runs a single-player game (their own slot), started at the same wall-clock instant. **"STARTING IN X" countdown** in the game-time display ticks down the 8s lead before the count-off fires (`ctx.remoteCountoffStartsAt` checked each rAF tick in `startGameTimer()`). Verified working end-to-end.
- **Lobby warmup panel** — device picker (Computer Keyboard or any connected MIDI device) in participant row + a live playable canvas below lobby cards. Piano: shows keyboard only (CSS crop — container `height: 140px; overflow: hidden`, canvas `position: absolute; bottom: 0; height: 520px`). Drums: shows full drum-pad view. Switching instrument or device calls `rebuildLobbyWarmup()` immediately (reads DOM before DB round-trip). `stopLobbyWarmup()` cleans up on state change.
- **Phase 8 RLS:** `user_in_lobby_session()` helper + `pss_insert_self_in_session` + `pss_select_in_lobby_session` — remote players write and read their own slot rows.

**HISTORY screen** — every session you appear in, grouped by date, with PB badges. RLS-correct: hosted sessions show all slots, joined sessions show only yours.

**`2player.html` — prototype + dev harness** (reached via Dev Lab). NOT migrated to the new engine; `js/screens/gameplay.js` still has its own loop. Has unique features (role toggle, test patterns, file picker, calibration overlay) that the production game doesn't expose yet.

**Social / account layer** (`index.html`):
- Email/password auth via Supabase
- Profiles (username, display name, avatar, accent color, tagline)
- Friend requests, friend list, online presence, real-time inbox, play invites
- Profile setup onboarding

**Dev Lab** (`lab.html`) — hub linked from the main nav.

**URL convention:**
- `play.html` — real game (production)
- `2player.html` — prototype + dev harness
- `studio.html` — Song Creator (stub only; build is next major effort)

### What's next

**Immediate (§27 finish line):**

1. ✅ ~~**§27 phase 5 — clock sync**~~ — shipped. `get_server_time()` RPC + `measureClockOffset()` + synchronized `engine.start({ countoffStartsAt })`. Verified working.
2. ✅ ~~**§27 phase 6 — score sidebar**~~ — shipped. Supabase Broadcast channel (`game:<lobbyId>`), ~1Hz throttle, slim strip above game canvas showing all remote players' live score / grade / accuracy.
3. ✅ ~~**§27 phase 7 — end-of-song**~~ — shipped. Host creates `play_sessions` header + stamps `session_id` on lobby row + writes own slot. Non-hosts poll `getLobby()` (1.5s interval, 30s timeout) until `session_id` appears, then write their slot via `pss_insert_self_in_session`. All players' HISTORY shows the same shared session.
4. ✅ ~~**§27 phase 8 — RLS extension**~~ — shipped. `pss_insert_self_in_session` + `pss_select_in_lobby_session` live.

**Major candidates:**

1. **`studio.html` — Song Creator** (§25). Biggest unbuilt thing. Spec ready: live MIDI record, quantize, instrument-specific piano roll, save to Supabase, async collaboration, publish to library.
2. **Drum-track playback in bundled songs** — needs a GM drum-map translation pass in the MIDI parser pipeline so drum tracks reach the engine as abstract names. Today's library is all piano.
3. **Calibration in `play.html`** — extract the 2player calibration overlay into a shared `js/ui/calibration-overlay.js` module, then wire it into the play.html setup screen.
4. **Real piano + drum samples** — replace synth with samples. Biggest perceptual upgrade per §18.
5. **Phase 3c — port `js/screens/gameplay.js`** to the new engine, eliminating the duplicate loop. Pure cleanup; deferred unless 2player.html starts getting active engine changes.

**Smaller polish items:**

- ~~**Lobby chat** — shipped. Ephemeral Broadcast chat on `lobby:<id>` channel.~~
- ~~**Remote warm-up countdown** — shipped. "STARTING IN X" counts down the 8s lead in the game-time display.~~
- ~~**Lobby warmup instrument + device picker** — shipped. Device select in participant row + live piano/drum canvas below lobby cards.~~
- ~~**Mobile pass + theme lift** — shipped. 480px breakpoint, 44px touch targets, dark-navy theme variables.~~
- ~~**Personal replay** — shipped. Records actual performance during a run; "⏪ REPLAY" button on results re-runs it through the engine.~~
- **History integration for replay** — `ctx.lastReplayLog` is in-memory only (lost on reload). Could serialise and store in `play_session_slots` as a JSONB column for persistent replay.
- Twilio SMS invites (§26 → Future enhancements)
- Connected-devices "revoke all" button
- In-game banner when a friend is attached (currently a small chip in the game header)
- Accuracy-bar animations on the results screen
- 3-4 player hardware-tested gameplay (layout exists; needs real devices)

### Open architectural decisions

- Pricing tiers ($/mo)
- Domain name
- AI scope — which Studio capability ships first (see §14, §25)

---

## 1. Vision

BandSync is a browser-based, Synthesia-style rhythm game for up to 4 players, with a built-in AI-assisted MIDI editor for creating and modifying songs.

**Core promise:** the fastest way to put four people in front of four instruments and have them play a song together. Pick up your instrument, plug it in, hit notes as they fall. Plus: AI tools that turn anyone into a usable songwriter — generate charts, simplify songs for kids, suggest harmonies, fill in missing tracks.

**Audience:** families with kids learning music, casual music makers, music teachers, hobbyist bands.

**Target experience:** Guitar Hero meets Synthesia meets Ableton, browser-first, MIDI-instrument-driven, AI-augmented.

---

## 2. Product Surface

What users see, at a glance:

| Surface | What it is |
|---|---|
| **Game** | 1–4 player rhythm gameplay, falling notes synced to a MIDI song, scoring, results |
| **AI Studio** | Piano-roll MIDI editor with Claude-powered suggestions (add bass line, simplify, harmonize, etc.) |
| **Library** | Personal song collection — bundled songs + user-uploaded MIDIs + AI-generated charts |
| **Profile** | Per-user stats, history, calibrations, drum mappings, instrument preferences |
| **Multiplayer setup** | Profile select → device assignment → song select with track-to-player mapping |

---

## 3. Pricing & Paywall (planned)

| Tier | Includes |
|---|---|
| **Free** | Solo + 2-player gameplay, included song library, AI chart simplification (limited daily uses) |
| **Pro** (`$X/mo`) | 3–4 player gameplay, unlimited custom MIDI upload, full AI MIDI editor, AI song generator, audio→MIDI conversion, replay system |
| **Family** (`$Y/mo`) | Pro features + multiple user accounts under one bill |

Feature gates check user tier before unlocking. Stripe Checkout for subscriptions; webhooks reconcile renewals and cancellations. Final pricing TBD.

---

## 4. Technology Stack

### Current (frontend, working today)
- **HTML5 + CSS3 + Vanilla JavaScript (ES modules)** — no frameworks, no build tools
- **Web MIDI API** — Chrome only, device discovery and input
- **Web Audio API** — synthesis, AudioContext singleton
- **HTML5 Canvas** — per-player view rendering
- **localStorage** — profiles, calibrations, drum mappings (temporary, migrates to server when accounts ship)

### Hosting (current)
- **GitHub Pages** — live at <https://ahaze-lms.github.io/Band-Sync/>, auto-deploys on push to `main`
- **Local dev (optional):** `python -m http.server 8000` — only needed for offline work; live site is the primary target

### Backend (current — implemented)
- **Supabase** — Postgres + Auth + Realtime. Project: `pmccwxovzhfdkuqzhkez.supabase.co`
- **Auth:** email + password via Supabase Auth
- **Realtime:** Supabase channels for live inbox events (messages, play invites, friend requests)
- **Vendor:** `js/vendor/supabase.umd.js` — bundled locally to eliminate CDN latency

### Planned
- **AI:** Claude API (Anthropic) for the MIDI editor + chart generation (see §14)
- **Payments:** Stripe Checkout + webhooks
- **OAuth:** Google sign-in (future, after core features ship)

---

## 5. Architecture

The codebase is a flat ES-module project. No frameworks, no build step. Browser loads `index.html` and `<script type="module">` imports resolve at runtime.

```
Band-Sync/
├── index.html              App shell / hub page
├── README.md
├── DESIGN.md               ← this file
├── css/                    Shared stylesheets (in progress)
├── js/
│   ├── config.js           Constants (timing values, hit windows, scoring, colors)
│   ├── core/               Engine modules (singletons or factories)
│   │   ├── timing.js       Song clock, count-off, speed/hit-window
│   │   ├── audio.js        AudioContext, synth (piano + drums + click)
│   │   ├── scoring.js      createScorer() factory per player
│   │   ├── midi.js         Web MIDI wrapper, per-device routing
│   │   ├── calibration.js  Latency offset storage + round math
│   │   ├── midi-parser.js  Multi-track .mid file parser
│   │   └── drum-mapping.js Per-device drum-name lookup
│   ├── render/             Canvas renderers (one per instrument view)
│   │   ├── piano.js        (Stage 5)
│   │   └── drums.js        (Stage 5)
│   ├── input/              MIDI-to-game input mapping (optional layer)
│   ├── screens/            Top-level screens
│   │   ├── gameplay.js     (Stage 6: 2P split; 3-4P later)
│   │   ├── results.js      (planned)
│   │   ├── library.js      (planned)
│   │   ├── studio.js       (AI MIDI editor — planned)
│   │   └── profile.js      (planned)
│   └── services/           (planned) API client, auth client, AI client, payments client
├── songs/                  Bundled .mid files
└── debug/                  Standalone debug tools (piano_debug, drum_debug, etc.)
```

### Architectural principles

1. **Game logic is local; sync is asynchronous.** The audio clock is local to the browser and never depends on network. The server is for persistence + auth + AI + payments — never for real-time gameplay timing.

2. **Abstract drums, never raw MIDI notes.** Game logic only knows `KICK`, `SNARE`, `HH_CLOSED`, etc. A per-device mapping translates MIDI numbers to these names. Swapping a kit = swapping a mapping file. This generalizes to bass/guitar/vocals when added.

3. **Modules over classes, factories where state is needed.** `createScorer()` returns a fresh per-player scorer; the timing engine is a singleton because there is only ever one song clock.

4. **No build step, ever.** Files are served as-is. Modules import directly. Refresh to see changes.

---

## 6. App Flow

Logged-out:
1. **Auth** ✅ — sign in / sign up with email + password

Logged-in (social layer):
2. **Home** ✅ — PLAY NOW button, friends panel, pending requests, play invites
3. **Friends** ✅ — search players, send/accept/decline requests, invite to play, message
4. **Inbox** ✅ — real-time direct messages between friends
5. **Profile edit** ✅ — username, display name, avatar, accent color, tagline

Gameplay flow (future integration with social layer):
6. **Profile select** — pick which logged-in users are playing today
7. **Device assignment** — assign MIDI device + role per player, test input
8. **Song select** — pick from library; assign tracks to players; shared/dueling option
9. **Count-off** — mandatory 4-beat count-in, notes fall during count-off
10. **Gameplay** — 1-4 panels, falling notes, HUD per player, pause
11. **Results** — scores, accuracy, grade, personal-best flags, dueling winner
12. **Replay** (paid) — visual + audio playback, expected vs actual side-by-side
13. **Profile + progress** — all-time stats, per-song history, accuracy graph
14. **AI Studio** — piano-roll MIDI editor with Claude suggestions (planned)
15. **Library** — saved songs, custom uploads, AI-generated charts (planned)
16. **Settings** — volume, calibrations, drum mappings, account (planned)
17. **Subscription** — tier, upgrade, billing portal via Stripe (planned)
18. **Admin** — user list, friend graph, message log, data management (planned — admin-only)

---

## 7. Player Profiles & Accounts

**Two profile types coexist:**

- **Local profile** — works without an account, stored in localStorage. Quick start for casual play. Limited to one browser.
- **Cloud profile** — tied to a user account. Syncs across devices. Required for paid features.

**Profile fields:**
- Name (string)
- Avatar (one of ~10 instrument icons)
- Accent color (used for notes, score card, key highlights)
- Tagline (optional, e.g. "Destroyer of snares")
- All-time stats: songs played, best accuracy, favorite song, hours played
- Per-song personal bests
- Session history (every song played: date, score, accuracy, grade)
- Per-device calibration offsets
- Per-device drum mappings
- Keyboard range preferences per song

**Sync model:** Cloud profile is the source of truth when signed in. Local profile gets merged into cloud profile on sign-in (offered as a one-time prompt). Offline play continues to work using a local cache.

---

## 8. Gameplay Engine — Timing

This is the same timing system documented in v8 §7. **Do not change without careful testing.**

### Song clock
```js
const fallTimeMs = getFallTimeMs();
songStart = performance.now() - (COUNTOFF_TOTAL_MS - fallTimeMs);
```
The song clock starts *pre-rolled* so the first note (`startMs = 0`) reaches the hit zone exactly as the count-off ends.

### Time queries
```js
getSongTime() = performance.now() - songStart - pauseOffset
```
Returns `-1` if the clock isn't running. Negative during count-off until beat 1 lands.

### Spawn rule
A note spawns at `y = 0` (top of highway) when `songTime >= note.startMs`. It travels at `pxPerFrame * (delta / 16.67)` for delta-time correction.

### Hit detection
```js
expectedHitTime = note.startMs + fallTimeMs + userOffset
diff = |songTime - expectedHitTime|

if diff <= hitWindow.perfect → PERFECT
if diff <= hitWindow.good    → GOOD
```

### Miss detection
A note becomes a miss when `songTime - expectedHitTime > hitWindow.good` and the note has spawned. *Known issue:* miss detection currently doesn't include `userOffset`. Will align in a future cleanup pass.

### Constants
```
HIGHWAY_H        = 400  (px)
HIT_Y            = 396  (HIGHWAY_H - 4)
PREVIEW_ZONE     = 120  (HIGHWAY_H * 0.3)
COUNTOFF_BEATS   = 4
COUNTOFF_BPM     = 80   (will match song BPM in future)
BEAT_MS          = 750  (at 80 BPM)
COUNTOFF_TOTAL_MS = 3000
```

---

## 9. Speed System

Speed is defined as **fall duration in seconds**, not pixels per frame. Intuitive and frame-rate-independent.

| Level | Fall time | Feel | Designed for |
|---|---|---|---|
| 1 | 4.0s | Very slow | Absolute beginners |
| 2 | 3.5s | Slow | Beginners |
| 3 | 3.0s | Comfortable | **Default** |
| 4 | 2.5s | Moderate | Casual |
| 5 | 2.0s | Standard | Normal play |
| 6 | 1.7s | Fast | Experienced |
| 7 | 1.4s | Very fast | Advanced |
| 8 | 1.1s | Intense | Expert |
| 9 | 0.8s | Extreme | Master |
| 10 | 0.5s | Insane | Bragging rights |

---

## 10. Hit Windows

7 difficulty levels. PERFECT window in ms / GOOD window in ms.

| Level | Name | PERFECT | GOOD | Notes |
|---|---|---|---|---|
| 1 | Practice | ±250 | ±500 | Very young kids — quarter-second tolerance |
| 2 | Beginner | ±180 | ±350 | Building motor timing |
| 3 | Very Easy | ±120 | ±200 | Casual family play |
| 4 | Easy | ±80 | ±160 | **Default** — comfortable adult play |
| 5 | Normal | ±40 | ±80 | Standard rhythm-game feel |
| 6 | Hard | ±25 | ±50 | Experienced players |
| 7 | Expert | ±15 | ±30 | Tighter than Guitar Hero |

Future: hit window will be derived from difficulty level, not a separate slider.

---

## 11. Scoring

- PERFECT: 100 pts × multiplier
- GOOD: 50 pts × multiplier
- MISS: 0 pts, **breaks combo**
- WRONG: 0 pts, **does not break combo** (tracked separately as keypresses with no spawned target)

Combo multiplier tiers: x1 → x2 → x4 → x8, every 10 consecutive scored hits.

| Grade | Accuracy |
|---|---|
| S | 95%+ |
| A | 85–94% |
| B | 70–84% |
| C | 50–69% |
| D | <50% |

`Accuracy = (perfect + good) / (perfect + good + miss) × 100`

---

## 12. Latency Calibration

Every player + every MIDI device pairing has its own latency. Calibration measures it and compensates.

**Flow:** 3 × 10-second rounds at 80 BPM. Player taps each flash; the engine averages the offset between flash time and tap time. Fine-tune with −10 / −1 / +1 / +10 buttons. Apply & save.

**Storage today:** `localStorage` keyed by device name. Migrates to per-profile cloud storage when accounts land — legacy keys stay readable so calibrations aren't lost.

**Observed offsets:**
- Casio CDP-S160RD piano: ~−111ms (player hits early)
- Simmons SD5X drums: ~−182ms (player hits early)

---

## 13. Backend — Supabase (implemented)

**Decision made: Supabase.** Implemented and live.

### Database schema (`supabase/schema.sql`)

| Table | Purpose |
|---|---|
| `profiles` | One row per user — username, display_name, avatar, accent_color, tagline, is_online, last_seen_at |
| `friend_requests` | from_id → to_id, status: pending / accepted / declined |
| `messages` | from_id → to_id, body, read_at |
| `play_invites` | from_id → to_id, song_id, status, expires_at (5 min TTL) |
| `songs` | Song projects — owner, BPM, visibility (private/friends/public), remix_of, full track+notes JSONB blob |
| `song_collaborators` | Junction — which user can edit which track slot of which song |

All tables have Row Level Security. Users can only read/write their own data or data they're party to. A Postgres trigger auto-creates a `profiles` row on every new `auth.users` insert.

### Realtime

All four tables are in the `supabase_realtime` publication. The `subscribeToInbox()` function in `js/services/social.js` sets up a Supabase channel per user that pushes new messages, play invites, and friend requests in real time.

### Admin

**Current:** Supabase Dashboard → Table Editor (view/edit all rows like a spreadsheet).

**Planned:** In-app `/admin` screen — see §19 roadmap.

---

## 14. AI Tools

The AI surface is what makes BandSync defensible vs other rhythm games. Three concentric circles of capability:

### Inner circle — quick wins, ship first
- **Auto-simplify** — take any MIDI, produce easier variants (kids / beginner / intermediate / expert). Claude API given the source MIDI, returns a simplified MIDI.
- **Difficulty grading** — auto-rate each song 1–10. Claude API analyses note density, speed, hand-span requirements, etc.
- **Practice tips** — "Bar 14 is tricky because of the rhythm change. Practice it at 0.5x first." Claude API given a song + the player's history.

### Middle circle — flagship AI feature
- **AI MIDI editor** — piano-roll UI with a Claude-powered side panel:
  - "Add a bass line"
  - "Make the drums busier"
  - "Harmonize this melody in thirds"
  - "Change this section to 6/8"
  - "Generate a kick pattern that matches this guitar riff"
- Workflow: user uploads or starts a MIDI, edits in the piano roll, asks Claude for changes via natural language, accepts/rejects suggestions, saves to library.

### Outer circle — bigger investment, later
- **AI song generator** — pick genre / tempo / length / instruments, get a 4-track MIDI suitable for rhythm gameplay. Needs prompt engineering + style controls.
- **Audio → MIDI** — upload an MP3, get a playable chart. Requires audio analysis ML; either an existing API (Klangio, AnthemScore, basic-pitch) or trained models. Hardest of the four.

### What we're explicitly **not** building
- AI audio synthesis from text ("write me a song" → audio). Suno and Udio dominate; we'd lose. Stick to MIDI domain where we can win.

---

## 15. Instruments & 4-Track System

A song is one MIDI file with up to 4 tracks. At song-select time each player independently picks any track from the song — multiple players are allowed to pick the same track.

### Roles (current + planned)
- **Piano** — falling notes on a keyboard view (built ✓)
- **Drums** — falling notes per drum lane (built ✓)
- **Bass** — falling notes on a 4-string fretboard view (planned, v1.5)
- **Guitar** — falling notes on a 6-string fretboard view (planned, v2.0)
- **Vocals** — pitch-contour line with lyrics (planned, v2.5)

Any subset of players can share a track ("dueling") — same notes, independent scores. With 4 players this could be 4-on-1, 2+2, 3+1, etc. — there's no exclusion in the picker.

### Drum-mapping abstraction
Drum tracks store abstract names (`KICK`, `SNARE`, `HH_CLOSED`, ...) so any physical kit works once mapped. This pattern generalizes:
- Bass: abstract string/fret pairs
- Guitar: abstract string/fret pairs (+ chord shapes)
- Vocals: abstract pitch class + lyric syllable

---

## 16. Visual Design

- Dark base (`#0a0a0f`)
- Per-player accent color runs through their notes, score card, key highlights
- Sharp typography, minimal decoration, no skeuomorphism
- Mixed-age aesthetic — fun for kids, clean for adults

**Layout by player count:**
| Players | Layout |
|---|---|
| 1 | Full screen — single highway |
| 2 | Top / bottom panel (good for piano + drums) |
| 3 | Two panels top, one full-width bottom |
| 4 | 2×2 quad grid |

---

## 17. Drum Mapping Reference

Default Simmons SD5X mapping (used as starting point until calibrated):

| MIDI Note | Abstract Name |
|---|---|
| 75 | KICK |
| 54 | SNARE |
| 31 | HH_CLOSED |
| 40 | HH_OPEN |
| 68 | HH_PEDAL |
| 19 | TOM_1 |
| 79 | TOM_2 |
| 37 | TOM_3 |
| 46 | CRASH |

Abstract names recognized today: `KICK`, `SNARE`, `SNARE_RIM`, `HH_CLOSED`, `HH_OPEN`, `HH_PEDAL`, `TOM_1`, `TOM_2`, `TOM_3`, `CRASH`, `RIDE`, `RIDE_BELL`.

---

## 18. Audio System

**Today:** synthesized.
- Piano: triangle-wave oscillator at correct pitch, 0.8s decay
- Drums: per-name recipe (sine sweep for kick, bandpass noise for snare, highpass noise for hi-hat, etc.)
- Click: 880 Hz sine, 60ms decay

**Planned:** real samples.
- Piano: one sample per octave, pitch-shifted via `AudioBufferSourceNode`
- Drums: one sample per abstract name
- Sources: Freesound.org, MIDI.js Soundfonts (free/CC-licensed)

---

## 19. Build Roadmap

### v0.x — Prototype (current)
- ✅ Modular refactor — shared engine modules under `/js/core`
- ✅ Piano debug + drum debug on shared modules
- ✅ Render module extraction (`render/piano.js`, `render/drums.js`)
- ✅ 2-player split-screen gameplay (`2player.html`)
- ✅ P2 role toggle (drums or second piano) with localStorage persistence
- ✅ Combined test patterns (piano + drums; piano + piano)
- ✅ Multi-device MIDI routing with auto-detect + override
- ✅ Shared-device multiplexing (one keyboard → both players for unison)
- ✅ Big hit-feedback overlays per player
- ✅ HUD tooltips on every stat
- ✅ Hit window scale extended to 7 levels (Practice + Beginner added for kids)
- ✅ **Verified working** with two physical MIDI devices (MPK Mini 3 + Casio CDP)
- ✅ Supabase backend — auth, profiles, friends, inbox, play invites
- ✅ Real-time inbox via Supabase Realtime channels
- ✅ Live on GitHub Pages — no local server required for users
- ✅ Supabase vendor bundle served locally (no CDN latency)
- ✅ `play.html` — real game (song select → setup → gameplay → results)
- ✅ `js/core/gameplay-engine.js` extracted, parameterised for 1–N players
- ✅ 1 / 2 / 3 / 4-player grid layouts; 3-4 hardware-gated
- ✅ Per-song personal best display + NEW PB badge on results
- ✅ Proper results screen with per-player breakdown
- ✅ Session history saved to Supabase (`play_sessions` + `play_session_slots`)
- ✅ HISTORY nav screen with PB badges and date grouping
- ✅ Player identity model (§26) — host / friend-via-code / guest, with editable guest names
- ✅ Track-picker UI per player at setup; same-track allowed (duel mode)
- ✅ Bundled PD song library via `tools/build-songs.mjs` (Twinkle, Mary, Ode to Joy, Frère Jacques, Saints, + Twinkle duet)
- ✅ Computer Keyboard as a first-class input device (mutex per machine) + always-on note labels on falling blocks (teach-by-exposure)
- ✅ Warm-up state on game screen — engine alive but song paused until ▶ START SONG
- ✅ Speed (1-10) + Difficulty (1-7) selectors at top of setup; choices persist in `ctx.setup` and save to `play_sessions`
- ✅ ResizeObserver-driven crisp canvas at any display size (4K → mobile)
- ✅ Email confirmation redirect fix (`emailRedirectTo` explicit on signUp; Site URL also configured)
- ✅ Readability + mobile pass — lifted dim contrast, bumped base font, inbox single-pane on mobile with `dvh` viewport + 16px inputs to avoid iOS auto-zoom
- 🔜 §26 Evolution v2 — durable session attachments (token-based localStorage rehydration so reloads don't kill the friend's identity)
- 🔜 §27 Remote multiplayer — lobby + clock-sync + score broadcast (~3-4 focused sessions)
- 🔜 Admin screen — in-app user/data management (admin-only route)
- 🔜 Real piano + drum samples
- 🔜 GM drum-map translation so drum tracks reach the engine as abstract names (currently piano-only library)
- 🔜 Calibration overlay extracted into a shared `js/ui/` module; calibration added to play.html setup
- 🔜 Phase 3c — port `js/screens/gameplay.js` (2player.html) to use the engine, eliminating the duplicate game loop
- 🔜 3- and 4-player hardware-tested gameplay (layouts exist; needs ≥3 MIDI devices)
- 🔜 Mobile touch comfort — keys are small on narrow screens (current state: visible + tappable but not comfortable). Pinch-zoom or "double-size keys" toggle is the path.

### v1.0 — MVP launchable
- Real game at `play.html` — song select → setup → gameplay → results
- Song Creator MVP — record piano + drums, one-click quantize, basic piano roll, save/share, async collaboration, publish to library
- Admin screen with user list, activity log, data management
- Paywall (free 1-2P, paid 3-4P + custom uploads)
- Default song library (bundled MIDIs)
- Results screen — full per-player scores, accuracy bars, personal-best flags
- Device assignment screen
- Drum mapping calibration tool integrated into onboarding
- Latency calibration migrated to per-profile in Supabase
- Google OAuth (optional — lower friction sign-up)

### v1.5 — Paid features differentiate
- Song Creator v2 — quantize strength slider, note resize, rubber-band select, piano roll zoom, real-time collaboration
- Browse / Discover — public song library, remix / fork any public song
- AI Generate — text prompt → full 4-track MIDI song (paid)
- AI Assist — select region, ask Claude to modify it (paid)
- Custom MIDI upload (paid)
- AI chart simplification (free limited, paid unlimited)
- Replay system (paid)
- Bass instrument view (piano roll + fretboard)

### v2.0 — AI Studio era
- Full AI MIDI editor with conversational suggestions
- AI song generator
- Audio→MIDI (paid)
- Guitar instrument view
- Practice mode (slow down, loop sections)

### v2.5+
- Online multiplayer (WebSockets)
- Vocals view (pitch-contour + lyrics)
- Mobile browser support
- Teacher / student mode

### v3.0+
- VST integration (loopMIDI on web, pedalboard on standalone)
- Tournament / leaderboard modes

---

## 20. Known issues & TODOs

### High priority
- Real piano + drum samples (replacing synthesis)
- Results screen (replacing single-line `showSongComplete()`)
- Player profile UI
- 2-player split-screen (next)

### Medium priority
- Migrate `userOffset` into per-profile storage when profiles land
- Count-off BPM should match song BPM, not hardcoded 80
- MIDI miss detection should include `userOffset` (currently inconsistent with hit detection)
- Note range — detect from loaded MIDI, warn if outside player's keyboard range
- Preserve velocity in parseMIDI's per-note records
- Song duration should add `fallTimeMs` buffer so last notes don't cut off

### Low priority
- Debug-panel toggle
- Per-piano key labels toggle
- Note height scaled by sustain duration

---

## 21. Risks

- **Web MIDI is Chrome-only.** Document clearly. Block other browsers with a friendly message + Chrome link.
- **Latency varies wildly by device.** Calibration mitigates; per-device storage handles different kits.
- **Sample licensing.** Use only open/CC-licensed sources. Freesound + MIDI.js Soundfonts vetted.
- **AI cost economics.** Claude API isn't free. Cap usage per user per tier. Cache results where possible.
- **MIDI editor UX is hard.** Piano-roll editing is a non-trivial UI. Plan for iteration; consider OSS reference like webaudio-controls or react-piano (we won't use React but we can learn from their interaction patterns).
- **Audio→MIDI accuracy.** State-of-the-art is "good but not perfect." Set user expectation accordingly; offer manual touch-up in the editor after auto-conversion.

---

## 22. Decisions log

| Date | Decision |
|---|---|
| Pre-v8 | Web-first (Chrome + Web MIDI + Canvas). Python standalone is fallback only. |
| Pre-v8 | No frameworks, no build tools. |
| Pre-v8 | Count-off is mandatory; notes fall during count-off so beat 1 hits on GO. |
| Pre-v8 | `songStart = now - (COUNTOFF_TOTAL_MS - fallTimeMs)` is the canonical clock formula. |
| Pre-v8 | Blocks always spawn at `y=0`. Never mid-screen. |
| Pre-v8 | Per-device latency offset stored separately. |
| Pre-v8 | Abstract drum names — game logic never sees raw MIDI numbers. |
| 2026-05-16 | Modular ES-module refactor. `/js/core` shared across all screens. |
| 2026-05-16 | Vision expanded to commercial product with user accounts, paywall, and AI tools. |
| 2026-05-16 | AI scope focused on MIDI domain (editor + simplification + chart generation). Explicit non-goal: text-to-audio synthesis. |
| 2026-05-16 | Render modules extracted — `createPianoRenderer(canvas, opts)` and `createDrumRenderer(canvas, opts)` factory functions. Both debug tools and the gameplay screen compose them. |
| 2026-05-16 | First playable prototype shipped — `2player.html` with 2-player split-screen, verified on physical MIDI hardware (MPK Mini 3 + Casio CDP). |
| 2026-05-16 | P2 role is runtime-switchable (drums ↔ piano). Drum work fully preserved. |
| 2026-05-16 | Single-MIDI-device shared between both players is allowed and multiplexes one event stream into both `onP1Midi` and `onP2Midi`. Useful when only one keyboard is plugged in. |
| 2026-05-16 | Hit window scale extended from 5 to 7 levels — Practice (±250/±500) and Beginner (±180/±350) added for younger players. |
| 2026-05-16 | HUD tooltips on every stat. Pattern: `[data-tip]` + `.has-tip` CSS — reusable for future screens. |
| 2026-05-16 | **Backend: Supabase.** Implemented. Project `pmccwxovzhfdkuqzhkez`. Tables: profiles, friend_requests, messages, play_invites. All with RLS + Realtime. |
| 2026-05-16 | Supabase vendor bundle (`supabase.umd.js`) downloaded and served from `/js/vendor/` — eliminates CDN latency on every load. |
| 2026-05-16 | Live-first development. GitHub Pages (`ahaze-lms.github.io/Band-Sync`) is the primary target. Local server (`python -m http.server 8000`) is optional fallback for offline work only. |
| 2026-05-16 | Admin screen added to roadmap — in-app route, admin-only, showing user list, friend graph, recent activity. Supabase Table Editor fills this role in the interim. |
| 2026-05-17 | Song Creator / AI Studio designed — `studio.html` stub added. Transport + track list + instrument-specific piano roll + collaboration panel + AI panel. Full spec in §25. |
| 2026-05-17 | Instrument plan: piano + drums working now; bass (v1.5), guitar (v2.0), vocals (v2.5). Each has a distinct piano roll view. Drum view uses abstract lane names, not MIDI note numbers. |
| 2026-05-17 | Collaboration model: song owner assigns track slots to specific friends. Assigned collaborator owns their track; owner can always override. Async first, real-time (Supabase Realtime, one person per track) in v2. |
| 2026-05-17 | Sharing model: two distinct actions — Invite to Collaborate (edit assigned track) vs Publish to Library (play-only). Visibility levels: private / friends / public. |
| 2026-05-17 | Public library + Remix: public songs discoverable by all users. Any public song can be forked into a new private project; attribution preserved. |
| 2026-05-17 | `play.html` setup screen requires per-player track selection, not just instrument + device. Track picker lists the song's tracks (Melody, Bass, Drums…); designed for up to 4 players with any subset allowed to share a track ("duel mode"). Picker has no exclusion — same-track selection across players is a valid free choice, not just an auto-default for under-tracked songs. Implementation currently exposes 1–2 players. |
| 2026-05-17 | Bundled PD song library generated by `tools/build-songs.mjs` (Twinkle, Mary Had a Little Lamb, Ode to Joy, Frère Jacques, Saints Go Marching In) + a multi-track Twinkle duet (Melody + Bass) to demo the track picker. Single-track songs use channel 1; multi-track songs split channels per track. |
| 2026-05-17 | Gameplay engine extracted into `js/core/gameplay-engine.js` — pure, parameterized for 1-N players, no DOM. `play.html` uses it; `js/screens/gameplay.js` (2player.html) still duplicates the loop and is scheduled to be ported. The engine's local-first design (audio clock local, MIDI local, hits judged locally) honors CLAUDE.md principle #2 and is exactly the shape remote multiplayer (v2.5) needs as its foundation. |
| 2026-05-17 | `Clock.startSong()` parameterized with optional `{ countoffStartsAt: localTimestamp }` so all clients can fire beat 1 at the same wall-clock moment when remote multiplayer ships. Default = "now" so existing callers behave identically. `tickCountoff` + `justCrossedBeat` tolerate elapsed-negative (scheduled-future) starts. |
| 2026-05-17 | Player identity model designed — three modes per slot: Host (logged-in user, default P1), Friend (attached via 6-digit device code generated on friend's phone, single-use, 10-min TTL), Guest (anonymous, scores save to session row only). Friend-attach borrows the YouTube-on-TV pairing UX. Full spec in §26. Schema: `device_codes`, `play_sessions`, `play_session_slots`. Threat model: a malicious host can grief a friend's scores but cannot read/modify any of their other data. |
| 2026-05-17 | Player identity MVP shipped — phases 1-7 from §26 all live: Supabase migration, friend-side code generation (PAIRING card in profile-edit), host-side identity picker in play.html setup, claim modal (6-digit input with paste support), score persistence on song complete, HISTORY nav screen with date grouping and PB badges, RECENT ACCOUNT ACTIVITY audit card. End-to-end loop verified. |
| 2026-05-17 | `play.html` gameplay layout optimized for 1-4 players. Score card flipped from a 220px side column to a compact horizontal strip on top of each panel; canvas fills remaining space via `object-fit: contain` so the keyboard upscales at 1-player full screen and downscales cleanly at 4-player quad. Grids: 1-col / 2-col / 3-col / 2×2. `ENABLED_PLAYERS` raised to 4 (3-4 are layout-ready; gameplay still needs ≥3 MIDI devices). |
| 2026-05-17 | Personal best surfaced in two places: "YOUR BEST: 14,400 · S · 98% · 2d ago" line under each song on the setup screen, and a "NEW PERSONAL BEST" pill on the host's results row when they beat their previous PB. Triggered only when there *was* a previous best (first plays just record quietly). Friend/guest slots don't get the badge — friends' PBs are blocked by RLS, guests have no account. |
| 2026-05-17 | Guest names are editable but optional. Identity cell for guest slots renders as a name input + mini kind-switcher side-by-side; default `Guest N` stays a valid value (empty input reverts to it). Edited name flows through to in-game chips, results row, saved `display_name`, and friend audit log. No schema change required. |
| 2026-05-17 | §26 evolution: durable session attachments. Friend's 6-digit code is still the one-shot pairing handshake, but on claim Supabase now also issues a session token that the host stores in localStorage. Reloads rehydrate the attached identity by validating the token (24h TTL, revocable from friend's Connected Devices). YouTube-on-TV mental model. Fixes the "have to regen a code every song after every refresh" friction the user hit during testing. Schema adds `session_attachments` + extends `claim_device_code` RPC + new `attach_session` / `revoke_session_attachment` RPCs. Full spec in §26 Evolution v2. |
| 2026-05-17 | §27 Remote Multiplayer specced. Local-first by design: each player runs their own engine, audio, and hit detection on their own machine; only synchronised start (via existing `Clock.startSong({ countoffStartsAt })`) and score broadcasts (Supabase Realtime, ~1Hz) cross the network. New tables: `lobbies`, `lobby_participants`. Both modes (local couch coop + remote) write the same `play_sessions` / `play_session_slots` rows so HISTORY queries are mode-agnostic. Honest scope: ~3-4 focused sessions to a functional first version, with lobby UI being the only genuinely new architectural surface. |
| 2026-05-17 | Computer Keyboard input shipped + always-on note labels on falling blocks. Keyboard is a first-class device option in the picker (mutex per machine — one slot owns it). QWERTY mapping covers 2 octaves (z-row = C4 octave, q-row = C5, Garageband-style). Note name (C, F#, etc.) drawn on every falling block for *all* players regardless of input device — teach-by-exposure pedagogy so MIDI users learn note names too. Keyboard players also see the QWERTY letter as a smaller secondary hint. |
| 2026-05-17 | play.html gameplay screen now opens in a **warm-up state**. The engine spins up immediately (canvas drawing, audio + input responsive) but the song timer doesn't start until the user clicks `▶ START SONG`. Lets players test their device + find hand position before count-off. Hint text "Play a few notes to warm up, then start." Restart re-enters the same flow. |
| 2026-05-17 | Speed (1–10) and Difficulty (1–7) selectors added to setup. Choices persist in `ctx.setup` (survive song-select ↔ setup loops within a page session) and are passed both to the engine config and to `play_sessions` so HISTORY records what was actually played. Replaces the implicit `DEFAULT_*` constants. |
| 2026-05-17 | Piano renderer uses a ResizeObserver to keep the canvas pixel buffer matched to `displaySize × devicePixelRatio`. Crisp at any display size — 4K monitors no longer get bilinear blur. Drawing code stays in logical `CANVAS_W × CANVAS_H` coordinates; per-frame `ctx.setTransform` handles the mapping. Drums renderer has the same issue but no one's complained (library is piano-only). |
| 2026-05-17 | Mobile pass (quick wins, not full responsive redesign). Lifted `--dim` color contrast from `#55556a` to `#8585a0` (was nearly invisible on phones in bright light); bumped base font 14→15px. play.html: panels stack vertically on ≤768px; setup player rows wrap fields below the P# tag. Inbox single-pane with ← BACK button; `#app` uses 100dvh; inputs forced to 16px to stop iOS auto-zoom. Deliberately NOT in scope: full responsive redesign, landscape-specific layouts, pinch-zoom for touch-comfortable keys. |
| 2026-05-17 | RLS recursion fix migration 0002 — play_sessions ↔ play_session_slots policies cross-referenced each other, so any insert-with-select triggered "infinite recursion detected." Pulled the cross-table existence checks into SECURITY DEFINER helper functions (`user_in_session`, `user_hosts_session`) — same pattern as `claim_device_code`. Surfaced as "COULD NOT SAVE" on every results screen until the migration was applied. |
| 2026-05-17 | Email confirmation redirect fix — friend's signup link 404'd because Supabase's Site URL fallback didn't match the GitHub Pages path. Added explicit `emailRedirectTo` to `signUp()` deriving from `location.href` so the URL is unambiguous regardless of Supabase config drift. Also documented the Site URL + Redirect URLs dashboard settings (`https://ahaze-lms.github.io/Band-Sync/` and `…/**` allowlist). |
| 2026-05-18 | §27 Remote Multiplayer phases 5+8 shipped. Clock sync: `get_server_time()` RPC (migration 0006) + `measureClockOffset()` in `lobbies.js` (5 round-trip samples, trim outliers). Host clicks START → measures offset → writes `start_at = serverNow + 3s` + state='starting'. Non-host receives via Realtime, converts server epoch to local `performance.now()` using their own measured offset, calls `launchRemoteGame(countoffStartsAt)`. Each client runs a 1-player game started at the same wall-clock instant. Phase 8 RLS: `user_in_lobby_session()` helper + `pss_insert_self_in_session` + `pss_select_in_lobby_session`. First successful 2-player remote session verified end-to-end: both players in separate browsers, both saved to HISTORY. |
| 2026-05-18 | §27 phase 7 shipped — end-of-song remote persistence. `createSessionHeader()` + `saveSlot()` added to `play-sessions.js`. `onSongComplete()` branches: local → existing `saveSession()`; remote host → `createSessionHeader()` → `updateLobby({ session_id })` → `saveSlot()`; remote non-host → `waitForLobbySessionId()` polls until host stamps `session_id`, then `saveSlot()` via `pss_insert_self_in_session`. Remote lead time bumped 3s→8s for drum warm-up. All four §27 phases (5, 6, 7, 8) now shipped. |
| 2026-05-18 | §27 phase 6 shipped — remote score strip. Supabase Broadcast channel `game:<lobbyId>` carries score ticks (~1Hz throttle) from each player. Slim strip above game canvas shows all participants' live score / grade / accuracy. Lobby track picker added: instrument + track selects on your own participant row, wired to `setSlotConfig()` so launchRemoteGame reads the correct instrument/track. Lobby form-card styling added. Friend-invite-from-lobby flow: `play_invites.lobby_id` column (migration 0007) + 30-min expiry; home screen detects lobby invites and renders JOIN LOBBY link. Remote play lead time bumped 3 s → 8 s to give drum players time to find hand position before the count-off fires. |
| 2026-05-18 | Lobby chat shipped — ephemeral Broadcast chat panel in the lobby waiting room. `subscribeLobby()` now returns `{ unsubscribe, sendChat }` and accepts an `onChat` callback. Own messages pushed to local state immediately (Supabase Broadcast does not echo to sender). Chat draft preserved across `paintLobby()` repaints (triggered by participant joins/ready-state changes). Enter key + SEND button; sender name from participant profile. Messages capped at 60; auto-scrolls to bottom. |
| TBD | Pricing tiers ($/mo) |
| TBD | Domain name |
| TBD | Where to keep the calibration overlay logic — currently duplicated in 3 screens (piano_debug, drum_debug, gameplay). Candidate for a shared `js/ui/calibration-overlay.js`. |

---

## 23. Open questions

- Domain + brand: bandsync.app? bandsync.com?
- Business entity (LLC/etc.) before Stripe live mode
- Whether to support guest play with no profile at all, or require at least a local profile
- AI usage limits per tier — what's the right cap before it eats margin?
- Should AI-generated songs be shareable to a public library, or stay private?

---

## 24. Reference — file layout summary

| Where | What |
|---|---|
| `/index.html` | Auth-gated SPA shell (login, home, social) |
| `/play.html` | Real game — song select → setup → gameplay → results (in design) |
| `/studio.html` | Song Creator / AI Studio — record, quantize, piano roll, export (in design) |
| `/2player.html` | 2-player prototype (access via Dev Lab) |
| `/lab.html` | Dev Lab hub — links to prototype + all debug tools |
| `/README.md` | Dev workflow + how to run locally |
| `/DESIGN.md` | This file |
| `/css/` | Stylesheets (in progress) |
| `/js/config.js` | All shared constants |
| `/js/core/` | Engine modules (timing, audio, scoring, MIDI, calibration, parser, mapping) |
| `/js/render/` | Canvas renderers (piano, drums, future bass/guitar) |
| `/js/input/` | MIDI-to-game input mapping (future) |
| `/js/screens/` | SPA screens: auth, home, profile-edit, friends, inbox — plus future: gameplay, results, library, studio, admin |
| `/js/services/` | Supabase clients: auth.js, profile.js, social.js, supabase.js |
| `/js/vendor/` | Local third-party bundles — supabase.umd.js (served locally, no CDN) |
| `/songs/` | Bundled `.mid` files |
| `/debug/` | Standalone debug tools that survived the refactor |
| `/server/` | Backend code (future) |

---

## 25. Song Creator / AI Studio

Lives at `studio.html`. The tool for building songs that feed into the game library, with collaborative multi-user editing and a public song library.

### Vision

A lightweight browser-based DAW: record MIDI tracks one at a time with any connected instrument, quantize, edit notes in an instrument-specific piano roll, stack up to four tracks, and publish to the game library. Friends can be invited to contribute individual tracks. Published songs are playable by anyone — and remixable by anyone into their own project.

**Heart and Soul example:** You record Track 1 (chord accompaniment, piano), invite a friend to record Track 2 (melody), combine and publish → a playable BandSync song any user can discover.

---

### Instruments

Each instrument has its own piano roll view. Piano and drums are working today; the rest are planned.

| Instrument | Status | Piano roll Y axis | Duration? |
|---|---|---|---|
| **Piano** | ✅ Working | MIDI pitch (88 keys, keyboard on left) | Yes — sustain matters |
| **Drums** | ✅ Working | Drum lanes (KICK, SNARE, HH_CLOSED…) | No — hits only |
| **Bass** | 🔜 v1.5 | 4 strings × frets (fretboard layout) | Yes |
| **Guitar** | 🔜 v2.0 | 6 strings × frets + chord diagram overlay | Yes |
| **Vocals** | 🔜 v2.5 | Pitch contour + lyric syllable labels | Yes (held pitch) |

The `piano-roll.js` renderer reads the track's `role` and draws the correct view. Drum tracks use the abstract name system (`KICK`, `SNARE`, etc.) already established in the game engine — the studio never stores raw MIDI note numbers for drums.

---

### User flow

1. **New / Open** — name the song, set BPM (type or tap tempo), time signature (default 4/4), total bars
2. **Record** — arm a track slot, assign instrument role, hit Record, 4-beat count-in plays, perform, hit Stop
3. **Quantize** — choose grid resolution, set strength (0–100%), Apply
4. **Edit** — instrument-appropriate piano roll: move, resize, delete, add notes
5. **Repeat** — arm a different track, record the next part
6. **Mix** — mute / solo tracks, adjust volume, listen to everything together
7. **Collaborate** — invite specific friends to contribute to assigned track slots
8. **Publish** — set visibility (private / friends / public), add to game library

---

### Components

| Component | Description |
|---|---|
| **Transport bar** | Song name, BPM input + tap-tempo, time sig, total bars, Record / Play / Stop / Rewind |
| **Track list** | 4 rows — instrument role, color, mute, solo, volume, arm button, assigned collaborator avatar |
| **Piano roll** | Canvas grid, instrument-specific view. X = time (bars + beats), Y = pitch or drum lanes |
| **Quantize panel** | Grid resolution selector, strength slider (0–100%), Apply button, Auto-quantize toggle |
| **AI panel** | Generate tab + Assist tab |
| **Collaboration panel** | Invite friends, track assignments, per-track contribution status |
| **Publish dialog** | Visibility selector (private / friends / public), title, description, Publish button |

---

### Piano roll — instrument views

**Piano view**
- Y axis: 88-key piano keyboard on left margin, chromatic pitch
- Notes: colored bars (pitch × duration) — wider = longer sustained note

**Drum view**
- Y axis: named drum lanes — KICK, SNARE, HH_CLOSED, HH_OPEN, HH_PEDAL, TOM_1, TOM_2, TOM_3, CRASH, RIDE
- Notes: fixed-height hit markers (no meaningful duration)
- Lane labels show abstract name, not MIDI note number

**Bass / Guitar view** (planned v1.5 / v2.0)
- Y axis: string × fret grid (fretboard layout)
- Notes: colored bars per string

**Vocal view** (planned v2.5)
- Y axis: chromatic pitch (no keyboard graphic)
- Notes: bars with lyric syllable text rendered inside

---

### Piano roll interactions

**MVP:**
- View notes after recording
- Click-drag to move notes (time + pitch / lane)
- Right-click to delete
- Click empty grid to add a note

**Full (v2+):**
- Drag right edge to resize note duration
- Rubber-band select multiple notes
- Copy / paste selection
- Zoom X (bars visible) and Y (pitch range)
- Snap-to-grid toggle

---

### Quantization

Grid resolution: 1/4, 1/8, **1/16 (default)**, 1/32 notes.

Strength: 0% = raw recording, 100% = fully snapped. Values in between blend proportionally. Original timestamps always preserved — re-quantize at any strength, any time.

Auto-quantize: optional toggle that applies 100% / 16th-note snap automatically when recording stops.

---

### Collaboration model

**Async first, real-time later.**

*Async (MVP):* A song is a shared document in Supabase. Owner works and saves; collaborators open it later and see the latest state. Like passing a project file, but through the cloud.

*Real-time (v2):* Supabase Realtime channels (already in the stack for inbox) broadcast note changes to all active collaborators. Conflict-free by design: **one person per track at a time**. If everyone is on a different track, there are no conflicts to resolve — the model maps naturally to how a real band works.

**Track ownership rules:**
- Song owner assigns track slots to specific collaborators: "Track 2 is yours — record the bass line."
- Assigned collaborator can record, re-record, and edit their track only.
- Song owner can always reassign or override any track — it's their project.
- Unassigned tracks are open for any collaborator with edit access to claim.

---

### Sharing model

Two distinct actions with different intents — never conflated in one dialog.

| Action | Who | Access granted |
|---|---|---|
| **Invite to Collaborate** | Specific friend(s) | Edit their assigned track(s) |
| **Publish to Library** | Friends-only *or* Public | Play the song in the game |

**Visibility levels:**

| Level | Who can see it |
|---|---|
| `private` | Owner only |
| `friends` | Owner's friend list |
| `public` | All BandSync users — discoverable in Browse / Discover |

**Remix:** any public song can be forked into a new private project. The fork is a full copy; the original is unchanged. Attribution preserved: *"Remixed from [title] by @username."*

---

### AI integration

**Generate tab** — text prompt → complete song

User writes: *"Heart and Soul — 4 tracks, 100 BPM, 32 bars. Track 1: chord accompaniment (piano). Track 2: melody (piano). Track 3: bass line. Track 4: simple drums."*

Claude API returns a note array per track in the song data model format. Studio imports these as pre-populated tracks. User can record over any track, edit notes, or use as-is.

**Assist tab** — select a track or region → ask Claude

Examples:
- "Add a harmony a third above this melody"
- "Write a kick/snare pattern that fits this groove"
- "Simplify this for a 7-year-old"
- "Transpose the whole track up a fourth"
- "Make bars 9–12 swing more"

Claude returns a modified note array for the selected track / region. User accepts or rejects. Original preserved until accepted.

---

### Data model

```js
// Song — saved to Supabase `songs` table + exported as .mid
{
  id: uuid,
  owner_id: uuid,              // auth.users reference
  name: string,
  description: string,
  bpm: number,
  timeSignature: { num: 4, den: 4 },
  bars: number,
  visibility: 'private' | 'friends' | 'public',
  remix_of: uuid | null,       // source song id if this is a fork
  created_at: timestamp,
  updated_at: timestamp,
  tracks: [
    {
      id: uuid,
      index: 0,                // 0–3, maps to game player slot
      name: string,
      role: 'piano' | 'drums' | 'bass' | 'guitar' | 'vocals',
      color: string,
      muted: boolean,
      solo: boolean,
      volume: number,          // 0–1
      contributor_id: uuid | null,  // which collaborator owns this track
      notes: [
        {
          pitch: number,         // MIDI note number (non-drum roles)
          drumName: string,      // abstract name (drums role only)
          startTick: number,     // quantized position (480 PPQ ticks)
          startMsRaw: number,    // original recorded timestamp, always preserved
          durationTick: number,
          velocity: number       // 0–127
        }
      ]
    }
  ]
}
```

Tick resolution: 480 PPQ (standard MIDI quarter-note resolution).

---

### Supabase schema additions

```sql
create table songs (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid references auth.users not null,
  name        text not null,
  description text,
  bpm         integer not null default 120,
  bars        integer not null default 32,
  visibility  text not null default 'private'
                check (visibility in ('private','friends','public')),
  remix_of    uuid references songs,
  data        jsonb not null,   -- full tracks + notes blob
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create table song_collaborators (
  song_id     uuid references songs not null,
  user_id     uuid references auth.users not null,
  track_index integer,          -- null = any unassigned track
  invited_at  timestamptz default now(),
  primary key (song_id, user_id)
);

-- RLS: owner + collaborators can read private songs;
--      friends-visibility readable by friend list;
--      public readable by all authenticated users.
--      Only owner can change visibility or reassign tracks.
```

---

### New modules

| File | Purpose |
|---|---|
| `js/core/recorder.js` | Capture live MIDI events with timestamps while metronome runs |
| `js/core/quantizer.js` | Snap `startMsRaw` to nearest grid division at given strength; output `startTick` |
| `js/core/song.js` | Song data model — create, serialize, deserialize, export to `.mid` binary |
| `js/render/piano-roll.js` | Canvas piano roll — instrument-specific views, mouse interaction, viewport management |
| `js/services/library.js` | Supabase CRUD for `songs` + `song_collaborators` — save, list, load, invite, publish |

Reuses: `js/core/midi.js`, `js/core/audio.js` (metronome + playback synth), `js/core/midi-parser.js` (re-import `.mid`), existing drum-mapping abstraction.

---

### MVP scope (build first)

- BPM input + tap tempo (average last 4 taps)
- Piano and drum track recording (the two working instruments)
- 4-beat count-in before recording
- One-click quantize (16th note, 100% strength)
- Instrument-appropriate piano roll view (piano keys vs. drum lanes)
- Piano roll: view notes, drag to move, right-click delete, click grid to add
- 4 track slots with mute / solo
- Playback all tracks (existing audio synth)
- Save to Supabase `songs` table (private by default)
- Invite a collaborator to a specific track slot (async)
- Publish: set visibility to `friends` or `public`
- Export / download as `.mid`

### Deferred to v2

- Quantize strength slider + multiple grid resolutions
- Note resize by dragging right edge
- Rubber-band select, copy / paste
- Piano roll zoom (X and Y axes)
- Real-time collaboration via Supabase Realtime
- Browse / Discover public library screen
- Remix / fork public songs
- AI Generate tab (Claude API)
- AI Assist tab (Claude API)
- Bass, guitar, vocal instrument views
- Punch-in / overdub recording
- Undo / redo history
- Per-track volume automation

---

## 26. Player Identity & Multi-Account Sessions

How multiple humans sitting at the same device — or one human plus
unaccounted guests — get their own identity for score attribution,
history, and personal bests.

### Problem

BandSync is a couch co-op game. The browser holds exactly one Supabase
session at a time (the host). But up to 4 humans may be playing on the
same device, each wanting their scores to land on **their own** account
— or, equally valid, not on any account at all.

### Three identity modes

Every player slot in `play.html` setup carries one of three identities:

| Mode | Who | user_id | Scores save? | Default for |
|---|---|---|---|---|
| **Host** | The logged-in Supabase user | host's | Yes (host's history) | P1 |
| **Friend** | Another Supabase user, attached via device code | friend's | Yes (friend's history) | — |
| **Guest** | Anonymous local-only player | null | Stored on session row only; no per-user history | P2-P4 if not claimed |

The picker in `play.html` setup gains an **identity column** per row.
Each slot can be freely set to any mode at any time (and toggled
between Guest ↔ Friend mid-setup if a friend joins late).

### Friend attach — device-code flow

Borrowed straight from "YouTube on TV / Netflix on TV" pairing UX.
Friendly enough for a kid with a parent's phone, secure enough that
shoulder-surfing a code does nothing harmful.

```
Friend's phone               Host's machine               Supabase
─────────────────────────────────────────────────────────────────────
 [Profile screen]
  → tap "Generate            (waits)                      INSERT into
     guest code"                                          device_codes
  ← shows  "742 619"                                      (10-min TTL)

 (says code aloud)           [P2 slot]
                              → tap "Join with code"
                              → enters 742 619
                                                          SELECT where
                                                          code='742619'
                                                          AND used_at IS NULL
                                                          AND expires_at > now()
                              ← Supabase returns
                                friend's profile snapshot
                                                          UPDATE used_at = now(),
                                                          used_by_user = host.id
                              → slot 2 = Sarah's account
                                (icon, accent color)

 [Plays Twinkle as P2 …]
 [Song ends]                 [Saves play_sessions
                              + play_session_slots rows]   INSERT slot row
                                                          WHERE user_id=friend
                                                          allowed by RLS
                                                          because session's
                                                          host_user_id=auth.uid()
```

**Properties:**
- Code is **single-use** — claiming consumes it.
- Code is **short-lived** — 10-minute TTL (re-generate if expired).
- Code is **6 digits** — brute-force impractical inside the TTL window
  *given lookup rate-limiting* (see Security below).
- Code is **friend-initiated** — host can't force a friend's identity
  onto a slot without the friend actively generating a code.
- Friend can **revoke** active sessions from a "Connected devices" view
  in their profile (deletes pending codes + invalidates session).

### Data model

Three new Supabase tables. All have RLS.

```sql
-- ── Device codes ─────────────────────────────────────────────
-- Short-lived 6-digit handoff between friend's phone and host's screen.
create table device_codes (
  code           text primary key,         -- 6 digits, e.g. '742619'
  user_id        uuid references auth.users not null,
  display_name   text,                     -- snapshot at generation time —
  avatar         text,                     -- so the host's UI can show the
  accent_color   text,                     -- friend's identity immediately
  created_at     timestamptz default now(),
  expires_at     timestamptz not null,     -- created_at + 10 min
  used_at        timestamptz,
  used_by_user   uuid references auth.users
);

create index on device_codes (user_id, created_at desc);
create index on device_codes (expires_at);    -- for cleanup job


-- ── Play sessions (one row per song played) ──────────────────
create table play_sessions (
  id                uuid primary key default gen_random_uuid(),
  host_user_id      uuid references auth.users not null,
  song_file         text not null,         -- e.g. 'twinkle-twinkle.mid'
  song_title        text not null,
  started_at        timestamptz default now(),
  ended_at          timestamptz,
  speed_level       int,
  hit_window_level  int,
  player_count      int not null
);

create index on play_sessions (host_user_id, started_at desc);


-- ── Per-player results within a session ──────────────────────
-- Separate table so user_id can be indexed for "show my history"
-- queries that span sessions where the user wasn't the host.
create table play_session_slots (
  session_id    uuid references play_sessions on delete cascade,
  slot          int not null check (slot between 1 and 4),
  identity      text not null check (identity in ('host','friend','guest')),
  user_id       uuid references auth.users,   -- null for guest
  display_name  text not null,
  instrument    text not null,
  track_index   int not null,
  track_name    text,
  score         int default 0,
  accuracy      int,
  grade         text,
  perfect       int default 0,
  good          int default 0,
  miss          int default 0,
  wrong         int default 0,
  max_combo     int default 0,
  primary key (session_id, slot)
);

create index on play_session_slots (user_id, session_id);
```

### RLS policies (sketch)

**`device_codes`**
- `INSERT`: `user_id = auth.uid()` — only generate codes for yourself.
- `SELECT`: any authenticated user can read by `code` if `used_at IS NULL AND expires_at > now()`. Rate-limited (see below).
- `UPDATE`: any authenticated user can set `used_at, used_by_user` if `used_at IS NULL`. Single-shot claim.
- `DELETE`: `user_id = auth.uid()` — let users revoke their own unused codes.

**`play_sessions`**
- `INSERT`: `host_user_id = auth.uid()`.
- `SELECT`: `host_user_id = auth.uid()` OR session has a slot where `user_id = auth.uid()`.

**`play_session_slots`**
- `INSERT`: allowed if the parent session's `host_user_id = auth.uid()`. The host can write rows for any `user_id` they wish — but only inside a session they themselves host.
- `SELECT`: allowed if `user_id = auth.uid()` OR the parent session is host-visible.

### Security model

**What the host CAN do:**
- Record scores against a claimed friend's account (the whole point).
- Choose to record a fake high score against a friend's account.

**What the host CANNOT do:**
- Read the friend's other data (profile fields, DMs, friend graph).
- Modify the friend's profile or settings.
- Write to any table other than `play_sessions` and `play_session_slots`.
- Persist their access — the friend's identity is held only in
  in-memory state on the host's machine, never written to localStorage.

**Threat model accepted:**
- A malicious host can grief a friend by saving inflated or deflated
  scores against their account. Mitigated by:
  - Friend's "Connected devices" page can revoke + dispute.
  - All sessions show `host_user_id` so the friend can see who logged
    bad data and ignore / remove it.
  - Personal-best logic can ignore sessions hosted by anyone other than
    a configurable "trusted hosts" set in v2.
- A guesser can try codes. Mitigated by:
  - 6-digit codes, 10-minute TTL, single-use → ~10⁶ × (10 min ÷ guess
    rate) effective space.
  - Rate-limit `device_codes` SELECT to e.g. 5/min per IP via an Edge
    Function wrapper (post-MVP — initial release can rely on Supabase's
    default PostgREST limits).

### UI surfaces

**Friend's phone — profile-edit screen** (new section "Pairing"):
- "Generate guest code" button.
- Active codes list (code, expires-in countdown, Revoke button).
- Recent sessions where I appeared (for verification).

**Host's `play.html` setup screen** — each player row gains an
identity selector (replacing the silent default of "host for P1,
nothing for P2-P4"):

```
P2  IDENTITY [▾ Guest        ]  INSTRUMENT [▾ Piano]  ...
              ├── Me (Anthony)         ← only one slot can pick Me
              ├── Join with code…       ← opens claim modal
              └── Guest
```

When "Join with code…" is picked:
- Modal: "Enter your friend's code" with 6 input cells
- On valid claim: slot identity becomes Friend with their display_name,
  avatar, and accent color
- On invalid/expired: error inline, slot reverts to Guest

Guest slots default-name to "Guest 2 / Guest 3 / Guest 4"; the host can
overtype to "Mom" or "Lila" for the session.

**Results screen** — each row shows the player's display_name and (for
non-host accounts) a tiny avatar. Guests get a "play_sessions row
saved (no account)" footnote.

**Friend's profile** — new "History" tab querying
`play_session_slots WHERE user_id = me ORDER BY session.started_at DESC`,
showing every song they played, grouped by host.

### Persistence model

- Every completed song writes **one** `play_sessions` row + **N**
  `play_session_slots` rows (one per slot, even guests).
- Host's full play history queries by `host_user_id`.
- Friend's full play history queries by `play_session_slots.user_id`.
- Guest stats live only on the slot row; no user can claim them later
  (deliberately — claiming retroactively opens a fraud vector).
- Personal-best per `(user_id, song_file)` derived live from
  `play_session_slots` — no materialization in v1.

### Implementation phases

1. **Schema + Supabase migration** — three new tables, RLS policies.
2. **Friend-side: generate / list / revoke codes** in profile-edit.
3. **Host-side: identity selector in `play.html` setup** — adds the
   third column to the player picker. Defaults to Me for P1, Guest
   elsewhere.
4. **Host-side: claim modal** — 6-digit input, validates against
   `device_codes`, populates slot identity.
5. **Score persistence** — on `onSongComplete`, write `play_sessions`
   + `play_session_slots`.
6. **History view in profile** — list of sessions, per-song bests.
7. **Connected devices view in profile** — active codes + recent
   claimed sessions, with Revoke.

Phases 1-5 are the **MVP** — enough to play, save, and look back.
Phases 6-7 are the **payoff** — the user-visible value of all this
identity plumbing.

### Evolution v2 — Durable session attachments

The phase 1-7 MVP holds claimed friend identities **in memory only** on
the host's machine. That works for "one song together at a party" but
breaks the moment the host hard-reloads, closes the tab, or navigates
away. The friend has to generate a fresh 6-digit code every time.
Bad for couch coop sessions where you'll play 5+ songs over an hour;
fatal once we want phones/tablets that can lose focus.

**Fix**: keep the 6-digit code as the one-shot pairing handshake, but
when it's claimed, also issue a **session token** that the host stores
in localStorage. Reloads rehydrate the attached identity by validating
the token against Supabase. Tokens auto-expire (24 h default), and the
friend can revoke any time from their Connected Devices page.

This is the YouTube-on-TV / Spotify-Connect mental model: pair once,
stay paired for a sensible window, revoke if you mistrust.

#### Flow

```
[friend phone]              [host browser]              [Supabase]
generate 6-digit code  →    (read it aloud)
                            claim_device_code(code) →   validate +
                                                        consume code,
                                                        issue session
                                                        token, return
                                                        both
                            store session token in
                            localStorage keyed by
                            host_user_id + slot
(close tab / reload)   ←    (still works)

[reload]               →    read localStorage,
                            attach_session(token)  →    check not revoked,
                                                        not expired,
                                                        bump last_used_at,
                                                        return profile
                            ← attach identity to slot

(friend revokes from   ←    (next reload of host
 Connected Devices)         won't rehydrate;
                            current in-memory still
                            works until reload)
```

#### Schema additions

```sql
create table session_attachments (
  token             text primary key,           -- random ~32-char secret
  user_id           uuid references auth.users on delete cascade not null,
  host_user_id      uuid references auth.users on delete cascade not null,
  display_name      text,
  avatar            text,
  accent_color      text,
  created_at        timestamptz default now(),
  last_used_at      timestamptz default now(),  -- bumped on each rehydrate
  expires_at        timestamptz not null,       -- created_at + 24h default
  revoked_at        timestamptz,
  revoked_reason    text                        -- 'user' | 'expired' | 'rotated'
);

create index on session_attachments (user_id, expires_at);
create index on session_attachments (host_user_id);
```

RLS:
- `INSERT` — only the RPC (SECURITY DEFINER) writes; users don't insert directly
- `SELECT` — `user_id = auth.uid()` (your own attachments) OR `host_user_id = auth.uid()` (attachments to your device)
- `UPDATE` — `user_id = auth.uid()` (to revoke) — sets `revoked_at`, `revoked_reason`
- `DELETE` — own user_id only

#### RPC additions

Update `claim_device_code` to issue an attachment in the same transaction:

```sql
-- Returns user_id, display_name, avatar, accent_color, session_token
create or replace function claim_device_code(p_code text)
returns table (
  user_id       uuid,
  display_name  text,
  avatar        text,
  accent_color  text,
  session_token text
) ...
```

New `attach_session(p_token text)` — validates a stored token:

```sql
-- Returns the same profile snapshot, or no rows if invalid.
-- Bumps last_used_at as a side-effect.
create or replace function attach_session(p_token text)
returns table ( user_id uuid, display_name text, avatar text, accent_color text )
language plpgsql security definer ...
```

New `revoke_session_attachment(p_token text)` — friend-side revoke:

```sql
-- Marks revoked_at + revoked_reason='user'. Allowed only if
-- the token's user_id matches auth.uid().
```

#### Host-side localStorage

```js
// js/services/session-attachments.js
const KEY = userId => `bandsync_attachments_${userId}`;

// shape: { [slotKey]: { token, userId, displayName, avatar, accentColor, expiresAt } }
function load(hostUserId)            { /* JSON.parse, drop expired */ }
function save(hostUserId, slotKey, attachment)
function remove(hostUserId, slotKey)
function reattachAll(hostUserId)     { /* call attach_session on each */ }
```

`slotKey` is something stable like `'p2'` for "the second player slot." Stored
per host so different accounts using the same browser don't see each other's
attachments.

#### UI changes

- **Profile / Connected Devices** (§26 phase 7): list active
  `session_attachments` for the user instead of just used `device_codes`
  rows. Each shows: who claimed (host_user_id → profile), when (created_at),
  last activity (last_used_at), Revoke button.
- **`play.html` setup**: on entering setup, attempt `reattachAll`. Any
  rehydrated slot shows the attached friend's pill exactly as before.
- **Trust signal**: if the page rehydrated an attachment, optionally show
  a subtle "@sarah's session restored" toast for the first second.

#### Phase plan (incremental on top of §26 MVP)

1. Migration: `session_attachments` table + RLS + updated RPCs (one paste).
2. `js/services/session-attachments.js` — localStorage layer + RPC wrappers.
3. Update `claim` flow in play.js to receive + store token.
4. Add rehydrate-on-setup step.
5. Update Connected Devices view to read attachments.
6. Cleanup: expire/revoke triggers, maybe a daily cleanup of expired tokens.

#### Threat model delta vs MVP

- **localStorage theft**: someone with file access to the host machine can
  steal tokens and use them to record scores as the friend. Mitigated by
  the 24 h TTL and the friend's revoke button. Same blast radius as
  pre-evolution (host can already grief).
- **Friend's account compromise**: same as before — attachments live in
  Supabase under the friend's user_id; they can wipe all in one query.
- **Revoke latency**: revoke takes effect on the next rehydrate, NOT
  mid-session. Acceptable; the in-memory identity dies with the page anyway.

### Future enhancements

- **SMS invites via Twilio** — current flow requires the friend to
  generate a code on their own phone, then read it aloud. A nicer
  host-initiated variant: in `play.html` setup, host clicks
  *"Text a friend to join P2"* and enters a phone number. Backend
  uses Twilio (or Supabase's built-in phone OTP via Twilio) to send
  the friend a magic link → friend taps it on their phone → if
  signed in there, they confirm "Join Anthony's BandSync session" →
  identity attaches to slot 2 the same way a manual code would.
  Doesn't replace the manual-code flow (great when phones aren't
  available); just adds a smoother path when they are.
  Needs: Twilio account, server-side SMS dispatch (Supabase Edge
  Function), deep-link route in `index.html` that maps to a
  pending-claim record, and a confirmation modal on the friend's
  side. Tracks naturally with the eventual remote-multiplayer work
  in §19 v2.5.

### Open questions

- Should the host see a banner in-game when a friend is attached
  ("Now recording for @sarah")?
- Should the count-off pause if a slot has Friend identity but the
  device code TTL expires mid-session? (Suggested: no — already
  claimed; in-memory identity persists until the session ends.)
- Should we offer a passwordless **"sign in here for this device"**
  flow as an alternative (longer-lived but full account)? Probably
  yes — `signInWithOtp({ email })` from Supabase is one line. For v2.
- Personal-best **honesty mode**: should bests only count from
  sessions where the player was Host (so a friend can't inflate your
  PB)? Suggested toggle in profile, off by default.

---

## 27. Remote Multiplayer

How friends sitting at different houses play the same song together
"in sync" — given that internet latency makes frame-perfect inter-player
sync physically impossible.

### What "remote multiplayer" actually means here

Not Beat Saber co-op where you see each other's hits in real time. The
math kills it: a perfect hit window is ±40ms, internet round-trip is
50-150ms typical. By the time your friend's input arrived on your
screen, the song moved 100ms past where they pressed.

What works (and is what e.g. Beat Saber multiplayer + Fortnite Festival
actually do):

- **Synchronised start** — everyone hears the count-off + beat 1 at the
  same wall-clock moment
- **Local-first gameplay** — each player's audio, MIDI/keyboard input,
  hit detection, and scoring run on their own machine. Frame-perfect
  feel locally. Their inputs never leave their device for hit-judgement.
- **Shared score sidebar** — scores stream up via Supabase Realtime
  every ~1s; each player sees the others' totals updating on their HUD
- **Voice chat externalised** — Discord / WebRTC / phone, not built in v1
- **Results compared at end** — same per-slot rows + grades as local

You get the **feeling** of playing together — same song at the same
moment, scores racing, results compared — without pretending the
network is faster than physics.

### Architectural fit

We're already 80% set up for this **on purpose**. CLAUDE.md principle
#2: "game logic is local; sync is async." Concretely:

- ✅ `gameplay-engine.js` is parameterised + local — each player runs
  their own instance with their own slice of the config
- ✅ `Clock.startSong({ countoffStartsAt })` accepts an absolute timestamp
  for synchronised starts — already wired (commit b4af140)
- ✅ Supabase Realtime is in production for inbox / play invites — the
  transport for everything new
- ✅ `play_sessions` + `play_session_slots` schema works for both
  modes; we just need RLS to allow "I write my own slot" for remote
- ✅ Identity model (§26) treats the player's user_id as the unit of
  attribution regardless of where the bits originated

What's missing:

- ❌ Lobby concept — a session-in-progress that friends can join before
  the song starts
- ❌ Real-time score broadcast layer
- ❌ Clock-skew measurement against the server
- ❌ RLS update so each remote player writes their own slot row
- ❌ Lobby UI (create, share invite, join, ready check)
- ❌ Disconnect / reconnect handling

### Conceptual model — Local vs Remote unified

|                          | Local couch coop                     | Remote                                  |
|---|---|---|
| **Who creates the session** | Host (auto, on Start)              | Host (auto, on lobby Start)             |
| **Who's in the session**    | Slots claimed via 6-digit codes / guests | Players joined via lobby invite       |
| **Identity source**         | `session_attachments` (§26 evolution) | The player's own auth session         |
| **Who writes which slot**   | Host writes all (RLS allows)         | Each player writes their own (RLS extension) |
| **Audio / input**           | Local (one machine, multiple devices) | Local (each player on their own machine) |
| **Clock**                   | Host's local clock                   | Server time + each client's clock-skew offset |
| **Score visibility live**   | Side-by-side on host's screen        | Live HUD via Realtime broadcasts        |

Both modes write the **same** `play_sessions` + `play_session_slots`
rows, so HISTORY, PB display, and stats queries don't care which mode
the song was played in.

### New schema

```sql
create table lobbies (
  id            uuid primary key default gen_random_uuid(),
  host_user_id  uuid references auth.users on delete cascade not null,
  song_file     text not null,
  song_title    text not null,
  state         text not null check (state in
                    ('waiting','ready','starting','playing','done','abandoned'))
                  default 'waiting',
  speed_level      int,
  hit_window_level int,
  start_at         timestamptz,           -- server time when count-off fires
  session_id       uuid references play_sessions, -- set when state→'playing'
  created_at       timestamptz default now(),
  expires_at       timestamptz default (now() + interval '2 hours')
);

create table lobby_participants (
  lobby_id      uuid references lobbies on delete cascade not null,
  user_id       uuid references auth.users on delete cascade not null,
  slot          int check (slot between 1 and 4),
  instrument    text,
  track_index   int,
  is_ready      boolean default false,
  joined_at     timestamptz default now(),
  primary key (lobby_id, user_id)
);
```

Both in the `supabase_realtime` publication so clients can subscribe
to changes.

### RLS sketch

- `lobbies`: INSERT = own host_user_id; SELECT = host OR participant
  (via SECURITY DEFINER helper, same recursion-fix pattern as the
  play_sessions tables); UPDATE/DELETE = host only
- `lobby_participants`: INSERT = self OR host; SELECT = anyone in the
  same lobby; UPDATE = self (for is_ready) OR host (for slot/instrument
  reassignment); DELETE = self (leave) or host (kick)
- `play_session_slots`: extend `pss_insert_host` to also allow
  `pss_insert_self_in_session` — `user_id = auth.uid() AND
  user_in_session(session_id)`

### Realtime channels

One channel per lobby: `lobby:<id>`. Players subscribe on join.

Messages:
- `participant_joined` / `participant_left` (DB-driven via Realtime
  changes on lobby_participants)
- `state_change` (lobby state field updates)
- `clock_sync_pong` (server timestamp echo for skew measurement)
- `score_tick` — broadcast every ~1 second from each player:
  `{ user_id, score, combo, perfect, good, miss, wrong, accuracy }`
- `song_ended` — when a player finishes, marks them done in the lobby

### Clock sync

The hard part, but bounded. Approach:

1. Before the host fires "starting", every client sends a few `clock_sync_ping`
   broadcasts and measures round-trip via the server timestamp echo.
2. Each client computes its own `serverTime - localTime` offset.
3. Host picks a `start_at = serverTime + 3 seconds` (enough lead for
   slowest client) and writes it to the lobby row.
4. Realtime fans the `start_at` to all participants.
5. Each client converts: `localStartAt = start_at - clockOffset`.
6. Each client calls `engine.start({ countoffStartsAt: localStartAt })`.
7. All count-offs fire at the same wall-clock instant; song stays in
   sync because everyone advances their own local audio clock.

Acceptable drift: ~30ms across clients on a typical home connection.
Worse than that and we'd surface a "you and Sarah are out of sync — try
again on better wifi" notice.

### Build phases

Each is committable in isolation:

1. **Migration**: lobbies + lobby_participants tables, RLS, helper
   functions, RPCs.
2. **Lobby service**: `js/services/lobbies.js` — create, join, leave,
   ready, kick, set start_at.
3. **Lobby UI**: new `play.html` state between song-select and setup
   when "Remote game" is chosen. Shows participant list, ready
   checkboxes, share-invite link.
4. **Realtime wiring**: per-lobby channel, score broadcast, state
   change propagation.
5. **Clock sync**: ping/pong implementation + the synchronised-start
   handshake. Engine integration via existing `countoffStartsAt`.
6. **Score sidebar in gameplay**: small HUD overlay showing each remote
   player's live score (updated on score_tick).
7. **End-of-song**: each player writes their own slot via the new RLS
   path; results screen aggregates.
8. **RLS extension**: `pss_insert_self_in_session` policy.

### Honest scope estimate

If we did them back-to-back with no other distractions:

- Phase 1 + 2 + 8: ~1 focused session
- Phase 3 + 4: ~1 focused session
- Phase 5: ~half session (the hardest math but well-defined)
- Phase 6 + 7: ~half session
- Polish (invite-via-link flow, disconnect handling, lobby teardown,
  empty states, mobile responsiveness): ~1 session

So **~3-4 focused sessions** to a functional first version. Less if we
ship a "minimum viable remote" with fixed song picked by host, no
late-join, no reconnect. More if voice chat or WebRTC is in scope (it
shouldn't be in v1 — Discord works).

The pieces that already exist do the heavy lifting. The lobby
infrastructure is the only genuinely new architectural concept; the
rest is plumbing.

### What this does NOT cover (deliberate)

- **In-game live opponent visuals**: you don't see your friend's hits
  on your screen during play. Latency forbids it. You see their score
  in the HUD only.
- **Voice chat**: out of scope. Discord / phone / WebRTC integration
  is a separate v3 feature.
- **AI fill-in for missing players**: if a friend disconnects mid-song,
  their slot just stops scoring. No bot replacement.
- **Spectator mode**: not v1. Could be added by allowing
  `lobby_participants.slot = NULL` for watchers.

### Open questions

- Should the lobby's `start_at` be hard-coded to "3 seconds from now"
  or adaptive based on the worst observed clock-sync round-trip?
- Late join (during count-off vs during song): allow / forbid / clamp?
- What happens to scores when a player has clock drift > 100ms — flag
  the session or just save it with a note?
- Honesty-mode PB toggle (§26 future) becomes more important: should
  remote-played PBs count the same as solo PBs?

---

*End of document. Edit in place; commit changes alongside code; tag major revisions in §22.*
