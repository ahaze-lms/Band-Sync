import { supabase } from './supabase.js';

export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles').select('*').eq('id', userId).single();
  if (error) throw error;
  return data;
}

export async function updateProfile(userId, updates) {
  const { data, error } = await supabase
    .from('profiles').upsert({ id: userId, ...updates }).select().single();
  if (error) throw error;
  return data;
}

export async function isUsernameTaken(username) {
  const { data } = await supabase
    .from('profiles').select('id').eq('username', username).maybeSingle();
  return !!data;
}

export async function searchProfiles(query) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar, accent_color, is_online')
    .or(`username.ilike.%${query}%,display_name.ilike.%${query}%`)
    .limit(10);
  if (error) throw error;
  return data ?? [];
}

export async function setOnline(userId, isOnline) {
  await supabase.from('profiles').update({
    is_online: isOnline,
    last_seen_at: new Date().toISOString(),
  }).eq('id', userId);
}
