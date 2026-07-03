-- Short-lived upload sessions for direct browser → Mega uploads

create table if not exists public.upload_sessions (
  id uuid primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  mega_account_index integer not null default 0,
  title text not null,
  description text default '',
  tags text[] default '{}',
  filename text not null,
  mime_type text,
  size_bytes bigint not null,
  has_thumbnail boolean not null default false,
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists upload_sessions_user_idx on public.upload_sessions (user_id);
create index if not exists upload_sessions_expires_idx on public.upload_sessions (expires_at);

alter table public.upload_sessions enable row level security;

-- Only service role touches sessions (edge functions)
