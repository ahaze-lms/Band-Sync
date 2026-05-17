# BandSync

A browser-based, Synthesia-style multiplayer rhythm game for up to 4 players. Each player connects a MIDI instrument, picks a role (piano, drums, ...), and plays along to a song as notes fall on screen.

**Stack:** Vanilla HTML5 + CSS3 + JavaScript (ES modules). Web MIDI API. Web Audio API. HTML5 Canvas. No frameworks, no build tools.

**Hosted on:** GitHub Pages — <https://ahaze-lms.github.io/Band-Sync/>

---

## Project structure

```
Band-Sync/
├── index.html              App shell / hub page
├── css/                    Shared stylesheets
├── js/
│   ├── config.js           Shared constants (timing, hit windows, etc.)
│   ├── core/               Engine modules (timing, midi, audio, scoring, ...)
│   ├── render/             Canvas renderers (piano, drums)
│   ├── input/              MIDI-to-game input mapping
│   └── screens/            Top-level screens (gameplay, results, profile)
├── songs/                  Sample .mid files
└── debug/                  Standalone debug tools (piano_debug, drum_debug, ...)
```

Anything in `debug/` is a self-contained tool used during development. Anything under `js/` is part of the shipped app.

---

## Running it locally

Because the app uses ES modules, browsers won't load it from `file://` URLs. You need a tiny local server.

```bash
# from the project root
python -m http.server 8000

# then open
# http://localhost:8000
```

That's it. Any change to a file shows up on refresh — no build step.

Open `http://localhost:8000/debug/piano_debug.html` (etc.) to use the standalone debug tools.

---

## Deploying

GitHub Pages auto-deploys on every push to `main`. No CI, no config.

```bash
git add .
git commit -m "..."
git push
```

Live site updates in ~30 seconds at <https://ahaze-lms.github.io/Band-Sync/>.

---

## Browser support

Chrome only. Web MIDI is required and isn't supported in Safari or Firefox at this time. Tested on Windows 11 with the following MIDI devices:

- Akai MPK Mini 3 (keyboard controller)
- Casio CDP-S160RD (88-key digital piano)
- Simmons SD5X (electronic drum kit)
- PreSonus FirePod (audio interface, also exposes MIDI)

---

## Design spec

The full design doc is `BandSync_Web_Design_Doc_v8.docx` at the project root. It covers the timing architecture, scoring system, drum mapping abstraction, calibration flow, and the full 11-screen app flow.
