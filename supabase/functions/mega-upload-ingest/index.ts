import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { Storage } from 'npm:megajs@1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const BUCKET = 'hacknet-uploads';
const MEGA_QUOTA_PER_ACCOUNT = 20 * 1024 * 1024 * 1024;
const THUMBNAIL_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

type MegaAccount = { email: string; password: string };
type MegaFolder = {
  upload: (opts: { name: string; size: number }, data?: Uint8Array) => {
    write: (chunk: Uint8Array) => boolean;
    end: () => void;
    complete: Promise<{ link: (o: object) => Promise<string>; nodeId?: string; id?: string }>;
  };
};

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
    if (headroom >= incomingBytes) return { index: i, account: accounts[i] };
  }
  throw new Error('Hacknet is out of storage space right now. Try again later or ask a moderator to add capacity.');
}

async function streamBlobToMega(
  data: Blob,
  folder: MegaFolder,
  filename: string,
  sizeBytes: number,
) {
  const uploadHandle = folder.upload({ name: filename, size: sizeBytes });
  const reader = data.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) uploadHandle.write(value);
  }
  uploadHandle.end();
  return uploadHandle.complete;
}

async function streamStorageToMega(
  adminClient: ReturnType<typeof createClient>,
  path: string,
  folder: MegaFolder,
  filename: string,
  sizeBytes: number,
) {
  const { data, error } = await adminClient.storage.from(BUCKET).download(path);
  if (error || !data) {
    throw new Error('Could not read your staged upload. Try uploading again.');
  }
  return streamBlobToMega(data, folder, filename, sizeBytes);
}

async function streamChunksToMega(
  adminClient: ReturnType<typeof createClient>,
  folder: MegaFolder,
  filename: string,
  sizeBytes: number,
  userId: string,
  sessionId: string,
  chunkCount: number,
) {
  const uploadHandle = folder.upload({ name: filename, size: sizeBytes });
  for (let i = 0; i < chunkCount; i++) {
    const chunkPath = `${userId}/${sessionId}/chunk-${String(i).padStart(5, '0')}`;
    const { data, error } = await adminClient.storage.from(BUCKET).download(chunkPath);
    if (error || !data) {
      throw new Error(`Upload chunk ${i + 1} of ${chunkCount} is missing. Try uploading again.`);
    }
    const reader = data.stream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) uploadHandle.write(value);
    }
  }
  uploadHandle.end();
  return uploadHandle.complete;
}

async function getHacknetFolder(account: MegaAccount) {
  const storage = await new Storage({ email: account.email, password: account.password }).ready;
  let folder = storage.root.children.find((c: { name: string }) => c.name === 'Hacknet');
  if (!folder) folder = await storage.mkdir('Hacknet');
  return folder as MegaFolder;
}

