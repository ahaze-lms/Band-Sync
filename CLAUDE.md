# BandSync — Claude Code Context

BandSync is a browser-based Synthesia-style multiplayer rhythm game for up to 4 players.
Live site: https://ahaze-lms.github.io/Band-Sync/
Repo: https://github.com/ahaze-lms/Band-Sync
Full design spec: DESIGN.md

---

## Dev workflow

**Push to main — GitHub Pages deploys in ~30 seconds. That is the dev loop. No localhost needed.**

```
git add <files>
git commit -m "..."
git push
```

Never suggest running a local server unless the user explicitly asks. The live site is always the target.

**Cache busting:** when `gameplay.js` or other canvas/module-scope files change significantly, bump the `?v=` query string on the `<script>` tag in the relevant HTML file so browsers don't serve stale modules.

---

## Stack

- Vanilla HTML5 + CSS3 + JavaScript (ES modules) — no frameworks, no build tools, no build step ever
- Web MIDI API — Chrome only; block other browsers with a friendly message
- Web Audio API — AudioContext singleton
- HTML5 Canvas — per-player view rendering
- Supabase — Postgres + Auth + Realtime (project: `pmccwxovzhfdkuqzhkez.supabase.co`)
- GitHub Pages — static hosting, auto-deploys on push to `main`
- `js/vendor/supabase.umd.js` — Supabase bundled locally, no CDN

---

## Key files

| File | What it is |
|---|---|
| `index.html` | Auth-gated SPA shell — login, home, friends, inbox, profile |
| `play.html` | Real game — reserved, not yet built |
| `studio.html` | Song Creator — reserved, not yet built (stub page exists) |
| `2player.html` | 2-player prototype — access via Dev Lab |
| `lab.html` | Dev Lab hub — links to prototype + all debug tools |
| `js/app.js` | SPA router + nav bar |
| `js/config.js` | All shared constants — timing, hit windows, scoring, colors |
| `js/core/` | Engine modules: timing, audio, scoring, midi, calibration, midi-parser, drum-mapping |
| `js/render/` | Canvas renderers: `piano.js`, `drums.js` (factory functions) |
| `js/screens/` | SPA screens: auth, home, profile-edit, friends, inbox; future: gameplay, results, library, studio |
| `js/services/` | Supabase clients: auth.js, profile.js, social.js, supabase.js |
| `songs/` | Bundled `.mid` files |
| `debug/` | Standalone debug tools (piano_debug, drum_debug, drum_monitor, midi_test, bandsync_mockup) |
| `supabase/schema.sql` | Full DB schema — run once in Supabase SQL editor to set up a fresh project |

---

## Architecture principles

1. **No frameworks, no build step.** Files are served as-is. ES modules import directly. Never introduce a bundler or transpiler.

2. **Game logic is local; sync is async.** The audio clock never depends on the network. Supabase is for persistence, auth, AI, and payments — never for real-time gameplay timing.

3. **Abstract drums, never raw MIDI notes.** Game logic only knows `KICK`, `SNARE`, `HH_CLOSED`, etc. A per-device mapping translates MIDI note numbers to these abstract names. Never store or compare raw MIDI note numbers in drum logic.

4. **Modules over classes, factories where state is needed.** `createScorer()` returns a fresh per-player scorer; the timing engine is a singleton because there is only one song clock.

5. **Renderers are factories.** `createPianoRenderer(canvas, opts)` and `createDrumRenderer(canvas, opts)` return renderer objects. Both the gameplay screen and debug tools compose these.

---

## Timing system — do not change without careful testing

```js
// Song clock starts pre-rolled so beat 1 hits exactly when the count-off ends
songStart = performance.now() - (COUNTOFF_TOTAL_MS - fallTimeMs);

// Time query
getSongTime() = performance.now() - songStart - pauseOffset
// Returns -1 if clock isn't running. Negative during count-off.

// Hit detection
expectedHitTime = note.startMs + fallTimeMs + userOffset
diff = |songTime - expectedHitTime|
```

Constants (in `js/config.js`):
```
HIGHWAY_H         = 400px
HIT_Y             = 396px  (HIGHWAY_H - 4)
COUNTOFF_BEATS    = 4
COUNTOFF_BPM      = 80
COUNTOFF_TOTAL_MS = 3000ms
```

Speed is fall duration in seconds (level 3 = 3.0s default). Hit windows are ±ms pairs per difficulty level (level 4 = ±80ms perfect / ±160ms good default).

---

## What's working today

