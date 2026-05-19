// ════════════════════════════════════════════════════════════════════
// BandSync — play.html entry point
// ════════════════════════════════════════════════════════════════════
// Mini-SPA with 4 states: song-select → setup → game → results.
// Phase 1 ✓ : auth gate + song-select pulling from songs/manifest.json.
// Phase 2 ✓ : setup screen — player count + per-player instrument /
//             device / track pickers. Designed for 1-4 players; UI
//             currently enables 1-2.
// Phase 3 ✓ : gameplay using js/core/gameplay-engine.js. Per-player
//             canvases, live score cards, feedback overlays, song timer,
//             pause / restart, end-of-song → results.
// Phase 3+4 ✓ : per-slot IDENTITY (Me / Friend via code / Guest).
//               Identity persists across song-select ↔ setup ↔ game ↔
//               results loops within a play.html page session — only
//               trackIndex resets on song change. Claim modal handles
//               6-digit device-code entry. See DESIGN.md §26.
// Phase 5 (next): score persistence to play_sessions + play_session_slots.
// ════════════════════════════════════════════════════════════════════

import { getUser }            from './services/auth.js';
import { getProfile }         from './services/profile.js';
import { claimCode }          from './services/device-codes.js';
import * as sessionAttachments from './services/session-attachments.js';
import * as lobbies            from './services/lobbies.js';
import { getFriends, sendPlayInvite } from './services/social.js';
import { saveSession }        from './services/play-sessions.js';
import { getMyPersonalBests } from './services/history.js';
import { initMIDI, getInputs, onStateChange } from './core/midi.js';
import { parseMIDIFile }      from './core/midi-parser.js';
import { loadOffset }         from './core/calibration.js';
import { createGameplay }     from './core/gameplay-engine.js';
import { PLAYER_COLORS,
         PIANO_NOTE_MIN, PIANO_NOTE_MAX,
         DEFAULT_SPEED_LEVEL, DEFAULT_HIT_WINDOW_LEVEL,
         FALL_TIMES_MS, HIT_WINDOWS,
         DEVICE_ID_KEYBOARD, DEVICE_LABEL_KEYBOARD } from './config.js';

// Avatars are also defined in js/app.js (index.html SPA shell) — duplicated
// here so play.html stays decoupled from the SPA shell module.
const AVATARS = {
  piano:'🎹', drums:'🥁', guitar:'🎸', trumpet:'🎺',
  violin:'🎻', note:'🎵',  mic:'🎤',    star:'⭐',
};
const avatarEmoji = slug => AVATARS[slug] ?? '🎵';

const stateEl      = document.getElementById('state');
const stateLabelEl = document.getElementById('state-label');

const MAX_PLAYERS     = 4;
const ENABLED_PLAYERS = 4;   // 3-4 layouts live; gameplay needs that many devices though

const ctx = {
  user:        null,
  profile:     null,  // host's profile
  manifest:    null,
  song:        null,  // selected song from manifest
  setup:       null,  // per-song setup state (player count, choices, identities)
  midi:        null,  // { ok, reason?, inputCount }
  activeGame:    null,  // current gameplay engine instance, or null
  gameStarted:   false, // false while in warm-up (engine alive but song not started)
  gameTimer:     null,  // requestAnimationFrame id for the song timer
  gameStartedAt: null,  // ISO timestamp when current run began (refreshed on restart)
  lastResults:   null,  // [{ identity, stats, ... }, ...] for results screen
  saveStatus:    null,  // { state: 'saving'|'saved'|'failed', sessionId?, error? }
  bests:         null,  // host's personal bests: { [song_file]: { score, grade, ... } }
  oldBests:      null,  // snapshot of bests at game start — for NEW PB detection on results
  attachments:   null,  // { 'p2': { token, userId, displayName, avatar, accentColor }, ... }
  pairedFriends: null,  // [{ token, user_id, display_name, ... }] — friends ever paired with this device, for dropdown
  mode:          'local',  // 'local' (default) | 'remote' — controls what song-select click does
  lobby:         null,     // { id, lobby, participants, tracks, unsubscribe, gameLaunched } when in lobby
  clockOffset:   null,     // ms: Date.now() - serverTime, measured on lobby entry for Phase 5
  gameChannel:   null,     // { broadcast, unsubscribe } during a remote game (Phase 6)
  remoteScores:  null,     // Map<userId, scorePayload> during a remote game (Phase 6)
};

let setupTeardown = null;

// ── BOOT ───────────────────────────────────────────────────────────

init().catch(err => {
  console.error('play.js: startup error', err);
  renderError('STARTUP ERROR', err.message);
});

