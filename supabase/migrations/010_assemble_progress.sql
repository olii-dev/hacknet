alter table public.upload_sessions
  add column if not exists assemble_stage text,
  add column if not exists assemble_updated_at timestamptz;
