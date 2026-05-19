// ════════════════════════════════════════════════════════════════════
// BandSync — Song data model
// ════════════════════════════════════════════════════════════════════
// Minimal in-memory song shape used by the Studio. Phase 1 supports
// a single monophonic-or-polyphonic piano track; multi-track + drums
// come later.
//
// Note shape:
//   { pitch, startMs, durationMs, velocity }
//
// startMs is relative to song start (0 = beat 1 of bar 1). Notes are
// not assumed to be sorted — callers should sort if they need ordered
// playback. durationMs is always > 0.
// ════════════════════════════════════════════════════════════════════

export function createSong(bpm = 120) {
  return {
    bpm,
    // num = beats per bar, denom = which note value gets the beat.
    // Per DAW convention, BPM always means quarter-notes-per-minute
    // regardless of denom, so denom is mostly visual / metadata.
    timeSig: { num: 4, denom: 4 },
    notes: [],
  };
}

export function clearNotes(song) {
  song.notes.length = 0;
}

export function addNote(song, note) {
  song.notes.push(note);
}

// Remove a specific note (by identity, not by value). Returns true if
// the note was found and removed.
export function removeNote(song, note) {
  const idx = song.notes.indexOf(note);
  if (idx === -1) return false;
  song.notes.splice(idx, 1);
  return true;
}

// Total length in ms, derived from the last-ending note.
// Returns 0 for an empty song.
export function durationMs(song) {
  if (song.notes.length === 0) return 0;
  let max = 0;
  for (const n of song.notes) {
    const end = n.startMs + n.durationMs;
    if (end > max) max = end;
  }
  return max;
}