async function init() {
  const user = await getUser();
  if (!user) { location.href = 'index.html'; return; }
  ctx.user = user;

  // Load host profile (for the "Me" identity display).
  try { ctx.profile = await getProfile(user.id); }
  catch (err) { console.warn('play.js: getProfile failed, using fallbacks', err); }

  // Load host personal bests (for setup display + NEW PB badge on results).
  // Best-effort; an empty/failed fetch just means no PB displays.
  try { ctx.bests = await getMyPersonalBests(user.id); }
  catch (err) { console.warn('play.js: getMyPersonalBests failed', err); ctx.bests = {}; }

  // Rehydrate any durable friend-attachment tokens stored in localStorage
  // from previous sessions (DESIGN.md §26 Evolution v2). Slots default
  // to those rehydrated identities until the host explicitly detaches.
  try {
    const { rehydrated } = await sessionAttachments.reattachAll(user.id);
    ctx.attachments = rehydrated;
  } catch (err) {
    console.warn('play.js: reattachAll failed', err);
    ctx.attachments = {};
  }

  // List all friends ever paired with this device (for one-tap reattach
  // in the identity dropdown). Doesn't depend on localStorage — sourced
  // from session_attachments directly.
  try {
    ctx.pairedFriends = await sessionAttachments.listPaired(user.id);
  } catch (err) {
    console.warn('play.js: listPaired failed', err);
    ctx.pairedFriends = [];
  }

  // Library manifest.
  try {
    const res = await fetch('songs/manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ctx.manifest = await res.json();
  } catch (err) {
    renderError('COULD NOT LOAD LIBRARY',
      `Failed to fetch songs/manifest.json — ${err.message}.\n` +
      `If you just pulled, regenerate with:  node tools/build-songs.mjs`);
    return;
  }

  const invite = new URLSearchParams(location.search).get('invite');
  if (invite) ctx.inviteId = invite;

  // Remote-lobby join via shareable URL (?lobby=<id>). Bypasses
  // song-select — the lobby already knows the song.
  const lobbyParam = new URLSearchParams(location.search).get('lobby');
  if (lobbyParam) {
    try {
      const slot = await lobbies.join(lobbyParam);
      if (slot != null) {
        ctx.lobby = { id: lobbyParam };
        renderLobby();
        return;
      }
      renderError('CANNOT JOIN LOBBY',
        'This lobby is full, closed, or no longer exists.');
      return;
    } catch (err) {
      renderError('CANNOT JOIN LOBBY', err.message);
      return;
    }
  }

  renderSongSelect();
}

// ── IDENTITY HELPERS ───────────────────────────────────────────────

function makeHostIdentity() {
  const p = ctx.profile;
  return {
    kind:        'host',
    userId:      ctx.user.id,
    displayName: p?.display_name || p?.username || 'Me',
    avatar:      p?.avatar       || 'piano',
    accentColor: p?.accent_color || 'purple',
  };
}

function makeGuestIdentity(slotIdx) {
  return {
    kind:        'guest',
    userId:      null,
    displayName: `Guest ${slotIdx + 1}`,
    avatar:      'note',
    accentColor: null,
  };
}

function makeFriendIdentity(claim) {
  return {
    kind:        'friend',
    userId:      claim.user_id,
    displayName: claim.display_name || 'Friend',
    avatar:      claim.avatar       || 'note',
    accentColor: claim.accent_color || null,
  };
}

function slotKey(slotIdx) { return `p${slotIdx + 1}`; }

function persistAttachmentForSlot(slotIdx, claim) {
  if (!claim?.session_token) return;
  const key = slotKey(slotIdx);
  const stored = {
    token:       claim.session_token,
    userId:      claim.user_id,
    displayName: claim.display_name,
    avatar:      claim.avatar,
    accentColor: claim.accent_color,
  };
  sessionAttachments.save(ctx.user.id, key, stored);
  if (!ctx.attachments) ctx.attachments = {};
  ctx.attachments[key] = stored;
}

function forgetAttachmentForSlot(slotIdx) {
  const key = slotKey(slotIdx);
  sessionAttachments.remove(ctx.user.id, key);
  if (ctx.attachments) delete ctx.attachments[key];
}

// Add / refresh a friend in the paired-friends cache after a successful
// claim, so they appear in other slots' dropdowns immediately without
// waiting for a server round-trip.
function rememberPairedFriend(claim) {
  if (!claim?.session_token || claim.user_id === ctx.user?.id) return;
  if (!ctx.pairedFriends) ctx.pairedFriends = [];
  const entry = {
    token:        claim.session_token,
    user_id:      claim.user_id,
    display_name: claim.display_name,
    avatar:       claim.avatar,
    accent_color: claim.accent_color,
    last_used_at: new Date().toISOString(),
    expires_at:   new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  const existingIdx = ctx.pairedFriends.findIndex(f => f.user_id === claim.user_id);
  if (existingIdx >= 0) ctx.pairedFriends[existingIdx] = entry;
  else ctx.pairedFriends.unshift(entry);
}

// Slots default: P1 is Me. P2+ uses a rehydrated friend attachment if
// one's in localStorage for that slot, else Guest.
function defaultSlot(idx, song) {
  return {
    identity:   defaultIdentity(idx),
    instrument: 'piano',
    deviceId:   null,
    trackIndex: Math.min(idx, song.tracks.length - 1),
  };
}

function defaultIdentity(idx) {
  if (idx === 0) return makeHostIdentity();
  const attached = ctx.attachments?.[`p${idx + 1}`];
  if (attached) {
    return {
      kind:        'friend',
      userId:      attached.userId,
      displayName: attached.displayName || 'Friend',
      avatar:      attached.avatar      || 'note',
      accentColor: attached.accentColor || null,
    };
  }
  return makeGuestIdentity(idx);
}

function defaultSetup(song) {
  return {
    songFile:        song.file,
    playerCount:     Math.min(ENABLED_PLAYERS, Math.max(1, song.tracks.length)),
    speedLevel:      DEFAULT_SPEED_LEVEL,
    hitWindowLevel:  DEFAULT_HIT_WINDOW_LEVEL,
    players:         Array.from({ length: MAX_PLAYERS }, (_, i) => defaultSlot(i, song)),
  };
}

// Apply a new song selection. If we already have a setup (mid play
// session), preserve playerCount + per-slot identity/instrument/device
// and only reset trackIndex (track is the song-specific bit).
function applySong(song) {
  ctx.song = song;
  if (!ctx.setup) {
    ctx.setup = defaultSetup(song);
    return;
  }
  ctx.setup.songFile = song.file;
  ctx.setup.players  = ctx.setup.players.map((p, i) => ({
    ...p,
    trackIndex: Math.min(i, song.tracks.length - 1),
  }));
}

// Only one slot may be "Me" at a time. When a slot is promoted to host,
// any other host slot demotes to a guest with a sensible default name.
function enforceSingleHost(promotedIdx) {
  ctx.setup.players.forEach((p, i) => {
    if (i !== promotedIdx && p.identity.kind === 'host') {
      p.identity = makeGuestIdentity(i);
    }
  });
}

// ── STATE: SONG SELECT ─────────────────────────────────────────────

function renderSongSelect() {
  leaveCurrentState();
  setStateLabel('SONG SELECT');

  const songs = ctx.manifest.songs ?? [];
  if (!songs.length) {
    renderError('NO SONGS', 'The library is empty. Run: node tools/build-songs.mjs');
    return;
  }

  stateEl.innerHTML = `
    <div class="state-inner">
      <div class="mode-toggle">
        <button class="mode-opt ${ctx.mode === 'local' ? 'selected' : ''}" data-mode="local">
          <span class="mode-opt-title">SOLO / COUCH</span>
          <span class="mode-opt-sub">Everyone on this device</span>
        </button>
        <button class="mode-opt ${ctx.mode === 'remote' ? 'selected' : ''}" data-mode="remote">
          <span class="mode-opt-title">REMOTE LOBBY</span>
          <span class="mode-opt-sub">Friends on their own devices</span>
        </button>
      </div>
      <div class="section-label">LIBRARY — ${songs.length} SONGS</div>
      <div class="song-grid">
        ${songs.map(songCard).join('')}
      </div>
    </div>
  `;

  stateEl.querySelectorAll('[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      ctx.mode = btn.dataset.mode;
      renderSongSelect();
    });
  });

  stateEl.querySelectorAll('[data-song-file]').forEach(el => {
    el.addEventListener('click', () => {
      const file = el.dataset.songFile;
      const song = songs.find(s => s.file === file);
      if (ctx.mode === 'remote') {
        createRemoteLobby(song);
      } else {
        applySong(song);
        renderSetup();
      }
    });
  });
}

async function createRemoteLobby(song) {
  try {
    const lobbyId = await lobbies.create(song.file, song.title, {
      speedLevel:      ctx.setup?.speedLevel      ?? DEFAULT_SPEED_LEVEL,
      hitWindowLevel:  ctx.setup?.hitWindowLevel  ?? DEFAULT_HIT_WINDOW_LEVEL,
    });
    ctx.lobby = { id: lobbyId };
    // Update URL so reload reattaches + the bar is the share link.
    const url = new URL(location.href);
    url.searchParams.set('lobby', lobbyId);
    history.replaceState({}, '', url.toString());
    renderLobby();
  } catch (err) {
    console.error('createRemoteLobby failed', err);
    renderError('COULD NOT CREATE LOBBY', err.message || String(err));
  }
}

function songCard(song) {
  const trackCount = song.tracks.length;
  const duet       = trackCount > 1 ? '<span class="badge-duet">DUET</span>' : '';
  const trackList  = song.tracks.map(t => t.name).join(' + ');
  const mm         = Math.floor(song.durationSec / 60);
  const ss         = String(Math.round(song.durationSec % 60)).padStart(2, '0');

  return `
    <button class="song-card" data-song-file="${esc(song.file)}">
      <div class="song-title">${esc(song.title)}${duet}</div>
      <div class="song-tracks">${esc(trackList)}</div>
      <div class="song-meta">
        <span class="pill">${song.bpm} BPM</span>
        <span class="pill">${mm}:${ss}</span>
        <span class="pill">${trackCount} TRACK${trackCount === 1 ? '' : 'S'}</span>
      </div>
    </button>
  `;
}

// ── STATE: SETUP ───────────────────────────────────────────────────

async function renderSetup() {
  leaveCurrentState();
  setStateLabel('SETUP');

  ctx.midi = await initMIDI();
  if (!ctx.setup) ctx.setup = defaultSetup(ctx.song);

  const inputs = getInputs();
  for (const p of ctx.setup.players) {
    if (!p.deviceId && inputs.length) p.deviceId = inputs[0].id;
  }

  paintSetup();

  onStateChange(() => {
    if (stateLabelEl.textContent === 'SETUP') paintSetup();
  });
  setupTeardown = () => {};
}

