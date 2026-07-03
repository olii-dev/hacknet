-- Full-text search for files

alter table public.files
  add column search_vector tsvector;

create or replace function public.files_search_vector_update()
returns trigger
language plpgsql
as $$
begin
  new.search_vector :=
    setweight(to_tsvector('english', coalesce(new.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.filename, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(array_to_string(new.tags, ' '), '')), 'C');
  return new;
end;
$$;

create trigger files_search_vector_trigger
  before insert or update of title, description, tags, filename on public.files
  for each row execute function public.files_search_vector_update();

create index files_search_idx on public.files using gin (search_vector);

-- Search function (approved files only for public)
create or replace function public.search_files(
  query text,
  tag_filter text[] default null,
  result_limit int default 50,
  result_offset int default 0
)
returns setof public.files
language sql
stable
security definer set search_path = public
as $$
  select f.*
  from public.files f
  where f.status = 'approved'
    and (
      query is null
      or query = ''
      or f.search_vector @@ plainto_tsquery('english', query)
    )
    and (
      tag_filter is null
      or f.tags && tag_filter
    )
  order by
    case when query is not null and query != ''
      then ts_rank(f.search_vector, plainto_tsquery('english', query))
      else 0
    end desc,
    f.created_at desc
  limit result_limit
  offset result_offset;
$$;

-- Popular files (by likes + views)
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
    f.tags, f.status, f.view_count, f.created_at,
    count(l.user_id) as like_count
  from public.files f
  left join public.likes l on l.file_id = f.id
  where f.status = 'approved'
  group by f.id
  order by like_count desc, f.view_count desc
  limit result_limit;
$$;

-- Trending files (recent likes + views, weighted)
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
    f.tags, f.status, f.view_count, f.created_at,
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

grant execute on function public.search_files to anon, authenticated;
grant execute on function public.get_popular_files to anon, authenticated;
grant execute on function public.get_trending_files to anon, authenticated;
grant execute on function public.increment_view_count to anon, authenticated;
