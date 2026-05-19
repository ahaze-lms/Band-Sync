-- ═══════════════════════════════════════════════════════════════════
-- BandSync — Migration 0003: Durable Session Attachments
-- ═══════════════════════════════════════════════════════════════════
-- DESIGN.md §26 Evolution v2. The §26 MVP keeps friend identities in
-- memory only — reload kills the attachment, friend has to generate a
-- fresh 6-digit code every song. This migration adds a token-based
-- persistence layer on top: claiming a code also issues a session
-- token the host stores in localStorage; reloads call attach_session
-- to rehydrate.
--
-- The 6-digit code remains the one-shot pairing handshake. The token
-- is the durable artifact that survives reloads (24h TTL, revocable).
--
--   session_attachments         — token rows (per friend, per host)
--   claim_device_code (updated) — also issues + returns session_token
--   attach_session (new)        — validate stored token, return profile
--   revoke_session_attachment   — friend-initiated revoke
--
-- HOW TO RUN: Supabase dashboard → SQL editor → paste this file → Run.
-- Idempotent against re-runs (uses if-exists / drop-if-exists where
-- needed); safe to apply on top of migration 0001.
-- ═══════════════════════════════════════════════════════════════════


-- ── SESSION ATTACHMENTS ───────────────────────────────────────────
-- One row per (friend, host, claim event). Friend's profile is
-- snapshotted at claim time so rehydrates don't depend on the friend's
-- profile row being readable to the host (RLS would block it).
create table if not exists public.session_attachments (
  token          text primary key,                  -- 64 hex chars, 256-bit secret
  user_id        uuid references auth.users on delete cascade not null,
  host_user_id   uuid references auth.users on delete cascade not null,
  display_name   text,
  avatar         text,
  accent_color   text,
  created_at     timestamptz default now(),
  last_used_at   timestamptz default now(),         -- bumped on each attach_session
  expires_at     timestamptz not null,              -- created_at + 24h default
  revoked_at     timestamptz,
  revoked_reason text                               -- 'user' | 'expired' | 'rotated'
);

create index if not exists session_attachments_user_idx
  on public.session_attachments (user_id, expires_at);
create index if not exists session_attachments_host_idx
  on public.session_attachments (host_user_id);


alter table public.session_attachments enable row level security;

-- Friend reads / manages their own attachments (Connected Devices view).
drop policy if exists "sa_select_own"  on public.session_attachments;
drop policy if exists "sa_select_host" on public.session_attachments;
drop policy if exists "sa_update_own"  on public.session_attachments;
drop policy if exists "sa_delete_own"  on public.session_attachments;

create policy "sa_select_own" on public.session_attachments
  for select using (auth.uid() = user_id);

-- Host reads attachments to their own device — needed if the host UI
-- ever wants to list "friends currently attached here" without calling
-- the RPC. attach_session via RPC remains the canonical rehydrate path
-- because SECURITY DEFINER lets it bump last_used_at.
create policy "sa_select_host" on public.session_attachments
  for select using (auth.uid() = host_user_id);

-- Friend revokes their own attachment (sets revoked_at, revoked_reason).
create policy "sa_update_own" on public.session_attachments
  for update using (auth.uid() = user_id);

-- Friend can also fully delete (Connected Devices cleanup).
create policy "sa_delete_own" on public.session_attachments
  for delete using (auth.uid() = user_id);

-- No INSERT policy — only the SECURITY DEFINER RPC below writes rows.


-- ── claim_device_code(p_code) — UPDATED ──────────────────────────
-- Same args, but return widens to add session_token. Existing callers
-- that read user_id / display_name / avatar / accent_color keep
-- working; new callers can grab the token to persist the attachment.
--
-- Wrapped in a transaction: code consumption + attachment insert
-- happen atomically so we can't end up with a consumed code and no
-- attachment (or vice versa).
drop function if exists public.claim_device_code(text);

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
  if auth.uid() is null then
    return;
  end if;

  -- Lock the candidate row to serialize concurrent claim attempts.
  select * into v_row
  from public.device_codes
  where code = p_code
    and used_at is null
    and expires_at > now()
  for update;

  if not found then
    return;
  end if;

  update public.device_codes
    set used_at = now(),
        used_by_user = auth.uid()
    where code = p_code;

  -- 64 hex chars from two UUIDs. ~244 bits of effective entropy.
  -- Using gen_random_uuid() (Postgres core) rather than pgcrypto's
  -- gen_random_bytes() so the function works without depending on
  -- pgcrypto's schema being on the search_path.
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


-- ── attach_session(p_token) — NEW ────────────────────────────────
-- Host's rehydrate path. Validates that the token is unrevoked +
-- unexpired, bumps last_used_at, and returns the friend's profile
-- snapshot. Returns no rows if invalid / expired / revoked (caller
-- treats as "stale token, drop from localStorage").
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
  if auth.uid() is null then
    return;
  end if;

  select * into v_row
  from public.session_attachments
  where token = p_token
    and revoked_at is null
    and expires_at > now()
    and host_user_id = auth.uid()    -- token bound to this host
  for update;

  if not found then
    return;
  end if;

  update public.session_attachments
    set last_used_at = now()
    where token = p_token;

  return query
    select v_row.user_id, v_row.display_name, v_row.avatar, v_row.accent_color;
end;
$$;

grant execute on function public.attach_session(text) to authenticated;


-- ── revoke_session_attachment(p_token) — NEW ─────────────────────
-- Friend-initiated revoke from Connected Devices. Only the attachment
-- owner (the friend) can revoke. Idempotent — re-revoking a revoked
-- token is a no-op.
create or replace function public.revoke_session_attachment(p_token text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  v_user_id uuid;
begin
  if auth.uid() is null then
    return false;
  end if;

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


-- ═══════════════════════════════════════════════════════════════════
-- Verify in the SQL editor:
--   select * from public.session_attachments;          -- empty, no error
--   select public.attach_session('bogus');             -- returns no rows
--   select public.revoke_session_attachment('bogus');  -- returns false
-- ═══════════════════════════════════════════════════════════════════