function paintSetup() {
  const song    = ctx.song;
  const setup   = ctx.setup;
  const inputs  = getInputs();
  const tracks  = song.tracks;
  const mm      = Math.floor(song.durationSec / 60);
  const ss      = String(Math.round(song.durationSec % 60)).padStart(2, '0');

  stateEl.innerHTML = `
    <div class="state-inner">
      <div class="setup-song">
        <div class="setup-song-title">${esc(song.title)}</div>
        <div class="setup-song-meta">
          ${song.bpm} BPM &middot; ${mm}:${ss} &middot;
          ${tracks.length} TRACK${tracks.length === 1 ? '' : 'S'}
          (${tracks.map(t => esc(t.name)).join(', ')})
        </div>
        ${renderSetupPB(song)}
      </div>

      <div class="setup-section">
        <div class="setup-section-label">DIFFICULTY &amp; SPEED</div>
        <div class="setup-difficulty">
          <div class="field">
            <label class="field-label">SPEED — how fast notes fall</label>
            <select data-field="speed">
              ${FALL_TIMES_MS.map((ms, i) => {
                const level = i + 1;
                const s = (ms / 1000).toFixed(1);
                return `<option value="${level}" ${setup.speedLevel === level ? 'selected' : ''}>Level ${level} — ${s}s fall</option>`;
              }).join('')}
            </select>
          </div>
          <div class="field">
            <label class="field-label">DIFFICULTY — timing tolerance</label>
            <select data-field="difficulty">
              ${HIT_WINDOWS.map((hw, i) => {
                const level = i + 1;
                return `<option value="${level}" ${setup.hitWindowLevel === level ? 'selected' : ''}>${level} — ${hw.name} (±${hw.perfect}ms perfect)</option>`;
              }).join('')}
            </select>
          </div>
        </div>
      </div>

      <div class="setup-section">
        <div class="setup-section-label">PLAYERS</div>
        <div class="player-count">
          ${[1, 2, 3, 4].map(n => `
            <button class="count-btn ${setup.playerCount === n ? 'active' : ''}"
                    data-count="${n}"
                    ${n > ENABLED_PLAYERS ? 'disabled' : ''}>${n}</button>
          `).join('')}
          ${ENABLED_PLAYERS < MAX_PLAYERS
            ? `<div class="count-btn-note">${ENABLED_PLAYERS}+ player support coming</div>`
            : ''}
        </div>
      </div>

      <div class="setup-section">
        <div class="setup-section-label">ASSIGN</div>
        <div class="player-rows">
          ${setup.players.slice(0, setup.playerCount)
            .map((p, i) => playerRow(i, p, inputs, tracks))
            .join('')}
        </div>
      </div>

      <div class="midi-status ${midiStatusClass()}">${midiStatusText()}</div>

      <div class="actions">
        <button class="btn-ghost" data-action="back">← BACK TO SONGS</button>
        <button class="btn-primary" data-action="start">▶ START</button>
      </div>
    </div>
  `;

  // Player count buttons
  stateEl.querySelectorAll('[data-count]').forEach(el => {
    el.addEventListener('click', () => {
      const n = Number(el.dataset.count);
      if (n > ENABLED_PLAYERS) return;
      setup.playerCount = n;
      paintSetup();
    });
  });

  // Per-row selectors (non-identity fields)
  stateEl.querySelectorAll('[data-field]').forEach(el => {
    el.addEventListener('change', () => {
      const i = Number(el.dataset.player);
      const field = el.dataset.field;
      const p = setup.players[i];

      // Session-level fields (not per-player) — no row to update.
      if (field === 'speed')      { setup.speedLevel     = Number(el.value); return; }
      if (field === 'difficulty') { setup.hitWindowLevel = Number(el.value); return; }

      if (field === 'instrument') p.instrument = el.value;
      if (field === 'device') {
        p.deviceId = el.value || null;
        // Only one slot can own the Computer Keyboard — demote any other.
        if (p.deviceId === DEVICE_ID_KEYBOARD) {
          let changed = false;
          setup.players.forEach((other, oi) => {
            if (oi !== i && other.deviceId === DEVICE_ID_KEYBOARD) {
              other.deviceId = null;
              changed = true;
            }
          });
          if (changed) paintSetup();
        }
      }
      if (field === 'track')      p.trackIndex = Number(el.value);

      if (field === 'guest-name') {
        // Commit on blur. Empty value reverts to default — no destructive
        // surprise if the user clears the input.
        const v = el.value.trim();
        const name = v || `Guest ${i + 1}`;
        if (!v) el.value = name;
        if (p.identity.kind === 'guest') p.identity.displayName = name;
        return;
      }

      if (field === 'identity') {
        // Re-selecting the current kind from the mini-switcher is a no-op
        // — guest's edited name would otherwise reset.
        if (el.value === p.identity.kind) return;
        handleIdentityChange(i, el.value);
        return;   // handleIdentityChange repaints
      }
    });
  });

  // Detach button on attached friend
  stateEl.querySelectorAll('[data-action="identity-detach"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.player);
      setup.players[i].identity = makeGuestIdentity(i);
      forgetAttachmentForSlot(i);
      paintSetup();
    });
  });

  // Bottom actions
  stateEl.querySelector('[data-action="back"]').addEventListener('click', renderSongSelect);
  stateEl.querySelector('[data-action="start"]').addEventListener('click', renderGame);
}

function handleIdentityChange(slotIdx, value) {
  const setup = ctx.setup;
  const p     = setup.players[slotIdx];

  if (value === 'host') {
    p.identity = makeHostIdentity();
    enforceSingleHost(slotIdx);
    paintSetup();
    return;
  }
  if (value === 'guest') {
    p.identity = makeGuestIdentity(slotIdx);
    paintSetup();
    return;
  }
  if (value.startsWith('paired:')) {
    attachPairedFriend(slotIdx, value.slice('paired:'.length));
    return;
  }
  if (value === 'claim') {
    // Don't apply yet — open modal. If they cancel we need the previous
    // identity to remain, so re-paint *before* the modal opens (resets
    // the dropdown to whatever p.identity was) and then overlay the modal.
    paintSetup();
    showClaimModal({
      slotIdx,
      onClaimed: claim => {
        if (claim.user_id === ctx.user.id) {
          // Friend code happens to be the host's — treat as Me.
          p.identity = makeHostIdentity();
          enforceSingleHost(slotIdx);
        } else {
          p.identity = makeFriendIdentity(claim);
          persistAttachmentForSlot(slotIdx, claim);
          rememberPairedFriend(claim);
        }
        paintSetup();
      },
    });
  }
}

// One-tap reattach for a friend who's previously paired with this
// device. Validates the cached token via attach_session — catches the
// case where the friend revoked it since we last loaded the list — and
// falls back to dropping the dead entry from the cache.
async function attachPairedFriend(slotIdx, friendUserId) {
  const setup  = ctx.setup;
  const p      = setup.players[slotIdx];
  const paired = ctx.pairedFriends?.find(f => f.user_id === friendUserId);
  if (!paired) { paintSetup(); return; }

  try {
    const profile = await sessionAttachments.attach(paired.token);
    if (!profile) {
      // Token died server-side (revoked / expired). Drop from cache + repaint.
      ctx.pairedFriends = ctx.pairedFriends.filter(f => f.token !== paired.token);
      paintSetup();
      return;
    }
    const claim = {
      user_id:       profile.user_id,
      display_name:  profile.display_name,
      avatar:        profile.avatar,
      accent_color:  profile.accent_color,
      session_token: paired.token,
    };
    p.identity = makeFriendIdentity(claim);
    persistAttachmentForSlot(slotIdx, claim);
    paintSetup();
  } catch (err) {
    console.warn('attachPairedFriend failed', err);
    paintSetup();
  }
}

function playerRow(i, slot, inputs, tracks) {
  const tag = `P${i + 1}`;
  return `
    <div class="player-row p${i + 1}">
      <div class="player-tag">${tag}</div>

      <div class="field">
        <label class="field-label">IDENTITY</label>
        ${identityCell(i, slot)}
      </div>

      <div class="field">
        <label class="field-label">INSTRUMENT</label>
        <select data-player="${i}" data-field="instrument">
          <option value="piano" ${slot.instrument === 'piano' ? 'selected' : ''}>Piano</option>
          <option value="drums" ${slot.instrument === 'drums' ? 'selected' : ''}>Drums</option>
        </select>
      </div>

      <div class="field">
        <label class="field-label">MIDI DEVICE</label>
        <select data-player="${i}" data-field="device">
          <option value="">(none)</option>
          <option value="${esc(DEVICE_ID_KEYBOARD)}" ${slot.deviceId === DEVICE_ID_KEYBOARD ? 'selected' : ''}>
            ⌨ ${esc(DEVICE_LABEL_KEYBOARD)}
          </option>
          ${inputs.map(d => `
            <option value="${esc(d.id)}" ${slot.deviceId === d.id ? 'selected' : ''}>
              ${esc(d.name)}
            </option>`).join('')}
        </select>
      </div>

      <div class="field">
        <label class="field-label">TRACK</label>
        <select data-player="${i}" data-field="track">
          ${tracks.map((t, ti) => `
            <option value="${ti}" ${slot.trackIndex === ti ? 'selected' : ''}>${esc(t.name)}</option>
          `).join('')}
        </select>
      </div>
    </div>
  `;
}

