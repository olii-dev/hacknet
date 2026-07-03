import { getPreviewUrl } from './api.js';
import { getAccessToken } from './auth.js';
import { getSettings, initTheme } from './settings.js';

export function getBasePath() {
  const base = window.HACKNET_CONFIG?.basePath || '/';
  return base.endsWith('/') ? base : `${base}/`;
}

export function pageUrl(page, params = {}) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value != null && value !== '') qs.set(key, value);
  });
  const query = qs.toString();
  const file = page === 'index' ? 'index.html' : `${page}.html`;
  const path = `${getBasePath()}${file}`;
  return query ? `${path}?${query}` : path;
}

export function isCreatorUsername(username) {
  const creator = window.HACKNET_CONFIG?.creatorUsername || 'oli';
  return String(username || '').toLowerCase() === creator.toLowerCase();
}

export function creatorBadge(username) {
  if (!isCreatorUsername(username)) return '';
  return '<span class="badge badge-creator" title="Creator of Hacknet">Creator</span>';
}

export function creatorUsernameLabel(username) {
  const name = escapeHtml(username || 'unknown');
  if (!isCreatorUsername(username)) return `@${name}`;
  return `<span class="username-creator" title="Creator of Hacknet">@${name}</span>`;
}

export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function copyShareLink(url = window.location.href) {
  navigator.clipboard.writeText(url).then(
    () => showToast('Link copied to clipboard', 'success'),
    () => showToast('Could not copy link', 'error'),
  );
}

export function getFileIcon(mimeType) {
  if (!mimeType) return '📄';
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType.startsWith('audio/')) return '🎵';
  if (mimeType === 'application/pdf') return '📕';
  if (mimeType.includes('zip') || mimeType.includes('archive')) return '📦';
  if (mimeType.includes('text')) return '📝';
  return '📄';
}

function hasPreviewThumb(mimeType) {
  return mimeType?.startsWith('image/') || mimeType?.startsWith('video/');
}

function renderCardVisual(file, { hideThumbnails = false } = {}) {
  const icon = getFileIcon(file.mime_type);
  if (hideThumbnails) {
    return '';
  }

  if (!hasPreviewThumb(file.mime_type) || !file.id) {
    return `<div class="file-card-thumb file-card-thumb--icon"><span class="file-card-fallback">${icon}</span></div>`;
  }

  return `
    <div class="file-card-thumb" data-thumb-id="${file.id}" data-thumb-mime="${escapeHtml(file.mime_type || '')}">
      <span class="file-card-fallback" aria-hidden="true">${icon}</span>
    </div>
  `;
}

