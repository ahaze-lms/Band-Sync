-- ═══════════════════════════════════════════════════════════════════
-- BandSync — Migration 0002: Fix play_sessions ↔ play_session_slots
--                            RLS recursion
-- ═══════════════════════════════════════════════════════════════════
-- The 0001 migration's policies cross-reference each other:
--   play_sessions's "participant SELECT" checks play_session_slots,
--   and play_session_slots's "host SELECT/INSERT/UPDATE" checks
--   play_sessions. When PostgREST runs `INSERT ... .select('id')`,
--   Postgres evaluates both sides and loops, throwing:
--     "infinite recursion detected in policy for relation play_sessions"
--
-- Fix: pull the cross-table existence checks into SECURITY DEFINER
-- functions. They still respect `auth.uid()` so the privilege scope
-- is unchanged, but they bypass RLS internally — no recursion.
--
-- HOW TO RUN:
--   Supabase dashboard → SQL editor → paste this file → Run.
-- ═══════════════════════════════════════════════════════════════════


-- ── Helper functions ──────────────────────────────────────────────

-- "Does the current user appear in a slot of this session?" — used by
-- play_sessions's participant SELECT policy.
create or replace function public.user_in_session(p_session_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.play_session_slots
    where session_id = p_session_id
      and user_id    = auth.uid()
  );
$$;

-- "Does the current user host this session?" — used by all three
-- play_session_slots policies (INSERT / UPDATE / SELECT-host).
create or replace function public.user_hosts_session(p_session_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.play_sessions
    where id           = p_session_id
      and host_user_id = auth.uid()
  );
$$;

grant execute on function public.user_in_session(uuid)    to authenticated;
grant execute on function public.user_hosts_session(uuid) to authenticated;


-- ── Re-create the affected policies ───────────────────────────────

drop policy if exists "ps_select_participant" on public.play_sessions;
create policy "ps_select_participant" on public.play_sessions
  for select using (public.user_in_session(id));

drop policy if exists "pss_select_host" on public.play_session_slots;
create policy "pss_select_host" on public.play_session_slots
  for select using (public.user_hosts_session(session_id));

drop policy if exists "pss_insert_host" on public.play_session_slots;
create policy "pss_insert_host" on public.play_session_slots
  for insert with check (public.user_hosts_session(session_id));

drop policy if exists "pss_update_host" on public.play_session_slots;
create policy "pss_update_host" on public.play_session_slots
  for update using (public.user_hosts_session(session_id));


-- ═══════════════════════════════════════════════════════════════════
-- Verify: play a song in the live site; the results card should show
-- "✓ SAVED TO HISTORY" instead of the recursion error.
-- ═══════════════════════════════════════════════════════════════════