function identityCell(slotIdx, slot) {
  // Attached friend → show inline panel with name + detach.
  if (slot.identity.kind === 'friend') {
    return `
      <div class="identity-attached">
        <span class="ia-avatar">${avatarEmoji(slot.identity.avatar)}</span>
        <span class="ia-name">${esc(slot.identity.displayName)}</span>
        <button class="ia-detach" data-player="${slotIdx}" data-action="identity-detach" title="Detach">✕</button>
      </div>
    `;
  }

  const meLabel = `Me — ${esc(ctx.profile?.display_name || ctx.profile?.username || 'You')}`;
  const pairedOpts = pairedFriendOptions(slot);

  // Guest → editable name input + compact kind-switcher. Default name
  // stays a valid value; editing is purely optional.
  if (slot.identity.kind === 'guest') {
    return `
      <div class="identity-guest-cell">
        <input type="text"
               class="identity-name-input"
               data-player="${slotIdx}" data-field="guest-name"
               value="${esc(slot.identity.displayName)}"
               placeholder="Guest ${slotIdx + 1}"
               maxlength="24"
               aria-label="Guest name">
        <select class="identity-kind-mini" data-player="${slotIdx}" data-field="identity"
                title="Change identity">
          <option value="guest" selected>Guest</option>
          <option value="host">${meLabel}</option>
          ${pairedOpts}
          <option value="claim">Join with code…</option>
        </select>
      </div>
    `;
  }

  // Host → single dropdown.
  return `
    <select data-player="${slotIdx}" data-field="identity">
      <option value="host" selected>${meLabel}</option>
      ${pairedOpts}
      <option value="claim">Join with code…</option>
      <option value="guest">Guest ${slotIdx + 1}</option>
    </select>
  `;
}

// Render <option> elements for previously-paired friends. Skips anyone
// who's the current host (since "Me" already covers them).
function pairedFriendOptions(_slot) {
  const friends = ctx.pairedFriends ?? [];
  if (!friends.length) return '';
  return friends
    .filter(f => f.user_id !== ctx.user?.id)
    .map(f => `<option value="paired:${esc(f.user_id)}">${esc(f.display_name || 'Friend')}</option>`)
    .join('');
}

// ── CLAIM MODAL ────────────────────────────────────────────────────

function showClaimModal({ slotIdx, onClaimed }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal-card">
      <div class="modal-title">P${slotIdx + 1} — JOIN WITH CODE</div>
      <div class="modal-desc">
        Have your friend tap <strong>GENERATE NEW CODE</strong> in their
        BandSync profile, then read you the 6 digits. Codes expire after
        10 minutes and can only be used once.
      </div>
      <div class="code-input-row">
        ${Array.from({ length: 6 }, (_, i) =>
          `<input class="code-input" data-i="${i}" type="text" inputmode="numeric" maxlength="1" autocomplete="off">`).join('')}
      </div>
      <div class="modal-error" data-error></div>
      <div class="modal-actions">
        <button class="btn-ghost"   data-action="cancel">CANCEL</button>
        <button class="btn-primary" data-action="submit">JOIN</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const inputs    = [...backdrop.querySelectorAll('.code-input')];
  const errEl     = backdrop.querySelector('[data-error]');
  const submitBtn = backdrop.querySelector('[data-action="submit"]');
  const cancelBtn = backdrop.querySelector('[data-action="cancel"]');

  inputs[0].focus();

  inputs.forEach((input, i) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 1);
      if (input.value && i < inputs.length - 1) inputs[i + 1].focus();
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !input.value && i > 0) inputs[i - 1].focus();
      if (e.key === 'Enter') submit();
    });
    input.addEventListener('paste', e => {
      e.preventDefault();
      const data = (e.clipboardData?.getData('text') ?? '').replace(/\D/g, '').slice(0, 6);
      data.split('').forEach((d, j) => { if (inputs[j]) inputs[j].value = d; });
      const next = Math.min(data.length, inputs.length - 1);
      inputs[next].focus();
    });
  });

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', escHandler);
  }
  function escHandler(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', escHandler);

  async function submit() {
    const code = inputs.map(i => i.value).join('');
    if (code.length !== 6) { errEl.textContent = 'Enter all 6 digits.'; return; }
    submitBtn.disabled = true; errEl.textContent = '';
    try {
      const claimed = await claimCode(code);
      if (!claimed) {
        errEl.textContent = 'Code invalid, expired, or already used.';
        submitBtn.disabled = false;
        return;
      }
      onClaimed(claimed);
      close();
    } catch (ex) {
      errEl.textContent = ex.message || 'Failed to claim code.';
      submitBtn.disabled = false;
    }
  }

  submitBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
}

function renderSetupPB(song) {
  const myBest = ctx.bests?.[song.file];
  if (!myBest) {
    return `<div class="setup-song-pb empty">YOUR BEST: — set it now</div>`;
  }
  return `
    <div class="setup-song-pb">
      YOUR BEST: ${myBest.score.toLocaleString()} &middot;
      ${esc(myBest.grade || '—')} &middot;
      ${myBest.accuracy ?? '—'}% &middot;
      ${esc(timeAgo(myBest.played_at))}
    </div>
  `;
}

function midiStatusText() {
  if (!ctx.midi) return 'MIDI: initializing…';
  if (!ctx.midi.ok && ctx.midi.reason === 'unsupported') {
    return 'MIDI: not supported in this browser — open in Chrome to play';
  }
  if (!ctx.midi.ok && ctx.midi.reason === 'denied') {
    return 'MIDI: access denied — reload and allow the permission prompt';
  }
  const inputs = getInputs();
  if (inputs.length === 0) return 'MIDI: no devices connected — mouse/click input still works';
  return `MIDI: ${inputs.length} device${inputs.length === 1 ? '' : 's'} connected`;
}

function midiStatusClass() {
  if (!ctx.midi?.ok) return 'error';
  if (getInputs().length === 0) return 'warn';
  return 'ok';
}

// ── STATE: GAME ────────────────────────────────────────────────────

