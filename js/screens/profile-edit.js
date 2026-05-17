import { updateProfile, isUsernameTaken } from '../services/profile.js';
import { AVATARS, ACCENT_COLORS, refreshProfile } from '../app.js';

export function mount(el, ctx, navigate, { onboarding = false } = {}) {
  const { user, profile } = ctx;

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
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
