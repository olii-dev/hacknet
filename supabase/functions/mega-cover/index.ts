import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { Storage } from 'npm:megajs@1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
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
    const fileId = (formData.get('file_id') as string)?.trim();
    const thumbnail = formData.get('thumbnail') as File | null;

    if (!fileId) {
      return json({ error: 'File ID is required.' }, 400);
    }
    if (!thumbnail || thumbnail.size === 0) {
      return json({ error: 'Please select a cover image.' }, 400);
    }
    if (thumbnail.size > MAX_THUMBNAIL_BYTES) {
      return json({ error: 'Your cover image is too large. Keep it under 5 MB.' }, 400);
    }
    if (!THUMBNAIL_TYPES.includes(thumbnail.type)) {
      return json({ error: 'Cover images must be JPEG, PNG, GIF, or WebP.' }, 400);
    }

    const adminClient = createClient(supabaseUrl, serviceKey);
    const { data: fileRow, error: fileError } = await adminClient
      .from('files')
      .select('id, uploader_id, mega_account_index')
      .eq('id', fileId)
      .single();

    if (fileError || !fileRow) {
      return json({ error: 'File not found.' }, 404);
    }
    if (fileRow.uploader_id !== user.id) {
      return json({ error: 'You can only edit your own uploads.' }, 403);
    }

    const accountIndex = fileRow.mega_account_index ?? 0;
    const account = megaAccounts[accountIndex] || megaAccounts[0];

    const storage = await new Storage({
      email: account.email,
      password: account.password,
    }).ready;

    let folder = storage.root.children.find((c: { name: string }) => c.name === 'Hacknet');
    if (!folder) {
      folder = await storage.mkdir('Hacknet');
    }

    const thumbBuffer = new Uint8Array(await thumbnail.arrayBuffer());
    const thumbName = `cover-${Date.now()}-${thumbnail.name}`;
    const thumbUploaded = await folder.upload({
      name: thumbName,
      size: thumbnail.size,
    }, thumbBuffer).complete;
    const customThumbnailUrl = await thumbUploaded.link({});

    const { data: updated, error: updateError } = await userClient
      .from('files')
      .update({ custom_thumbnail_url: customThumbnailUrl })
      .eq('id', fileId)
      .select()
      .single();

    if (updateError) {
      return json({ error: 'Could not save the cover image. Please try again.' }, 500);
    }

    return json({ file: updated });
  } catch (err) {
    return json({ error: err.message || 'Failed to update cover image' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
