// ════════════════════════════════════════════════════════════════════
// BandSync — Lobbies Service
// ════════════════════════════════════════════════════════════════════
// Remote-multiplayer lobby ops. See DESIGN.md §27.
//
//   create(songFile, songTitle, opts)  — RPC, returns lobby id
//   join(lobbyId)                       — RPC, returns assigned slot or null
//   leave(lobbyId)                      — DELETE own participant row
//   setReady(lobbyId, isReady)          — UPDATE own is_ready
//   setSlotConfig(lobbyId, fields)      — UPDATE own slot/instrument/track
//   kick(lobbyId, userId)               — DELETE other participant (host)
//   setStartAt(lobbyId, startAt)        — UPDATE lobby start_at (host, clock sync)
//   setState(lobbyId, state)            — UPDATE lobby state (host)
//   updateLobby(lobbyId, fields)        — generic UPDATE (host)
//   getLobby(lobbyId)                   — SELECT one lobby
//   listParticipants(lobbyId)           — SELECT + profile join
//
// All operations route through Supabase. RLS enforces who can do
// what; the service is a thin wrapper that returns parsed data or
// throws on error.
//
// Realtime subscription (per-lobby channel) is phase 4 — not in this
// file yet.
// ════════════════════════════════════════════════════════════════════

import { supabase } from './supabase.js';

// ── Lifecycle ────────────────────────────────────────────────────

// Atomically creates a lobby + inserts the caller as participant
// slot 1. Returns the new lobby's id.
export async function create(songFile, songTitle, { speedLevel = null, hitWindowLevel = null } = {}) {
  const { data, error } = await supabase.rpc('create_lobby', {
    p_song_file:        songFile,
    p_song_title:       songTitle,
    p_speed_level:      speedLevel,
    p_hit_window_level: hitWindowLevel,
  });
  if (error) throw error;
  return data;   // uuid string
}

// Joins an existing lobby. Returns the assigned slot (1-4) or null
// if the lobby is full / closed / nonexistent.
// Idempotent: re-joining returns the existing slot.
export async function join(lobbyId) {
  const { data, error } = await supabase.rpc('join_lobby', { p_lobby_id: lobbyId });
  if (error) throw error;
  return data;   // int or null
}

// Removes the caller from the lobby. Host's leave doesn't delete the
// lobby — call updateLobby(..., { state: 'abandoned' }) or delete it
// explicitly if needed.
export async function leave(lobbyId) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('not authenticated');
  const { error } = await supabase
    .from('lobby_participants')
    .delete()
    .eq('lobby_id', lobbyId)
    .eq('user_id', user.id);
  if (error) throw error;
}

// Host-only. Removes a participant from the lobby.
export async function kick(lobbyId, userId) {
  const { error } = await supabase
    .from('lobby_participants')
    .delete()
    .eq('lobby_id', lobbyId)
    .eq('user_id', userId);
  if (error) throw error;
}

// ── Participant updates ──────────────────────────────────────────

// Mark the caller ready / not-ready.
export async function setReady(lobbyId, isReady) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('not authenticated');
  const { error } = await supabase
    .from('lobby_participants')
    .update({ is_ready: !!isReady })
    .eq('lobby_id', lobbyId)
    .eq('user_id', user.id);
  if (error) throw error;
}

// Update the caller's own slot config (instrument / track_index).
// Slot reassignment by self is allowed by RLS but conflicts on the
// partial-unique-index — pass only fields you mean to change.
export async function setSlotConfig(lobbyId, fields) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('not authenticated');
  const allowed = {};
  if ('slot'        in fields) allowed.slot        = fields.slot;
  if ('instrument'  in fields) allowed.instrument  = fields.instrument;
  if ('track_index' in fields) allowed.track_index = fields.track_index;
  if (Object.keys(allowed).length === 0) return;
  const { error } = await supabase
    .from('lobby_participants')
    .update(allowed)
    .eq('lobby_id', lobbyId)
    .eq('user_id', user.id);
  if (error) throw error;
}

// ── Lobby updates (host-only via RLS) ────────────────────────────

// Host sets the wall-clock moment for synchronised count-off start.
// Phase 5 (clock sync) computes this from server time + slowest
// client's measured offset.
export async function setStartAt(lobbyId, startAt) {
  const iso = startAt instanceof Date ? startAt.toISOString() : startAt;
  const { error } = await supabase
    .from('lobbies')
    .update({ start_at: iso })
    .eq('id', lobbyId);
  if (error) throw error;
}

// State machine transition: waiting → ready → starting → playing → done.
// 'abandoned' is the bailout terminal state.
export async function setState(lobbyId, state) {
  const { error } = await supabase
    .from('lobbies')
    .update({ state })
    .eq('id', lobbyId);
  if (error) throw error;
}

// Generic update for combined host-side changes (e.g. set state +
// start_at + session_id in one go when starting the song).
export async function updateLobby(lobbyId, fields) {
  if (!fields || Object.keys(fields).length === 0) return;
  const { error } = await supabase
    .from('lobbies')
    .update(fields)
    .eq('id', lobbyId);
  if (error) throw error;
}

// ── Reads ────────────────────────────────────────────────────────

// Fetch one lobby. Returns the row or null if no access / not found.
export async function getLobby(lobbyId) {
  const { data, error } = await supabase
    .from('lobbies')
    .select('*')
    .eq('id', lobbyId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// List all participants of a lobby with profile snapshots joined in.
// Sorted by slot (nulls last). Useful for the lobby UI's roster
// view; the realtime channel (phase 4) keeps it in sync after the
// initial fetch.
export async function listParticipants(lobbyId) {
  const { data, error } = await supabase
    .from('lobby_participants')
    .select('lobby_id, user_id, slot, instrument, track_index, is_ready, joined_at')
    .eq('lobby_id', lobbyId)
    .order('slot', { ascending: true, nullsFirst: false });
  if (error) throw error;

  const userIds = [...new Set((data ?? []).map(r => r.user_id))];
  let profiles = {};
  if (userIds.length) {
    const { data: profs, error: pErr } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar, accent_color')
      .in('id', userIds);
    if (pErr) throw pErr;
    profiles = Object.fromEntries((profs ?? []).map(p => [p.id, p]));
  }

  return (data ?? []).map(r => ({ ...r, profile: profiles[r.user_id] ?? null }));
}

// ── Realtime ─────────────────────────────────────────────────────

// Subscribe to a single lobby's live changes. Returns an unsubscribe
// function — call it on unmount / leave to release the channel.
//
//   onLobbyChange      (payload)  — INSERT/UPDATE/DELETE on the lobby row
//   onParticipantChange(payload)  — INSERT/UPDATE/DELETE on lobby_participants
//
// Callbacks get the raw postgres_changes payload — usually you'll
// just call your existing "re-fetch state" function and ignore the
// payload contents.
export function subscribeLobby(lobbyId, { onLobbyChange, onParticipantChange } = {}) {
  const channel = supabase.channel(`lobby:${lobbyId}`)
    .on('postgres_changes',
        { event: '*', schema: 'public', table: 'lobbies', filter: `id=eq.${lobbyId}` },
        payload => onLobbyChange?.(payload))
    .on('postgres_changes',
        { event: '*', schema: 'public', table: 'lobby_participants', filter: `lobby_id=eq.${lobbyId}` },
        payload => onParticipantChange?.(payload))
    .subscribe();

  return () => { supabase.removeChannel(channel); };
}
