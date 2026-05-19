// ════════════════════════════════════════════════════════════════════
// BandSync — Song data model
// ════════════════════════════════════════════════════════════════════
// Multi-track song shape used by the Studio.
//
// {
//   bpm:           number,
//   timeSig:       { num, denom },
//   tracks:        [Track, ...],            // 1..4
//   activeTrackId: string                   // which track receives
//                                           // recording / new edits
//   notes (getter): the active track's notes array — backward-
//                   compatible alias used by recorder / arrow nudge /
//                   ADD callbacks. Iterating ALL notes across tracks
//                   goes through `song.tracks` directly.
// }
//
// Track shape:
// {
//   id, name, role, color, notes: [...], muted, solo, activeGrid
// }
//
// Note shape:
//   { pitch, startMs, startMsRaw, durationMs, velocity }
//
// startMs is relative to song start (0 = beat 1 of bar 1). Notes are
// not assumed to be sorted — callers should sort if they need ordered
// playback. durationMs is always > 0. startMsRaw is the original
// recorded timestamp preserved across quantization (see quantizer.js).
// ════════════════════════════════════════════════════════════════════

// Predefined per-track color palette. Tracks created via addTrack get
// the next color in the sequence (wrapping at 4).
export const TRACK_COLORS = ['#7F77DD', '#1D9E75', '#E0A040', '#E0533C'];
export const MAX_TRACKS = 4;

let _nextTrackId = 1;
function makeTrack(name, colorIdx = 0) {
  return {
    id:         `t${_nextTrackId++}`,
    name,
    role:       'piano',
    color:      TRACK_COLORS[colorIdx % TRACK_COLORS.length],
    notes:      [],
    muted:      false,
    solo:       false,
    activeGrid: 'raw',     // per-track quantize state
  };
}

export function createSong(bpm = 120) {
  const firstTrack = makeTrack('Track 1', 0);
  return {
    bpm,
    timeSig: { num: 4, denom: 4 },
    tracks: [firstTrack],
    activeTrackId: firstTrack.id,
    // Backward-compatible alias for the active track's notes. Lets the
    // recorder, arrow nudge, and ADD callbacks keep using `song.notes`
    // without knowing about tracks. Reads go through whatever track is
    // currently active. Assignment is intentionally not supported —
    // callers should mutate the returned array.
    get notes() { return getActiveTrack(this).notes; },
  };
}

// ── Track operations ──────────────────────────────────────────────
export function getActiveTrack(song) {
  return song.tracks.find(t => t.id === song.activeTrackId) || song.tracks[0];
}

export function setActiveTrack(song, trackId) {
  if (song.tracks.some(t => t.id === trackId)) {
    song.activeTrackId = trackId;
  }
}

// Append a new track. Returns the new track (or null when at MAX).
export function addTrack(song, name) {
  if (song.tracks.length >= MAX_TRACKS) return null;
  const track = makeTrack(name || `Track ${song.tracks.length + 1}`, song.tracks.length);
  song.tracks.push(track);
  return track;
}

// Remove a track by id. Refuses to remove the last track. Returns true
// on success.
export function removeTrack(song, trackId) {
  if (song.tracks.length <= 1) return false;
  const idx = song.tracks.findIndex(t => t.id === trackId);
  if (idx === -1) return false;
  song.tracks.splice(idx, 1);
  if (song.activeTrackId === trackId) {
    song.activeTrackId = song.tracks[Math.max(0, idx - 1)].id;
  }
  return true;
}


// ── Note operations ──────────────────────────────────────────────
// All of these target the ACTIVE track unless otherwise noted.
export function clearNotes(song) {
  getActiveTrack(song).notes.length = 0;
}

export function addNote(song, note) {
  getActiveTrack(song).notes.push(note);
}

// Remove a specific note (by identity). Searches all tracks since a
// selected note might belong to any of them. Returns true if found.
export function removeNote(song, note) {
  for (const track of song.tracks) {
    const idx = track.notes.indexOf(note);
    if (idx !== -1) {
      track.notes.splice(idx, 1);
      return true;
    }
  }
  return false;
}


// ── Song-wide queries ────────────────────────────────────────────
// Total length in ms across ALL tracks. Returns 0 for an empty song.
export function durationMs(song) {
  let max = 0;
  for (const track of song.tracks) {
    for (const n of track.notes) {
      const end = n.startMs + n.durationMs;
      if (end > max) max = end;
    }
  }
  return max;
}

// True if any track has at least one note.
export function songHasNotes(song) {
  for (const track of song.tracks) {
    if (track.notes.length > 0) return true;
  }
  return false;
}

// Total note count across all tracks.
export function totalNoteCount(song) {
  let n = 0;
  for (const track of song.tracks) n += track.notes.length;
  return n;
}
