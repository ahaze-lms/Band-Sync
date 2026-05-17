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
