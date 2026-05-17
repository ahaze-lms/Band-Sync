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
import { initMIDI, getInputs, onStateChange } from './core/midi.js';
import { parseMIDIFile }      from './core/midi-parser.js';
import { loadOffset }         from './core/calibration.js';
import { createGameplay }     from './core/gameplay-engine.js';
import { PLAYER_COLORS,
         PIANO_NOTE_MIN, PIANO_NOTE_MAX,
         DEFAULT_SPEED_LEVEL, DEFAULT_HIT_WINDOW_LEVEL } from './config.js';

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
const ENABLED_PLAYERS = 2;   // bump when 3/4-player layouts land

const ctx = {
  user:        null,
  profile:     null,  // host's profile
  manifest:    null,
  song:        null,  // selected song from manifest
  setup:       null,  // per-song setup state (player count, choices, identities)
  midi:        null,  // { ok, reason?, inputCount }
  activeGame:  null,  // current gameplay engine instance, or null
  gameTimer:   null,  // requestAnimationFrame id for the song timer
  lastResults: null,  // [{ identity, stats, ... }, ...] for results screen
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

// Slots default: P1 is Me, all others Guest.
function defaultSlot(idx, song) {
  return {
    identity:   idx === 0 ? makeHostIdentity() : makeGuestIdentity(idx),
    instrument: 'piano',
    deviceId:   null,
    trackIndex: Math.min(idx, song.tracks.length - 1),
  };
}

function defaultSetup(song) {
  return {
    songFile:    song.file,
    playerCount: Math.min(ENABLED_PLAYERS, Math.max(1, song.tracks.length)),
    players:     Array.from({ length: MAX_PLAYERS }, (_, i) => defaultSlot(i, song)),
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
      <div class="section-label">LIBRARY — ${songs.length} SONGS</div>
      <div class="song-grid">
        ${songs.map(songCard).join('')}
      </div>
    </div>
  `;

  stateEl.querySelectorAll('[data-song-file]').forEach(el => {
    el.addEventListener('click', () => {
      const file = el.dataset.songFile;
      applySong(songs.find(s => s.file === file));
      renderSetup();
    });
  });
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
      </div>

      <div class="setup-section">
        <div class="setup-section-label">PLAYERS</div>
        <div class="player-count">
          ${[1, 2, 3, 4].map(n => `
            <button class="count-btn ${setup.playerCount === n ? 'active' : ''}"
                    data-count="${n}"
                    ${n > ENABLED_PLAYERS ? 'disabled title="3-4 player layouts coming later"' : ''}>${n}</button>
          `).join('')}
          ${ENABLED_PLAYERS < MAX_PLAYERS
            ? `<div class="count-btn-note">3-4 player layouts coming later</div>`
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

      if (field === 'instrument') p.instrument = el.value;
      if (field === 'device')     p.deviceId   = el.value || null;
      if (field === 'track')      p.trackIndex = Number(el.value);

      if (field === 'identity') {
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
        }
        paintSetup();
      },
    });
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
        <select data-player="${i}" data-field="device" ${inputs.length === 0 ? 'disabled' : ''}>
          ${inputs.length === 0
            ? `<option value="">(no devices)</option>`
            : `<option value="">(none)</option>` +
              inputs.map(d => `
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

  // Else dropdown: Me / Join with code… / Guest
  const isHost  = slot.identity.kind === 'host';
  const isGuest = slot.identity.kind === 'guest';
  const meLabel = `Me — ${esc(ctx.profile?.display_name || ctx.profile?.username || 'You')}`;
  return `
    <select data-player="${slotIdx}" data-field="identity">
      <option value="host"  ${isHost  ? 'selected' : ''}>${meLabel}</option>
      <option value="claim">Join with code…</option>
      <option value="guest" ${isGuest ? 'selected' : ''}>Guest ${slotIdx + 1}</option>
    </select>
  `;
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
    speedLevel:     DEFAULT_SPEED_LEVEL,
    hitWindowLevel: DEFAULT_HIT_WINDOW_LEVEL,
    alwaysSound:    true,
    callbacks: {
      onScoreUpdate:  (idx, stats) => updateScoreCard(idx, stats),
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

  startGameTimer();

  document.getElementById('btn-pause').addEventListener('click', () => {
    if (!ctx.activeGame) return;
    const nowPaused = ctx.activeGame.togglePause();
    document.getElementById('btn-pause').textContent = nowPaused ? '▶ RESUME' : '⏸ PAUSE';
  });
  document.getElementById('btn-restart').addEventListener('click', () => {
    if (!ctx.activeGame) return;
    ctx.activeGame.reset();
    document.getElementById('btn-pause').textContent = '⏸ PAUSE';
    ctx.activeGame.start();
  });
  document.getElementById('btn-exit-game').addEventListener('click', renderSetup);

  ctx.activeGame.start();
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
        <div class="score-row">
          <span>SCORE</span>
          <span class="val big" data-stat="${i}-score">0</span>
        </div>
        <div class="score-row">
          <span>COMBO</span>
          <span class="val" data-stat="${i}-combo">x1</span>
        </div>
        <div class="score-row">
          <span>ACC</span>
          <span class="val dim" data-stat="${i}-acc">—</span>
        </div>
        <div class="score-row">
          <span>GRADE</span>
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
        <div class="game-time" id="game-time">0:00 / ${mm}:${ss}</div>
      </div>
      <div class="game-panels players-${playerCount}">
        ${panels}
      </div>
      <div class="game-controls">
        <button class="btn-ghost" id="btn-exit-game">← EXIT</button>
        <div class="spacer"></div>
        <button class="btn-ghost" id="btn-restart">↺ RESTART</button>
        <button class="btn-ghost" id="btn-pause">⏸ PAUSE</button>
      </div>
    </div>
  `;
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
  setTimeout(() => renderResults(), 800);
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
      </div>
      <div class="actions">
        <button class="btn-ghost" data-action="menu">← SONG LIBRARY</button>
        <button class="btn-primary" data-action="again">▶ PLAY AGAIN</button>
      </div>
    </div>
  `;
  stateEl.querySelector('[data-action="menu"]').addEventListener('click', renderSongSelect);
  stateEl.querySelector('[data-action="again"]').addEventListener('click', renderGame);
}

function resultsRow(i, r) {
  const s = r.stats ?? { score: 0, accuracy: 0, grade: '—', perfect: 0, good: 0, miss: 0, wrong: 0 };
  const identityLine = r.identity.kind === 'guest'
    ? `<span class="identity-guest">${esc(r.identity.displayName)}</span>`
    : `${avatarEmoji(r.identity.avatar)} <span class="${r.identity.kind === 'host' ? 'identity-host' : 'identity-friend'}">${esc(r.identity.displayName)}</span>`;
  return `
    <div class="results-row p${i + 1}">
      <div class="results-tag">P${i + 1}</div>
      <div>
        <div style="font-size:13px;color:#fff">${identityLine}</div>
        <div class="results-pgmw">${esc(r.trackName)} &middot; ${s.perfect} / ${s.good} / ${s.miss} / ${s.wrong}</div>
      </div>
      <div class="results-score">${s.score}</div>
      <div class="results-acc">${s.accuracy !== null ? s.accuracy + '%' : '—'}</div>
      <div class="results-grade">${s.grade || '—'}</div>
    </div>
  `;
}

// ── HELPERS ────────────────────────────────────────────────────────

function leaveCurrentState() {
  if (setupTeardown) { setupTeardown(); setupTeardown = null; }
  if (ctx.activeGame) { ctx.activeGame.destroy(); ctx.activeGame = null; }
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
