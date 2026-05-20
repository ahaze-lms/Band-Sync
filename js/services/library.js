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
// Lists the caller's saved songs, sorted by most recent edit. Phase 6
// includes the `data` blob so play.html can render full song cards
// (track names, duration) without an extra getSong() per row.
export async function listSongs() {
  const { data, error } = await supabase
    .from('songs')
    .select('id, name, bpm, visibility, created_at, updated_at, data')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// Pulls the playable-summary fields out of a song row. Used by
// play.html's song-select to render a Studio song card with the same
// shape as a bundled .mid card. Returns
//   { id, title, bpm, durationSec, trackNames, trackCount }
// — a strict superset of what songCard() reads.
export function summarizeSong(row) {
  const tracks = row?.data?.tracks ?? [];
  let maxEndMs = 0;
  for (const t of tracks) {
    for (const n of (t.notes ?? [])) {
      const end = n.startMs + n.durationMs;
      if (end > maxEndMs) maxEndMs = end;
    }
  }
  return {
    id:          row.id,
    title:       row.name,
    bpm:         row.bpm,
    durationSec: maxEndMs / 1000,
    trackNames:  tracks.map(t => t.name),
    trackCount:  tracks.length,
  };
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

// Serialize the in-memory multi-track song into the Supabase data
// blob. Per-track metadata (name, role, color, mute/solo, activeGrid)
// rides along so reopening restores the exact editing state.
export function packSong(song) {
  return {
    timeSig: song.timeSig
      ? { num: song.timeSig.num, denom: song.timeSig.denom }
      : { num: 4, denom: 4 },
    activeTrackId: song.activeTrackId,
    tracks: song.tracks.map(t => ({
      id:         t.id,
      name:       t.name,
      role:       t.role,
      color:      t.color,
      muted:      !!t.muted,
      solo:       !!t.solo,
      activeGrid: t.activeGrid ?? 'raw',
      notes: t.notes.map(n => ({
        pitch:      n.pitch,
        startMs:    n.startMs,
        startMsRaw: n.startMsRaw ?? n.startMs,
        durationMs: n.durationMs,
        velocity:   n.velocity,
      })),
    })),
  };
}

// Read a packed row back into the in-memory shape that studio.html
// consumes. Multi-track aware. Legacy single-track rows (saved before
// Phase 5) come back as a 1-track song. Missing per-track metadata is
// backfilled with sensible defaults.
export function unpackSong(row) {
  const ts          = row?.data?.timeSig;
  const savedTracks = row?.data?.tracks ?? [];
  const tracks = savedTracks.length > 0
    ? savedTracks.map((t, i) => ({
        id:         t.id ?? `t-load-${i + 1}`,
        name:       t.name  ?? `Track ${i + 1}`,
        role:       t.role  ?? 'piano',
        color:      t.color ?? PRIMARY_TRACK_COLOR,
        muted:      !!t.muted,
        solo:       !!t.solo,
        activeGrid: t.activeGrid ?? 'raw',
        notes: (t.notes ?? []).map(n => ({
          pitch:      n.pitch,
          startMs:    n.startMs,
          startMsRaw: n.startMsRaw ?? n.startMs,
          durationMs: n.durationMs,
          velocity:   n.velocity,
        })),
      }))
    : [{
        id:         't-load-1',
        name:       'Track 1',
        role:       'piano',
        color:      PRIMARY_TRACK_COLOR,
        muted:      false,
        solo:       false,
        activeGrid: 'raw',
        notes:      [],
      }];
  return {
    bpm:           row.bpm,
    timeSig:       { num: ts?.num ?? 4, denom: ts?.denom ?? 4 },
    activeTrackId: row?.data?.activeTrackId ?? tracks[0].id,
    tracks,
  };
}
