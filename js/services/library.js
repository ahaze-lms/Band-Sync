// ════════════════════════════════════════════════════════════════════
// BandSync — Library service (Studio Phase 4)
// ════════════════════════════════════════════════════════════════════
// Supabase CRUD for the `songs` table. All operations are gated by
// Phase 4 RLS (owner_id = auth.uid()), so each function requires the
// caller to be signed in. Errors surface so the UI can decide how to
// present them.
//
// Data shape stored in `songs.data` (future-compatible with Phase 5
// multi-track — even though Phase 4 only writes a single track):
//
//   {
//     tracks: [
//       { name: 'Piano', role: 'piano', color: '#7F77DD', notes: [...] }
//     ]
//   }
//
// Helpers `packSong` / `unpackSong` convert between the flat in-memory
// `{ bpm, notes }` Studio uses today and that tracks structure.
// ════════════════════════════════════════════════════════════════════

import { supabase } from './supabase.js';

const PRIMARY_TRACK_COLOR = '#7F77DD';


// ── Listing ───────────────────────────────────────────────────────
// Lightweight list of the caller's saved songs, sorted by most recent
// edit. Used to populate the SONGS modal. Does NOT include the heavy
// `data` blob — callers fetch that on demand via getSong(id).
export async function listSongs() {
  const { data, error } = await supabase
    .from('songs')
    .select('id, name, bpm, visibility, created_at, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}


// ── Fetch one (full row, including data) ──────────────────────────
export async function getSong(id) {
  const { data, error } = await supabase
    .from('songs')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}


// ── Create ────────────────────────────────────────────────────────
// `song` is the in-memory Studio song shape ({ bpm, notes }). The
// `name` argument is separate because the in-memory song has no title.
export async function createSong({ ownerId, name, song, visibility = 'private' }) {
  const row = {
    owner_id:   ownerId,
    name:       name || 'Untitled',
    bpm:        song.bpm,
    visibility,
    data:       packSong(song),
  };
  const { data, error } = await supabase
    .from('songs')
    .insert(row)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}


// ── Update ────────────────────────────────────────────────────────
// Pass only the fields you want to change. updated_at bumps via the
// songs_set_updated_at trigger — no need to set it client-side.
export async function updateSong(id, { name, song, visibility } = {}) {
  const patch = {};
  if (name !== undefined)       patch.name       = name;
  if (visibility !== undefined) patch.visibility = visibility;
  if (song !== undefined) {
    patch.bpm  = song.bpm;
    patch.data = packSong(song);
  }
  const { data, error } = await supabase
    .from('songs')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}


// ── Delete ────────────────────────────────────────────────────────
export async function deleteSong(id) {
  const { error } = await supabase
    .from('songs')
    .delete()
    .eq('id', id);
  if (error) throw error;
}


// ════════════════════════════════════════════════════════════════════
// SHAPE HELPERS
// ════════════════════════════════════════════════════════════════════

// Wrap the flat in-memory song into the future-compatible track shape.
// Phase 4 always emits exactly one track named "Piano". Phase 5 will
// expand to 4 tracks with different roles per track.
export function packSong(song) {
  return {
    tracks: [
      {
        name:  'Piano',
        role:  'piano',
        color: PRIMARY_TRACK_COLOR,
        notes: song.notes.map(n => ({
          pitch:      n.pitch,
          startMs:    n.startMs,
          startMsRaw: n.startMsRaw ?? n.startMs,
          durationMs: n.durationMs,
          velocity:   n.velocity,
        })),
      },
    ],
  };
}

// Read the first track's notes out of a packed row. Multi-track rows
// (Phase 5+) still open correctly — Studio just sees track 1 for now,
// and Phase 5's UI will switch between tracks once it lands.
export function unpackSong(row) {
  const tracks = row?.data?.tracks ?? [];
  const first  = tracks[0];
  const notes  = first?.notes ?? [];
  return {
    bpm:   row.bpm,
    notes: notes.map(n => ({
      pitch:      n.pitch,
      startMs:    n.startMs,
      startMsRaw: n.startMsRaw ?? n.startMs,
      durationMs: n.durationMs,
      velocity:   n.velocity,
    })),
  };
}
