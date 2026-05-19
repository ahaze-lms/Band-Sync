-- ═══════════════════════════════════════════════════════════════════
-- BandSync — Migration 0008: Songs (Studio Phase 4)
-- ═══════════════════════════════════════════════════════════════════
-- Adds the `songs` table backing studio.html save / load / delete.
-- Phase 4 ships owner-only access (every song is private). Phase 5
-- will layer in the `friends` and `public` visibility policies; the
-- column already exists so the migration won't need to change shape.
--
-- The `data` JSONB column stores the song's tracks in a future-
-- compatible shape — `{ tracks: [{ name, role, color, notes: [...] }] }`
-- — even though Phase 4 only ever writes a single track. Phase 5
-- multi-track will read existing single-track rows unchanged.
--
-- HOW TO RUN:
--   Supabase dashboard → SQL editor → paste this file → Run.
-- ═══════════════════════════════════════════════════════════════════


-- ── SONGS ─────────────────────────────────────────────────────────
create table public.songs (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid references auth.users on delete cascade not null,
  name        text not null,
  description text,
  bpm         integer not null default 120,
  bars        integer not null default 32,
  visibility  text not null default 'private'
                check (visibility in ('private','friends','public')),
  remix_of    uuid references public.songs on delete set null,
  data        jsonb not null,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Owner-keyed list query ("show me my songs, newest edit first").
create index songs_owner_updated_idx on public.songs (owner_id, updated_at desc);

-- Partial index for the eventual Browse / Discover query (Phase 6).
create index songs_public_idx on public.songs (visibility) where visibility = 'public';

alter table public.songs enable row level security;


-- ── PHASE 4 RLS (owner-only) ──────────────────────────────────────
-- Phase 5 will add additional select policies for visibility =
-- 'friends' / 'public' without modifying the four below.
create policy "songs_select_own" on public.songs
  for select using (auth.uid() = owner_id);

create policy "songs_insert_own" on public.songs
  for insert with check (auth.uid() = owner_id);

create policy "songs_update_own" on public.songs
  for update using (auth.uid() = owner_id);

create policy "songs_delete_own" on public.songs
  for delete using (auth.uid() = owner_id);


-- ── updated_at trigger ────────────────────────────────────────────
-- Lets the client save without computing updated_at locally; also
-- guarantees consistency if the column ever gets edited from the
-- Supabase dashboard.
create or replace function songs_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger songs_set_updated_at
  before update on public.songs
  for each row
  execute function songs_touch_updated_at();
