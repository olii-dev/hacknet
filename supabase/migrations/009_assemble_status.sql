alter table public.upload_sessions
  add column if not exists assemble_status text not null default 'pending',
  add column if not exists assemble_error text,
  add column if not exists result_file_id uuid references public.files (id) on delete set null;

create index if not exists upload_sessions_assemble_status_idx
  on public.upload_sessions (assemble_status)
  where completed_at is null;
