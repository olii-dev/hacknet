const DB_NAME = 'hacknet-thumbnails';
const STORE = 'blobs';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BLOB_BYTES = 5 * 1024 * 1024;
const VIDEO_POSTER_TIMEOUT_MS = 15000;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function cacheKey(fileId, source) {
  return `${fileId}:${source}`;
}

export async function getCachedThumbnail(fileId, source = 'preview') {
  try {
    const db = await openDb();
    const key = cacheKey(fileId, source);
    const record = await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    if (!record || Date.now() - record.cachedAt > MAX_AGE_MS) return null;
    return URL.createObjectURL(record.blob);
  } catch {
    return null;
  }
}

export async function putCachedThumbnail(fileId, source, blob) {
  if (!blob || blob.size > MAX_BLOB_BYTES) return;
  try {
    const db = await openDb();
    const key = cacheKey(fileId, source);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ blob, cachedAt: Date.now() }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Cache write failed — non-fatal
  }
}

export async function resolveThumbnailUrl(fileId, fetchUrl, source = 'preview') {
  const cached = await getCachedThumbnail(fileId, source);
  if (cached) return cached;

  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error('Thumbnail fetch failed');

  const blob = await res.blob();
  await putCachedThumbnail(fileId, source, blob);
  return URL.createObjectURL(blob);
}

function captureVideoPoster(videoUrl) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';

    const finish = (blob) => {
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      resolve(blob);
    };

    const timer = setTimeout(() => finish(null), VIDEO_POSTER_TIMEOUT_MS);

    video.onloadeddata = () => {
      try {
        const w = video.videoWidth || 320;
        const h = video.videoHeight || 180;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d')?.drawImage(video, 0, 0, w, h);
        canvas.toBlob((blob) => finish(blob), 'image/jpeg', 0.82);
      } catch {
        finish(null);
      }
    };
    video.onerror = () => finish(null);
    video.src = videoUrl;
  });
}

/** Cached JPEG poster for video cards (avoids re-fetching from Mega on every visit). */
export async function resolveVideoPosterUrl(fileId, videoUrl) {
  const cached = await getCachedThumbnail(fileId, 'video-poster');
  if (cached) return cached;

  const poster = await captureVideoPoster(videoUrl);
  if (!poster) return null;

  await putCachedThumbnail(fileId, 'video-poster', poster);
  return URL.createObjectURL(poster);
}

export async function clearThumbnailCache() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}
