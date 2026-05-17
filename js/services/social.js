import { supabase } from './supabase.js';

// ── FRIENDS ───────────────────────────────────────────────────────

export async function getFriends(userId) {
  const { data, error } = await supabase
    .from('friend_requests')
    .select(`id, status,
      sender:from_id(id,username,display_name,avatar,accent_color,is_online),
      receiver:to_id(id,username,display_name,avatar,accent_color,is_online)`)
    .eq('status', 'accepted')
    .or(`from_id.eq.${userId},to_id.eq.${userId}`);
  if (error) throw error;
  return (data ?? []).map(r => ({
    requestId: r.id,
    friend: r.sender.id === userId ? r.receiver : r.sender,
  }));
}

export async function getPendingIncoming(userId) {
  const { data, error } = await supabase
    .from('friend_requests')
    .select(`id, created_at,
      sender:from_id(id,username,display_name,avatar,accent_color)`)
    .eq('to_id', userId).eq('status', 'pending');
  if (error) throw error;
  return data ?? [];
}

export async function getPendingOutgoing(userId) {
  const { data, error } = await supabase
    .from('friend_requests')
    .select(`id, created_at,
      receiver:to_id(id,username,display_name,avatar,accent_color)`)
    .eq('from_id', userId).eq('status', 'pending');
  if (error) throw error;
  return data ?? [];
}

export async function sendFriendRequest(fromId, toId) {
  const { error } = await supabase
    .from('friend_requests').insert({ from_id: fromId, to_id: toId });
  if (error) throw error;
}

export async function respondToFriendRequest(requestId, status) {
  const { error } = await supabase
    .from('friend_requests').update({ status }).eq('id', requestId);
  if (error) throw error;
}

export async function cancelFriendRequest(requestId) {
  const { error } = await supabase
    .from('friend_requests').delete().eq('id', requestId);
  if (error) throw error;
}

export async function removeFriend(requestId) {
  await cancelFriendRequest(requestId);
}

// ── MESSAGES ──────────────────────────────────────────────────────

export async function getConversation(userId, friendId) {
  const { data, error } = await supabase
    .from('messages').select('*')
    .or(`and(from_id.eq.${userId},to_id.eq.${friendId}),and(from_id.eq.${friendId},to_id.eq.${userId})`)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function getRecentConversations(userId) {
  // Get latest message per conversation partner
  const { data, error } = await supabase
    .from('messages')
    .select(`id, body, created_at, read_at, from_id, to_id,
      sender:from_id(id,username,display_name,avatar,accent_color),
      recipient:to_id(id,username,display_name,avatar,accent_color)`)
    .or(`from_id.eq.${userId},to_id.eq.${userId}`)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;

  // Deduplicate by partner
  const seen = new Set();
  const convos = [];
  for (const msg of data ?? []) {
    const partner = msg.from_id === userId ? msg.recipient : msg.sender;
    if (!partner || seen.has(partner.id)) continue;
    seen.add(partner.id);
    convos.push({ partner, latestMsg: msg, unread: !msg.read_at && msg.to_id === userId });
  }
  return convos;
}

export async function sendMessage(fromId, toId, body) {
  const { error } = await supabase
    .from('messages').insert({ from_id: fromId, to_id: toId, body });
  if (error) throw error;
}

export async function markMessagesRead(userId, fromId) {
  await supabase.from('messages')
    .update({ read_at: new Date().toISOString() })
    .eq('to_id', userId).eq('from_id', fromId).is('read_at', null);
}

export async function getUnreadCount(userId) {
  const { count } = await supabase
    .from('messages').select('*', { count: 'exact', head: true })
    .eq('to_id', userId).is('read_at', null);
  return count ?? 0;
}

// ── PLAY INVITES ──────────────────────────────────────────────────

export async function sendPlayInvite(fromId, toId, songId = null) {
  const { data, error } = await supabase
    .from('play_invites').insert({ from_id: fromId, to_id: toId, song_id: songId })
    .select().single();
  if (error) throw error;
  return data;
}

export async function getPendingPlayInvites(userId) {
  const { data, error } = await supabase
    .from('play_invites')
    .select(`id, song_id, expires_at, created_at,
      sender:from_id(id,username,display_name,avatar,accent_color)`)
    .eq('to_id', userId).eq('status', 'pending')
    .gt('expires_at', new Date().toISOString());
  if (error) throw error;
  return data ?? [];
}

export async function respondToPlayInvite(inviteId, status) {
  const { error } = await supabase
    .from('play_invites').update({ status }).eq('id', inviteId);
  if (error) throw error;
}

// ── REALTIME ──────────────────────────────────────────────────────

export function subscribeToInbox(userId, { onMessage, onPlayInvite, onFriendRequest }) {
  const ch = supabase.channel(`inbox:${userId}`);
  if (onMessage)
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages',
      filter: `to_id=eq.${userId}` }, p => onMessage(p.new));
  if (onPlayInvite)
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'play_invites',
      filter: `to_id=eq.${userId}` }, p => onPlayInvite(p.new));
  if (onFriendRequest)
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'friend_requests',
      filter: `to_id=eq.${userId}` }, p => onFriendRequest(p.new));
  ch.subscribe();
  return () => supabase.removeChannel(ch);
}