async function renderGame() {
  leaveCurrentState();
  setStateLabel('GAME');

  const song   = ctx.song;
  const setup  = ctx.setup;
  const inputs = getInputs();

  stateEl.innerHTML = `<div class="center-msg"><div class="title">LOADING SONG…</div></div>`;

  let parsed;
  try {
    const res = await fetch('songs/' + song.file, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    parsed = parseMIDIFile(buf);
  } catch (err) {
    renderError('FAILED TO LOAD SONG', `${song.file}: ${err.message}`);
    return;
  }

  const playableTracks = parsed.tracks.filter(t => t.notes.length > 0);
  if (playableTracks.length === 0) {
    renderError('EMPTY SONG', `${song.file} has no playable tracks.`);
    return;
  }

  paintGame(setup.playerCount);

  // Phase 6 — Remote score broadcast. Subscribe before the engine so
  // broadcastScore is in scope when the onScoreUpdate callback fires.
  let broadcastScore = () => {};
  if (ctx.lobby?.id) {
    ctx.remoteScores = new Map();
    const mySlotNum  = ctx.lobby.participants?.find(p => p.user_id === ctx.user.id)?.slot ?? 1;
    ctx.gameChannel  = lobbies.subscribeGameScores(ctx.lobby.id, onRemoteScoreTick);
    let lastBroadcast = 0;
    broadcastScore = (stats) => {
      const now = Date.now();
      if (now - lastBroadcast < 900) return;
      lastBroadcast = now;
      ctx.gameChannel?.broadcast({
        userId:   ctx.user.id,
        slot:     mySlotNum,
        score:    stats.score,
        grade:    stats.grade,
        accuracy: stats.accuracy,
        combo:    stats.multiplier,
      });
    };
    updateRemoteScoreStrip();   // pre-populate with all participants at 0
  }

  const enginePlayers = setup.players.slice(0, setup.playerCount).map((p, i) => {
    const track  = playableTracks[p.trackIndex] ?? playableTracks[0];
    const device = inputs.find(d => d.id === p.deviceId) ?? null;
    const trackIsDrums = track.notes[0]?.abstractName != null;
    const instrument   = trackIsDrums ? 'drums' : 'piano';

    return {
      id:         `p${i + 1}`,
      color:      PLAYER_COLORS[i],
      instrument,
      canvas:     document.getElementById(`p${i + 1}-canvas`),
      notes:      track.notes,
      deviceId:   p.deviceId || null,
      drumMapping: {},
      userOffset: device ? loadOffset(device.name) : 0,
      pianoOpts:  { noteMin: PIANO_NOTE_MIN, noteMax: PIANO_NOTE_MAX },
    };
  });

  ctx.activeGame = createGameplay({
    players:        enginePlayers,
    speedLevel:     setup.speedLevel     ?? DEFAULT_SPEED_LEVEL,
    hitWindowLevel: setup.hitWindowLevel ?? DEFAULT_HIT_WINDOW_LEVEL,
    alwaysSound:    true,
    callbacks: {
      onScoreUpdate:  (idx, stats) => { updateScoreCard(idx, stats); broadcastScore(stats); },
      onFeedback:     (idx, text, cls) => showFeedback(idx, text, cls),
      onSongComplete: () => onSongComplete(),
    },
  });

  ctx.lastResults = setup.players.slice(0, setup.playerCount).map((p, i) => {
    const track = playableTracks[p.trackIndex] ?? playableTracks[0];
    return {
      identity:  p.identity,
      trackName: track.name,
      instrument: enginePlayers[i].instrument,
      stats:     null,
    };
  });

  ctx.gameStarted = false;
  paintGameTimeDisplay();   // shows "READY · 0:32"

  document.getElementById('btn-start-song').addEventListener('click', startSongRun);
  document.getElementById('btn-pause').addEventListener('click', () => {
    if (!ctx.activeGame || !ctx.gameStarted) return;
    const nowPaused = ctx.activeGame.togglePause();
    document.getElementById('btn-pause').textContent = nowPaused ? '▶ RESUME' : '⏸ PAUSE';
  });
  document.getElementById('btn-restart').addEventListener('click', () => {
    if (!ctx.activeGame) return;
    ctx.activeGame.reset();
    document.getElementById('btn-pause').textContent = '⏸ PAUSE';
    startSongRun();
  });
  document.getElementById('btn-exit-game').addEventListener('click', renderSetup);
}

// Flip from warm-up state into the actual run. Snapshot PBs first so
// onSongComplete can detect a fresh best, capture startedAt for the
// session record, swap the controls, kick off the timer.
function startSongRun(engineOpts = {}) {
  if (!ctx.activeGame) return;
  ctx.oldBests      = { ...(ctx.bests || {}) };
  ctx.saveStatus    = null;
  ctx.gameStartedAt = new Date().toISOString();
  ctx.gameStarted   = true;

  // Swap controls — hide START + warm-up hint, show PAUSE + RESTART.
  const startBtn = document.getElementById('btn-start-song');
  if (startBtn) startBtn.style.display = 'none';
  const hint = document.querySelector('.warmup-hint');
  if (hint) hint.style.display = 'none';
  const pauseBtn   = document.getElementById('btn-pause');
  const restartBtn = document.getElementById('btn-restart');
  if (pauseBtn)   { pauseBtn.style.display   = ''; pauseBtn.textContent = '⏸ PAUSE'; }
  if (restartBtn) { restartBtn.style.display = ''; }

  ctx.activeGame.start(engineOpts);
  startGameTimer();
}

function paintGame(playerCount) {
  const song = ctx.song;
  const mm   = Math.floor(song.durationSec / 60);
  const ss   = String(Math.round(song.durationSec % 60)).padStart(2, '0');

  // "Now recording" label per player when a non-host identity is attached —
  // a small honesty cue so the host doesn't forget scores aren't all theirs.
  const identityChips = ctx.setup.players.slice(0, playerCount).map((p, i) => {
    if (p.identity.kind === 'host')  return `<span class="identity-host">P${i + 1} ${esc(p.identity.displayName)}</span>`;
    if (p.identity.kind === 'friend') return `<span class="identity-friend">P${i + 1} ${avatarEmoji(p.identity.avatar)} ${esc(p.identity.displayName)}</span>`;
    return `<span class="identity-guest">P${i + 1} ${esc(p.identity.displayName)}</span>`;
  }).join(' &middot; ');

  const panels = Array.from({ length: playerCount }, (_, i) => `
    <div class="game-panel p${i + 1}">
      <div class="score-card">
        <div class="score-tag">P${i + 1}</div>
        <div class="score-stat">
          <span class="lab">SCORE</span>
          <span class="val big" data-stat="${i}-score">0</span>
        </div>
        <div class="score-stat">
          <span class="lab">COMBO</span>
          <span class="val" data-stat="${i}-combo">x1</span>
        </div>
        <div class="score-stat">
          <span class="lab">ACC</span>
          <span class="val dim" data-stat="${i}-acc">—</span>
        </div>
        <div class="score-stat">
          <span class="lab">GRADE</span>
          <span class="val" data-stat="${i}-grade">—</span>
        </div>
        <div class="score-pgmw" data-stat="${i}-pgmw">0 / 0 / 0 / 0</div>
      </div>
      <div class="canvas-stage">
        <canvas id="p${i + 1}-canvas"></canvas>
        <div class="feedback-overlay" id="p${i + 1}-feedback"></div>
      </div>
    </div>
  `).join('');

  stateEl.innerHTML = `
    <div class="game-shell">
      <div class="game-header">
        <div class="game-song">${esc(song.title)}</div>
        <div class="game-meta">${song.bpm} BPM &middot; ${mm}:${ss}</div>
        <div class="game-meta" style="margin-left:18px">${identityChips}</div>
        <div class="game-time" id="game-time">READY · ${mm}:${ss}</div>
      </div>
      <div id="remote-score-strip" class="remote-score-strip"${ctx.lobby?.id ? '' : ' style="display:none"'}></div>
      <div class="game-panels players-${playerCount}">
        ${panels}
      </div>
      <div class="game-controls">
        <button class="btn-ghost" id="btn-exit-game">← EXIT</button>
        <div class="spacer"></div>
        <div class="warmup-hint">Play a few notes to warm up, then start.</div>
        <button class="btn-ghost"   id="btn-restart" style="display:none">↺ RESTART</button>
        <button class="btn-ghost"   id="btn-pause"   style="display:none">⏸ PAUSE</button>
        <button class="btn-primary" id="btn-start-song">▶ START SONG</button>
      </div>
    </div>
  `;
}

// One-shot paint of the time display (used pre-start). Once the run
// begins, startGameTimer's rAF loop takes over and updates per frame.
function paintGameTimeDisplay() {
  const el = document.getElementById('game-time');
  if (!el || !ctx.activeGame) return;
  const total = ctx.activeGame.getSongDuration?.() ?? 0;
  const mmT = Math.floor(total / 60000);
  const ssT = String(Math.floor((total / 1000) % 60)).padStart(2, '0');
  el.textContent = `READY · ${mmT}:${ssT}`;
}

function updateScoreCard(idx, stats) {
  setText(`${idx}-score`, stats.score);
  setText(`${idx}-combo`, 'x' + stats.multiplier);
  setText(`${idx}-acc`,   stats.accuracy !== null ? stats.accuracy + '%' : '—');
  setText(`${idx}-grade`, stats.grade || '—');
  setText(`${idx}-pgmw`,  `${stats.perfect} / ${stats.good} / ${stats.miss} / ${stats.wrong}`);
  if (ctx.lastResults?.[idx]) ctx.lastResults[idx].stats = stats;
}

function setText(stat, value) {
  const el = document.querySelector(`[data-stat="${stat}"]`);
  if (el) el.textContent = value;
}

function showFeedback(idx, text, cls) {
  const el = document.getElementById(`p${idx + 1}-feedback`);
  if (!el) return;
  el.textContent = text;
  el.className   = 'feedback-overlay show ' + cls;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = 'feedback-overlay ' + cls; }, 550);
}

