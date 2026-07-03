import { getPreviewUrl, getDownloadUrl } from './api.js';
import { getAccessToken } from './auth.js';
import { getFileIcon } from './ui.js';

export async function renderPreview(file, container) {
  const mime = file.mime_type || '';
  const icon = getFileIcon(mime);

  if (mime.startsWith('image/')) {
    const url = await authenticatedPreviewUrl(file.id);
    container.innerHTML = `<img src="${url}" alt="${file.title}" class="preview-image" loading="lazy">`;
    return;
  }

  if (mime === 'application/pdf') {
    const url = await authenticatedPreviewUrl(file.id);
    container.innerHTML = `<iframe src="${url}" class="preview-pdf" title="PDF preview"></iframe>`;
    return;
  }

  if (mime.startsWith('audio/')) {
    const url = await authenticatedPreviewUrl(file.id);
    container.innerHTML = `<audio controls src="${url}" class="preview-audio"></audio>`;
    return;
  }

  if (mime.startsWith('video/')) {
    const url = await authenticatedPreviewUrl(file.id);
    container.innerHTML = `<video controls src="${url}" class="preview-video"></video>`;
    return;
  }

  container.innerHTML = `
    <div class="preview-fallback">
      <span class="preview-fallback-icon">${icon}</span>
      <p>Preview not available for this file type.</p>
      <a href="${getDownloadUrl(file.id, file.filename)}" class="btn btn-primary" download>Download</a>
    </div>
  `;
}

async function authenticatedPreviewUrl(fileId) {
  const token = await getAccessToken();
  const extra = token ? { token } : {};
  return getPreviewUrl(fileId, extra);
}
