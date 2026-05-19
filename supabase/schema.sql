-- ═══════════════════════════════════════════════════════════════
-- BandSync — Supabase Schema
-- Paste into: Supabase dashboard → SQL editor → New query → Run
-- ═══════════════════════════════════════════════════════════════

-- ── PROFILES ─────────────────────────────────────────────────────
create table public.profiles (
  id            uuid references auth.users on delete cascade primary key,
  username      text unique,
  display_name  text,
  avatar        text default 'piano',
  accent_color  text default 'purple',
  tagline       text,
  is_online     boolean default false,
  last_seen_at  timestamptz,
  created_at    timestamptz default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select" on public.profiles for select using (true);
create policy "profiles_insert" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update" on public.profiles for update using (auth.uid() = id);

-- ── FRIEND REQUESTS ───────────────────────────────────────────────
create table public.friend_requests (
  id          uuid default gen_random_uuid() primary key,
  from_id     uuid references public.profiles on delete cascade not null,
  to_id       uuid references public.profiles on delete cascade not null,
  status      text check (status in ('pending','accepted','declined')) default 'pending',
  created_at  timestamptz default now(),
  unique (from_id, to_id)
);

alter table public.friend_requests enable row level security;

create policy "fr_select" on public.friend_requests
  for select using (auth.uid() = from_id or auth.uid() = to_id);
create policy "fr_insert" on public.friend_requests
  for insert with check (auth.uid() = from_id);
create policy "fr_update" on public.friend_requests
  for update using (auth.uid() = to_id or auth.uid() = from_id);
create policy "fr_delete" on public.friend_requests
  for delete using (auth.uid() = from_id);

-- ── MESSAGES ──────────────────────────────────────────────────────
create table public.messages (
  id          uuid default gen_random_uuid() primary key,
  from_id     uuid references public.profiles on delete cascade not null,
  to_id       uuid references public.profiles on delete cascade not null,
  body        text not null,
  read_at     timestamptz,
  created_at  timestamptz default now()
);

alter table public.messages enable row level security;

create policy "msg_select" on public.messages
  for select using (auth.uid() = from_id or auth.uid() = to_id);
create policy "msg_insert" on public.messages
  for insert with check (auth.uid() = from_id);
create policy "msg_update" on public.messages
  for update using (auth.uid() = to_id);

-- ── PLAY INVITES ──────────────────────────────────────────────────
create table public.play_invites (
  id          uuid default gen_random_uuid() primary key,
  from_id     uuid references public.profiles on delete cascade not null,
  to_id       uuid references public.profiles on delete cascade not null,
  song_id     text,
  status      text check (status in ('pending','accepted','declined','expired','cancelled')) default 'pending',
  expires_at  timestamptz default (now() + interval '5 minutes'),
  created_at  timestamptz default now()
);

alter table public.play_invites enable row level security;

create policy "pi_select" on public.play_invites
  for select using (auth.uid() = from_id or auth.uid() = to_id);
create policy "pi_insert" on public.play_invites
  for insert with check (auth.uid() = from_id);
create policy "pi_update" on public.play_invites
  for update using (auth.uid() = to_id or auth.uid() = from_id);

-- ── AUTO-CREATE PROFILE ON SIGNUP ────────────────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data->>'display_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ── REALTIME ──────────────────────────────────────────────────────
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.play_invites;
alter publication supabase_realtime add table public.profiles;
alter publication supabase_realtime add table public.friend_requests;


-- ═══════════════════════════════════════════════════════════════════
-- Player Identity & Multi-Account Sessions (DESIGN.md §26)
-- ═══════════════════════════════════════════════════════════════════
-- Mirror of migrations/0001_player_identity.sql for fresh installs.
-- If you're modifying an existing project, run the migration file
-- instead — running this whole schema.sql against an existing DB
-- would fail on the original tables above.

-- ── DEVICE CODES ──────────────────────────────────────────────────
create table public.device_codes (
  code           text primary key,
  user_id        uuid references auth.users on delete cascade not null,
  display_name   text,
  avatar         text,
  accent_color   text,
  created_at     timestamptz default now(),
  expires_at     timestamptz not null,
  used_at        timestamptz,
  used_by_user   uuid references auth.users on delete set null
);

create index device_codes_user_idx    on public.device_codes (user_id, created_at desc);
create index device_codes_expires_idx on public.device_codes (expires_at);

alter table public.device_codes enable row level security;

create policy "dc_insert_own" on public.device_codes for insert with check (auth.uid() = user_id);
create policy "dc_select_own" on public.device_codes for select using (auth.uid() = user_id);
create policy "dc_update_own" on public.device_codes for update using (auth.uid() = user_id);
create policy "dc_delete_own" on public.device_codes for delete using (auth.uid() = user_id);

-- ── SESSION ATTACHMENTS ───────────────────────────────────────────
-- DESIGN.md §26 Evolution v2. Durable token issued at claim time so
-- the host's reloads can rehydrate a friend identity without the
-- friend regenerating a 6-digit code every song.
create table public.session_attachments (
  token          text primary key,
  user_id        uuid references auth.users on delete cascade not null,
  host_user_id   uuid references auth.users on delete cascade not null,
  display_name   text,
  avatar         text,
  accent_color   text,
  created_at     timestamptz default now(),
  last_used_at   timestamptz default now(),
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  revoked_reason text
);

create index session_attachments_user_idx on public.session_attachments (user_id, expires_at);
create index session_attachments_host_idx on public.session_attachments (host_user_id);

alter table public.session_attachments enable row level security;

create policy "sa_select_own"  on public.session_attachments for select using (auth.uid() = user_id);
create policy "sa_select_host" on public.session_attachments for select using (auth.uid() = host_user_id);
create policy "sa_update_own"  on public.session_attachments for update using (auth.uid() = user_id);
create policy "sa_delete_own"  on public.session_attachments for delete using (auth.uid() = user_id);
-- No INSERT policy — only claim_device_code() (SECURITY DEFINER) inserts.

-- Opportunistic cleanup of long-expired/revoked attachments + used
-- device codes. Called from claim_device_code on every fresh claim
-- so the audit log + Connected Devices view stay clean without a
-- scheduled job.
create or replace function public.cleanup_attachments_and_codes()
returns void
language sql security definer
set search_path = public
as $$
  delete from public.session_attachments
  where (expires_at < now() - interval '30 days')
     or (revoked_at is not null and revoked_at < now() - interval '30 days');

  delete from public.device_codes
  where used_at is not null
    and used_at < now() - interval '90 days';
$$;

create or replace function public.claim_device_code(p_code text)
returns table (
  user_id       uuid,
  display_name  text,
  avatar        text,
  accent_color  text,
  session_token text
)
language plpgsql security definer
set search_path = public
as $$
declare
  v_row   public.device_codes%rowtype;
  v_token text;
begin
  if auth.uid() is null then return; end if;

  perform public.cleanup_attachments_and_codes();

  select * into v_row
  from public.device_codes
  where code = p_code
    and used_at is null
    and expires_at > now()
  for update;

  if not found then return; end if;

  update public.device_codes
    set used_at = now(), used_by_user = auth.uid()
    where code = p_code;

  v_token := replace(gen_random_uuid()::text, '-', '') ||
             replace(gen_random_uuid()::text, '-', '');

  insert into public.session_attachments
    (token, user_id, host_user_id, display_name, avatar, accent_color, expires_at)
  values
    (v_token, v_row.user_id, auth.uid(), v_row.display_name,
     v_row.avatar, v_row.accent_color, now() + interval '24 hours');

  return query
    select v_row.user_id, v_row.display_name, v_row.avatar,
           v_row.accent_color, v_token;
end;
$$;

grant execute on function public.claim_device_code(text) to authenticated;

-- Host's rehydrate path. Validates token + bumps last_used_at.
create or replace function public.attach_session(p_token text)
returns table (
  user_id      uuid,
  display_name text,
  avatar       text,
  accent_color text
)
language plpgsql security definer
set search_path = public
as $$
declare
  v_row public.session_attachments%rowtype;
begin
  if auth.uid() is null then return; end if;

  select * into v_row
  from public.session_attachments
  where token = p_token
    and revoked_at is null
    and expires_at > now()
    and host_user_id = auth.uid()
  for update;

  if not found then return; end if;

  update public.session_attachments
    set last_used_at = now()
    where token = p_token;

  return query
    select v_row.user_id, v_row.display_name, v_row.avatar, v_row.accent_color;
end;
$$;

grant execute on function public.attach_session(text) to authenticated;

-- Friend-initiated revoke from Connected Devices view.
create or replace function public.revoke_session_attachment(p_token text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  v_user_id uuid;
begin
  if auth.uid() is null then return false; end if;

  select user_id into v_user_id
  from public.session_attachments
  where token = p_token;

  if v_user_id is null or v_user_id <> auth.uid() then
    return false;
  end if;

  update public.session_attachments
    set revoked_at = coalesce(revoked_at, now()),
        revoked_reason = coalesce(revoked_reason, 'user')
    where token = p_token;

  return true;
end;
$$;

grant execute on function public.revoke_session_attachment(text) to authenticated;

-- ── PLAY SESSIONS ─────────────────────────────────────────────────
create table public.play_sessions (
  id                uuid default gen_random_uuid() primary key,
  host_user_id      uuid references auth.users on delete set null,
  song_file         text not null,
  song_title        text not null,
  started_at        timestamptz default now(),
  ended_at          timestamptz,
  speed_level       int,
  hit_window_level  int,
  player_count      int not null check (player_count between 1 and 4)
);

create index play_sessions_host_idx on public.play_sessions (host_user_id, started_at desc);

-- ── PLAY SESSION SLOTS ────────────────────────────────────────────
create table public.play_session_slots (
  session_id    uuid references public.play_sessions on delete cascade not null,
  slot          int not null check (slot between 1 and 4),
  identity      text not null check (identity in ('host','friend','guest')),
  user_id       uuid references auth.users on delete set null,
  display_name  text not null,
  instrument    text not null check (instrument in ('piano','drums')),
  track_index   int not null,
  track_name    text,
  score         int default 0,
  accuracy      int,
  grade         text,
  perfect       int default 0,
  good          int default 0,
  miss          int default 0,
  wrong         int default 0,
  max_combo     int default 0,
  primary key (session_id, slot)
);

create index play_session_slots_user_idx on public.play_session_slots (user_id);

-- ── Helper functions to break RLS cross-reference recursion (see
--    migrations/0002_fix_play_session_rls_recursion.sql for the why) ──
create or replace function public.user_in_session(p_session_id uuid)
returns boolean
language sql security definer
set search_path = public
as $$
  select exists (
    select 1 from public.play_session_slots
    where session_id = p_session_id and user_id = auth.uid()
  );
$$;

create or replace function public.user_hosts_session(p_session_id uuid)
returns boolean
language sql security definer
set search_path = public
as $$
  select exists (
    select 1 from public.play_sessions
    where id = p_session_id and host_user_id = auth.uid()
  );
$$;

grant execute on function public.user_in_session(uuid)    to authenticated;
grant execute on function public.user_hosts_session(uuid) to authenticated;

-- ── RLS — play_sessions ───────────────────────────────────────────
alter table public.play_sessions enable row level security;

create policy "ps_insert_host" on public.play_sessions
  for insert with check (auth.uid() = host_user_id);
create policy "ps_select_host" on public.play_sessions
  for select using (auth.uid() = host_user_id);
create policy "ps_select_participant" on public.play_sessions
  for select using (public.user_in_session(id));
create policy "ps_update_host" on public.play_sessions
  for update using (auth.uid() = host_user_id);

-- ── RLS — play_session_slots ──────────────────────────────────────
alter table public.play_session_slots enable row level security;

create policy "pss_insert_host" on public.play_session_slots
  for insert with check (public.user_hosts_session(session_id));
create policy "pss_update_host" on public.play_session_slots
  for update using (public.user_hosts_session(session_id));
create policy "pss_select_own" on public.play_session_slots
  for select using (auth.uid() = user_id);
create policy "pss_select_host" on public.play_session_slots
  for select using (public.user_hosts_session(session_id));
