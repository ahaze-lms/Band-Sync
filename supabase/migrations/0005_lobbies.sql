-- ═══════════════════════════════════════════════════════════════════
-- BandSync — Migration 0005: Remote multiplayer lobbies (phase 1)
-- ═══════════════════════════════════════════════════════════════════
-- DESIGN.md §27 phase 1. Just the schema, RLS, helpers, and the two
-- core RPCs. Realtime wiring + UI + clock sync come in later phases.
--
--   lobbies                — one row per pending/active remote game
--   lobby_participants     — who's joined, what slot, ready state
--   user_in_lobby(id)      — SECURITY DEFINER helper for RLS recursion
--   user_hosts_lobby(id)   — same pattern, host check
--   create_lobby(...)      — RPC: makes the lobby + adds host as slot 1
--   join_lobby(p_lobby_id) — RPC: claims lowest free slot 1-4
--
-- Both tables are added to supabase_realtime so subscribers get push
-- updates on participant join/leave + state transitions.
--
-- The RLS-recursion helper pattern mirrors migration 0002 — direct
-- cross-table EXISTS in policies triggers "infinite recursion
-- detected" in Postgres, SECURITY DEFINER functions bypass it.
--
-- HOW TO RUN: Supabase dashboard → SQL editor → paste → Run.
-- ═══════════════════════════════════════════════════════════════════


-- ── LOBBIES ──────────────────────────────────────────────────────
create table public.lobbies (
  id                uuid primary key default gen_random_uuid(),
  host_user_id      uuid references auth.users on delete cascade not null,
  song_file         text not null,
  song_title        text not null,
  state             text not null
                      check (state in ('waiting','ready','starting','playing','done','abandoned'))
                      default 'waiting',
  speed_level       int,
  hit_window_level  int,
  start_at          timestamptz,                        -- server time when count-off fires
  session_id        uuid references public.play_sessions on delete set null,
  created_at        timestamptz default now(),
  expires_at        timestamptz default (now() + interval '2 hours')
);

create index lobbies_host_idx    on public.lobbies (host_user_id, created_at desc);
create index lobbies_state_idx   on public.lobbies (state) where state in ('waiting','ready','starting','playing');
create index lobbies_expires_idx on public.lobbies (expires_at);


-- ── LOBBY PARTICIPANTS ───────────────────────────────────────────
create table public.lobby_participants (
  lobby_id     uuid references public.lobbies on delete cascade not null,
  user_id      uuid references auth.users on delete cascade not null,
  slot         int check (slot between 1 and 4),
  instrument   text,
  track_index  int,
  is_ready     boolean default false,
  joined_at    timestamptz default now(),
  primary key (lobby_id, user_id)
);

create index lobby_participants_user_idx on public.lobby_participants (user_id);
-- Enforce at most one participant per slot within a lobby. NULL slots
-- are allowed (future spectator mode) so use a partial unique index.
create unique index lobby_participants_slot_unique
  on public.lobby_participants (lobby_id, slot)
  where slot is not null;


-- ── RLS recursion-breaking helpers ───────────────────────────────
create or replace function public.user_in_lobby(p_lobby_id uuid)
returns boolean
language sql security definer
set search_path = public
as $$
  select exists (
    select 1 from public.lobby_participants
    where lobby_id = p_lobby_id and user_id = auth.uid()
  );
$$;

create or replace function public.user_hosts_lobby(p_lobby_id uuid)
returns boolean
language sql security definer
set search_path = public
as $$
  select exists (
    select 1 from public.lobbies
    where id = p_lobby_id and host_user_id = auth.uid()
  );
$$;

grant execute on function public.user_in_lobby(uuid)    to authenticated;
grant execute on function public.user_hosts_lobby(uuid) to authenticated;


-- ── RLS — lobbies ────────────────────────────────────────────────
alter table public.lobbies enable row level security;

create policy "lobbies_insert_host" on public.lobbies
  for insert with check (auth.uid() = host_user_id);

-- Host sees their own lobby; participants see lobbies they've joined.
create policy "lobbies_select_host" on public.lobbies
  for select using (auth.uid() = host_user_id);

create policy "lobbies_select_participant" on public.lobbies
  for select using (public.user_in_lobby(id));

create policy "lobbies_update_host" on public.lobbies
  for update using (auth.uid() = host_user_id);

create policy "lobbies_delete_host" on public.lobbies
  for delete using (auth.uid() = host_user_id);


-- ── RLS — lobby_participants ─────────────────────────────────────
alter table public.lobby_participants enable row level security;

