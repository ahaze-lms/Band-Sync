import { getFriends, getPendingIncoming, getPendingOutgoing,
         sendFriendRequest, respondToFriendRequest, cancelFriendRequest,
         removeFriend, sendPlayInvite } from '../services/social.js';
import { searchProfiles } from '../services/profile.js';
import { avatarEmoji, accentFor, refreshBadges } from '../app.js';

export function mount(el, ctx, navigate) {
  const { user } = ctx;

  el.innerHTML = `
    <div class="friends-wrap">

      <div class="panel">
        <div class="panel-title">FIND PLAYERS</div>
        <div class="search-row">
          <input class="input" type="text" id="search-input" placeholder="Search by username or name...">
        </div>
        <div id="search-results"></div>
      </div>

      <div class="panel">
        <div class="panel-title">INCOMING REQUESTS <span class="badge" id="badge-incoming"></span></div>
        <div id="incoming-list"><div class="dim">Loading...</div></div>
      </div>

      <div class="panel">
        <div class="panel-title">FRIENDS</div>
        <div id="friends-list"><div class="dim">Loading...</div></div>
      </div>

      <div class="panel">
        <div class="panel-title">SENT REQUESTS</div>
        <div id="outgoing-list"><div class="dim">Loading...</div></div>
      </div>

    </div>
  `;

  // ── Search ────────────────────────────────────────────────────
  let searchTimer;
  document.getElementById('search-input').addEventListener('input', e => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    if (!q) { document.getElementById('search-results').innerHTML = ''; return; }
    searchTimer = setTimeout(() => doSearch(q), 350);
  });

  async function doSearch(q) {
    const resultsEl = document.getElementById('search-results');
    resultsEl.innerHTML = '<div class="dim">Searching...</div>';
    const [results, friends, outgoing] = await Promise.all([
      searchProfiles(q),
      getFriends(user.id),
      getPendingOutgoing(user.id),
    ]);
    const friendIds   = new Set(friends.map(f => f.friend.id));
    const outgoingIds = new Map(outgoing.map(r => [r.receiver.id, r.id]));

    const filtered = results.filter(p => p.id !== user.id);
    if (!filtered.length) { resultsEl.innerHTML = '<div class="dim">No players found.</div>'; return; }

    resultsEl.innerHTML = filtered.map(p => {
      const color   = accentFor(p.accent_color);
      const isFriend  = friendIds.has(p.id);
      const reqId     = outgoingIds.get(p.id);
      let actionBtn;
      if (isFriend)  actionBtn = `<span class="dim" style="font-size:10px">FRIENDS</span>`;
      else if (reqId) actionBtn = `<button class="btn btn-ghost btn-sm btn-cancel-req" data-req="${reqId}">CANCEL</button>`;
      else           actionBtn = `<button class="btn btn-primary btn-sm btn-add" data-id="${p.id}">+ ADD</button>`;

      return `<div class="friend-row">
        <span class="friend-avatar" style="color:${color.accent}">${avatarEmoji(p.avatar)}</span>
        <div class="friend-info">
          <span class="friend-name" style="color:${color.accent}">${esc(p.display_name ?? p.username)}</span>
          <span class="dim" style="font-size:10px">@${esc(p.username)}</span>
        </div>
        <span class="status-dot ${p.is_online ? 'online' : 'offline'}"></span>
        ${actionBtn}
      </div>`;
    }).join('');

    resultsEl.querySelectorAll('.btn-add').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '...';
        try { await sendFriendRequest(user.id, btn.dataset.id); btn.textContent = 'SENT'; }
        catch { btn.disabled = false; btn.textContent = '+ ADD'; }
      });
    });
    resultsEl.querySelectorAll('.btn-cancel-req').forEach(btn => {
      btn.addEventListener('click', async () => {
        await cancelFriendRequest(btn.dataset.req);
        doSearch(document.getElementById('search-input').value.trim());
      });
    });
  }

  // ── Load all lists ────────────────────────────────────────────
  async function loadAll() {
    try {
      const [friends, incoming, outgoing] = await Promise.all([
        getFriends(user.id),
        getPendingIncoming(user.id),
        getPendingOutgoing(user.id),
      ]);
      renderFriends(friends);
      renderIncoming(incoming);
      renderOutgoing(outgoing);
    } catch (err) {
      console.error('Friends: loadAll failed', err);
      const el2 = document.getElementById('friends-list');
      if (el2) el2.innerHTML = `<div class="dim" style="color:#E24B4A">Failed to load: ${esc(err.message)}</div>`;
    }
  }

  function renderFriends(friends) {
    const el2 = document.getElementById('friends-list');
    if (!friends.length) { el2.innerHTML = '<div class="dim">No friends yet.</div>'; return; }
    el2.innerHTML = friends.map(({ requestId, friend: f }) => {
      const color = accentFor(f.accent_color);
      return `<div class="friend-row" id="fr-${requestId}">
        <span class="friend-avatar" style="color:${color.accent}">${avatarEmoji(f.avatar)}</span>
        <div class="friend-info">
          <span class="friend-name" style="color:${color.accent}">${esc(f.display_name ?? f.username)}</span>
          <span class="dim" style="font-size:10px">@${esc(f.username)}</span>
        </div>
        <span class="status-dot ${f.is_online ? 'online' : 'offline'}"></span>
        <button class="btn btn-ghost btn-sm btn-msg" data-id="${f.id}">MSG</button>
        <button class="btn btn-ghost btn-sm btn-invite" data-id="${f.id}">INVITE</button>
        <button class="btn btn-ghost btn-sm btn-remove" data-req="${requestId}">✕</button>
      </div>`;
    }).join('');

    el2.querySelectorAll('.btn-msg').forEach(b =>
      b.addEventListener('click', () => navigate('inbox', { openWith: b.dataset.id })));

    el2.querySelectorAll('.btn-invite').forEach(b =>
      b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = '...';
        try { await sendPlayInvite(user.id, b.dataset.id); b.textContent = 'SENT!'; }
        catch { b.disabled = false; b.textContent = 'INVITE'; }
        setTimeout(() => { if (!b.isConnected) return; b.disabled = false; b.textContent = 'INVITE'; }, 3000);
      }));

    el2.querySelectorAll('.btn-remove').forEach(b =>
      b.addEventListener('click', async () => {
        if (!confirm('Remove this friend?')) return;
        await removeFriend(b.dataset.req);
        document.getElementById(`fr-${b.dataset.req}`)?.remove();
      }));
  }

  function renderIncoming(incoming) {
    const badge = document.getElementById('badge-incoming');
    badge.textContent = incoming.length || '';
    badge.style.display = incoming.length ? '' : 'none';
    const el2 = document.getElementById('incoming-list');
    if (!incoming.length) { el2.innerHTML = '<div class="dim">No pending requests.</div>'; return; }
    el2.innerHTML = incoming.map(r => `
      <div class="friend-row" id="inc-${r.id}">
        <span class="friend-avatar">${avatarEmoji(r.sender?.avatar)}</span>
        <div class="friend-info">
          <span class="friend-name">${esc(r.sender?.display_name ?? r.sender?.username)}</span>
          <span class="dim" style="font-size:10px">@${esc(r.sender?.username)}</span>
        </div>
        <button class="btn btn-primary btn-sm btn-accept" data-id="${r.id}">ACCEPT</button>
        <button class="btn btn-ghost btn-sm btn-decline" data-id="${r.id}">DECLINE</button>
      </div>
    `).join('');

    el2.querySelectorAll('.btn-accept, .btn-decline').forEach(btn => {
      btn.addEventListener('click', async () => {
        const status = btn.classList.contains('btn-accept') ? 'accepted' : 'declined';
        await respondToFriendRequest(btn.dataset.id, status);
        document.getElementById(`inc-${btn.dataset.id}`)?.remove();
        refreshBadges();
        if (status === 'accepted') loadAll();
      });
    });
  }

  function renderOutgoing(outgoing) {
    const el2 = document.getElementById('outgoing-list');
    if (!outgoing.length) { el2.innerHTML = '<div class="dim">No sent requests.</div>'; return; }
    el2.innerHTML = outgoing.map(r => `
      <div class="friend-row" id="out-${r.id}">
        <span class="friend-avatar">${avatarEmoji(r.receiver?.avatar)}</span>
        <div class="friend-info">
          <span class="friend-name">${esc(r.receiver?.display_name ?? r.receiver?.username)}</span>
          <span class="dim" style="font-size:10px">@${esc(r.receiver?.username)}</span>
        </div>
        <span class="dim" style="font-size:10px">pending</span>
        <button class="btn btn-ghost btn-sm btn-cancel" data-id="${r.id}">CANCEL</button>
      </div>
    `).join('');
    el2.querySelectorAll('.btn-cancel').forEach(btn =>
      btn.addEventListener('click', async () => {
        await cancelFriendRequest(btn.dataset.id);
        document.getElementById(`out-${btn.dataset.id}`)?.remove();
      }));
  }

  loadAll();
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
