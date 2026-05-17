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
