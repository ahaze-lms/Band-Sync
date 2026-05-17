import { getFriends, getPendingIncoming, getPendingPlayInvites, respondToPlayInvite } from '../services/social.js';
import { avatarEmoji, accentFor, timeAgo, refreshBadges } from '../app.js';

export function mount(el, ctx, navigate) {
  const { user, profile } = ctx;

  el.innerHTML = `
    <div class="home-wrap">

      <div class="home-hero">
        <div class="home-greeting">
          <span class="home-avatar">${avatarEmoji(profile?.avatar)}</span>
          <div>
            <div class="home-name">${esc(profile?.display_name ?? 'Player')}</div>
            <div class="home-tagline">${esc(profile?.tagline ?? '')}</div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          <a class="btn btn-play" href="play.html" target="_blank">▶ PLAY NOW</a>
          <a href="lab.html" target="_blank" style="font-size:9px;letter-spacing:2px;color:#444;text-decoration:none;text-align:right;transition:color 0.15s" onmouseover="this.style.color='#7F77DD'" onmouseout="this.style.color='#444'">⚗ DEV LAB</a>
        </div>
      </div>

      <div class="home-panels">

        <div class="panel" id="panel-invites" style="display:none">
          <div class="panel-title">PLAY INVITES</div>
          <div id="invites-list"></div>
        </div>

        <div class="panel">
          <div class="panel-title">FRIENDS
            <button class="btn btn-ghost btn-sm" id="btn-go-friends">MANAGE</button>
          </div>
          <div id="friends-list"><div class="dim">Loading...</div></div>
        </div>

        <div class="panel">
          <div class="panel-title">PENDING REQUESTS</div>
          <div id="requests-list"><div class="dim">Loading...</div></div>
        </div>

      </div>
    </div>
  `;

  document.getElementById('btn-go-friends').addEventListener('click', () => navigate('friends'));

  loadAll();

  async function loadAll() {
    try {
      const [friends, incoming, invites] = await Promise.all([
        getFriends(user.id),
        getPendingIncoming(user.id),
        getPendingPlayInvites(user.id),
      ]);
      renderFriends(friends);
      renderRequests(incoming);
      renderInvites(invites);
    } catch (err) {
      console.error('Home: loadAll failed', err);
      const el2 = document.getElementById('friends-list');
      if (el2) el2.innerHTML = `<div class="dim" style="color:#E24B4A">Failed to load: ${esc(err.message)}</div>`;
    }
  }

  function renderFriends(friends) {
    const el2 = document.getElementById('friends-list');
    if (!friends.length) { el2.innerHTML = '<div class="dim">No friends yet — find people in the Friends tab.</div>'; return; }
    el2.innerHTML = friends.map(({ friend: f }) => {
      const color = accentFor(f.accent_color);
      return `<div class="friend-row">
        <span class="friend-avatar" style="color:${color.accent}">${avatarEmoji(f.avatar)}</span>
        <div class="friend-info">
          <span class="friend-name" style="color:${color.accent}">${esc(f.display_name ?? f.username)}</span>
          <span class="dim" style="font-size:10px">${f.username ? '@' + esc(f.username) : ''}</span>
        </div>
        <span class="status-dot ${f.is_online ? 'online' : 'offline'}"></span>
        <button class="btn btn-ghost btn-sm btn-msg" data-id="${f.id}">MSG</button>
      </div>`;
    }).join('');
    el2.querySelectorAll('.btn-msg').forEach(btn => {
      btn.addEventListener('click', () => navigate('inbox', { openWith: btn.dataset.id }));
    });
  }

  function renderRequests(incoming) {
    const el2 = document.getElementById('requests-list');
    if (!incoming.length) { el2.innerHTML = '<div class="dim">No pending requests.</div>'; return; }
    el2.innerHTML = incoming.map(r => `
      <div class="friend-row" id="req-${r.id}">
        <span class="friend-avatar">${avatarEmoji(r.sender?.avatar)}</span>
        <div class="friend-info">
          <span class="friend-name">${esc(r.sender?.display_name ?? r.sender?.username)}</span>
          <span class="dim" style="font-size:10px">${timeAgo(r.created_at)}</span>
        </div>
        <button class="btn btn-primary btn-sm" data-id="${r.id}" data-action="accept">ACCEPT</button>
        <button class="btn btn-ghost btn-sm"   data-id="${r.id}" data-action="decline">DECLINE</button>
      </div>
    `).join('');
    el2.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { id, action } = btn.dataset;
        const status = action === 'accept' ? 'accepted' : 'declined';
        try {
          const { respondToFriendRequest } = await import('../services/social.js');
          await respondToFriendRequest(id, status);
          document.getElementById(`req-${id}`)?.remove();
          if (action === 'accept') loadAll();
          refreshBadges();
        } catch {}
      });
    });
  }

  function renderInvites(invites) {
    const panel = document.getElementById('panel-invites');
    const list  = document.getElementById('invites-list');
    if (!invites.length) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    list.innerHTML = invites.map(inv => `
      <div class="friend-row" id="inv-${inv.id}">
        <span class="friend-avatar">${avatarEmoji(inv.sender?.avatar)}</span>
        <div class="friend-info">
          <span class="friend-name">${esc(inv.sender?.display_name ?? inv.sender?.username)}</span>
          <span class="dim" style="font-size:10px">wants to play!</span>
        </div>
        <button class="btn btn-primary btn-sm" data-id="${inv.id}" data-action="accepted">ACCEPT</button>
        <button class="btn btn-ghost btn-sm"   data-id="${inv.id}" data-action="declined">DECLINE</button>
      </div>
    `).join('');
    list.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await respondToPlayInvite(btn.dataset.id, btn.dataset.action);
        document.getElementById(`inv-${btn.dataset.id}`)?.remove();
        refreshBadges();
      });
    });
  }
}

function esc(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
