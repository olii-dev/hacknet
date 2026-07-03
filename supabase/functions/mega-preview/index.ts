import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { File } from 'npm:megajs@1';
import { Readable } from 'node:stream';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function isPreviewableMime(mime: string) {
  return (
    mime.startsWith('image/') ||
    mime.startsWith('audio/') ||
    mime.startsWith('video/') ||
    mime === 'application/pdf'
  );
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

    const disposition = download
      ? `attachment; filename="${file.filename.replace(/"/g, '')}"`
      : `inline; filename="${file.filename.replace(/"/g, '')}"`;

    const headers: Record<string, string> = {
      ...corsHeaders,
      'Content-Type': mime,
      'Content-Disposition': disposition,
      'Cache-Control': download ? 'private, max-age=0' : 'public, max-age=3600',
    };

    const size = megaFile.size || file.size_bytes || 0;
    if (size > 0) headers['Content-Length'] = String(size);

    // Stream large files — buffering blows Edge memory limits (HTTP 546).
    const webStream = Readable.toWeb(megaFile.download()) as ReadableStream<Uint8Array>;
    return new Response(webStream, { headers });
  } catch (err) {
    return new Response(err.message || 'Preview failed', { status: 500, headers: corsHeaders });
  }
});
