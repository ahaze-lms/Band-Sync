# BandSync — Design Document v9

> Updated 2026-05-16. Supersedes `BandSync_Web_Design_Doc_v8.docx`.
>
> Major changes from v8: scope expanded from "fun family rhythm game" to a commercial product with user accounts, paywall, AI-assisted music tools, and a built-in MIDI editor. Architecture refactored to ES modules (no frameworks, no build tools).

---

## 🚦 Current state (2026-05-16)

**Playable.** A 2-player split-screen prototype works end-to-end and has been verified with two physical MIDI devices. See `README.md` for the running checklist of what works.

### What's next when we pick this up

In rough priority order:

1. **Real piano + drum samples** — replace the triangle-wave synthesis. Biggest perceived-quality jump for the least work.
2. **Proper results screen** — replace the single-line "SONG COMPLETE" text with a full screen showing per-player scores, accuracy bars, personal-best flags, and Replay / Play Again / Song Select buttons.
3. **Player profile UI** — names, avatars, accent colors. Still localStorage-backed at this stage; cloud sync arrives with §13 (backend) decisions.
4. **Session history** — every completed song saved to localStorage with date / score / accuracy / grade.
5. **Track-picker UI** for MIDI files with multiple piano or drum tracks (current behavior just picks the first of each — fine for v0.x).
6. **3- and 4-player layouts** — design doc §16 lays out the 2×2 quad grid; mostly a CSS-grid + extra-renderer composition exercise.
7. **Calibration overlay extraction** — duplicated across 3 screens; pull into `js/ui/calibration-overlay.js`.

### Open architectural decisions (still parked)

- Backend stack (working assumption: Supabase)
- Auth provider (depends on backend)
- Pricing tiers
- Domain name
- AI scope sharpening (see §14) — which capability to ship first

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
- **GitHub Pages** for the static frontend
- **Local dev:** `python -m http.server 8000` from project root

### Planned (backend, when accounts land)
- **Backend:** TBD. Top candidates: Supabase (Postgres + auth + storage in one), Firebase, or rolled own Node + Postgres on Fly.io/Render. See §13.
- **Auth:** managed service (depends on backend choice). Email + password, Google OAuth.
- **AI:** Claude API (Anthropic) for the MIDI editor + chart generation
- **Payments:** Stripe Checkout + webhooks
- **Hosting:** moves from GitHub Pages → Vercel or Cloudflare Pages (frontend) + backend host of choice

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
1. **Landing** — logo, "Try free" + "Sign in"
2. **Sign in / sign up** — managed by the auth provider

Logged-in:
3. **Home** — Quick Play / Library / AI Studio / Profile
4. **Profile select** — pick which humans are playing today (multiple profiles, one screen)
5. **Device assignment** — assign MIDI device + role per player, test input
6. **Song select** — pick from library; for multi-track songs, assign tracks to players; shared/dueling option
7. **Count-off** — mandatory 4-beat count-in, notes fall during count-off
8. **Gameplay** — 1-4 panels, falling notes, HUD per player, pause
9. **Song complete** — brief flash before results
10. **Results** — scores, accuracy, grade, personal-best flags, dueling winner
11. **Replay** (paid) — visual + audio playback, expected vs actual side-by-side
12. **Profile + progress** — all-time stats, per-song history, accuracy graph
13. **AI Studio** — piano-roll MIDI editor with Claude suggestions
14. **Library** — saved songs, custom uploads, AI-generated charts
15. **Settings** — global volume, calibrations, drum mappings, account
16. **Subscription** — current tier, upgrade, billing portal (Stripe)

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

## 13. Backend (planned, decision pending)

Top three candidates ranked by fit:

