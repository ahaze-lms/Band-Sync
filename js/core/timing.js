// ════════════════════════════════════════════════════════════════════
// BandSync — Timing Engine
// ════════════════════════════════════════════════════════════════════
// The song clock, count-off, and speed/hit-window state. There's exactly
// one song clock in the app (it drives every player's panel) so this
// module owns module-level state — treat it as a singleton.
//
// The clock-pre-roll trick lives here: songStart is set to
//
//   performance.now() - (COUNTOFF_TOTAL_MS - fallTimeMs)
//
// so the first note (startMs = 0) reaches the hit zone exactly as the
// count-off ends. See design doc §7 for the full explanation.
// ════════════════════════════════════════════════════════════════════

import {
  FALL_TIMES_MS,
  HIT_WINDOWS,
  HIGHWAY_H,
  COUNTOFF_BEATS,
  COUNTOFF_TOTAL_MS,
  BEAT_MS,
  DEFAULT_SPEED_LEVEL,
  DEFAULT_HIT_WINDOW_LEVEL,
} from '../config.js';


// ── Clock state (private) ───────────────────────────────────────
let _playing         = false;
let _paused          = false;
let _songStart       = 0;
let _songStartSet    = false;
let _pauseOffset     = 0;
let _pauseStart      = 0;
let _countoffActive  = false;
let _countoffDone    = false;
let _countoffStart   = 0;

// Per-beat tracking for justCrossedBeat() and tickCountoff()
let _lastClickBeat   = -1;

// User-facing settings
let _speedLevel      = DEFAULT_SPEED_LEVEL;
let _hitWindowLevel  = DEFAULT_HIT_WINDOW_LEVEL;


// ════════════════════════════════════════════════════════════════
// SPEED & HIT WINDOW
// ════════════════════════════════════════════════════════════════

export function setSpeedLevel(level) {
  _speedLevel = clamp(level, 1, FALL_TIMES_MS.length);
}

export function getSpeedLevel() {
  return _speedLevel;
}

export function setHitWindowLevel(level) {
  _hitWindowLevel = clamp(level, 1, HIT_WINDOWS.length);
}

export function getHitWindowLevel() {
  return _hitWindowLevel;
}

export function getFallTimeMs() {
  return FALL_TIMES_MS[_speedLevel - 1];
}

// Pixels travelled per frame at 60fps. Renderers should still apply
// delta-time correction (b.y += pxPerFrame * (delta / 16.67)) so the
// note speed is stable across frame rates.
export function getPxPerFrame() {
  return HIGHWAY_H / (getFallTimeMs() / 1000 * 60);
}

export function getHitWindow() {
  return HIT_WINDOWS[_hitWindowLevel - 1];
}


// ════════════════════════════════════════════════════════════════
// SONG CLOCK
// ════════════════════════════════════════════════════════════════

// Start the song. Sets the pre-rolled songStart so notes begin falling
// during the count-off (see comment block at top of file).
//
// Caller is responsible for resetting their own gameplay state
// (scheduled notes, falling blocks, score, etc.) — this function only
// touches the clock.
//
// Options:
//   countoffStartsAt: local performance.now() at which the count-off
//     should begin. Defaults to "now". Pass a future timestamp for
//     synchronized starts in remote multiplayer — each client computes
//     `serverNow + offsetToLocalClock` from the agreed server start
//     timestamp so all clients fire beat 1 at the same wall-clock moment.
//     The tick/getSongTime functions tolerate a future start (elapsed < 0).
export function startSong(options = {}) {
  const fallTimeMs = getFallTimeMs();
  const startAt    = options.countoffStartsAt ?? performance.now();
  _songStart       = startAt - (COUNTOFF_TOTAL_MS - fallTimeMs);
  _songStartSet    = true;
  _countoffActive  = true;
  _countoffDone    = false;
  _countoffStart   = startAt;
  _playing         = true;
  _paused          = false;
  _pauseOffset     = 0;
  _lastClickBeat   = -1;
}

// Stop the clock completely. Use this on reset or when the song ends.
export function stopSong() {
  _playing        = false;
  _paused         = false;
  _countoffActive = false;
  _countoffDone   = false;
  _songStartSet   = false;
  _pauseOffset    = 0;
  _lastClickBeat  = -1;
}

// Toggle pause. Returns the new paused state (true = now paused).
// Adjusts countoffStart so the count-off resumes from where it left off.
export function togglePause() {
  if (!_playing) return _paused;
  _paused = !_paused;
  if (_paused) {
    _pauseStart = performance.now();
  } else {
    const dur = performance.now() - _pauseStart;
    _pauseOffset += dur;
    if (_countoffActive) _countoffStart += dur;
  }
  return _paused;
}

// Current song time in ms. Returns -1 if the clock isn't running.
// During count-off this is negative until beat 1 lands.
export function getSongTime() {
  if (!_playing || !_songStartSet) return -1;
  return performance.now() - _songStart - _pauseOffset;
}


// ════════════════════════════════════════════════════════════════
// STATE GETTERS
// ════════════════════════════════════════════════════════════════

export function isPlaying()        { return _playing; }
export function isPaused()         { return _paused; }
export function isCountoffActive() { return _countoffActive; }
export function isCountoffDone()   { return _countoffDone; }


// ════════════════════════════════════════════════════════════════
// COUNT-OFF
// ════════════════════════════════════════════════════════════════

// Call from the game loop. Returns the count-off display state for
// rendering, or null if the count-off is no longer active.
//
//   { beatNum, beatIndex, beatProgress, elapsed }
//
// beatNum:      1..COUNTOFF_BEATS during count, COUNTOFF_BEATS+1 for "GO!"
// beatIndex:    0-based, useful for indexing
// beatProgress: 0..1 — fraction of the way through the current beat
// elapsed:      ms since count-off started
//
// This function also auto-ends the count-off when it's elapsed.
export function tickCountoff() {
  if (!_countoffActive) return null;
  const elapsed = performance.now() - _countoffStart;
  // Scheduled-future start (remote sync) — count-off hasn't begun yet.
  if (elapsed < 0) return null;
  if (elapsed >= COUNTOFF_TOTAL_MS) {
    _countoffActive = false;
    _countoffDone   = true;
    return null;
  }
  const beatIndex    = Math.floor(elapsed / BEAT_MS);
  const beatProgress = (elapsed % BEAT_MS) / BEAT_MS;
  return {
    beatNum:      Math.min(beatIndex + 1, COUNTOFF_BEATS + 1),
    beatIndex,
    beatProgress,
    elapsed,
  };
}

// Returns true exactly once per beat boundary during the count-off.
// Use to fire a metronome click on each beat. Safe to call every frame.
export function justCrossedBeat() {
  if (!_countoffActive) {
    _lastClickBeat = -1;
    return false;
  }
  const elapsed   = performance.now() - _countoffStart;
  // Scheduled-future start (remote sync) — no beats to fire yet.
  if (elapsed < 0) return false;
  const beatIndex = Math.floor(elapsed / BEAT_MS);
  if (beatIndex !== _lastClickBeat && beatIndex < COUNTOFF_BEATS) {
    _lastClickBeat = beatIndex;
    return true;
  }
  return false;
}


// ════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════

function clamp(v, lo, hi) {
  v = parseInt(v);
  if (isNaN(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}
