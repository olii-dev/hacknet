-- Improved search: filename in index, fuzzy fallback, filters, popular tags

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

drop trigger if exists files_search_vector_trigger on public.files;

create trigger files_search_vector_trigger
  before insert or update of title, description, tags, filename on public.files
  for each row execute function public.files_search_vector_update();

-- Backfill search vectors for existing rows
update public.files set title = title;

create or replace function public.search_files(
  query text,
  tag_filter text[] default null,
  mime_prefix text default null,
  sort_by text default 'relevance',
  result_limit int default 50,
  result_offset int default 0
)
returns setof public.files
language sql
stable
security definer set search_path = public
as $$
  with filtered as (
    select f.*
    from public.files f
    where f.status = 'approved'
      and (
        mime_prefix is null
        or mime_prefix = ''
        or f.mime_type like mime_prefix || '%'
      )
      and (
        tag_filter is null
        or f.tags && tag_filter
      )
      and (
        query is null
        or btrim(query) = ''
        or f.search_vector @@ websearch_to_tsquery('english', query)
        or f.title ilike '%' || replace(replace(btrim(query), '%', '\%'), '_', '\_') || '%'
        or f.filename ilike '%' || replace(replace(btrim(query), '%', '\%'), '_', '\_') || '%'
        or f.description ilike '%' || replace(replace(btrim(query), '%', '\%'), '_', '\_') || '%'
        or exists (
          select 1 from unnest(f.tags) t(tag)
          where t.tag ilike '%' || replace(replace(btrim(query), '%', '\%'), '_', '\_') || '%'
        )
      )
  )
  select f.*
  from filtered f
  order by
    case when sort_by = 'newest' then extract(epoch from f.created_at) end desc nulls last,
    case when sort_by = 'popular' then f.view_count end desc nulls last,
    case when sort_by = 'relevance' and btrim(coalesce(query, '')) != ''
      then ts_rank(f.search_vector, websearch_to_tsquery('english', query))
    end desc nulls last,
    f.created_at desc
  limit result_limit
  offset result_offset;
$$;

create or replace function public.get_popular_tags(result_limit int default 16)
returns table (tag text, usage_count bigint)
language sql
stable
security definer set search_path = public
as $$
  select t.tag, count(*)::bigint as usage_count
  from public.files f
  cross join lateral unnest(f.tags) as t(tag)
  where f.status = 'approved' and t.tag is not null and btrim(t.tag) != ''
  group by t.tag
  order by usage_count desc, t.tag asc
  limit result_limit;
$$;

grant execute on function public.get_popular_tags to anon, authenticated;
