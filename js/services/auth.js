import { supabase } from './supabase.js';

// The URL Supabase sends users to after they click the email-confirmation
// link. Derived from the current page so it works whether served from
// /Band-Sync/ on GitHub Pages or from a local dev path. Sends people to
// index.html so the SPA's onAuthChange picks them up and lands them on
// home. Must also be allowed in the Supabase dashboard:
//   Authentication → URL Configuration → Site URL + Redirect URLs.
function getAuthRedirectUrl() {
  return new URL('index.html', location.href).href;
}

export async function signUp(email, password, displayName) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: displayName },
      emailRedirectTo: getAuthRedirectUrl(),
    },
  });
  if (error) throw error;
  return data.user;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export function onAuthChange(cb) {
  return supabase.auth.onAuthStateChange((event, session) => {
    // Only react to events that require a full auth state change
    if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') return;
    cb(session?.user ?? null);
  });
}