- **2-player gameplay** (`2player.html`) — piano + drums or two pianos, verified on physical MIDI hardware
- **Per-player instrument picker** — P1 and P2 independently switch piano/drums at runtime
- **Scoring** — PERFECT/GOOD/MISS/WRONG, combo multiplier (x1→x8), S/A/B/C/D grades per player
- **MIDI** — auto-detect, per-device routing, shared-device multiplexing, manual override
- **Calibration** — per-device latency offset, 3-round averaging, fine-tune buttons
- **Social layer** (`index.html`) — Supabase auth, profiles, friend requests, real-time inbox, play invites
- **Dev Lab** (`lab.html`) — hub page in the nav, links to prototype + debug tools

---

## What's being built next

### `play.html` — the real game
Mini-SPA with 4 states:
1. Song select — list of `.mid` files from `songs/`
2. Setup — **up to 4 players** (UI currently exposes 1–2; design supports 1–4). Per player: instrument, MIDI device, **and track** (which of the song's tracks they'll play — e.g. Melody vs Bass). Any subset of players can share a track ("duel mode") — same notes, independent scores. Auto-defaults when player count exceeds track count, but is also a free choice.
3. Game — same engine as `2player.html`, parameterized by player count and per-player track selection
4. Results — per-player scores, accuracy, grade, Play Again / Menu

Auth: Supabase auth state persists in localStorage across page loads. Call `supabase.auth.getUser()` at load; redirect to `index.html` if no session. Logged-in user is P1 by default. Play invites: load from `play.html?invite=<id>`.

### `studio.html` — Song Creator
Full spec in `DESIGN.md §25`. Key decisions:

**Instruments:** piano + drums are the two working instrument views. Each has a different piano roll: piano = MIDI pitch Y-axis (88-key keyboard on left), drums = named lane Y-axis (KICK, SNARE, HH_CLOSED…, no duration). Bass (v1.5), guitar (v2.0), vocals (v2.5) planned.

**Collaboration:** song owner assigns track slots to specific friends. Assigned friend owns their track (owner can always override). Async first (shared Supabase doc); real-time via Supabase Realtime in v2 (one person per track = no conflicts).

**Sharing — two distinct actions, never conflated:**
- *Invite to Collaborate* — specific friend, edit access to their assigned track
- *Publish to Library* — friends-only or public, play-only access

**Visibility:** `private` / `friends` / `public`. Public songs appear in Browse/Discover and can be remixed (forked to a new private project, attribution preserved).

**New modules needed:**
- `js/core/recorder.js` — live MIDI capture with timestamps
- `js/core/quantizer.js` — snap notes to grid at variable strength (0–100%)
- `js/core/song.js` — song data model, serialize, export to `.mid`
- `js/render/piano-roll.js` — canvas piano roll, instrument-specific views
- `js/services/library.js` — Supabase CRUD for `songs` + `song_collaborators`

**Supabase additions needed:** `songs` table and `song_collaborators` table — see `DESIGN.md §25` for full SQL.

---

## Supabase

Project: `pmccwxovzhfdkuqzhkez.supabase.co`

Current tables: `profiles`, `friend_requests`, `messages`, `play_invites`
Planned tables: `songs`, `song_collaborators`, `device_codes`, `play_sessions`, `play_session_slots`

All tables have Row Level Security. A Postgres trigger auto-creates a `profiles` row on every new `auth.users` insert. All four current tables are in the `supabase_realtime` publication.

## Player identity (3 modes per slot)

`play.html` setup assigns one of three identities per player slot — see `DESIGN.md §26` for the full spec, schema, RLS, and threat model:
- **Host** — the logged-in Supabase user; default for P1
- **Friend** — another Supabase user, attached via a 6-digit device code generated on their phone (single-use, 10-min TTL); scores save to *their* account
- **Guest** — anonymous; scores live only on the session row, not tied to any user

Score persistence writes one `play_sessions` row + N `play_session_slots` rows (one per slot, even guests) on song complete.

---

## Visual style

- Dark base: `#0a0a0f`
- Primary accent: `#7F77DD` (purple)
- Secondary accent: `#1D9E75` (teal)
- Per-player accent color runs through notes, score card, key highlights
- Sharp typography, minimal decoration, no skeuomorphism
- Font: `'Segoe UI', sans-serif`
- Card pattern: `background: #0d0d14`, `border: 0.5px solid #1e1e2a`, `border-radius: 10px`
- Hover border: `#7F77DD` (purple cards) or `#1D9E75` (teal cards)

---

## Known issues (do not fix without flagging)

- Miss detection does not include `userOffset` (inconsistent with hit detection — intentional deferral)
- Count-off BPM is hardcoded at 80, does not yet match song BPM
- Calibration overlay logic is duplicated across 3 screens (piano_debug, drum_debug, gameplay) — candidate for `js/ui/calibration-overlay.js`
