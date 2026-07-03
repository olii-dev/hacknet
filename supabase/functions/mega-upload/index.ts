import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { Storage } from 'npm:megajs@1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MAX_BYTES = 15 * 1024 * 1024;
const MEGA_QUOTA_PER_ACCOUNT = 20 * 1024 * 1024 * 1024;
const VIDEO_TYPES = [
  'video/mp4', 'video/webm', 'video/ogg',
  'video/quicktime', // .mov
  'video/x-msvideo', 'video/avi', 'video/msvideo', 'video/vnd.avi', // .avi
  'video/x-matroska', // .mkv
  'video/mpeg', 'video/mp2t', // .mpg, .ts
  'video/3gpp', 'video/3gpp2', // .3gp
  'video/x-flv', // .flv
  'video/x-ms-wmv', 'video/x-ms-asf', // .wmv, .asf
  'video/x-m4v', 'video/hevc', 'video/h264',
];
const ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf',
  'text/plain', 'text/markdown', 'text/csv',
  'application/json', 'application/zip',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/webm',
  ...VIDEO_TYPES,
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
];

function isAllowedMime(mime: string) {
  if (!mime) return true;
  if (ALLOWED_TYPES.includes(mime)) return true;
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return true;
  return false;
}

type MegaAccount = { email: string; password: string };

function loadMegaAccounts(): MegaAccount[] {
  const json = Deno.env.get('MEGA_ACCOUNTS');
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.filter((a) => a?.email && a?.password);
      }
    } catch {
      // fall through
    }
  }

  const accounts: MegaAccount[] = [];
  const primaryEmail = Deno.env.get('MEGA_EMAIL');
  const primaryPassword = Deno.env.get('MEGA_PASSWORD');
  if (primaryEmail && primaryPassword) {
    accounts.push({ email: primaryEmail, password: primaryPassword });
  }

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
    if (idx >= 0 && idx < usage.length) {
      usage[idx] += Number(row.size_bytes) || 0;
    }
  }

  for (let i = 0; i < accounts.length; i++) {
    const headroom = MEGA_QUOTA_PER_ACCOUNT - usage[i];
    if (headroom >= incomingBytes) {
      return { index: i, account: accounts[i] };
    }
  }

  throw new Error('Hacknet is out of storage space right now. Try again later or ask a moderator to add capacity.');
}

function friendlyMegaError(message: string) {
  const raw = message || 'Upload failed';
  if (/storage accounts are full|out of storage space/i.test(raw)) {
    return 'Hacknet is out of storage space right now. Try again later or ask a moderator.';
  }
  if (/login|auth|credential|password/i.test(raw)) {
    return 'Storage login failed on the server. Ask a moderator to check the Mega account settings.';
  }
  if (/quota|over.?limit|no space|storage full/i.test(raw)) {
    return 'The storage account is full. Try again later or ask a moderator to add capacity.';
  }
  if (/rate.?limit|too many/i.test(raw)) {
    return 'Too many uploads at once. Wait a minute and try again.';
  }
  return raw;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const autoApprove = Deno.env.get('AUTO_APPROVE') !== 'false';
    const megaAccounts = loadMegaAccounts();

    if (!megaAccounts.length) {
      return json({ error: "Uploads aren't configured on the server yet. Ask a moderator." }, 500);
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return json({ error: "You're not signed in. Log in and try again." }, 401);
    }

    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return json({ error: "You're not signed in. Log in and try again." }, 401);
    }

    const formData = await req.formData();
    const file = formData.get('file') as File;
    const title = (formData.get('title') as string)?.trim();
    const description = (formData.get('description') as string)?.trim() || '';
    const tagsRaw = formData.get('tags') as string;
    let tags: string[] = [];
    try {
      tags = JSON.parse(tagsRaw || '[]');
    } catch {
      tags = [];
    }

    if (!file || !title) {
      return json({ error: 'Please select a file and give it a title.' }, 400);
    }
    if (file.size > MAX_BYTES) {
      return json({ error: 'That file is too big. Hacknet allows uploads up to 15 MB.' }, 400);
    }
    if (!isAllowedMime(file.type)) {
      return json({ error: `That file type isn't supported (${file.type || 'unknown'}).` }, 400);
    }

    const adminClient = createClient(supabaseUrl, serviceKey);
    const { index: accountIndex, account } = await pickMegaAccount(
      adminClient,
      megaAccounts,
      file.size,
    );

    const storage = await new Storage({
      email: account.email,
      password: account.password,
    }).ready;

    let folder = storage.root.children.find((c: { name: string }) => c.name === 'Hacknet');
    if (!folder) {
      folder = await storage.mkdir('Hacknet');
    }

    const buffer = new Uint8Array(await file.arrayBuffer());
    const uploaded = await folder.upload({ name: file.name, size: file.size }, buffer).complete;
    const megaUrl = await uploaded.link({});

    const { data: fileRow, error: dbError } = await adminClient
      .from('files')
      .insert({
        uploader_id: user.id,
        title,
        description,
        filename: file.name,
        mime_type: file.type || 'application/octet-stream',
        size_bytes: file.size,
        mega_url: megaUrl,
        mega_file_id: uploaded.nodeId || uploaded.id || null,
        mega_account_index: accountIndex,
        tags,
        status: autoApprove ? 'approved' : 'pending',
      })
      .select()
      .single();

    if (dbError) {
      return json({ error: 'Your file uploaded but we could not save its details. Please try again.' }, 500);
    }

    return json({ file: fileRow });
  } catch (err) {
    return json({ error: friendlyMegaError(err.message || 'Upload failed') }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
