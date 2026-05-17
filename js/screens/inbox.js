import { getFriends } from '../services/social.js';
import { getConversation, sendMessage, markMessagesRead,
         getRecentConversations, subscribeToInbox } from '../services/social.js';
import { avatarEmoji, accentFor, timeAgo, refreshBadges } from '../app.js';
import { supabase } from '../services/supabase.js';

export function mount(el, ctx, navigate, { openWith = null } = {}) {
  const { user } = ctx;
  let activePartnerId = null;
  let unsub = null;

  el.innerHTML = `
    <div class="inbox-wrap">
      <div class="inbox-sidebar">
        <div class="panel-title" style="padding:12px 14px 8px">MESSAGES</div>
        <div id="convo-list"></div>
      </div>
      <div class="inbox-main" id="inbox-main">
        <div class="inbox-empty">Select a conversation</div>
      </div>
    </div>
  `;

  async function loadConvoList() {
    const [convos, friends] = await Promise.all([
      getRecentConversations(user.id),
      getFriends(user.id),
    ]);

    // Merge: conversations + friends with no messages yet
    const seen = new Set(convos.map(c => c.partner.id));
    const friendsOnly = friends
      .filter(f => !seen.has(f.friend.id))
      .map(f => ({ partner: f.friend, latestMsg: null, unread: false }));

    const all = [...convos, ...friendsOnly];
    const listEl = document.getElementById('convo-list');
    if (!all.length) { listEl.innerHTML = '<div class="dim" style="padding:12px">Add friends to start messaging.</div>'; return; }

    listEl.innerHTML = all.map(({ partner: p, latestMsg, unread }) => {
      const color = accentFor(p.accent_color);
      return `<div class="convo-row ${unread ? 'unread' : ''}" data-id="${p.id}">
        <span class="friend-avatar" style="color:${color.accent}">${avatarEmoji(p.avatar)}</span>
        <div class="friend-info">
          <span class="friend-name" style="color:${color.accent}">${esc(p.display_name ?? p.username)}</span>
          <span class="convo-preview">${latestMsg ? esc(latestMsg.body.slice(0,40)) : 'Start a conversation'}</span>
        </div>
        ${unread ? '<span class="unread-dot"></span>' : ''}
        <span class="status-dot ${p.is_online ? 'online' : 'offline'}" style="margin-left:auto"></span>
      </div>`;
    }).join('');

    listEl.querySelectorAll('.convo-row').forEach(row => {
      row.addEventListener('click', () => openConversation(row.dataset.id, all.find(c => c.partner.id === row.dataset.id)?.partner));
    });

    // Auto-open if requested
    if (openWith) {
      const target = all.find(c => c.partner.id === openWith);
      if (target) openConversation(openWith, target.partner);
      else {
        // Friend with no messages yet — fetch their profile
        const match = friends.find(f => f.friend.id === openWith);
        if (match) openConversation(openWith, match.friend);
      }
    }
  }

  async function openConversation(partnerId, partnerProfile) {
    activePartnerId = partnerId;
    // Mobile: swap from list-pane to conversation-pane.
    document.querySelector('.inbox-wrap')?.classList.add('has-active');
    // Highlight selected
    document.querySelectorAll('.convo-row').forEach(r =>
      r.classList.toggle('active', r.dataset.id === partnerId));

    const color = accentFor(partnerProfile?.accent_color);
    const mainEl = document.getElementById('inbox-main');
    mainEl.innerHTML = `
      <div class="chat-header">
        <button class="chat-back-btn" id="chat-back" title="Back to messages">← BACK</button>
        <span class="friend-avatar" style="color:${color.accent}">${avatarEmoji(partnerProfile?.avatar)}</span>
        <div>
          <div class="friend-name" style="color:${color.accent}">${esc(partnerProfile?.display_name ?? partnerProfile?.username)}</div>
          <div class="dim" style="font-size:10px">@${esc(partnerProfile?.username)}</div>
        </div>
        <span class="status-dot ${partnerProfile?.is_online ? 'online' : 'offline'}" style="margin-left:auto"></span>
      </div>
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-input-row">
        <input class="input" id="chat-input" placeholder="Message..." maxlength="500">
        <button class="btn btn-primary" id="chat-send">SEND</button>
      </div>
    `;

    document.getElementById('chat-back')?.addEventListener('click', () => {
      document.querySelector('.inbox-wrap')?.classList.remove('has-active');
      activePartnerId = null;
      // Clear the highlight on the list so re-entering doesn't look pre-selected.
      document.querySelectorAll('.convo-row').forEach(r => r.classList.remove('active'));
    });

    await loadMessages(partnerId);
    await markMessagesRead(user.id, partnerId);
    refreshBadges();

    document.getElementById('chat-send').addEventListener('click', () => doSend(partnerId));
    document.getElementById('chat-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(partnerId); }
    });
    document.getElementById('chat-input').focus();
  }

  async function loadMessages(partnerId) {
    const msgs = await getConversation(user.id, partnerId);
    renderMessages(msgs);
  }

  function renderMessages(msgs) {
    const el2 = document.getElementById('chat-messages');
    if (!el2) return;
    if (!msgs.length) { el2.innerHTML = '<div class="dim" style="text-align:center;padding:24px">No messages yet.</div>'; return; }
    el2.innerHTML = msgs.map(m => {
      const mine = m.from_id === user.id;
      return `<div class="chat-msg ${mine ? 'mine' : 'theirs'}">
        <div class="chat-bubble">${esc(m.body)}</div>
        <div class="chat-time">${timeAgo(m.created_at)}</div>
      </div>`;
    }).join('');
    el2.scrollTop = el2.scrollHeight;
  }

  async function doSend(partnerId) {
    const input = document.getElementById('chat-input');
    const body  = input.value.trim();
    if (!body) return;
    input.value = '';
    await sendMessage(user.id, partnerId, body);
    await loadMessages(partnerId);
    refreshBadges();
  }

  // Real-time: incoming messages refresh the active conversation
  unsub = subscribeToInbox(user.id, {
    onMessage: async msg => {
      if (msg.from_id === activePartnerId) {
        await loadMessages(activePartnerId);
        await markMessagesRead(user.id, activePartnerId);
      }
      loadConvoList();
      refreshBadges();
    },
  });

  loadConvoList();

  return {
    destroy() { if (unsub) unsub(); }
  };
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