async function uploadThumbnail(
  adminClient: ReturnType<typeof createClient>,
  folder: MegaFolder,
  thumbnailPath: string,
  filename: string,
) {
  const { data: thumbData, error: thumbError } = await adminClient.storage.from(BUCKET).download(thumbnailPath);
  if (thumbError || !thumbData) return null;
  const thumbBlob = await thumbData.arrayBuffer();
  const thumbType = thumbData.type || 'image/jpeg';
  if (!THUMBNAIL_TYPES.includes(thumbType) || thumbBlob.byteLength > 5 * 1024 * 1024) return null;
  const thumbUploaded = await folder.upload(
    { name: `cover-${Date.now()}-${filename}`, size: thumbBlob.byteLength },
    new Uint8Array(thumbBlob),
  ).complete;
  return thumbUploaded.link({});
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const autoApprove = Deno.env.get('AUTO_APPROVE') === 'true';
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

    if (body.action === 'assemble') {
      const sessionId = body.session_id as string;
      const chunkCount = Number(body.chunk_count);
      const thumbnailPath = body.thumbnail_path as string | null;

      if (!sessionId || !chunkCount || chunkCount < 1) {
        return json({ error: 'Upload session incomplete. Try again.' }, 400);
      }

      const { data: session, error: sessionError } = await adminClient
        .from('upload_sessions')
        .select('*')
        .eq('id', sessionId)
        .eq('user_id', user.id)
        .is('completed_at', null)
        .single();

      if (sessionError || !session) {
        return json({ error: 'Upload session expired or not found. Try uploading again.' }, 400);
      }
      if (new Date(session.expires_at) < new Date()) {
        return json({ error: 'Upload session expired. Try uploading again.' }, 400);
      }

      const account = megaAccounts[session.mega_account_index ?? 0] || megaAccounts[0];
      const folder = await getHacknetFolder(account);

      const uploaded = await streamChunksToMega(
        adminClient,
        folder,
        session.filename,
        Number(session.size_bytes),
        session.user_id,
        sessionId,
        chunkCount,
      );
      const megaUrl = await uploaded.link({});
      const megaFileId = uploaded.nodeId || uploaded.id || null;

      let customThumbnailUrl: string | null = null;
      if (thumbnailPath && thumbnailPath.startsWith(`${user.id}/`)) {
        customThumbnailUrl = await uploadThumbnail(adminClient, folder, thumbnailPath, session.filename);
      }

      const pathsToDelete = [
        ...Array.from({ length: chunkCount }, (_, i) =>
          `${session.user_id}/${sessionId}/chunk-${String(i).padStart(5, '0')}`),
        thumbnailPath,
      ].filter(Boolean) as string[];
      await adminClient.storage.from(BUCKET).remove(pathsToDelete);

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

      if (dbError) return json({ error: 'Your file uploaded but we could not save its details. Please try again.' }, 500);

      await adminClient.from('upload_sessions').update({ completed_at: new Date().toISOString() }).eq('id', sessionId);

      return json({ file: fileRow });
    }

    const {
      storage_path: storagePath,
      thumbnail_path: thumbnailPath,
      title,
      description = '',
      tags = [],
      filename,
      mime_type: mimeType,
      size_bytes: sizeBytes,
    } = body;

    if (!storagePath || !title || !filename || !sizeBytes) {
      return json({ error: 'Missing upload details. Try uploading again.' }, 400);
    }
    if (!storagePath.startsWith(`${user.id}/`)) {
      return json({ error: 'Invalid upload path.' }, 403);
    }
    if (thumbnailPath && !thumbnailPath.startsWith(`${user.id}/`)) {
      return json({ error: 'Invalid cover image path.' }, 403);
    }

    const { index: accountIndex, account } = await pickMegaAccount(
      adminClient,
      megaAccounts,
      Number(sizeBytes) + (thumbnailPath ? 5 * 1024 * 1024 : 0),
    );

    const folder = await getHacknetFolder(account);

    const uploaded = await streamStorageToMega(
      adminClient,
      storagePath,
      folder,
      filename,
      Number(sizeBytes),
    );
    const megaUrl = await uploaded.link({});

    let customThumbnailUrl: string | null = null;
    if (thumbnailPath) {
      customThumbnailUrl = await uploadThumbnail(adminClient, folder, thumbnailPath, filename);
    }

    const pathsToDelete = [storagePath, thumbnailPath].filter(Boolean) as string[];
    await adminClient.storage.from(BUCKET).remove(pathsToDelete);

    const { data: fileRow, error: dbError } = await adminClient.from('files').insert({
      uploader_id: user.id,
      title: String(title).trim(),
      description: String(description || '').trim(),
      filename,
      mime_type: mimeType || 'application/octet-stream',
      size_bytes: Number(sizeBytes),
      mega_url: megaUrl,
      mega_file_id: uploaded.nodeId || uploaded.id || null,
      mega_account_index: accountIndex,
      custom_thumbnail_url: customThumbnailUrl,
      tags: Array.isArray(tags) ? tags : [],
      status: autoApprove ? 'approved' : 'pending',
    }).select().single();

    if (dbError) return json({ error: 'Your file uploaded but we could not save its details. Please try again.' }, 500);
    return json({ file: fileRow });
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
