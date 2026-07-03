import { getPreviewUrl, getDownloadUrl } from './api.js';
import { getAccessToken } from './auth.js';
import { getFileIcon } from './ui.js';

export async function renderPreview(file, container) {
  const mime = file.mime_type || '';
  const icon = getFileIcon(mime);

  if (mime.startsWith('image/')) {
    const url = await authenticatedPreviewUrl(file);
    container.innerHTML = `<img src="${url}" alt="${file.title}" class="preview-image" loading="lazy">`;
    return;
  }

  if (mime === 'application/pdf') {
    const url = await authenticatedPreviewUrl(file);
    container.innerHTML = `<iframe src="${url}" class="preview-pdf" title="PDF preview"></iframe>`;
    return;
  }

  if (mime.startsWith('audio/')) {
    const url = await authenticatedPreviewUrl(file);
    container.innerHTML = `<audio controls src="${url}" class="preview-audio"></audio>`;
    return;
  }

  if (mime.startsWith('video/')) {
    const url = await authenticatedPreviewUrl(file);
    container.innerHTML = `<video controls class="preview-video" preload="metadata"><source src="${url}" type="${mime}">Your browser can't play this video format — use Download instead.</video>`;
    return;
  }

  container.innerHTML = `
    <div class="preview-fallback">
      <span class="preview-fallback-icon">${icon}</span>
      <p>Preview not available for this file type.</p>
      <a href="${getDownloadUrl(file.id, file.filename, file)}" class="btn btn-primary" download>Download</a>
    </div>
  `;
}

async function authenticatedPreviewUrl(file) {
  if (!file.mega_url && file.storage_path) {
    throw new Error('This file is stored on an old server that is no longer available.');
  }
  const token = await getAccessToken();
  const extra = token ? { token } : {};
  const url = getPreviewUrl(file.id, extra, file);
  if (!url) throw new Error('Preview is not available for this file.');
  return url;
}
