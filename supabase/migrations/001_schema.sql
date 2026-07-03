-- Hacknet schema

create type user_role as enum ('user', 'moderator', 'admin');
create type file_status as enum ('pending', 'approved', 'rejected');
create type report_status as enum ('open', 'resolved');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text unique not null,
  avatar_url text,
  bio text default '',
  role user_role not null default 'user',
  created_at timestamptz not null default now(),
  constraint username_length check (char_length(username) >= 3 and char_length(username) <= 30),
  constraint username_format check (username ~ '^[a-zA-Z0-9_-]+$')
);

create table public.files (
  id uuid primary key default gen_random_uuid(),
  uploader_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  description text default '',
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null,
  mega_url text not null,
  mega_file_id text,
  tags text[] not null default '{}',
  status file_status not null default 'pending',
  view_count integer not null default 0,
  created_at timestamptz not null default now(),
  constraint title_length check (char_length(title) >= 1 and char_length(title) <= 200)
);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references public.files (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  constraint body_length check (char_length(body) >= 1 and char_length(body) <= 2000)
);

create table public.likes (
  file_id uuid not null references public.files (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (file_id, user_id)
);

create table public.collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  description text default '',
  is_public boolean not null default true,
  created_at timestamptz not null default now(),
  constraint collection_name_length check (char_length(name) >= 1 and char_length(name) <= 100)
);

create table public.collection_files (
  collection_id uuid not null references public.collections (id) on delete cascade,
  file_id uuid not null references public.files (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (collection_id, file_id)
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references public.files (id) on delete cascade,
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  reason text not null,
  status report_status not null default 'open',
  created_at timestamptz not null default now(),
  constraint reason_length check (char_length(reason) >= 1 and char_length(reason) <= 1000)
);

create index files_uploader_id_idx on public.files (uploader_id);
create index files_status_idx on public.files (status);
create index files_created_at_idx on public.files (created_at desc);
create index comments_file_id_idx on public.comments (file_id);
create index likes_file_id_idx on public.likes (file_id);
create index collections_user_id_idx on public.collections (user_id);
create index reports_status_idx on public.reports (status);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  base_username text;
  final_username text;
  suffix int := 0;
begin
  base_username := coalesce(
    nullif(trim(new.raw_user_meta_data->>'username'), ''),
    split_part(new.email, '@', 1)
  );
  base_username := regexp_replace(lower(base_username), '[^a-z0-9_-]', '', 'g');
  if char_length(base_username) < 3 then
    base_username := 'user';
  end if;
  base_username := left(base_username, 26);
  final_username := base_username;

  while exists (select 1 from public.profiles where username = final_username) loop
    suffix := suffix + 1;
    final_username := base_username || suffix::text;
  end loop;

  insert into public.profiles (id, username)
  values (new.id, final_username);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Increment view count
create or replace function public.increment_view_count(file_uuid uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  update public.files
  set view_count = view_count + 1
  where id = file_uuid and status = 'approved';
end;
$$;
