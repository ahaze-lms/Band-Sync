-- ═══════════════════════════════════════════════════════════════════
-- BandSync — Migration 0006: Remote multiplayer RLS + server-time RPC
-- ═══════════════════════════════════════════════════════════════════
-- DESIGN.md §27 phases 5 + 8.
--
--   get_server_time()             — returns now() for clock-offset measurement
--   user_in_lobby_session(uuid)   — SECURITY DEFINER helper used by the
--                                   two new play_session_slots policies below
--   pss_insert_self_in_session    — remote player writes their own slot row
--   pss_select_in_lobby_session   — remote players see all slots (results screen)
--
-- Phase 5 (clock sync) reads get_server_time() via supabase.rpc() to
-- measure each client's clock offset before the synchronised start.
--
-- Phase 8 (remote slot writes): local couch coop → host writes all
-- slots (pss_insert_host). Remote → each player writes only their own
-- slot, gated on being a participant in the lobby that owns the session.
--
-- HOW TO RUN: Supabase dashboard → SQL editor → paste → Run.
-- ═══════════════════════════════════════════════════════════════════


-- ── Server-time RPC ──────────────────────────────────────────────────
-- Called N times by each client before the host fires "starting".
-- Client measures round-trip, computes localEpoch - serverEpoch offset.

create or replace function public.get_server_time()
returns timestamptz
language sql security definer
set search_path = public
as $$
  select now();
$$;

grant execute on function public.get_server_time() to authenticated;


-- ── Phase 8 RLS helper ───────────────────────────────────────────────
-- "Is auth.uid() a participant in a lobby that owns this session?"
-- Queries lobbies + lobby_participants directly (SECURITY DEFINER
-- bypasses their RLS, preventing cross-table recursion).

create or replace function public.user_in_lobby_session(p_session_id uuid)
returns boolean
language sql security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.lobbies l
    join public.lobby_participants lp on lp.lobby_id = l.id
    where l.session_id = p_session_id
      and lp.user_id   = auth.uid()
  );
$$;

grant execute on function public.user_in_lobby_session(uuid) to authenticated;


-- ── Phase 8 play_session_slots policies ──────────────────────────────
--
-- Existing policies (from migration 0001 / 0002):
--   pss_insert_host   — host inserts all slots (local couch coop)
--   pss_select_host   — host sees all slots
--   pss_select_own    — each user sees their own slots
--   pss_update_host   — host can update any slot
--
-- New policies for remote:
--   pss_insert_self_in_session — remote player inserts their OWN slot
--   pss_select_in_lobby_session — remote players see all slots in
--                                  their shared session (results screen)

create policy "pss_insert_self_in_session" on public.play_session_slots
  for insert with check (
    auth.uid() = user_id
    and public.user_in_lobby_session(session_id)
  );

create policy "pss_select_in_lobby_session" on public.play_session_slots
  for select using (public.user_in_lobby_session(session_id));


-- ═══════════════════════════════════════════════════════════════════
-- Verify:
--   select public.get_server_time();                   -- current timestamp
--   select public.user_in_lobby_session(gen_random_uuid());  -- false
-- ═══════════════════════════════════════════════════════════════════
