// ════════════════════════════════════════════════════════════════════
// BandSync — History Service
// ════════════════════════════════════════════════════════════════════
// Reads from play_sessions + play_session_slots for the current user's
// history screen. RLS does the heavy lifting:
//   • Sessions I host         → all slots come back
//   • Sessions I was a friend → only my own slot comes back
//   • Sessions involving none of my user_id     → not returned at all
//
// See DESIGN.md §26 for the full data model.
// ════════════════════════════════════════════════════════════════════

import { supabase } from './supabase.js';

// All sessions visible to the current user, newest first. Each row carries
// its own slots array (the shape varies per RLS as noted above).
export async function getMyHistory() {
  const { data, error } = await supabase
    .from('play_sessions')
    .select(`
      id,
      host_user_id,
      song_file,
      song_title,
      started_at,
      ended_at,
      player_count,
      slots:play_session_slots ( * )
    `)
    .order('started_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// Personal best per song, keyed by song_file. Derived live from my slot
// rows — no materialized table. Returns:
//   { [song_file]: { song_file, song_title, score, accuracy, grade, played_at, session_id } }
export async function getMyPersonalBests(userId) {
  const { data, error } = await supabase
    .from('play_session_slots')
    .select(`
      session_id,
      score, accuracy, grade,
      sessions:play_sessions!inner ( song_file, song_title, started_at )
    `)
    .eq('user_id', userId);
  if (error) throw error;

  const bests = {};
  for (const row of data ?? []) {
    const file = row.sessions.song_file;
    const prev = bests[file];
    if (!prev || row.score > prev.score) {
      bests[file] = {
        song_file:  file,
        song_title: row.sessions.song_title,
        score:      row.score,
        accuracy:   row.accuracy,
        grade:      row.grade,
        played_at:  row.sessions.started_at,
        session_id: row.session_id,
      };
    }
  }
  return bests;
}
