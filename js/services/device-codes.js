// ════════════════════════════════════════════════════════════════════
// BandSync — Device Codes Service
// ════════════════════════════════════════════════════════════════════
// Friend → host identity handoff for couch co-op. See DESIGN.md §26.
//
//   generateCode(userId, profile)  — friend's side: create a 6-digit code
//   listMyCodes(userId)             — friend's side: list active codes
//   revokeCode(code)                — friend's side: delete an unused code
//   claimCode(code)                 — host's side: redeem someone else's code
//
// Backed by `device_codes` table + `claim_device_code()` RPC.
// ════════════════════════════════════════════════════════════════════

import { supabase } from './supabase.js';

const CODE_TTL_MS       = 10 * 60 * 1000;   // 10 minutes
const CODE_LENGTH       = 6;
const MAX_GEN_ATTEMPTS  = 5;
const PG_UNIQUE_CONFLICT = '23505';

// 6-digit string, zero-padded so '042619' is a valid code value.
function randomCode() {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(CODE_LENGTH, '0');
}

// Friend's side. Generates a fresh code, snapshotting the friend's
// profile (name / avatar / color) so the host's UI can display their
// identity instantly on claim — without needing to read the friend's
// profile row (which RLS would block).
export async function generateCode(userId, profile) {
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

  for (let attempt = 0; attempt < MAX_GEN_ATTEMPTS; attempt++) {
    const code = randomCode();
    const { data, error } = await supabase
      .from('device_codes')
      .insert({
        code,
        user_id:      userId,
        display_name: profile?.display_name ?? null,
        avatar:       profile?.avatar ?? null,
        accent_color: profile?.accent_color ?? null,
        expires_at:   expiresAt,
      })
      .select()
      .single();

    if (!error) return data;
    if (error.code !== PG_UNIQUE_CONFLICT) throw error;   // real failure → bubble
    // Else: code collision, retry with a fresh random.
  }
  throw new Error(`Could not generate a unique code after ${MAX_GEN_ATTEMPTS} attempts. Try again.`);
}

// Friend's side. Lists codes that are still claimable
// (unused AND not expired).
export async function listMyCodes(userId) {
  const { data, error } = await supabase
    .from('device_codes')
    .select('*')
    .eq('user_id', userId)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// Friend's side. Cancels an active code so it can't be claimed.
// (Already-used codes can also be deleted to tidy history — RLS allows
// own-row deletes regardless of state.)
export async function revokeCode(code) {
  const { error } = await supabase
    .from('device_codes')
    .delete()
    .eq('code', code);
  if (error) throw error;
}

// Host's side. Redeems a code the friend read aloud. Returns the
// friend's profile snapshot { user_id, display_name, avatar, accent_color }
// on success, or null if the code is invalid / expired / already claimed.
// The RPC marks the code consumed atomically — safe under concurrent claims.
export async function claimCode(code) {
  const { data, error } = await supabase.rpc('claim_device_code', { p_code: code });
  if (error) throw error;
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0];
}
