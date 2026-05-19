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

  function start() {
    startedAt = performance.now();
    recording = true;
    pending.clear();
    song.notes.length = 0;    // fresh take overwrites previous recording
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