function startGameTimer() {
  const total = ctx.activeGame?.getSongDuration?.() ?? 0;
  const mmT = Math.floor(total / 60000);
  const ssT = String(Math.floor((total / 1000) % 60)).padStart(2, '0');

  const tick = () => {
    if (!ctx.activeGame) return;
    const t  = Math.max(0, ctx.activeGame.getSongTime());
    const mm = Math.floor(t / 60000);
    const ss = String(Math.floor((t / 1000) % 60)).padStart(2, '0');
    const el = document.getElementById('game-time');
    if (el) el.textContent = `${mm}:${ss} / ${mmT}:${ssT}`;
    ctx.gameTimer = requestAnimationFrame(tick);
  };
  ctx.gameTimer = requestAnimationFrame(tick);
}

function stopGameTimer() {
  if (ctx.gameTimer !== null) cancelAnimationFrame(ctx.gameTimer);
  ctx.gameTimer = null;
}

function onSongComplete() {
  // Snapshot stats from the engine's final emission. ctx.lastResults
  // was kept in lockstep by updateScoreCard, so it's the source of truth here.
  const slots = (ctx.lastResults ?? []).map((r, i) => ({
    slot:        i + 1,
    identity:    r.identity.kind,
    userId:      r.identity.userId,
    displayName: r.identity.displayName,
    instrument:  r.instrument,
    trackIndex:  ctx.setup.players[i].trackIndex,
    trackName:   r.trackName,
    score:       r.stats?.score    ?? 0,
    accuracy:    r.stats?.accuracy ?? null,
    grade:       r.stats?.grade    ?? null,
    perfect:     r.stats?.perfect  ?? 0,
    good:        r.stats?.good     ?? 0,
    miss:        r.stats?.miss     ?? 0,
    wrong:       r.stats?.wrong    ?? 0,
    maxCombo:    r.stats?.maxCombo ?? 0,
  }));

  // Fire the save in the background — don't block the results screen.
  // saveStatus drives the small badge in renderResults().
  ctx.saveStatus = { state: 'saving' };
  saveSession({
    hostUserId:     ctx.user.id,
    song:           { file: ctx.song.file, title: ctx.song.title },
    speedLevel:     ctx.setup?.speedLevel     ?? DEFAULT_SPEED_LEVEL,
    hitWindowLevel: ctx.setup?.hitWindowLevel ?? DEFAULT_HIT_WINDOW_LEVEL,
    startedAt:      ctx.gameStartedAt,
    endedAt:        new Date().toISOString(),
    slots,
  }).then(sessionId => {
    ctx.saveStatus = { state: 'saved', sessionId };
    refreshSaveStatusUI();
    // Refresh PBs so the next setup screen reads current data.
    getMyPersonalBests(ctx.user.id).then(b => { ctx.bests = b; }).catch(() => {});
  }).catch(err => {
    console.error('play.js: saveSession failed', err);
    ctx.saveStatus = { state: 'failed', error: err.message };
    refreshSaveStatusUI();
  });

  setTimeout(() => renderResults(), 800);
}

function refreshSaveStatusUI() {
  const el = document.getElementById('save-status');
  if (!el || !ctx.saveStatus) return;
  const s = ctx.saveStatus;
  if (s.state === 'saving') {
    el.textContent = 'SAVING TO HISTORY…';
    el.className = 'save-status saving';
  } else if (s.state === 'saved') {
    el.textContent = '✓ SAVED TO HISTORY';
    el.className = 'save-status saved';
  } else {
    el.textContent = `⚠ COULD NOT SAVE — ${s.error}`;
    el.className = 'save-status failed';
  }
}

// ── STATE: RESULTS ─────────────────────────────────────────────────

function renderResults() {
  leaveCurrentState();
  setStateLabel('RESULTS');

  const results = ctx.lastResults ?? [];
  const song    = ctx.song;

  stateEl.innerHTML = `
    <div class="state-inner">
      <div class="results-card">
        <div class="results-song">${esc(song.title)}</div>
        <div class="results-subtitle">SONG COMPLETE</div>
        <div class="results-players">
          ${results.map((r, i) => resultsRow(i, r)).join('')}
        </div>
        <div class="save-status" id="save-status">SAVING TO HISTORY…</div>
      </div>
      <div class="actions">
        <button class="btn-ghost" data-action="menu">← SONG LIBRARY</button>
        <button class="btn-primary" data-action="again">▶ PLAY AGAIN</button>
      </div>
    </div>
  `;
  refreshSaveStatusUI();   // reflect the in-flight or completed save state
  stateEl.querySelector('[data-action="menu"]').addEventListener('click', renderSongSelect);
  stateEl.querySelector('[data-action="again"]').addEventListener('click', renderGame);
}

function resultsRow(i, r) {
  const s = r.stats ?? { score: 0, accuracy: 0, grade: '—', perfect: 0, good: 0, miss: 0, wrong: 0 };
  // NEW PB only for the host slot — we don't have friends' PBs (RLS) and
  // guests have no account to record against. Also only triggers when
  // there was a previous best to beat (first plays just record quietly).
  const isHostSlot = r.identity.kind === 'host';
  const oldBest    = ctx.oldBests?.[ctx.song.file]?.score ?? 0;
  const newPB      = isHostSlot && oldBest > 0 && s.score > oldBest;

  const identityLine = r.identity.kind === 'guest'
    ? `<span class="identity-guest">${esc(r.identity.displayName)}</span>`
    : `${avatarEmoji(r.identity.avatar)} <span class="${r.identity.kind === 'host' ? 'identity-host' : 'identity-friend'}">${esc(r.identity.displayName)}</span>`;
  const pbBadge = newPB ? '<span class="pb-new-badge">NEW PERSONAL BEST</span>' : '';

  return `
    <div class="results-row p${i + 1}">
      <div class="results-tag">P${i + 1}</div>
      <div>
        <div style="font-size:13px;color:#fff">${identityLine} ${pbBadge}</div>
        <div class="results-pgmw">${esc(r.trackName)} &middot; ${s.perfect} / ${s.good} / ${s.miss} / ${s.wrong}</div>
      </div>
      <div class="results-score">${s.score}</div>
      <div class="results-acc">${s.accuracy !== null ? s.accuracy + '%' : '—'}</div>
      <div class="results-grade">${s.grade || '—'}</div>
    </div>
  `;
}

// ── STATE: LOBBY (remote multiplayer) ──────────────────────────────

async function renderLobby() {
  leaveCurrentState();
  setStateLabel('LOBBY');

  if (!ctx.lobby?.id) {
    renderError('NO LOBBY', 'Lobby context missing — go back to song select.');
    return;
  }

  // Subscribe to live changes; teardown wired through leaveCurrentState.
  const lobbyId = ctx.lobby.id;
  const unsubscribe = lobbies.subscribeLobby(lobbyId, {
    onLobbyChange:       () => refreshLobbyData(),
    onParticipantChange: () => refreshLobbyData(),
  });
  setupTeardown = () => {
    unsubscribe();
    if (ctx.lobby) ctx.lobby.unsubscribe = null;
  };
  ctx.lobby.unsubscribe  = unsubscribe;
  ctx.lobby.gameLaunched = false;
  ctx.lobby.friends      = [];
  ctx.lobby.invited      = new Set();   // user_ids already invited this session

  // Load friends + measure clock offset in parallel — neither blocks the UI.
  Promise.all([
    getFriends(ctx.user.id).then(f => {
      // Sort: online first, then alphabetical.
      ctx.lobby.friends = f.sort((a, b) => {
        if (a.friend.is_online !== b.friend.is_online) return b.friend.is_online ? 1 : -1;
        return (a.friend.display_name ?? '').localeCompare(b.friend.display_name ?? '');
      });
    }),
    lobbies.measureClockOffset().then(offset => { ctx.clockOffset = offset; }),
  ]).catch(err => console.warn('lobby entry pre-load failed', err));

  await refreshLobbyData();
}

