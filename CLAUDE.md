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

**No PRs, no feature branches, no worktrees.** This is a solo project — Anthony is the only contributor and reviews changes by looking at the live site. Commit directly to `main` and push. If a Claude Code session somehow lands in a worktree on a side branch, flag that to the user at the start so they can relaunch in the main repo folder instead of doing PR ceremony for every change. If you must work from a worktree, push directly to main with `git push origin HEAD:main` rather than opening a PR.

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
| `play.html` | Real game — live; song-select → setup → game → results, plus full remote-multiplayer lobby (§27 all phases shipped) |
| `studio.html` | Song Creator — reserved, not yet built (stub page exists) |
| `2player.html` | 2-player prototype — access via Dev Lab |
| `lab.html` | Dev Lab hub — links to prototype + all debug tools |
| `js/app.js` | SPA router + nav bar |
| `js/config.js` | All shared constants — timing, hit windows, scoring, colors |
| `js/core/` | Engine modules: timing, audio, scoring, midi, calibration, midi-parser, drum-mapping |
| `js/render/` | Canvas renderers: `piano.js`, `drums.js` (factory functions) |
| `js/screens/` | SPA screens: auth, home, profile-edit, friends, inbox; future: gameplay, results, library, studio |
| `js/services/` | Supabase clients: auth, profile, social, supabase, device-codes, session-attachments, history, play-sessions, lobbies |
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

