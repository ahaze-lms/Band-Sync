import { updateProfile, isUsernameTaken } from '../services/profile.js';
import { generateCode, listMyCodes, revokeCode, getRecentUses } from '../services/device-codes.js';
import { AVATARS, ACCENT_COLORS, refreshProfile, avatarEmoji, timeAgo } from '../app.js';

export function mount(el, ctx, navigate, { onboarding = false } = {}) {
  const { user, profile } = ctx;
  let countdownTimer = null;

  el.innerHTML = `
    <div class="form-page">
      <div class="form-card">
        <div class="form-card-title">${onboarding ? 'SET UP YOUR PROFILE' : 'EDIT PROFILE'}</div>
        ${onboarding ? '<div class="dim" style="margin-bottom:16px;font-size:12px;text-align:center">Choose a username to get started — you can update everything later.</div>' : ''}

        <div class="form-group">
          <label class="form-label">USERNAME <span class="dim">(visible to others, unique)</span></label>
          <input class="input" type="text" id="f-username" maxlength="24"
            placeholder="cooldrummer99" value="${esc(profile?.username ?? '')}">
          <div class="field-hint" id="username-hint"></div>
        </div>

        <div class="form-group">
          <label class="form-label">DISPLAY NAME</label>
          <input class="input" type="text" id="f-displayname" maxlength="32"
            placeholder="Your name" value="${esc(profile?.display_name ?? '')}">
        </div>

        <div class="form-group">
          <label class="form-label">TAGLINE <span class="dim">(optional)</span></label>
          <input class="input" type="text" id="f-tagline" maxlength="60"
            placeholder="Destroyer of snares" value="${esc(profile?.tagline ?? '')}">
        </div>

        <div class="form-group">
          <label class="form-label">AVATAR</label>
          <div class="avatar-grid" id="avatar-grid">
            ${Object.entries(AVATARS).map(([slug, emoji]) => `
              <button class="avatar-opt ${(profile?.avatar ?? 'piano') === slug ? 'selected' : ''}"
                data-slug="${slug}" title="${slug}">${emoji}</button>
            `).join('')}
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">ACCENT COLOR</label>
          <div class="color-grid" id="color-grid">
            ${ACCENT_COLORS.map(c => `
              <button class="color-opt ${(profile?.accent_color ?? 'purple') === c.name ? 'selected' : ''}"
                data-color="${c.name}" title="${c.label}"
                style="background:${c.fill};border-color:${c.stroke}"></button>
            `).join('')}
          </div>
        </div>

        <div class="auth-error" id="profile-error"></div>
        <div class="auth-note"  id="profile-note"></div>

        <button class="btn btn-primary btn-full" id="btn-save">
          ${onboarding ? 'GET STARTED →' : 'SAVE CHANGES'}
        </button>
        ${!onboarding ? '<button class="btn btn-ghost btn-full" id="btn-cancel" style="margin-top:8px">CANCEL</button>' : ''}
      </div>

      ${onboarding ? '' : `
      <div class="form-card" id="pairing-card">
        <div class="form-card-title">PAIRING</div>
        <div class="pairing-explainer">
          Generate a one-time code to play under <strong>your account</strong>
          on a friend's device. Share the code aloud or with a message — they
          enter it at <code>play.html → setup → P2: Join with code</code> and
          your scores save to your history. Codes expire in 10 minutes and
          can only be used once.
        </div>
        <button class="btn btn-primary" id="btn-gen-code">▸ GENERATE NEW CODE</button>
        <div class="auth-error" id="pairing-error"></div>
        <div class="pairing-list" id="pairing-list">
          <div class="pairing-empty">Loading…</div>
        </div>
      </div>

      <div class="form-card" id="activity-card">
        <div class="form-card-title">RECENT ACCOUNT ACTIVITY</div>
        <div class="pairing-explainer">
          Codes of yours that have been claimed on someone else's device.
          If you don't recognize one, you can revoke its remaining sessions
          from the connected device by removing it from your
          <a href="#" data-screen-link="history" class="history-link">history</a>.
        </div>
        <div class="activity-list" id="activity-list">
          <div class="pairing-empty">Loading…</div>
        </div>
      </div>
      `}
    </div>
  `;

  let selectedAvatar = profile?.avatar ?? 'piano';
  let selectedColor  = profile?.accent_color ?? 'purple';

  // Avatar selection
  document.getElementById('avatar-grid').addEventListener('click', e => {
    const btn = e.target.closest('.avatar-opt');
    if (!btn) return;
    selectedAvatar = btn.dataset.slug;
    document.querySelectorAll('.avatar-opt').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
  });

  // Color selection
  document.getElementById('color-grid').addEventListener('click', e => {
    const btn = e.target.closest('.color-opt');
    if (!btn) return;
    selectedColor = btn.dataset.color;
    document.querySelectorAll('.color-opt').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
  });

  // Username availability check (debounced)
  let usernameTimer;
  const usernameInput = document.getElementById('f-username');
  usernameInput.addEventListener('input', () => {
    clearTimeout(usernameTimer);
    const hint = document.getElementById('username-hint');
    const val  = usernameInput.value.trim();
    if (!val) { hint.textContent = ''; hint.className = 'field-hint'; return; }
    if (!/^[a-z0-9_]{3,24}$/i.test(val)) {
      hint.textContent = '3–24 chars, letters/numbers/underscore only';
      hint.className = 'field-hint hint-error';
      return;
    }
    hint.textContent = 'Checking...';
    hint.className = 'field-hint hint-dim';
    usernameTimer = setTimeout(async () => {
      if (val === profile?.username) { hint.textContent = '✓ Your current username'; hint.className = 'field-hint hint-ok'; return; }
      const taken = await isUsernameTaken(val);
      hint.textContent = taken ? '✗ Username taken' : '✓ Available';
      hint.className   = taken ? 'field-hint hint-error' : 'field-hint hint-ok';
    }, 400);
  });

  // Save
  document.getElementById('btn-save').addEventListener('click', async () => {
    const errEl  = document.getElementById('profile-error');
    const noteEl = document.getElementById('profile-note');
    errEl.textContent = ''; noteEl.textContent = '';

    const username    = usernameInput.value.trim();
    const displayName = document.getElementById('f-displayname').value.trim();
    const tagline     = document.getElementById('f-tagline').value.trim();

    if (!username) { errEl.textContent = 'Username is required.'; return; }
    if (!/^[a-z0-9_]{3,24}$/i.test(username)) { errEl.textContent = 'Invalid username format.'; return; }

    const btn = document.getElementById('btn-save');
    btn.disabled = true; btn.textContent = '...';

    try {
      if (username !== profile?.username && await isUsernameTaken(username)) {
        errEl.textContent = 'That username is already taken.';
        return;
      }
      const updated = await updateProfile(user.id, {
        username, display_name: displayName, tagline,
        avatar: selectedAvatar, accent_color: selectedColor,
      });
      ctx.profile = updated;
      await refreshProfile();
      if (onboarding) { navigate('home'); return; }
      noteEl.textContent = '✓ Profile saved.';
    } catch (ex) {
      errEl.textContent = ex.message;
    } finally {
      btn.disabled = false;
      btn.textContent = onboarding ? 'GET STARTED →' : 'SAVE CHANGES';
    }
  });

  if (!onboarding) {
    document.getElementById('btn-cancel')?.addEventListener('click', () => navigate('home'));
  }

  // ── Pairing section ────────────────────────────────────────────
  // Only present when not onboarding. Manages active device-code list
  // with a live countdown, generate, and revoke.
  let freshCode = null;       // most recently generated code, gets the highlight

  async function refreshPairingList() {
    const listEl = document.getElementById('pairing-list');
    if (!listEl) return;
    try {
      const codes = await listMyCodes(user.id);
      if (codes.length === 0) {
        listEl.innerHTML = '<div class="pairing-empty">NO ACTIVE CODES</div>';
        return;
      }
      listEl.innerHTML = codes.map(renderCodeRow).join('');
      // Wire revoke buttons.
      listEl.querySelectorAll('[data-revoke]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const code = btn.dataset.revoke;
          btn.disabled = true;
          try {
            await revokeCode(code);
            await refreshPairingList();
          } catch (ex) {
            btn.disabled = false;
            document.getElementById('pairing-error').textContent = ex.message;
          }
        });
      });
      paintCountdowns();
    } catch (ex) {
      listEl.innerHTML = `<div class="pairing-empty" style="color:var(--red)">${esc(ex.message)}</div>`;
    }
  }

  function renderCodeRow(c) {
    const codeFmt = formatCode(c.code);
    const fresh   = c.code === freshCode ? ' fresh' : '';
    return `
      <div class="pairing-row${fresh}" data-code="${esc(c.code)}" data-expires="${esc(c.expires_at)}">
        <div class="pairing-code">${esc(codeFmt)}</div>
        <div class="pairing-meta" data-countdown></div>
        <button class="btn-revoke" data-revoke="${esc(c.code)}">REVOKE</button>
      </div>
    `;
  }

  // Visual: "742619" → "742 619" (three digits, space, three digits).
  function formatCode(c) {
    return c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c;
  }

  function paintCountdowns() {
    const rows = document.querySelectorAll('.pairing-row[data-expires]');
    const now  = Date.now();
    let anyExpired = false;
    rows.forEach(row => {
      const expiresAt = new Date(row.dataset.expires).getTime();
      const msLeft    = expiresAt - now;
      const meta      = row.querySelector('[data-countdown]');
      if (!meta) return;
      if (msLeft <= 0) { anyExpired = true; meta.textContent = 'EXPIRED'; meta.className = 'pairing-meta warn'; return; }
      const totalSec = Math.floor(msLeft / 1000);
      const mm = Math.floor(totalSec / 60);
      const ss = String(totalSec % 60).padStart(2, '0');
      meta.textContent = `EXPIRES IN ${mm}:${ss}`;
      meta.className   = msLeft < 60_000 ? 'pairing-meta warn' : 'pairing-meta';
    });
    if (anyExpired) refreshPairingList();   // re-fetch so expired rows drop off
  }

  // ── Recent activity (audit log: who has used my codes) ────────
  async function refreshActivityList() {
    const listEl = document.getElementById('activity-list');
    if (!listEl) return;
    try {
      const rows = await getRecentUses(user.id);
      if (rows.length === 0) {
        listEl.innerHTML = '<div class="pairing-empty">NO ONE HAS USED A CODE YET</div>';
        return;
      }
      listEl.innerHTML = rows.map(renderActivityRow).join('');
    } catch (ex) {
      listEl.innerHTML = `<div class="pairing-empty" style="color:var(--red)">${esc(ex.message)}</div>`;
    }
  }

  function renderActivityRow(r) {
    const code = formatCode(r.code);
    const name = r.claimer
      ? esc(r.claimer.display_name || r.claimer.username || 'someone')
      : '(unknown)';
    const av   = r.claimer ? avatarEmoji(r.claimer.avatar) : '·';
    return `
      <div class="activity-row">
        <span class="activity-avatar">${av}</span>
        <span class="activity-name">${name}</span>
        <span class="activity-time" title="${esc(new Date(r.used_at).toLocaleString())}">${esc(timeAgo(r.used_at))}</span>
        <span class="activity-code">${esc(code)}</span>
      </div>
    `;
  }

  if (!onboarding) {
    document.getElementById('btn-gen-code').addEventListener('click', async () => {
      const btn    = document.getElementById('btn-gen-code');
      const errEl  = document.getElementById('pairing-error');
      errEl.textContent = '';
      btn.disabled = true; btn.textContent = '...';
      try {
        // Use the latest in-memory profile so the snapshot reflects any
        // unsaved-but-applied display/avatar/color tweaks above. If a
        // change hasn't been saved yet, the snapshot uses the saved one.
        const snap = ctx.profile ?? profile;
        const row  = await generateCode(user.id, snap);
        freshCode  = row.code;
        await refreshPairingList();
      } catch (ex) {
        errEl.textContent = ex.message;
      } finally {
        btn.disabled = false;
        btn.textContent = '▸ GENERATE NEW CODE';
      }
    });

    // Inline "history" link in the ACTIVITY explainer.
    document.querySelectorAll('[data-screen-link]').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        navigate(a.dataset.screenLink);
      });
    });

    refreshPairingList();
    refreshActivityList();
    countdownTimer = setInterval(paintCountdowns, 1000);
  }

  // ── Cleanup ────────────────────────────────────────────────────
  return {
    destroy() {
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    },
  };
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
