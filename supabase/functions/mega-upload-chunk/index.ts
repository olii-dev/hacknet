import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  type AssembleMegaState,
  type MacState,
  uploadCiphertext,
} from './_shared/mega-resumable.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-mac-state',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: "You're not signed in. Log in and try again." }, 401);

    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return json({ error: "You're not signed in. Log in and try again." }, 401);

    const url = new URL(req.url);
    const sessionId = url.searchParams.get('session_id');
    if (!sessionId) return json({ error: 'Missing session.' }, 400);

    const macHeader = req.headers.get('X-Mac-State');
    if (!macHeader) return json({ error: 'Missing encryption state.' }, 400);

    let mac: MacState;
    try {
      mac = JSON.parse(macHeader);
    } catch {
      return json({ error: 'Invalid encryption state.' }, 400);
    }

    const ciphertext = new Uint8Array(await req.arrayBuffer());
    if (!ciphertext.length) return json({ error: 'Empty chunk.' }, 400);

    const adminClient = createClient(supabaseUrl, serviceKey);
    const { data: session, error: sessionError } = await adminClient
      .from('upload_sessions')
      .select('assemble_mega_state, assemble_status, expires_at, completed_at')
      .eq('id', sessionId)
      .eq('user_id', user.id)
      .single();

    if (sessionError || !session) return json({ error: 'Upload session not found.' }, 404);
    if (session.completed_at) return json({ error: 'Upload session already completed.' }, 400);
    if (new Date(session.expires_at) < new Date()) {
      return json({ error: 'Upload session expired. Try uploading again.' }, 400);
    }

    const megaState = session.assemble_mega_state as AssembleMegaState | null;
    if (!megaState?.uploadUrl) {
      return json({ error: 'Upload not initialized. Try again.' }, 400);
    }

    const nextState = await uploadCiphertext(
      { fetch, request: () => {} },
      { ...megaState, mac },
      ciphertext,
    );

    await adminClient.from('upload_sessions').update({
      assemble_mega_state: nextState,
      assemble_status: 'assembling',
      assemble_stage: nextState.uploadHashB64 ? 'mega_upload_finalize' : 'mega_uploading',
      assemble_updated_at: new Date().toISOString(),
    }).eq('id', sessionId);

    return json({
      status: 'assembling',
      bytes_uploaded: nextState.transfer.bytesUploaded,
      ciphertext_size: nextState.transfer.totalCiphertextSize,
      ready_to_finalize: !!nextState.uploadHashB64,
    });
  } catch (err) {
    return json({ error: err?.message || 'Chunk upload failed' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
