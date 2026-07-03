import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export const MAX_BYTES = 1024 * 1024 * 1024;
export const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;

export const THUMBNAIL_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
export const PREVIEWABLE_TYPES = [
  ...THUMBNAIL_TYPES,
  'image/svg+xml',
  'application/pdf',
  'audio/mpeg', 'audio/wav', 'audio/ogg',
  'video/mp4', 'video/webm',
];
export const ALLOWED_TYPES = [
  ...PREVIEWABLE_TYPES,
  'text/plain', 'text/markdown', 'text/csv',
  'application/json', 'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
];

const BLOCKED_WORDS = ['nigger', 'nigga', 'faggot', 'fag', 'retard', 'kike', 'chink', 'cunt', 'rape', 'nazi', 'hitler'];

export function getStorageRoot() {
  return process.env.STORAGE_ROOT || '/plex-usb/hacknet';
}

export function getPublicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
}

export function containsProfanity(...texts) {
  const haystack = texts.filter(Boolean).join(' ').toLowerCase();
  return BLOCKED_WORDS.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(haystack));
}

export function friendlyError(message) {
  const raw = message || 'Upload failed';
  if (/enospc|no space left/i.test(raw)) {
    return 'The file server is out of disk space. Ask a moderator.';
  }
  if (/rate.?limit|too many/i.test(raw)) {
    return 'Too many uploads at once. Wait a minute and try again.';
  }
  return raw;
}

export function getAnonClient() {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error('Supabase is not configured on the file server.');
  return createClient(url, anon);
}

export function getUserClient(authHeader) {
  const client = getAnonClient();
  if (!authHeader) return client;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
}

export async function verifyUser(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const client = getUserClient(authHeader);
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) return null;
  return user;
}

export function parseAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || '*';
  if (raw.trim() === '*') return '*';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function corsHeaders(origin, allowed) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': '86400',
  };
  if (allowed === '*') {
    headers['Access-Control-Allow-Origin'] = '*';
  } else if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  return headers;
}

export function safePathInside(root, ...segments) {
  const resolved = path.resolve(root, ...segments);
  const rootResolved = path.resolve(root);
  if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
    throw new Error('Invalid file path.');
  }
  return resolved;
}

export function ensureStorageDirs(root) {
  fs.mkdirSync(safePathInside(root, 'files'), { recursive: true });
  fs.mkdirSync(safePathInside(root, 'thumbs'), { recursive: true });
}

export async function streamToFile(readStream, destPath, maxBytes) {
  let bytes = 0;
  const writeStream = fs.createWriteStream(destPath);
  readStream.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes + 1024) {
      readStream.destroy();
      writeStream.destroy();
      throw new Error('File is larger than allowed.');
    }
  });
  await pipeline(readStream, writeStream);
  return bytes;
}

export async function fetchFileRow(fileId, authHeader) {
  const client = authHeader ? getUserClient(authHeader) : getAnonClient();
  const { data, error } = await client
    .from('files')
    .select('id, uploader_id, filename, mime_type, size_bytes, status, storage_path, custom_thumbnail_url, mega_url')
    .eq('id', fileId)
    .single();
  if (error || !data) return null;
  return data;
}

export async function canAccessFile(fileRow, user, authHeader) {
  if (fileRow.status === 'approved') return true;
  if (!user) return false;
  if (fileRow.uploader_id === user.id) return true;
  const client = getUserClient(authHeader);
  const { data: profile } = await client
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  return profile?.role === 'admin' || profile?.role === 'moderator';
}

export function thumbPublicUrl(fileId) {
  const base = getPublicBaseUrl();
  return base ? `${base}/files/${fileId}/thumbnail` : `/files/${fileId}/thumbnail`;
}