async function hydrateCardThumbnails(container) {
  const { hideThumbnails } = getSettings();
  if (hideThumbnails) return;

  const token = await getAccessToken();
  const extra = token ? { token } : {};

  const thumbs = container.querySelectorAll('[data-thumb-id]');
  thumbs.forEach((thumb) => {
    const fileId = thumb.dataset.thumbId;
    const mime = thumb.dataset.thumbMime || '';
    const url = getPreviewUrl(fileId, extra);
    const removeFallback = () => thumb.querySelector('.file-card-fallback')?.remove();

    if (mime.startsWith('video/')) {
      const video = document.createElement('video');
      video.src = url;
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.className = 'file-card-img';
      video.onloadeddata = removeFallback;
      video.onerror = () => video.remove();
      thumb.appendChild(video);
      return;
    }

    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.className = 'file-card-img';
    img.loading = 'lazy';
    img.onload = removeFallback;
    img.onerror = () => img.remove();
    thumb.appendChild(img);
  });
}

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function showToast(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

let navMenuBound = false;

function bindNavMenu(nav) {
  if (navMenuBound) return;
  navMenuBound = true;

  document.addEventListener('click', (e) => {
    const menu = nav.querySelector('.nav-user-menu');
    if (!menu) return;
    if (menu.contains(e.target)) {
      if (e.target.closest('#nav-user-btn')) {
        menu.classList.toggle('open');
      }
      return;
    }
    menu.classList.remove('open');
  });
}

export function renderNav(profile) {
  const nav = document.getElementById('site-nav');
  if (!nav) return;

  const authBlock = profile
    ? `
      <div class="nav-user-menu">
        <button type="button" class="nav-user-btn" id="nav-user-btn" aria-haspopup="true">
          @${escapeHtml(profile.username)} <span class="nav-chevron">▾</span>
        </button>
        <div class="nav-dropdown">
          <a href="${pageUrl('profile', { u: profile.username })}">Profile</a>
          <a href="${pageUrl('upload')}">Upload</a>
          <a href="${pageUrl('settings')}">Settings</a>
          ${profile.role === 'moderator' || profile.role === 'admin' ? `<a href="${pageUrl('moderation')}">Moderation</a>` : ''}
          <button type="button" id="logout-btn">Log out</button>
        </div>
      </div>
    `
    : `
      <a href="${pageUrl('settings')}" class="nav-icon-link" title="Settings">⚙️</a>
      <a href="${pageUrl('login')}">Log in</a>
      <a href="${pageUrl('signup')}" class="btn btn-primary btn-sm">Sign up</a>
    `;

  nav.innerHTML = `
    <a href="${pageUrl('index')}" class="logo">Hacknet</a>
    <div class="nav-links">
      <a href="${pageUrl('index')}">Discover</a>
      <a href="${pageUrl('search')}">Search</a>
      <a href="${pageUrl('collections')}">Collections</a>
      ${authBlock}
    </div>
  `;

  bindNavMenu(nav);

  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      const { signOut } = await import('./auth.js');
      await signOut();
      window.location.href = pageUrl('index');
    });
  }
}

export function renderFileCard(file, options = {}) {
  const username = file.profiles?.username || 'unknown';
  const hideThumbnails = options.hideThumbnails ?? getSettings().hideThumbnails;
  const tags = (file.tags || [])
    .map((t) => `<span class="tag tag-link" data-href="${escapeHtml(pageUrl('search', { tags: t }))}">${escapeHtml(t)}</span>`)
    .join('');

  return `
    <a href="${pageUrl('file', { id: file.id })}" class="file-card${hideThumbnails ? ' file-card--compact' : ''}">
      ${renderCardVisual(file, { hideThumbnails })}
      <div class="file-card-body">
        <h3>${escapeHtml(file.title)}</h3>
        <p class="file-meta">
          <span>${creatorUsernameLabel(username)}</span>
          <span>${formatBytes(file.size_bytes)}</span>
          <span>${Number(file.view_count) || 0} views</span>
          ${options.likeCount != null ? `<span>❤ ${options.likeCount}</span>` : ''}
          ${options.trendScore != null ? `<span>🔥 ${Number(options.trendScore).toFixed(1)}</span>` : ''}
        </p>
        ${tags ? `<div class="tags">${tags}</div>` : ''}
      </div>
    </a>
  `;
}

export async function renderFileGrid(files, container, options = {}) {
  if (!files?.length) {
    container.innerHTML = '<p class="empty-state">No files found.</p>';
    return;
  }
  const hideThumbnails = options.hideThumbnails ?? getSettings().hideThumbnails;
  container.classList.toggle('file-grid--compact', hideThumbnails);
  container.innerHTML = files
    .map((f) => renderFileCard(f, {
      likeCount: f.like_count,
      trendScore: f.trend_score,
      hideThumbnails,
      ...options,
    }))
    .join('');

  container.querySelectorAll('.tag-link').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.location.href = el.dataset.href;
    });
  });

  await hydrateCardThumbnails(container);
}

export function setLoading(container, message = 'Loading...') {
  container.innerHTML = `<p class="loading">${escapeHtml(message)}</p>`;
}

export function showError(container, message) {
  container.innerHTML = `<p class="error-state">${escapeHtml(message)}</p>`;
}

export async function initPage(callback) {
  initTheme();
  const { initAuth, onAuthChange, getProfile } = await import('./auth.js');
  await initAuth();
  renderNav(getProfile());
  onAuthChange(({ profile }) => renderNav(profile));
  if (callback) await callback();
}
