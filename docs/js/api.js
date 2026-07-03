import { supabase, getFunctionsUrl } from './supabase.js';
import { getAccessToken } from './auth.js';

const FILE_SELECT = `
  id, uploader_id, title, description, filename, mime_type,
  size_bytes, mega_url, mega_file_id, storage_path, custom_thumbnail_url, tags, status, view_count, created_at,
  profiles!files_uploader_id_fkey (username, avatar_url)
`;

export async function getRecentFiles(limit = 24) {
  const { data, error } = await supabase
    .from('files')
    .select(FILE_SELECT)
    .eq('status', 'approved')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

export async function getPopularFiles(limit = 24) {
  const { data, error } = await supabase.rpc('get_popular_files', { result_limit: limit });
  if (error) throw error;
  return enrichFiles(data);
}

export async function getTrendingFiles(limit = 24) {
  const { data, error } = await supabase.rpc('get_trending_files', { result_limit: limit });
  if (error) throw error;
  return enrichFiles(data);
}

async function enrichFiles(files) {
  if (!files?.length) return [];
  const ids = files.map((f) => f.uploader_id);
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, username, avatar_url')
    .in('id', ids);
  const profileMap = Object.fromEntries((profiles || []).map((p) => [p.id, p]));
  return files.map((f) => ({ ...f, profiles: profileMap[f.uploader_id] }));
}

export async function searchFiles(query, tags = [], options = {}) {
  const {
    limit = 50,
    offset = 0,
    mimePrefix = null,
    sortBy = 'relevance',
  } = options;

  const { data, error } = await supabase.rpc('search_files', {
    query: query || '',
    tag_filter: tags.length ? tags : null,
    mime_prefix: mimePrefix || null,
    sort_by: sortBy,
    result_limit: limit,
    result_offset: offset,
  });
  if (error) throw error;
  return enrichFiles(data);
}

export async function getPopularTags(limit = 16) {
  const { data, error } = await supabase.rpc('get_popular_tags', { result_limit: limit });
  if (error) throw error;
  return data || [];
}

export async function getFile(id) {
  const { data, error } = await supabase
    .from('files')
    .select(FILE_SELECT)
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

export async function incrementViews(id) {
  await supabase.rpc('increment_view_count', { file_uuid: id });
}

export async function getLikeCount(fileId) {
  const { count, error } = await supabase
    .from('likes')
    .select('*', { count: 'exact', head: true })
    .eq('file_id', fileId);
  if (error) throw error;
  return count;
}

export async function hasLiked(fileId, userId) {
  if (!userId) return false;
  const { data } = await supabase
    .from('likes')
    .select('file_id')
    .eq('file_id', fileId)
    .eq('user_id', userId)
    .maybeSingle();
  return !!data;
}

export async function toggleLike(fileId, userId, currentlyLiked) {
  if (currentlyLiked) {
    const { error } = await supabase.from('likes').delete().eq('file_id', fileId).eq('user_id', userId);
    if (error) throw error;
    return false;
  }
  const { error } = await supabase.from('likes').insert({ file_id: fileId, user_id: userId });
  if (error) throw error;
  return true;
}

export async function getComments(fileId) {
  const { data, error } = await supabase
    .from('comments')
    .select('id, body, created_at, profiles!comments_user_id_fkey (username, avatar_url)')
    .eq('file_id', fileId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

export async function addComment(fileId, userId, body) {
  const { data, error } = await supabase
    .from('comments')
    .insert({ file_id: fileId, user_id: userId, body })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function reportFile(fileId, reporterId, reason) {
  const { error } = await supabase.from('reports').insert({
    file_id: fileId,
    reporter_id: reporterId,
    reason,
  });
  if (error) throw error;
}

export async function getProfile(username) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('username', username)
    .single();
  if (error) throw error;
  return data;
}

export async function getUserFiles(userId, includeAll = false) {
  let query = supabase
    .from('files')
    .select(FILE_SELECT)
    .eq('uploader_id', userId)
    .order('created_at', { ascending: false });
  if (!includeAll) query = query.eq('status', 'approved');
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function getPublicCollections(limit = 50) {
  const { data, error } = await supabase
    .from('collections')
    .select('*, profiles!collections_user_id_fkey (username)')
    .eq('is_public', true)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

export async function getCollection(id) {
  const { data, error } = await supabase
    .from('collections')
    .select('*, profiles!collections_user_id_fkey (username)')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

export async function getCollectionFiles(collectionId) {
  const { data, error } = await supabase
    .from('collection_files')
    .select('file_id')
    .eq('collection_id', collectionId);
  if (error) throw error;
  if (!data?.length) return [];
  const fileIds = data.map((row) => row.file_id);
  const { data: files, error: fileError } = await supabase
    .from('files')
    .select(FILE_SELECT)
    .in('id', fileIds)
    .eq('status', 'approved');
  if (fileError) throw fileError;
  return files;
}

export async function getUserCollections(userId) {
  const { data, error } = await supabase
    .from('collections')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function createCollection(userId, { name, description, is_public }) {
  const { data, error } = await supabase
    .from('collections')
    .insert({ user_id: userId, name, description, is_public })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function addToCollection(collectionId, fileId) {
  const { error } = await supabase
    .from('collection_files')
    .insert({ collection_id: collectionId, file_id: fileId });
  if (error) throw error;
}

export async function getPendingFiles() {
  const { data, error } = await supabase
    .from('files')
    .select(FILE_SELECT)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

export async function getOpenReports() {
  const { data, error } = await supabase
    .from('reports')
    .select('*, files!inner (id, title, filename, status), profiles!reports_reporter_id_fkey (username)')
    .eq('status', 'open')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

export async function moderateFile(fileId, status) {
  const { error } = await supabase.from('files').update({ status }).eq('id', fileId);
  if (error) throw error;
}

export async function updateFile(fileId, updates) {
  const { title, description, tags, custom_thumbnail_url } = updates;
  if (title !== undefined || description !== undefined || tags !== undefined) {
    const { containsProfanity, profanityMessage } = await import('./profanity.js');
    const tagStr = Array.isArray(tags) ? tags.join(' ') : '';
    if (containsProfanity(title ?? '', description ?? '', tagStr)) {
      throw new Error(profanityMessage());
    }
  }

  const payload = {};
  if (updates.title != null) payload.title = String(updates.title).trim();
  if (updates.description != null) payload.description = String(updates.description).trim();
  if (updates.tags != null) payload.tags = updates.tags;
  if ('custom_thumbnail_url' in updates) payload.custom_thumbnail_url = updates.custom_thumbnail_url;

  const { data, error } = await supabase
    .from('files')
    .update(payload)
    .eq('id', fileId)
    .select(FILE_SELECT)
    .single();
  if (error) throw error;
  return data;
}

export async function uploadCoverImage(fileId, thumbnail) {
  const token = await getAccessToken();
  if (!token) throw new Error("You're not signed in. Log in and try again.");

  const formData = new FormData();
  formData.append('thumbnail', thumbnail);

  const api = getFilesApiUrl();
  const endpoint = api
    ? `${api}/files/${fileId}/cover`
    : `${getFunctionsUrl()}/mega-cover`;

  if (!api) {
    formData.append('file_id', fileId);
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Failed to update cover image');
  return body.file;
}

export async function resolveReport(reportId) {
  const { error } = await supabase.from('reports').update({ status: 'resolved' }).eq('id', reportId);
  if (error) throw error;
}

export async function getMegaStorageStats() {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');

  const res = await fetch(`${getFunctionsUrl()}/mega-stats`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Failed to load storage stats');
  return body;
}

export class UploadCancelledError extends Error {
  constructor() {
    super('Upload cancelled.');
    this.name = 'UploadCancelledError';
  }
}

export function formatUploadMbps(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '—';
  const mbps = (bytesPerSecond * 8) / (1024 * 1024);
  if (mbps >= 100) return `${Math.round(mbps)} Mbps`;
  if (mbps >= 10) return `${mbps.toFixed(1)} Mbps`;
  return `${mbps.toFixed(2)} Mbps`;
}

export function formatUploadError(err, fallback = 'Upload failed. Please try again.', context = {}) {
  if (err instanceof UploadCancelledError) return err.message;

  const raw = String(err?.message || err || '').trim();
  if (!raw) return fallback;

  const rules = [
    [/cancel/i, 'Upload cancelled.'],
    [/not authenticated|missing authorization|unauthorized/i, "You're not signed in. Log in and try again."],
    [/file and title are required/i, 'Please select a file and give it a title.'],
    [/file exceeds .*limit|too big/i, 'That file is too big. Hacknet allows uploads up to 15 MB.'],
    [/exceeded the maximum allowed size|payload too large|entity too large/i, 'That file is too large. Hacknet allows uploads up to 15 MB.'],
    [/file type not allowed/i, "That file type isn't supported. Try images, PDFs, zip, audio, video, or plain text."],
    [/cover image exceeds/i, 'Your cover image is too large.'],
    [/cover image must be/i, 'Cover images must be JPEG, PNG, GIF, or WebP.'],
    [/out of storage space|storage account is full/i, 'Hacknet is out of storage space right now. Try again later or ask a moderator.'],
    [/isn't configured yet/i, "Upload server isn't configured yet."],
    [/isn't supported/i, "That file type isn't supported. Try images, PDFs, zip, audio, video, or plain text."],
    [/could not save its details/i, 'Your file uploaded but we could not save its details. Please try again.'],
    [/storage login failed/i, 'Storage login failed on the server. Ask a moderator to check the Mega account settings.'],
    [/server stopped while saving|status.?546|worker.?resource|WORKER_RESOURCE|out of memory/i, 'That file is too large for our upload server. Hacknet allows uploads up to 15 MB — try a smaller file.'],
    [/timeout|timed out/i, 'The upload took too long and timed out. Try again on a faster connection or with a smaller file.'],
    [/413|payload too large|request entity too large/i, 'That file is too large. Hacknet allows uploads up to 15 MB.'],
    [/502|503|504|gateway/i, 'The upload server is busy or unavailable. Wait a moment and try again.'],
    [/500|internal server/i, 'Something went wrong on our end. Your file may not have been saved — please try again.'],
  ];

  if (context.phase === 'processing' && !raw) {
    return 'Your file finished uploading, but saving to Mega failed. Try again in a minute.';
  }

  for (const [pattern, message] of rules) {
    if (pattern.test(raw)) return message;
  }

  if (/network error|load failed|failed to fetch/i.test(raw)) {
    return context.phase === 'processing'
      ? 'Your file finished uploading, but the server stopped while saving to Mega. Try again in a minute.'
      : 'Your connection dropped while uploading. Check your internet and try again.';
  }

  return raw.endsWith('.') ? raw : `${raw}.`;
}

function getFilesApiUrl() {
  const config = window.HACKNET_CONFIG;
  return (config.filesApiUrl || config.uploadWorkerUrl || '').replace(/\/$/, '');
}

export function uploadFile(file, metadata, options = {}) {
  return uploadToMega(file, metadata, options);
}

function uploadToMega(file, metadata, options = {}) {
  const { onProgress, signal } = options;
  const endpoint = `${getFunctionsUrl()}/mega-upload`;

  return new Promise(async (resolve, reject) => {
    const token = await getAccessToken();
    if (!token) {
      reject(new Error("You're not signed in. Log in and try again."));
      return;
    }

    const formData = new FormData();
    formData.append('title', metadata.title);
    formData.append('description', metadata.description || '');
    formData.append('tags', JSON.stringify(metadata.tags || []));
    formData.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.responseType = 'text';

    let aborted = false;
    let phase = 'uploading';
    let lastLoaded = 0;
    let lastProgressAt = performance.now();
    let smoothedSpeed = 0;

    const emitProgress = (payload) => {
      phase = payload.phase || phase;
      onProgress?.(payload);
    };

    const speedFromDelta = (loaded) => {
      const now = performance.now();
      const elapsed = (now - lastProgressAt) / 1000;
      if (elapsed >= 0.15 && loaded > lastLoaded) {
        const instant = (loaded - lastLoaded) / elapsed;
        smoothedSpeed = smoothedSpeed ? smoothedSpeed * 0.75 + instant * 0.25 : instant;
        lastLoaded = loaded;
        lastProgressAt = now;
      }
      return smoothedSpeed;
    };

    const fail = (message) => {
      if (signal) signal.removeEventListener('abort', abortHandler);
      reject(new Error(formatUploadError({ message }, undefined, { phase })));
    };

    const abortHandler = () => {
      aborted = true;
      xhr.abort();
    };

    if (signal) {
      if (signal.aborted) {
        reject(new UploadCancelledError());
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    xhr.upload.addEventListener('progress', (event) => {
      if (!onProgress) return;
      const loaded = event.loaded;
      const total = event.lengthComputable ? event.total : file.size;
      const bytesPerSecond = speedFromDelta(loaded);
      const fileShare = file.size / total;
      const fileLoaded = Math.min(file.size, Math.round(loaded * fileShare));
      emitProgress({
        phase: 'uploading',
        loaded: fileLoaded,
        total: file.size,
        percent: (fileLoaded / file.size) * 92,
        bytesPerSecond,
      });
    });

    xhr.upload.addEventListener('load', () => {
      phase = 'processing';
      emitProgress({
        phase: 'processing',
        loaded: file.size,
        total: file.size,
        percent: 95,
        bytesPerSecond: 0,
      });
    });

    xhr.addEventListener('load', () => {
      if (signal) signal.removeEventListener('abort', abortHandler);
      let body = {};
      try {
        body = JSON.parse(xhr.responseText || '{}');
      } catch { /* ignore */ }

      if (xhr.status >= 200 && xhr.status < 300 && body.file) {
        emitProgress({
          phase: 'processing',
          loaded: file.size,
          total: file.size,
          percent: 100,
          bytesPerSecond: 0,
        });
        resolve(body.file);
        return;
      }

      if (xhr.status === 546) {
        fail('WORKER_RESOURCE_LIMIT');
        return;
      }

      const serverError = body.error || `Upload failed (${xhr.status || 'unknown'})`;
      fail(serverError);
    });

    xhr.addEventListener('error', () => {
      if (aborted) {
        if (signal) signal.removeEventListener('abort', abortHandler);
        reject(new UploadCancelledError());
        return;
      }
      fail('Network error');
    });

    xhr.addEventListener('abort', () => {
      if (signal) signal.removeEventListener('abort', abortHandler);
      reject(new UploadCancelledError());
    });

    xhr.send(formData);
  });
}

export function getDownloadUrl(fileId, filename = 'download', file = null) {
  const api = getFilesApiUrl();
  if (api && file?.storage_path) {
    const params = new URLSearchParams({ download: '1' });
    return `${api}/files/${fileId}?${params}`;
  }
  if (!file?.mega_url && file?.storage_path) {
    return '#';
  }
  const config = window.HACKNET_CONFIG;
  const params = new URLSearchParams({
    file_id: fileId,
    download: '1',
    apikey: config.supabaseAnonKey,
  });
  return `${getFunctionsUrl()}/mega-preview?${params}`;
}

export function getPreviewUrl(fileId, extraParams = {}, file = null) {
  const api = getFilesApiUrl();
  if (api && file?.storage_path) {
    const params = new URLSearchParams(extraParams);
    const qs = params.toString();
    return qs ? `${api}/files/${fileId}?${qs}` : `${api}/files/${fileId}`;
  }
  if (!file?.mega_url && file?.storage_path) {
    return '';
  }
  const config = window.HACKNET_CONFIG;
  const params = new URLSearchParams({
    file_id: fileId,
    apikey: config.supabaseAnonKey,
    ...extraParams,
  });
  return `${getFunctionsUrl()}/mega-preview?${params}`;
}
