import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { Storage } from 'npm:megajs@1';
import {
  type AssembleMegaState,
  connectHacknetFolder,
  finalizeMegaFile,
} from './_shared/mega-resumable.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const THUMBNAIL_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

type MegaAccount = { email: string; password: string };

function loadMegaAccounts(): MegaAccount[] {
  const json = Deno.env.get('MEGA_ACCOUNTS');
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.filter((a) => a?.email && a?.password);
      }
    } catch { /* fall through */ }
  }
  const accounts: MegaAccount[] = [];
  const primaryEmail = Deno.env.get('MEGA_EMAIL');
  const primaryPassword = Deno.env.get('MEGA_PASSWORD');
  if (primaryEmail && primaryPassword) accounts.push({ email: primaryEmail, password: primaryPassword });
  for (let i = 2; i <= 10; i++) {
    const email = Deno.env.get(`MEGA_EMAIL_${i}`);
    const password = Deno.env.get(`MEGA_PASSWORD_${i}`);
    if (email && password) accounts.push({ email, password });
  }
  return accounts;
}

async function connectMega(account: MegaAccount) {
  const storage = await new Storage({
    email: account.email,
    password: account.password,
    keepalive: false,
  }).ready;
  if (!storage?.root) throw new Error('Mega login failed to initialize storage root.');
  return storage;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const autoApprove = Deno.env.get('AUTO_APPROVE') === 'true';
    const megaAccounts = loadMegaAccounts();
    if (!megaAccounts.length) {
      return json({ error: "Uploads aren't configured on the server yet. Ask a moderator." }, 500);
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: "You're not signed in. Log in and try again." }, 401);

    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return json({ error: "You're not signed in. Log in and try again." }, 401);

    const body = await req.json();
    const sessionId = body.session_id as string;
    if (!sessionId) return json({ error: 'Missing session.' }, 400);

    const adminClient = createClient(supabaseUrl, serviceKey);
    const { data: session, error: sessionError } = await adminClient
      .from('upload_sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('user_id', user.id)
      .single();

    if (sessionError || !session) return json({ error: 'Upload session not found.' }, 404);
    if (session.completed_at && session.result_file_id) {
      const { data: fileRow } = await adminClient
        .from('files')
        .select('*')
        .eq('id', session.result_file_id)
        .single();
      return json({ status: 'complete', file: fileRow });
    }
    if (new Date(session.expires_at) < new Date()) {
      return json({ error: 'Upload session expired. Try uploading again.' }, 400);
    }

    const megaState = session.assemble_mega_state as AssembleMegaState | null;
    if (!megaState?.uploadHashB64) {
      return json({ error: 'File data has not finished uploading to Mega yet.' }, 400);
    }
    if (megaState.transfer.bytesUploaded < megaState.transfer.totalCiphertextSize) {
      return json({ error: 'Mega upload is incomplete.' }, 400);
    }

    const account = megaAccounts[session.mega_account_index ?? 0] || megaAccounts[0];
    const storage = await connectMega(account);
    const folder = await connectHacknetFolder(storage);
    const uploaded = await finalizeMegaFile(storage, folder, session.filename, megaState);
    const megaUrl = await uploaded.link({});
    const megaFileId = uploaded.nodeId || uploaded.id || null;

    let customThumbnailUrl: string | null = null;
    const thumbB64 = body.thumbnail_b64 as string | undefined;
    const thumbType = (body.thumbnail_type as string) || 'image/jpeg';
    if (thumbB64 && THUMBNAIL_TYPES.includes(thumbType)) {
      const thumbBytes = Uint8Array.from(atob(thumbB64), (c) => c.charCodeAt(0));
      if (thumbBytes.byteLength <= 5 * 1024 * 1024) {
        const thumbUploaded = await folder.upload(
          { name: `cover-${Date.now()}-${session.filename}`, size: thumbBytes.byteLength },
          thumbBytes,
        ).complete;
        customThumbnailUrl = await thumbUploaded.link({});
      }
    }

    const { data: fileRow, error: dbError } = await adminClient.from('files').insert({
      uploader_id: user.id,
      title: session.title,
      description: session.description || '',
      filename: session.filename,
      mime_type: session.mime_type || 'application/octet-stream',
      size_bytes: session.size_bytes,
      mega_url: megaUrl,
      mega_file_id: megaFileId,
      mega_account_index: session.mega_account_index,
      custom_thumbnail_url: customThumbnailUrl,
      tags: session.tags || [],
      status: autoApprove ? 'approved' : 'pending',
    }).select().single();

    if (dbError) {
      return json({ error: 'Your file uploaded but we could not save its details. Please try again.' }, 500);
    }

    await adminClient.from('upload_sessions').update({
      completed_at: new Date().toISOString(),
      assemble_status: 'complete',
      assemble_error: null,
      assemble_stage: 'complete',
      assemble_updated_at: new Date().toISOString(),
      result_file_id: fileRow.id,
    }).eq('id', sessionId);

    return json({ status: 'complete', file: fileRow });
  } catch (err) {
    return json({ status: 'failed', error: err?.message || 'Upload failed' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
