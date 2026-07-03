const THEME_KEY = 'hacknet_theme';
const HIDE_THUMBNAILS_KEY = 'hacknet_hide_thumbnails';

export function getSettings() {
  return {
    theme: localStorage.getItem(THEME_KEY) || 'system',
    hideThumbnails: localStorage.getItem(HIDE_THUMBNAILS_KEY) === 'true',
  };
}

export function setTheme(theme) {
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
}

export function setHideThumbnails(hide) {
  localStorage.setItem(HIDE_THUMBNAILS_KEY, hide ? 'true' : 'false');
}

function resolveTheme(theme) {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme;
}

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', resolveTheme(theme));
}

let systemListenerBound = false;

export function initTheme() {
  const { theme } = getSettings();
  applyTheme(theme);

  if (!systemListenerBound) {
    systemListenerBound = true;
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getSettings().theme === 'system') applyTheme('system');
    });
  }
}
