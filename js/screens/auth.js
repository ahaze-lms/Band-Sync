import { signIn, signUp } from '../services/auth.js';

export function mount(container, navigate) {
  let mode = 'signin'; // 'signin' | 'signup'

  container.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-logo">BAND<span>SYNC</span></div>
      <div class="auth-sub">MULTIPLAYER RHYTHM GAME</div>
      <div class="auth-card">
        <div class="auth-tabs">
          <button class="auth-tab active" id="tab-signin">SIGN IN</button>
          <button class="auth-tab"        id="tab-signup">CREATE ACCOUNT</button>
        </div>

        <!-- SIGN IN -->
        <form class="auth-form" id="form-signin">
          <div class="form-group">
            <label class="form-label">EMAIL</label>
            <input class="input" type="email" id="si-email" autocomplete="email" required>
          </div>
          <div class="form-group">
            <label class="form-label">PASSWORD</label>
            <input class="input" type="password" id="si-pass" autocomplete="current-password" required>
          </div>
          <div class="auth-error" id="si-error"></div>
          <button class="btn btn-primary btn-full" type="submit" id="si-btn">SIGN IN</button>
        </form>

        <!-- SIGN UP -->
        <form class="auth-form" id="form-signup" style="display:none">
          <div class="form-group">
            <label class="form-label">DISPLAY NAME</label>
            <input class="input" type="text" id="su-name" maxlength="32" required>
          </div>
          <div class="form-group">
            <label class="form-label">EMAIL</label>
            <input class="input" type="email" id="su-email" autocomplete="email" required>
          </div>
          <div class="form-group">
            <label class="form-label">PASSWORD</label>
            <input class="input" type="password" id="su-pass" autocomplete="new-password" minlength="6" required>
          </div>
          <div class="auth-error" id="su-error"></div>
          <div class="auth-note" id="su-note"></div>
          <button class="btn btn-primary btn-full" type="submit" id="su-btn">CREATE ACCOUNT</button>
        </form>
      </div>
      <div class="auth-footer">Chrome required · Web MIDI · No account needed to use the <a href="play.html">2-player prototype</a></div>
    </div>
  `;

  // Tab switching
  function showTab(t) {
    mode = t;
    document.getElementById('form-signin').style.display = t === 'signin' ? '' : 'none';
    document.getElementById('form-signup').style.display = t === 'signup' ? '' : 'none';
    document.getElementById('tab-signin').classList.toggle('active', t === 'signin');
    document.getElementById('tab-signup').classList.toggle('active', t === 'signup');
  }
  document.getElementById('tab-signin').addEventListener('click', () => showTab('signin'));
  document.getElementById('tab-signup').addEventListener('click', () => showTab('signup'));

  // Sign in
  document.getElementById('form-signin').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('si-btn');
    const err = document.getElementById('si-error');
    err.textContent = '';
    btn.disabled = true; btn.textContent = '...';
    try {
      await signIn(
        document.getElementById('si-email').value.trim(),
        document.getElementById('si-pass').value,
      );
      // onAuthChange in app.js will take over
    } catch (ex) {
      err.textContent = friendlyAuthError(ex.message);
      btn.disabled = false; btn.textContent = 'SIGN IN';
    }
  });

  // Sign up
  document.getElementById('form-signup').addEventListener('submit', async e => {
    e.preventDefault();
    const btn  = document.getElementById('su-btn');
    const err  = document.getElementById('su-error');
    const note = document.getElementById('su-note');
    err.textContent = ''; note.textContent = '';
    btn.disabled = true; btn.textContent = '...';
    try {
      await signUp(
        document.getElementById('su-email').value.trim(),
        document.getElementById('su-pass').value,
        document.getElementById('su-name').value.trim(),
      );
      note.textContent = '✓ Account created — check your email to confirm, then sign in.';
      showTab('signin');
    } catch (ex) {
      err.textContent = friendlyAuthError(ex.message);
    } finally {
      btn.disabled = false; btn.textContent = 'CREATE ACCOUNT';
    }
  });
}

function friendlyAuthError(msg) {
  if (/invalid.*credential|invalid login/i.test(msg)) return 'Incorrect email or password.';
  if (/already.*registered|email.*exists/i.test(msg)) return 'An account with that email already exists.';
  if (/password.*short|password.*6/i.test(msg))       return 'Password must be at least 6 characters.';
  if (/email.*invalid/i.test(msg))                    return 'Please enter a valid email address.';
  return msg;
}
