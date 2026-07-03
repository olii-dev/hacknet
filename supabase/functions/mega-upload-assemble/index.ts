import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { Storage } from 'npm:megajs@1';
import {
  type AssembleMegaState,
  connectHacknetFolder,
  encryptStagingBytes,
  finalizeMegaFile,
  initMegaUploadState,
  paddedCiphertextSize,
  uploadCiphertext,
} from './_shared/mega-resumable.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const BUCKET = 'hacknet-uploads';
const THUMBNAIL_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const ASSEMBLE_STALE_MS = 3 * 60 * 1000;
const STAGING_CHUNK_BYTES = 45 * 1024 * 1024;
const TIMEOUT_ERROR = 'Server timed out saving to Mega. Try again.';

type MegaAccount = { email: string; password: string };
type AdminClient = ReturnType<typeof createClient>;

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

function storageObjectUrl(supabaseUrl: string, path: string) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${supabaseUrl}/storage/v1/object/${BUCKET}/${encoded}`;
}

async function touchAssembleStage(
  adminClient: AdminClient,
  sessionId: string,
  stage: string,
) {
  await adminClient.from('upload_sessions').update({
    assemble_stage: stage,
    assemble_updated_at: new Date().toISOString(),
  }).eq('id', sessionId);
}

async function markAssembleFailed(
  adminClient: AdminClient,
  sessionId: string,
  message: string,
) {
  await adminClient.from('upload_sessions').update({
    assemble_status: 'failed',
    assemble_error: message,
    assemble_stage: 'failed',
    assemble_updated_at: new Date().toISOString(),
  }).eq('id', sessionId);
}

async function connectMega(account: MegaAccount) {
  if (!account?.email) throw new Error('Mega account not configured.');
  const storage = await new Storage({
    email: account.email,
    password: account.password,
    keepalive: false,
  }).ready;
  if (!storage?.root) throw new Error('Mega login failed to initialize storage root.');
  return storage;
}

async function downloadStagingChunk(
  supabaseUrl: string,
  serviceKey: string,
  chunkPath: string,
): Promise<Uint8Array> {
  const res = await fetch(storageObjectUrl(supabaseUrl, chunkPath), {
    headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
  });
  if (!res.ok) throw new Error('Upload chunk is missing. Try uploading again.');
  return new Uint8Array(await res.arrayBuffer());
}

async function uploadThumbnail(
  storage: Awaited<ReturnType<typeof connectMega>>,
  folder: Awaited<ReturnType<typeof connectHacknetFolder>>,
  supabaseUrl: string,
  serviceKey: string,
  thumbnailPath: string,
  filename: string,
): Promise<string | null> {
  const thumbRes = await fetch(storageObjectUrl(supabaseUrl, thumbnailPath), {
    headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
  });
  if (!thumbRes.ok) return null;
  const thumbBlob = await thumbRes.arrayBuffer();
  const thumbType = thumbRes.headers.get('content-type') || 'image/jpeg';
  if (!THUMBNAIL_TYPES.includes(thumbType) || thumbBlob.byteLength > 5 * 1024 * 1024) return null;
  const thumbUploaded = await folder.upload(
    { name: `cover-${Date.now()}-${filename}`, size: thumbBlob.byteLength },
    new Uint8Array(thumbBlob),
  ).complete;
  return thumbUploaded.link({});
}

function isAssembleStale(session: { assemble_updated_at?: string | null }) {
  if (!session.assemble_updated_at) return true;
  return Date.now() - new Date(session.assemble_updated_at).getTime() > ASSEMBLE_STALE_MS;
}

function stagingChunkByteLength(chunkIndex: number, fileSize: number): number {
  const start = chunkIndex * STAGING_CHUNK_BYTES;
  return Math.min(STAGING_CHUNK_BYTES, fileSize - start);
}

async function loadSession(
  adminClient: AdminClient,
  sessionId: string,
  userId: string,
) {
  const { data: session, error } = await adminClient
    .from('upload_sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .single();
  if (error || !session) throw new Error('Upload session not found.');
  if (session.completed_at) throw new Error('Upload session already completed.');
  if (new Date(session.expires_at) < new Date()) throw new Error('Upload session expired. Try uploading again.');
  return session;
}

async function runAssembleStart(
  adminClient: AdminClient,
  supabaseUrl: string,
  serviceKey: string,
  megaAccounts: MegaAccount[],
  userId: string,
  sessionId: string,
  chunkCount: number,
  thumbnailPath: string | null,
) {
  const session = await loadSession(adminClient, sessionId, userId);

  if (session.assemble_status === 'assembling' && !isAssembleStale(session) && session.assemble_mega_state) {
    return {
      status: 'assembling' as const,
      chunk_index: session.assemble_chunk_index ?? 0,
      chunk_count: session.assemble_chunk_count ?? chunkCount,
      stage: session.assemble_stage,
    };
  }

  await adminClient.from('upload_sessions').update({
    assemble_status: 'assembling',
    assemble_error: null,
    assemble_stage: 'mega_login',
    assemble_updated_at: new Date().toISOString(),
    assemble_chunk_index: 0,
    assemble_chunk_count: chunkCount,
    assemble_thumbnail_path: thumbnailPath,
    assemble_mega_state: null,
  }).eq('id', sessionId);

  const account = megaAccounts[session.mega_account_index ?? 0] || megaAccounts[0];
  const storage = await connectMega(account);
  const folder = await connectHacknetFolder(storage);
  const megaState = await initMegaUploadState(
    storage,
    folder,
    Number(session.size_bytes),
  );

  await adminClient.from('upload_sessions').update({
    assemble_stage: 'mega_upload_ready',
    assemble_mega_state: megaState,
    assemble_updated_at: new Date().toISOString(),
  }).eq('id', sessionId);

  return {
    status: 'assembling' as const,
    chunk_index: 0,
    chunk_count: chunkCount,
    stage: 'mega_upload_ready',
    ciphertext_size: paddedCiphertextSize(Number(session.size_bytes)),
  };
}

async function runAssembleChunk(
  adminClient: AdminClient,
  supabaseUrl: string,
  serviceKey: string,
  megaAccounts: MegaAccount[],
  userId: string,
  sessionId: string,
  chunkIndex: number,
) {
  const session = await loadSession(adminClient, sessionId, userId);
  const chunkCount = session.assemble_chunk_count;
  const megaState = session.assemble_mega_state as AssembleMegaState | null;

  if (!chunkCount || !megaState) {
    throw new Error('Assemble not initialized. Call start first.');
  }
  if (chunkIndex < 0 || chunkIndex >= chunkCount) {
    throw new Error('Invalid chunk index.');
  }
  if (chunkIndex !== (session.assemble_chunk_index ?? 0)) {
    throw new Error(`Expected chunk ${session.assemble_chunk_index ?? 0}, got ${chunkIndex}.`);
  }

  const chunkPath = `${session.user_id}/${sessionId}/chunk-${String(chunkIndex).padStart(5, '0')}`;

  await touchAssembleStage(
    adminClient,
    sessionId,
    `mega_chunk_${chunkIndex + 1}_of_${chunkCount}`,
  );

  const account = megaAccounts[session.mega_account_index ?? 0] || megaAccounts[0];
  const storage = await connectMega(account);

  const plaintext = await downloadStagingChunk(supabaseUrl, serviceKey, chunkPath);
  const expectedLen = stagingChunkByteLength(chunkIndex, Number(session.size_bytes));
  if (plaintext.length !== expectedLen) {
    throw new Error(`Upload chunk ${chunkIndex + 1} of ${chunkCount} has wrong size. Try uploading again.`);
  }

  const plaintextOffset = chunkIndex * STAGING_CHUNK_BYTES;
  const fileKey = Uint8Array.from(atob(megaState.fileKeyB64), (c) => c.charCodeAt(0));
  const isLastChunk = chunkIndex === chunkCount - 1;
  const { ciphertext, mac } = encryptStagingBytes(
    fileKey,
    megaState.mac,
    plaintext,
    plaintextOffset,
    isLastChunk,
  );

  let nextState = await uploadCiphertext(storage.api, { ...megaState, mac }, ciphertext);

  await adminClient.from('upload_sessions').update({
    assemble_chunk_index: chunkIndex + 1,
    assemble_mega_state: nextState,
    assemble_updated_at: new Date().toISOString(),
    assemble_stage: chunkIndex + 1 >= chunkCount ? 'mega_upload_finalize' : `mega_chunk_${chunkIndex + 1}_of_${chunkCount}`,
  }).eq('id', sessionId);

  return {
    status: 'assembling' as const,
    chunk_index: chunkIndex + 1,
    chunk_count: chunkCount,
    stage: chunkIndex + 1 >= chunkCount ? 'mega_upload_finalize' : `mega_chunk_${chunkIndex + 1}_of_${chunkCount}`,
    bytes_uploaded: nextState.transfer.bytesUploaded,
    ciphertext_size: nextState.transfer.totalCiphertextSize,
    ready_to_finalize: chunkIndex + 1 >= chunkCount,
  };
}

async function runAssembleFinalize(
  adminClient: AdminClient,
  supabaseUrl: string,
  serviceKey: string,
  autoApprove: boolean,
  megaAccounts: MegaAccount[],
  userId: string,
  sessionId: string,
) {
  const session = await loadSession(adminClient, sessionId, userId);
  const chunkCount = session.assemble_chunk_count;
  const megaState = session.assemble_mega_state as AssembleMegaState | null;
  const thumbnailPath = session.assemble_thumbnail_path as string | null;

  if (!chunkCount || !megaState) throw new Error('Assemble not initialized.');
  if ((session.assemble_chunk_index ?? 0) < chunkCount) {
    throw new Error('Not all chunks have been uploaded to Mega yet.');
  }
  if (megaState.transfer.bytesUploaded < megaState.transfer.totalCiphertextSize) {
    throw new Error('Mega upload is incomplete.');
  }

  await touchAssembleStage(adminClient, sessionId, 'mega_finalize');

  const account = megaAccounts[session.mega_account_index ?? 0] || megaAccounts[0];
  const storage = await connectMega(account);
  const folder = await connectHacknetFolder(storage);
  const uploaded = await finalizeMegaFile(storage, folder, session.filename, megaState);
  const megaUrl = await uploaded.link({});
  const megaFileId = uploaded.nodeId || uploaded.id || null;

  let customThumbnailUrl: string | null = null;
  if (thumbnailPath && thumbnailPath.startsWith(`${userId}/`)) {
    await touchAssembleStage(adminClient, sessionId, 'mega_thumbnail');
    customThumbnailUrl = await uploadThumbnail(
      storage,
      folder,
      supabaseUrl,
      serviceKey,
      thumbnailPath,
      session.filename,
    );
  }

  await touchAssembleStage(adminClient, sessionId, 'cleanup_staging');
  const pathsToDelete = [
    ...Array.from({ length: chunkCount }, (_, i) =>
      `${session.user_id}/${sessionId}/chunk-${String(i).padStart(5, '0')}`),
    thumbnailPath,
  ].filter(Boolean) as string[];
  await adminClient.storage.from(BUCKET).remove(pathsToDelete);

  await touchAssembleStage(adminClient, sessionId, 'save_metadata');
  const { data: fileRow, error: dbError } = await adminClient.from('files').insert({
    uploader_id: userId,
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

  if (dbError) throw new Error('Your file uploaded but we could not save its details. Please try again.');

  await adminClient.from('upload_sessions').update({
    completed_at: new Date().toISOString(),
    assemble_status: 'complete',
    assemble_error: null,
    assemble_stage: 'complete',
    assemble_updated_at: new Date().toISOString(),
    result_file_id: fileRow.id,
  }).eq('id', sessionId);

  return fileRow;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const autoApprove = Deno.env.get('AUTO_APPROVE') === 'true';
  const megaAccounts = loadMegaAccounts();
  const adminClient = createClient(supabaseUrl, serviceKey);

  try {
    if (!megaAccounts.length) return json({ error: "Uploads aren't configured on the server yet. Ask a moderator." }, 500);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: "You're not signed in. Log in and try again." }, 401);

    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return json({ error: "You're not signed in. Log in and try again." }, 401);

    const body = await req.json();
    const action = body.action as string;
    const sessionId = body.session_id as string;

    if (action === 'status') {
      if (!sessionId) return json({ error: 'Missing session.' }, 400);

      const { data: session, error } = await adminClient
        .from('upload_sessions')
        .select('assemble_status, assemble_error, assemble_stage, assemble_updated_at, assemble_chunk_index, assemble_chunk_count, result_file_id, completed_at')
        .eq('id', sessionId)
        .eq('user_id', user.id)
        .single();

      if (error || !session) return json({ error: 'Upload session not found.' }, 404);

      if (session.assemble_status === 'complete' && session.result_file_id) {
        const { data: fileRow } = await adminClient
          .from('files')
          .select('*')
          .eq('id', session.result_file_id)
          .single();
        return json({ status: 'complete', file: fileRow, stage: session.assemble_stage });
      }

      if (session.assemble_status === 'failed') {
        return json({
          status: 'failed',
          error: session.assemble_error || 'Could not save file to Mega.',
          stage: session.assemble_stage,
        });
      }

      const stale = session.assemble_status === 'assembling' && isAssembleStale(session);
      if (stale) {
        await markAssembleFailed(adminClient, sessionId, TIMEOUT_ERROR);
        return json({ status: 'failed', error: TIMEOUT_ERROR, stage: 'failed', stale: true });
      }

      return json({
        status: session.assemble_status || 'pending',
        stage: session.assemble_stage,
        chunk_index: session.assemble_chunk_index ?? 0,
        chunk_count: session.assemble_chunk_count,
        stale: false,
      });
    }

    if (!sessionId) return json({ error: 'Missing session.' }, 400);

    if (action === 'start') {
      const chunkCount = Number(body.chunk_count);
      const thumbnailPath = (body.thumbnail_path as string | null) || null;
      if (!chunkCount || chunkCount < 1) return json({ error: 'Upload session incomplete. Try again.' }, 400);

      try {
        const result = await runAssembleStart(
          adminClient,
          supabaseUrl,
          serviceKey,
          megaAccounts,
          user.id,
          sessionId,
          chunkCount,
          thumbnailPath,
        );
        return json(result, 202);
      } catch (err) {
        const errMsg = err?.message || String(err);
        await markAssembleFailed(adminClient, sessionId, errMsg);
        return json({ status: 'failed', error: errMsg }, 500);
      }
    }

    if (action === 'chunk') {
      const chunkIndex = Number(body.chunk_index);
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
        return json({ error: 'Invalid chunk index.' }, 400);
      }

      try {
        const result = await runAssembleChunk(
          adminClient,
          supabaseUrl,
          serviceKey,
          megaAccounts,
          user.id,
          sessionId,
          chunkIndex,
        );
        return json(result, result.ready_to_finalize ? 200 : 202);
      } catch (err) {
        const errMsg = err?.message || String(err);
        await markAssembleFailed(adminClient, sessionId, errMsg);
        return json({ status: 'failed', error: errMsg }, 500);
      }
    }

    if (action === 'finalize') {
      try {
        const fileRow = await runAssembleFinalize(
          adminClient,
          supabaseUrl,
          serviceKey,
          autoApprove,
          megaAccounts,
          user.id,
          sessionId,
        );
        return json({ status: 'complete', file: fileRow });
      } catch (err) {
        const errMsg = err?.message || String(err);
        await markAssembleFailed(adminClient, sessionId, errMsg);
        return json({ status: 'failed', error: errMsg }, 500);
      }
    }

    return json({ error: 'Unknown action.' }, 400);
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
