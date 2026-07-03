import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MEGA_QUOTA_PER_ACCOUNT = 20 * 1024 * 1024 * 1024;

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

function maskEmail(email: string) {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const visible = local.slice(0, 1);
  return `${visible}***@${domain}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Missing authorization' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return json({ error: 'Unauthorized' }, 401);

    const adminClient = createClient(supabaseUrl, serviceKey);
    const { data: profile } = await adminClient
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!profile || (profile.role !== 'moderator' && profile.role !== 'admin')) {
      return json({ error: 'Forbidden' }, 403);
    }

    const accounts = loadMegaAccounts();
    if (!accounts.length) return json({ error: 'No Mega accounts configured' }, 500);

    const { data: files } = await adminClient.from('files').select('mega_account_index, size_bytes');
    const usage = accounts.map(() => ({ file_count: 0, bytes_used: 0 }));

    for (const row of files || []) {
      const idx = row.mega_account_index ?? 0;
      if (idx >= 0 && idx < usage.length) {
        usage[idx].file_count += 1;
        usage[idx].bytes_used += Number(row.size_bytes) || 0;
      }
    }

    const stats = accounts.map((account, index) => ({
      mega_account_index: index,
      label: maskEmail(account.email),
      file_count: usage[index].file_count,
      bytes_used: usage[index].bytes_used,
      quota_bytes: MEGA_QUOTA_PER_ACCOUNT,
    }));

    const totalUsed = stats.reduce((sum, row) => sum + row.bytes_used, 0);
    const totalQuota = MEGA_QUOTA_PER_ACCOUNT * accounts.length;

    return json({
      account_count: accounts.length,
      total_used: totalUsed,
      total_quota: totalQuota,
      accounts: stats,
    });
  } catch (err) {
    return json({ error: err.message || 'Failed to load storage stats' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
