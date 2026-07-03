import { supabase } from './supabase.js';

let currentUser = null;
let currentProfile = null;
const listeners = new Set();

export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  listeners.forEach((fn) => fn({ user: currentUser, profile: currentProfile }));
}

export async function initAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) {
    currentUser = session.user;
    await loadProfile();
  }
  notify();

  supabase.auth.onAuthStateChange(async (_event, session) => {
    currentUser = session?.user ?? null;
    if (currentUser) {
      await loadProfile();
    } else {
      currentProfile = null;
    }
    notify();
  });
}

async function loadProfile() {
  if (!currentUser) return;
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', currentUser.id)
    .single();
  currentProfile = data;
}

export function getUser() {
  return currentUser;
}

export function getProfile() {
  return currentProfile;
}

export function isModerator() {
  return currentProfile?.role === 'moderator' || currentProfile?.role === 'admin';
}

export async function signUp(email, password, username) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { username } },
  });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function requireAuth(redirectTo = 'login.html') {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    const returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `${redirectTo}?return=${returnUrl}`;
    return false;
  }
  return true;
}

export async function requireModerator(redirectTo = 'index.html') {
  if (!(await requireAuth())) return false;
  if (!isModerator()) {
    window.location.href = redirectTo;
    return false;
  }
  return true;
}

export async function getAccessToken() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

export async function updateProfile(updates) {
  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', currentUser.id)
    .select()
    .single();
  if (error) throw error;
  currentProfile = data;
  notify();
  return data;
}