async function refreshLobbyData() {
  if (!ctx.lobby?.id) return;
  try {
    const [lobby, participants] = await Promise.all([
      lobbies.getLobby(ctx.lobby.id),
      lobbies.listParticipants(ctx.lobby.id),
    ]);
    if (!lobby) {
      renderError('LOBBY CLOSED', 'This lobby has ended or expired.');
      return;
    }
    ctx.lobby.lobby = lobby;
    ctx.lobby.participants = participants;

    // Load song track list from the manifest (for the track picker in the lobby UI).
    if (!ctx.lobby.tracks && lobby.song_file) {
      const entry = ctx.manifest?.songs?.find(s => s.file === lobby.song_file);
      ctx.lobby.tracks = entry?.tracks ?? [];
    }

    // Non-host: when state flips to 'starting', launch the game locally.
    // Guard gameLaunched so repeated Realtime ticks don't double-launch.
    if (lobby.state === 'starting' && lobby.start_at
        && lobby.host_user_id !== ctx.user.id
        && !ctx.lobby.gameLaunched) {
      ctx.lobby.gameLaunched = true;
      const serverStartMs  = new Date(lobby.start_at).getTime();
      const clockOffset    = ctx.clockOffset ?? 0;
      // Convert server epoch → local performance.now():
      //   localEpoch = serverEpoch + offset (where offset = localClock - serverClock)
      //   perfMs     = localEpoch - (Date.now() - performance.now())
      const localStartPerfMs = (serverStartMs + clockOffset) - (Date.now() - performance.now());
      launchRemoteGame(localStartPerfMs);
      return;
    }

    // If the host abandoned while we were watching, bail out gracefully.
    if (lobby.state === 'abandoned' && lobby.host_user_id !== ctx.user.id) {
      stateEl.innerHTML = `
        <div class="state-inner">
          <div class="center-msg">
            <div class="title">HOST LEFT THE LOBBY</div>
            <p class="dim">Returning to song select…</p>
          </div>
        </div>`;
      setTimeout(() => exitLobby({ skipServer: true }), 2000);
      return;
    }

    paintLobby();
  } catch (err) {
    console.error('refreshLobbyData failed', err);
  }
}

function paintLobby() {
  const { lobby, participants } = ctx.lobby;
  const me        = participants.find(p => p.user_id === ctx.user.id);
  const isHost    = lobby.host_user_id === ctx.user.id;
  const readyCnt  = participants.filter(p => p.is_ready).length;
  const allReady  = participants.length > 0 && readyCnt === participants.length;
  const inviteUrl = new URL(`play.html?lobby=${lobby.id}`, location.href).href;

  const stateLabels = {
    waiting:   'WAITING FOR PLAYERS',
    ready:     'ALL READY',
    starting:  'SYNCING CLOCKS…',
    playing:   'IN GAME',
    done:      'GAME FINISHED',
    abandoned: 'ABANDONED',
  };

  stateEl.innerHTML = `
    <div class="state-inner">
      <div class="lobby-header">
        <div class="section-label">REMOTE LOBBY${isHost ? ' — YOU ARE HOST' : ''}</div>
        <div class="lobby-song">${esc(lobby.song_title)}</div>
        <div class="lobby-state-pill state-${esc(lobby.state)}">${esc(stateLabels[lobby.state] || lobby.state.toUpperCase())}</div>
      </div>

      <div class="lobby-cards">
        <div class="form-card">
          <div class="form-card-title">PARTICIPANTS — ${participants.length}/4</div>
          <div class="lobby-roster">
            ${participants.map(p => renderParticipantRow(p, isHost)).join('')}
          </div>
        </div>

        <div class="form-card">
          <div class="form-card-title">INVITE A FRIEND</div>
          ${renderFriendPicker()}
        </div>

        <div class="form-card">
          <div class="form-card-title">SHARE LINK</div>
          <div class="pairing-explainer">
            Or send this link — anyone with it joins automatically.
          </div>
          <div class="invite-link-row">
            <input type="text" class="invite-link-input" readonly value="${esc(inviteUrl)}">
            <button class="btn-copy-invite" data-action="copy-invite">COPY</button>
          </div>
        </div>
      </div>

      <div class="lobby-actions">
        <button class="btn-ghost-lobby" data-action="leave">${isHost ? 'CLOSE LOBBY' : '← LEAVE'}</button>
        ${me ? `
          <button class="${me.is_ready ? 'btn-ready' : 'btn-not-ready'}" data-action="toggle-ready">
            ${me.is_ready ? '✓ READY' : 'READY UP'}
          </button>
        ` : ''}
        ${isHost ? `
          <button class="btn-start-lobby" data-action="start" ${allReady && lobby.state === 'waiting' ? '' : 'disabled'}>
            ${lobby.state === 'waiting'
                ? (allReady ? '▶ START SONG' : `WAITING — ${readyCnt}/${participants.length} READY`)
                : 'LOCKED IN'}
          </button>
        ` : ''}
      </div>
    </div>
  `;

  stateEl.querySelector('[data-action="leave"]')?.addEventListener('click', () => exitLobby());
  stateEl.querySelector('[data-action="toggle-ready"]')?.addEventListener('click', toggleReady);
  stateEl.querySelector('[data-action="start"]')?.addEventListener('click', startLobby);
  stateEl.querySelector('[data-action="copy-invite"]')?.addEventListener('click', copyInvite);
  stateEl.querySelectorAll('[data-action="kick"]').forEach(btn => {
    btn.addEventListener('click', () => kickParticipant(btn.dataset.userId));
  });
  stateEl.querySelectorAll('[data-action="invite-friend"]').forEach(btn => {
    btn.addEventListener('click', () => inviteFriend(btn.dataset.userId, btn));
  });
  stateEl.querySelectorAll('[data-action="set-slot-config"]').forEach(sel => {
    sel.addEventListener('change', () => {
      const field = sel.dataset.field;
      const val   = field === 'track' ? Number(sel.value) : sel.value;
      lobbies.setSlotConfig(ctx.lobby.id, field === 'track' ? { track_index: val } : { instrument: val })
        .catch(err => console.error('setSlotConfig failed', err));
    });
  });
}

function renderFriendPicker() {
  const friends = ctx.lobby?.friends ?? [];
  const already = new Set((ctx.lobby?.participants ?? []).map(p => p.user_id));
  if (!friends.length) {
    return '<div class="pairing-explainer">No friends yet — add some from the home screen.</div>';
  }
  return `<div class="lobby-roster">${friends.map(({ friend: f }) => {
    const inLobby   = already.has(f.id);
    const invited   = ctx.lobby?.invited?.has(f.id);
    const disabled  = inLobby || invited;
    const label     = inLobby ? 'IN LOBBY' : invited ? 'INVITED ✓' : 'INVITE';
    return `
      <div class="participant-row">
        <span class="participant-avatar">${avatarEmoji(f.avatar)}</span>
        <span class="participant-name">
          ${esc(f.display_name ?? f.username ?? 'Friend')}
          ${f.is_online ? '' : '<span class="dim" style="font-size:10px"> · offline</span>'}
        </span>
        <button class="btn-kick" style="min-width:72px"
          data-action="invite-friend" data-user-id="${esc(f.id)}"
          ${disabled ? 'disabled' : ''}>${label}</button>
      </div>`;
  }).join('')}</div>`;
}

async function inviteFriend(friendId, btn) {
  btn.disabled = true;
  btn.textContent = 'SENDING…';
  try {
    await sendPlayInvite(ctx.user.id, friendId, null, ctx.lobby.id);
    ctx.lobby.invited.add(friendId);
    btn.textContent = 'INVITED ✓';
  } catch (err) {
    console.error('inviteFriend failed', err);
    btn.disabled = false;
    btn.textContent = 'INVITE';
  }
}

