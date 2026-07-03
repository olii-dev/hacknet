import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Busboy from 'busboy';
import {
  isAllowedMime,
  isPreviewableMime,
  MAX_BYTES,
  MAX_THUMBNAIL_BYTES,
  THUMBNAIL_TYPES,
  canAccessFile,
  containsProfanity,
  corsHeaders,
  ensureStorageDirs,
  fetchFileRow,
  friendlyError,
  getPublicBaseUrl,
  getStorageRoot,
  getUserClient,
  parseAllowedOrigins,
  safePathInside,
  streamToFile,
  thumbPublicUrl,
  verifyUser,
} from './lib.mjs';

const PORT = Number(process.env.PORT || 8080);
const STORAGE_ROOT = getStorageRoot();
const allowedOrigins = parseAllowedOrigins();

ensureStorageDirs(STORAGE_ROOT);

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendFile(res, filePath, mimeType, filename, download, extraHeaders = {}) {
  const stat = fs.statSync(filePath);
  const disposition = download
    ? `attachment; filename="${filename.replace(/"/g, '')}"`
    : `inline; filename="${filename.replace(/"/g, '')}"`;

  res.writeHead(200, {
    'Content-Type': mimeType || 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': disposition,
    'Cache-Control': download ? 'private, max-age=0' : 'public, max-age=3600',
    ...extraHeaders,
  });
  fs.createReadStream(filePath).pipe(res);
}

async function handleUpload(req, res, origin) {
  const headers = corsHeaders(origin, allowedOrigins);

  const user = await verifyUser(req.headers.authorization);
  if (!user) {
    return sendJson(res, 401, { error: "You're not signed in. Log in and try again." }, headers);
  }
  const userClient = getUserClient(req.headers.authorization);

  const fields = {};
  let filePart = null;
  let thumbnailBuffer = null;

  await new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: req.headers,
      limits: { files: 2, fileSize: MAX_BYTES + MAX_THUMBNAIL_BYTES },
    });

    busboy.on('field', (name, value) => { fields[name] = value; });

    busboy.on('file', (fieldname, stream, info) => {
      if (fieldname === 'thumbnail') {
        const chunks = [];
        let size = 0;
        stream.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_THUMBNAIL_BYTES) {
            stream.destroy();
            reject(new Error('Your cover image is too large. Keep it under 5 MB.'));
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', () => { thumbnailBuffer = Buffer.concat(chunks); });
        stream.on('error', reject);
        return;
      }

      if (fieldname === 'file') {
        filePart = {
          stream,
          filename: path.basename(info.filename || 'upload.bin'),
          mimeType: info.mimeType || 'application/octet-stream',
        };
        stream.pause();
      }
    });

    busboy.on('error', reject);
    busboy.on('finish', resolve);
    req.pipe(busboy);
  });

  try {
    if (!filePart) {
      return sendJson(res, 400, { error: 'Please select a file.' }, headers);
    }

    const title = String(fields.title || '').trim();
    const description = String(fields.description || '').trim();
    const mimeType = String(fields.mime_type || filePart.mimeType || 'application/octet-stream');
    const sizeBytes = Number(fields.size_bytes);
    let tags = [];
    try { tags = JSON.parse(fields.tags || '[]'); } catch { tags = []; }

    if (!title) return sendJson(res, 400, { error: 'Please give your file a title.' }, headers);
    if (!Number.isFinite(sizeBytes) || sizeBytes < 1) {
      return sendJson(res, 400, { error: 'Invalid file size.' }, headers);
    }
    if (sizeBytes > MAX_BYTES) {
      return sendJson(res, 400, { error: 'That file is too big. Hacknet allows uploads up to 1 GB.' }, headers);
    }
    if (!isAllowedMime(mimeType)) {
      return sendJson(res, 400, { error: `That file type isn't supported (${mimeType || 'unknown'}).` }, headers);
    }
    if (containsProfanity(title, description, ...(Array.isArray(tags) ? tags : []))) {
      return sendJson(res, 400, { error: "Your upload contains language that isn't allowed on Hacknet." }, headers);
    }
    if (thumbnailBuffer?.length) {
      const thumbType = fields.thumbnail_type || 'image/jpeg';
      if (!THUMBNAIL_TYPES.includes(thumbType)) {
        return sendJson(res, 400, { error: 'Cover images must be JPEG, PNG, GIF, or WebP.' }, headers);
      }
    }

    const fileId = randomUUID();
    const fileDir = safePathInside(STORAGE_ROOT, 'files', fileId);
    fs.mkdirSync(fileDir, { recursive: true });
    const destPath = safePathInside(fileDir, filePart.filename);

    filePart.stream.resume();
    const written = await streamToFile(filePart.stream, destPath, sizeBytes);
    if (written !== sizeBytes) {
      fs.rmSync(fileDir, { recursive: true, force: true });
      return sendJson(res, 400, { error: 'Uploaded file size did not match. Try again.' }, headers);
    }

    const storagePath = `${fileId}/${filePart.filename}`;
    let customThumbnailUrl = null;

    if (thumbnailBuffer?.length) {
      const ext = (fields.thumbnail_type || 'image/jpeg').split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
      const thumbPath = safePathInside(STORAGE_ROOT, 'thumbs', `${fileId}.${ext}`);
      fs.writeFileSync(thumbPath, thumbnailBuffer);
      customThumbnailUrl = thumbPublicUrl(fileId);
    }

    const autoApprove = process.env.AUTO_APPROVE === 'true';
    const { data: fileRow, error: dbError } = await userClient
      .from('files')
      .insert({
        id: fileId,
        uploader_id: user.id,
        title,
        description,
        filename: filePart.filename,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        storage_path: storagePath,
        mega_url: null,
        mega_file_id: null,
        custom_thumbnail_url: customThumbnailUrl,
        tags: Array.isArray(tags) ? tags : [],
        status: autoApprove ? 'approved' : 'pending',
      })
      .select()
      .single();

    if (dbError) {
      fs.rmSync(fileDir, { recursive: true, force: true });
      return sendJson(res, 500, { error: 'Your file uploaded but we could not save its details. Please try again.' }, headers);
    }

    return sendJson(res, 200, { file: fileRow }, headers);
  } catch (err) {
    console.error('Upload failed:', err);
    return sendJson(res, 500, { error: friendlyError(err?.message || 'Upload failed') }, headers);
  }
}

