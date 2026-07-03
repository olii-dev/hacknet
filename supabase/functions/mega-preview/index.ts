import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { File } from 'npm:megajs@1';
import { Readable } from 'node:stream';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, range',
  'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
};

const BUFFER_LIMIT = 5 * 1024 * 1024;

function isPreviewableMime(mime: string) {
  return (
    mime.startsWith('image/') ||
    mime.startsWith('audio/') ||
    mime.startsWith('video/') ||
    mime === 'application/pdf'
  );
}

function isStreamableMime(mime: string) {
  return mime.startsWith('video/') || mime.startsWith('audio/');
}

function parseRange(rangeHeader: string | null, size: number): { start: number; end: number } | null {
  if (!rangeHeader || size <= 0) return null;
  const match = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return null;

  const start = Number(match[1]);
  let end = match[2] !== '' ? Number(match[2]) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size) {
    return null;
  }
  end = Math.min(end, size - 1);
  if (end < start) return null;
  return { start, end };
}

function buildHeaders(mime: string, filename: string, download: boolean, totalSize: number) {
  const disposition = download
    ? `attachment; filename="${filename.replace(/"/g, '')}"`
    : `inline; filename="${filename.replace(/"/g, '')}"`;

  const headers: Record<string, string> = {
    ...corsHeaders,
    'Content-Type': mime,
    'Content-Disposition': disposition,
    'Cache-Control': download ? 'private, max-age=0' : 'public, max-age=3600',
  };

  if (totalSize > 0 && isStreamableMime(mime)) {
    headers['Accept-Ranges'] = 'bytes';
  }

  return headers;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const fileId = url.searchParams.get('file_id');
    if (!fileId) {
      return new Response('Missing file_id', { status: 400, headers: corsHeaders });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const adminClient = createClient(supabaseUrl, serviceKey);

    const { data: file, error } = await adminClient
      .from('files')
      .select('mega_url, mime_type, status, filename, size_bytes')
      .eq('id', fileId)
      .single();

    if (error || !file) {
      return new Response('File not found', { status: 404, headers: corsHeaders });
    }

    if (!file.mega_url) {
      return new Response('File data is not available.', { status: 404, headers: corsHeaders });
    }

    if (file.status !== 'approved') {
      const token = url.searchParams.get('token') || req.headers.get('Authorization')?.replace('Bearer ', '');
      if (!token) {
        return new Response('Forbidden', { status: 403, headers: corsHeaders });
      }
      const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) {
        return new Response('Forbidden', { status: 403, headers: corsHeaders });
      }
    }

    const download = url.searchParams.get('download') === '1';
    const mime = file.mime_type || 'application/octet-stream';

    if (!isPreviewableMime(mime) && !download) {
      return new Response('Preview not supported', { status: 415, headers: corsHeaders });
    }

    const megaFile = File.fromURL(file.mega_url);
    await megaFile.loadAttributes();

    const totalSize = megaFile.size || file.size_bytes || 0;
    const filename = file.filename || 'download';
    const headers = buildHeaders(mime, filename, download, totalSize);

    if (req.method === 'HEAD') {
      if (totalSize > 0) headers['Content-Length'] = String(totalSize);
      return new Response(null, { headers });
    }

    const range = parseRange(req.headers.get('range'), totalSize);
    if (range && isStreamableMime(mime)) {
      const { start, end } = range;
      const chunkSize = end - start + 1;
      headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
      headers['Content-Length'] = String(chunkSize);

      const nodeStream = megaFile.download({ start, end: end + 1 });
      const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
      return new Response(webStream, { status: 206, headers });
    }

    if (req.headers.get('range') && totalSize > 0) {
      return new Response('Range not satisfiable', {
        status: 416,
        headers: { ...corsHeaders, 'Content-Range': `bytes */${totalSize}` },
      });
    }

    if (!isStreamableMime(mime) && totalSize > 0 && totalSize <= BUFFER_LIMIT) {
      const buffer = await megaFile.downloadBuffer({ start: 0, end: totalSize });
      headers['Content-Length'] = String(buffer.byteLength);
      return new Response(buffer, { headers });
    }

    if (totalSize > 0) headers['Content-Length'] = String(totalSize);

    const webStream = Readable.toWeb(megaFile.download()) as ReadableStream<Uint8Array>;
    return new Response(webStream, { headers });
  } catch (err) {
    return new Response(err.message || 'Preview failed', { status: 500, headers: corsHeaders });
  }
});
