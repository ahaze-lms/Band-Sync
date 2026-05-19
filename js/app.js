import { onAuthChange, signOut } from './services/auth.js';
import { getProfile, setOnline } from './services/profile.js';
import { subscribeToInbox, getPendingIncoming, getUnreadCount } from './services/social.js';

import { mount as mountAuth }        from './screens/auth.js';
import { mount as mountHome }        from './screens/home.js';
import { mount as mountProfileEdit } from './screens/profile-edit.js?v=5';
import { mount as mountFriends }     from './screens/friends.js';
import { mount as mountInbox }       from './screens/inbox.js?v=2';
import { mount as mountHistory }     from './screens/history.js';

const app   = document.getElementById('app');
const nav   = document.getElementById('main-nav');
const main  = document.getElementById('main-content');

let ctx = { user: null, profile: null };
let currentScreen = null;
let unsubInbox = null;

// ── NAVIGATION ────────────────────────────────────────────────────

const SCREENS = {
  home:    mountHome,
  profile: mountProfileEdit,
  friends: mountFriends,
  inbox:   mountInbox,
  history: mountHistory,
};

export function navigate(screen, params = {}) {
  if (currentScreen?.destroy) currentScreen.destroy();
  main.innerHTML = '';
  const mounter = SCREENS[screen];
  if (mounter) currentScreen = mounter(main, ctx, navigate, params) ?? {};
  setActiveNav(screen);
}

function setActiveNav(screen) {
  nav.querySelectorAll('.nav-link').forEach(el => {
    el.classList.toggle('active', el.dataset.screen === screen);
  });
}

// ── NAV BAR ───────────────────────────────────────────────────────

function renderNav() {
  nav.style.display = 'flex';
  nav.innerHTML = `
    <a class="nav-logo" data-screen="home" href="#">BAND<span>SYNC</span></a>
    <div class="nav-links">
      <a class="nav-link" data-screen="home"    href="#">HOME</a>
      <a class="nav-link" data-screen="friends" href="#">FRIENDS <span class="badge" id="badge-friends"></span></a>
      <a class="nav-link" data-screen="inbox"   href="#">INBOX   <span class="badge" id="badge-inbox"></span></a>
      <a class="nav-link" data-screen="history" href="#">HISTORY</a>
      <a class="nav-link" href="studio.html">STUDIO</a>
      <a class="nav-link nav-lab" href="lab.html" target="_blank">DEV LAB</a>
    </div>
    <div class="nav-right">
      <a class="nav-avatar" data-screen="profile" href="#" title="Edit profile">
        <span id="nav-avatar-icon">${avatarEmoji(ctx.profile?.avatar)}</span>
      </a>
      <button class="btn-signout" id="btn-signout">SIGN OUT</button>
    </div>
  `;
  nav.querySelectorAll('[data-screen]').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); navigate(el.dataset.screen); });
  });
  nav.querySelector('#btn-signout').addEventListener('click', async () => {
    if (ctx.user) await setOnline(ctx.user.id, false);
    await signOut();
  });
  refreshBadges();
}

export async function refreshBadges() {
  if (!ctx.user) return;
  const [incoming, unread] = await Promise.all([
    getPendingIncoming(ctx.user.id),
    getUnreadCount(ctx.user.id),
  ]);
  const bf = document.getElementById('badge-friends');
  const bi = document.getElementById('badge-inbox');
  if (bf) { bf.textContent = incoming.length || ''; bf.style.display = incoming.length ? '' : 'none'; }
  if (bi) { bi.textContent = unread || ''; bi.style.display = unread ? '' : 'none'; }
}

export async function refreshProfile() {
  if (!ctx.user) return;
  ctx.profile = await getProfile(ctx.user.id);
  const icon = document.getElementById('nav-avatar-icon');
  if (icon) icon.textContent = avatarEmoji(ctx.profile?.avatar);
}

// ── AUTH STATE ────────────────────────────────────────────────────

// Fallback: if onAuthChange never fires (e.g. Supabase init failure),
// show the auth screen after 3 seconds so the page isn't permanently blank.
const initTimeout = setTimeout(() => {
  if (main.innerHTML === '') {
    console.error('BandSync: onAuthChange did not fire within 3s — showing auth screen as fallback');
    mountAuth(main, navigate);
  }
}, 3000);

