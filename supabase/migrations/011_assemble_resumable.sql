-- Resumable Mega assemble: one staging chunk per edge invocation

alter table public.upload_sessions
  add column if not exists assemble_chunk_index integer not null default 0,
  add column if not exists assemble_chunk_count integer,
  add column if not exists assemble_thumbnail_path text,
  add column if not exists assemble_mega_state jsonb;
