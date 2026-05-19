// ════════════════════════════════════════════════════════════════════
// BandSync — Play Sessions Service
// ════════════════════════════════════════════════════════════════════
// Persists a completed song to play_sessions + play_session_slots.
// The host (currently-authed user) is the writer for both tables;
// RLS allows them to insert slot rows for any user_id — including a
// claimed friend's — provided the parent session row is theirs. See
// DESIGN.md §26.
// ════════════════════════════════════════════════════════════════════

import { supabase } from './supabase.js';

// session: {
//   hostUserId:      uuid,
//   song:            { file, title },
//   speedLevel:      int,
//   hitWindowLevel:  int,
//   startedAt:       ISO 8601 string,
//   endedAt:         ISO 8601 string,
//   slots: [{
//     slot:        1..4,
//     identity:    'host' | 'friend' | 'guest',
//     userId:      uuid | null,
//     displayName: string,
//     instrument:  'piano' | 'drums',
//     trackIndex:  int,
//     trackName:   string,
//     score:       int,
//     accuracy:    int | null,
//     grade:       string | null,
//     perfect, good, miss, wrong, maxCombo: ints,
//   }],
// }
//
// Returns the inserted session row's id on success. Throws on error.
export async function saveSession(session) {
  if (!session?.hostUserId)        throw new Error('saveSession: hostUserId required');
  if (!session?.song?.file)        throw new Error('saveSession: song.file required');
  if (!Array.isArray(session.slots) || session.slots.length === 0) {
    throw new Error('saveSession: at least one slot required');
  }

  // 1. Parent session row.
  const { data: sess, error: sessErr } = await supabase
    .from('play_sessions')
    .insert({
      host_user_id:     session.hostUserId,
      song_file:        session.song.file,
      song_title:       session.song.title,
      started_at:       session.startedAt,
      ended_at:         session.endedAt,
      speed_level:      session.speedLevel,
      hit_window_level: session.hitWindowLevel,
      player_count:     session.slots.length,
    })
    .select('id')
    .single();
  if (sessErr) throw sessErr;

  // 2. All slot rows in one batch.
  const slotRows = session.slots.map(s => ({
    session_id:   sess.id,
    slot:         s.slot,
    identity:     s.identity,
    user_id:      s.userId,
    display_name: s.displayName,
    instrument:   s.instrument,
    track_index:  s.trackIndex,
    track_name:   s.trackName,
    score:        s.score        ?? 0,
    accuracy:     s.accuracy     ?? null,
    grade:        s.grade        ?? null,
    perfect:      s.perfect      ?? 0,
    good:         s.good         ?? 0,
    miss:         s.miss         ?? 0,
    wrong:        s.wrong        ?? 0,
    max_combo:    s.maxCombo     ?? 0,
  }));

  const { error: slotsErr } = await supabase
    .from('play_session_slots')
    .insert(slotRows);
  if (slotsErr) {
    // Partial state: session row exists, no slots. Surface so the
    // caller can decide whether to retry. (Cleanup would orphan rows
    // — leaving the empty session is the safer default.)
    throw new Error(`Session saved but slot rows failed: ${slotsErr.message}`);
  }

  return sess.id;
}

// ── Remote multiplayer helpers (Phase 7) ─────────────────────────
//
// Remote games use a split write: the lobby host creates the parent
// session row and stamps session_id on the lobby. Each non-host
// participant polls for that stamp, then inserts their own slot via
// the pss_insert_self_in_session RLS policy.

// Create just the play_sessions header row (no slots). Returns the
// new session's id. Called by the lobby host at end-of-song.
export async function createSessionHeader({ hostUserId, song, speedLevel, hitWindowLevel, startedAt, endedAt, playerCount }) {
  const { data: sess, error } = await supabase
    .from('play_sessions')
    .insert({
      host_user_id:     hostUserId,
      song_file:        song.file,
      song_title:       song.title,
      started_at:       startedAt,
      ended_at:         endedAt,
      speed_level:      speedLevel,
      hit_window_level: hitWindowLevel,
      player_count:     playerCount,
    })
    .select('id')
    .single();
  if (error) throw error;
  return sess.id;
}

// Insert one slot row. Works for the host (pss_insert_host) and for
// remote participants (pss_insert_self_in_session — requires
// user_in_lobby_session() to return true for this session_id).
export async function saveSlot(sessionId, slot) {
  const { error } = await supabase
    .from('play_session_slots')
    .insert({
      session_id:   sessionId,
      slot:         slot.slot,
      identity:     slot.identity,
      user_id:      slot.userId,
      display_name: slot.displayName,
      instrument:   slot.instrument,
      track_index:  slot.trackIndex,
      track_name:   slot.trackName,
      score:        slot.score     ?? 0,
      accuracy:     slot.accuracy  ?? null,
      grade:        slot.grade     ?? null,
      perfect:      slot.perfect   ?? 0,
      good:         slot.good      ?? 0,
      miss:         slot.miss      ?? 0,
      wrong:        slot.wrong     ?? 0,
      max_combo:    slot.maxCombo  ?? 0,
    });
  if (error) throw error;
}