onAuthChange(async user => {
  clearTimeout(initTimeout);
  try {
    // Clean up previous session
    if (unsubInbox) { unsubInbox(); unsubInbox = null; }
    if (currentScreen?.destroy) currentScreen.destroy();
    main.innerHTML = '<div class="loading-screen">LOADING...</div>';

    if (!user) {
      ctx = { user: null, profile: null };
      nav.style.display = 'none';
      currentScreen = mountAuth(main, navigate) ?? {};
      return;
    }

    ctx.user = user;

    // Load profile with a visible timeout — if Supabase is unreachable this surfaces the real error
    try {
      ctx.profile = await Promise.race([
        getProfile(user.id),
        new Promise((_, rej) => setTimeout(
          () => rej(new Error('Supabase query timed out (8 s). Check: is your project paused? Is the anon key correct? Open Network tab (F12) to see the request.')),
          8000
        )),
      ]);
    } catch (err) {
      console.error('BandSync: getProfile failed —', err);
      // PGRST116 = "no rows" — profile simply doesn't exist yet, that's fine
      if (err?.code === 'PGRST116' || err?.details?.includes?.('0 rows')) {
        ctx.profile = null;
      } else {
        // Real connectivity / auth / RLS problem — show it on-screen
        main.innerHTML = errorScreen('SUPABASE ERROR', err.message,
          'Open DevTools → Network tab and look for a red request to supabase.co to see the full response.');
        return;
      }
    }

    renderNav();

    // Set online presence (best-effort — don't block on failure)
    setOnline(user.id, true).catch(() => {});
    window.addEventListener('beforeunload', () => setOnline(user.id, false));

    // Subscribe to real-time inbox events
    unsubInbox = subscribeToInbox(user.id, {
      onMessage: () => refreshBadges(),
      onPlayInvite: () => refreshBadges(),
      onFriendRequest: () => refreshBadges(),
    });

    // New user needs to pick a username
    if (!ctx.profile?.username) {
      currentScreen = mountProfileEdit(main, ctx, navigate, { onboarding: true }) ?? {};
      setActiveNav('profile');
    } else {
      navigate('home');
    }
  } catch (err) {
    console.error('BandSync: auth handler error', err);
    main.innerHTML = errorScreen('STARTUP ERROR', err.message, 'Check the browser console (F12) for the full stack trace.');
  }
});

// ── HELPERS ───────────────────────────────────────────────────────

export const AVATARS = {
  piano: '🎹', drums: '🥁', guitar: '🎸', trumpet: '🎺',
  violin: '🎻', note: '🎵', mic: '🎤', star: '⭐',
};

export const ACCENT_COLORS = [
  { name: 'purple', label: 'Purple', stroke: '#7F77DD', accent: '#AFA9EC', fill: '#534AB7' },
  { name: 'teal',   label: 'Teal',   stroke: '#1D9E75', accent: '#5DCAA5', fill: '#0F6E56' },
  { name: 'amber',  label: 'Amber',  stroke: '#BA7517', accent: '#EF9F27', fill: '#854F0B' },
  { name: 'red',    label: 'Red',    stroke: '#E24B4A', accent: '#F09595', fill: '#8B2A29' },
];

export function avatarEmoji(slug) { return AVATARS[slug] ?? '🎵'; }

export function accentFor(colorName) {
  return ACCENT_COLORS.find(c => c.name === colorName) ?? ACCENT_COLORS[0];
}

export function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function errorScreen(title, message, hint = '') {
  return `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                height:100%;gap:16px;font-family:'Space Mono',monospace;padding:24px;text-align:center">
      <div style="color:#E24B4A;font-size:13px;letter-spacing:3px">${esc(title)}</div>
      <div style="background:#0d0d1a;border:1px solid #2a2a40;border-radius:8px;padding:16px 24px;
                  max-width:600px;width:100%">
        <pre style="color:#c8c8d8;font-size:11px;white-space:pre-wrap;text-align:left;margin:0">${esc(message)}</pre>
      </div>
      ${hint ? `<div style="color:#55556a;font-size:10px;letter-spacing:1px">${esc(hint)}</div>` : ''}
      <button onclick="location.reload()"
        style="padding:8px 20px;background:transparent;border:1px solid #2a2a40;color:#55556a;
               border-radius:6px;cursor:pointer;font-family:inherit;font-size:10px;letter-spacing:2px;
               transition:all 0.15s" onmouseover="this.style.borderColor='#7F77DD';this.style.color='#AFA9EC'"
               onmouseout="this.style.borderColor='#2a2a40';this.style.color='#55556a'">
        RETRY
      </button>
    </div>`;
}
