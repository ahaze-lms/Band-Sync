-- ═══════════════════════════════════════════════════════════════════
-- BandSync — Migration 0007: Add lobby_id to play_invites
-- ═══════════════════════════════════════════════════════════════════
-- Enables the friend-invite-from-lobby flow (DESIGN.md §27 UX polish).
-- Host clicks "INVITE" next to a friend in the lobby UI → a play_invite
-- row is inserted with lobby_id set. Recipient sees it in their real-time
-- inbox; clicking JOIN LOBBY navigates to play.html?lobby=<id>.
--
-- lobby_id is nullable so existing generic play invites (no lobby) still
-- work unchanged. ON DELETE CASCADE means lobby deletion cleans up any
-- pending invites automatically.
--
-- HOW TO RUN: Supabase dashboard → SQL editor → paste → Run.
-- ═══════════════════════════════════════════════════════════════════

alter table public.play_invites
  add column lobby_id uuid references public.lobbies on delete cascade;

-- Index so the friend can quickly find their pending lobby invites.
create index play_invites_lobby_idx on public.play_invites (lobby_id)
  where lobby_id is not null;

-- ═══════════════════════════════════════════════════════════════════
-- Verify:
--   \d public.play_invites   -- lobby_id column should appear
-- ═══════════════════════════════════════════════════════════════════
