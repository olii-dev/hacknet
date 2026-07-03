const DB_NAME = 'hacknet-thumbnails';
const STORE = 'blobs';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