-- Self-join (e.g. via join_lobby RPC's grants), or host adds someone.
create policy "lp_insert_self" on public.lobby_participants
  for insert with check (auth.uid() = user_id);

create policy "lp_insert_host" on public.lobby_participants
  for insert with check (public.user_hosts_lobby(lobby_id));

-- Anyone in the lobby (including the host as slot-1 participant) sees
-- every other participant. Pre-join hosts also see participants
-- through the host check.
create policy "lp_select_participant" on public.lobby_participants
  for select using (public.user_in_lobby(lobby_id));

create policy "lp_select_host" on public.lobby_participants
  for select using (public.user_hosts_lobby(lobby_id));

-- Self-update for is_ready / instrument / track_index. Host can
-- reassign slots or change anyone's row.
create policy "lp_update_self" on public.lobby_participants
  for update using (auth.uid() = user_id);

create policy "lp_update_host" on public.lobby_participants
  for update using (public.user_hosts_lobby(lobby_id));

-- Leave a lobby (self) or kick someone (host).
create policy "lp_delete_self" on public.lobby_participants
  for delete using (auth.uid() = user_id);

create policy "lp_delete_host" on public.lobby_participants
  for delete using (public.user_hosts_lobby(lobby_id));


-- ── Realtime publication ─────────────────────────────────────────
-- Wrap in DO so a re-run doesn't error if a table is already added.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'lobbies'
  ) then
    alter publication supabase_realtime add table public.lobbies;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'lobby_participants'
  ) then
    alter publication supabase_realtime add table public.lobby_participants;
  end if;
end $$;


-- ── create_lobby(...) ────────────────────────────────────────────
-- Atomically: insert a fresh lobby with the caller as host, then
-- insert the host as participant in slot 1. Either both succeed or
-- neither (single function = single transaction). Returns the new
-- lobby id so the client can subscribe + share an invite link.
create or replace function public.create_lobby(
  p_song_file         text,
  p_song_title        text,
  p_speed_level       int default null,
  p_hit_window_level  int default null
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_lobby_id uuid;
begin
  if auth.uid() is null then
    raise exception 'auth required';
  end if;

  insert into public.lobbies
    (host_user_id, song_file, song_title, speed_level, hit_window_level)
  values
    (auth.uid(), p_song_file, p_song_title, p_speed_level, p_hit_window_level)
  returning id into v_lobby_id;

  insert into public.lobby_participants (lobby_id, user_id, slot)
  values (v_lobby_id, auth.uid(), 1);

  return v_lobby_id;
end;
$$;

grant execute on function public.create_lobby(text, text, int, int) to authenticated;


-- ── join_lobby(p_lobby_id) ───────────────────────────────────────
-- Validates the lobby is open for joining, finds the lowest free slot
-- (1-4), inserts the caller as a participant. Returns the assigned
-- slot, or null if the lobby is full / closed / nonexistent.
--
-- Safety: SELECT FOR UPDATE on the lobby row serialises concurrent
-- joins so two callers can't grab the same slot.
create or replace function public.join_lobby(p_lobby_id uuid)
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  v_state    text;
  v_slot     int;
  v_existing int;
begin
  if auth.uid() is null then
    raise exception 'auth required';
  end if;

  -- Lock the lobby row to serialise concurrent joins.
  select state into v_state
  from public.lobbies
  where id = p_lobby_id
  for update;

  if v_state is null then
    return null;
  end if;

  if v_state not in ('waiting','ready') then
    return null;
  end if;

  -- Idempotent: if already a participant, return existing slot.
  select slot into v_existing
  from public.lobby_participants
  where lobby_id = p_lobby_id and user_id = auth.uid();

  if v_existing is not null then
    return v_existing;
  end if;

  -- Find the lowest unused slot 1-4. generate_series + NOT IN handles
  -- the gap case (slot 1 leaves → next join lands at 1, not 5).
  select s into v_slot
  from generate_series(1, 4) s
  where s not in (
    select slot from public.lobby_participants
    where lobby_id = p_lobby_id and slot is not null
  )
  order by s
  limit 1;

  if v_slot is null then
    return null;   -- lobby full
  end if;

  insert into public.lobby_participants (lobby_id, user_id, slot)
  values (p_lobby_id, auth.uid(), v_slot);

  return v_slot;
end;
$$;

grant execute on function public.join_lobby(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════
-- Verify in the SQL editor:
--   select * from public.lobbies;             -- empty, no error
--   select * from public.lobby_participants;  -- empty, no error
--   select public.user_in_lobby(gen_random_uuid());     -- false
--   select public.user_hosts_lobby(gen_random_uuid());  -- false
-- ═══════════════════════════════════════════════════════════════════
