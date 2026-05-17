// ════════════════════════════════════════════════════════════════════
// BandSync — History Screen
// ════════════════════════════════════════════════════════════════════
// Chronological list of every session the user appears in, grouped by
// date. Each row I host shows all slots; each row I joined as a friend
// shows only my slot (RLS handles the filtering server-side). PB badge
// inline marks rows where my score is my personal best for that song.
// ════════════════════════════════════════════════════════════════════

import { getMyHistory, getMyPersonalBests } from '../services/history.js';

const AVATARS = {
  piano:'🎹', drums:'🥁', guitar:'🎸', trumpet:'🎺',
  violin:'🎻', note:'🎵',  mic:'🎤',    star:'⭐',
};
const avatarEmoji = slug => AVATARS[slug] ?? '🎵';

export function mount(el, ctx, navigate) {
  el.innerHTML = `<div class="history-page"><div class="history-loading">LOADING HISTORY…</div></div>`;
  render(el, ctx).catch(err => {
    console.error('history mount: ', err);
    el.innerHTML = `<div class="history-page"><div class="history-empty">Failed to load: ${esc(err.message)}</div></div>`;
  });
}

async function render(el, ctx) {
  const userId = ctx.user.id;
  const [sessions, bests] = await Promise.all([
    getMyHistory(),
    getMyPersonalBests(userId),
  ]);

  if (sessions.length === 0) {
    el.innerHTML = `
      <div class="history-page">
        <div class="history-empty">
          NO PLAYS YET<br>
          <span class="dim" style="font-size:11px;letter-spacing:1px">
            Head to <a href="play.html" class="history-link">PLAY</a> and finish a song
            — it'll show up here.
          </span>
        </div>
      </div>
    `;
    return;
  }

  const grouped = groupByDate(sessions);

  el.innerHTML = `
    <div class="history-page">
      <div class="history-header">
        <div class="history-title">HISTORY</div>
        <div class="history-meta">
          ${sessions.length} SESSION${sessions.length === 1 ? '' : 'S'}
          &middot;
          ${Object.keys(bests).length} SONG${Object.keys(bests).length === 1 ? '' : 'S'} PLAYED
        </div>
      </div>

      ${grouped.map(group => `
        <div class="history-section-label">${esc(group.label)}</div>
        <div class="history-list">
          ${group.sessions.map(s => sessionCard(s, userId, bests)).join('')}
        </div>
      `).join('')}
    </div>
  `;
}

function sessionCard(session, userId, bests) {
  const time = formatTime(session.started_at);
  const slots = session.slots.slice().sort((a, b) => a.slot - b.slot);
  const isMyHosted = session.host_user_id === userId;

  return `
    <div class="history-card">
      <div class="history-card-head">
        <div class="history-song">${esc(session.song_title)}</div>
        <div class="history-time">${esc(time)}</div>
      </div>
      <div class="history-slots">
        ${slots.map(slot => slotRow(slot, userId, session, bests)).join('')}
      </div>
      ${slots.length < session.player_count && !isMyHosted ? `
        <div class="history-card-foot dim">
          You joined this session via a code — other players' scores aren't shown.
        </div>
      ` : ''}
    </div>
  `;
}

function slotRow(slot, userId, session, bests) {
  const isMe       = slot.user_id === userId;
  const pb         = bests[session.song_file];
  const isMyPB     = isMe && pb && pb.session_id === session.id && pb.score === slot.score;
  const identityClass = slot.identity === 'host'   ? 'identity-host'
                      : slot.identity === 'friend' ? 'identity-friend'
                      : 'identity-guest';

  return `
    <div class="history-slot ${isMe ? 'me' : ''}">
      <div class="hs-tag p${slot.slot}">P${slot.slot}</div>
      <div class="hs-identity">
        <span class="hs-avatar">${slot.identity === 'guest' ? '·' : avatarEmoji('note')}</span>
        <span class="${identityClass}">${esc(slot.display_name)}</span>
        ${isMyPB ? '<span class="pb-badge" title="Personal best">PB</span>' : ''}
      </div>
      <div class="hs-track dim">${esc(slot.track_name || '')}</div>
      <div class="hs-score">${slot.score.toLocaleString()}</div>
      <div class="hs-acc dim">${slot.accuracy != null ? slot.accuracy + '%' : '—'}</div>
      <div class="hs-grade">${esc(slot.grade || '—')}</div>
    </div>
  `;
}

// ── Grouping & formatting ──────────────────────────────────────────

function groupByDate(sessions) {
  const groups = [];
  const today    = startOfDay(new Date());
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);

  let currentKey = null;
  let currentGroup = null;

  for (const s of sessions) {
    const d   = new Date(s.started_at);
    const key = startOfDay(d).getTime();
    if (key !== currentKey) {
      currentKey  = key;
      currentGroup = { label: dateLabel(d, today, yesterday), sessions: [] };
      groups.push(currentGroup);
    }
    currentGroup.sessions.push(s);
  }
  return groups;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function dateLabel(d, today, yesterday) {
  const s = startOfDay(d).getTime();
  if (s === today.getTime())     return 'TODAY';
  if (s === yesterday.getTime()) return 'YESTERDAY';
  // Older: "Mon May 17" style.
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
