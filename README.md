# BandSync

A browser-based, Synthesia-style multiplayer rhythm game for up to 4 players. Each player connects a MIDI instrument, picks a role (piano, drums, ...), and plays along to a song as notes fall on screen.

**Stack:** Vanilla HTML5 + CSS3 + JavaScript (ES modules). Web MIDI API. Web Audio API. HTML5 Canvas. Supabase (Postgres + Auth + Realtime). No frameworks, no build tools.

**Live site:** <https://ahaze-lms.github.io/Band-Sync/>

---

## Where we are

### Gameplay prototype — playable at `play.html`

- ✅ Two-player split-screen — piano + drums, or two pianos
- ✅ Independent scoring, combo, accuracy, S/A/B/C/D grades per player
- ✅ Big PERFECT / GOOD / MISS / WRONG feedback overlays per side
- ✅ MIDI auto-detect with manual override (per player)
- ✅ Multi-device routing; shared device routes to both players for unison play
- ✅ Per-device latency calibration (per-player buttons)
- ✅ 7-level hit window scale (Practice → Expert) for kids through pros
- ✅ 10-level speed scale (4.0s → 0.5s fall time)
- ✅ Count-off engine with metronome click
- ✅ Multi-track `.mid` file loading with auto-role detection
- ✅ Hover tooltips on every HUD stat

### Social & account layer — live at `index.html`

- ✅ Email/password auth (Supabase Auth)
- ✅ User profiles — username, display name, avatar, accent color, tagline
- ✅ Friend requests, friend list, online presence indicators
- ✅ Real-time inbox — direct messages between friends
- ✅ Play invites — send / accept / decline game invitations
- ✅ Profile setup onboarding for new users

---

## Project structure

```
Band-Sync/
├── index.html              Auth-gated SPA shell (login, home, social)
├── play.html               2-player gameplay screen (standalone)
├── js/
│   ├── app.js              SPA router + nav + auth state
│   ├── config.js           Shared constants (timing, hit windows, etc.)
│   ├── core/               Engine modules (timing, midi, audio, scoring, ...)
│   ├── render/             Canvas renderers (piano, drums)
│   ├── input/              MIDI-to-game input mapping
│   ├── screens/            SPA screens (auth, home, profile-edit, friends, inbox)
│   ├── services/           Supabase clients (auth, profile, social)
│   └── vendor/             Local copies of third-party libraries (supabase.umd.js)
├── supabase/
│   └── schema.sql          Full DB schema — run once in Supabase SQL editor
├── songs/                  Sample .mid files
└── debug/                  Standalone debug tools (piano_debug, drum_debug, ...)
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

Tables: `profiles`, `friend_requests`, `messages`, `play_invites`

To set up a fresh Supabase project, run `supabase/schema.sql` in the SQL editor. That creates all tables, RLS policies, the auto-profile trigger, and enables Realtime.

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
