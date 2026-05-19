// ════════════════════════════════════════════════════════════════════
// BandSync — Studio recorder
// ════════════════════════════════════════════════════════════════════
// Captures live noteOn/noteOff events into a song. Timestamps are
// relative to record start (performance.now() at start() call).
//
// Pending noteOn events are kept in a map keyed by pitch so the
// matching noteOff can compute durationMs. If stop() is called while
// notes are still held, those held notes get a duration ending at the
// stop instant.
//
// Source-agnostic: the caller decides whether events come from MIDI,
// QWERTY, or touch — recorder.noteOn(pitch, velocity) is the same.
// That's the affordance we'll lean on when phase 1.5 wires up the
// on-screen touch keyboard for mobile.
// ════════════════════════════════════════════════════════════════════

const MIN_DURATION_MS = 30;

export function createRecorder(song) {
  let startedAt = 0;          // performance.now() when start() was called
  let recording = false;
  const pending = new Map();  // pitch → { startMs, velocity }

  // Start a recording take. `offsetMs` is the song-time the recording
  // begins at — 0 means "fresh take from the top", any positive value
  // is a "punch-in" that preserves notes before the offset and replaces
  // notes from the offset onward (standard DAW punch-in behavior).
  //
  // Pre-rolling startedAt so elapsedMs() returns SONG-TIME (not real
  // time-since-press) means downstream consumers — noteOn timestamps,
  // the UI timer, overdub playback — all get aligned numbers without
  // doing offset math themselves.
  function start(offsetMs = 0) {
    startedAt = performance.now() - offsetMs;
    recording = true;
    pending.clear();
    if (offsetMs === 0) {
      song.notes.length = 0;   // fresh take overwrites the whole track
    } else {
      // Punch-in: drop the existing notes from the offset onward.
      // Earlier notes survive (the part of the song the user is keeping).
      const notes = song.notes;
      for (let i = notes.length - 1; i >= 0; i--) {
        if (notes[i].startMs >= offsetMs) notes.splice(i, 1);
      }
    }
  }

  function noteOn(pitch, velocity) {
    if (!recording) return;
    // Same pitch already held? Close the old note first — pianos can
    // re-trigger a held key (sustain pedal patterns) but we want clean
    // contiguous notes, not overlapping copies.
    if (pending.has(pitch)) closePending(pitch);
    pending.set(pitch, {
      startMs:  performance.now() - startedAt,
      velocity,
    });
  }

  function noteOff(pitch) {
    if (!recording) return;
    if (!pending.has(pitch)) return;
    closePending(pitch);
  }

  function closePending(pitch) {
    const open = pending.get(pitch);
    const endMs = performance.now() - startedAt;
    const duration = Math.max(MIN_DURATION_MS, endMs - open.startMs);
    // startMsRaw mirrors startMs at record time. The quantizer modifies
    // startMs but never touches startMsRaw, so we can re-quantize at any
    // grid (or revert to raw) without losing the original take.
    song.notes.push({
      pitch,
      startMs:    open.startMs,
      startMsRaw: open.startMs,
      durationMs: duration,
      velocity:   open.velocity,
    });
    pending.delete(pitch);
  }

  function stop() {
    if (!recording) return;
    for (const pitch of [...pending.keys()]) closePending(pitch);
    recording = false;
  }

  function isRecording() { return recording; }

  function elapsedMs() {
    if (!recording) return 0;
    return performance.now() - startedAt;
  }

  return { start, stop, noteOn, noteOff, isRecording, elapsedMs };
}
