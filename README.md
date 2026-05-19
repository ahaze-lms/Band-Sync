# BandSync

A browser-based, Synthesia-style multiplayer rhythm game for up to 4 players. Each player connects a MIDI instrument, picks a role (piano, drums, ...), and plays along to a song as notes fall on screen.

**Stack:** Vanilla HTML5 + CSS3 + JavaScript (ES modules). Web MIDI API. Web Audio API. HTML5 Canvas. Supabase (Postgres + Auth + Realtime). No frameworks, no build tools.

**Live site:** <https://ahaze-lms.github.io/Band-Sync/>

---

## Where we are

### Real game — live at `play.html`

- ✅ Song select from a bundled library + per-song personal-best display
- ✅ Setup screen — Speed (1-10) + Difficulty (1-7) on top, per-player identity / instrument / MIDI device / track pickers below
- ✅ 1, 2, 3, and 4-player grid layouts (3-4 layout-ready; needs ≥3 MIDI devices for hardware testing)
- ✅ Independent scoring, combo, accuracy, S/A/B/C/D grades per player; PERFECT / GOOD / MISS / WRONG overlays
- ✅ Always-on note name labels on falling blocks (teach-by-exposure for all players)
- ✅ Warm-up state — engine alive on entry so players can find hand position before clicking ▶ START SONG
- ✅ MIDI auto-detect, multi-device routing, shared-device multiplexing, per-device latency calibration
- ✅ **Computer Keyboard as a first-class input device** — QWERTY → MIDI mapping covers 2 octaves (mutex: one slot per machine)
- ✅ ResizeObserver-driven crisp canvas at any display size (4K → mobile)
- ✅ Results screen with per-slot breakdown, identity display, NEW PERSONAL BEST badge
- ✅ Session history persisted to Supabase (`play_sessions` + `play_session_slots`) — HISTORY nav screen with date grouping
- ✅ Personal replay — every noteOn during a run is recorded; "⏪ REPLAY" button on results plays it back through the engine
- ✅ Mobile pass — 480px breakpoint, 44px touch targets, lifted dark-navy theme for daylight readability

### Remote multiplayer — live (§27, all 8 phases shipped)

- ✅ Lobbies + lobby participants with full RLS, Supabase Realtime roster sync
- ✅ Song-select MODE toggle (SOLO/COUCH ↔ REMOTE LOBBY); `?lobby=<id>` URL auto-joins for shareable invites
- ✅ Lobby warmup panel — device picker + live playable piano/drum canvas below the lobby cards
- ✅ Lobby chat — ephemeral Broadcast chat on `lobby:<id>` while waiting
- ✅ Clock sync via `get_server_time()` + 5-sample offset measurement; host writes `start_at = serverNow + 8s` and every client fires count-off at the same wall-clock instant
- ✅ Live score strip above each player's canvas — `~1Hz` Broadcast on `game:<lobbyId>`
- ✅ End-of-song persistence — host writes the shared `play_sessions` header; each player writes their own slot via `pss_insert_self_in_session`. Everyone's HISTORY shows the same session.
- ✅ Friend-invite-from-lobby — `play_invites.lobby_id` extension + 30-min expiry; home screen renders JOIN LOBBY link

### Player identity (§26 + Evolution v2)

- ✅ Three identity modes per slot: **Host** (logged-in user), **Friend** (attached via 6-digit device code, scores save to their account), **Guest** (anonymous; scores live only on the session row)
- ✅ Durable session attachments — claim issues a localStorage token so reloads rehydrate without a fresh code (24h TTL, revocable from CONNECTED DEVICES)
- ✅ Paired-friend dropdown for one-tap reattach within the token window

### Social & account layer — live at `index.html`

- ✅ Email/password auth (Supabase Auth)
- ✅ User profiles — username, display name, avatar, accent color, tagline
- ✅ Friend requests, friend list, online presence indicators
- ✅ Real-time inbox — direct messages between friends
- ✅ Play invites — send / accept / decline game invitations (couch and remote)
- ✅ Profile setup onboarding for new users
- ✅ PAIRING card (generate device codes) + CONNECTED DEVICES card (revoke attachments) + RECENT ACCOUNT ACTIVITY audit log

### Dev harness

- `2player.html` — original 2-player prototype, kept as a dev/test surface (file picker, role toggle, test patterns, calibration overlay). Reached via Dev Lab.
- `lab.html` — Dev Lab hub linking to the prototype + all debug tools (piano_debug, drum_debug, drum_monitor, midi_test, bandsync_mockup).

---

## Project structure

```
Band-Sync/
├── index.html              Auth-gated SPA shell (login, home, friends, inbox, profile)
├── play.html               Real game — song select → setup → game → results, plus remote lobby
├── studio.html             Song Creator — stub only; build is next major effort (DESIGN.md §25)
├── 2player.html            Original 2-player prototype (access via Dev Lab)
├── lab.html                Dev Lab hub — links to prototype + all debug tools
├── js/
│   ├── app.js              SPA router + nav + auth state
│   ├── config.js           Shared constants (timing, hit windows, etc.)
│   ├── core/               Engine modules — gameplay-engine, timing, audio, scoring, midi, calibration, midi-parser, drum-mapping
│   ├── render/             Canvas renderers (piano, drums) as factory functions
│   ├── input/              MIDI-to-game input mapping
│   ├── screens/            SPA screens (auth, home, profile-edit, friends, inbox)
│   ├── services/           Supabase clients — auth, profile, social, supabase, device-codes, session-attachments, history, play-sessions, lobbies
│   └── vendor/             Local copies of third-party libraries (supabase.umd.js)
├── supabase/
│   └── schema.sql          Full DB schema — run once in Supabase SQL editor
├── songs/                  Bundled public-domain .mid files
├── tools/                  Build scripts (build-songs.mjs)
└── debug/                  Standalone debug tools (piano_debug, drum_debug, drum_monitor, midi_test, bandsync_mockup)
```

---

## Development workflow

The live site is the primary target. Push to `main` and GitHub Pages deploys in ~30 seconds.

```bash
git add .
git commit -m "..."
git push
```

For local testing while writing code (ES modules require a server, not `file://`):

```bash
# from the project root
python -m http.server 8000
# open http://localhost:8000
```

---

## Deploying

GitHub Pages auto-deploys on every push to `main`. No CI, no config needed.

Live at <https://ahaze-lms.github.io/Band-Sync/>.

---

## Backend (Supabase)

Project: `pmccwxovzhfdkuqzhkez.supabase.co`

Tables: `profiles`, `friend_requests`, `messages`, `play_invites`, `device_codes`, `session_attachments`, `play_sessions`, `play_session_slots`, `lobbies`, `lobby_participants`

To set up a fresh Supabase project, run `supabase/schema.sql` in the SQL editor. That creates all tables, RLS policies (with `SECURITY DEFINER` recursion-fix helpers for cross-table policies), the auto-profile trigger, and enables Realtime on the user-facing tables. In-lobby chat and `score_tick` traffic ride Supabase Broadcast channels (not DB-driven Realtime).

**Admin / data browser:** Supabase dashboard → Table Editor. View and edit all rows directly.

---

## Browser support

Chrome only. Web MIDI is required and isn't supported in Safari or Firefox at this time. Tested on Windows 11 with:

- Akai MPK Mini 3 (keyboard controller)
- Casio CDP-S160RD (88-key digital piano)
- Simmons SD5X (electronic drum kit)
- PreSonus FirePod (audio interface, also exposes MIDI)

---

## Design spec

See `DESIGN.md` for the full architecture, roadmap, timing system, scoring, and decision log.
