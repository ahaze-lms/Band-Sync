// ════════════════════════════════════════════════════════════════════
// BandSync — Undo / Redo history (Studio)
// ════════════════════════════════════════════════════════════════════
// Single-track snapshot stack with a small max size. The "state" we
// snapshot is the document data: bpm + timeSig + notes. Selection,
// playhead position, quantize-button highlight, and other UI bits
// are deliberately excluded — undo restores the song you'd save to
// disk, not the cursor you happened to have on screen.
//
// API:
//   const h = createHistory(maxSize = 50);
//   h.push(state)     — record a new state after a mutation. Clears
//                       any redo entries past the cursor.
//   h.undo()          — returns the previous state, or null if at the
//                       beginning of history.
//   h.redo()          — returns the next state, or null if at the end.
//   h.canUndo() / .canRedo()
//   h.clear()         — wipe the stack (e.g. on song-load).
//   h.size()
//
// Helpers (song-specific):
//   snapshotSong(song)            — deep copy of the document data
//   restoreSong(song, snapshot)   — write a snapshot back into the
//                                   live song object, in-place so
//                                   external references survive
// ════════════════════════════════════════════════════════════════════

export function createHistory(maxSize = 50) {
  let stack = [];
  let cursor = -1;   // points at current state; -1 when empty

  function push(state) {
    // Any redo entries past the cursor are now stale — forking the
    // timeline drops them.
    stack = stack.slice(0, cursor + 1);
    stack.push(state);
    if (stack.length > maxSize) stack.shift();
    else cursor++;
  }

  function undo() {
    if (cursor <= 0) return null;
    cursor--;
    return stack[cursor];
  }

  function redo() {
    if (cursor >= stack.length - 1) return null;
    cursor++;
    return stack[cursor];
  }

  function canUndo() { return cursor > 0; }
  function canRedo() { return cursor < stack.length - 1; }
  function clear()   { stack = []; cursor = -1; }
  function size()    { return stack.length; }

  return { push, undo, redo, canUndo, canRedo, clear, size };
}


// ── Song snapshot helpers ──────────────────────────────────────────
// Deep-clone the document-level state. Notes are simple bags of
// primitives so a per-note spread is enough; nothing here references
// the rest of the runtime (renderer / recorder / UI).
export function snapshotSong(song) {
  return {
    bpm: song.bpm,
    timeSig: { num: song.timeSig.num, denom: song.timeSig.denom },
    notes: song.notes.map(n => ({
      pitch:      n.pitch,
      startMs:    n.startMs,
      startMsRaw: n.startMsRaw,
      durationMs: n.durationMs,
      velocity:   n.velocity,
    })),
  };
}

// Write a snapshot back into `song` in place — mutates the existing
// object so anything holding a reference (renderer, recorder, etc.)
// keeps working without re-wiring.
export function restoreSong(song, snap) {
  song.bpm = snap.bpm;
  song.timeSig = { num: snap.timeSig.num, denom: snap.timeSig.denom };
  song.notes.length = 0;
  for (const n of snap.notes) song.notes.push({ ...n });
}