async function handleCoverUpload(req, res, fileId, origin) {
  const headers = corsHeaders(origin, allowedOrigins);
  const user = await verifyUser(req.headers.authorization);
  if (!user) return sendJson(res, 401, { error: "You're not signed in." }, headers);

  const fileRow = await fetchFileRow(fileId, req.headers.authorization);
  if (!fileRow || fileRow.uploader_id !== user.id) {
    return sendJson(res, 404, { error: 'File not found.' }, headers);
  }
  if (!fileRow.storage_path) {
    return sendJson(res, 400, { error: 'This file is not stored on the local server.' }, headers);
  }

  let thumbBuffer = null;
  let thumbType = 'image/jpeg';

  await new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_THUMBNAIL_BYTES } });
    busboy.on('file', (name, stream, info) => {
      thumbType = info.mimeType || 'image/jpeg';
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => { thumbBuffer = Buffer.concat(chunks); });
      stream.on('error', reject);
    });
    busboy.on('finish', resolve);
    busboy.on('error', reject);
    req.pipe(busboy);
  });

  if (!thumbBuffer?.length || !THUMBNAIL_TYPES.includes(thumbType)) {
    return sendJson(res, 400, { error: 'Cover images must be JPEG, PNG, GIF, or WebP.' }, headers);
  }

  const ext = thumbType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
  const thumbPath = safePathInside(STORAGE_ROOT, 'thumbs', `${fileId}.${ext}`);
  fs.writeFileSync(thumbPath, thumbBuffer);
  const customThumbnailUrl = thumbPublicUrl(fileId);

  const { data, error } = await getUserClient(req.headers.authorization)
    .from('files')
    .update({ custom_thumbnail_url: customThumbnailUrl })
    .eq('id', fileId)
    .select()
    .single();

  if (error) return sendJson(res, 500, { error: 'Could not update cover image.' }, headers);
  return sendJson(res, 200, { file: data }, headers);
}

async function handleFileGet(req, res, fileId, origin, { thumbnail = false } = {}) {
  const headers = corsHeaders(origin, allowedOrigins);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const download = url.searchParams.get('download') === '1';

  const user = await verifyUser(req.headers.authorization);
  const fileRow = await fetchFileRow(fileId, req.headers.authorization);
  if (!fileRow) return sendJson(res, 404, { error: 'File not found.' }, headers);

  if (!(await canAccessFile(fileRow, user, req.headers.authorization))) {
    return sendJson(res, 403, { error: 'Forbidden.' }, headers);
  }

  if (thumbnail) {
    const thumbDir = safePathInside(STORAGE_ROOT, 'thumbs');
    const matches = fs.readdirSync(thumbDir).filter((f) => f.startsWith(`${fileId}.`));
    if (!matches.length) return sendJson(res, 404, { error: 'No thumbnail.' }, headers);
    const thumbPath = safePathInside(thumbDir, matches[0]);
    const mime = matches[0].endsWith('.png') ? 'image/png' : 'image/jpeg';
    return sendFile(res, thumbPath, mime, matches[0], false, headers);
  }

  if (!fileRow.storage_path) {
    return sendJson(res, 404, { error: 'File is stored externally (legacy Mega upload).' }, headers);
  }

  if (!download && !isPreviewableMime(fileRow.mime_type)) {
    return sendJson(res, 415, { error: 'Preview not supported for this file type.' }, headers);
  }

  const diskPath = safePathInside(STORAGE_ROOT, 'files', fileRow.storage_path);
  if (!fs.existsSync(diskPath)) {
    return sendJson(res, 404, { error: 'File data missing on server.' }, headers);
  }

  return sendFile(res, diskPath, fileRow.mime_type, fileRow.filename, download, headers);
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const headers = corsHeaders(origin, allowedOrigins);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    let diskFree = null;
    try {
      fs.statfsSync(STORAGE_ROOT);
      diskFree = 'ok';
    } catch { diskFree = 'error'; }
    sendJson(res, 200, {
      ok: true,
      service: 'hacknet-files',
      storage_root: STORAGE_ROOT,
      public_base_url: getPublicBaseUrl() || null,
      disk: diskFree,
    }, headers);
    return;
  }

  const fileMatch = req.url?.match(/^\/files\/([0-9a-f-]{36})(?:\/(thumbnail))?(?:\?.*)?$/i);
  if (req.method === 'GET' && fileMatch) {
    await handleFileGet(req, res, fileMatch[1], origin, { thumbnail: fileMatch[2] === 'thumbnail' });
    return;
  }

  const coverMatch = req.url?.match(/^\/files\/([0-9a-f-]{36})\/cover$/i);
  if (req.method === 'POST' && coverMatch) {
    await handleCoverUpload(req, res, coverMatch[1], origin);
    return;
  }

  if (req.method === 'POST' && req.url === '/upload') {
    await handleUpload(req, res, origin);
    return;
  }

  sendJson(res, 404, { error: 'Not found' }, headers);
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;

server.listen(PORT, () => {
  console.log(`Hacknet file server listening on :${PORT}`);
  console.log(`Storage: ${STORAGE_ROOT}`);
});