- **`play.html` — the real game** (the production gameplay surface)
  - Song select pulling from `songs/manifest.json`
  - Setup screen with **Speed (1-10) + Difficulty (1-7) selectors** at the top, per-player identity / instrument / MIDI device / track pickers below
  - Identity per slot: Me (host) / Friend (via code) / Guest (editable name)
  - **Computer Keyboard** is a first-class device option in the picker (with mutex — only one slot can own it). QWERTY → MIDI mapping covers 2 octaves (z-row C4, q-row C5)
  - Gameplay using the extracted `js/core/gameplay-engine.js` — same loop, parameterized for 1–4 players
  - 1/2/3/4-player grid layouts; score strip on top, canvas fills via object-fit
  - **Warm-up state** — clicking START on setup lands in the game screen with engine alive (audio + input responsive, no count-off, no scoring). Big `▶ START SONG` button kicks off the actual run.
  - **Always-on note labels** on falling blocks (C, F#, D…) so all players learn note recognition by exposure. Keyboard-input players also see the QWERTY key letter as a secondary hint.
  - Per-player live score card, feedback overlays, song timer, pause/restart
  - **ResizeObserver-driven crisp canvas** — pixel buffer matches `displaySize × devicePixelRatio` so the keyboard is sharp at any screen size (4K monitors, mobile, anything in between)
  - Results screen with per-slot stats, identity display, **NEW PERSONAL BEST** badge
  - End-of-song persistence to `play_sessions` + `play_session_slots`
  - PB display under each song on setup (`YOUR BEST: 14,400 · S · 98% · 2d ago`)
- **`2player.html`** — original prototype, still alive as a dev/test harness (reached via Dev Lab). Has unique features: role toggle, test patterns, file picker, calibration overlay. NOT yet ported to the new engine — `js/screens/gameplay.js` duplicates the loop logic (deferred phase 3c).
- **Player identity (`DESIGN.md §26` + §26 Evolution v2)** — 6-digit device codes for first-time pairing (PAIRING in profile, 10-min TTL, single-use), claimed at play.html setup (6-digit modal). On claim, Supabase also issues a **durable session token** stored in localStorage; reloads call `attach_session(token)` to rehydrate the friend identity without a fresh code (24h TTL, revocable). Previously-paired friends appear in the identity dropdown for one-tap reattach. CONNECTED DEVICES card in profile-edit lists active attachments with Revoke. Opportunistic cleanup runs on every new claim (>30d expired/revoked attachments, >90d used codes).
- **HISTORY screen** — chronological list of every session you appear in, grouped by date, with PB badges
- **Social layer** (`index.html`) — Supabase auth, profiles, friend requests, real-time inbox, play invites
- **Mobile pass** (quick wins, not a full redesign): bumped color contrast + base font, inbox flips to single-pane with back button + `dvh` viewport + 16px inputs to avoid iOS auto-zoom, play.html stacks panels vertically and uses default `object-fit:contain` so the keyboard stays visible
- **Engine fundamentals** — scoring (PERFECT/GOOD/MISS/WRONG, x1→x8 combo, S/A/B/C/D), MIDI auto-detect + shared-device multiplexing, per-device latency calibration, count-off with `Clock.startSong({ countoffStartsAt })` parameterised for the eventual remote-multiplayer synchronised start
- **Dev Lab** (`lab.html`) — hub for the prototype + all debug tools

---

## What's being built next

Primary candidates (no specific order — pick by appetite):

- **`studio.html` — Song Creator** (the biggest unbuilt thing). Spec in `DESIGN.md §25`: record live MIDI, quantize, instrument-specific piano roll, save to Supabase, async collaboration, publish to library.
- **Drum-track playback in songs**. Needs a GM drum-map translation in `js/core/midi-parser.js` so drum tracks reach the engine as abstract names. Bundled songs are all piano-only today.
- **Calibration in `play.html`**. The 2player.html prototype has a calibration overlay; extracting it into a shared `js/ui/calibration-overlay.js` module unlocks adding it to play.html too. Flagged as duplicated across 3 screens.
- **Real piano + drum samples**. Replaces synthesised audio; biggest perceived-quality jump for the least work per `DESIGN.md §18`.
- **Phase 3c**: port `js/screens/gameplay.js` to use the engine, eliminating the duplicate loop. Pure cleanup, no user-visible payoff — defer unless 2player.html is going to get active changes.

Smaller polish items still on the board: Twilio SMS invites (`DESIGN.md §26 → Future enhancements`), connected-devices revoke-all, in-game banner when friend is attached, accuracy-bar animations on results.

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

Current tables: `profiles`, `friend_requests`, `messages`, `play_invites`, `device_codes`, `session_attachments`, `play_sessions`, `play_session_slots`, `lobbies`, `lobby_participants`
Planned tables: `songs`, `song_collaborators`

All tables have Row Level Security. A Postgres trigger auto-creates a `profiles` row on every new `auth.users` insert. Tables in the `supabase_realtime` publication: `profiles`, `friend_requests`, `messages`, `play_invites`, `lobbies`, `lobby_participants`. Realtime Broadcast (not DB-driven) is used for in-lobby chat and `score_tick` traffic.

## Player identity (3 modes per slot)

`play.html` setup assigns one of three identities per player slot — see `DESIGN.md §26` for the full spec, schema, RLS, and threat model:
- **Host** — the logged-in Supabase user; default for P1
- **Friend** — another Supabase user, attached via a 6-digit device code generated on their phone (single-use, 10-min TTL); scores save to *their* account
- **Guest** — anonymous; scores live only on the session row, not tied to any user

Score persistence writes one `play_sessions` row + N `play_session_slots` rows (one per slot, even guests) on song complete.

**Evolution v2 (shipped)** — `§26` Evolution v2 is built end-to-end. Schema: `session_attachments` table + updated `claim_device_code` (now returns `session_token`) + `attach_session` / `revoke_session_attachment` RPCs. Service: `js/services/session-attachments.js` with localStorage layer + RPC wrappers + `reattachAll` boot rehydrate + `listPaired` for the one-tap dropdown. UI: paired friends in `play.html` identity dropdown, CONNECTED DEVICES card in profile-edit with Revoke buttons.

## Remote multiplayer (§27 — all 8 phases shipped)

`DESIGN.md §27` specs the lobby model: each player runs their own engine on their own machine (local-first), synchronised start via `Clock.startSong({ countoffStartsAt })` + Supabase Realtime, score broadcast at ~1Hz. Tables: `lobbies`, `lobby_participants`. Both local and remote write the same `play_sessions` / `play_session_slots` schema so HISTORY is mode-agnostic.

- **Schema + lobby service**: `lobbies` + `lobby_participants` with full RLS (`user_in_lobby` / `user_hosts_lobby` recursion-fix helpers, host vs participant visibility), both in `supabase_realtime` publication, `create_lobby` + `join_lobby` RPCs (atomic, lowest-free-slot assignment, idempotent re-joins). `js/services/lobbies.js`: create/join/leave/setReady/setSlotConfig/kick/setStartAt/setState/updateLobby/getLobby/listParticipants/subscribeLobby + `measureClockOffset()`.
- **Lobby UI**: `play.html` SPA gains a LOBBY state. Song-select MODE toggle (SOLO/COUCH ↔ REMOTE LOBBY). `?lobby=<id>` URL param auto-joins on boot for shareable invites. Live roster + ready states via per-lobby Realtime channel. Host gets KICK + START. Guests get READY UP + LEAVE. Host-abandon detection auto-exits guests with a 2s "HOST LEFT" message.
- **Lobby warmup panel**: device picker (Computer Keyboard or any connected MIDI device) on each participant row + a live playable piano/drum canvas below the lobby cards so players can warm up before the song starts.
- **Lobby chat**: ephemeral Broadcast chat panel on the `lobby:<id>` channel — own messages echoed locally; drafts preserved across repaints (triggered by participant joins / ready-state changes).
- **Phase 5 — clock sync**: `get_server_time()` RPC (migration 0006) + `measureClockOffset()` (5 round-trip samples, trim outliers). Host clicks START → measures offset → writes `start_at = serverNow + 8s` + state='starting'. Non-host: Realtime delivers `start_at`, converts to local `performance.now()` via offset, calls `engine.start({ countoffStartsAt })`. "STARTING IN X" countdown shown in the game-time display during the 8s lead.
- **Phase 6 — score sidebar**: Supabase Broadcast channel `game:<lobbyId>` carries score ticks (~1Hz). Slim strip above the game canvas shows all participants' live score / grade / accuracy.
- **Phase 7 — end-of-song persistence**: host creates `play_sessions` header → stamps `session_id` on the lobby row → writes own slot. Non-hosts poll `getLobby()` (1.5s interval, 30s timeout) until `session_id` appears, then write their slot via `pss_insert_self_in_session`. All players' HISTORY shows the same shared session.
- **Phase 8 — RLS**: `user_in_lobby_session()` helper + `pss_insert_self_in_session` + `pss_select_in_lobby_session` policies.
- **Friend-invite-from-lobby**: `play_invites.lobby_id` column (migration 0007) + 30-min expiry. Home screen detects lobby invites and renders a JOIN LOBBY link.

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