function renderParticipantRow(p, viewerIsHost) {
  const name        = p.profile?.display_name || p.profile?.username || 'Player';
  const av          = avatarEmoji(p.profile?.avatar);
  const isMe        = p.user_id === ctx.user.id;
  const isLobbyHost = ctx.lobby.lobby.host_user_id === p.user_id;
  const canKick     = viewerIsHost && !isMe;

  const suffix = [
    isMe        ? '(you)' : '',
    isLobbyHost ? 'HOST'  : '',
  ].filter(Boolean).join(' · ');

  const tracks = ctx.lobby?.tracks ?? [];
  const myConfig = isMe ? `
    <div class="lobby-my-config">
      <select class="lobby-slot-sel" data-action="set-slot-config" data-field="instrument">
        <option value="piano" ${(p.instrument ?? 'piano') === 'piano' ? 'selected' : ''}>🎹 Piano</option>
        <option value="drums" ${p.instrument === 'drums' ? 'selected' : ''}>🥁 Drums</option>
      </select>
      ${tracks.length > 1 ? `<select class="lobby-slot-sel" data-action="set-slot-config" data-field="track">
        ${tracks.map((t, i) => `<option value="${i}" ${(p.track_index ?? 0) === i ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
      </select>` : ''}
    </div>` : `<span class="participant-ready">${p.is_ready ? '✓ READY' : 'WAITING…'}</span>`;

  return `
    <div class="participant-row ${p.is_ready ? 'is-ready' : ''}">
      <span class="participant-slot">P${p.slot ?? '?'}</span>
      <span class="participant-avatar">${av}</span>
      <span class="participant-name">${esc(name)}${suffix ? ` <span class="dim">· ${esc(suffix)}</span>` : ''}</span>
      ${myConfig}
      ${canKick ? `<button class="btn-kick" data-action="kick" data-user-id="${esc(p.user_id)}">KICK</button>` : ''}
    </div>
  `;
}

async function toggleReady() {
  const me = ctx.lobby?.participants?.find(p => p.user_id === ctx.user.id);
  if (!me) return;
  try {
    await lobbies.setReady(ctx.lobby.id, !me.is_ready);
    // Realtime triggers refreshLobbyData on success.
  } catch (err) {
    console.error('setReady failed', err);
  }
}

async function startLobby() {
  const lobbyId = ctx.lobby.id;
  try {
    // Ensure clock offset is ready (should already be from lobby entry).
    if (ctx.clockOffset === null) {
      ctx.clockOffset = await lobbies.measureClockOffset();
    }

    // Compute when the count-off should fire in server time.
    // serverNow = Date.now() - clockOffset (our best estimate of server's current epoch).
    // Add 3 s of lead time so every client has time to load the song.
    const serverNow        = Date.now() - ctx.clockOffset;
    const serverStartEpoch = serverNow + 3000;

    // Write start_at + transition to 'starting' in one update.
    await lobbies.updateLobby(lobbyId, {
      state:    'starting',
      start_at: new Date(serverStartEpoch).toISOString(),
    });

    // Host launches immediately — clock offset cancels out, so
    // localStartPerfMs = performance.now() + 3000 for the host.
    ctx.lobby.gameLaunched = true;
    launchRemoteGame(performance.now() + 3000);
  } catch (err) {
    console.error('startLobby failed', err);
    alert(`Could not start — ${err.message ?? err}\n\nHave you run migration 0006 in Supabase?`);
  }
}

async function kickParticipant(userId) {
  try {
    await lobbies.kick(ctx.lobby.id, userId);
  } catch (err) {
    console.error('kick failed', err);
  }
}

function copyInvite() {
  const input = stateEl.querySelector('.invite-link-input');
  if (!input) return;
  input.select();
  navigator.clipboard?.writeText(input.value).catch(() => {
    try { document.execCommand('copy'); } catch {}
  });
  const btn = stateEl.querySelector('[data-action="copy-invite"]');
  if (btn) {
    btn.textContent = 'COPIED';
    setTimeout(() => { if (btn.textContent === 'COPIED') btn.textContent = 'COPY'; }, 1500);
  }
}

// Leave the lobby (self) or close it (host). Clears URL param + ctx
// and returns to song-select. skipServer=true when the server already
// invalidated the lobby (e.g. host abandoned while we were watching).
async function exitLobby({ skipServer = false } = {}) {
  const lobby   = ctx.lobby?.lobby;
  const lobbyId = ctx.lobby?.id;
  const wasHost = lobby?.host_user_id === ctx.user.id;

  if (!skipServer && lobbyId) {
    try {
      if (wasHost) {
        await lobbies.updateLobby(lobbyId, { state: 'abandoned' });
      } else {
        await lobbies.leave(lobbyId);
      }
    } catch (err) {
      console.warn('exitLobby cleanup failed', err);
    }
  }

  if (ctx.lobby?.unsubscribe) { ctx.lobby.unsubscribe(); }
  ctx.lobby = null;

  const url = new URL(location.href);
  url.searchParams.delete('lobby');
  history.replaceState({}, '', url.toString());

  renderSongSelect();
}

// Transition from the lobby state to a live game for remote multiplayer.
// Each player runs a single-player game (their own slot only) started at
// the same wall-clock instant. countoffStartsAt is a performance.now()
// value computed from the shared server start_at + each client's offset.
async function launchRemoteGame(countoffStartsAt) {
  const lobby   = ctx.lobby?.lobby;
  const mySlot  = ctx.lobby?.participants?.find(p => p.user_id === ctx.user.id);
  if (!lobby) return;

  // Tear down lobby Realtime subscription before navigating away.
  if (ctx.lobby?.unsubscribe) {
    ctx.lobby.unsubscribe();
    ctx.lobby.unsubscribe = null;
    setupTeardown = null;
  }

  const url = new URL(location.href);
  url.searchParams.delete('lobby');
  history.replaceState({}, '', url.toString());

  // Populate ctx.song + ctx.setup from lobby config.
  ctx.song = { file: lobby.song_file, title: lobby.song_title };
  ctx.setup = {
    playerCount:     1,
    speedLevel:      lobby.speed_level      ?? DEFAULT_SPEED_LEVEL,
    hitWindowLevel:  lobby.hit_window_level ?? DEFAULT_HIT_WINDOW_LEVEL,
    songFile:        lobby.song_file,
    players: [{
      identity:   makeHostIdentity(),
      trackIndex: mySlot?.track_index ?? 0,
      deviceId:   DEVICE_ID_KEYBOARD,
      instrument: mySlot?.instrument  ?? 'piano',
    }],
  };

  // Render game screen (loads MIDI, creates engine), then start immediately
  // with the synchronized countoff timestamp — no "▶ START SONG" warmup.
  await renderGame();
  startSongRun({ countoffStartsAt });
}

// ── REMOTE SCORE STRIP (Phase 6) ───────────────────────────────────

function onRemoteScoreTick(payload) {
  if (!ctx.remoteScores || !payload?.userId) return;
  ctx.remoteScores.set(payload.userId, payload);
  updateRemoteScoreStrip();
}

function updateRemoteScoreStrip() {
  const strip = document.getElementById('remote-score-strip');
  if (!strip) return;
  const participants = ctx.lobby?.participants ?? [];
  strip.innerHTML = participants.map(p => {
    const rs   = ctx.remoteScores?.get(p.user_id);
    const name = p.profile?.display_name || p.profile?.username || `P${p.slot ?? '?'}`;
    const isMe = p.user_id === ctx.user.id;
    return `
      <div class="rss-entry ${isMe ? 'rss-me' : ''}">
        <span class="rss-name">${esc(name)}${isMe ? ' · you' : ''}</span>
        <span class="rss-score">${rs ? rs.score.toLocaleString() : '0'}</span>
        <span class="rss-grade">${rs?.grade ?? '—'}</span>
        <span class="rss-acc">${rs?.accuracy != null ? rs.accuracy + '%' : '—'}</span>
      </div>`;
  }).join('');
}

// ── HELPERS ────────────────────────────────────────────────────────

function leaveCurrentState() {
  if (setupTeardown) { setupTeardown(); setupTeardown = null; }
  if (ctx.activeGame) { ctx.activeGame.destroy(); ctx.activeGame = null; }
  if (ctx.gameChannel) { ctx.gameChannel.unsubscribe(); ctx.gameChannel = null; }
  ctx.remoteScores = null;
  stopGameTimer();
  // Tear down any open modals so they don't leak across state transitions.
  document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
}

function setStateLabel(text) {
  stateLabelEl.textContent = text;
}

function renderError(title, message) {
  leaveCurrentState();
  setStateLabel('');
  stateEl.innerHTML = `
    <div class="center-msg error">
      <div class="title">${esc(title)}</div>
      <pre>${esc(message)}</pre>
    </div>
  `;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Inline relative-time formatter — small enough not to be worth a shared util.
// app.js has the same function but we don't import from it (play.html doesn't
// expose the DOM elements app.js touches on import).
function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60)    return 'just now';
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