### Supabase (recommended)
- Postgres + auth + storage + realtime in one product
- Generous free tier
- Clean Stripe integration via webhooks
- Single client SDK; row-level security keeps things tidy
- Lock-in is moderate; data is portable (it's Postgres)

### Firebase
- Slightly easier auth UX
- Firestore is NoSQL — awkward for relational data (profiles + sessions + per-song bests)
- Less smooth Stripe integration

### Roll-your-own (Node + Postgres on Fly.io / Render)
- Maximum flexibility, no vendor lock-in
- Far more plumbing to write before features ship
- Auth becomes a project of its own

### Cloudflare Workers + D1 + KV
- Cheapest at scale
- Newer ecosystem; auth requires gluing pieces together
- Better as a v2 migration than a v1 starter

**Working assumption: Supabase**, until a better reason emerges. Final call pending user decision.

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

A song is one MIDI file with up to 4 tracks. Each track is assigned to one player at song-select time.

### Roles (current + planned)
- **Piano** — falling notes on a keyboard view (built ✓)
- **Drums** — falling notes per drum lane (built ✓)
- **Bass** — falling notes on a 4-string fretboard view (planned, v1.5)
- **Guitar** — falling notes on a 6-string fretboard view (planned, v2.0)
- **Vocals** — pitch-contour line with lyrics (planned, v2.5)

Two players can share a track ("dueling") — same notes, independent scores.

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
- ✅ 2-player split-screen gameplay (`play.html`)
- ✅ P2 role toggle (drums or second piano) with localStorage persistence
- ✅ Combined test patterns (piano + drums; piano + piano)
- ✅ Multi-device MIDI routing with auto-detect + override
- ✅ Shared-device multiplexing (one keyboard → both players for unison)
- ✅ Big hit-feedback overlays per player
- ✅ HUD tooltips on every stat
- ✅ Hit window scale extended to 7 levels (Practice + Beginner added for kids)
- ✅ **Verified working** with two physical MIDI devices (MPK Mini 3 + Casio CDP)
- 🔜 3- and 4-player layouts
- 🔜 Real piano + drum samples
- 🔜 Proper results screen (replacing the single-line song-complete text)
- 🔜 Session history in localStorage
- 🔜 Player profile UI (names, avatars, accent colors)
- 🔜 Track-picker UI when a MIDI file has multiple piano or drum tracks
- 🔜 Calibration-overlay extraction into a shared `js/ui/` module

### v1.0 — MVP launchable
- User accounts + cloud sync (backend decision required)
- Paywall (free 1-2P, paid 3-4P + custom uploads)
- Default song library (bundled MIDIs)
- Results screen full
- Profile UI (create, edit, switch)
- Device assignment screen
- Drum mapping calibration tool integrated into onboarding
- Latency calibration migrated to per-profile

### v1.5 — Paid features differentiate
- Custom MIDI upload (paid)
- AI chart simplification (free limited, paid unlimited)
- AI MIDI editor v1 (paid)
- Replay system (paid)
- Bass instrument view

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
| 2026-05-16 | First playable prototype shipped — `play.html` with 2-player split-screen, verified on physical MIDI hardware (MPK Mini 3 + Casio CDP). |
| 2026-05-16 | P2 role is runtime-switchable (drums ↔ piano). Drum work fully preserved. |
| 2026-05-16 | Single-MIDI-device shared between both players is allowed and multiplexes one event stream into both `onP1Midi` and `onP2Midi`. Useful when only one keyboard is plugged in. |
| 2026-05-16 | Hit window scale extended from 5 to 7 levels — Practice (±250/±500) and Beginner (±180/±350) added for younger players. |
| 2026-05-16 | HUD tooltips on every stat. Pattern: `[data-tip]` + `.has-tip` CSS — reusable for future screens. |
| TBD | Backend stack (working assumption: Supabase) |
| TBD | Auth provider (depends on backend) |
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
| `/index.html` | App shell / hub (currently a debug-tool launcher) |
| `/README.md` | Dev workflow + how to run locally |
| `/DESIGN.md` | This file |
| `/css/` | Stylesheets (in progress) |
| `/js/config.js` | All shared constants |
| `/js/core/` | Engine modules (timing, audio, scoring, MIDI, calibration, parser, mapping) |
| `/js/render/` | Canvas renderers (piano, drums, future bass/guitar) |
| `/js/input/` | MIDI-to-game input mapping (future) |
| `/js/screens/` | Top-level screens (gameplay, results, library, studio) |
| `/js/services/` | API/auth/AI/payments clients (future) |
| `/songs/` | Bundled `.mid` files |
| `/debug/` | Standalone debug tools that survived the refactor |
| `/server/` | Backend code (future) |

---

*End of document. Edit in place; commit changes alongside code; tag major revisions in §22.*
