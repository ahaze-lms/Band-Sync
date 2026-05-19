// ════════════════════════════════════════════════════════════════════
// BandSync — Session Attachments Service
// ════════════════════════════════════════════════════════════════════
// Durable friend-identity tokens. See DESIGN.md §26 Evolution v2.
//
// The 6-digit device code (device-codes.js) is the one-shot pairing
// handshake. When it's claimed, claim_device_code() also issues a
// session token. This module persists those tokens in localStorage so
// reloads / tab-closes can rehydrate the friend's identity without
// re-pairing every song.
//
//   save / load / remove / clear  — localStorage layer, keyed by host
//   attach(token)                  — host's rehydrate RPC wrapper
//   revoke(token)                  — friend's revoke RPC wrapper
//   reattachAll(hostUserId)        — rehydrate every stored slot at once
//   listForUser(userId)            — friend's Connected Devices query
//
// Storage shape (one localStorage key per host user):
//   bandsync_attachments_<hostUserId> = {
//     "p2": { token, userId, displayName, avatar, accentColor, expiresAt },
//     ...
//   }
//
// expiresAt is a client-side optimisation — the server is the source
// of truth. attach() validates the token fully via the RPC.
// ════════════════════════════════════════════════════════════════════

import { supabase } from './supabase.js';

const STORAGE_PREFIX = 'bandsync_attachments_';

function storageKey(hostUserId) {
  return `${STORAGE_PREFIX}${hostUserId}`;
}

function readAll(hostUserId) {
  if (!hostUserId) return {};
  try {
    const raw = localStorage.getItem(storageKey(hostUserId));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeAll(hostUserId, map) {
  if (!hostUserId) return;
  try {
    if (!map || Object.keys(map).length === 0) {
      localStorage.removeItem(storageKey(hostUserId));
    } else {
      localStorage.setItem(storageKey(hostUserId), JSON.stringify(map));
    }
  } catch (err) {
    console.warn('session-attachments: localStorage write failed', err);
  }
}

function isExpired(attachment) {
  if (!attachment?.expiresAt) return true;
  return Date.parse(attachment.expiresAt) <= Date.now();
}

// ── localStorage layer ───────────────────────────────────────────

// Returns the stored map { slotKey -> attachment }, with expired
// entries already pruned (and persisted away).
export function load(hostUserId) {
  const map = readAll(hostUserId);
  let mutated = false;
  for (const key of Object.keys(map)) {
    if (isExpired(map[key])) {
      delete map[key];
      mutated = true;
    }
  }
  if (mutated) writeAll(hostUserId, map);
  return map;
}

// Persist a freshly-claimed attachment under a slot key (e.g. 'p2').
// Pass the full claim_device_code result + the issuer's choice of slot.
export function save(hostUserId, slotKey, attachment) {
  if (!hostUserId || !slotKey || !attachment?.token) return;
  const map = readAll(hostUserId);
  map[slotKey] = {
    token:        attachment.token,
    userId:       attachment.userId,
    displayName:  attachment.displayName ?? null,
    avatar:       attachment.avatar ?? null,
    accentColor:  attachment.accentColor ?? null,
    expiresAt:    attachment.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  writeAll(hostUserId, map);
}

// Forget a slot's attachment (e.g. user picked a different identity).
export function remove(hostUserId, slotKey) {
  if (!hostUserId || !slotKey) return;
  const map = readAll(hostUserId);
  if (!(slotKey in map)) return;
  delete map[slotKey];
  writeAll(hostUserId, map);
}

// Forget every attachment for a host (e.g. on sign-out).
export function clear(hostUserId) {
  if (!hostUserId) return;
  localStorage.removeItem(storageKey(hostUserId));
}

// ── RPC wrappers ─────────────────────────────────────────────────

// Host's rehydrate path. Returns the friend's profile snapshot on
// success, or null if the token is bad / expired / revoked. The RPC
// bumps last_used_at server-side as a side-effect.
export async function attach(token) {
  if (!token) return null;
  const { data, error } = await supabase.rpc('attach_session', { p_token: token });
  if (error) throw error;
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0];
}

// Friend-initiated revoke from Connected Devices. Returns true if the
// row was found + owned by the caller, false otherwise.
export async function revoke(token) {
  if (!token) return false;
  const { data, error } = await supabase.rpc('revoke_session_attachment', { p_token: token });
  if (error) throw error;
  return Boolean(data);
}

// ── Composite operations ─────────────────────────────────────────

// On entering play.html setup, attempt to rehydrate every stored slot.
// Returns { rehydrated: { slotKey -> { ...attachment, ...profile } }, dropped: [slotKey] }
// — rehydrated entries can be applied directly to slot identity; dropped
// keys have been pruned from localStorage (server said the token's stale).
export async function reattachAll(hostUserId) {
  const map = load(hostUserId);
  const rehydrated = {};
  const dropped = [];

  for (const [slotKey, stored] of Object.entries(map)) {
    try {
      const profile = await attach(stored.token);
      if (profile) {
        rehydrated[slotKey] = { ...stored, ...profile };
      } else {
        dropped.push(slotKey);
        remove(hostUserId, slotKey);
      }
    } catch {
      // Network/transient errors — keep the token, try again later.
      // We deliberately don't drop on transport failure.
    }
  }

  return { rehydrated, dropped };
}

// Host-side. Lists friends previously paired with this device whose
// tokens are still valid — for "one-tap reattach" UI in play.html setup.
// De-duplicates by user_id (most recently used token wins). The host's
// own `sa_select_host` RLS policy permits the read; no extra RPC needed.
export async function listPaired(hostUserId) {
  const { data, error } = await supabase
    .from('session_attachments')
    .select('token, user_id, display_name, avatar, accent_color, last_used_at, expires_at')
    .eq('host_user_id', hostUserId)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('last_used_at', { ascending: false });
  if (error) throw error;

  const seen = new Set();
  const out  = [];
  for (const row of data ?? []) {
    if (seen.has(row.user_id)) continue;
    seen.add(row.user_id);
    out.push(row);
  }
  return out;
}

// Friend's Connected Devices view. Lists their active (unexpired,
// unrevoked) attachments, newest first. Augmented with host profile
// info so the UI can show "claimed by @anthony".
export async function listForUser(userId) {
  const { data, error } = await supabase
    .from('session_attachments')
    .select('token, host_user_id, created_at, last_used_at, expires_at, revoked_at, revoked_reason')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('last_used_at', { ascending: false });
  if (error) throw error;

  const hostIds = [...new Set((data ?? []).map(r => r.host_user_id).filter(Boolean))];
  let hosts = {};
  if (hostIds.length) {
    const { data: profs, error: pErr } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar, accent_color')
      .in('id', hostIds);
    if (pErr) throw pErr;
    hosts = Object.fromEntries((profs ?? []).map(p => [p.id, p]));
  }

  return (data ?? []).map(r => ({ ...r, host: hosts[r.host_user_id] ?? null }));
}
