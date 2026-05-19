-- ═══════════════════════════════════════════════════════════════════
-- BandSync — Migration 0004: Opportunistic attachment cleanup
-- ═══════════════════════════════════════════════════════════════════
-- DESIGN.md §26 Evolution v2 phase 6. Without cleanup, every claim
-- accumulates a session_attachments row forever — even after it's
-- expired or revoked. Same for used device_codes (the audit log
-- table). Volumes are low for a personal-project rhythm game, but
-- "small forever" still becomes "not so small" over years.
--
-- Approach: piggyback on claim_device_code. Every fresh claim runs a
-- tiny cleanup pass first. No scheduled job, no Edge Function, no
-- cron. The retention windows are generous so the audit log + friend's
-- Connected Devices view stay useful for the recent past:
--
--   session_attachments  — drop 30 days after expiry/revoke
--   device_codes (used)  — drop 90 days after use
--
-- Re-running this migration is safe (create or replace).
--
-- HOW TO RUN: Supabase dashboard → SQL editor → paste → Run.
-- ═══════════════════════════════════════════════════════════════════


-- ── cleanup_attachments_and_codes() ───────────────────────────────
-- Separately callable so it can be triggered from elsewhere later
-- (e.g. a pg_cron schedule if claim traffic ever drops to zero).
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


-- ── claim_device_code(p_code) — UPDATED ──────────────────────────
-- Adds a single perform-cleanup call at the top of the function.
-- All other logic identical to migration 0003. Return signature
-- unchanged so JS callers don't need to know about this.
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
  if auth.uid() is null then return; end if;

  -- Opportunistic cleanup of long-expired/revoked rows. Tiny work
  -- in a low-volume table — no need for an index strategy.
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


-- ═══════════════════════════════════════════════════════════════════
-- Verify in the SQL editor:
--   select public.cleanup_attachments_and_codes();  -- void, no error
-- ═══════════════════════════════════════════════════════════════════
