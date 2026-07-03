-- Custom cover images for file cards

alter table public.files
  add column if not exists custom_thumbnail_url text;

drop function if exists public.get_popular_files(int);
drop function if exists public.get_trending_files(int);

-- Include custom_thumbnail_url in popular/trending RPCs
create or replace function public.get_popular_files(result_limit int default 24)
returns table (
  id uuid,
  uploader_id uuid,
  title text,
  description text,
  filename text,
  mime_type text,
  size_bytes bigint,
  mega_url text,
  mega_file_id text,
  custom_thumbnail_url text,
  tags text[],
  status file_status,
  view_count integer,
  created_at timestamptz,
  like_count bigint
)
language sql
stable
security definer set search_path = public
as $$
  select
    f.id, f.uploader_id, f.title, f.description, f.filename,
    f.mime_type, f.size_bytes, f.mega_url, f.mega_file_id,
    f.custom_thumbnail_url, f.tags, f.status, f.view_count, f.created_at,
    count(l.user_id) as like_count
  from public.files f
  left join public.likes l on l.file_id = f.id
  where f.status = 'approved'
  group by f.id
  order by like_count desc, f.view_count desc
  limit result_limit;
$$;

create or replace function public.get_trending_files(result_limit int default 24)
returns table (
  id uuid,
  uploader_id uuid,
  title text,
  description text,
  filename text,
  mime_type text,
  size_bytes bigint,
  mega_url text,
  mega_file_id text,
  custom_thumbnail_url text,
  tags text[],
  status file_status,
  view_count integer,
  created_at timestamptz,
  trend_score numeric
)
language sql
stable
security definer set search_path = public
as $$
  select
    f.id, f.uploader_id, f.title, f.description, f.filename,
    f.mime_type, f.size_bytes, f.mega_url, f.mega_file_id,
    f.custom_thumbnail_url, f.tags, f.status, f.view_count, f.created_at,
    (
      f.view_count * 0.3 +
      (select count(*) from public.likes l where l.file_id = f.id) * 2 +
      (select count(*) from public.comments c where c.file_id = f.id) * 1.5
    ) / greatest(extract(epoch from (now() - f.created_at)) / 3600 + 2, 1) as trend_score
  from public.files f
  where f.status = 'approved'
    and f.created_at > now() - interval '30 days'
  order by trend_score desc
  limit result_limit;
$$;
