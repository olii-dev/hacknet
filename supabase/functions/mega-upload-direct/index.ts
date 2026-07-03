import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { Storage } from 'npm:megajs@1';
import {
  connectHacknetFolder,
  initMegaUploadState,
  paddedCiphertextSize,
} from './_shared/mega-resumable.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_BYTES = 50 * 1024 * 1024;
const MEGA_QUOTA_PER_ACCOUNT = 20 * 1024 * 1024 * 1024;
const SESSION_TTL_MS = 15 * 60 * 1000;

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

const BLOCKED_WORDS = ['nigger', 'nigga', 'faggot', 'fag', 'retard', 'kike', 'chink', 'cunt', 'rape', 'nazi', 'hitler'];

function containsProfanity(...texts: string[]) {
  const haystack = texts.filter(Boolean).join(' ').toLowerCase();
  return BLOCKED_WORDS.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(haystack));
}

async function pickMegaAccount(
  adminClient: ReturnType<typeof createClient>,
  accounts: MegaAccount[],
  incomingBytes: number,
) {
  const { data } = await adminClient.from('files').select('mega_account_index, size_bytes');
  const usage = accounts.map(() => 0);
  for (const row of data || []) {
    const idx = row.mega_account_index ?? 0;
    if (idx >= 0 && idx < usage.length) usage[idx] += Number(row.size_bytes) || 0;
  }
  for (let i = 0; i < accounts.length; i++) {
    const headroom = MEGA_QUOTA_PER_ACCOUNT - usage[i];
    if (headroom >= incomingBytes) return { index: i };
  }
  throw new Error('Hacknet is out of storage space right now. Try again later or ask a moderator to add capacity.');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const megaAccounts = loadMegaAccounts();
    if (!megaAccounts.length) return json({ error: "Uploads aren't configured on the server yet. Ask a moderator." }, 500);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: "You're not signed in. Log in and try again." }, 401);

    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return json({ error: "You're not signed in. Log in and try again." }, 401);

    const body = await req.json();
    const adminClient = createClient(supabaseUrl, serviceKey);

    const title = String(body.title || '').trim();
    const filename = String(body.filename || '').trim();
    const sizeBytes = Number(body.size_bytes);
    if (!title || !filename || !sizeBytes) {
      return json({ error: 'Please add a title and select a file.' }, 400);
    }
    if (sizeBytes > MAX_BYTES) {
      return json({ error: 'That file is too big. Hacknet allows uploads up to 50 MB.' }, 400);
    }
    if (containsProfanity(title, String(body.description || ''), ...(Array.isArray(body.tags) ? body.tags : []))) {
      return json({ error: 'Your upload contains language that isn\'t allowed on Hacknet.' }, 400);
    }

    const thumbSize = Number(body.thumbnail_size) || 0;
    const { index: accountIndex } = await pickMegaAccount(adminClient, megaAccounts, sizeBytes + thumbSize);

    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    const { error: sessionError } = await adminClient.from('upload_sessions').insert({
      id: sessionId,
      user_id: user.id,
      mega_account_index: accountIndex,
      title,
      description: String(body.description || '').trim(),
      tags: Array.isArray(body.tags) ? body.tags : [],
      filename,
      mime_type: body.mime_type || 'application/octet-stream',
      size_bytes: sizeBytes,
      has_thumbnail: thumbSize > 0,
      expires_at: expiresAt,
    });

    if (sessionError) return json({ error: 'Could not start upload session. Try again.' }, 500);

    const account = megaAccounts[accountIndex];
    const storage = await new Storage({
      email: account.email,
      password: account.password,
      keepalive: false,
    }).ready;
    if (!storage?.root) return json({ error: 'Mega storage is unavailable. Try again later.' }, 503);

    const folder = await connectHacknetFolder(storage);
    const megaState = await initMegaUploadState(storage, folder, sizeBytes);

    await adminClient.from('upload_sessions').update({
      assemble_status: 'assembling',
      assemble_stage: 'mega_upload_ready',
      assemble_mega_state: megaState,
      assemble_updated_at: new Date().toISOString(),
    }).eq('id', sessionId);

    return json({
      session_id: sessionId,
      user_id: user.id,
      file_key_b64: megaState.fileKeyB64,
      ciphertext_size: paddedCiphertextSize(sizeBytes),
    });
  } catch (err) {
    return json({ error: err.message || 'Upload failed' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
