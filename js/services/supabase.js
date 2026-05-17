// Uses the UMD bundle loaded via <script> in index.html — no CDN round-trip
const { createClient } = window.supabase;

export const supabase = createClient(
  'https://pmccwxovzhfdkuqzhkez.supabase.co',
  'sb_publishable_ArRtkgDYTa6kaoIlbZ_hhw_utgB2wHC'
);
